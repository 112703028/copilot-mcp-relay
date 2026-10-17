import path from "node:path";

// worker 會 clone 並閱讀不受信任的 repo, repo 內容可能藏有 prompt injection。
// 所以不用 approveAll, 只放行「在專用工作目錄內 clone、讀、改、產 diff」需要的操作, 其他一律拒絕。

const ALLOWED_COMMANDS = new Set([
  "git", "cd", "pwd", "ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "findstr", "echo",
  "mkdir", "rm", "rmdir",
  "set-location", "get-location", "get-childitem", "get-content", "select-string", "test-path",
  "new-item", "remove-item", "write-output",
]);
const FORBIDDEN_GIT = /\bgit\b[^|;&\n]*\s(push|config|credential|remote|submodule)\b/i;
// 這些 git 參數本身就能執行任意指令 (例如 git -c core.pager='...' diff), 不論子指令為何都拒絕
const FORBIDDEN_GIT_OPTIONS = /\bgit\b[^|;&\n]*\s(-c\s|-c$|--config-env\b|--upload-pack\b|--receive-pack\b|--exec\b|-u\s)/i;
const ALLOWED_URL = /^https:\/\/github\.com\//i;
// 指令替換會在允許的指令裡偷偷執行別的指令, 例如 echo $(curl ...)
const COMMAND_SUBSTITUTION = /\$\(|`/;

// 不相信 runtime 回報的 identifier 格式 (實測是整段指令文字, 而非執行檔名稱),
// 自己依 ; | && || 換行切段, 取每段第一個字, 去掉路徑與 .exe 等副檔名
export function commandNames(text) {
  return text
    .split(/\r?\n|;|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const first = segment.startsWith('"') ? segment.slice(1, segment.indexOf('"', 1)) : segment.split(/\s+/)[0];
      return first.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
    });
}

export function createWorkerPermissionPolicy({ workRoot }) {
  const root = path.resolve(workRoot);

  function inside(p) {
    if (!p) return false;
    const rel = path.relative(root, path.resolve(root, p));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  const approve = () => ({ kind: "approve-once" });
  const reject = (feedback) => ({ kind: "reject", feedback: `${feedback} (worker 只允許在 ${root} 內操作)` });

  function decideShell(request) {
    const text = request.fullCommandText ?? "";
    if (COMMAND_SUBSTITUTION.test(text)) return reject("command substitution ($( ) or backticks) is not allowed");
    const names = [text, ...(request.commands ?? []).map((c) => c.identifier)].flatMap(commandNames);
    const disallowed = names.find((name) => !ALLOWED_COMMANDS.has(name));
    if (disallowed) return reject(`command not allowed: ${disallowed}`);
    if (FORBIDDEN_GIT.test(text)) return reject("git push/config/credential/remote/submodule are not allowed");
    if (FORBIDDEN_GIT_OPTIONS.test(text)) return reject("git options that can execute commands (-c, --upload-pack, ...) are not allowed");
    const urls = [
      ...(request.possibleUrls ?? []).map((u) => u.url),
      ...(text.match(/\bhttps?:\/\/\S+/gi) ?? []),
    ];
    const badUrl = urls.find((u) => !ALLOWED_URL.test(u));
    if (badUrl) return reject(`only https://github.com/ URLs are allowed: ${badUrl}`);
    const paths = (request.possiblePaths ?? []).map((p) => request.resolvedPaths?.[p] ?? p);
    const outside = paths.find((p) => !inside(p));
    if (outside) return reject(`path outside the work directory: ${outside}`);
    return approve();
  }

  return function decide(request, invocation = {}) {
    // 組織政策要求人工確認時不自動放行, 交回給政策處理 (與 SDK 的 approveAll 行為一致)
    if (request.managedApprovalRequired || invocation.managedSettingsEnabled) return { kind: "no-result" };

    switch (request.kind) {
      case "read": {
        const p = request.resolvedPath ?? request.path;
        return inside(p) ? approve() : reject(`read outside the work directory: ${p}`);
      }
      case "write": {
        const p = request.resolvedPath ?? request.fileName;
        return inside(p) ? approve() : reject(`write outside the work directory: ${p}`);
      }
      case "shell":
        return decideShell(request);
      default:
        return reject(`permission kind not allowed: ${request.kind}`);
    }
  };
}
