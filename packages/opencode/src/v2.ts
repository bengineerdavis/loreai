import { Plugin } from "@opencode/plugin";
import type {
  SessionHttpRequest,
  SessionPrompt,
} from "@opencode/plugin/promise/session";
import type {
  Info as ToolInfo,
  ToolContext,
} from "@opencode/plugin/promise/tool";
import {
  createGatewayRecallClient,
  createGatewayRequest,
  discoverWorkspaceRoot,
  getGitRemote,
  log,
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_INPUT_SCHEMA,
  RECALL_TOOL_NAME,
  type RecallToolArguments,
} from "@loreai/core";
import {
  gatewayAccessHeadersForRemote,
  probeGateway,
  shouldRegisterNativeRecallTool,
  shouldForwardUpstreamExtraHeader,
  surfaceGatewayUnavailable,
} from "./internal";
import {
  resolveGatewayUrl,
  startInProcess,
  gatewayStartError,
} from "./lifecycle";

type Context = Parameters<Plugin.Plugin["setup"]>[0];
type HttpRequest = SessionHttpRequest;
type Registration = { dispose(): Promise<void> };
type SessionTurn = { id: string };

const turns = new Map<string, SessionTurn>();
const sessionMetadata = new Map<
  string,
  { parentID: string | null; title: string | null }
>();
let processInitDone = false;
let gatewayBase = "";
let gatewayInit: Promise<string | null> | undefined;
let nativeRecallClient:
  | ReturnType<typeof createGatewayRecallClient>
  | undefined;

function disabled(): boolean {
  return (
    process.env.LORE_DISABLED === "1" || process.env.LORE_DISABLED === "true"
  );
}

function forceActive(): boolean {
  return process.env.LORE_OPENCODE_FORCE_ACTIVE === "1";
}

async function initializeGateway(): Promise<string | null> {
  if (disabled()) return null;
  if (gatewayBase) return gatewayBase;
  if (gatewayInit) return gatewayInit;
  gatewayInit = (async () => {
    const explicitGateway = Boolean(
      process.env.LORE_GATEWAY_URL || process.env.LORE_REMOTE_URL,
    );
    const inTest = process.env.NODE_ENV === "test";
    const existing = await resolveGatewayUrl({
      allowAmbient: !explicitGateway && !inTest,
    });
    if (existing) return existing;
    // An explicit but unreachable gateway is a degraded integration, not a
    // reason to replace the configured provider with a new gateway. Preserve
    // direct upstream access; only auto-start when no gateway was configured.
    if (explicitGateway || inTest) return null;
    return startInProcess();
  })();
  const result = await gatewayInit;
  if (result) {
    gatewayBase = result;
    nativeRecallClient = createGatewayRecallClient(result);
    if (!processInitDone) {
      log.info(`routing through ${new URL(result).origin}`);
      log.info(`dashboard available at ${new URL(result).origin}/ui`);
    }
    processInitDone = true;
  } else {
    // A failed explicit gateway is not a permanent process-wide verdict.
    // Retry on a later setup/model request; while it is unavailable, direct
    // provider traffic must carry no Lore-only routing or identity metadata.
    gatewayInit = undefined;
  }
  return result;
}

async function activeGateway(): Promise<string | null> {
  if (!gatewayBase) await initializeGateway();
  if (!gatewayBase || !(await probeGateway(gatewayBase))) return null;
  return gatewayBase;
}

function upstreamExtras(): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = process.env.LORE_UPSTREAM_EXTRA_HEADERS;
  if (!raw) return headers;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name && shouldForwardUpstreamExtraHeader(name)) {
      headers[name] = line.slice(colon + 1).trim();
    }
  }
  return headers;
}

async function sessionMetadataFor(ctx: Context, sessionID: string) {
  const cached = sessionMetadata.get(sessionID);
  if (cached) return cached;
  const empty = { parentID: null, title: null };
  try {
    const session = (await ctx.session.get({ sessionID })) as {
      parentID?: string | null;
      title?: string | null;
    };
    const value = {
      parentID: session.parentID ?? null,
      title: session.title ?? null,
    };
    sessionMetadata.set(sessionID, value);
    return value;
  } catch {
    return empty;
  }
}

async function verifiedTurn(ctx: Context, toolContext: ToolContext) {
  const messages = await ctx.session.context({
    sessionID: toolContext.sessionID,
  });
  const position = messages.findIndex(
    (item) => item.id === toolContext.messageID,
  );
  const message = position >= 0 ? messages[position] : undefined;
  if (message?.type !== "assistant") return null;
  const providerID = message.model.providerID;
  if (!providerID) return null;
  // Prompt admission supplies the originating user-message ID. When no such
  // prompt exists, use the host's preceding user message rather than guess.
  let parentID = turns.get(toolContext.sessionID)?.id;
  if (!parentID) {
    const parent = messages
      .slice(0, position)
      .reverse()
      .find((item) => item.type === "user");
    parentID = parent?.id;
  }
  if (!parentID) return null;
  return { providerID, turnID: parentID };
}

function recallDefinition(ctx: Context): ToolInfo {
  return {
    name: RECALL_TOOL_NAME,
    description: RECALL_TOOL_DESCRIPTION,
    input: RECALL_TOOL_INPUT_SCHEMA,
    async execute(input, toolContext) {
      if (toolContext.signal.aborted)
        return { content: "Recall was cancelled." };
      if (!nativeRecallClient) {
        return {
          content: "Recall is unavailable for this authenticated session.",
        };
      }
      try {
        const verified = await verifiedTurn(ctx, toolContext);
        if (!verified) {
          return {
            content: "Recall is unavailable for this authenticated session.",
          };
        }
        const projectPath = discoverWorkspaceRoot(ctx.location.directory);
        return {
          content: await nativeRecallClient.execute(
            input as RecallToolArguments,
            {
              projectPath,
              sessionID: toolContext.sessionID,
              providerID: verified.providerID,
              turnID: verified.turnID,
              signal: toolContext.signal,
            },
          ),
        };
      } catch {
        return {
          content: "Recall is unavailable for this authenticated session.",
        };
      }
    },
  };
}

function withoutLoreRouting(headers: Headers): void {
  // model.request runs before the native health check. If the gateway fails
  // between those boundaries, its metadata must not travel to the provider.
  for (const name of Array.from(headers.keys())) {
    if (name.startsWith("x-lore-") || name === "x-parent-session-id") {
      headers.delete(name);
    }
  }
}

async function prepareRequest(ctx: Context, event: HttpRequest) {
  if (!(await activeGateway())) {
    withoutLoreRouting(event.request.headers);
    return;
  }
  const projectPath = discoverWorkspaceRoot(ctx.location.directory);
  const turn = turns.get(event.sessionID);
  const metadata = await sessionMetadataFor(ctx, event.sessionID);
  const providerID = event.model.providerID;
  // OpenCode honors header edits made on the native request. A replacement
  // Request takes a separate body-replay path; keep the native object when
  // the static provider config already points at Lore, so direct-gateway
  // recursion protection cannot discard the attribution added here.
  const headers = event.request.headers;
  for (const [key, value] of Object.entries(
    gatewayAccessHeadersForRemote(gatewayBase),
  )) {
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries({
    ...upstreamExtras(),
    "x-lore-session-id": event.sessionID,
    "x-lore-agent": event.agent,
    "x-lore-provider": providerID,
    "x-lore-project": projectPath,
  })) {
    headers.set(key, value);
  }
  const remote = getGitRemote(projectPath);
  if (remote) headers.set("x-lore-git-remote", remote);
  if (turn) headers.set("x-lore-native-turn-id", turn.id);
  if (metadata.parentID) {
    headers.set("x-parent-session-id", metadata.parentID);
  } else {
    headers.set(
      "x-lore-session-parent-state",
      sessionMetadata.has(event.sessionID) ? "primary" : "pending",
    );
  }
  if (metadata.title && !/^new session\b/i.test(metadata.title)) {
    headers.set("x-lore-session-title", encodeURIComponent(metadata.title));
  }
  const customUpstream =
    process.env[`LORE_UPSTREAM_${providerID.toUpperCase().replace(/-/g, "_")}`];
  if (customUpstream) headers.set("x-lore-upstream-url", customUpstream);
  nativeRecallClient?.observeRequestHeaders(headers);
  const request = new Request(event.request, { headers });
  event.request =
    createGatewayRequest(request, gatewayBase, {
      ...gatewayAccessHeadersForRemote(gatewayBase),
    }) ?? event.request;
}

export function isInertTestEnv(): boolean {
  if (forceActive()) return false;
  return (
    process.env.NODE_ENV === "test" ||
    process.argv.some((arg) => arg.includes(".test."))
  );
}

export const definition = Plugin.define({
  id: "lore",
  async setup(ctx) {
    if (!isInertTestEnv()) log.silenceStderr();
    await initializeGateway();
    if (!gatewayBase && !disabled() && !isInertTestEnv()) {
      const reason = gatewayStartError();
      surfaceGatewayUnavailable(
        {
          tui: { showToast: (input: unknown) => Promise.resolve(input) },
        } as never,
        `Lore failed to start — memory features are unavailable.${reason ? ` Gateway error: ${reason}` : " Ensure @loreai/gateway is installed."}`,
      );
    }

    const registrations: Registration[] = [];
    registrations.push(
      await ctx.session.hook("prompt", (event: SessionPrompt) => {
        turns.set(event.sessionID, { id: event.messageID });
      }),
    );
    registrations.push(
      await ctx.session.hook("model.request", async (event) => {
        if (!(await activeGateway())) return;
        // The provider prefix is stripped from the upstream model ID. Supply
        // the original identity before OpenCode serializes the native request,
        // including when static provider config already points at the gateway.
        event.headers["x-lore-provider"] = event.model.providerID;
      }),
    );
    registrations.push(
      await ctx.session.hook("http.request", async (event) => {
        // Probe before every rewrite: a failed gateway never turns into a
        // blanket provider route that prevents normal host-agent use.
        await prepareRequest(ctx, event);
      }),
    );
    registrations.push(
      await ctx.session.hook("http.response", (event) => {
        // The gateway consumes this header for correlation, but it must never
        // escape into a direct provider request or another plugin's response.
        event.request.headers.delete("x-lore-native-turn-id");
      }),
    );
    if (gatewayBase && shouldRegisterNativeRecallTool(gatewayBase)) {
      registrations.push(
        await ctx.tool.transform((editor) => editor.add(recallDefinition(ctx))),
      );
    }
    return async () => {
      for (const registration of registrations) await registration.dispose();
    };
  },
});
