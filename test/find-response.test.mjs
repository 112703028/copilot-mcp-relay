import { test } from "node:test";
import assert from "node:assert/strict";
import { findNewResponse, maxCommentId } from "../find-response.mjs";

const M = "<!-- copilot-bridge-response -->";

test("只認 baseline 之後的 marker 回覆", () => {
  const comments = [
    { id: 1, body: `${M}\n舊答案` },
    { id: 5, body: "使用者留言" },
    { id: 8, body: `${M}\n新答案` },
  ];
  const r = findNewResponse(comments, 5);
  assert.equal(r.id, 8);
});

test("baseline 後無 marker 回覆則 undefined", () => {
  const comments = [{ id: 2, body: "非 marker" }];
  assert.equal(findNewResponse(comments, 1), undefined);
});

test("多則新 marker 取第一則(id 最小的 > baseline)", () => {
  const comments = [
    { id: 10, body: `${M}\nA` },
    { id: 12, body: `${M}\nB` },
  ];
  const r = findNewResponse(comments, 5);
  assert.equal(r.body.includes("A"), true);
});

test("maxCommentId 回傳最大 id,空陣列回 0", () => {
  assert.equal(maxCommentId([{ id: 3 }, { id: 9 }, { id: 4 }]), 9);
  assert.equal(maxCommentId([]), 0);
});
