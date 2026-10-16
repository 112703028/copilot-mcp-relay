import { spawn } from "node:child_process";

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
export function gitApplyCheck(patch, repoPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["apply", "--check", "-"], { cwd: repoPath });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, reason: stderr.trim() || `git apply exited with ${code}` });
    });
    child.stdin.end(patch.endsWith("\n") ? patch : `${patch}\n`);
  });
}

export async function verifyPatch(patch, { verifyIn } = {}) {
  const format = checkPatchFormat(patch);
  if (!format.ok) return format;
  if (!verifyIn) return { ok: true, level: "format" };
  const applied = await gitApplyCheck(patch, verifyIn);
  return applied.ok ? { ok: true, level: "git-apply-check" } : applied;
}
