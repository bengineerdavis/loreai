import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_INPUT_SCHEMA,
  discoverWorkspaceRoot,
  type RecallToolExecutor,
} from "@loreai/core";
import { createRecallTool } from "../src/recall-tool";

/**
 * v2 tool context: `ToolContext` carries sessionID/agent/messageID/signal —
 * no `directory`/`worktree`/`abort`/`ask` (the v1 ToolContext had those). The
 * directory is closed over by the plugin setup instead, so the tests pass it
 * via `createRecallTool({ directory })`.
 */
function makeToolContext(signal = new AbortController().signal) {
  return { sessionID: "session-1", signal };
}

describe("OpenCode recall tool (v2 adapter)", () => {
  test("carries the shared schema and description", () => {
    const runner = vi.fn<RecallToolExecutor>(async () => "memory results");
    const recall = createRecallTool({
      directory: "/project",
      runner,
    });

    expect(recall.description).toBe(RECALL_TOOL_DESCRIPTION);
    // v2 takes the canonical JSON Schema directly as the tool's `input`.
    expect(recall.input).toBe(RECALL_TOOL_INPUT_SCHEMA);
    expect(recall.input.type).toBe("object");
    expect(recall.input.properties.query.maxLength).toBeTypeOf("number");
  });

  test("forwards host context to the runner", async () => {
    const runner = vi.fn<RecallToolExecutor>(async () => "memory results");
    const recall = createRecallTool({ directory: "/project", runner });
    const signal = new AbortController().signal;

    await recall.execute(
      { query: "cache behavior", scope: "session" },
      makeToolContext(signal),
    );
    expect(runner).toHaveBeenCalledWith(
      { query: "cache behavior", scope: "session" },
      {
        projectPath: "/project",
        sessionID: "session-1",
        signal,
      },
    );
  });

  test("reports cancellation before invoking the runner", async () => {
    const runner = vi.fn<RecallToolExecutor>(async () => "memory results");
    const recall = createRecallTool({ directory: "/project", runner });
    const controller = new AbortController();
    controller.abort();

    const result = await recall.execute(
      { query: "x" },
      makeToolContext(controller.signal),
    );
    expect(result).toEqual({ output: "Recall was cancelled." });
    expect(runner).not.toHaveBeenCalled();
  });

  test("passes invalid arguments to the shared validator unchanged", async () => {
    const runner = vi.fn<RecallToolExecutor>(async () => "invalid");
    const recall = createRecallTool({ directory: "/project", runner });
    await expect(recall.execute({}, makeToolContext())).resolves.toEqual({
      output: "invalid",
    });
    expect(runner).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ projectPath: "/project" }),
    );
  });

  test("resolves nested workspace paths and preserves the gateway session ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-opencode-recall-"));
    try {
      const nested = join(root, "packages", "app");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(root, ".lore.json"),
        JSON.stringify({ workspaces: ["packages/*"] }),
      );
      const runner = vi.fn<RecallToolExecutor>(async () => "memory results");
      const recall = createRecallTool({ directory: nested, runner });

      await recall.execute(
        { query: "session memory", scope: "session" },
        makeToolContext(),
      );

      expect(runner).toHaveBeenCalledWith(
        { query: "session memory", scope: "session" },
        {
          projectPath: root,
          sessionID: "session-1",
          signal: expect.any(AbortSignal),
        },
      );
      expect(discoverWorkspaceRoot(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
