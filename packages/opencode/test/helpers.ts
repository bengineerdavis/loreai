import type { LorePlugin } from "../src/index";

/** The v2 cleanup function `setup` returns. */
export type SetupCleanup = Awaited<ReturnType<(typeof LorePlugin)["setup"]>>;

export interface SessionInfoLike {
  id: string;
  parentID?: string;
  title?: string;
}

export interface MockContextOptions {
  directory?: string;
  projectID?: string;
  /** Full session.get response bodies by session id. */
  sessions?: Record<string, SessionInfoLike>;
  /** session id → title (merged over `sessions`). */
  titles?: Record<string, string>;
  /** session id → parentID (merged over `sessions`). */
  parents?: Record<string, string>;
  /** When it returns true for a lookup, session.get rejects ("server down"). */
  fail?: () => boolean;
  /** Records every session.get id, in call order. */
  calls?: string[];
}

export interface Registration {
  dispose: () => Promise<void>;
}

/**
 * Minimal fake of the v2 plugin context: only the members the plugin's setup
 * actually touches — location metadata, the agent and provider transforms,
 * and the session domain's `model.request` hook + `get`.
 *
 * The plugin stays inert under test runners (NODE_ENV=test / a `.test.` argv
 * entry), so no gateway init happens and the provider transform — registered
 * only when a gateway was found — is NOT among the registrations. Tests that
 * exercise the active path (routing.e2e, source-ui-bootstrap) force it via
 * LORE_OPENCODE_FORCE_ACTIVE=1 and assert accordingly.
 */
export function createMockContext(options: MockContextOptions = {}) {
  const directory = options.directory ?? "/tmp/lore-test";
  const projectID = options.projectID ?? "test";
  const registrations: Registration[] = [];
  const agentCallbacks: ((editor: unknown) => void)[] = [];
  const providerCallbacks: ((editor: unknown) => void)[] = [];
  const toolCallbacks: ((editor: unknown) => void)[] = [];
  const sessionHooks: {
    name: string;
    callback: (input: unknown) => Promise<void> | void;
  }[] = [];

  const session = {
    hook: (name: string, cb: (input: unknown) => Promise<void> | void) => {
      sessionHooks.push({ name, callback: cb });
      const registration: Registration = { dispose: async () => {} };
      registrations.push(registration);
      return registration;
    },
    get: async ({ sessionID }: { sessionID: string }) => {
      options.calls?.push(sessionID);
      if (options.fail?.()) throw new Error("server down");
      const base = options.sessions?.[sessionID] ?? { id: sessionID };
      const parentID = options.parents?.[sessionID] ?? base.parentID;
      const title = options.titles?.[sessionID] ?? base.title;
      return {
        ...base,
        ...(parentID !== undefined ? { parentID } : {}),
        ...(title !== undefined ? { title } : {}),
      } satisfies SessionInfoLike;
    },
  };

  const ctx = {
    location: {
      directory,
      project: { id: projectID, directory },
    },
    agent: {
      transform: (cb: (editor: unknown) => void) => {
        agentCallbacks.push(cb);
        const registration: Registration = { dispose: async () => {} };
        registrations.push(registration);
        return registration;
      },
    },
    provider: {
      transform: (cb: (editor: unknown) => void) => {
        providerCallbacks.push(cb);
        const registration: Registration = { dispose: async () => {} };
        registrations.push(registration);
        return registration;
      },
    },
    tool: {
      transform: (cb: (editor: unknown) => void) => {
        toolCallbacks.push(cb);
        const registration: Registration = { dispose: async () => {} };
        registrations.push(registration);
        return registration;
      },
    },
    session,
  };

  return {
    ctx: ctx as unknown as Parameters<(typeof LorePlugin)["setup"]>[0],
    /** Un-typed view for tests that need to swap mock internals. */
    raw: ctx as unknown as {
      session: { get: (args: { sessionID: string }) => Promise<unknown> };
    },
    registrations,
    agentCallbacks,
    providerCallbacks,
    toolCallbacks,
    sessionHooks,
  };
}

/**
 * The v2 provider-editor slice the provider-pinning helper uses, plus a
 * harness that captures editor mutations. Shape mirrors the real editor:
 * `list()` returns records of `{ provider: Info }`, and
 * `update(providerID, fn)` hands the callback the live Info object to
 * mutate synchronously.
 */
export function createEditorFake(): {
  providers: Map<string, Record<string, unknown>>;
  updates: string[];
  list(): { provider: { id: string } }[];
  update(
    providerID: string,
    update: (provider: unknown) => void,
  ): void | Promise<void>;
} {
  const providers = new Map<string, Record<string, unknown>>([
    ["openai", { id: "openai", settings: { headerTimeout: 30_000 } }],
    ["anthropic", { id: "anthropic", settings: {} }],
    ["google", { id: "google" }],
  ]);
  const updates: string[] = [];
  return {
    providers,
    updates,
    list() {
      return [...providers.values()].map((info) => ({
        provider: info as { id: string },
      }));
    },
    update(providerID, update) {
      const info = providers.get(providerID);
      updates.push(providerID);
      if (!info) return;
      update(info);
      return undefined;
    },
  };
}

/** A registered `model.request` hook captured by `createMockContext`. */
export interface CapturedHook {
  name: string;
  callback: (input: unknown) => Promise<void> | void;
}

/** Run a captured `model.request` hook with a realistic input. */
export async function runModelRequest(
  hook: CapturedHook,
  overrides: {
    sessionID?: string;
    providerID?: string;
    agent?: string;
  } = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  await hook.callback({
    sessionID: overrides.sessionID ?? "ses_primary",
    agent: overrides.agent ?? "build",
    model: {
      id: "claude-sonnet-4-5",
      providerID: overrides.providerID ?? "anthropic",
    },
    kind: "primary",
    headers,
  });
  return headers;
}
