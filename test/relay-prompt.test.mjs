import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPatchTaskBody } from "../relay-prompt.mjs";

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
