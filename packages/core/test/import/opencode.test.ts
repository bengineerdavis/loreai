/**
 * The OpenCode provider against both on-disk schemas.
 *
 * OpenCode 2.x moved conversations from `session`/`message`/`part` to
 * `session_v2`/`session_message`, carrying each assistant message's parts
 * inline in `data.content` instead of in a sibling `part` table. A reader that
 * knows only v1 silently imports nothing from a migrated database, which is
 * exactly the failure these tests exist to catch.
 *
 * The fixtures here are real SQLite databases built on disk, not mock objects:
 * the provider opens `~/.local/share/opencode/opencode.db` by path, so a test
 * that stubbed the database would not exercise the code that broke.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { Database } from "#db/driver";
import type { AgentHistoryProvider } from "../../src/import/types";

const WORKTREE = "/tmp/v2-fixture-repo";

let home: string;
let previousXdg: string | undefined;
let provider: AgentHistoryProvider;

/** Point the provider's DB path at a disposable directory. */
function useHome(path: string): void {
  home = path;
  process.env.XDG_DATA_HOME = join(path, ".local", "share");
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
}

function dbPath(): string {
  return join(home, ".local", "share", "opencode", "opencode.db");
}

/** Create the `project` row both schemas share. */
function seedProject(db: Database): void {
  db.query(
    `CREATE TABLE project (
       id TEXT PRIMARY KEY, worktree TEXT, vcs TEXT, name TEXT,
       time_created INTEGER, time_updated INTEGER
     )`,
  ).run();
  db.query(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run(
    "proj-1",
    WORKTREE,
  );
}

/** A v1 database: sessions and messages in the legacy tables. */
function buildV1Database(): void {
  const db = new Database(dbPath());
  seedProject(db);
  db.query(
    `CREATE TABLE session (
       id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT,
       time_created INTEGER, time_updated INTEGER
     )`,
  ).run();
  db.query(
    `CREATE TABLE message (
       id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER
     )`,
  ).run();
  db.query(
    `CREATE TABLE part (
       id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER
     )`,
  ).run();
  db.query(
    `INSERT INTO session VALUES ('ses-v1', 'proj-1', NULL, 'Legacy session', 0, 0)`,
  ).run();
  // detect() skips sessions with fewer than 3 messages.
  for (let i = 0; i < 3; i++) {
    const mid = `msg-v1-${i}`;
    db.query(`INSERT INTO message VALUES (?, 'ses-v1', ?, ?)`).run(
      mid,
      JSON.stringify({ role: i % 2 === 0 ? "user" : "assistant" }),
      i,
    );
    db.query(`INSERT INTO part VALUES (?, ?, ?, ?)`).run(
      `part-v1-${i}`,
      mid,
      JSON.stringify({ type: "text", text: `v1 message ${i}` }),
      i,
    );
  }
  db.close();
}

/** A v2 database: sessions in `session_v2`, parts inline in the message data. */
function buildV2Database(): void {
  const db = new Database(dbPath());
  seedProject(db);
  db.query(
    `CREATE TABLE session_v2 (
       id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT,
       time_created INTEGER, time_updated INTEGER
     )`,
  ).run();
  db.query(
    `CREATE TABLE session_message (
       id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
       time_created INTEGER, data TEXT
     )`,
  ).run();
  db.query(
    `INSERT INTO session_v2 VALUES ('ses-v2', 'proj-1', NULL, 'Modern session', 0, 100)`,
  ).run();

  // A user turn keeps its text at the top level of `data`.
  db.query(
    `INSERT INTO session_message VALUES ('m0', 'ses-v2', 'user', 0, 0, ?)`,
  ).run(JSON.stringify({ text: "what does the reader want" }));
  // An assistant turn keeps its parts in `content`, with tool output nested
  // under state.content as a list of text parts.
  db.query(
    `INSERT INTO session_message VALUES ('m1', 'ses-v2', 'assistant', 1, 1, ?)`,
  ).run(
    JSON.stringify({
      content: [
        { type: "reasoning", text: "thinking hard" },
        { type: "text", text: "reading the schema" },
        {
          type: "tool",
          name: "bash",
          state: {
            status: "completed",
            content: [{ type: "text", text: "CREATE TABLE session_v2" }],
          },
        },
      ],
    }),
  );
  // Third message so the session clears the msg_count >= 3 filter.
  db.query(
    `INSERT INTO session_message VALUES ('m2', 'ses-v2', 'assistant', 2, 2, ?)`,
  ).run(JSON.stringify({ content: [{ type: "text", text: "done" }] }));
  db.close();
}

beforeAll(async () => {
  // The provider resolves its database path once, at module load, so XDG_DATA_HOME
  // has to point at the disposable home before that import executes. Setting it in
  // beforeEach would leave the module holding the real path.
  previousXdg = process.env.XDG_DATA_HOME;
  useHome(
    join(
      tmpdir(),
      `lore-opencode-v2-${process.pid}-${Math.random().toString(36).slice(2)}`,
    ),
  );
  // Importing the provider module is what registers it; the barrel only
  // exposes the lookup.
  await import("../../src/import/providers/opencode");
  const { getProvider } = await import("../../src/import/providers");
  const found = getProvider("opencode");
  if (!found) throw new Error("opencode provider not registered");
  provider = found;
});

afterEach(() => {
  rmSync(join(home, ".local", "share", "opencode"), {
    recursive: true,
    force: true,
  });
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
});

afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(home, { recursive: true, force: true });
});

describe("OpenCode provider — v2 schema", () => {
  test("detect finds sessions in session_v2", () => {
    buildV2Database();
    const sessions = provider.detect([WORKTREE]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("ses-v2");
    expect(sessions[0].messageCount).toBe(3);
    expect(sessions[0].label).toContain("Modern session");
  });

  test("readChunks reads text and tool output from inline content", () => {
    buildV2Database();
    const chunks = provider.readChunks(WORKTREE, ["ses-v2"]);
    const text = chunks.map((c: { text: string }) => c.text).join("\n");

    expect(text).toContain("[user] what does the reader want");
    expect(text).toContain("[assistant] reading the schema");
    expect(text).toContain("[tool: bash] CREATE TABLE session_v2");
    // Reasoning parts are not conversation text, matching the v1 path.
    expect(text).not.toContain("thinking hard");
  });

  test("v2 sessions below the message threshold are skipped", () => {
    const db = new Database(dbPath());
    seedProject(db);
    db.query(
      `CREATE TABLE session_v2 (
         id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT,
         time_created INTEGER, time_updated INTEGER
       )`,
    ).run();
    db.query(
      `CREATE TABLE session_message (
         id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
         time_created INTEGER, data TEXT
       )`,
    ).run();
    db.query(
      `INSERT INTO session_v2 VALUES ('tiny', 'proj-1', NULL, 'Tiny', 0, 0)`,
    ).run();
    db.query(
      `INSERT INTO session_message VALUES ('a', 'tiny', 'user', 0, 0, '{"text":"hi"}')`,
    ).run();
    db.close();

    expect(provider.detect([WORKTREE])).toEqual([]);
  });
});

describe("OpenCode provider — v1 still works", () => {
  test("detect finds legacy sessions", () => {
    buildV1Database();
    const sessions = provider.detect([WORKTREE]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("ses-v1");
  });

  test("readChunks reads text parts from the part table", () => {
    buildV1Database();
    const chunks = provider.readChunks(WORKTREE, ["ses-v1"]);
    const text = chunks.map((c: { text: string }) => c.text).join("\n");

    expect(text).toContain("v1 message 0");
    expect(text).toContain("v1 message 2");
  });

  test("a database with neither schema yields no sessions", () => {
    const db = new Database(dbPath());
    seedProject(db);
    db.close();
    expect(provider.detect([WORKTREE])).toEqual([]);
  });
});
