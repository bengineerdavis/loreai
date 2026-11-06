import {
  executeRecallTool,
  discoverWorkspaceRoot,
  RECALL_TOOL_NAME,
  RECALL_TOOL_INPUT_SCHEMA,
  RECALL_TOOL_DESCRIPTION,
  type RecallToolExecutor,
} from "@loreai/core";

/**
 * v2 adapter for the native recall tool (#2065).
 *
 * The pre-2.x adapter returned a `ToolDefinition` for the v1 `tool` hook map
 * and verified the invoking assistant message via `ctx.client` (binding the
 * interceptor's cached credential to THIS turn: providerID + turnID from the
 * message's parentID). v2 has no client domain and `SessionModelRequest`
 * carries no message id, so the verification step is dropped: the runner is
 * called with only `projectPath`, `sessionID`, and `signal`. The gateway
 * client then matches credentials cached WITHOUT a turn header (the v2
 * `model.request` hook cannot stamp one) and fails closed when the match is
 * ambiguous — e.g. multiple providers used in the same session. See the PR's
 * open questions for the multi-provider regression this implies.
 *
 * The returned object matches the v2 `ToolEditor.add()` entry shape:
 * `{ name, description, input, execute }` where `input` is the canonical
 * JSON Schema (v2 accepts raw JSON Schema as `Tool.ValueSchema`).
 */
export function createRecallTool(options: {
  /** The plugin instance's location directory (v2 ToolContext has none). */
  directory: string;
  /** Usually `nativeRecallClient.execute` — the gateway recall client. */
  runner: RecallToolExecutor;
}): {
  name: string;
  description: string;
  input: typeof RECALL_TOOL_INPUT_SCHEMA;
  execute: (input: unknown, context: unknown) => Promise<{ output: string }>;
} {
  return {
    name: RECALL_TOOL_NAME,
    description: RECALL_TOOL_DESCRIPTION,
    input: RECALL_TOOL_INPUT_SCHEMA,
    async execute(input, context) {
      const toolCtx = context as {
        sessionID?: string;
        signal?: AbortSignal;
      };
      if (toolCtx.signal?.aborted) return { output: "Recall was cancelled." };
      return {
        output: await options.runner(input, {
          projectPath: discoverWorkspaceRoot(options.directory),
          sessionID: toolCtx.sessionID,
          signal: toolCtx.signal,
        }),
      };
    },
  };
}

// Re-exported for tests that exercise validation directly.
export { executeRecallTool };
