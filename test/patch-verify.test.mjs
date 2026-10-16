import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkPatchFormat, gitApplyCheck, verifyPatch } from "../patch-verify.mjs";

const GOOD = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-hello",
  "+world",
  "",
].join("\n");

// context 對不上: 檔案內容是 hello, patch 卻以為是 goodbye
const STALE = GOOD.replace("-hello", "-goodbye");

async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "patch-verify-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await writeFile(path.join(dir, "a.txt"), "hello\n");
  return dir;
}

test("checkPatchFormat: 空 patch 不通過", () => {
  const r = checkPatchFormat("   \n");
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/i);
});

test("checkPatchFormat: 不是 unified diff 不通過", () => {
  const r = checkPatchFormat("I could not complete the task.");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unified diff/i);
});

test("checkPatchFormat: 合法的 git diff 通過", () => {
  assert.deepEqual(checkPatchFormat(GOOD), { ok: true });
});

test("gitApplyCheck: 能套用的 patch 通過, 且不修改工作目錄", async () => {
  const dir = await tempRepo();
  try {
    const r = await gitApplyCheck(GOOD, dir);
    assert.deepEqual(r, { ok: true });
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "hello\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitApplyCheck: context 對不上的 patch 不通過, 並帶回 git 的錯誤訊息", async () => {
  const dir = await tempRepo();
  try {
    const r = await gitApplyCheck(STALE, dir);
    assert.equal(r.ok, false);
    assert.match(r.reason, /a\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyPatch: 沒給 verifyIn 只做格式檢查", async () => {
  assert.deepEqual(await verifyPatch(GOOD, {}), { ok: true, level: "format" });
  assert.equal((await verifyPatch("", {})).ok, false);
});

test("verifyPatch: 給 verifyIn 時再用 git apply --check 驗證", async () => {
  const dir = await tempRepo();
  try {
    assert.deepEqual(await verifyPatch(GOOD, { verifyIn: dir }), { ok: true, level: "git-apply-check" });
    assert.equal((await verifyPatch(STALE, { verifyIn: dir })).ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
