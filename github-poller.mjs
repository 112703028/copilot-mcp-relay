import "dotenv/config";
import { readFile } from "node:fs/promises";
import { askCopilot, stopCopilot } from "./copilot-service.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { createPoller } from "./poller-core.mjs";

const token = process.env.GITHUB_TOKEN;
const owner = process.env.GITHUB_OWNER ?? "112703028";
const repo = process.env.GITHUB_REPO ?? "copilot-request-queue";
const allowedUsers = new Set(
  (process.env.GITHUB_ALLOWED_USERS ?? owner).split(",").map((value) => value.trim()).filter(Boolean),
);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const maxFailures = Number(process.env.MAX_FAILURES ?? 3);
let stopping = false;

if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

const { request } = createGitHubClient({ token });

// 舊版 poller 把 sessionId 存在本機 state 檔; 新版改記在 Issue 的回覆裡。
// 只讀不寫: 讓舊格式 Issue 的追問還能接續原本的 Copilot session。
async function loadLegacySessionIds() {
  try {
    const state = JSON.parse(await readFile(new URL("./github-poller-state.json", import.meta.url), "utf8"));
    return Object.fromEntries(
      Object.entries(state.issues ?? {}).filter(([, s]) => s.sessionId).map(([n, s]) => [n, s.sessionId]),
    );
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

const poller = createPoller({
  request,
  owner,
  repo,
  allowedUsers,
  askCopilot,
  maxFailures,
  legacySessionIds: await loadLegacySessionIds(),
});

async function main() {
  console.log(`Polling ${owner}/${repo} every ${pollIntervalMs / 1000} seconds`);
  while (!stopping) {
    try {
      await poller.poll({ isStopping: () => stopping });
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
