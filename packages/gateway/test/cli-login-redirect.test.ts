import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ answer: "" }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => fixture.answer,
    close: () => {},
  }),
}));

test.each([
  [307, "123456", "token"],
  [308, "123456", "token"],
  [
    307,
    "https://example.test/verify?token_hash=fixture-hash&type=magiclink",
    "token_hash",
  ],
  [
    308,
    "https://example.test/verify?token_hash=fixture-hash&type=magiclink",
    "token_hash",
  ],
])(
  "CLI email verification never follows a %s redirect for %s",
  async (status, input, field) => {
    let forwarded = 0;
    let verified = false;
    const target = createServer((req, res) => {
      forwarded++;
      req.resume();
      res.writeHead(400, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) =>
      target.listen(0, "127.0.0.1", resolve),
    );
    const location = `http://127.0.0.1:${(target.address() as AddressInfo).port}/target`;
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (req.url === "/auth/v1/verify") {
          const body = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as Record<string, unknown>;
          verified =
            body[field] === (field === "token" ? "123456" : "fixture-hash");
          res.writeHead(status, { location }).end();
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
        }
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    vi.stubEnv(
      "SUPABASE_URL",
      `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    );
    vi.stubEnv("SUPABASE_ANON_KEY", "fixture-key");
    vi.resetModules();
    fixture.answer = input;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("fixture-exit");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { commandLogin } = await import("../src/cli/login");
      await expect(
        commandLogin([], { email: "fixture@example.test" }),
      ).rejects.toThrow("fixture-exit");
      expect(verified).toBe(true);
      expect(forwarded).toBe(0);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      log.mockRestore();
      error.mockRestore();
      vi.unstubAllEnvs();
      vi.resetModules();
      upstream.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => upstream.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
  },
);
