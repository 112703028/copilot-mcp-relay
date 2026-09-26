import { readFile, rename, writeFile } from "node:fs/promises";
import { askCopilot, stopCopilot } from "./copilot-service.mjs";
import { createGitHubClient } from "./github-client.mjs";

const token = process.env.GITHUB_TOKEN;
const owner = process.env.GITHUB_OWNER ?? "112703028";
const repo = process.env.GITHUB_REPO ?? "copilot-request-queue";
const allowedUsers = new Set(
  (process.env.GITHUB_ALLOWED_USERS ?? owner).split(",").map((value) => value.trim()).filter(Boolean),
);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const statePath = new URL("./github-poller-state.json", import.meta.url);
const responseMarker = "<!-- copilot-bridge-response -->";
let stopping = false;

if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

const { request: github } = createGitHubClient({ token });

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { issues: {} };
    throw error;
  }
}

async function saveState(state) {
  const temporaryPath = new URL("./github-poller-state.tmp", import.meta.url);
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}

async function addComment(issueNumber, body) {
  await github(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: `${responseMarker}\n${body.slice(0, 60_000)}` }),
  });
}

async function processIssue(issue, state) {
  if (!allowedUsers.has(issue.user.login)) return;

  const key = String(issue.number);
  const issueState = state.issues[key] ?? {
    sessionId: undefined,
    initialProcessed: false,
    lastCommentId: 0,
  };
  let prompt;
  let processedCommentId = issueState.lastCommentId;

  if (!issueState.initialProcessed) {
    prompt = issue.body;
  } else {
    const comments = await github(`/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100`);
    const comment = comments.find(
      (item) =>
        item.id > issueState.lastCommentId &&
        allowedUsers.has(item.user.login) &&
        !item.body.startsWith(responseMarker),
    );
    if (!comment) return;
    prompt = comment.body;
    processedCommentId = comment.id;
  }

  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > 4_000) {
    await addComment(issue.number, "Request rejected: prompt must contain 1 to 4,000 characters.");
    issueState.initialProcessed = true;
    issueState.lastCommentId = processedCommentId;
    state.issues[key] = issueState;
    await saveState(state);
    return;
  }

  console.log(`Processing ${owner}/${repo}#${issue.number}`);
  const result = await askCopilot(prompt, issueState.sessionId);
  await addComment(issue.number, result.answer);

  issueState.sessionId = result.sessionId;
  issueState.initialProcessed = true;
  issueState.lastCommentId = processedCommentId;
  state.issues[key] = issueState;
  await saveState(state);
}

async function poll() {
  const state = await loadState();
  const issues = await github(
    `/repos/${owner}/${repo}/issues?state=open&labels=copilot-request&sort=created&direction=asc&per_page=20`,
  );

  for (const issue of issues) {
    if (stopping) return;
    if (!issue.pull_request) {
      await processIssue(issue, state);
    }
  }
}

async function main() {
  console.log(`Polling ${owner}/${repo} every ${pollIntervalMs / 1000} seconds`);
  while (!stopping) {
    try {
      await poll();
    } catch (error) {
      console.error(error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

const shutdown = async () => {
  stopping = true;
  await stopCopilot();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await main();