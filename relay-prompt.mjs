export function buildPatchTaskBody({ repo, task }) {
  return [
    `請對 public GitHub repo \`${repo}\` 進行以下修改,並以 unified diff patch 回傳。`,
    "你不需要 push、不需要開 PR。全程只做讀取與產生 diff。",
    "",
    "步驟:",
    `1. 在目前的工作目錄底下建立一個新的子目錄,用 \`git clone --depth 1 https://github.com/${repo}.git\` clone 該 repo(這是 public repo,一般 clone 即可)。只能在目前的工作目錄內操作。`,
    "2. 依下面的任務描述完成修改。",
    "3. 用 `git add -A` 後執行 `git diff --cached` 產生完整 unified diff。",
    "4. 做完後刪除這個子目錄。",
    "",
    "把最終 diff 放在一個 ```diff 圍欄區塊中貼回,方便我擷取。除了 diff 圍欄外,可另附簡短說明。",
    "**不要 push、不要開 PR。若 clone 或任何步驟失敗,請照實貼出錯誤訊息,不要假裝成功。**",
    "",
    "---",
    "任務描述:",
    task,
  ].join("\n");
}

export function buildFollowupTaskBody({ task }) {
  return [
    "這是延續上一輪的追問。你在先前的對話中已對某個 public repo 產生過 diff。",
    "請在先前修改的基礎上,依下面的追問完成調整,並回傳**完整的新 patch**",
    "(包含先前的修改 + 這次的調整,讓我可以直接對乾淨的 repo 套用一份 diff)。",
    "",
    "若先前 clone 的子目錄已刪除,請在目前的工作目錄底下重新 clone 同一個 repo,重現先前的修改後再加上這次的調整。",
    "把完整 diff 放在一個 ```diff 圍欄區塊中貼回。",
    "**不要 push、不要開 PR。若任何步驟失敗,請照實貼出錯誤訊息。**",
    "",
    "---",
    "追問:",
    task,
  ].join("\n");
}
