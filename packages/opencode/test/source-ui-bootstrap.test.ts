import { createServer, type Server } from "node:http";
import { log } from "@loreai/core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { LorePlugin } from "../src/index";
import { createMockContext } from "./helpers";

const gatewayMock = vi.hoisted(() => ({
  prepareSourceUiAssets: vi.fn(),
}));

vi.mock("@loreai/gateway", () => gatewayMock);

describe("OpenCode source UI bootstrap ordering", () => {
  let server: Server;
  let gatewayUrl: string;
  let healthSawPreparation = false;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        healthSawPreparation =
          gatewayMock.prepareSourceUiAssets.mock.results.some(
            (result) => result.type === "return",
          );
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    gatewayUrl = `http://127.0.0.1:${
      (server.address() as { port: number }).port
    }`;
  });

  afterAll(async () => {
    process.env = { ...savedEnv };
    gatewayMock.prepareSourceUiAssets.mockReset();
    log.silenceStderr(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("prepares before probing an explicit local gateway", async () => {
    const previousGateway = process.env.LORE_GATEWAY_URL;
    const previousForce = process.env.LORE_OPENCODE_FORCE_ACTIVE;
    const previousRemote = process.env.LORE_REMOTE_URL;
    gatewayMock.prepareSourceUiAssets.mockResolvedValue({
      attempted: true,
      files: 17,
      buildId: "build-a",
    });
    process.env.LORE_GATEWAY_URL = gatewayUrl;
    process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
    delete process.env.LORE_REMOTE_URL;

    try {
      const { ctx } = createMockContext({ directory: process.cwd() });
      const teardown = await LorePlugin.setup(ctx);
      expect(gatewayMock.prepareSourceUiAssets).toHaveBeenCalledOnce();
      expect(healthSawPreparation).toBe(true);
      if (teardown) await teardown();
    } finally {
      if (previousGateway === undefined) delete process.env.LORE_GATEWAY_URL;
      else process.env.LORE_GATEWAY_URL = previousGateway;
      if (previousForce === undefined)
        delete process.env.LORE_OPENCODE_FORCE_ACTIVE;
      else process.env.LORE_OPENCODE_FORCE_ACTIVE = previousForce;
      if (previousRemote === undefined) delete process.env.LORE_REMOTE_URL;
      else process.env.LORE_REMOTE_URL = previousRemote;
    }
  });
});
