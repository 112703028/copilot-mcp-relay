import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPatchTaskBody, buildFollowupTaskBody } from "../relay-prompt.mjs";

test("body 含 repo 與 task", () => {
  const body = buildPatchTaskBody({ repo: "owner/name", task: "加一個函式" });
  assert.match(body, /owner\/name/);
  assert.match(body, /加一個函式/);
});

test("body 指示 clone、不 push、產 diff、圍欄", () => {
  const body = buildPatchTaskBody({ repo: "o/n", task: "t" });
  assert.match(body, /git clone/);
  assert.match(body, /不要 push|不要.*開 PR/);
  assert.match(body, /git diff/);
  assert.match(body, /```diff/);
});

test("body 指示 clone 到目前工作目錄底下 (worker 權限只允許在工作目錄內操作)", () => {
  const body = buildPatchTaskBody({ repo: "o/n", task: "t" });
  assert.match(body, /目前的工作目錄/);
  assert.doesNotMatch(body, /暫存目錄/);
});

test("followup body 重新 clone 時也指向目前工作目錄", () => {
  const body = buildFollowupTaskBody({ task: "t" });
  assert.match(body, /目前的工作目錄/);
  assert.doesNotMatch(body, /暫存目錄/);
});

test("followup body 含追問 task、要求完整 patch、延續前文", () => {
  const body = buildFollowupTaskBody({ task: "再加 X" });
  assert.match(body, /再加 X/);
  assert.match(body, /完整/); // 要求完整的新 patch
  assert.match(body, /```diff/);
  assert.match(body, /延續|先前|上一/); // 提示延續前一輪
});
