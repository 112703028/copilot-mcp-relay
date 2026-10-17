import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { createAskCopilot } from "./copilot-ask.mjs";
import { createWorkerPermissionPolicy } from "./worker-permissions.mjs";

function toWindowsPath(value) {
  const msysPath = value.match(/^\/([a-zA-Z])\/(.*)$/);
  return msysPath ? `${msysPath[1]}:\\${msysPath[2].replaceAll("/", "\\")}` : value;
}

const configuredCopilotHome = process.env.COPILOT_HOME ?? path.join(process.env.HOME ?? homedir(), ".copilot");
const copilotHome = toWindowsPath(configuredCopilotHome);
const client = new CopilotClient({ baseDirectory: copilotHome, logLevel: "error" });

await client.start();

const workRoot = toWindowsPath(process.env.COPILOT_WORK_DIR ?? path.join(tmpdir(), "copilot-bridge-work"));
await mkdir(workRoot, { recursive: true });

// 預設只放行工作目錄內的操作; COPILOT_PERMISSION_MODE=approve-all 是白名單擋到正常操作時的緊急開關
const policy = createWorkerPermissionPolicy({ workRoot });
function restrictedPermissions(request, invocation) {
  const decision = policy(request, invocation);
  if (decision.kind === "reject") console.error(`Permission rejected: ${decision.feedback}`);
  return decision;
}

const sessionConfig = {
  model: process.env.COPILOT_MODEL ?? "gpt-5",
  workingDirectory: workRoot,
  onPermissionRequest: process.env.COPILOT_PERMISSION_MODE === "approve-all" ? approveAll : restrictedPermissions,
};

export const askCopilot = createAskCopilot({
  client,
  sessionConfig,
  timeoutMs: Number(process.env.COPILOT_TIMEOUT_MS ?? 600_000),
});

export async function stopCopilot() {
  await client.stop();
}
