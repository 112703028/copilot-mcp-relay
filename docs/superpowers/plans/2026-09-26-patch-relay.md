# Copilot Patch Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 家裡新增一個 stdio MCP server，讓家裡 Claude Code 用 tool 把「對某個 public GitHub repo 做修改」的任務派給公司電腦的 Copilot，取回 unified diff patch。

**Architecture:** 家裡 MCP server（`mcp-relay.mjs`）透過既有 GitHub Issue 中轉：開 Issue（結構化任務模板）→ 輪詢 queue repo 的 comments 等帶 marker 的回覆 → 從回覆擷取 patch → 回傳給 MCP client。公司端 poller/Copilot 完全不改。GitHub fetch 邏輯抽成共用的 `github-client.mjs`，poller 與 relay 共用。

**Tech Stack:** Node.js 24（ESM `.mjs`）、`@modelcontextprotocol/sdk`（stdio transport）、`dotenv`、內建 `fetch`、內建 `node:test` + `node:assert` 做單元測試。

**Spec:** `docs/superpowers/specs/2026-09-26-patch-relay-design.md`

## Global Constraints

- Node.js `^20.19.0` 或 `>=22.12.0`（已驗證 Node 24.11.0）。
- 純 ESM，副檔名 `.mjs`，`package.json` 現為 `"type": "commonjs"` — 故 `.mjs` 明確走 ESM，不改 type。
- 單元測試用內建 `node:test`（`import { test } from "node:test"`）+ `node:assert/strict`，不引入外部測試框架。
- queue repo 預設 `112703028/copilot-request-queue`，label `copilot-request`，response marker `<!-- copilot-bridge-response -->`（與 poller 一致，不可改）。
- patch 圍欄標記：Copilot 回覆中 patch 放在 ```` ```diff ```` … ```` ``` ```` 圍欄內。
- 目標 repo 必須 public（EMU 讀不到 private），這是使用者責任，程式不強制驗證但錯誤要能誠實回報。
- 秘密（token）只從 `.env` 或環境變數讀，絕不寫入程式碼或 commit。

## Review Focus

- **同一 Issue 追問時抓到舊 patch**：`copilot_patch` 對已用過的 Issue（理論上每次開新 Issue，但 `check_patch` 查舊 Issue 時）必須只認送任務後才出現的 comment（baseline id 機制），否則回傳上一輪的 patch。→ Task 4 測。
- **Copilot 回覆不含 patch 圍欄**（例如 clone 失敗、它只回錯誤文字）：擷取器不可誤把整段錯誤當 patch，須降級回報「無法擷取」。→ Task 3 測。
- **GitHub API 非 2xx**（401 token 失效 / 404 repo 看不到）：`github-client` 要拋出帶狀態碼與 body 的錯誤，不可回傳 undefined 讓上層誤判。→ Task 1 測。
- **輪詢逾時**：到 `timeoutSeconds` 仍無 marker comment，須回 `{ status: "pending", issueNumber }` 而非拋錯或無限等待。→ Task 5 測。
- **回覆 comment 同時存在多則 marker**（poller 因故寫了多次）：擷取須取 baseline 之後「第一則」帶 patch 的，行為明確。→ Task 4 測。

---

## Task 0: 專案版控與依賴初始化

**Files:**
- Create: `.gitignore`（已存在，確認內容）
- Modify: `package.json`（加依賴與 script）

**Interfaces:**
- Produces: 一個 git repo、裝好 `@modelcontextprotocol/sdk`、`npm run mcp` script。

- [ ] **Step 1: 初始化 git repo（若尚未）**

Run:
```bash
cd "c:/Users/timwu/source/copilot-bridge"
git rev-parse --is-inside-work-tree 2>/dev/null || git init
```
Expected: 若非 repo 則建立 `.git`。

- [ ] **Step 2: 確認 .gitignore 涵蓋秘密與狀態檔**

確認 `.gitignore` 含（現有已有前三項）：
```
.env
github-poller-state.json
github-poller-state.tmp
node_modules
```
若缺 `node_modules` 則補上。

- [ ] **Step 3: 安裝 MCP SDK**

Run:
```bash
npm install @modelcontextprotocol/sdk
```
Expected: `package.json` dependencies 出現 `@modelcontextprotocol/sdk`。

- [ ] **Step 4: 加 mcp script**

Modify `package.json` scripts，加一行：
```json
"mcp": "node mcp-relay.mjs"
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore package.json package-lock.json
git commit -m "chore: init git, add MCP SDK dependency and mcp script"
```

---

## Task 1: 抽出共用 GitHub client

**Files:**
- Create: `github-client.mjs`
- Test: `test/github-client.test.mjs`
- Modify: `github-poller.mjs:19-36`（改為 import 共用函式）

**Interfaces:**
- Produces:
  - `createGitHubClient({ token, baseUrl = "https://api.github.com" }) → { request }`
  - `request(path, options?) → Promise<any | undefined>`：成功回 JSON（204 回 `undefined`）；非 2xx 拋 `Error`，message 格式 `GitHub API <status>: <body 前 500 字>`。

- [ ] **Step 1: 寫失敗測試**

`test/github-client.test.mjs`：
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitHubClient } from "../github-client.mjs";

test("request 成功回傳 JSON", async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200, json: async () => ({ hello: "world" }),
  });
  const { request } = createGitHubClient({ token: "t", fetchImpl: fakeFetch });
  assert.deepEqual(await request("/x"), { hello: "world" });
});

test("request 204 回 undefined", async () => {
  const fakeFetch = async () => ({ ok: true, status: 204 });
  const { request } = createGitHubClient({ token: "t", fetchImpl: fakeFetch });
  assert.equal(await request("/x"), undefined);
});

test("request 非 2xx 拋錯含狀態碼與 body", async () => {
  const fakeFetch = async () => ({
    ok: false, status: 404, text: async () => "not found",
  });
  const { request } = createGitHubClient({ token: "t", fetchImpl: fakeFetch });
  await assert.rejects(() => request("/x"), /GitHub API 404: not found/);
});

test("request 帶正確 headers", async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { request } = createGitHubClient({ token: "abc", fetchImpl: fakeFetch });
  await request("/repos/x");
  assert.equal(seen.url, "https://api.github.com/repos/x");
  assert.equal(seen.opts.headers.Authorization, "Bearer abc");
  assert.equal(seen.opts.headers["X-GitHub-Api-Version"], "2022-11-28");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/github-client.test.mjs`
Expected: FAIL（`createGitHubClient` 未定義）。

- [ ] **Step 3: 寫最小實作**

`github-client.mjs`：
```javascript
export function createGitHubClient({ token, baseUrl = "https://api.github.com", fetchImpl = fetch }) {
  async function request(path, options = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
    }
    return response.status === 204 ? undefined : response.json();
  }
  return { request };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/github-client.test.mjs`
Expected: PASS（4 tests）。

- [ ] **Step 5: 讓 poller 改用共用 client**

Modify `github-poller.mjs`：把檔頭 `github()` 函式（行 19-36）替換為：
```javascript
import { createGitHubClient } from "./github-client.mjs";
const { request: github } = createGitHubClient({ token });
```
（刪除原本內嵌的 `async function github(...)` 定義；其餘呼叫 `github(path, options)` 簽章不變，無需改。）

- [ ] **Step 6: 手動驗證 poller 仍可載入**

Run: `node -e "import('./github-poller.mjs').catch(e => { if (String(e).includes('GITHUB_TOKEN')) { console.log('OK: 載入到預期的 token 檢查'); process.exit(0);} else throw e; })"`
Expected: 印出 `OK: 載入到預期的 token 檢查`（證明 import 鏈正常，只卡在預期的 token 必填）。

- [ ] **Step 7: Commit**

```bash
git add github-client.mjs test/github-client.test.mjs github-poller.mjs
git commit -m "refactor: extract shared github-client, reuse in poller"
```

---

## Task 2: Issue 任務模板產生器

**Files:**
- Create: `relay-prompt.mjs`
- Test: `test/relay-prompt.test.mjs`

**Interfaces:**
- Produces:
  - `buildPatchTaskBody({ repo, task }) → string`：產生給 Copilot 的結構化 Issue body，內含 clone public repo、改、產 diff、不 push、清暫存的指示，並要求 patch 放在 ```` ```diff ```` 圍欄。

- [ ] **Step 1: 寫失敗測試**

`test/relay-prompt.test.mjs`：
```javascript
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/relay-prompt.test.mjs`
Expected: FAIL（`buildPatchTaskBody` 未定義）。

- [ ] **Step 3: 寫最小實作**

`relay-prompt.mjs`：
```javascript
export function buildPatchTaskBody({ repo, task }) {
  return [
    `請對 public GitHub repo \`${repo}\` 進行以下修改,並以 unified diff patch 回傳。`,
    "你不需要 push、不需要開 PR。全程只做讀取與產生 diff。",
    "",
    "步驟:",
    `1. 在暫存目錄用 \`git clone --depth 1 https://github.com/${repo}.git\` clone 該 repo(這是 public repo,一般 clone 即可)。`,
    "2. 依下面的任務描述完成修改。",
    "3. 用 `git add -A` 後執行 `git diff --cached` 產生完整 unified diff。",
    "4. 做完後刪除暫存目錄。",
    "",
    "把最終 diff 放在一個 ```diff 圍欄區塊中貼回,方便我擷取。除了 diff 圍欄外,可另附簡短說明。",
    "**不要 push、不要開 PR。若 clone 或任何步驟失敗,請照實貼出錯誤訊息,不要假裝成功。**",
    "",
    "---",
    "任務描述:",
    task,
  ].join("\n");
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/relay-prompt.test.mjs`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add relay-prompt.mjs test/relay-prompt.test.mjs
git commit -m "feat: add patch task body template"
```

---

## Task 3: patch 擷取器

**Files:**
- Create: `patch-extract.mjs`
- Test: `test/patch-extract.test.mjs`

**Interfaces:**
- Produces:
  - `extractPatch(commentBody) → { ok: true, patch: string } | { ok: false, reason: string, raw: string }`：從 comment 內容擷取 ```` ```diff ```` 圍欄內的 patch；找不到圍欄則 `ok: false`，`raw` 帶原文供上層判讀。須先去掉開頭的 response marker 行。

- [ ] **Step 1: 寫失敗測試**

`test/patch-extract.test.mjs`：
```javascript
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/patch-extract.test.mjs`
Expected: FAIL（`extractPatch` 未定義）。

- [ ] **Step 3: 寫最小實作**

`patch-extract.mjs`：
```javascript
const MARKER = "<!-- copilot-bridge-response -->";

export function extractPatch(commentBody) {
  const raw = commentBody.startsWith(MARKER)
    ? commentBody.slice(MARKER.length).trim()
    : commentBody;
  const match = raw.match(/```diff\s*\n([\s\S]*?)\n```/);
  if (!match) {
    return { ok: false, reason: "no diff fence found", raw };
  }
  return { ok: true, patch: match[1] };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/patch-extract.test.mjs`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add patch-extract.mjs test/patch-extract.test.mjs
git commit -m "feat: add patch extractor with diff-fence parsing"
```

---

## Task 4: 回覆比對（baseline + marker）

**Files:**
- Create: `find-response.mjs`
- Test: `test/find-response.test.mjs`

**Interfaces:**
- Consumes: response marker 常數。
- Produces:
  - `findNewResponse(comments, baselineId) → comment | undefined`：從 comments 找第一則 `id > baselineId` 且 body 以 response marker 開頭者。
  - `maxCommentId(comments) → number`：回傳目前最大 comment id（無則 0），供送任務前記 baseline。

- [ ] **Step 1: 寫失敗測試**

`test/find-response.test.mjs`：
```javascript
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/find-response.test.mjs`
Expected: FAIL（未定義）。

- [ ] **Step 3: 寫最小實作**

`find-response.mjs`：
```javascript
const MARKER = "<!-- copilot-bridge-response -->";

export function findNewResponse(comments, baselineId) {
  return comments
    .filter((c) => c.id > baselineId && c.body.startsWith(MARKER))
    .sort((a, b) => a.id - b.id)[0];
}

export function maxCommentId(comments) {
  return comments.reduce((max, c) => (c.id > max ? c.id : max), 0);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/find-response.test.mjs`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add find-response.mjs test/find-response.test.mjs
git commit -m "feat: add baseline+marker response matcher"
```

---

## Task 5: relay 核心（開 Issue → 輪詢 → 取 patch）

**Files:**
- Create: `relay-core.mjs`
- Test: `test/relay-core.test.mjs`

**Interfaces:**
- Consumes: `createGitHubClient`（Task 1）、`buildPatchTaskBody`（Task 2）、`extractPatch`（Task 3）、`findNewResponse`/`maxCommentId`（Task 4）。
- Produces:
  - `createRelay({ request, owner, repo, sleep? }) → { requestPatch, checkPatch }`
  - `requestPatch({ repo: targetRepo, task, timeoutMs, pollMs }) → { patch, issueNumber } | { status: "pending", issueNumber } | { status: "error", issueNumber, raw }`
  - `checkPatch({ issueNumber, baselineId }) → { status: "ready", patch } | { status: "pending" } | { status: "error", raw }`
  - 注意：`request` 是注入的 GitHub client（可測試）；`sleep` 預設 `setTimeout` 包裝，測試注入立即 resolve。

- [ ] **Step 1: 寫失敗測試**

`test/relay-core.test.mjs`：
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../relay-core.mjs";

const M = "<!-- copilot-bridge-response -->";

function fakeRequest(script) {
  // script: 依序回傳的回應陣列;每次呼叫取下一個
  let i = 0;
  const calls = [];
  return {
    request: async (path, options) => {
      calls.push({ path, method: options?.method ?? "GET" });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return typeof step === "function" ? step(path, options) : step;
    },
    calls,
  };
}

test("requestPatch: 開 Issue 後輪詢拿到 patch", async () => {
  const script = [
    // POST 建 Issue
    { number: 42 },
    // 第一次 GET comments: 還沒回覆
    [],
    // 第二次 GET comments: 有 marker + diff
    [{ id: 100, body: `${M}\n\`\`\`diff\ndiff --git a/x b/x\n+y\n\`\`\`` }],
  ];
  const { request, calls } = fakeRequest(script);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestPatch({ repo: "o/target", task: "t", timeoutMs: 10000, pollMs: 1 });
  assert.equal(r.issueNumber, 42);
  assert.match(r.patch, /diff --git a\/x b\/x/);
  assert.equal(calls[0].method, "POST"); // 建 Issue
});

test("requestPatch: 逾時回 pending", async () => {
  const script = [{ number: 7 }, []]; // 建 Issue 後永遠空
  const { request } = fakeRequest(script);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 5, pollMs: 1 });
  assert.equal(r.status, "pending");
  assert.equal(r.issueNumber, 7);
});

test("requestPatch: 回覆無 diff 圍欄則 status error 帶 raw", async () => {
  const script = [
    { number: 9 },
    [{ id: 200, body: `${M}\nclone 失敗: not found` }],
  ];
  const { request } = fakeRequest(script);
  const relay = createRelay({ request, owner: "o", repo: "q", sleep: async () => {} });
  const r = await relay.requestPatch({ repo: "o/t", task: "t", timeoutMs: 10000, pollMs: 1 });
  assert.equal(r.status, "error");
  assert.match(r.raw, /clone 失敗/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/relay-core.test.mjs`
Expected: FAIL（`createRelay` 未定義）。

- [ ] **Step 3: 寫最小實作**

`relay-core.mjs`：
```javascript
import { buildPatchTaskBody } from "./relay-prompt.mjs";
import { extractPatch } from "./patch-extract.mjs";
import { findNewResponse, maxCommentId } from "./find-response.mjs";

const RESPONSE_MARKER = "<!-- copilot-bridge-response -->";

export function createRelay({ request, owner, repo, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function createIssue(task, targetRepo) {
    const body = buildPatchTaskBody({ repo: targetRepo, task });
    const issue = await request(`/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `patch: ${targetRepo}`, body, labels: ["copilot-request"] }),
    });
    return issue.number;
  }

  async function getComments(issueNumber) {
    return request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
  }

  function classify(comment) {
    const extracted = extractPatch(comment.body);
    if (extracted.ok) return { status: "ready", patch: extracted.patch };
    return { status: "error", raw: extracted.raw };
  }

  async function pollForResponse(issueNumber, baselineId, timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const comments = await getComments(issueNumber);
      const found = findNewResponse(comments, baselineId);
      if (found) return classify(found);
      await sleep(pollMs);
    }
    return { status: "pending" };
  }

  async function requestPatch({ repo: targetRepo, task, timeoutMs = 180000, pollMs = 4000 }) {
    const issueNumber = await createIssue(task, targetRepo);
    const result = await pollForResponse(issueNumber, 0, timeoutMs, pollMs);
    if (result.status === "ready") return { patch: result.patch, issueNumber };
    if (result.status === "error") return { status: "error", issueNumber, raw: result.raw };
    return { status: "pending", issueNumber };
  }

  async function checkPatch({ issueNumber, baselineId = 0 }) {
    const comments = await getComments(issueNumber);
    const found = findNewResponse(comments, baselineId);
    if (!found) return { status: "pending" };
    return classify(found);
  }

  return { requestPatch, checkPatch };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/relay-core.test.mjs`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add relay-core.mjs test/relay-core.test.mjs
git commit -m "feat: add relay core (create issue, poll, extract patch)"
```

---

## Task 6: MCP server 進入點

**Files:**
- Create: `mcp-relay.mjs`
- Modify: `environment.example.txt`（補家裡端變數註解）

**Interfaces:**
- Consumes: `createGitHubClient`（Task 1）、`createRelay`（Task 5）。
- Produces: 一個 stdio MCP server，註冊 `copilot_patch`、`check_patch`、`ask_copilot` 三個 tool。此為進入點，無單元測試（薄的接線層），以手動 smoke 驗證。

- [ ] **Step 1: 確認 MCP SDK 的 server API 形狀**

Run:
```bash
node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m => console.log(Object.keys(m)))"
node -e "import('@modelcontextprotocol/sdk/server/stdio.js').then(m => console.log(Object.keys(m)))"
```
Expected: 印出可用的 export（預期含 `McpServer`；stdio 含 `StdioServerTransport`）。若 export 名不同，以實際印出為準調整 Step 2 的 import。

- [ ] **Step 2: 寫 MCP server**

`mcp-relay.mjs`：
```javascript
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createGitHubClient } from "./github-client.mjs";
import { createRelay } from "./relay-core.mjs";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");
const owner = process.env.GITHUB_OWNER ?? "112703028";
const repo = process.env.GITHUB_REPO ?? "copilot-request-queue";

const { request } = createGitHubClient({ token });
const relay = createRelay({ request, owner, repo });

const server = new McpServer({ name: "copilot-patch-relay", version: "1.0.0" });

server.tool(
  "copilot_patch",
  "派 Copilot 對一個 public GitHub repo 做修改,回傳 unified diff patch(不 push、不開 PR)。",
  {
    repo: z.string().describe("目標 public repo, 格式 owner/name"),
    task: z.string().describe("要 Copilot 做的修改描述"),
    timeoutSeconds: z.number().optional().describe("等待上限秒數, 預設 180"),
  },
  async ({ repo: targetRepo, task, timeoutSeconds = 180 }) => {
    const r = await relay.requestPatch({ repo: targetRepo, task, timeoutMs: timeoutSeconds * 1000 });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

server.tool(
  "check_patch",
  "查詢先前 copilot_patch 逾時的 Issue 是否已有 patch。",
  { issueNumber: z.number().describe("copilot_patch 回傳的 issueNumber") },
  async ({ issueNumber }) => {
    const r = await relay.checkPatch({ issueNumber });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

server.tool(
  "ask_copilot",
  "向 Copilot 問一個純文字問題(不涉及 repo/patch)。",
  {
    prompt: z.string().describe("問題內容"),
    timeoutSeconds: z.number().optional(),
  },
  async ({ prompt, timeoutSeconds = 180 }) => {
    // 復用 requestPatch 的中轉,但 task 直接是 prompt、不套 patch 模板:
    // 簡化起見,問答走同一 Issue 機制但期待純文字回覆(無 diff 圍欄→ status error 帶 raw 即答案)
    const r = await relay.requestPatch({ repo: "(no-repo)", task: prompt, timeoutMs: timeoutSeconds * 1000 });
    const answer = r.patch ?? r.raw ?? JSON.stringify(r);
    return { content: [{ type: "text", text: answer }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

（註：`ask_copilot` 復用中轉但語意較弱——因為 `buildPatchTaskBody` 會包 patch 指示。若 Step 4 smoke 發現問答被 patch 模板污染，於 Task 7 修為獨立的純問答 body。先以最小實作出貨。）

- [ ] **Step 3: 確認 zod 已安裝**

Run: `node -e "import('zod').then(()=>console.log('zod ok')).catch(()=>console.log('need install'))"`
若印 `need install`：`npm install zod`

- [ ] **Step 4: Smoke test — server 啟動且列出 tools**

Run（無 token 應報錯，證明檢查生效）:
```bash
node -e "delete process.env.GITHUB_TOKEN; import('./mcp-relay.mjs').catch(e => console.log(String(e).includes('GITHUB_TOKEN') ? 'OK: token check' : 'FAIL: '+e))"
```
Expected: `OK: token check`

- [ ] **Step 5: 更新 environment.example.txt 註解**

在 `environment.example.txt` 補一行註解說明家裡端只需 `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO`（MCP relay 用）。

- [ ] **Step 6: Commit**

```bash
git add mcp-relay.mjs environment.example.txt package.json package-lock.json
git commit -m "feat: add stdio MCP server exposing copilot_patch/check_patch/ask_copilot"
```

---

## Task 7: 端到端手動 smoke test 與 README

**Files:**
- Create: `docs/patch-relay-smoke.md`（手動驗證步驟）
- Modify: `README.md`（加 Patch Relay 章節）

**Interfaces:**
- Consumes: 完整的 `mcp-relay.mjs`。
- Produces: 可重複的手動 e2e 驗證步驟 + 使用文件。

- [ ] **Step 1: 寫手動 smoke 步驟文件**

`docs/patch-relay-smoke.md`，內容涵蓋：
```markdown
# Patch Relay 手動 e2e Smoke Test

前提: 公司電腦 poller 在跑、Copilot 已登入、目標 repo 為 public。

1. 家裡 `.env` 設好 GITHUB_TOKEN(個人 PAT, queue repo Issues 讀寫)。
2. 在 MCP client(Claude Code)設定此 server: `node mcp-relay.mjs`(stdio)。
3. 呼叫 copilot_patch({ repo: "112703028/first-contributions", task: "在根目錄新增 HELLO.md, 內容寫一行 hello relay" })。
4. 預期: 回傳含 patch 的 JSON, patch 內容為新增 HELLO.md 的 diff。
5. 家裡 Claude 展示 patch → 確認 → git apply 到本機 clone 的同 repo → 驗證檔案出現。
6. 逾時情境: 若回 status pending + issueNumber, 用 check_patch({ issueNumber }) 補查。
```

- [ ] **Step 2: 執行一次真實 e2e（需 poller 在跑）**

用 MCP client 或直接寫一支臨時 driver 呼叫 `relay.requestPatch({ repo: "112703028/first-contributions", task: "在根目錄新增 HELLO.md 內容一行 hello relay" })`，確認拿回真實 patch。
Expected: 回傳物件含 `patch`，patch 內含 `diff --git` 與 `HELLO.md`。
（此步依賴外部 poller/Copilot，屬手動 smoke；若當下 poller 未跑則記錄為待驗證，不阻塞 commit。）

- [ ] **Step 3: 寫 README Patch Relay 章節**

在 `README.md` 新增章節，說明：Patch Relay 用途、`npm run mcp` 啟動、MCP client 設定、`copilot_patch`/`check_patch`/`ask_copilot` 三 tool、**目標 repo 必須 public** 的前提、patch 先審後套的流程、EMU 限制導致不能自動 push 的說明。

- [ ] **Step 4: Commit**

```bash
git add docs/patch-relay-smoke.md README.md
git commit -m "docs: add patch relay smoke test and README section"
```

---

## 完成後

- 全部單元測試：`node --test`（Task 1-5 的測試應全綠）。
- 手動 e2e：依 `docs/patch-relay-smoke.md`（需公司端 poller 在跑）。
- 使用 superpowers:requesting-code-review 對整個 branch 做審查。
