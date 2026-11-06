/**
 * Internal helpers for the Lore OpenCode plugin.
 *
 * These functions are intentionally kept OUT of the plugin entry module
 * (`./index.ts`). Historically, OpenCode's pre-2.x legacy plugin loader
 * treated EVERY function exported from a plugin module as a plugin instance
 * and invoked it (see `getServerPlugin`/`getLegacyPlugins` in opencode's
 * plugin loader): exporting these helpers from the entry module caused them
 * to be invoked as plugins and their return values pushed into the host's
 * hooks array — `applyLoreProviderConfig` returned `undefined`, so the host
 * crashed on the first hook dispatch with `undefined is not an object
 * (evaluating 'A.event')`. Keeping them in a separate module means the entry
 * module exposes only the plugin itself, while tests can still import them
 * here. v2's loader validates the default export's shape instead, but a
 * minimal entry module stays the safe posture under either loader.
 */

import { GATEWAY_AUTH_HEADER, isRemoteGatewayTarget, log } from "@loreai/core";
import * as http from "node:http";
import * as https from "node:https";

export interface SigtermHost {
  prependOnceListener: (event: "SIGTERM", listener: () => void) => unknown;
  removeListener: (event: "SIGTERM", listener: () => void) => unknown;
  exit: (code?: number) => unknown;
}

/**
 * Bridge the host process' SIGTERM to an embedded gateway's bounded shutdown.
 *
 * OpenCode's plugin cleanup follows its per-workspace instance cache and
 * can run during ordinary reloads, so it cannot own a process-wide gateway.
 * Its headless `serve` command also does not dispose that cache on SIGTERM.
 * Start Lore teardown first, then explicitly finish the requested process exit.
 */
export function installEmbeddedGatewaySigtermHandler(
  shutdown: () => Promise<void>,
  host: SigtermHost = process,
): () => void {
  let installed = true;
  const onSigterm = (): void => {
    if (!installed) return;
    installed = false;
    host.removeListener("SIGTERM", onSigterm);
    void (async () => {
      try {
        await shutdown();
      } catch {
        // The process is terminating anyway. Record only a categorical error;
        // process exit is the final bounded worker/thread cleanup mechanism.
        log.error("embedded gateway shutdown failed during SIGTERM");
      } finally {
        host.exit(0);
      }
    })();
  };

  host.prependOnceListener("SIGTERM", onSigterm);
  return () => {
    if (!installed) return;
    installed = false;
    host.removeListener("SIGTERM", onSigterm);
  };
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "localhost." ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

/** Access headers are injected only for the URL selected by LORE_REMOTE_URL. */
export function gatewayAccessHeadersForRemote(
  gatewayBase: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const remoteUrl = env.LORE_REMOTE_URL?.replace(/\/+$/, "");
  const token = env.LORE_GATEWAY_AUTH_TOKEN;
  return remoteUrl === gatewayBase.replace(/\/+$/, "") && token
    ? { [GATEWAY_AUTH_HEADER]: token }
    : {};
}

/** Provider and Lore credentials are applied by the gateway, never this hop. */
export function shouldForwardUpstreamExtraHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    !lower.startsWith("x-lore-") &&
    lower !== "x-api-key" &&
    lower !== "x-goog-api-key" &&
    lower !== "authorization"
  );
}

function probeLoopback(url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === "https:" ? https : http).request(
      parsed,
      { method: "GET", signal },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/**
 * The slice of the v2 provider editor this helper uses, declared structurally
 * so unit tests can pass a plain fake and the real SDK editor assigns without
 * casts (`never` in the callback position is assignable from any concrete
 * parameter type).
 */
export interface LoreProviderEditorLike {
  list(): readonly { provider: { id: string } }[];
  update(
    providerID: string,
    update: (provider: unknown) => void,
  ): void | Promise<void>;
}

/**
 * Pin every discovered provider's `settings.baseURL` to the Lore gateway.
 * Without this, opencode can derive the Anthropic baseURL from
 * `OPENAI_BASE_URL` (stripping `/v1`), sending the SDK to
 * `http://host/messages` (no /v1) — the gateway only routes `/v1/messages`,
 * and the fetch interceptor skips 127.0.0.1 to avoid loops, so the call
 * lands as a bare `/messages` 404. Worse, the `OPENAI_BASE_URL` /
 * `ANTHROPIC_BASE_URL` env vars are bypassed by opencode's `resolveSDK()`
 * (it always passes the factory a baseURL, and @ai-sdk's
 * `loadOptionalSetting()` only consults the env var when the factory
 * receives an undefined `baseURL`). Every other @ai-sdk provider (google,
 * mistral, groq, cohere, xai, perplexity, togetherai, vercel, alibaba,
 * deepinfra, gateway, openrouter, cerebras, etc.) has NO baseURL env var at
 * all. Pinning the live provider inventory is the only universal lever.
 *
 * v2 shape: the pre-2.x plugin did this by mutating `cfg.provider` in the
 * `config` hook (`options.baseURL`); v2 exposes no mutable global config, so
 * this runs as a provider-domain transform over the editor's live inventory.
 * Transforms are replayed on every registry rebuild, so providers discovered
 * after setup (e.g. post-auth account inventories) are pinned on the next
 * rebuild too — as long as the transform stays cheap and repeatable, which
 * a per-provider settings assignment is.
 *
 * Per-provider, existing settings keys are preserved (assign a merged
 * settings object; never clobber user-set keys). Providers named `openai`
 * or `openai-codex` additionally get `headerTimeout: false`: Lore can take
 * longer than OpenCode's Codex 10s header deadline while it prepares
 * context, and OpenCode installs its own default before plugins run, so
 * Lore must override rather than preserve that value. The gateway owns the
 * foreground request deadline.
 *
 * Difference from the pre-2.x helper (deliberate): the old code also CREATED
 * a synthetic `pinned.openai` when no openai provider was configured. v2's
 * editor can add providers, but a synthetic one would carry no models and
 * no package inventory, and the gateway routes every request regardless —
 * so the fallback is dropped (see the PR's open questions).
 *
 * Exported for direct testing — tests pass a fake editor and verify the
 * merge logic without spinning up a real gateway.
 */
export function applyLoreProviderSettings(
  editor: LoreProviderEditorLike,
  gatewayBase: string,
): void {
  if (!gatewayBase) return;
  const baseUrl = `${gatewayBase}/v1`;
  for (const record of editor.list()) {
    const id = record.provider.id;
    void editor.update(id, (provider) => {
      const p = provider as {
        settings?: Record<string, unknown>;
      };
      p.settings = {
        ...p.settings,
        baseURL: baseUrl,
        ...(id === "openai" || id === "openai-codex"
          ? { headerTimeout: false }
          : {}),
      };
    });
  }
}

/**
 * Check if the Lore gateway is reachable at the given base URL.
 * Short timeout so this doesn't delay OpenCode startup noticeably.
 */
export async function probeGateway(
  baseURL: string,
  timeoutMs = 1500,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseURL}/health`;
    if (isLoopbackUrl(url)) return await probeLoopback(url, controller.signal);
    return (await fetch(url, { signal: controller.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prepare the UI before probing local gateways.
 *
 * A source-loaded OpenCode plugin can start or reuse a gateway before the
 * workspace build hook has ever run. The gateway owns the actual staging
 * implementation; this small bridge keeps the published plugin compatible
 * with older gateway packages where the development helper does not exist.
 */
export async function prepareLocalUiAssets(): Promise<void> {
  try {
    const gw = "@loreai/gateway";
    const gateway = (await import(/* webpackIgnore: true */ gw)) as {
      prepareSourceUiAssets?: () => Promise<{
        attempted: boolean;
        files: number;
        buildId: string | null;
        error?: string;
      }>;
    };
    if (!gateway.prepareSourceUiAssets) return;
    const result = await gateway.prepareSourceUiAssets();
    if (!result.attempted) return;
    if (result.error) {
      log.warn(`source UI preparation failed: ${result.error}`);
    } else if (result.files === 0) {
      log.warn("source UI preparation produced no assets");
    } else {
      log.info(
        `source UI staged: ${result.files} files` +
          (result.buildId ? `, build ${result.buildId}` : ""),
      );
    }
  } catch {
    // The gateway is optional from the plugin's point of view. Its normal
    // startup path reports a useful error if it cannot be imported.
  }
}

/**
 * Native recall reads the host's local database. Keep it available only when
 * model traffic goes to a local gateway, never a remote target.
 * (Ported from the pre-rebase upstream internal.ts.)
 */
export function shouldRegisterNativeRecallTool(
  gatewayBase: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isLoopbackUrl(gatewayBase) && !isRemoteGatewayTarget(gatewayBase, env);
}

/**
 * Surface a fatal "Lore is unavailable" condition.
 *
 * The pre-2.x plugin ALSO raised a TUI-safe toast via the SDK client
 * (`client.tui.showToast`): in embedded/TUI mode the core logger's stderr is
 * hard-silenced (see `log.silenceStderr()` at plugin activation), so
 * `log.error` alone lands only in the log file + Sentry sink — invisible to
 * a user sitting inside OpenCode's full-screen TUI. The v2 server-plugin
 * context has no toast/notification channel, so this is log-only for now;
 * `lore logs` remains the way to see it (see the PR's open questions).
 */
export function reportGatewayUnavailable(message: string): void {
  // File + Sentry sink (silenced on stderr in embedded mode).
  log.error(message);
}
