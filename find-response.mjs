const MARKER = "<!-- copilot-bridge-response -->";

export function findNewResponse(comments, baselineId) {
  return comments
    .filter((c) => c.id > baselineId && c.body.startsWith(MARKER))
    .sort((a, b) => a.id - b.id)[0];
}

export function maxCommentId(comments) {
  return comments.reduce((max, c) => (c.id > max ? c.id : max), 0);
}
