import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { log } from "@loreai/core";
import {
  gatewayAccessHeadersForRemote,
  installEmbeddedGatewaySigtermHandler,
  isLoopbackUrl,
  prepareLocalUiAssets,
  reportGatewayUnavailable,
  shouldForwardUpstreamExtraHeader,
} from "../src/internal";

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(),
}));

vi.mock("@loreai/gateway", () => gatewayMock);

describe("source UI adapter bridge", () => {
  afterEach(() => {
    gatewayMock.prepareSourceUiAssets.mockReset();
  });

  test("logs and returns after a successful source staging result", async () => {
    gatewayMock.prepareSourceUiAssets.mockResolvedValue({
      attempted: true,
      files: 17,
      buildId: "build-a",
    });

    await expect(prepareLocalUiAssets()).resolves.toBeUndefined();
    expect(gatewayMock.prepareSourceUiAssets).toHaveBeenCalledOnce();
  });

  test("tolerates a failed, empty, or unavailable gateway bridge", async () => {
    gatewayMock.prepareSourceUiAssets.mockResolvedValueOnce({
      attempted: true,
      files: 0,
      buildId: null,
      error: "temporary failure",
    });
    await expect(prepareLocalUiAssets()).resolves.toBeUndefined();

    gatewayMock.prepareSourceUiAssets.mockResolvedValueOnce({
      attempted: true,
      files: 0,
      buildId: null,
    });
    await expect(prepareLocalUiAssets()).resolves.toBeUndefined();

    gatewayMock.prepareSourceUiAssets.mockImplementationOnce(() => {
      throw new Error("bridge unavailable");
    });
    await expect(prepareLocalUiAssets()).resolves.toBeUndefined();
  });

  test("recognizes loopback URLs but not remote or malformed URLs", () => {
    expect(isLoopbackUrl("http://127.0.0.1:3207")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3207")).toBe(true);
    expect(isLoopbackUrl("https://localhost/gateway")).toBe(true);
    expect(isLoopbackUrl("https://lore.example/gateway")).toBe(false);
    expect(isLoopbackUrl("not a URL")).toBe(false);
  });
});

describe("embedded gateway SIGTERM", () => {
  function fakeHost() {
    const events = new EventEmitter();
    let resolveExit: ((code: number | undefined) => void) | undefined;
    const exited = new Promise<number | undefined>((resolve) => {
      resolveExit = resolve;
    });
    return {
      events,
      exited,
      host: {
        prependOnceListener: (event: "SIGTERM", listener: () => void) =>
          events.prependOnceListener(event, listener),
        removeListener: (event: "SIGTERM", listener: () => void) =>
          events.removeListener(event, listener),
        exit: (code?: number) => resolveExit?.(code),
      },
    };
  }

  test("awaits embedded gateway shutdown before completing SIGTERM", async () => {
    let finishShutdown: (() => void) | undefined;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    const { events, exited, host } = fakeHost();
    installEmbeddedGatewaySigtermHandler(shutdown, host);

    events.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledTimes(1);
    let didExit = false;
    void exited.then(() => {
      didExit = true;
    });
    await Promise.resolve();
    expect(didExit).toBe(false);

    finishShutdown?.();
    await expect(exited).resolves.toBe(0);
  });

  test("still completes termination when gateway shutdown fails", async () => {
    const { events, exited, host } = fakeHost();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    log.silenceStderr(false);
    try {
      installEmbeddedGatewaySigtermHandler(async () => {
        throw new Error("shutdown failed");
      }, host);
      events.emit("SIGTERM");
      await expect(exited).resolves.toBe(0);
    } finally {
      stderr.mockRestore();
      log.silenceStderr(false);
    }
  });

  test("cleanup removes the process signal listener", () => {
    const shutdown = vi.fn(async () => {});
    const { events, host } = fakeHost();
    const cleanup = installEmbeddedGatewaySigtermHandler(shutdown, host);

    cleanup();
    events.emit("SIGTERM");
    expect(shutdown).not.toHaveBeenCalled();
  });
});

describe("remote gateway access headers", () => {
  const token = "opencode-remote-gateway-token-at-least-32";

  test("injects the access token only for the matching LORE_REMOTE_URL", () => {
    expect(
      gatewayAccessHeadersForRemote("https://lore.example", {
        LORE_REMOTE_URL: "https://lore.example/",
        LORE_GATEWAY_AUTH_TOKEN: token,
      }),
    ).toEqual({ "x-lore-gateway-token": token });

    expect(
      gatewayAccessHeadersForRemote("http://127.0.0.1:3207", {
        LORE_REMOTE_URL: "https://lore.example",
        LORE_GATEWAY_AUTH_TOKEN: token,
      }),
    ).toEqual({});
  });

  test("does not confuse provider credentials with gateway access", () => {
    expect(
      gatewayAccessHeadersForRemote("https://lore.example", {
        LORE_REMOTE_URL: "https://lore.example",
        ANTHROPIC_API_KEY: "provider-key",
      }),
    ).toEqual({});
  });

  test.each([
    "x-api-key",
    "X-Goog-Api-Key",
    "Authorization",
    "X-Lore-Gateway-Token",
  ])("does not forward managed credential header %s from extras", (name) => {
    expect(shouldForwardUpstreamExtraHeader(name)).toBe(false);
  });

  test("still forwards non-credential upstream extras", () => {
    expect(shouldForwardUpstreamExtraHeader("CF-Access-Client-Id")).toBe(true);
  });
});

/**
 * `reportGatewayUnavailable` is the one user-visible signal left when the
 * in-process gateway fails to start. In embedded/TUI mode `log.error` is
 * silenced on stderr (so it can't corrupt the render), which would otherwise
 * make a totally-failed gateway a silent no-op (Daniel's Windows report).
 *
 * v2 note: the pre-2.x helper ALSO raised a TUI-safe toast via the SDK
 * client (`client.tui.showToast`). The v2 server-plugin context has no
 * toast/notification channel, so this is log-only now — see the PR's open
 * questions. The helper must NEVER let a logging failure turn a degraded
 * session into a crash.
 */
describe("reportGatewayUnavailable", () => {
  const MSG = "Lore failed to start — memory features are unavailable.";
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    // log.error only reaches stderr when NOT silenced; assert that path here.
    log.silenceStderr(false);
  });

  afterEach(() => {
    stderr.mockRestore();
    log.silenceStderr(false);
  });

  test("still records the failure via log.error (file + Sentry sink)", () => {
    reportGatewayUnavailable(MSG);
    const logged = stderr.mock.calls.some((args: unknown[]) =>
      args.join(" ").includes(MSG),
    );
    expect(logged).toBe(true);
  });

  test("never throws (no crash path)", () => {
    expect(() => reportGatewayUnavailable(MSG)).not.toThrow();
  });
});
