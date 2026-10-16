const responseMarker = "<!-- copilot-bridge-response -->";

export function createPoller({
  request: github,
  owner,
  repo,
  allowedUsers,
  askCopilot,
  store,
  maxFailures = 3,
  log = console,
}) {
  async function addComment(issueNumber, body) {
    await github(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: `${responseMarker}\n${body.slice(0, 60_000)}` }),
    });
  }

  function getIssueState(state, key) {
    return state.issues[key] ?? {
      sessionId: undefined,
      initialProcessed: false,
      lastCommentId: 0,
      failCount: 0,
    };
  }

  // 失敗累計到 maxFailures 就回報錯誤並放棄, 避免同一個任務無限重試、消耗額度
  async function recordFailure(issue, state, error) {
    const key = String(issue.number);
    const issueState = getIssueState(state, key);
    issueState.failCount = (issueState.failCount ?? 0) + 1;
    log.error(`${owner}/${repo}#${issue.number} failed (${issueState.failCount}/${maxFailures}): ${error.message}`);
    if (issueState.failCount >= maxFailures) {
      issueState.failed = true;
      await addComment(issue.number, `Request failed after ${issueState.failCount} attempts: ${error.message}`);
    }
    state.issues[key] = issueState;
    await store.save(state);
  }

  async function processIssue(issue, state) {
    if (!allowedUsers.has(issue.user.login)) return;

    const key = String(issue.number);
    const issueState = getIssueState(state, key);
    if (issueState.failed) return;
    let prompt;
    let processedCommentId = issueState.lastCommentId;

    if (!issueState.initialProcessed) {
      prompt = issue.body;
    } else {
      const comments = await github(`/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100`);
      const comment = comments.find(
        (item) =>
          item.id > issueState.lastCommentId &&
          allowedUsers.has(item.user.login) &&
          !item.body.startsWith(responseMarker),
      );
      if (!comment) return;
      prompt = comment.body;
      processedCommentId = comment.id;
    }

    if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > 4_000) {
      await addComment(issue.number, "Request rejected: prompt must contain 1 to 4,000 characters.");
      issueState.initialProcessed = true;
      issueState.lastCommentId = processedCommentId;
      state.issues[key] = issueState;
      await store.save(state);
      return;
    }

    log.log(`Processing ${owner}/${repo}#${issue.number}`);
    const result = await askCopilot(prompt, issueState.sessionId);
    await addComment(issue.number, result.answer);

    issueState.sessionId = result.sessionId;
    issueState.failCount = 0;
    issueState.initialProcessed = true;
    issueState.lastCommentId = processedCommentId;
    state.issues[key] = issueState;
    await store.save(state);
  }

  async function poll({ isStopping = () => false } = {}) {
    const state = await store.load();
    const issues = await github(
      `/repos/${owner}/${repo}/issues?state=open&labels=copilot-request&sort=created&direction=asc&per_page=20`,
    );

    for (const issue of issues) {
      if (isStopping()) return;
      if (issue.pull_request) continue;
      try {
        await processIssue(issue, state);
      } catch (error) {
        await recordFailure(issue, state, error);
      }
    }
  }

  return { poll };
}
