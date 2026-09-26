export function buildPatchTaskBody({ repo, task }) {
  return [
    `請對 public GitHub repo \`${repo}\` 進行以下修改,並以 unified diff patch 回傳。`,
    "你不需要 push、不需要開 PR。全程只做讀取與產生 diff。",
    "",
    "步驟:",
    `1. 在暫存目錄用 \`git clone --depth 1 https://github.com/${repo}.git\` clone 該 repo(這是 public repo,一般 clone 即可)。`,
    "2. 依下面的任務描述完成修改。",
    "3. 用 `git add -A` 後執行 `git diff --cached` 產生完整 unified diff。",
    "4. 做完後刪除暫存目錄。",
    "",
    "把最終 diff 放在一個 ```diff 圍欄區塊中貼回,方便我擷取。除了 diff 圍欄外,可另附簡短說明。",
    "**不要 push、不要開 PR。若 clone 或任何步驟失敗,請照實貼出錯誤訊息,不要假裝成功。**",
    "",
    "---",
    "任務描述:",
    task,
  ].join("\n");
}
