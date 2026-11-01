import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import plugin from "../src/index";

vi.mock("@loreai/gateway", () => ({
  startGateway: vi.fn(async () => {
    throw new Error("an alternate gateway must not start in this test");
  }),
  readPortFile: vi.fn(() => null),
  prepareSourceUiAssets: vi.fn(async () => ({
    attempted: false,
    files: 0,
    buildId: null,
  })),
}));

const originalFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };

type Context = Parameters<NonNullable<typeof plugin.setup>>[0];
type Hooks = {
  [Kind in "prompt" | "http.request" | "http.response"]: Array<
    (event: never) => Promise<void> | void
  >;
};

async function harness() {
  const hooks: Hooks = { prompt: [], "http.request": [], "http.response": [] };
  const tools: Array<{ name: string }> = [];
  const ctx = {
    location: {
      directory: process.cwd(),
      project: { id: "v2-routing", directory: process.cwd() },
    },
    session: {
      hook: async (kind: keyof Hooks, callback: never) => {
        hooks[kind].push(callback);
        return { dispose: async () => {} };
      },
      get: async () => ({ id: "v2-session" }),
      context: async () => [],
    },
    agent: {
      transform: async () => ({ dispose: async () => {} }),
    },
    tool: {
      transform: async (
        callback: (editor: { add: (tool: { name: string }) => void }) => void,
      ) => {
        callback({ add: (tool) => tools.push(tool) });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Context;
  vi.resetModules();
  const candidate = (await import("../src/index")).default;
  await candidate.setup?.(ctx);
  return { hooks, tools };
}

function request(message: string): Request {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "synthetic-provider-key",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 32,
      messages: [{ role: "user", content: message }],
    }),
  });
}

describe("V2 native HTTP routing", () => {
  let gateway: Server;
  let baseURL: string;
  const seen: Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }> = [];

  beforeAll(async () => {
    process.env = { ...originalEnvironment };
    process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
    globalThis.fetch = originalFetch;
    gateway = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          url: req.url ?? "",
          headers: Object.fromEntries(
            Object.entries(req.headers).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value]] : [],
            ),
          ),
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
    });
    await new Promise<void>((resolve) =>
      gateway.listen(0, "127.0.0.1", resolve),
    );
    baseURL = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });

  test("routes a native request with Lore attribution", async () => {
    process.env.LORE_GATEWAY_URL = baseURL;
    const { hooks } = await harness();
    const event = {
      sessionID: "v2-session",
      agent: "build",
      model: { providerID: "synthetic", id: "synthetic-model" },
      kind: "primary",
      request: request("v2-routing-marker"),
    };
    for (const hook of hooks.prompt) {
      await hook({ sessionID: "v2-session", messageID: "v2-turn" } as never);
    }
    for (const hook of hooks["http.request"]) await hook(event as never);
    expect(event.request.url).toBe(`${baseURL}/v1/messages`);
    expect(event.request.headers.get("x-lore-session-id")).toBe("v2-session");
    expect(event.request.headers.get("x-lore-native-turn-id")).toBe("v2-turn");
    expect(event.request.headers.get("x-lore-upstream-url")).toBe(
      "https://api.anthropic.com",
    );
  });

  test("routes a loopback upstream through the healthy gateway", async () => {
    process.env.LORE_GATEWAY_URL = baseURL;
    const { hooks } = await harness();
    const event = {
      sessionID: "v2-loopback-session",
      agent: "build",
      model: { providerID: "synthetic", id: "synthetic-model" },
      kind: "primary",
      request: new Request("http://127.0.0.1:4010/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "synthetic",
        },
        body: JSON.stringify({
          model: "synthetic-model",
          max_tokens: 1024,
          system: "You are a coding assistant. ".repeat(30),
          messages: [{ role: "user", content: "loopback-marker" }],
        }),
      }),
    };
    for (const hook of hooks["http.request"]) await hook(event as never);
    expect(event.request.url).toBe(`${baseURL}/v1/messages`);
    expect(event.request.headers.get("x-lore-upstream-url")).toBe(
      "http://127.0.0.1:4010",
    );
    expect(event.request.headers.get("x-lore-upstream-path")).toBe("/messages");
  });

  test("leaves the configured upstream unchanged when the gateway is unavailable", async () => {
    process.env.LORE_GATEWAY_URL = "http://127.0.0.1:1";
    const { hooks } = await harness();
    const event = {
      sessionID: "v2-fallback",
      agent: "build",
      model: { providerID: "synthetic", id: "synthetic-model" },
      kind: "primary",
      request: request("upstream-must-still-work"),
    };
    for (const hook of hooks["http.request"]) await hook(event as never);
    expect(event.request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(event.request.headers.get("x-lore-session-id")).toBeNull();
    expect(event.request.headers.get("x-lore-upstream-url")).toBeNull();
    const lifecycle = await import("../src/lifecycle");
    expect(lifecycle.gatewayStartError()).toBeNull();
    const { startGateway } = await import("@loreai/gateway");
    expect(startGateway).not.toHaveBeenCalled();
  });
});
