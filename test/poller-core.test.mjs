import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "../poller-core.mjs";
import { buildPatchTaskBody } from "../relay-prompt.mjs";
import { formatResponse, parseResponse } from "../request-ledger.mjs";

const M = "<!-- copilot-bridge-response -->";

function issue(number, body, extra = {}) {
  return { number, body, user: { login: "me" }, ...extra };
}

// 假 GitHub: comment 會真的累積 (poller 留的回覆下一輪看得到), 支援分頁與 Issue 排序
function fakeGitHub({ issues, comments = {} }) {
  const byIssue = structuredClone(comments);
  const posted = [];
  const commentFetches = [];
  let nextId = 100_000;
  const request = async (path, options = {}) => {
    const method = options.method ?? "GET";
    const url = new URL(path, "https://x");
    const m = url.pathname.match(/\/issues\/(\d+)\/comments$/);
    if (m && method === "POST") {
      const body = JSON.parse(options.body).body;
      const c = { id: nextId++, body, user: { login: "me" } };
      (byIssue[m[1]] ??= []).push(c);
      posted.push({ issue: Number(m[1]), body });
      return c;
    }
    if (m) {
      commentFetches.push(Number(m[1]));
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return (byIssue[m[1]] ?? []).slice((page - 1) * perPage, page * perPage);
    }
    if (typeof issues !== "function") return issues;
    return issues(url.searchParams);
  };
  return { request, posted, commentFetches };
}

// 模擬 GitHub 列 Issue 的排序與分頁
function githubListSemantics(list) {
  return (params) => {
    const field = params.get("sort") === "updated" ? "updated_at" : "created_at";
    const sign = params.get("direction") === "asc" ? 1 : -1;
    const perPage = Number(params.get("per_page") ?? 30);
    return [...list].sort((a, b) => sign * (a[field] - b[field])).slice(0, perPage);
  };
}

const answered = (forKey, id = 1) => ({ id, body: formatResponse({ forKey, sessionId: "x", body: "done" }), user: { login: "me" } });

function makePoller({ gh, askCopilot, maxFailures, legacySessionIds }) {
  return createPoller({
    request: gh.request,
    owner: "o",
    repo: "q",
    allowedUsers: new Set(["me"]),
    askCopilot,
    maxFailures,
    legacySessionIds,
    log: { log() {}, error() {} },
  });
}

function recorder(answer = (prompt) => ({ answer: `re: ${prompt}`, sessionId: "s1" })) {
  const calls = [];
  const askCopilot = async (prompt, sessionId) => {
    calls.push({ prompt, sessionId });
    return answer(prompt, sessionId);
  };
  return { calls, askCopilot };
}

test("poll: 新 Issue 交給 Copilot, 回覆標明回應的請求與 session", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "do it")] });
  const cp = recorder();

  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();

  assert.deepEqual(cp.calls, [{ prompt: "do it", sessionId: undefined }]);
  assert.equal(gh.posted.length, 1);
  assert.ok(gh.posted[0].body.startsWith(`${M}\n`));
  assert.deepEqual(parseResponse(gh.posted[0].body), { forKey: "issue", sessionId: "s1" });
});

test("poll: 重啟後 (全新 poller, 沒有任何記憶) 不會重複處理已回覆的請求", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "do it")] });
  const cp = recorder();

  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();
  await makePoller({ gh, askCopilot: cp.askCopilot }).poll(); // 模擬當機後重啟

  assert.equal(cp.calls.length, 1);
  assert.equal(gh.posted.length, 1);
});

test("poll: 重啟後的追問會接續回覆裡記錄的 session", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "do it")] });
  const cp = recorder();
  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();
  await gh.request("/repos/o/q/issues/1/comments", { method: "POST", body: JSON.stringify({ body: "more please" }) });

  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();

  assert.deepEqual(cp.calls[1], { prompt: "more please", sessionId: "s1" });
});

test("poll: 舊格式的 Issue 用舊 state 檔裡的 sessionId 接續追問", async () => {
  const gh = fakeGitHub({
    issues: [issue(1, "do it")],
    comments: { 1: [{ id: 10, body: `${M}\nold answer`, user: { login: "me" } }, { id: 11, body: "more", user: { login: "me" } }] },
  });
  const cp = recorder();

  await makePoller({ gh, askCopilot: cp.askCopilot, legacySessionIds: { 1: "legacy-s" } }).poll();

  assert.deepEqual(cp.calls, [{ prompt: "more", sessionId: "legacy-s" }]);
});

test("poll: relay 送來的最長 task (含模板) 不會被 poller 拒絕", async () => {
  const body = buildPatchTaskBody({ repo: "o/t", task: "x".repeat(4000) });
  const gh = fakeGitHub({ issues: [issue(1, body)] });
  const cp = recorder(() => ({ answer: "ok", sessionId: "s" }));

  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();

  assert.equal(cp.calls.length, 1);
  assert.doesNotMatch(gh.posted[0].body, /rejected/);
});

test("poll: 超過長度上限的請求被拒絕, 拒絕訊息也標明回應的請求 (不會一直重複拒絕)", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "x".repeat(6000))] });
  const cp = recorder();
  const poller = makePoller({ gh, askCopilot: cp.askCopilot });

  await poller.poll();
  await poller.poll();

  assert.equal(cp.calls.length, 0);
  assert.equal(gh.posted.length, 1);
  assert.match(gh.posted[0].body, /rejected/);
  assert.equal(parseResponse(gh.posted[0].body).forKey, "issue");
});

test("poll: 一個 Issue 失敗不影響同輪後面的 Issue", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "bad"), issue(2, "good")] });
  const cp = recorder((prompt) => {
    if (prompt === "bad") throw new Error("Timeout after 60000ms");
    return { answer: "ok", sessionId: "s2" };
  });

  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();

  assert.deepEqual(gh.posted.map((p) => p.issue), [2]);
});

test("poll: 連續失敗達上限後回報錯誤並停止重試", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "bad")] });
  const cp = recorder(() => { throw new Error("boom"); });
  const poller = makePoller({ gh, askCopilot: cp.askCopilot, maxFailures: 2 });

  await poller.poll(); // 失敗 1
  await poller.poll(); // 失敗 2 → 達上限, 留錯誤 comment
  await poller.poll(); // 已回覆 (錯誤), 不再呼叫 Copilot

  assert.equal(cp.calls.length, 2);
  assert.equal(gh.posted.length, 1);
  assert.match(gh.posted[0].body, /boom/);
  assert.equal(parseResponse(gh.posted[0].body).forKey, "issue");
});

test("poll: 失敗次數按請求分開計算, 新的追問不會沿用上一則的失敗次數", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "flaky")] });
  let n = 0;
  const cp = recorder((prompt) => {
    n++;
    if (n === 1 || n === 3) throw new Error("transient"); // 本文失敗一次後成功; 追問也失敗一次
    return { answer: "ok", sessionId: "s1" };
  });
  const poller = makePoller({ gh, askCopilot: cp.askCopilot, maxFailures: 2 });

  await poller.poll(); // 本文失敗 1
  await poller.poll(); // 本文成功
  await gh.request("/repos/o/q/issues/1/comments", { method: "POST", body: JSON.stringify({ body: "more" }) });
  await poller.poll(); // 追問失敗 1 (若沿用本文的次數會直接達上限)
  await poller.poll(); // 追問成功

  assert.equal(gh.posted.filter((p) => /failed after/.test(p.body)).length, 0);
  assert.equal(cp.calls.length, 4);
});

test("poll: Issue 超過 100 則 comment 時, 仍能看到最新的追問 (分頁)", async () => {
  const history = [answered("issue", 1)];
  for (let i = 2; i <= 150; i += 2) {
    history.push({ id: i, body: `q${i}`, user: { login: "me" } });
    history.push(answered(`comment:${i}`, i + 1));
  }
  history.push({ id: 500, body: "latest question", user: { login: "me" } });
  const gh = fakeGitHub({ issues: [issue(1, "do it")], comments: { 1: history } });
  const cp = recorder();

  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();

  assert.deepEqual(cp.calls.map((c) => c.prompt), ["latest question"]);
});

test("poll: Issue 沒有更新 (updated_at 不變) 就不重新抓 comment", async () => {
  const gh = fakeGitHub({
    issues: [issue(1, "do it", { updated_at: 5 })],
    comments: { 1: [answered("issue")] },
  });
  const cp = recorder();
  const poller = makePoller({ gh, askCopilot: cp.askCopilot });

  await poller.poll();
  await poller.poll();

  assert.deepEqual(gh.commentFetches, [1]);
});

test("poll: 累積超過一頁的舊 Issue 後, 新 Issue 仍會被處理", async () => {
  const old = Array.from({ length: 30 }, (_, i) => issue(i + 1, `old ${i + 1}`, { created_at: i, updated_at: i }));
  const fresh = issue(31, "new task", { created_at: 100, updated_at: 100 });
  const comments = Object.fromEntries(old.map((o) => [o.number, [answered("issue", o.number)]]));
  const gh = fakeGitHub({ issues: githubListSemantics([...old, fresh]), comments });
  const cp = recorder();

  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();

  assert.deepEqual(cp.calls.map((c) => c.prompt), ["new task"]);
});

test("poll: 很舊的 Issue 收到新追問時仍會被處理", async () => {
  const list = Array.from({ length: 30 }, (_, i) => issue(i + 1, `old ${i + 1}`, { created_at: i, updated_at: i }));
  list[0].updated_at = 100; // #1 是最早建立的, 但剛收到追問
  const comments = Object.fromEntries(list.map((o) => [o.number, [answered("issue", o.number)]]));
  comments[1].push({ id: 500, body: "follow-up", user: { login: "me" } });
  const gh = fakeGitHub({ issues: githubListSemantics(list), comments });
  const cp = recorder();

  await makePoller({ gh, askCopilot: cp.askCopilot }).poll();

  assert.deepEqual(cp.calls.map((c) => c.prompt), ["follow-up"]);
});
