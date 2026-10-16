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

// 模擬 Copilot 依序回覆: 開 Issue 後回 replies[0], 之後每則追問回下一則
function scriptedCopilot(replies) {
  const comments = [];
  const followups = [];
  let nextId = 1;
  let replyIndex = 0;
  const reply = () => {
    if (replyIndex < replies.length) comments.push({ id: nextId++, body: `${M}\n${replies[replyIndex++]}` });
  };
  const request = async (path, options) => {
    if (options?.method === "POST" && path.endsWith("/issues")) {
      reply();
      return { number: 1 };
    }
    if (options?.method === "POST") {
      const body = JSON.parse(options.body).body;
      comments.push({ id: nextId++, body });
      followups.push(body);
      reply();
      return {};
    }
    return [...comments];
  };
  return { request, followups };
}

const fence = (s) => `\`\`\`diff\n${s}\n\`\`\``;

test("requestPatch: patch 驗證通過時直接回傳, 並註明驗證等級", async () => {
  const cp = scriptedCopilot([fence("GOOD")]);
  const relay = createRelay({
    request: cp.request, owner: "o", repo: "q", sleep: async () => {},
    verifyPatch: async (patch) => (patch === "GOOD" ? { ok: true, level: "git-apply-check" } : { ok: false, reason: "bad" }),
  });

  const r = await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 1000, pollMs: 1 });

  assert.equal(r.patch, "GOOD");
  assert.deepEqual(r.verification, { level: "git-apply-check", repairRounds: 0 });
  assert.equal(cp.followups.length, 0);
});

test("requestPatch: 驗證失敗時自動追問修正, 帶上錯誤原因", async () => {
  const cp = scriptedCopilot([fence("BAD"), fence("GOOD")]);
  const relay = createRelay({
    request: cp.request, owner: "o", repo: "q", sleep: async () => {},
    verifyPatch: async (patch) => (patch === "GOOD" ? { ok: true, level: "git-apply-check" } : { ok: false, reason: "patch does not apply: a.txt" }),
  });

  const r = await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 1000, pollMs: 1 });

  assert.equal(r.patch, "GOOD");
  assert.equal(r.verification.repairRounds, 1);
  assert.equal(cp.followups.length, 1);
  assert.match(cp.followups[0], /patch does not apply: a\.txt/);
});

test("requestPatch: 修正輪數用完仍失敗, 回 invalid-patch 並附原因與最後的 patch", async () => {
  const cp = scriptedCopilot([fence("BAD1"), fence("BAD2")]);
  const relay = createRelay({
    request: cp.request, owner: "o", repo: "q", sleep: async () => {},
    verifyPatch: async () => ({ ok: false, reason: "nope" }),
  });

  const r = await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 1000, pollMs: 1, maxRepairRounds: 1 });

  assert.equal(r.status, "invalid-patch");
  assert.equal(r.reason, "nope");
  assert.equal(r.patch, "BAD2");
  assert.equal(r.issueNumber, 1);
});

test("requestPatch: verifyIn 會傳給驗證函式", async () => {
  const cp = scriptedCopilot([fence("GOOD")]);
  const seen = [];
  const relay = createRelay({
    request: cp.request, owner: "o", repo: "q", sleep: async () => {},
    verifyPatch: async (patch, ctx) => { seen.push(ctx); return { ok: true, level: "git-apply-check" }; },
  });

  await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 1000, pollMs: 1, verifyIn: "C:/src/t" });

  assert.deepEqual(seen, [{ verifyIn: "C:/src/t" }]);
});

test("requestPatch: 本機驗證環境出錯時回 verify-error, 不追問 Copilot", async () => {
  const cp = scriptedCopilot([fence("GOOD")]);
  const relay = createRelay({
    request: cp.request, owner: "o", repo: "q", sleep: async () => {},
    verifyPatch: async () => { throw new Error("spawn git ENOENT"); },
  });

  const r = await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 1000, pollMs: 1, verifyIn: "C:/missing" });

  assert.equal(r.status, "verify-error");
  assert.match(r.reason, /ENOENT/);
  assert.equal(r.patch, "GOOD");
  assert.equal(cp.followups.length, 0);
});

test("requestFollowupPatch: 追問拿到的 patch 也會驗證", async () => {
  const cp = scriptedCopilot([fence("FIRST"), fence("BAD"), fence("GOOD")]);
  const relay = createRelay({
    request: cp.request, owner: "o", repo: "q", sleep: async () => {},
    verifyPatch: async (patch) => (patch === "BAD" ? { ok: false, reason: "bad" } : { ok: true, level: "format" }),
  });
  await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 1000, pollMs: 1 });

  const r = await relay.requestFollowupPatch({ issueNumber: 1, task: "more", timeoutMs: 1000, pollMs: 1 });

  assert.equal(r.patch, "GOOD");
  assert.equal(r.verification.repairRounds, 1);
});

test("requestFollowupPatch: Issue 超過 100 則 comment 時, baseline 仍取到最新的 id (分頁)", async () => {
  const comments = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    body: i === 149 ? `${M}\n\`\`\`diff\nOLD PATCH\n\`\`\`` : `c${i + 1}`,
  }));
  const request = async (path, options) => {
    if (options?.method === "POST") {
      comments.push({ id: 1000, body: JSON.parse(options.body).body });
      return {};
    }
    const url = new URL(path, "https://x");
    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    return comments.slice((page - 1) * perPage, page * perPage);
  };
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });

  const r = await relay.requestFollowupPatch({ issueNumber: 9, task: "more", timeoutMs: 5, pollMs: 1 });

  assert.equal(r.status, "pending"); // 新回覆還沒出現, 不能把 id 150 的舊 patch 當成答案
  assert.equal(r.baselineId, 150);
});

test("requestFollowupPatch: task 為空回 invalid 且不留言", async () => {
  const { request, calls } = fakeRequest([[]]);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestFollowupPatch({ issueNumber: 1, task: "  ", timeoutMs: 10, pollMs: 1 });
  assert.equal(r.status, "invalid");
  assert.equal(calls.some((c) => c.method === "POST"), false);
});
