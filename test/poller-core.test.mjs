import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "../poller-core.mjs";

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
    return issues;
  };
  return { request, posted };
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
