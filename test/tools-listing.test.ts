import { afterEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./fakes/tool-harness.js";
import { engine } from "../src/engine.js";

describe("tool listing", () => {
  let h: Harness;
  afterEach(() => h?.close());

  // The tool set and every schema; a tool added, dropped or re-described shows here.
  it("matches the recorded listing", async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    const listing = tools.map(({ name, title, description, inputSchema, outputSchema }) => ({
      name,
      title,
      description,
      inputSchema,
      outputSchema,
    }));
    await expect(JSON.stringify(listing, null, 2) + "\n").toMatchFileSnapshot(
      `./__snapshots__/${engine.id}/tools-listing.json`,
    );
  });
});
