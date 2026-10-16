import { MAX_PROMPT_LENGTH } from "./limits.mjs";
import { formatResponse, findPendingRequest } from "./request-ledger.mjs";

const PER_PAGE = 100;

// poller 不存本機狀態: 每次都從 Issue 的 comment 紀錄算出還沒回覆的請求 (見 request-ledger.mjs)。
// 記憶體裡只放可以遺失的東西: 失敗次數 (重啟後頂多多重試幾次) 與 updated_at 快取 (省 API 呼叫)。
export function createPoller({
  request: github,
  owner,
  repo,
  allowedUsers,
  askCopilot,
  maxFailures = 3,
  legacySessionIds = {},
  log = console,
}) {
  const failCounts = new Map(); // "issue#key" → 連續失敗次數
  const settledAt = new Map(); // issueNumber → 已無待處理請求時的 updated_at

  async function getAllComments(issueNumber) {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await github(
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${PER_PAGE}&page=${page}`,
      );
      all.push(...batch);
      if (batch.length < PER_PAGE) return all;
    }
  }

  async function respond(issueNumber, forKey, sessionId, body) {
    await github(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: formatResponse({ forKey, sessionId, body: body.slice(0, 60_000) }) }),
    });
  }

  async function processIssue(issue) {
    if (issue.updated_at !== undefined && settledAt.get(issue.number) === issue.updated_at) return;

    const comments = await getAllComments(issue.number);
    const ledger = findPendingRequest({ issue, comments, allowedUsers });
    const { pending } = ledger;
    if (!pending) {
      settledAt.set(issue.number, issue.updated_at);
      return;
    }
    const sessionId = ledger.sessionId ?? legacySessionIds[issue.number];

    if (typeof pending.prompt !== "string" || pending.prompt.trim() === "" || pending.prompt.length > MAX_PROMPT_LENGTH) {
      await respond(issue.number, pending.key, sessionId, `Request rejected: prompt must contain 1 to ${MAX_PROMPT_LENGTH} characters.`);
      return;
    }

    const failKey = `${issue.number}#${pending.key}`;
    let result;
    try {
      log.log(`Processing ${owner}/${repo}#${issue.number} (${pending.key})`);
      result = await askCopilot(pending.prompt, sessionId);
    } catch (error) {
      // 失敗累計到 maxFailures 就回報錯誤並放棄, 避免同一個任務無限重試、消耗額度
      const count = (failCounts.get(failKey) ?? 0) + 1;
      failCounts.set(failKey, count);
      log.error(`${owner}/${repo}#${issue.number} (${pending.key}) failed (${count}/${maxFailures}): ${error.message}`);
      if (count >= maxFailures) {
        await respond(issue.number, pending.key, sessionId, `Request failed after ${count} attempts: ${error.message}`);
        failCounts.delete(failKey);
      }
      return;
    }
    failCounts.delete(failKey);
    await respond(issue.number, pending.key, result.sessionId, result.answer);
  }

  async function poll({ isStopping = () => false } = {}) {
    // Issue 不會被關閉 (之後還能追問), 依建立時間排序的話, 舊 Issue 累積滿一頁後新任務永遠排不進來。
    // 改取最近有更新的 (新 Issue 或新追問都會更新 updated_at), 再由舊到新處理。
    const issues = await github(
      `/repos/${owner}/${repo}/issues?state=open&labels=copilot-request&sort=updated&direction=desc&per_page=20`,
    );

    for (const issue of [...issues].reverse()) {
      if (isStopping()) return;
      if (issue.pull_request) continue;
      try {
        await processIssue(issue);
      } catch (error) {
        // GitHub API 錯誤等: 記下來, 不影響同輪其他 Issue, 下一輪再試
        log.error(`${owner}/${repo}#${issue.number}: ${error.message}`);
      }
    }
  }

  return { poll };
}
