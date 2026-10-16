import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TASK_LENGTH, MAX_PROMPT_LENGTH } from "../limits.mjs";
import { buildPatchTaskBody, buildFollowupTaskBody } from "../relay-prompt.mjs";

// GitHub 帳號名最長 39 字, repo 名最長 100 字
const LONGEST_REPO = `${"o".repeat(39)}/${"r".repeat(100)}`;

test("上限: 最長 task 加上 patch 模板, 仍在 poller 接受的長度內", () => {
  const body = buildPatchTaskBody({ repo: LONGEST_REPO, task: "x".repeat(MAX_TASK_LENGTH) });
  assert.ok(body.length <= MAX_PROMPT_LENGTH, `${body.length} > ${MAX_PROMPT_LENGTH}`);
});

test("上限: 最長 task 加上 followup 模板, 仍在 poller 接受的長度內", () => {
  const body = buildFollowupTaskBody({ task: "x".repeat(MAX_TASK_LENGTH) });
  assert.ok(body.length <= MAX_PROMPT_LENGTH, `${body.length} > ${MAX_PROMPT_LENGTH}`);
});
