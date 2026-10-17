import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkProvenance, verifyPatch } from "../patch-verify.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// 已有一個 commit 的 repo (HEAD 有 a.txt = "hello\n")
async function committedRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "provenance-"));
  git(dir, "init", "-q");
  await writeFile(path.join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

// 在 repo 的另一份 clone 裡做修改, 取得 git 真正產生的 diff (不動原 repo)
async function realDiff(repo, change) {
  const work = await mkdtemp(path.join(tmpdir(), "provenance-work-"));
  git(work, "clone", "-q", repo, ".");
  await change(work);
  git(work, "add", "-A");
  const diff = git(work, "diff", "--cached");
  await rm(work, { recursive: true, force: true });
  return diff;
}

async function withRepo(fn) {
  const repo = await committedRepo();
  try {
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

// e2e 時 Copilot 被擋住無法 clone, 自己手寫交回的 diff (index hash 是編的)
const FABRICATED_E2E = [
  "diff --git a/E2E_TEST.md b/E2E_TEST.md",
  "new file mode 100644",
  "index 0000000..a1b2c3d",
  "--- /dev/null",
  "+++ b/E2E_TEST.md",
  "@@ -0,0 +1 @@",
  "+hello from e2e",
].join("\n");

// 同一個任務, Copilot 真的跑 git diff 時的輸出 (e2e Issue #12)
const GENUINE_E2E = FABRICATED_E2E.replace("a1b2c3d", "ef287b8");

test("checkProvenance: e2e 抓到的手寫 diff (hash 是編的) 不通過", async () => {
  await withRepo(async (repo) => {
    const r = await checkProvenance(FABRICATED_E2E, repo);
    assert.equal(r.ok, false);
    assert.match(r.reason, /E2E_TEST\.md/);
  });
});

test("checkProvenance: e2e 時 Copilot 真的跑 git diff 的輸出通過", async () => {
  await withRepo(async (repo) => {
    assert.deepEqual(await checkProvenance(GENUINE_E2E, repo), { ok: true });
  });
});

test("checkProvenance: git 產生的修改、新增、刪除 diff 都通過", async () => {
  await withRepo(async (repo) => {
    const diff = await realDiff(repo, async (work) => {
      await writeFile(path.join(work, "a.txt"), "hello\nworld\n");
      await writeFile(path.join(work, "b.txt"), "new file\n");
    });
    assert.deepEqual(await checkProvenance(diff, repo), { ok: true });

    const deletion = await realDiff(repo, async (work) => git(work, "rm", "-q", "a.txt"));
    assert.deepEqual(await checkProvenance(deletion, repo), { ok: true });
  });
});

test("checkProvenance: 修改後的內容與新 hash 對不上就不通過 (內容被手動改過)", async () => {
  await withRepo(async (repo) => {
    const diff = await realDiff(repo, (work) => writeFile(path.join(work, "a.txt"), "hello\nworld\n"));
    const tampered = diff.replace("+world", "+WORLD");
    const r = await checkProvenance(tampered, repo);
    assert.equal(r.ok, false);
    assert.match(r.reason, /a\.txt/);
  });
});

test("checkProvenance: 舊 hash 與本機檔案不符就不通過", async () => {
  await withRepo(async (repo) => {
    const diff = await realDiff(repo, (work) => writeFile(path.join(work, "a.txt"), "hello\nworld\n"));
    const wrongBase = diff.replace(/index [0-9a-f]+\.\./, "index 1234567..");
    const r = await checkProvenance(wrongBase, repo);
    assert.equal(r.ok, false);
    assert.match(r.reason, /a\.txt/);
  });
});

test("checkProvenance: 缺少 index 行就不通過", async () => {
  await withRepo(async (repo) => {
    const noIndex = FABRICATED_E2E.replace("index 0000000..a1b2c3d\n", "");
    const r = await checkProvenance(noIndex, repo);
    assert.equal(r.ok, false);
    assert.match(r.reason, /index/);
  });
});

test("checkProvenance: 不修改 repo 的工作目錄與暫存區", async () => {
  await withRepo(async (repo) => {
    await checkProvenance(GENUINE_E2E, repo);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });
});

test("verifyPatch: 給 verifyIn 時也做來源驗證, 手寫 diff 不通過", async () => {
  await withRepo(async (repo) => {
    assert.deepEqual(await verifyPatch(GENUINE_E2E, { verifyIn: repo }), { ok: true, level: "provenance" });
    const r = await verifyPatch(FABRICATED_E2E, { verifyIn: repo });
    assert.equal(r.ok, false);
    assert.match(r.reason, /git diff/);
  });
});
