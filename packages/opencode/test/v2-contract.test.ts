import { describe, expect, test } from "vitest";
import plugin, { LorePlugin } from "../src/index";

describe("OpenCode V2 public plugin contract", () => {
  test("default-exports a definition and keeps the supported V1 server", async () => {
    expect(plugin).toMatchObject({ id: "lore" });
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");

    // The named function remains the legacy entrypoint for hosts predating
    // the V1 object contract. V1 >=1.18.29 invokes default.server instead.
    expect(typeof LorePlugin).toBe("function");
    expect(plugin.server).toBe(LorePlugin);
  });
});
