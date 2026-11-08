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
import { afterEach, describe, expect, test, vi } from "vitest";
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

/**
 * The parent lookup is fire-and-forget (session metadata must never delay a
 * provider request), so a header only appears on a LATER hook invocation,
 * after the async lookup has landed. Keep invoking the hook until it does.
 */
async function waitForHeader(
  hook: CapturedHook,
  sessionID: string,
  name: string,
  expected: string,
): Promise<void> {
  await vi.waitFor(async () => {
    const headers = await headersFor(hook, sessionID);
    expect(headers[name]).toBe(expected);
  });
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
      expect(headers["x-lore-session-id"]).toBe("sa-child-1");
      // Fire-and-forget lookup: the first turn reports the conservative
      // pending state while the async resolution is in flight.
      expect(headers["x-lore-session-parent-state"]).toBe("pending");
      await waitForHeader(
        hook,
        "sa-child-1",
        "x-parent-session-id",
        "sa-parent-1",
      );
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("primary session stays pending until the async lookup resolves", async () => {
    const dir = makeTmp("primary");
    const calls: string[] = [];
    const { hook, cleanup } = await initPlugin(dir, { calls });
    try {
      const headers = await headersFor(hook, "primary-1");
      expect(headers["x-parent-session-id"]).toBeUndefined();
      expect(headers["x-lore-session-id"]).toBe("primary-1");
      expect(headers["x-lore-session-parent-state"]).toBe("pending");
      await vi.waitFor(() => expect(calls).toEqual(["primary-1"]));
      // Once the async lookup has confirmed a primary session (parentID
      // null), the state clears — without a second session.get call.
      const resolvedHeaders = await headersFor(hook, "primary-1");
      expect(resolvedHeaders["x-parent-session-id"]).toBeUndefined();
      expect(resolvedHeaders["x-lore-session-parent-state"]).toBe("primary");
      expect(calls).toEqual(["primary-1"]);
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
      await headersFor(hook, "cache-child");
      await waitForHeader(
        hook,
        "cache-child",
        "x-parent-session-id",
        "cache-parent",
      );
      await headersFor(hook, "cache-child");
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

      // The first failure is not cached; once the server recovers, a later
      // turn retries and the following turn observes the refreshed metadata.
      down = false;
      await headersFor(hook, "retry-child");
      await waitForHeader(
        hook,
        "retry-child",
        "x-parent-session-id",
        "retry-parent",
      );
    } finally {
      if (cleanup) await cleanup();
    }
  });
});
