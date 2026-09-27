# Patch Relay 手動 e2e Smoke Test

前提:
- 公司電腦 poller 正在跑,且 Copilot 已登入(未過期)。
- 目標 repo 為 **public**(公司 EMU 帳號只能讀取 public)。
- 家裡 `.env` 設好 `GITHUB_TOKEN`(個人 PAT, queue repo Issues 讀寫)。

## 步驟

1. 在 MCP client(Claude Code / Cursor / Claude Desktop)設定此 server,以 stdio 啟動:
   `node mcp-relay.mjs`(或 `npm run mcp`),工作目錄為本專案。

2. 呼叫 `copilot_patch`:
   ```json
   {
     "repo": "112703028/first-contributions",
     "task": "在根目錄新增 HELLO.md, 內容寫一行: hello relay"
   }
   ```

3. 預期回傳含 patch 的 JSON:
   ```json
   { "patch": "diff --git a/HELLO.md b/HELLO.md\n...", "issueNumber": <N> }
   ```
   patch 內容應為新增 HELLO.md 的 unified diff。

4. 套用:家裡 Claude 展示 patch → 你確認 → `git apply` 到本機 clone 的同 repo →
   驗證 HELLO.md 出現。套用後由你在家裡用個人身分 push / 開 PR。

5. 逾時情境:若回 `{ "status": "pending", "issueNumber": <N> }`,
   稍後用 `check_patch({ "issueNumber": <N> })` 補查。

## 已知待觀察(來自實作 ruling)

- **diff 圍欄格式**:目前擷取器只認 ```` ```diff ```` 圍欄。若真實 e2e 發現
  Copilot 常用其他圍欄(```` ``` ````/```` ```patch ````),需放寬 `patch-extract.mjs` 的正則。
- **大 patch**:超過 GitHub comment 上限時目前不處理(YAGNI)。
- **純問答 ask_copilot**:尚未實作(改 code 的追問走 copilot_patch_followup)。

## 追問(copilot_patch_followup)

初次 `copilot_patch` 後,用 `copilot_patch_followup({ issueNumber, task })` 對同一 Issue 追問。
已 e2e 驗證:對 Issue 追問時 Copilot 延續前文,回傳含先前+新增的完整 patch(git apply 可套用)。
