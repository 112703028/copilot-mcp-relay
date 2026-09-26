import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitHubClient } from "../github-client.mjs";

test("request 成功回傳 JSON", async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200, json: async () => ({ hello: "world" }),
  });
  const { request } = createGitHubClient({ token: "t", fetchImpl: fakeFetch });
  assert.deepEqual(await request("/x"), { hello: "world" });
});

test("request 204 回 undefined", async () => {
  const fakeFetch = async () => ({ ok: true, status: 204 });
  const { request } = createGitHubClient({ token: "t", fetchImpl: fakeFetch });
  assert.equal(await request("/x"), undefined);
});

test("request 非 2xx 拋錯含狀態碼與 body", async () => {
  const fakeFetch = async () => ({
    ok: false, status: 404, text: async () => "not found",
  });
  const { request } = createGitHubClient({ token: "t", fetchImpl: fakeFetch });
  await assert.rejects(() => request("/x"), /GitHub API 404: not found/);
});

test("request 帶正確 headers", async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { request } = createGitHubClient({ token: "abc", fetchImpl: fakeFetch });
  await request("/repos/x");
  assert.equal(seen.url, "https://api.github.com/repos/x");
  assert.equal(seen.opts.headers.Authorization, "Bearer abc");
  assert.equal(seen.opts.headers["X-GitHub-Api-Version"], "2022-11-28");
});
