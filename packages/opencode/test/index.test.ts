import { describe, test, expect } from "vitest";
import { LorePlugin } from "../src/index";
import { applyLoreProviderSettings } from "../src/internal";
import {
  createMockContext,
  createEditorFake,
  runModelRequest,
  type CapturedHook,
} from "./helpers";

describe("plugin entry module export shape (v2)", () => {
  // The v2 loader validates the default export: it must be a plugin
  // definition object with an id and an effect or setup function
  // ("Plugin must export a default definition with an id and an effect or
  // setup function" — the error the pre-2.x function-shaped export produced
  // on opencode 2.x servers).
  test("exports a Plugin.define default with id + setup", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;
    const plugin = mod.default as { id?: string; setup?: unknown };

    expect(typeof plugin).toBe("object");
    expect(plugin).not.toBeNull();
    expect(plugin.id).toBe("loreai");
    expect(typeof plugin.setup).toBe("function");

    // The named export is the same definition object.
    expect(mod.LorePlugin).toBe(plugin);

    // The entry module stays minimal: only the definition + default.
    expect(Object.keys(mod).sort()).toEqual(["LorePlugin", "default"]);
  });
});

describe("LorePlugin setup: registrations", () => {
  test("registers an agent transform and the model.request hook", async () => {
    const { ctx, registrations, agentCallbacks, sessionHooks } =
      createMockContext();
    const cleanup = await LorePlugin.setup(ctx);

    expect(agentCallbacks).toHaveLength(1);
    expect(sessionHooks.map((h) => h.name)).toEqual(["model.request"]);
    // Inert test env: no gateway → no provider transform (see the helper's
    // doc comment). Agent + session hook = 2 registrations.
    expect(registrations).toHaveLength(2);

    if (cleanup) await cleanup();
    // Cleanup disposes every registration without throwing.
    await Promise.all(registrations.map((r) => r.dispose()));
  });

  test("returns a cleanup that does not tear down process-global state", async () => {
    const { ctx } = createMockContext();
    const cleanup = await LorePlugin.setup(ctx);
    // Same invariant as pre-2.x: instance cleanup must not own the
    // process-wide gateway or fetch interceptor — v2 cleanup only disposes
    // this instance's hook/transform registrations.
    expect(typeof cleanup).toBe("function");
    if (cleanup) await cleanup();
  });
});

describe("LorePlugin setup: agent transform", () => {
  test("updates existing agents to hidden subagent workers", async () => {
    const { ctx, agentCallbacks } = createMockContext();
    await LorePlugin.setup(ctx);

    const edited: Record<string, Record<string, unknown>> = {
      "lore-distill": { id: "lore-distill" },
      "lore-curator": { id: "lore-curator" },
      "lore-query-expand": { id: "lore-query-expand" },
    };
    const fakeEditor = {
      get: (id: string) => edited[id],
      update: (id: string, update: (agent: never) => void) => {
        update(edited[id] as never);
      },
    };
    for (const cb of agentCallbacks) cb(fakeEditor);

    // `hidden` is only honored by OpenCode for subagent-mode agents; every
    // internal worker must be mode:"subagent" + hidden:true so it never
    // surfaces in the host project's agent/skill picker.
    for (const id of ["lore-distill", "lore-curator", "lore-query-expand"]) {
      const agent = edited[id];
      expect(agent.mode).toBe("subagent");
      expect(agent.hidden).toBe(true);
      expect(typeof agent.description).toBe("string");
      expect(agent.description).toBeTruthy();
    }
  });

  test("skips missing agents with a warning (v2 has no agent-creation path)", async () => {
    const { ctx, agentCallbacks } = createMockContext();
    await LorePlugin.setup(ctx);

    // No lore agents exist in the editor at all.
    const fakeEditor = {
      get: (_id: string) => undefined,
      update: (_id: string, _update: (agent: never) => void) => {},
    };
    // Must not throw — upstream gap is logged, not fatal.
    for (const cb of agentCallbacks) cb(fakeEditor);
  });
});

describe("LorePlugin setup: provider transform", () => {
  test("is not registered when no gateway was found (inert env)", async () => {
    const { ctx, providerCallbacks } = createMockContext();
    await LorePlugin.setup(ctx);
    expect(providerCallbacks).toHaveLength(0);
  });

  test("pins settings.baseURL for every discovered provider", () => {
    const fakeEditor = createEditorFake();
    // Drive the helper the same way the registered transform would with a
    // live gatewayBase (see routing.e2e.test.ts for the active-path proof).
    applyLoreProviderSettings(fakeEditor, "http://127.0.0.1:3207");

    for (const id of ["openai", "anthropic", "google"]) {
      const provider = fakeEditor.providers.get(id) as {
        settings?: Record<string, unknown>;
      };
      expect(provider.settings?.baseURL).toBe("http://127.0.0.1:3207/v1");
    }
  });
});

describe("applyLoreProviderSettings (v2 editor merge)", () => {
  const BASE = "http://127.0.0.1:3207";

  test("pins baseURL for every provider in the inventory", () => {
    // Regression test for the /messages-vs-/v1/messages 404: OpenCode can
    // derive the Anthropic baseURL from OPENAI_BASE_URL (stripping /v1),
    // which would send the SDK to `http://host/messages` (no /v1) and get
    // a 404 from the gateway. The plugin must pin EVERY discovered
    // provider's settings.baseURL to `${gatewayBase}/v1`.
    const editor = createEditorFake();
    applyLoreProviderSettings(editor, BASE);
    expect([...editor.updates].sort()).toEqual([
      "anthropic",
      "google",
      "openai",
    ]);
    for (const id of editor.updates) {
      const provider = editor.providers.get(id) as {
        settings?: Record<string, unknown>;
      };
      expect(provider.settings?.baseURL).toBe(`${BASE}/v1`);
    }
  });

  test("preserves unrelated settings keys while pinning baseURL", () => {
    const editor = createEditorFake();
    (
      editor.providers.get("anthropic") as { settings: Record<string, unknown> }
    ).settings.customKey = "keep-me";
    applyLoreProviderSettings(editor, BASE);

    const anthropic = editor.providers.get("anthropic") as {
      settings: Record<string, unknown>;
    };
    expect(anthropic.settings.baseURL).toBe(`${BASE}/v1`);
    expect(anthropic.settings.customKey).toBe("keep-me");
  });

  test("overrides OpenCode's inherited OpenAI header timeout", () => {
    const editor = createEditorFake();
    applyLoreProviderSettings(editor, BASE);

    const openai = editor.providers.get("openai") as {
      settings: Record<string, unknown>;
    };
    // Pre-set headerTimeout must be overridden to false: Lore can exceed
    // OpenCode's Codex 10s header deadline while preparing context. The
    // gateway owns the foreground request deadline.
    expect(openai.settings.headerTimeout).toBe(false);
    expect(openai.settings.baseURL).toBe(`${BASE}/v1`);
  });

  test("overrides headerTimeout for openai-codex too", () => {
    const editor = createEditorFake();
    editor.providers.set("openai-codex", { id: "openai-codex" });
    applyLoreProviderSettings(editor, BASE);

    const codex = editor.providers.get("openai-codex") as {
      settings?: Record<string, unknown>;
    };
    expect(codex.settings?.headerTimeout).toBe(false);
    expect(codex.settings?.baseURL).toBe(`${BASE}/v1`);
  });

  test("leaves other providers' headerTimeout untouched", () => {
    const editor = createEditorFake();
    applyLoreProviderSettings(editor, BASE);

    const anthropic = editor.providers.get("anthropic") as {
      settings: Record<string, unknown>;
    };
    expect("headerTimeout" in anthropic.settings).toBe(false);
  });

  test("creates the settings record when a provider has none", () => {
    const editor = createEditorFake();
    applyLoreProviderSettings(editor, BASE);

    const google = editor.providers.get("google") as {
      settings?: Record<string, unknown>;
    };
    expect(google.settings?.baseURL).toBe(`${BASE}/v1`);
  });

  test("is a no-op when gatewayBase is empty (test env / startup failure)", () => {
    // In inert test envs the plugin's init skips gateway start, so
    // gatewayBase is "" and no provider transform is registered at all;
    // belt-and-suspenders: the helper itself must also no-op.
    const editor = createEditorFake();
    applyLoreProviderSettings(editor, "");
    expect(editor.updates).toEqual([]);
    const openai = editor.providers.get("openai") as {
      settings?: Record<string, unknown>;
    };
    expect(openai.settings?.baseURL).toBeUndefined();
  });
});

describe("model.request hook", () => {
  test("injects session, agent, provider, project, and sub-agent headers", async () => {
    const { ctx, sessionHooks } = createMockContext({
      parents: { ses_child: "ses_parent" },
      titles: { ses_child: "Child task" },
    });
    await LorePlugin.setup(ctx);

    const hook = sessionHooks.find(
      (h): h is CapturedHook => h.name === "model.request",
    );
    if (!hook) throw new Error("model.request hook was not registered");

    const headers = await runModelRequest(hook, {
      sessionID: "ses_child",
    });

    expect(headers["x-lore-session-id"]).toBe("ses_child");
    expect(headers["x-lore-agent"]).toBe("build");
    expect(headers["x-lore-provider"]).toBe("anthropic");
    expect(headers["x-lore-project"]).toBe("/tmp/lore-test");
    // Sub-agent parent forwarding (#1300): ses_child's parentID is ses_parent.
    expect(headers["x-parent-session-id"]).toBe("ses_parent");
    // Harness title forwarding (#1921), percent-encoded.
    expect(headers["x-lore-session-title"]).toBe("Child%20task");
  });

  test("suppresses placeholder titles", async () => {
    const { ctx, raw, sessionHooks } = createMockContext();
    await LorePlugin.setup(ctx);

    const hook = sessionHooks.find(
      (h): h is CapturedHook => h.name === "model.request",
    );
    if (!hook) throw new Error("model.request hook was not registered");
    const originalGet = raw.session.get;
    raw.session.get = async ({ sessionID }: { sessionID: string }) => ({
      id: sessionID,
      title: "New session - 2026-01-01",
    });
    try {
      const headers = await runModelRequest(hook, {
        sessionID: "ses_placeholder",
      });
      expect(headers["x-lore-session-title"]).toBeUndefined();
    } finally {
      raw.session.get = originalGet;
    }
  });

  test("forwards LORE_UPSTREAM_<PROVIDER> as the upstream-url header", async () => {
    const { ctx, sessionHooks } = createMockContext();
    await LorePlugin.setup(ctx);

    const hook = sessionHooks.find(
      (h): h is CapturedHook => h.name === "model.request",
    );
    if (!hook) throw new Error("model.request hook was not registered");
    process.env.LORE_UPSTREAM_MY_LOCAL = "http://127.0.0.1:8080/v1";
    try {
      const headers = await runModelRequest(hook, {
        providerID: "my-local",
      });
      expect(headers["x-lore-upstream-url"]).toBe("http://127.0.0.1:8080/v1");
    } finally {
      delete process.env.LORE_UPSTREAM_MY_LOCAL;
    }
  });

  test("never throws on session lookup failure (best-effort)", async () => {
    const { ctx, raw, sessionHooks } = createMockContext();
    await LorePlugin.setup(ctx);

    const hook = sessionHooks.find(
      (h): h is CapturedHook => h.name === "model.request",
    );
    if (!hook) throw new Error("model.request hook was not registered");
    const originalGet = raw.session.get;
    raw.session.get = async () => {
      throw new Error("server unreachable");
    };
    try {
      const headers = await runModelRequest(hook, {
        sessionID: "ses_broken",
      });
      // The base identifiers are still injected; parent/title are absent.
      expect(headers["x-lore-session-id"]).toBe("ses_broken");
      expect(headers["x-parent-session-id"]).toBeUndefined();
      expect(headers["x-lore-session-title"]).toBeUndefined();
    } finally {
      raw.session.get = originalGet;
    }
  });

  test("forwards LORE_UPSTREAM_EXTRA_HEADERS as literal headers", async () => {
    const { ctx, sessionHooks } = createMockContext();
    await LorePlugin.setup(ctx);

    const hook = sessionHooks.find(
      (h): h is CapturedHook => h.name === "model.request",
    );
    if (!hook) throw new Error("model.request hook was not registered");
    process.env.LORE_UPSTREAM_EXTRA_HEADERS =
      "X-Team-Routing: eng\nx-api-key: must-not-forward";
    try {
      const headers = await runModelRequest(hook, {});
      expect(headers["X-Team-Routing"]).toBe("eng");
      // Managed credential headers are never clobbered.
      expect(headers["x-api-key"]).toBeUndefined();
    } finally {
      delete process.env.LORE_UPSTREAM_EXTRA_HEADERS;
    }
  });
});
