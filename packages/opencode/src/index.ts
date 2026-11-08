import { Plugin } from "@opencode/plugin";
import {
  log,
  getGitRemote,
  discoverWorkspaceRoot,
  installFetchInterceptor,
  RECALL_TOOL_NAME,
  createGatewayRecallClient,
} from "@loreai/core";
// Helpers live in a separate module so they are NOT re-exported from this
// plugin entry. (Historical: OpenCode's pre-2.x legacy plugin loader invoked
// every function export as a plugin; v2's loader instead validates the
// default export's shape — "Plugin must export a default definition with an
// id and an effect or setup function". Keeping helpers in ./internal.ts also
// keeps the entry module minimal for both.
import {
  applyLoreProviderSettings,
  gatewayAccessHeadersForRemote,
  installEmbeddedGatewaySigtermHandler,
  isLoopbackUrl,
  prepareLocalUiAssets,
  probeGateway,
  reportGatewayUnavailable,
  shouldForwardUpstreamExtraHeader,
  shouldRegisterNativeRecallTool,
} from "./internal";
import { createRecallTool } from "./recall-tool";

let nativeRecallClient:
  | ReturnType<typeof createGatewayRecallClient>
  | undefined;

/**
 * Lore plugin for OpenCode — transparent LLM proxy routing.
 *
 * Instead of overwriting provider baseURLs (which loses original auth and
 * URL context), this plugin installs a fetch-level interceptor that
 * transparently reroutes outgoing LLM API calls through the Lore gateway.
 * The SDK builds requests normally (correct auth, correct URL for each
 * provider), and the interceptor redirects them while preserving all
 * original headers. The gateway forwards non-managed headers upstream.
 *
 * Per-request context (session ID, agent name, provider ID) is injected via
 * the session-domain `model.request` hook.
 *
 * v2 notes (OpenCode 2.x plugin API):
 * - `setup` runs once per plugin instance (per location), not once per
 *   session/project call as the pre-2.x function-shaped plugin did. The
 *   init flow (gateway probe/start, fetch interceptor install) therefore
 *   runs here, and per-project state is registered up front for this
 *   instance's location.
 * - Hook/transform registrations return `Registration` disposables; the
 *   cleanup function returned by `setup` disposes them.
 * - There is no v2 mechanism to disable OpenCode's built-in auto-compaction
 *   (pre-2.x set `cfg.compaction = { auto: false, prune: false }`); see the
 *   open questions in the PR description.
 */

/** Default ports to probe when looking for a running gateway (must match gateway defaults). */
const KNOWN_GATEWAY_PORTS = [3207, 5673];

function gatewayOriginForLog(value: string): string {
  try {
    // The configured URL may contain credentials or a private path/query.
    // Keep operational logs useful without retaining any of those components.
    return new URL(value).origin;
  } catch {
    return "<gateway>";
  }
}

/**
 * Resolve the gateway URL by probing known ports and reading the port file.
 *
 * Order: LORE_REMOTE_URL → LORE_GATEWAY_URL env var → port file → known
 * default ports (3207, 5673). Returns the URL of a running gateway, or null
 * if none found.
 */
async function resolveGatewayUrl(): Promise<string | null> {
  // 0. Remote gateway — skip local discovery/startup entirely.
  if (process.env.LORE_REMOTE_URL) {
    const url = process.env.LORE_REMOTE_URL.replace(/\/$/, "");
    if (await probeGateway(url)) return url;
    log.info(
      "remote gateway is not reachable, falling through to local discovery",
    );
  }

  // 1. Explicit env var — probe it to verify it's actually reachable.
  let preparedLocalUi = false;
  if (process.env.LORE_GATEWAY_URL) {
    const url = process.env.LORE_GATEWAY_URL.replace(/\/$/, "");
    if (isLoopbackUrl(url)) {
      await prepareLocalUiAssets();
      preparedLocalUi = true;
    }
    if (await probeGateway(url)) return url;
    // env var set but gateway unreachable — fall through to discovery
  }

  // A source-loaded plugin may be running before the workspace's postinstall
  // build has staged packages/ui/dist into the gateway. Prepare it before
  // probing/reusing a local gateway, so an already-running source gateway can
  // discover the newly staged manifest as well.
  if (!preparedLocalUi) await prepareLocalUiAssets();

  // 2. Build probe list: port file first (handles random port), then known defaults.
  const probePorts = new Set<number>();
  try {
    const gw = "@loreai/gateway";
    const { readPortFile } = await import(/* webpackIgnore: true */ gw);
    const portfilePort = readPortFile();
    if (portfilePort) probePorts.add(portfilePort);
  } catch {
    /* gateway package not available — skip port file */
  }
  for (const p of KNOWN_GATEWAY_PORTS) probePorts.add(p);

  // 3. Probe each port.
  for (const port of probePorts) {
    const url = `http://127.0.0.1:${port}`;
    if (await probeGateway(url)) return url;
  }

  return null;
}

/**
 * Start the gateway server in-process by importing @loreai/gateway as a library.
 *
 * Uses startGateway() which handles the full port fallback chain
 * (3207 → 5673 → random) and port file management automatically.
 * Returns the URL of the started gateway, or null on failure.
 */
async function startInProcess(): Promise<string | null> {
  try {
    // Dynamic import — the gateway may be resolved from src (workspace) or
    // dist/index.cjs (npm). Use a variable to prevent tsc from resolving the
    // module at compile time (the .d.cts only exists after building).
    const gw = "@loreai/gateway";
    const { startGateway } = await import(/* webpackIgnore: true */ gw);
    const handle = await startGateway({ quiet: true, local: true });
    const url = `http://127.0.0.1:${handle.port}`;

    if (handle.owned) {
      installEmbeddedGatewaySigtermHandler(handle.shutdown);
    } else {
      log.info(`reusing existing gateway at ${url}`);
    }

    return url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastGatewayStartError = msg;
    log.info("failed to start gateway in-process:", msg);
    return null;
  }
}

// Captures the underlying reason the in-process gateway failed to start so
// the user-facing error can include the real cause (port conflict, DB lock,
// stale build, etc.) instead of just "Ensure @loreai/gateway is installed."
let lastGatewayStartError: string | null = null;

// Process-wide initialization state — shared across all plugin instances
// (v2 loads the plugin once per location; the interceptor and gateway are
// process-global and must only be installed once).
let processInitDone = false;
let processLoreActive = false;
let processLoreBase = "";

// Module-level fallback for the fetch interceptor's `getHeaders()` callback,
// which has no per-request context. The `model.request` hook is preferred
// (it sets headers per-request using this instance's project entry);
// `getHeaders()` only fires when a request bypasses that hook.
//
// The path and git remote are stored TOGETHER as a single object so the
// fallback pair is always self-consistent: a path is never emitted with a
// remote that was resolved for a DIFFERENT project on an earlier setup.
// (Pairing a path with a foreign remote is how a non-repo dir acquired
// another repo's remote and became a "git-remote magnet".)
let currentProject: { path: string; gitRemote: string } | undefined;

/** project.id → { projectPath, gitRemote, lastSeenAt } */
const projectState = new Map<
  string,
  { projectPath: string; gitRemote: string; lastSeenAt: number }
>();

/** Stale-entry threshold: 24 hours. Generous to avoid re-running
 * `getGitRemote()` when a user resumes after sleep/long break.
 * Each entry is ~200 bytes — even 100 projects would be 20 KB. */
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Drop project entries not seen within SESSION_STATE_TTL_MS (long-lived
 * processes). Called opportunistically whenever a new entry is registered. */
function reapStaleProjectState(): void {
  const cutoff = Date.now() - SESSION_STATE_TTL_MS;
  for (const [id, entry] of projectState) {
    if (entry.lastSeenAt < cutoff) projectState.delete(id);
  }
}

/** session.id → { parentID (null = primary session), title, lastSeenAt }.
 * A session's parent never changes, so the result is cached for the process
 * lifetime (TTL-reaped) to avoid an SDK round-trip on every turn. */
const sessionParent = new Map<
  string,
  {
    parentID: string | null;
    title: string | null;
    titleFetchedAt: number;
    lastSeenAt: number;
  }
>();
/** In-flight (or recently finished) session-info lookups, keyed the same as
 * `sessionParent`. Deduplicates concurrent lookups for one session and
 * carries the timeout race that bounds them. */
const sessionInfoLookups = new Map<string, Promise<void>>();

/** OpenCode's default title before it generates a real one. */
const PLACEHOLDER_TITLE_RE = /^new session\b/i;
/** Re-check a real (non-placeholder) title at most this often — a session
 * can be renamed mid-flight, but titles are not worth polling per turn. */
const TITLE_REFETCH_MS = 5 * 60 * 1000;
/** Bound optional metadata lookups so a hung SDK call cannot suppress retries. */
const SESSION_INFO_LOOKUP_TIMEOUT_MS = 5_000;

function reapStaleSessionParent(): void {
  const cutoff = Date.now() - SESSION_STATE_TTL_MS;
  for (const [id, entry] of sessionParent) {
    if (entry.lastSeenAt < cutoff) sessionParent.delete(id);
  }
}

function applySessionInfo(
  entry: {
    parentID: string | null;
    title: string | null;
    titleFetchedAt: number;
  },
  data: { parentID?: string; title?: string } | undefined,
): void {
  entry.parentID = data?.parentID ?? null;
  const title = typeof data?.title === "string" ? data.title.trim() : "";
  entry.title = title === "" ? null : title;
  entry.titleFetchedAt = Date.now();
}

function sessionInfoKey(directory: string, sessionID: string): string {
  return JSON.stringify([directory, sessionID]);
}

/**
 * Resolve a session's parent session ID and harness title via the v2
 * session domain (`ctx.session.get({ sessionID })`).
 *
 * OpenCode Task sub-agents run in a child session whose `parentID` points at
 * the session that spawned them; primary sessions have no parent. We forward a
 * non-null parent as the `x-parent-session-id` header so the gateway flags the
 * session as a sub-agent and sizes its LTM injection accordingly (#1300) — the
 * same signal Claude Code emits natively for its Task sub-agents. The harness's
 * own `title` is forwarded percent-encoded as `x-lore-session-title` so the
 * gateway can persist it as the session's explicit title (#1921).
 *
 * Cached per workspace and session (parentID is immutable). A successful
 * lookup — including the common `null` for a primary session — is cached so
 * we never re-query. Failures (gateway server unreachable, session not yet
 * persisted) are NOT cached and never throw, so a transient error is retried
 * on the next turn rather than permanently latching a real sub-agent as
 * "not a sub-agent".
 *
 * The lookup itself is fire-and-forget: session metadata is optional and
 * must never delay or break a provider request. Callers report
 * `parentLookupPending` so the gateway can apply the conservative sub-agent
 * budget until classification resolves (via `x-lore-session-parent-state`).
 */
function resolveSessionInfo(
  session: {
    get(args: { sessionID: string }): Promise<{
      parentID?: string;
      title?: string;
    }>;
  },
  sessionID: string,
  directory: string,
): {
  parentID: string | null;
  title: string | null;
  parentLookupPending: boolean;
} {
  const key = sessionInfoKey(directory, sessionID);
  const cached = sessionParent.get(key);
  if (cached) {
    cached.lastSeenAt = Date.now();
    // Title refresh policy (#1921): a harness that reports no title at all
    // never gets polled again (treat as final); OpenCode's auto "New session"
    // placeholder IS polled every turn because the real title is generated
    // shortly after the first turn; a real title refreshes lazily every
    // TITLE_REFETCH_MS so a manual rename eventually propagates.
    const needsRefetch =
      cached.title === null
        ? false
        : PLACEHOLDER_TITLE_RE.test(cached.title)
          ? true
          : Date.now() - cached.titleFetchedAt > TITLE_REFETCH_MS;
    if (!needsRefetch) {
      return {
        parentID: cached.parentID,
        title: cached.title,
        parentLookupPending: false,
      };
    }
    fetchSessionInfo(session, sessionID, directory);
    return {
      parentID: cached.parentID,
      title: cached.title,
      parentLookupPending: false,
    };
  }
  fetchSessionInfo(session, sessionID, directory);
  return { parentID: null, title: null, parentLookupPending: true };
}

function fetchSessionInfo(
  session: {
    get(args: { sessionID: string }): Promise<{
      parentID?: string;
      title?: string;
    }>;
  },
  sessionID: string,
  directory: string,
): void {
  // Session IDs are scoped by OpenCode's workspace directory; never reuse a
  // lookup or cached metadata from a different workspace with the same ID.
  const key = sessionInfoKey(directory, sessionID);
  if (sessionInfoLookups.has(key)) return;

  // Session metadata is optional: never await it on a provider request. A
  // failed or timed-out lookup stays uncached so a later turn can retry it.
  let lookup: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = Promise.resolve()
    .then(() => session.get({ sessionID }))
    .then((res) => {
      // A timeout or newer lookup owns the slot now; late responses cannot
      // overwrite metadata resolved by a later turn.
      if (!lookup || sessionInfoLookups.get(key) !== lookup) return;
      // The v2 session domain can reject (server unreachable, session not
      // yet persisted). Such a response cannot establish that the session
      // has no parent and must be retried.
      const entry = sessionParent.get(key) ?? {
        parentID: null,
        title: null,
        titleFetchedAt: 0,
        lastSeenAt: Date.now(),
      };
      applySessionInfo(entry, res);
      sessionParent.set(key, entry);
      reapStaleSessionParent();
    })
    .catch(() => {
      // Metadata failures must not escape into request handling.
    });
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, SESSION_INFO_LOOKUP_TIMEOUT_MS);
  });
  lookup = Promise.race([request, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (sessionInfoLookups.get(key) === lookup) {
      sessionInfoLookups.delete(key);
    }
  });
  sessionInfoLookups.set(key, lookup);
}

/** Memoized lore init promise — ensures concurrent setup calls don't race. */
let loreInitPromise: Promise<string | null> | null = null;

/**
 * Whether the plugin should stay inert (skip gateway probe/start and the
 * process-wide fetch interceptor). True under test runners — `NODE_ENV=test`
 * or a `.test.` argv entry — so unrelated package suites don't accidentally
 * spin up a gateway or patch `globalThis.fetch`.
 *
 * Tests that need the active discovery → interceptor → routing path set
 * `LORE_OPENCODE_FORCE_ACTIVE=1` and point the plugin at a controlled
 * in-process gateway via `LORE_GATEWAY_URL`. The force flag keeps
 * `NODE_ENV=test` (so `log` stays file-suppressed and the DB isolated) while
 * exercising the real wiring. Mirrors the Pi extension's `LORE_PI_FORCE_ACTIVE`.
 */
function isInertTestEnv(): boolean {
  if (process.env.LORE_OPENCODE_FORCE_ACTIVE === "1") return false;
  return (
    process.env.NODE_ENV === "test" ||
    process.argv.some((a) => a.includes(".test."))
  );
}

const LORE_WORKERS = [
  {
    id: "lore-distill",
    description: "Lore memory distillation worker",
  },
  {
    id: "lore-curator",
    description: "Lore knowledge curator worker",
  },
  {
    id: "lore-query-expand",
    description: "Lore query expansion worker",
  },
];

export const LorePlugin = Plugin.define({
  id: "loreai",
  async setup(ctx) {
    // Initialize lore — only probe/start once per process.
    const loreDisabled =
      process.env.LORE_DISABLED === "1" || process.env.LORE_DISABLED === "true";
    let loreActive = processLoreActive;
    let gatewayBase = processLoreBase;
    if (!processInitDone) {
      const inTestEnv = isInertTestEnv();

      // We're loaded by a real OpenCode process, which owns a full-screen TUI:
      // any byte on stdout/stderr corrupts the render. Flip the core logger's
      // process-global silence flag — which the in-process gateway's own
      // (bundled) copy of `core` reads off `globalThis` too — so NOTHING (not
      // even `log.error` or gateway warnings) reaches the terminal. Everything
      // still lands in the log file + Sentry sink (`lore logs`). Skipped under
      // inert test mode so unrelated suites keep their console.
      if (!inTestEnv) log.silenceStderr();

      if (!loreDisabled && !inTestEnv) {
        // Memoize so concurrent setup calls don't race on probe→spawn.
        if (!loreInitPromise) {
          loreInitPromise = (async () => {
            // Try to find a running gateway first (probes port file + ports).
            const existingUrl = await resolveGatewayUrl();
            if (existingUrl) {
              log.info(
                `gateway detected at ${gatewayOriginForLog(existingUrl)}`,
              );
              return existingUrl;
            }
            // No running gateway — start one in-process (fallback chain).
            log.info("starting gateway in-process…");
            const startedUrl = await startInProcess();
            if (startedUrl) {
              log.info(`gateway started in-process at ${startedUrl}`);
              return startedUrl;
            }
            return null;
          })();
        }
        const result = await loreInitPromise;
        if (result) {
          loreActive = true;
          gatewayBase = result;
        }
      }
      processLoreActive = loreActive;
      processLoreBase = gatewayBase;
    }

    if (!loreActive && !loreDisabled) {
      const inTestEnv = isInertTestEnv();
      if (!inTestEnv) {
        const base = "Lore failed to start — memory features are unavailable.";
        const msg = lastGatewayStartError
          ? `${base} Gateway error: ${lastGatewayStartError}` +
            (/not found|not exported|cannot find module/i.test(
              lastGatewayStartError,
            )
              ? " — this looks like a stale build; rebuild with" +
                " `pnpm --filter @loreai/gateway run bundle`" +
                " (or `run build` for a dev checkout)."
              : "")
          : `${base} Ensure @loreai/gateway is installed.`;
        // v2 note: the pre-2.x plugin also raised a TUI-safe toast via the
        // SDK client (`ctx.client.tui.showToast`) so a totally-failed gateway
        // wasn't a silent no-op (Daniel's Windows report). The v2 server
        // plugin context has no toast/notification channel, so this is
        // log-only now — see the PR's open questions.
        reportGatewayUnavailable(msg);
      }
    }

    // Compute and register THIS location's project state. The Map is keyed
    // by project id so concurrent projects in the same process (e.g.,
    // worktrees opened in parallel) don't clobber each other. v2's setup
    // runs once per plugin instance, so the project path is computed here
    // instead of on every pre-2.x plugin call.
    const projectID = ctx.location.project?.id ?? ctx.location.directory;
    const thisProjectPath = discoverWorkspaceRoot(ctx.location.directory);

    // Resolve git remote per-project. Re-use the cached value when the same
    // project is seen again (avoids spawning `git remote -v` every setup).
    const existingState = projectState.get(projectID);
    const thisGitRemote =
      existingState?.projectPath === thisProjectPath
        ? existingState.gitRemote
        : (getGitRemote(thisProjectPath) ?? "");

    projectState.set(projectID, {
      projectPath: thisProjectPath,
      gitRemote: thisGitRemote,
      lastSeenAt: Date.now(),
    });
    reapStaleProjectState();

    // Module-level fallback (used only when model.request is bypassed).
    currentProject = { path: thisProjectPath, gitRemote: thisGitRemote };

    try {
      const registrations: { dispose: () => Promise<void> }[] = [];

      // Disable built-in compaction? — NOT POSSIBLE in v2 (see PR open
      // questions): pre-2.x set `cfg.compaction = { auto: false, prune: false }`
      // because the gateway handles compaction; v2 exposes no plugin path to
      // disable auto-compaction.

      // Register the hidden worker agents via the agent domain transform.
      // `mode: "subagent"` is REQUIRED for `hidden` to take effect: OpenCode
      // defaults agents to `mode: "all"` (visible in BOTH the primary Tab
      // picker and the @-mention/skill list) and only honors `hidden: true`
      // for subagent-mode agents. Without it these internal workers leak into
      // every host project's agent/skill picker.
      //
      // KNOWN GAP (see PR open questions): the v2 AgentEditor has no `add()`,
      // only update-by-id. Agents that already exist are updated in place;
      // missing ones are logged and skipped rather than crashing setup —
      // upstream needs an agent-creation path for full parity.
      registrations.push(
        await ctx.agent.transform((editor) => {
          for (const worker of LORE_WORKERS) {
            const existing = editor.get(worker.id);
            if (existing) {
              editor.update(worker.id, (agent) => {
                agent.mode = "subagent";
                agent.hidden = true;
                agent.description = worker.description;
              });
            } else {
              log.warn(
                `agent ${worker.id} does not exist yet — v2 has no agent-creation path; skipping`,
              );
            }
          }
        }),
      );

      // Pin every provider's baseURL to the gateway via the provider domain
      // transform. See applyLoreProviderSettings in ./internal.ts for the full
      // rationale (the /messages-vs-/v1/messages 404 and the resolveSDK()
      // env-var bypass). `settings.baseURL` is v2's home for what pre-2.x
      // called `options.baseURL`.
      if (gatewayBase) {
        registrations.push(
          await ctx.provider.transform((editor) => {
            applyLoreProviderSettings(editor, gatewayBase);
          }),
        );
      }

      // Register the native recall tool (#2065) via the v2 tool domain.
      // Unlike AgentEditor, ToolEditor HAS an add() — the tool can be
      // registered in v2 exactly as upstream intended.
      if (shouldRegisterNativeRecallTool(gatewayBase) && !nativeRecallClient) {
        nativeRecallClient = createGatewayRecallClient(gatewayBase);
      }
      if (nativeRecallClient) {
        const client = nativeRecallClient;
        registrations.push(
          await ctx.tool.transform((editor) => {
            if (editor.get(RECALL_TOOL_NAME)) return;
            editor.add(
              createRecallTool({
                directory: ctx.location.directory,
                runner: (input, context) =>
                  client
                    ? client.execute(input, context)
                    : Promise.resolve(
                        "Recall is unavailable for this authenticated session.",
                      ),
              }),
            );
          }),
        );
      }

      // Inject per-request identifiers so the gateway can distinguish meta
      // requests (title generation, summary agents, etc.) from real
      // conversation turns and route by provider.
      // Project path, git remote, and upstream URL are injected by the
      // fetch interceptor (installed once per process).
      registrations.push(
        await ctx.session.hook("model.request", async (input) => {
          Object.assign(
            input.headers,
            gatewayAccessHeadersForRemote(gatewayBase),
          );
          input.headers["x-lore-session-id"] = input.sessionID;
          input.headers["x-lore-agent"] = input.agent;
          const sessionInfo = resolveSessionInfo(
            ctx.session,
            input.sessionID,
            thisProjectPath || ctx.location.directory,
          );
          if (sessionInfo.parentID) {
            input.headers["x-parent-session-id"] = sessionInfo.parentID;
          } else {
            // The initial lookup is intentionally fire-and-forget. Tell the
            // gateway to apply the conservative sub-agent budget until it
            // can classify a root session and clear that temporary state.
            input.headers["x-lore-session-parent-state"] =
              sessionInfo.parentLookupPending ? "pending" : "primary";
          }
          if (
            sessionInfo.title &&
            !PLACEHOLDER_TITLE_RE.test(sessionInfo.title)
          ) {
            input.headers["x-lore-session-title"] = encodeURIComponent(
              sessionInfo.title,
            );
          }
          if (thisProjectPath) {
            input.headers["x-lore-project"] = thisProjectPath;
          }
          if (thisGitRemote) {
            input.headers["x-lore-git-remote"] = thisGitRemote;
          }
          const providerID = input.model.providerID;
          if (providerID) {
            input.headers["x-lore-provider"] = providerID;
            const envKey = `LORE_UPSTREAM_${providerID.toUpperCase().replace(/-/g, "_")}`;
            const upstream = process.env[envKey];
            if (upstream && !input.headers["x-lore-upstream-url"]) {
              input.headers["x-lore-upstream-url"] = upstream;
            }
          }
          const extrasRaw = process.env.LORE_UPSTREAM_EXTRA_HEADERS;
          if (extrasRaw) {
            for (const rawLine of extrasRaw.split(/\r?\n/)) {
              const line = rawLine.trim();
              if (!line) continue;
              const colonIdx = line.indexOf(":");
              if (colonIdx <= 0) continue;
              const name = line.slice(0, colonIdx).trim();
              const value = line.slice(colonIdx + 1).trim();
              if (name && shouldForwardUpstreamExtraHeader(name)) {
                input.headers[name] = value;
              }
            }
          }
        }),
      );

      // Startup banner + one-per-process interceptor install. Routed through
      // `log` (file + sink, stderr only when not silenced) — NEVER a raw
      // stderr write: OpenCode owns a full-screen TUI and any stray byte
      // corrupts it. Visible via `lore logs`.
      if (!processInitDone) {
        log.info(`active: ${thisProjectPath}`);

        if (loreActive) {
          installFetchInterceptor({
            gatewayBase,
            // Feed every outgoing request's headers to the recall client so
            // it can cache provider credentials observed on the current
            // turn (correlated via x-lore-session-id / x-lore-provider).
            // Without this the recall client's credential cache stays empty
            // and every native lore_recall call fails closed with
            // "Recall is unavailable for this authenticated session."
            // (#2065's createGatewayRecallClient contract).
            onRequestHeaders: (headers) =>
              nativeRecallClient?.observeRequestHeaders(headers),
            getHeaders: () => {
              const headers: Record<string, string> = {
                ...gatewayAccessHeadersForRemote(gatewayBase),
              };
              const cur = currentProject;
              if (cur?.path) {
                headers["x-lore-project"] = cur.path;
                if (cur.gitRemote) headers["x-lore-git-remote"] = cur.gitRemote;
              }
              return headers;
            },
          });
          log.info(`routing through ${gatewayOriginForLog(gatewayBase)}`);
          log.info(`dashboard: ${gatewayOriginForLog(gatewayBase)}/ui`);
        }

        processInitDone = true;
      }

      // v2 cleanup: dispose hook/transform registrations when the plugin
      // unloads. The gateway and fetch interceptor stay process-global —
      // tearing them down on one instance's unload would break every other
      // instance in the same process.
      return async () => {
        for (const registration of registrations) {
          try {
            await registration.dispose();
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            log.warn(`cleanup of a lore registration failed: ${detail}`);
          }
        }
      };
    } catch (e) {
      // Log the full error before re-throwing so OpenCode's plugin loader
      // (which catches and swallows the error) doesn't hide the root cause.
      // `log.error` captures it to the file + Sentry sink even when stderr is
      // silenced for the TUI, so the cause survives in `lore logs`.
      const detail = e instanceof Error ? e.stack || e.message : String(e);
      log.error(`init failed: ${detail}`);
      throw e;
    }
  },
});

export default LorePlugin;
