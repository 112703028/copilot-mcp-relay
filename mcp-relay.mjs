import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createGitHubClient } from "./github-client.mjs";
import { createRelay } from "./relay-core.mjs";
import { verifyPatch } from "./patch-verify.mjs";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");
const owner = process.env.GITHUB_OWNER ?? "112703028";
const repo = process.env.GITHUB_REPO ?? "copilot-request-queue";

const { request } = createGitHubClient({ token });
const relay = createRelay({ request, owner, repo, verifyPatch });

const server = new McpServer({ name: "copilot-patch-relay", version: "1.0.0" });

const verifyParams = {
  verifyIn: z
    .string()
    .optional()
    .describe("本機目標 repo 的路徑; 給了就用 git apply --check 驗證 patch 能否套用(請先同步到遠端預設分支)。省略時只檢查格式"),
  maxRepairRounds: z
    .number()
    .optional()
    .describe("驗證失敗時自動請 Copilot 修正的輪數上限, 預設 1。每輪各自有 timeoutSeconds 的等待時間"),
};

server.tool(
  "copilot_patch",
  "派 Copilot 對一個 public GitHub repo 做修改,回傳經過驗證的 unified diff patch(不 push、不開 PR)。",
  {
    repo: z.string().describe("目標 public repo, 格式 owner/name"),
    task: z.string().describe("要 Copilot 做的修改描述"),
    timeoutSeconds: z.number().optional().describe("等待上限秒數, 預設 180"),
    ...verifyParams,
  },
  async ({ repo: targetRepo, task, timeoutSeconds = 180, verifyIn, maxRepairRounds }) => {
    const r = await relay.requestPatch({
      repo: targetRepo, task, verifyIn, maxRepairRounds, timeoutMs: timeoutSeconds * 1000,
    });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

server.tool(
  "copilot_patch_followup",
  "對先前 copilot_patch 的同一個 Issue 追問,延續 Copilot 上下文,回傳經過驗證的完整新 patch。",
  {
    issueNumber: z.number().describe("先前 copilot_patch 回傳的 issueNumber"),
    task: z.string().describe("追問內容(在先前修改基礎上的調整)"),
    timeoutSeconds: z.number().optional().describe("等待上限秒數, 預設 180"),
    ...verifyParams,
  },
  async ({ issueNumber, task, timeoutSeconds = 180, verifyIn, maxRepairRounds }) => {
    const r = await relay.requestFollowupPatch({
      issueNumber, task, verifyIn, maxRepairRounds, timeoutMs: timeoutSeconds * 1000,
    });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

server.tool(
  "check_patch",
  "查詢先前 copilot_patch 或 copilot_patch_followup 逾時的 Issue 是否已有 patch。",
  {
    issueNumber: z.number().describe("copilot_patch 回傳的 issueNumber"),
    baselineId: z
      .number()
      .optional()
      .describe("copilot_patch_followup 逾時時回傳的 baselineId; 只認這之後的回覆。省略時用本次 session 記住的值"),
  },
  async ({ issueNumber, baselineId }) => {
    const r = await relay.checkPatch({ issueNumber, baselineId });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
