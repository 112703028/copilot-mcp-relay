import { buildPatchTaskBody, buildFollowupTaskBody } from "./relay-prompt.mjs";
import { extractPatch } from "./patch-extract.mjs";
import { findNewResponse, maxCommentId } from "./find-response.mjs";

const MAX_TASK_LENGTH = 4000;

function invalidTask(task) {
  return typeof task !== "string" || task.trim() === "" || task.length > MAX_TASK_LENGTH;
}

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

  async function addComment(issueNumber, body) {
    await request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
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

  // 把 pollForResponse 的結果收斂成對外回傳格式
  function toResult(result, issueNumber) {
    if (result.status === "ready") return { patch: result.patch, issueNumber };
    if (result.status === "error") return { status: "error", issueNumber, raw: result.raw };
    return { status: "pending", issueNumber };
  }

  async function requestPatch({ repo: targetRepo, task, timeoutMs = 180000, pollMs = 4000 }) {
    if (invalidTask(task)) {
      return { status: "invalid", reason: `task 必須是 1 到 ${MAX_TASK_LENGTH} 字元的非空字串` };
    }
    const issueNumber = await createIssue(task, targetRepo);
    const result = await pollForResponse(issueNumber, 0, timeoutMs, pollMs);
    return toResult(result, issueNumber);
  }

  async function requestFollowupPatch({ issueNumber, task, timeoutMs = 180000, pollMs = 4000 }) {
    if (invalidTask(task)) {
      return { status: "invalid", reason: `task 必須是 1 到 ${MAX_TASK_LENGTH} 字元的非空字串` };
    }
    // 先記 baseline: 留言前現有的最大 comment id,之後只認新出現的回覆(避免抓到上一輪舊 patch)
    const baselineId = maxCommentId(await getComments(issueNumber));
    await addComment(issueNumber, buildFollowupTaskBody({ task }));
    const result = await pollForResponse(issueNumber, baselineId, timeoutMs, pollMs);
    return toResult(result, issueNumber);
  }

  async function checkPatch({ issueNumber, baselineId = 0 }) {
    const comments = await getComments(issueNumber);
    const found = findNewResponse(comments, baselineId);
    if (!found) return { status: "pending" };
    return classify(found);
  }

  return { requestPatch, requestFollowupPatch, checkPatch };
}
