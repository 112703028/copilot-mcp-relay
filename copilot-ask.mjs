// Copilot runtime 看到 GITHUB_TOKEN / GH_TOKEN 會優先拿來登入, 而不是用 `copilot login` 存的憑證。
// poller 的 GITHUB_TOKEN 是只能讀寫 queue repo 的 PAT, 拿去登入 Copilot 會得到 Authorization error。
export function copilotRuntimeEnv(env) {
  const { GITHUB_TOKEN, GH_TOKEN, ...rest } = env;
  return rest;
}

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
