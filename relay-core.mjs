import { buildPatchTaskBody, buildFollowupTaskBody } from "./relay-prompt.mjs";
import { extractPatch } from "./patch-extract.mjs";
import { findNewResponse, maxCommentId } from "./find-response.mjs";

import { MAX_TASK_LENGTH } from "./limits.mjs";

function invalidTask(task) {
  return typeof task !== "string" || task.trim() === "" || task.length > MAX_TASK_LENGTH;
}

function repairTask(reason) {
  return [
    "上一版 patch 驗證失敗, 原因如下:",
    reason.slice(0, 2000),
    "",
    "請修正問題後重新提供完整 patch。",
  ].join("\n");
}

export function createRelay({
  request,
  owner,
  repo,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  verifyPatch = async () => ({ ok: true, level: "none" }),
}) {
  const baselines = new Map(); // issueNumber → 最近一次追問的 baseline comment id
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
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
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

  async function followup(issueNumber, task, timeoutMs, pollMs) {
    // 先記 baseline: 留言前現有的最大 comment id,之後只認新出現的回覆(避免抓到上一輪舊 patch)
    const baselineId = maxCommentId(await getComments(issueNumber));
    await addComment(issueNumber, buildFollowupTaskBody({ task }));
    // 記住這輪的 baseline, 逾時後 checkPatch 才不會拿到上一輪的舊 patch
    baselines.set(issueNumber, baselineId);
    const result = await pollForResponse(issueNumber, baselineId, timeoutMs, pollMs);
    return { result, baselineId };
  }

  // 驗證 Copilot 交回的 patch; 不通過就帶著錯誤原因追問修正, 最多 maxRepairRounds 輪
  async function verifyAndRepair(result, issueNumber, baselineId, { verifyIn, maxRepairRounds, timeoutMs, pollMs }) {
    let repairRounds = 0;
    while (result.status === "ready") {
      let verdict;
      try {
        verdict = await verifyPatch(result.patch, { verifyIn });
      } catch (error) {
        // 本機驗證環境的問題 (例如 verifyIn 路徑不存在) 不是 Copilot 的錯, 不追問
        return { status: "verify-error", issueNumber, patch: result.patch, reason: error.message };
      }
      if (verdict.ok) {
        return { patch: result.patch, issueNumber, verification: { level: verdict.level, repairRounds } };
      }
      if (repairRounds >= maxRepairRounds) {
        return { status: "invalid-patch", issueNumber, patch: result.patch, reason: verdict.reason, repairRounds };
      }
      repairRounds++;
      ({ result, baselineId } = await followup(issueNumber, repairTask(verdict.reason), timeoutMs, pollMs));
    }
    const out = toResult(result, issueNumber);
    return out.status === "pending" && baselineId !== undefined ? { ...out, baselineId } : out;
  }

  async function requestPatch({
    repo: targetRepo, task, verifyIn, maxRepairRounds = 1, timeoutMs = 180000, pollMs = 4000,
  }) {
    if (invalidTask(task)) {
      return { status: "invalid", reason: `task 必須是 1 到 ${MAX_TASK_LENGTH} 字元的非空字串` };
    }
    const issueNumber = await createIssue(task, targetRepo);
    const result = await pollForResponse(issueNumber, 0, timeoutMs, pollMs);
    return verifyAndRepair(result, issueNumber, undefined, { verifyIn, maxRepairRounds, timeoutMs, pollMs });
  }

  async function requestFollowupPatch({
    issueNumber, task, verifyIn, maxRepairRounds = 1, timeoutMs = 180000, pollMs = 4000,
  }) {
    if (invalidTask(task)) {
      return { status: "invalid", reason: `task 必須是 1 到 ${MAX_TASK_LENGTH} 字元的非空字串` };
    }
    const { result, baselineId } = await followup(issueNumber, task, timeoutMs, pollMs);
    return verifyAndRepair(result, issueNumber, baselineId, { verifyIn, maxRepairRounds, timeoutMs, pollMs });
  }

  async function checkPatch({ issueNumber, baselineId = baselines.get(issueNumber) ?? 0 }) {
    const comments = await getComments(issueNumber);
    const found = findNewResponse(comments, baselineId);
    if (!found) return { status: "pending" };
    return classify(found);
  }

  return { requestPatch, requestFollowupPatch, checkPatch };
}
