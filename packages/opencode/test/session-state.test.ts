/**
 * Tests for per-project state in the OpenCode plugin (B2).
 *
 * v2's `setup` runs once per plugin instance (per location), but the fetch
 * interceptor is process-global, so multiple OpenCode projects in the same
 * process (e.g., worktrees opened in parallel) each register their own entry
 * keyed by project id. The per-project Map ensures that:
 *   - Each project gets its own registered project path + git remote
 *   - The `model.request` hook injects the right headers per request
 *   - Concurrent project registrations don't clobber each other
 *
 * Regression coverage for the "lore-config" bug variant where the module-
 * level `currentProjectPath` global was overwritten by sibling project
 * inits, causing requests to be misattributed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LorePlugin } from "../src/index";
import { createMockContext, runModelRequest } from "./helpers";

async function initPluginForProject(projectId: string, directory: string) {
  const mock = createMockContext({ projectID: projectId, directory });
  const cleanup = await LorePlugin.setup(mock.ctx);
  const hook = mock.sessionHooks.find((h) => h.name === "model.request");
  if (!hook) throw new Error("model.request hook was not registered");
  return { mock, hook: hook, cleanup };
}

describe("OpenCode plugin — per-project state (B2)", () => {
  let tmpDirs: string[] = [];

  function makeTmp(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lore-opencode-test-${label}-`));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  test("single project: model.request injects x-lore-project for that project", async () => {
    const dirA = makeTmp("a");
    const { hook, cleanup } = await initPluginForProject("project-a", dirA);
    try {
      const headers = await runModelRequest(hook, { sessionID: "session-1" });

      expect(headers["x-lore-session-id"]).toBe("session-1");
      expect(headers["x-lore-agent"]).toBe("build");
      expect(headers["x-lore-project"]).toBe(dirA);
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("two projects: each model.request injects ITS project's path", async () => {
    const dirA = makeTmp("a");
    const dirB = makeTmp("b");
    const pluginA = await initPluginForProject("project-a", dirA);
    // Second project — re-uses the same plugin module (simulating two
    // OpenCode worktrees in the same process).
    const pluginB = await initPluginForProject("project-b", dirB);
    try {
      // Request from project A
      const headersA = await runModelRequest(pluginA.hook, {
        sessionID: "session-a",
      });
      expect(headersA["x-lore-project"]).toBe(dirA);

      // Request from project B (different plugin instance, but the underlying
      // module-level state is shared — verify it doesn't leak)
      const headersB = await runModelRequest(pluginB.hook, {
        sessionID: "session-b",
      });
      expect(headersB["x-lore-project"]).toBe(dirB);

      // Cross-check: A's project path is still correct after B's hook ran
      // (A's hook closed over ITS registered project entry).
      const headersA2 = await runModelRequest(pluginA.hook, {
        sessionID: "session-a-2",
      });
      expect(headersA2["x-lore-project"]).toBe(dirA);
    } finally {
      if (pluginA.cleanup) await pluginA.cleanup();
      if (pluginB.cleanup) await pluginB.cleanup();
    }
  });

  test("multiple sessions in the same project all get the same project path", async () => {
    const dirA = makeTmp("a");
    const { hook, cleanup } = await initPluginForProject("project-a", dirA);
    try {
      for (const sessionID of [
        "s1",
        "s2",
        "s3",
        "sub-agent-1",
        "sub-agent-2",
      ]) {
        const headers = await runModelRequest(hook, { sessionID });
        expect(headers["x-lore-project"]).toBe(dirA);
      }
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("meta agent requests still get x-lore-project (so gateway can route consistently)", async () => {
    const dirA = makeTmp("a");
    const { hook, cleanup } = await initPluginForProject("project-a", dirA);
    try {
      // Simulate the title-generation side-channel by using a "title" agent
      // name. The hook should still set the project path so the gateway
      // doesn't fall back to cwd on these requests.
      const headers = await runModelRequest(hook, {
        sessionID: "session-meta",
        agent: "title",
      });
      expect(headers["x-lore-project"]).toBe(dirA);
    } finally {
      if (cleanup) await cleanup();
    }
  });

  test("a non-git project never emits x-lore-git-remote (no sibling leak)", async () => {
    // Regression for the "git-remote magnet": a project in a non-repo dir must
    // not carry a git remote — neither its own (none on disk) nor one leaked
    // from a sibling project. The temp dirs are not git repos, so getGitRemote
    // returns null and the header must be absent.
    const dirA = makeTmp("a"); // not a git repo
    const dirB = makeTmp("b"); // not a git repo

    const pluginB = await initPluginForProject("project-b", dirB);
    const pluginA = await initPluginForProject("project-a", dirA);
    try {
      const headersA = await runModelRequest(pluginA.hook, {
        sessionID: "session-a",
      });
      expect(headersA["x-lore-project"]).toBe(dirA);
      // No remote on a non-repo dir, and none leaked from project B.
      expect(headersA["x-lore-git-remote"]).toBeUndefined();

      // And project B (initialized earlier) likewise carries no remote.
      const headersB = await runModelRequest(pluginB.hook, {
        sessionID: "session-b",
      });
      expect(headersB["x-lore-git-remote"]).toBeUndefined();
    } finally {
      if (pluginA.cleanup) await pluginA.cleanup();
      if (pluginB.cleanup) await pluginB.cleanup();
    }
  });
});
