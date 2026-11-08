/**
 * Regression coverage for the v2-port review finding: the plugin's
 * `installFetchInterceptor` call must wire `onRequestHeaders` into the
 * native recall client's `observeRequestHeaders`. Without that wiring the
 * recall client's credential cache stays empty and every native
 * `lore_recall` call fails closed with "Recall is unavailable for this
 * authenticated session." — a regression the recall-tool unit tests cannot
 * see (they inject the runner directly).
 */
import { describe, expect, test, vi } from "vitest";

const installSpy = vi.hoisted(() => vi.fn());
const recallClientSpy = vi.hoisted(() => ({
  execute: vi.fn(async () => "memory results"),
  observeRequestHeaders: vi.fn(),
}));

vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    installFetchInterceptor: installSpy,
    createGatewayRecallClient: vi.fn(() => recallClientSpy),
  };
});

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(async () => ({
    attempted: false,
    files: 0,
    buildId: null,
  })),
  startGateway: vi.fn(async () => {
    throw new Error("startup failed");
  }),
}));

vi.mock("@loreai/gateway", () => gatewayMock);

import { LorePlugin } from "../src/index";
import { createMockContext } from "./helpers";

describe("fetch interceptor wiring (native recall credentials)", () => {
  test("forwards onRequestHeaders to the recall client's observer", async () => {
    // Force the active path with a reachable gateway base so the plugin
    // creates the recall client and installs the interceptor.
    process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
    process.env.LORE_GATEWAY_URL = "http://127.0.0.1:3207";
    delete process.env.LORE_REMOTE_URL;
    delete process.env.LORE_DISABLED;
    // The gateway is mocked (startGateway rejects), so discovery must probe
    // a live health endpoint — point probeGateway at the mock via
    // LORE_GATEWAY_URL and accept that probeGateway runs a real fetch to a
    // closed port and fails; the in-process start then fails too... unless
    // probe succeeds. Force success instead: pre-install the interceptor
    // slot by calling installFetchInterceptor ourselves? No — instead mock
    // probeGateway implicitly by making the interceptor install observable
    // even when loreActive is false is NOT possible (install only happens
    // when loreActive). So assert on the wiring when loreActive is true.
    // Simplest deterministic path: make startGateway succeed.
    gatewayMock.startGateway.mockResolvedValue({
      port: 3207,
      owned: false,
      shutdown: async () => {},
    } as never);

    try {
      const mock = createMockContext({ directory: process.cwd() });
      const cleanup = await LorePlugin.setup(mock.ctx);
      if (cleanup) await cleanup();

      expect(installSpy).toHaveBeenCalled();
      const config = installSpy.mock.calls.at(-1)?.[0] as
        | {
            onRequestHeaders?: (headers: Headers) => void;
          }
        | undefined;
      expect(config?.onRequestHeaders).toBeTypeOf("function");

      // Drive the observer the way the interceptor would on a provider
      // request, and assert the recall client saw it.
      const headers = new Headers({
        "x-lore-project": "/proj",
        "x-lore-session-id": "ses-1",
        "x-lore-provider": "anthropic",
        authorization: "Bearer test-credential",
      });
      config?.onRequestHeaders?.(headers);
      expect(recallClientSpy.observeRequestHeaders).toHaveBeenCalledWith(
        headers,
      );
    } finally {
      delete process.env.LORE_OPENCODE_FORCE_ACTIVE;
      delete process.env.LORE_GATEWAY_URL;
      vi.restoreAllMocks();
    }
  });
});
