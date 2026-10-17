import { test } from "node:test";
import assert from "node:assert/strict";
import { createAskCopilot } from "../copilot-ask.mjs";

function fakeClient() {
  const sendCalls = [];
  const session = {
    sessionId: "s1",
    sendAndWait: async (options, timeout) => {
      sendCalls.push({ options, timeout });
      return { data: { content: "answer" } };
    },
    disconnect: async () => {},
  };
  return {
    client: { createSession: async () => session, resumeSession: async () => session },
    sendCalls,
  };
}

test("askCopilot: 呼叫 sendAndWait 時傳入設定的 timeout (不用 SDK 預設 60 秒)", async () => {
  const { client, sendCalls } = fakeClient();
  const ask = createAskCopilot({ client, sessionConfig: {}, timeoutMs: 600_000 });

  const r = await ask("do it");

  assert.equal(sendCalls[0].timeout, 600_000);
  assert.deepEqual(r, { answer: "answer", sessionId: "s1" });
});
