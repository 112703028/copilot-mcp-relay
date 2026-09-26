const MARKER = "<!-- copilot-bridge-response -->";

export function extractPatch(commentBody) {
  const raw = commentBody.startsWith(MARKER)
    ? commentBody.slice(MARKER.length).trim()
    : commentBody;
  const match = raw.match(/```diff\s*\n([\s\S]*?)\n```/);
  if (!match) {
    return { ok: false, reason: "no diff fence found", raw };
  }
  return { ok: true, patch: match[1] };
}
