/**
 * OpenCode sub-agent detection (#1300).
 *
 * A Task sub-agent runs in a child session whose `parentID` points at the
 * spawning session. The session-domain `model.request` hook resolves that
 * parent via the v2 session domain and forwards it as `x-parent-session-id` —
 * the same signal Claude Code emits natively — so the gateway flags the
 * session as a sub-agent and sizes its LTM injection (#1302). Primary sessions
 * have no parent and emit no such header.
 *
 * The lookup is cached per session and must never block or break the request.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LorePlugin } from "../src/index";
import {
  createMockContext,
  runModelRequest,
  type CapturedHook,
} from "./helpers";

async function initPlugin(
  directory: string,
  options?: Parameters<typeof createMockContext>[0],
) {
  const mock = createMockContext({ directory, ...options });
  const cleanup = await LorePlugin.setup(mock.ctx);
  const hook = mock.sessionHooks.find((h) => h.name === "model.request");
  if (!hook) throw new Error("model.request hook was not registered");
  return { mock, hook: hook, cleanup };
}

async function headersFor(
  hook: CapturedHook,
  sessionID: string,
): Promise<Record<string, string>> {
  return runModelRequest(hook, { sessionID });
}

describe("OpenCode plugin — sub-agent detection (#1300)", () => {
  let tmpDirs: string[] = [];
  function makeTmp(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lore-subagent-${label}-`));
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

  test("sub-agent session forwards its parentID as x-parent-session-id", async () => {
    const dir = makeTmp("sub");
    const { hook, cleanup } = await initPlugin(dir, {
      parents: { "sa-child-1": "sa-parent-1" },
    });
    try {
      const headers = await headersFor(hook, "sa-child-1");
      expect(headers["x-parent-session-id"]).toBe("sa-parent-1");
      // Sanity: the normal session header is still the child's own id.
      expect(headers["x-lore-session-id"]).toBe("sa-child-1");
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("primary session (no parentID) emits no x-parent-session-id", async () => {
    const dir = makeTmp("primary");
    const { hook, cleanup } = await initPlugin(dir, {});
    try {
      const headers = await headersFor(hook, "primary-1");
      expect(headers["x-parent-session-id"]).toBeUndefined();
      expect(headers["x-lore-session-id"]).toBe("primary-1");
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("parent lookup is cached — session.get runs once across turns", async () => {
    const dir = makeTmp("cache");
    const calls: string[] = [];
    const { hook, cleanup } = await initPlugin(dir, {
      parents: { "cache-child": "cache-parent" },
      calls,
    });
    try {
      for (let i = 0; i < 3; i++) {
        const headers = await headersFor(hook, "cache-child");
        expect(headers["x-parent-session-id"]).toBe("cache-parent");
      }
      expect(calls.filter((id) => id === "cache-child")).toHaveLength(1);
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("a lookup failure is swallowed and NOT cached (retried next turn)", async () => {
    const dir = makeTmp("retry");
    let down = true; // first call fails, then recovers
    const { hook, cleanup } = await initPlugin(dir, {
      parents: { "retry-child": "retry-parent" },
      fail: () => down,
    });
    try {
      // Turn 1: lookup fails — no header, request not broken.
      const h1 = await headersFor(hook, "retry-child");
      expect(h1["x-parent-session-id"]).toBeUndefined();
      expect(h1["x-lore-session-id"]).toBe("retry-child");

      // Turn 2: server recovers — the failure was not cached, so it resolves now.
      down = false;
      const h2 = await headersFor(hook, "retry-child");
      expect(h2["x-parent-session-id"]).toBe("retry-parent");
    } finally {
      if (cleanup) await cleanup();
    }
  });
});
