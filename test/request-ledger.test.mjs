import { test } from "node:test";
import assert from "node:assert/strict";
import { formatResponse, parseResponse, findPendingRequest } from "../request-ledger.mjs";

const M = "<!-- copilot-bridge-response -->";
const allowed = new Set(["me"]);
const issue = { number: 1, body: "do it", user: { login: "me" } };
const userComment = (id, body, login = "me") => ({ id, body, user: { login } });
const response = (id, forKey, sessionId, body = "ok") => ({ id, body: formatResponse({ forKey, sessionId, body }), user: { login: "me" } });

test("formatResponse: 第一行維持舊 marker (舊版 relay 才認得)", () => {
  const body = formatResponse({ forKey: "comment:5", sessionId: "s1", body: "hi" });
  assert.ok(body.startsWith(`${M}\n`));
  assert.ok(body.endsWith("\nhi"));
});

test("parseResponse: 讀回 for 與 session; 非回覆回 null", () => {
  assert.deepEqual(parseResponse(formatResponse({ forKey: "issue", sessionId: "s1", body: "x" })), { forKey: "issue", sessionId: "s1" });
  assert.deepEqual(parseResponse(`${M}\nlegacy answer`), { forKey: undefined, sessionId: undefined });
  assert.equal(parseResponse("a user comment"), null);
});

test("findPendingRequest: 新 Issue 沒有任何 comment, 待處理的是 Issue 本文", () => {
  const r = findPendingRequest({ issue, comments: [], allowedUsers: allowed });
  assert.deepEqual(r.pending, { key: "issue", prompt: "do it" });
  assert.equal(r.sessionId, undefined);
});

test("findPendingRequest: Issue 已回覆、有新追問 → 待處理的是追問, 並帶上前一輪的 session", () => {
  const r = findPendingRequest({
    issue,
    comments: [response(10, "issue", "s1"), userComment(11, "more")],
    allowedUsers: allowed,
  });
  assert.deepEqual(r.pending, { key: "comment:11", prompt: "more" });
  assert.equal(r.sessionId, "s1");
});

test("findPendingRequest: 全部都回覆了 → 沒有待處理", () => {
  const r = findPendingRequest({
    issue,
    comments: [response(10, "issue", "s1"), userComment(11, "more"), response(12, "comment:11", "s1")],
    allowedUsers: allowed,
  });
  assert.equal(r.pending, undefined);
});

test("findPendingRequest: 多則未回覆時, 先處理最早的", () => {
  const r = findPendingRequest({
    issue,
    comments: [response(10, "issue", "s1"), userComment(11, "first"), userComment(12, "second")],
    allowedUsers: allowed,
  });
  assert.equal(r.pending.key, "comment:11");
});

test("findPendingRequest: 不在允許名單的人留言不算請求", () => {
  const r = findPendingRequest({
    issue,
    comments: [response(10, "issue", "s1"), userComment(11, "hack", "stranger")],
    allowedUsers: allowed,
  });
  assert.equal(r.pending, undefined);
});

test("findPendingRequest: Issue 作者不在允許名單 → Issue 本文不算請求", () => {
  const r = findPendingRequest({ issue: { ...issue, user: { login: "stranger" } }, comments: [], allowedUsers: allowed });
  assert.equal(r.pending, undefined);
});

test("findPendingRequest: 舊格式回覆 (沒有 meta) 依先進先出對應最早的未回覆請求", () => {
  const r = findPendingRequest({
    issue,
    comments: [{ id: 10, body: `${M}\nold answer`, user: { login: "me" } }, userComment(11, "more")],
    allowedUsers: allowed,
  });
  assert.deepEqual(r.pending, { key: "comment:11", prompt: "more" });
});

test("findPendingRequest: comment 順序打亂也依 id 排序判斷", () => {
  const r = findPendingRequest({
    issue,
    comments: [userComment(11, "more"), { id: 10, body: `${M}\nold answer`, user: { login: "me" } }],
    allowedUsers: allowed,
  });
  assert.equal(r.pending.key, "comment:11");
});
