import { buildPatchTaskBody } from "./relay-prompt.mjs";
import { extractPatch } from "./patch-extract.mjs";
import { findNewResponse, maxCommentId } from "./find-response.mjs";

export function createRelay({ request, owner, repo, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function createIssue(task, targetRepo) {
    const body = buildPatchTaskBody({ repo: targetRepo, task });
    const issue = await request(`/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `patch: ${targetRepo}`, body, labels: ["copilot-request"] }),
    });
    return issue.number;
  }

  async function getComments(issueNumber) {
    return request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
  }

  function classify(comment) {
    const extracted = extractPatch(comment.body);
    if (extracted.ok) return { status: "ready", patch: extracted.patch };
    return { status: "error", raw: extracted.raw };
  }

  async function pollForResponse(issueNumber, baselineId, timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const comments = await getComments(issueNumber);
      const found = findNewResponse(comments, baselineId);
      if (found) return classify(found);
      await sleep(pollMs);
    }
    return { status: "pending" };
  }

  async function requestPatch({ repo: targetRepo, task, timeoutMs = 180000, pollMs = 4000 }) {
    const issueNumber = await createIssue(task, targetRepo);
    const result = await pollForResponse(issueNumber, 0, timeoutMs, pollMs);
    if (result.status === "ready") return { patch: result.patch, issueNumber };
    if (result.status === "error") return { status: "error", issueNumber, raw: result.raw };
    return { status: "pending", issueNumber };
  }

  async function checkPatch({ issueNumber, baselineId = 0 }) {
    const comments = await getComments(issueNumber);
    const found = findNewResponse(comments, baselineId);
    if (!found) return { status: "pending" };
    return classify(found);
  }

  return { requestPatch, checkPatch };
}
