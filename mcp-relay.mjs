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
  {
    issueNumber: z.number().describe("copilot_patch 回傳的 issueNumber"),
  },
  async ({ issueNumber }) => {
    const r = await relay.checkPatch({ issueNumber });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
