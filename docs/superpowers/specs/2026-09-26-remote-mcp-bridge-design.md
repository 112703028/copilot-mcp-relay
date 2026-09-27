# Remote MCP Bridge Design

**日期**: 2026-09-26
**狀態**: 待審

## 背景與動機

現有 `copilot-bridge` 專案讓公司電腦上的 GitHub Copilot CLI 可被遠端使用。因為公司電腦有 VPN、不能裝 Tailscale 之類的穿透工具(違反公司政策),無法讓外部主動連入,所以採用 **GitHub Issue 作為中轉**:公司電腦只做 outbound 連線到 `api.github.com`,透過 `github-poller.mjs` 主動輪詢 private repo 的 Issue、處理後把答案寫回 comment。

目前遠端使用者是「手動」在 GitHub 開 Issue、等回覆。本設計要在**家裡**新增一個 MCP server,把這個手動流程包成 MCP tool,讓家裡的 MCP client(Claude Desktop / Claude Code / Cursor)可以直接把 Copilot 當工具呼叫。

**MCP 不改變穿透模型**:MCP 的 stdio transport 要求 client 與 server 同機,HTTP transport 又需要有人連入公司電腦(正是被政策擋掉的)。因此 MCP server 跑在**家裡**,它的角色是現有 poller 的「對向」——以程式方式做遠端使用者原本手動的開 Issue / 等回覆動作。公司電腦端**完全不需要改**。

## 整體架構

```
[家裡]                                          [GitHub]                [公司電腦]
Claude (MCP client)                          private queue repo        github-poller.mjs
   │                                                                        │(每 N 秒 poll)
   │ 呼叫 ask_copilot("prompt")                                            │
   ▼                                                                        │
mcp-remote.mjs                                                              │
   │ 1. POST 建 Issue (label: copilot-request) ──────► Issue #N 建立       │
   │                                                                        │
   │ 2. 輪詢 GET Issue #N 的 comments ◄──────────────► ◄──── poller 撈到 #N
   │    (每幾秒, 等 marker comment)                                    丟給 Copilot
   │                                                     poller 寫回 ──► comment
   │                                                     (帶 response marker)
   │ 3. 看到 marker comment                                                 
   │◄── return answer ────                                                  
   ▼
Claude 拿到答案
```

兩端共用的協定沿用現有 README 已定義的約定:

- Issue 掛 `copilot-request` label。
- 送出者(此處為家裡 PAT 的帳號)必須在 poller 的 `GITHUB_ALLOWED_USERS` 內。
- 答案 comment 以 `<!-- copilot-bridge-response -->` marker 開頭,家裡靠此 marker 分辨「答案」與「自己送出的問題」。
- 同一個 Issue 內追問時,poller 用 `resumeSession(sessionId)` 延續 Copilot 上下文。因此 **Issue number 就是家裡端的對話 handle**,家裡端不需要管理 sessionId。

## 元件

### 新增檔案

| 檔案 | 用途 |
|---|---|
| `mcp-remote.mjs` | 家裡跑的 MCP server(stdio transport),註冊三個 tool |
| `github-client.mjs` | 從 `github-poller.mjs` 抽出的共用 GitHub fetch 包裝 |

### 修改檔案

| 檔案 | 修改 |
|---|---|
| `github-poller.mjs` | 改用 `github-client.mjs`(行為不變) |
| `package.json` | 新增 `@modelcontextprotocol/sdk` 依賴、`mcp` script |
| `environment.example.txt` | 新增家裡端所需環境變數註解 |
| `README.md` | 新增遠端 MCP 使用說明 |

### 依賴

- `@modelcontextprotocol/sdk`(MCP server + stdio transport)

## Tools

走「阻塞為主 + 可續查備援」的混合設計。

### 1. `ask_copilot`(主要,阻塞)

```
輸入: { prompt: string, timeoutSeconds?: number (預設 120),
        mode?: "answer" | "diff" (預設 "answer") }
行為: 開 Issue → 輪詢等 marker comment → 回答案
回傳(成功): { answer: string, issueNumber: number }
回傳(逾時): { status: "pending", issueNumber: number,
             message: "尚未完成,可用 check_response 稍後查詢" }
```

逾時不當作 error,而是回傳 `issueNumber` 讓 Claude 能續查,避免孤兒 Issue。

### 2. `check_response`(備援,不阻塞)

```
輸入: { issueNumber: number }
行為: 查該 Issue 目前有沒有新的 marker comment
回傳: { status: "ready", answer } 或 { status: "pending" }
```

給長任務逾時後補查用。

### 3. `ask_followup`(延續對話)

```
輸入: { issueNumber: number, prompt: string, timeoutSeconds?: number (預設 120),
        mode?: "answer" | "diff" (預設 "answer") }
行為: 在既有 Issue 留新 comment(追問) → 輪詢等新 marker 回覆 → 回答案
回傳: 同 ask_copilot
```

在同一 Issue 追問,公司端自動接上同一 Copilot session。

**YAGNI**:不做「列出進行中 Issue」「關閉 Issue」等管理型 tool,需要時在 GitHub 網頁操作。

## `mode: "diff"`：讓 Copilot 協助改 code

Copilot 跑在公司電腦,碰不到家裡專案的檔案;中轉管道只能傳文字。因此「改 code」的模型是:**Copilot 回文字(diff),家裡端負責套用**。

`ask_copilot` / `ask_followup` 的 `mode` 參數:

- `"answer"`(預設):原樣送出 prompt。
- `"diff"`:在 prompt 尾巴自動附上固定指示——「不要嘗試修改任何檔案,只在回答中提供 unified diff 格式的變更」。省去使用者每次手打。

**套用 diff 不屬於本 MCP server 的職責**:tool 只負責把 diff 文字取回。實際 `git apply` 到家裡專案,由家裡的 MCP client(Claude Code 等)完成。

**注意事項**:若要 Copilot 產出正確 diff,prompt 通常需帶上相關檔案的現有內容。這代表家裡的 code 會經 GitHub Issue 中轉(受公司 private repo 政策約束)。使用者須自行判斷哪些檔案適合經此管道傳送。本設計不自動附帶檔案內容,由使用者在 prompt 中決定。

## 核心邏輯:如何分辨「哪則 comment 是這輪的答案」

一個 Issue 的留言串可能同時存在多則「答案」comment(初次回答 + 每次追問的回答)。若只找「第一則答案」會抓到舊答案。

**解法**:GitHub 每則 comment 有遞增的 `id`(越晚留的越大)。送問前先記下「當下最新 comment id」(baseline),之後只認 `id > baseline` 且以 marker 開頭的 comment。

- `ask_copilot`:新開的 Issue 還沒有 comment,baseline = 0,第一個出現的 marker comment 即答案。
- `ask_followup`:先送出追問 comment,以「送問前的最大 comment id」為 baseline,只認之後出現的 marker comment。

**答案清理**:回傳前去掉開頭的 marker 那一行,只留乾淨內容。

## 輪詢節奏與 rate limit

- 每 3-5 秒 `GET /repos/{owner}/{repo}/issues/{n}/comments` 一次,直到 `timeoutSeconds`。
- GitHub REST API 認證後每小時 5000 次。即使每 3 秒查、等 2 分鐘也才 ~40 次,安全。
- 建議公司端 `POLL_INTERVAL_MS` 調短到 5-10 秒,縮短家裡等待。此為選配,不強制。

## 錯誤處理

| 情況 | 處理 |
|---|---|
| 缺 `GITHUB_TOKEN` | 啟動即報錯(對齊 poller) |
| 建 Issue / 留言失敗 (401/403/404) | tool 回傳 error,附 GitHub 狀態碼與訊息 |
| 輪詢逾時 | 回 `{ status: "pending", issueNumber }`,非 error |
| `check_response` 查到未完成 | 回 `{ status: "pending" }`,正常回應 |

## 環境變數(家裡端)

沿用現有變數名稱,家裡端只需 GitHub 相關者:

| 變數 | 必要 | 說明 |
|---|---|---|
| `GITHUB_TOKEN` | 是 | 家裡的 fine-grained PAT(同帳號),queue repo 的 Issues read/write |
| `GITHUB_OWNER` | 否 | 預設同 poller |
| `GITHUB_REPO` | 否 | 預設同 poller |

家裡 PAT 使用**同一個 GitHub 帳號**,天然符合 poller 的 `GITHUB_ALLOWED_USERS`。

## 前提條件

1. 公司電腦持續執行 `github-poller.mjs`。
2. 家裡 PAT 的帳號在 poller 的 `GITHUB_ALLOWED_USERS` 內(用同帳號即滿足)。
3. 家裡 PAT 有 queue repo 的 Issues read/write。

## 測試

- `github-client.mjs`:單元測試 fetch 包裝的成功/錯誤/204 分支。
- marker/baseline 比對邏輯:單元測試「多則答案挑最新」「舊答案不誤判」「marker 清理」。
- 端到端 smoke test:對真實(或測試用)queue repo 跑 `ask_copilot` → `ask_followup`,確認能拿到答案且追問延續上下文。需要公司端 poller 在跑,故列為手動 smoke test。

## 安全注意事項

沿用現有 README 的安全前提:

- Issue、comment、答案都留在 GitHub,受公司資料政策約束。
- 家裡 PAT 只授權單一 queue repo、僅 Issues read/write,定期輪替。
- 家裡端與公司端一樣,不改變「allowlist 只識別送出者,不會讓惡意 prompt 變安全」的限制。
- 公司端仍使用 `approveAll`,這是既有的高風險設定;本設計不改變它。
