import http from "node:http";
import { askCopilot, stopCopilot } from "./copilot-service.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.BRIDGE_API_KEY;

if (!apiKey) {
  throw new Error("BRIDGE_API_KEY is required");
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) {
      throw new Error("Request body is too large");
    }
  }
  return JSON.parse(body);
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200);
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method !== "POST" || request.url !== "/ask") {
    response.writeHead(404);
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (request.headers["x-api-key"] !== apiKey) {
    response.writeHead(401);
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    const { prompt } = await readJson(request);
    if (typeof prompt !== "string" || prompt.trim() === "") {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "prompt must be a non-empty string" }));
      return;
    }
    const { answer } = await askCopilot(prompt);
    response.writeHead(200);
    response.end(JSON.stringify({ answer }));
  } catch (error) {
    console.error(error);
    response.writeHead(500);
    response.end(JSON.stringify({ error: "Copilot request failed" }));
  }
});

server.listen(port, host, () => {
  console.log(`Copilot bridge listening on http://${host}:${port}`);
});

const shutdown = async () => {
  server.close();
  await stopCopilot();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);