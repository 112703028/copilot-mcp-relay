// 以 Issue 上的 comment 紀錄作為唯一事實來源: 每則回覆都標明它回應的是哪一則請求,
// 所以「哪些請求還沒處理」可以隨時從 GitHub 重建, worker 不需要本機狀態檔,
// 重啟或當機後也不會重複處理已回覆的請求。

const MARKER = "<!-- copilot-bridge-response -->";
const META = /^<!-- copilot-bridge-meta(?: for=(\S+))?(?: session=(\S+))? -->$/;

export function formatResponse({ forKey, sessionId, body }) {
  const meta = `<!-- copilot-bridge-meta for=${forKey}${sessionId ? ` session=${sessionId}` : ""} -->`;
  // 第一行維持舊 marker, 舊版 relay 用 startsWith(MARKER) 辨識回覆
  return `${MARKER}\n${meta}\n${body}`;
}

export function parseResponse(commentBody) {
  if (!commentBody.startsWith(MARKER)) return null;
  const secondLine = commentBody.slice(MARKER.length).split("\n")[1] ?? "";
  const match = secondLine.match(META);
  return { forKey: match?.[1], sessionId: match?.[2] };
}

export function findPendingRequest({ issue, comments, allowedUsers }) {
  const open = [];
  let sessionId;
  if (allowedUsers.has(issue.user.login)) open.push({ key: "issue", prompt: issue.body });

  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const response = parseResponse(comment.body);
    if (response) {
      // 舊格式回覆沒有 for: 舊 poller 依先進先出處理, 所以它對應最早的未回覆請求
      const index = response.forKey ? open.findIndex((r) => r.key === response.forKey) : 0;
      if (index >= 0) open.splice(index, 1);
      if (response.sessionId) sessionId = response.sessionId;
    } else if (allowedUsers.has(comment.user.login)) {
      open.push({ key: `comment:${comment.id}`, prompt: comment.body });
    }
  }
  return { pending: open[0], sessionId };
}
