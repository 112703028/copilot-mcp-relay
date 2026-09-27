# Copilot Patch Relay — 家裡 MCP Server 設計

**日期**: 2026-09-26
**狀態**: 待審
**取代**: `2026-09-26-remote-mcp-bridge-design.md`（該份假設 Copilot 直接開 PR，經 spike 驗證此路被 EMU 政策封死，見「設計歷程」）

## 一句話

讓家裡的 Claude Code 像派 subagent 一樣，把「對某個 **public** GitHub repo 做修改」的任務丟給公司電腦的 Copilot；Copilot clone 完整專案、改、產生 **unified diff patch** 回傳；家裡 Claude 檢視後 `git apply` 到本機專案。

## 動機

- 使用者公司的 Copilot 額度多、家裡 Claude 額度少。要把重活（讀完整 code、思考、產生修改）放在 Copilot，家裡 Claude 只送任務描述、收 patch、套用。
- 公司電腦有 VPN、禁裝穿透工具，故沿用既有 **GitHub Issue 中轉**（公司端 poller 只做 outbound）。

## 關鍵約束（決定方案為何長這樣）

1. **公司帳號是 Enterprise Managed User (EMU)**。EMU **不能寫入**企業外 repo（push / fork / 開 PR 到個人 repo 皆 403）。嘗試用個人 PAT 繞過時，**公司 Copilot 主動拒絕**（「不能協助繞過 EMU」）。→ **不走 push/PR，也不繞過政策。**
2. **但 EMU 能「讀取」public repo**：`git clone` public 個人 repo 成功（spike 驗證通過）。這是純讀取，不碰寫入牆，Copilot 視為正當操作、不拒絕。
3. **目標專案必須是 public**（EMU 看不到 private repo）。
4. Copilot 跑在公司電腦，碰不到家裡檔案；它只能對「自己 clone 的 repo」幹活。

## 整體架構

```
[家裡] Claude Code (MCP client)     [GitHub queue repo]      [公司電腦] poller + Copilot(EMU)
   │ copilot_patch({repo, task})                                  │
   ▼                                                              │
mcp-relay.mjs                                                     │
   │ 1. POST 建 Issue(label copilot-request, body=結構化任務) ─► Issue #N
   │                                            poller 撈到 ─────► Copilot
   │                                                              │ git clone --depth 1 <repo> (讀取,合法)
   │                                                              │ 讀完整專案、思考、改
   │ 2. 輪詢 Issue #N comments ◄──────────────────────────────── │ git diff → patch
   │    (每 3-5 秒, 等 marker)                                    │ rm -rf 暫存
   │                                            poller 寫回 ◄──── │ 貼回 patch(帶 response marker)
   │ 3. 看到 marker comment,取出 patch                            │
   │◄── 回傳 { patch, issueNumber } ──                            │
   ▼
家裡 Claude 展示 patch 摘要給使用者 → 確認 → git apply
```

**公司端 poller 完全不改。** 家裡新增 MCP server，是 poller 的「對向」。

## 元件

### 新增（家裡端）

| 檔案 | 用途 |
|---|---|
| `mcp-relay.mjs` | 家裡 stdio MCP server，註冊 tools |
| `github-client.mjs` | 從 poller 抽出的共用 GitHub fetch 包裝 |

### 修改

| 檔案 | 修改 |
|---|---|
| `github-poller.mjs` | 改用 `github-client.mjs`（行為不變） |
| `package.json` | 加 `@modelcontextprotocol/sdk`、`mcp` script |
| `README.md` | 加 Patch Relay 使用說明與 public repo 前提 |

### 依賴

- `@modelcontextprotocol/sdk`

## Tools

### 1. `copilot_patch`（主要）

```
輸入: {
  repo: string,            // "owner/name",必須 public
  task: string,            // 給 Copilot 的任務描述
  timeoutSeconds?: number  // 預設 180
}
行為: 開 Issue(結構化 body)→ 輪詢等 patch → 回傳
回傳(成功): { patch: string, issueNumber: number }
回傳(逾時): { status: "pending", issueNumber: number }
```

**Issue body 是結構化模板**（不是原樣轉發 task），明確指示 Copilot：
- clone 指定的 public repo 到暫存目錄（`--depth 1`）
- 完成 task 描述的修改
- 用 `git diff` 產出 unified diff 並貼回
- **不要 push、不要開 PR、做完清掉暫存**
- 產出以固定圍欄標記 patch 區塊（方便家裡端擷取）

家裡 Claude 拿到 patch 後**先展示摘要給使用者、確認後才 `git apply`**（不自動套用）。套用由家裡 Claude 執行，不屬於 MCP server 職責。

### 2. `check_patch`（備援，不阻塞）

```
輸入: { issueNumber: number }
回傳: { status: "ready", patch } 或 { status: "pending" }
```

長任務逾時後補查。

### 3. `ask_copilot`（輕量問答，保留）

```
輸入: { prompt: string, timeoutSeconds?: number }
回傳: { answer, issueNumber }
```

純諮詢用（不涉及 repo/patch），沿用最初問答設計。同 Issue 追問延續 Copilot session 的能力保留（`ask_followup` 可後續加，YAGNI 暫不做）。

**YAGNI**：不做 patch 自動套用、不做大 patch 分段上傳、不做管理型 tool。

## patch 擷取與套用

- **擷取**：Copilot 被要求把 patch 放在固定圍欄（例如 ` ```diff ... ``` `）。家裡端從 marker comment 中取出該區塊。
- **新舊 comment 分辨**：沿用既有機制——送任務前記下當下最大 comment id 為 baseline，只認 `id > baseline` 且帶 response marker 的 comment（避免抓到舊回覆）。
- **套用**：家裡 Claude `git apply`（或 `git apply --3way`）到目標本機專案的新 branch。展示 → 確認 → 套用。失敗（衝突）則回報，不強套。

## 輪詢與 rate limit

- 每 3-5 秒 GET comments，直到 `timeoutSeconds`。
- GitHub REST 認證後每小時 5000 次，遠低於上限。
- 公司端 `POLL_INTERVAL_MS` 建議調短（5-10 秒）縮短家裡等待。

## 錯誤處理

| 情況 | 處理 |
|---|---|
| 缺 `GITHUB_TOKEN` | 啟動即報錯 |
| repo 非 public / Copilot clone 失敗 | Copilot 照實回報錯誤 → 家裡端把錯誤當結果回傳，不誤當 patch |
| 輪詢逾時 | 回 `{ status: "pending", issueNumber }` |
| patch 圍欄缺失/格式異常 | 回傳原始 comment 內容 + 標記「無法擷取 patch」，交家裡 Claude 判讀 |
| 大 patch 超過 comment 上限 | 暫不處理（YAGNI），先假設不超過 |

## 環境變數（家裡端）

| 變數 | 必要 | 說明 |
|---|---|---|
| `GITHUB_TOKEN` | 是 | 家裡個人 PAT（帳號 112703028），queue repo 的 Issues read/write |
| `GITHUB_OWNER` / `GITHUB_REPO` | 否 | 預設同 poller |

## 前提條件

1. 公司電腦持續執行 poller（且 Copilot 已登入、未過期）。
2. 目標專案是 **public** repo。
3. 家裡 PAT 帳號在 poller 的 `GITHUB_ALLOWED_USERS` 內（同帳號即滿足）。

## 測試

- `github-client.mjs`：單元測試 fetch 成功/錯誤/204。
- patch 擷取 / baseline 比對：單元測試「多則回覆挑最新」「圍欄擷取」「格式異常降級」。
- 端到端 smoke test：`copilot_patch` 對一個 public repo 跑，確認拿回可 `git apply` 的 patch。需公司端 poller 在跑，列手動 smoke test。

## 安全

- 全程 Copilot 只對 public repo 做**讀取 + 產 diff**，不寫入任何 repo，不碰 EMU 隔離、不繞政策。
- Issue/comment/patch 留在 GitHub queue repo（private），受資料政策約束；勿把機密放進 task 描述。
- 家裡 PAT 最小權限、定期輪替。
- 公司端仍 `approveAll`，既有高風險設定，本設計不改變。

## 設計歷程（為何是這個方案 — 排除的死路）

1. ❌ **Copilot 直接 push / 開 PR 到個人 repo**：EMU 帳號 403（`denied to Tim-Wu3_GHIFX`）。
2. ❌ **用個人 PAT 內嵌 URL 繞過 EMU**：公司 Copilot 主動拒絕（不協助繞過 EMU + PAT 洩漏風險）。**此為政策紅線，不繞。**
3. ❌ **fork 模型**：`gh repo fork` → EMU 403（企業外互動被禁）。
4. ❌ **加 collaborator / 個人認證 push**：對 EMU 皆不通或屬繞過。
5. ✅ **Patch Relay（本方案）**：clone public（讀取，合法）→ 產 diff → 家裡套用。不碰寫入牆、不繞政策，Copilot 願意執行，spike 驗證通過。
