import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RECALL_TOOL_NAME } from "@loreai/core";
import plugin from "../src/index";
import { loopbackRequest } from "../../gateway/test/helpers/loopback-request";

const MARKER = "DOT-282 exact synthetic session message";
const SESSION = "dot-282-session";
const TURN = "dot-282-user-turn";
const ASSISTANT = "dot-282-assistant-turn";
const originalEnvironment = { ...process.env };

type Context = Parameters<NonNullable<typeof plugin.setup>>[0];
type HttpRequest = {
  sessionID: string;
  agent: string;
  model: { providerID: string; id: string };
  kind: string;
  request: Request;
};

describe("V2 gateway HTTP recording", () => {
  let gatewayBase: string;
  let stopGateway: () => Promise<void>;
  let resetPipeline: (options?: { fast?: boolean }) => Promise<void>;
  let closeDatabase: () => void;
  let upstreamCalls = 0;
  let upstreamNativeHeader: string | undefined;
  const hooks: {
    prompt: Array<(event: unknown) => Promise<void> | void>;
    request: Array<(event: HttpRequest) => Promise<void> | void>;
  } = { prompt: [], request: [] };
  const tools = new Map<string, { execute: Function }>();

  beforeAll(async () => {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: "test",
      LORE_OPENCODE_FORCE_ACTIVE: "1",
      SENTRY_ENABLED: "0",
    };
    const { setUpstreamFetchOverrideForTest } =
      await import("../../gateway/src/fetch");
    setUpstreamFetchOverrideForTest(async (_input, init) => {
      upstreamNativeHeader =
        new Headers(init?.headers).get("x-lore-native-turn-id") ?? undefined;
      return Response.json({
        id: "dot-282-response",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Synthetic upstream response" }],
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 32, output_tokens: 8 },
      });
    });
    const { setUpstreamInterceptor } =
      await import("../../gateway/src/pipeline");
    const gateway = (await import("@loreai/gateway")) as unknown as {
      loadConfig: () => Record<string, unknown>;
      startServer: (config: unknown) => Promise<{
        stop: () => Promise<void>;
        port: number;
      }>;
      resetPipelineState: (options?: { fast?: boolean }) => Promise<void>;
    };
    const core = await import("@loreai/core");
    closeDatabase = core.close;
    resetPipeline = gateway.resetPipelineState;
    closeDatabase();
    await resetPipeline();
    setUpstreamInterceptor(async (_body, _model, _streaming, makeReal) => {
      upstreamCalls += 1;
      return makeReal();
    });
    const config = {
      ...gateway.loadConfig(),
      port: 0,
      hosts: ["127.0.0.1"],
      remoteGateway: false,
      hostedMode: false,
    };
    const server = await gateway.startServer(config);
    stopGateway = server.stop;
    gatewayBase = `http://127.0.0.1:${server.port}`;
    process.env.LORE_GATEWAY_URL = gatewayBase;
    const ctx = {
      location: {
        directory: process.cwd(),
        project: { id: "dot-282", directory: process.cwd() },
      },
      session: {
        hook: async (kind: string, callback: never) => {
          if (kind === "prompt") hooks.prompt.push(callback);
          if (kind === "http.request") hooks.request.push(callback);
          return { dispose: async () => {} };
        },
        get: async () => ({ id: SESSION }),
        context: async () => [
          { type: "user", id: TURN },
          {
            type: "assistant",
            id: ASSISTANT,
            model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
          },
        ],
      },
      tool: {
        transform: async (
          callback: (editor: {
            add: (tool: { name: string; execute: Function }) => void;
          }) => void,
        ) => {
          callback({ add: (tool) => tools.set(tool.name, tool) });
          return { dispose: async () => {} };
        },
      },
      agent: { transform: async () => ({ dispose: async () => {} }) },
    } as unknown as Context;
    await plugin.setup?.(ctx);
  });

  afterAll(async () => {
    const { setUpstreamInterceptor } =
      await import("../../gateway/src/pipeline");
    setUpstreamInterceptor(undefined);
    const { setUpstreamFetchOverrideForTest } =
      await import("../../gateway/src/fetch");
    setUpstreamFetchOverrideForTest(null);
    await stopGateway?.();
    closeDatabase?.();
    await resetPipeline?.({ fast: true });
    process.env = originalEnvironment;
  });

  test("records and reads back the exact message through the public API", async () => {
    const event: HttpRequest = {
      sessionID: SESSION,
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-20250514" },
      kind: "primary",
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "synthetic-dot-282-key",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: "You are a coding assistant. ".repeat(30),
          messages: [{ role: "user", content: MARKER }],
        }),
      }),
    };
    for (const hook of hooks.prompt)
      await hook({ sessionID: SESSION, messageID: TURN });
    for (const hook of hooks.request) await hook(event);
    expect(event.request.url).toBe(`${gatewayBase}/v1/messages`);
    const response = await loopbackRequest(event.request.url, {
      method: event.request.method,
      headers: event.request.headers,
      body: await event.request.text(),
    });
    const responseText = await response.text();
    expect({
      status: response.status,
      body: responseText,
      upstreamCalls,
    }).toEqual({
      status: 200,
      body: expect.stringContaining("Synthetic upstream response"),
      upstreamCalls: 1,
    });
    const projectsResponse = await loopbackRequest(
      `${gatewayBase}/api/v1/projects`,
    );
    expect(projectsResponse.status).toBe(200);
    const projects = (await projectsResponse.json()) as Array<{
      id: string;
      path: string;
      message_count: number;
    }>;
    const project = projects.find(
      (candidate) => candidate.path === process.cwd(),
    );
    expect(project?.message_count).toBe(2);
    const sessionsResponse = await loopbackRequest(
      `${gatewayBase}/api/v1/projects/${project!.id}/sessions`,
    );
    expect(sessionsResponse.status).toBe(200);
    const sessions = (await sessionsResponse.json()) as Array<{
      session_id: string;
      message_count: number;
      title: string;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].message_count).toBe(2);
    const recordedSession = sessions[0].session_id;
    const read = await loopbackRequest(
      `${gatewayBase}/api/v1/sessions/${recordedSession}?path=${encodeURIComponent(process.cwd())}`,
    );
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages.map((message) => message.content)).toContain(MARKER);
    const wrongProject = await loopbackRequest(
      `${gatewayBase}/api/v1/sessions/${SESSION}?path=${encodeURIComponent("/dot-282-not-the-project")}`,
    );
    expect(wrongProject.status).not.toBe(200);
    expect(body.messages.some((message) => message.content === MARKER)).toBe(
      true,
    );
  });

  test("native recall returns session memory only for its verified turn", async () => {
    const tool = tools.get(RECALL_TOOL_NAME);
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { query: MARKER, scope: "session" },
      {
        sessionID: SESSION,
        messageID: ASSISTANT,
        agent: "build",
        id: "call-1",
        signal: new AbortController().signal,
        progress: async () => {},
      },
    );
    expect(result.content).toContain(MARKER);
    const negative = await tool!.execute(
      { query: MARKER, scope: "session" },
      {
        sessionID: SESSION,
        messageID: "not-an-assistant-message",
        agent: "build",
        id: "call-2",
        signal: new AbortController().signal,
        progress: async () => {},
      },
    );
    expect(negative.content).toContain("unavailable");
    expect(negative.content).not.toContain(MARKER);
    expect(upstreamCalls).toBeGreaterThan(0);
    expect(upstreamNativeHeader).toBeUndefined();
  });
});
