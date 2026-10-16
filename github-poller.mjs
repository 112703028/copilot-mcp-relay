import { readFile, rename, writeFile } from "node:fs/promises";
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
const statePath = new URL("./github-poller-state.json", import.meta.url);
let stopping = false;

if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

const { request } = createGitHubClient({ token });

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

const poller = createPoller({
  request,
  owner,
  repo,
  allowedUsers,
  askCopilot,
  store: { load: loadState, save: saveState },
  maxFailures,
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
