/**
 * OpenCode session title forwarding (#1921).
 *
 * The harness's own `Session.title` is resolved alongside parentID in the
 * session-domain `model.request` hook and forwarded percent-encoded as
 * `x-lore-session-title` so the gateway can persist it as the session's
 * explicit title. OpenCode's auto "New session" placeholder is suppressed and
 * polled until a real title appears; a harness that reports no title is never
 * re-queried.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LorePlugin } from "../src/index";
import { createMockContext, runModelRequest } from "./helpers";

async function initPlugin(
  directory: string,
  options?: Parameters<typeof createMockContext>[0],
) {
  const mock = createMockContext({ directory, ...options });
  const cleanup = await LorePlugin.setup(mock.ctx);
  const hook = mock.sessionHooks.find((h) => h.name === "model.request");
  if (!hook) throw new Error("model.request hook was not registered");
  return { mock, hook, cleanup };
}

async function headersFor(
  hook: Parameters<typeof runModelRequest>[0],
  sessionID: string,
): Promise<Record<string, string>> {
  return runModelRequest(hook, { sessionID });
}

describe("OpenCode plugin — session title forwarding (#1921)", () => {
  let tmpDirs: string[] = [];
  function makeTmp(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lore-title-${label}-`));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tmpDirs = [];
  });

  test("forwards the session title percent-encoded", async () => {
    const { hook, mock, cleanup } = await initPlugin(makeTmp("enc"), {
      titles: { s1: "Fix the Ünïcode bug" },
    });
    try {
      const headers = await headersFor(hook, "s1");
      expect(headers["x-lore-session-title"]).toBe(
        "Fix%20the%20%C3%9Cn%C3%AFcode%20bug",
      );
    } finally {
      if (cleanup) await cleanup();
      void mock;
    }
  });

  test("placeholder title is not forwarded and is re-queried next turn", async () => {
    const titles = { ph: "New session - 2026-09-27" };
    const calls: string[] = [];
    const { hook, cleanup } = await initPlugin(makeTmp("ph"), {
      titles,
      calls,
    });
    try {
      const first = await headersFor(hook, "ph");
      expect(first["x-lore-session-title"]).toBeUndefined();
      // Placeholder is kept but polled: the real title may land any turn.
      titles.ph = "Investigate FTS tokenizer";
      const second = await headersFor(hook, "ph");
      expect(calls).toEqual(["ph", "ph"]);
      expect(second["x-lore-session-title"]).toBe(
        "Investigate%20FTS%20tokenizer",
      );
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("a real title is cached — session.get runs once across turns", async () => {
    const calls: string[] = [];
    const { hook, cleanup } = await initPlugin(makeTmp("real"), {
      titles: { real: "Refactor the sync outbox" },
      calls,
    });
    try {
      await headersFor(hook, "real");
      const again = await headersFor(hook, "real");
      expect(calls).toEqual(["real"]);
      expect(again["x-lore-session-title"]).toBe(
        "Refactor%20the%20sync%20outbox",
      );
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("a session with no title emits no header and is not re-queried", async () => {
    const calls: string[] = [];
    const { hook, cleanup } = await initPlugin(makeTmp("none"), { calls });
    try {
      const first = await headersFor(hook, "none");
      const second = await headersFor(hook, "none");
      expect(first["x-lore-session-title"]).toBeUndefined();
      expect(second["x-lore-session-title"]).toBeUndefined();
      expect(calls).toEqual(["none"]);
    } finally {
      if (cleanup) await cleanup();
    }
  });
});
