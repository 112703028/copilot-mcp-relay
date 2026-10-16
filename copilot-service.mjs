import "dotenv/config";
import { homedir } from "node:os";
import path from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { createAskCopilot } from "./copilot-ask.mjs";

function toWindowsPath(value) {
  const msysPath = value.match(/^\/([a-zA-Z])\/(.*)$/);
  return msysPath ? `${msysPath[1]}:\\${msysPath[2].replaceAll("/", "\\")}` : value;
}

const configuredCopilotHome = process.env.COPILOT_HOME ?? path.join(process.env.HOME ?? homedir(), ".copilot");
const copilotHome = toWindowsPath(configuredCopilotHome);
const client = new CopilotClient({ baseDirectory: copilotHome, logLevel: "error" });

await client.start();

const sessionConfig = {
  model: process.env.COPILOT_MODEL ?? "gpt-5",
  onPermissionRequest: approveAll,
};

export const askCopilot = createAskCopilot({
  client,
  sessionConfig,
  timeoutMs: Number(process.env.COPILOT_TIMEOUT_MS ?? 600_000),
});

export async function stopCopilot() {
  await client.stop();
}
