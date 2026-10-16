export function createAskCopilot({ client, sessionConfig, timeoutMs }) {
  return async function askCopilot(prompt, sessionId) {
    const session = sessionId
      ? await client.resumeSession(sessionId, sessionConfig)
      : await client.createSession(sessionConfig);

    try {
      // SDK 不給 timeout 時預設 60 秒; clone + 改 code 常超過, 一定要明確傳入
      const response = await session.sendAndWait({ prompt }, timeoutMs);
      if (!response) {
        throw new Error("Copilot completed without an assistant message");
      }
      return { answer: response.data.content, sessionId: session.sessionId };
    } finally {
      await session.disconnect();
    }
  };
}
