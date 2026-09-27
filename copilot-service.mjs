import "dotenv/config";
import { homedir } from "node:os";
import path from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";

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

export async function askCopilot(prompt, sessionId) {
  const session = sessionId
    ? await client.resumeSession(sessionId, sessionConfig)
    : await client.createSession(sessionConfig);

  try {
    const response = await session.sendAndWait({ prompt });
    if (!response) {
      throw new Error("Copilot completed without an assistant message");
    }
    return { answer: response.data.content, sessionId: session.sessionId };
  } finally {
    await session.disconnect();
  }
}

export async function stopCopilot() {
  await client.stop();
}