import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPatch } from "../patch-extract.mjs";

const MARKER = "<!-- copilot-bridge-response -->";

test("擷取 diff 圍欄內容", () => {
  const body = `${MARKER}\n說明文字\n\`\`\`diff\ndiff --git a/x b/x\n+hello\n\`\`\`\n`;
  const r = extractPatch(body);
  assert.equal(r.ok, true);
  assert.match(r.patch, /diff --git a\/x b\/x/);
  assert.match(r.patch, /\+hello/);
  assert.doesNotMatch(r.patch, /說明文字/);
});

test("無 diff 圍欄則 ok:false 並帶 raw", () => {
  const body = `${MARKER}\nclone 失敗: repo not found`;
  const r = extractPatch(body);
  assert.equal(r.ok, false);
  assert.match(r.raw, /clone 失敗/);
});

test("多個 diff 圍欄取第一個", () => {
  const body = `${MARKER}\n\`\`\`diff\nFIRST\n\`\`\`\n\`\`\`diff\nSECOND\n\`\`\``;
  const r = extractPatch(body);
  assert.equal(r.ok, true);
  assert.match(r.patch, /FIRST/);
  assert.doesNotMatch(r.patch, /SECOND/);
});
