import { afterEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./fakes/tool-harness.js";
import { engine } from "../src/engine.js";

// Every tool the server registers. A tool added, dropped or renamed fails here first.
const EXPECTED_TOOLS = [
  "run_command", "list_actor_classes", "summon", "summon_at", "give", "take",
  "load_map", "list_running_scripts", "run_script", "run_acs", "screenshot", "screenshot_file",
  "menu_key", "menu_nav", "menu_text", "mouse_move", "mouse_click", "mouse_wheel", "verify_menu",
  "set_pause", "step", "ensure_live", "step_until", "get_acs_var", "set_acs_var", "list_acs_vars",
  "acs_index", "find_acs_symbol", "behavior_names", "list_map_exports", "list_saves", "save_game",
  "load_game", "play_demo", "player_state", "actor_state", "read_hud", "actors_near",
  "inspect_target", "set_cheat", "set_view", "list_players", "find_actors", "list_scripts",
  "list_functions", "profile_scripts", "profile_window", "list_modules", "get_map_var",
  "set_map_var", "get_map_array", "set_map_array", "renderer_info", "viewport_info", "hud_info",
  "map_info", "get_sector", "get_linedef", "find_sectors_by_tag", "launch_instance",
  "attach_instance", "kill_instance", "reset", "get_startup_errors", "read_log", "get_crash",
];

describe("tool listing", () => {
  let h: Harness;
  afterEach(() => h?.close());

  it("registers exactly the expected tools", async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(EXPECTED_TOOLS).toHaveLength(66);
  });

  it("matches the recorded listing", async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    const listing = tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
    await expect(JSON.stringify(listing, null, 2) + "\n").toMatchFileSnapshot(
      `./__snapshots__/${engine.id}/tools-listing.json`,
    );
  });
});
