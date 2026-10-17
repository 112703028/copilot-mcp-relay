import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function runGit(args, { cwd, input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr: stderr.trim() }));
    child.stdin.end(input ?? "");
  });
}

const withNewline = (patch) => (patch.endsWith("\n") ? patch : `${patch}\n`);

export function checkPatchFormat(patch) {
  if (typeof patch !== "string" || patch.trim() === "") {
    return { ok: false, reason: "patch is empty" };
  }
  const hasHeader = /^diff --git /m.test(patch) || (/^--- /m.test(patch) && /^\+\+\+ /m.test(patch));
  if (!hasHeader || !/^@@ /m.test(patch)) {
    return { ok: false, reason: "patch is not a unified diff (missing file headers or @@ hunks)" };
  }
  return { ok: true };
}

// 用 git apply --check 試套用: 只檢查, 不修改工作目錄
export async function gitApplyCheck(patch, repoPath) {
  const { code, stderr } = await runGit(["apply", "--check", "-"], { cwd: repoPath, input: withNewline(patch) });
  return code === 0 ? { ok: true } : { ok: false, reason: stderr || `git apply exited with ${code}` };
}

function parsePath(raw) {
  const value = raw.replace(/\t.*$/, "").replace(/^"(.*)"$/, "$1");
  return value === "/dev/null" ? null : value.replace(/^[ab]\//, "");
}

// 把 diff 切成每個檔案一段, 取出 index 行的 hash 與新舊路徑
function parseFileSections(patch) {
  const sections = [];
  let current;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { header: line, inHunk: false };
      sections.push(current);
      continue;
    }
    if (!current || current.inHunk) continue;
    const index = line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/);
    if (index) [, current.oldHash, current.newHash] = index;
    else if (line.startsWith("similarity index 100%")) current.pureRename = true;
    else if (line.startsWith("--- ")) current.oldPath = parsePath(line.slice(4));
    else if (line.startsWith("+++ ")) current.newPath = parsePath(line.slice(4));
    else if (line.startsWith("@@")) current.inHunk = true;
  }
  return sections;
}

const isZero = (hash) => /^0+$/.test(hash);
const notFromGit = (file, detail) => ({
  ok: false,
  reason: `${file}: ${detail}. The diff does not look like raw git diff output; actually run git and paste its output unedited`,
});

// 來源驗證: 真的 git diff 會在 index 行寫出修改前後檔案內容的 hash, 手寫的 diff 幾乎不可能猜對。
// 舊 hash 對照本機 HEAD; 新 hash 在臨時暫存區套用 patch 後計算 (不動工作目錄與真正的暫存區)。
export async function checkProvenance(patch, repoPath) {
  const sections = parseFileSections(patch);
  for (const s of sections) {
    const file = s.newPath ?? s.oldPath ?? s.header;
    if (!s.oldHash && !s.pureRename) return notFromGit(file, "missing index line");
    if (s.oldHash && !isZero(s.oldHash)) {
      const { code, stdout } = await runGit(["rev-parse", `HEAD:${s.oldPath}`], { cwd: repoPath });
      if (code !== 0) return notFromGit(file, `${s.oldPath} does not exist in the base commit`);
      if (!stdout.trim().startsWith(s.oldHash)) return notFromGit(file, `base hash ${s.oldHash} does not match the file`);
    }
  }

  const env = { ...process.env, GIT_INDEX_FILE: path.join(tmpdir(), `provenance-${randomUUID()}.index`) };
  try {
    await runGit(["read-tree", "HEAD"], { cwd: repoPath, env });
    const applied = await runGit(["apply", "--cached", "-"], { cwd: repoPath, env, input: withNewline(patch) });
    if (applied.code !== 0) return { ok: false, reason: applied.stderr };
    for (const s of sections) {
      if (!s.newHash) continue;
      const file = s.newPath ?? s.oldPath;
      const { stdout } = await runGit(["ls-files", "-s", "--", file], { cwd: repoPath, env });
      const actual = stdout.split(/\s+/)[1];
      if (isZero(s.newHash) ? actual : !actual?.startsWith(s.newHash)) {
        return notFromGit(file, `result hash ${s.newHash} does not match the patched content`);
      }
    }
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true });
  }
  return { ok: true };
}

export async function verifyPatch(patch, { verifyIn } = {}) {
  const format = checkPatchFormat(patch);
  if (!format.ok) return format;
  if (!verifyIn) return { ok: true, level: "format" };
  const applied = await gitApplyCheck(patch, verifyIn);
  if (!applied.ok) return applied;
  const provenance = await checkProvenance(patch, verifyIn);
  return provenance.ok ? { ok: true, level: "provenance" } : provenance;
}
