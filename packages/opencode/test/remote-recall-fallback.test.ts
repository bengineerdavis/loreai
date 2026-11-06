import { afterEach, expect, test, vi } from "vitest";
import { createMockContext } from "./helpers";

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(),
  startGateway: vi.fn(),
}));

const internalMock = vi.hoisted(() => ({
  probeGateway: vi.fn(),
  prepareLocalUiAssets: vi.fn(),
  reportGatewayUnavailable: vi.fn(),
}));

vi.mock("@loreai/gateway", () => gatewayMock);
vi.mock("../src/internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal")>();
  return {
    ...actual,
    probeGateway: internalMock.probeGateway,
    prepareLocalUiAssets: internalMock.prepareLocalUiAssets,
    reportGatewayUnavailable: internalMock.reportGatewayUnavailable,
  };
});

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  gatewayMock.prepareSourceUiAssets.mockReset();
  gatewayMock.startGateway.mockReset();
  internalMock.probeGateway.mockReset();
  internalMock.prepareLocalUiAssets.mockReset();
  internalMock.reportGatewayUnavailable.mockReset();
});

test("does not expose local recall when remote and embedded gateways fail", async () => {
  process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
  process.env.LORE_REMOTE_URL = "https://remote-gateway.example";
  process.env.LORE_GATEWAY_URL = "http://127.0.0.1:3207";
  delete process.env.LORE_DISABLED;
  internalMock.probeGateway.mockResolvedValue(false);
  internalMock.prepareLocalUiAssets.mockResolvedValue(undefined);
  internalMock.reportGatewayUnavailable.mockReturnValue(undefined);
  gatewayMock.prepareSourceUiAssets.mockResolvedValue({
    attempted: false,
    files: 0,
    buildId: null,
  });
  gatewayMock.startGateway.mockRejectedValue(new Error("startup failed"));

  vi.resetModules();
  const { LorePlugin } = await import("../src/index");
  const mock = createMockContext({ directory: process.cwd() });
  await LorePlugin.setup(mock.ctx);

  expect(internalMock.probeGateway).toHaveBeenCalled();
  expect(gatewayMock.startGateway).toHaveBeenCalledOnce();
  expect(mock.providerCallbacks).toHaveLength(0);
  expect(mock.toolCallbacks).toHaveLength(0);
});
