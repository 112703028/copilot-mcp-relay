import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../relay-core.mjs";

const M = "<!-- copilot-bridge-response -->";

function fakeRequest(script) {
  // script: 依序回傳的回應陣列;每次呼叫取下一個
  let i = 0;
  const calls = [];
  return {
    request: async (path, options) => {
      calls.push({ path, method: options?.method ?? "GET" });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return typeof step === "function" ? step(path, options) : step;
    },
    calls,
  };
}

test("requestPatch: task 為空則回 invalid 且不開 Issue", async () => {
  const { request, calls } = fakeRequest([{ number: 1 }]);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestPatch({ repo: "o/t", task: "   ", timeoutMs: 10, pollMs: 1 });
  assert.equal(r.status, "invalid");
  assert.equal(calls.length, 0); // 未開 Issue
});

test("requestPatch: task 過長(>4000)則回 invalid 且不開 Issue", async () => {
  const { request, calls } = fakeRequest([{ number: 1 }]);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestPatch({ repo: "o/t", task: "x".repeat(4001), timeoutMs: 10, pollMs: 1 });
  assert.equal(r.status, "invalid");
  assert.equal(calls.length, 0);
});

test("requestPatch: 開 Issue 後輪詢拿到 patch", async () => {
  const script = [
    // POST 建 Issue
    { number: 42 },
    // 第一次 GET comments: 還沒回覆
    [],
    // 第二次 GET comments: 有 marker + diff
    [{ id: 100, body: `${M}\n\`\`\`diff\ndiff --git a/x b/x\n+y\n\`\`\`` }],
  ];
  const { request, calls } = fakeRequest(script);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestPatch({ repo: "o/target", task: "t", timeoutMs: 10000, pollMs: 1 });
  assert.equal(r.issueNumber, 42);
  assert.match(r.patch, /diff --git a\/x b\/x/);
  assert.equal(calls[0].method, "POST"); // 建 Issue
});

test("requestPatch: 逾時回 pending", async () => {
  const script = [{ number: 7 }, []]; // 建 Issue 後永遠空
  const { request } = fakeRequest(script);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 5, pollMs: 1 });
  assert.equal(r.status, "pending");
  assert.equal(r.issueNumber, 7);
});

test("requestPatch: 回覆無 diff 圍欄則 status error 帶 raw", async () => {
  const script = [
    { number: 9 },
    [{ id: 200, body: `${M}\nclone 失敗: not found` }],
  ];
  const { request } = fakeRequest(script);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 10000, pollMs: 1 });
  assert.equal(r.status, "error");
  assert.match(r.raw, /clone 失敗/);
});

test("requestFollowupPatch: 只認留言後出現的新 patch(忽略舊回覆)", async () => {
  const OLD = `${M}\n\`\`\`diff\nOLD PATCH\n\`\`\``;
  const NEW = `${M}\n\`\`\`diff\nNEW PATCH\n\`\`\``;
  const script = [
    // GET 現有 comments(記 baseline): 已有一則舊 patch id=50
    [{ id: 50, body: OLD }],
    // POST 追問 comment
    { id: 51 },
    // GET 輪詢: 舊的還在,新的還沒
    [{ id: 50, body: OLD }],
    // GET 輪詢: 新 patch 出現 id=60
    [{ id: 50, body: OLD }, { id: 60, body: NEW }],
  ];
  const { request, calls } = fakeRequest(script);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestFollowupPatch({ issueNumber: 9, task: "再加 X", timeoutMs: 10000, pollMs: 1 });
  assert.equal(r.issueNumber, 9);
  assert.match(r.patch, /NEW PATCH/);
  assert.doesNotMatch(r.patch, /OLD PATCH/);
  // 應有一次 POST(留追問 comment)
  assert.equal(calls.some((c) => c.method === "POST"), true);
});

// 可變的 comments 狀態: GET 回傳目前清單, POST 留言加入一則非回覆的 comment
function liveIssue(initial) {
  const comments = [...initial];
  let nextId = 1000;
  const request = async (path, options) => {
    if (options?.method === "POST") {
      const c = { id: nextId++, body: JSON.parse(options.body).body };
      comments.push(c);
      return c;
    }
    return [...comments];
  };
  return { request, comments };
}

test("checkPatch: 追問逾時後再查, 回傳追問的新 patch 而非舊 patch", async () => {
  const OLD = `${M}\n\`\`\`diff\nOLD PATCH\n\`\`\``;
  const NEW = `${M}\n\`\`\`diff\nNEW PATCH\n\`\`\``;
  const issue = liveIssue([{ id: 50, body: OLD }]);
  const relay = createRelay({ request: issue.request, owner: "o", repo: "q", sleep: async () => {} });

  const pending = await relay.requestFollowupPatch({ issueNumber: 9, task: "再加 X", timeoutMs: 5, pollMs: 1 });
  assert.equal(pending.status, "pending");

  issue.comments.push({ id: 2000, body: NEW }); // Copilot 稍後才回覆
  const r = await relay.checkPatch({ issueNumber: 9 });

  assert.equal(r.status, "ready");
  assert.match(r.patch, /NEW PATCH/);
});

test("checkPatch: 追問逾時、新回覆還沒出現時回 pending (不回舊 patch)", async () => {
  const OLD = `${M}\n\`\`\`diff\nOLD PATCH\n\`\`\``;
  const issue = liveIssue([{ id: 50, body: OLD }]);
  const relay = createRelay({ request: issue.request, owner: "o", repo: "q", sleep: async () => {} });

  await relay.requestFollowupPatch({ issueNumber: 9, task: "再加 X", timeoutMs: 5, pollMs: 1 });
  const r = await relay.checkPatch({ issueNumber: 9 });

  assert.equal(r.status, "pending");
});

test("requestFollowupPatch: 逾時回傳 baselineId, 供 checkPatch 明確指定", async () => {
  const OLD = `${M}\n\`\`\`diff\nOLD PATCH\n\`\`\``;
  const issue = liveIssue([{ id: 50, body: OLD }]);
  const relay = createRelay({ request: issue.request, owner: "o", repo: "q", sleep: async () => {} });

  const pending = await relay.requestFollowupPatch({ issueNumber: 9, task: "再加 X", timeoutMs: 5, pollMs: 1 });

  assert.equal(pending.baselineId, 50);
});

test("requestFollowupPatch: task 為空回 invalid 且不留言", async () => {
  const { request, calls } = fakeRequest([[]]);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestFollowupPatch({ issueNumber: 1, task: "  ", timeoutMs: 10, pollMs: 1 });
  assert.equal(r.status, "invalid");
  assert.equal(calls.some((c) => c.method === "POST"), false);
});
