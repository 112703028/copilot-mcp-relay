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
