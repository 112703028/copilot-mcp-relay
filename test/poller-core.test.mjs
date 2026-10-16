import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "../poller-core.mjs";
import { buildPatchTaskBody } from "../relay-prompt.mjs";

const M = "<!-- copilot-bridge-response -->";

function issue(number, body, login = "me") {
  return { number, body, user: { login } };
}

// 假 GitHub: GET issues 回傳指定清單, GET comments 回傳 commentsByIssue, POST comment 記錄下來
function fakeGitHub({ issues, commentsByIssue = {} }) {
  const posted = [];
  const request = async (path, options = {}) => {
    const method = options.method ?? "GET";
    const m = path.match(/\/issues\/(\d+)\/comments/);
    if (method === "POST" && m) {
      posted.push({ issue: Number(m[1]), body: JSON.parse(options.body).body });
      return {};
    }
    if (m) return commentsByIssue[m[1]] ?? [];
    return typeof issues === "function" ? issues(path) : issues;
  };
  return { request, posted };
}

// 模擬 GitHub 列 Issue 的排序與分頁: 依 query 的 sort / direction / per_page 回傳
function githubListSemantics(issues) {
  return (path) => {
    const params = new URL(path, "https://x").searchParams;
    const field = params.get("sort") === "updated" ? "updated_at" : "created_at";
    const sign = params.get("direction") === "asc" ? 1 : -1;
    const perPage = Number(params.get("per_page") ?? 30);
    return [...issues].sort((a, b) => sign * (a[field] - b[field])).slice(0, perPage);
  };
}

function memoryStore(initial = { issues: {} }) {
  let state = structuredClone(initial);
  return {
    load: async () => structuredClone(state),
    save: async (s) => { state = structuredClone(s); },
    get: () => state,
  };
}

function makePoller({ gh, store, askCopilot, maxFailures }) {
  return createPoller({
    request: gh.request,
    owner: "o",
    repo: "q",
    allowedUsers: new Set(["me"]),
    askCopilot,
    store,
    maxFailures,
    log: { log() {}, error() {} },
  });
}

test("poll: 新 Issue 交給 Copilot, 回覆帶 marker, state 記下 sessionId", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "do it")] });
  const store = memoryStore();
  const prompts = [];
  const poller = makePoller({
    gh, store,
    askCopilot: async (prompt) => { prompts.push(prompt); return { answer: "done", sessionId: "s1" }; },
  });

  await poller.poll();

  assert.deepEqual(prompts, ["do it"]);
  assert.equal(gh.posted.length, 1);
  assert.equal(gh.posted[0].body, `${M}\ndone`);
  assert.equal(store.get().issues["1"].sessionId, "s1");
  assert.equal(store.get().issues["1"].initialProcessed, true);
});

test("poll: relay 送來的最長 task (含模板) 不會被 poller 拒絕", async () => {
  const body = buildPatchTaskBody({ repo: "o/t", task: "x".repeat(4000) });
  const gh = fakeGitHub({ issues: [issue(1, body)] });
  const prompts = [];
  const poller = makePoller({
    gh, store: memoryStore(),
    askCopilot: async (prompt) => { prompts.push(prompt); return { answer: "ok", sessionId: "s" }; },
  });

  await poller.poll();

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(gh.posted[0].body, /rejected/);
});

test("poll: 一個 Issue 失敗不影響同輪後面的 Issue", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "bad"), issue(2, "good")] });
  const store = memoryStore();
  const poller = makePoller({
    gh, store,
    askCopilot: async (prompt) => {
      if (prompt === "bad") throw new Error("Timeout after 60000ms");
      return { answer: "ok", sessionId: "s2" };
    },
  });

  await poller.poll();

  assert.deepEqual(gh.posted.map((p) => p.issue), [2]);
  assert.equal(store.get().issues["1"].failCount, 1);
});

test("poll: 累積超過一頁的舊 Issue 後, 新 Issue 仍會被處理", async () => {
  // 30 個已處理完、仍 open 的舊 Issue, 加上 1 個最新的
  const old = Array.from({ length: 30 }, (_, i) => ({
    ...issue(i + 1, `old ${i + 1}`), created_at: i, updated_at: i,
  }));
  const fresh = { ...issue(31, "new task"), created_at: 100, updated_at: 100 };
  const gh = fakeGitHub({ issues: githubListSemantics([...old, fresh]) });
  const processed = Object.fromEntries(
    old.map((o) => [String(o.number), { sessionId: "x", initialProcessed: true, lastCommentId: 0, failCount: 0 }]),
  );
  const store = memoryStore({ issues: processed });
  const prompts = [];
  const poller = makePoller({
    gh, store,
    askCopilot: async (prompt) => { prompts.push(prompt); return { answer: "ok", sessionId: "s" }; },
  });

  await poller.poll();

  assert.deepEqual(prompts, ["new task"]);
});

test("poll: 很舊的 Issue 收到新追問時仍會被處理", async () => {
  const issues = Array.from({ length: 30 }, (_, i) => ({
    ...issue(i + 1, `old ${i + 1}`), created_at: i, updated_at: i,
  }));
  issues[0].updated_at = 100; // #1 是最早建立的, 但剛收到追問
  const gh = fakeGitHub({
    issues: githubListSemantics(issues),
    commentsByIssue: { 1: [{ id: 500, body: "follow-up", user: { login: "me" } }] },
  });
  const processed = Object.fromEntries(
    issues.map((o) => [String(o.number), { sessionId: "x", initialProcessed: true, lastCommentId: 0, failCount: 0 }]),
  );
  const store = memoryStore({ issues: processed });
  const prompts = [];
  const poller = makePoller({
    gh, store,
    askCopilot: async (prompt) => { prompts.push(prompt); return { answer: "ok", sessionId: "x" }; },
  });

  await poller.poll();

  assert.deepEqual(prompts, ["follow-up"]);
});

test("poll: 失敗後重試成功, failCount 歸零", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "flaky")] });
  const store = memoryStore();
  let calls = 0;
  const poller = makePoller({
    gh, store,
    askCopilot: async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return { answer: "ok", sessionId: "s1" };
    },
  });

  await poller.poll();
  await poller.poll();

  assert.equal(store.get().issues["1"].failCount, 0);
});

test("poll: 連續失敗達上限後回報錯誤並停止重試", async () => {
  const gh = fakeGitHub({ issues: [issue(1, "bad")] });
  const store = memoryStore();
  let calls = 0;
  const poller = makePoller({
    gh, store, maxFailures: 2,
    askCopilot: async () => { calls++; throw new Error("boom"); },
  });

  await poller.poll(); // 失敗 1
  await poller.poll(); // 失敗 2 → 達上限, 留錯誤 comment
  await poller.poll(); // 不再呼叫 Copilot

  assert.equal(calls, 2);
  assert.equal(gh.posted.length, 1);
  assert.ok(gh.posted[0].body.startsWith(M));
  assert.match(gh.posted[0].body, /boom/);
});
