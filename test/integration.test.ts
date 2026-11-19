import { describe, it, expect, afterEach } from "vitest";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { BridgeClient } from "../src/bridge/transport.js";
import { parseDumpActors } from "../src/parsers/dumpactors.js";
import { engine } from "../src/engine.js";
import { engineFixture } from "./fakes/fixtures.js";

const golden = (engineId: string) => engineFixture(engineId, "dumpactors.golden.txt");

let bridge: FakeBridge | undefined;
let client: BridgeClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await bridge?.close();
  bridge = undefined;
});

describe("BridgeClient <-> FakeBridge", () => {
  it("handshakes and returns empty output for a command with no canned reply", async () => {
    bridge = await FakeBridge.start();
    client = new BridgeClient({ port: bridge.port });
    const hello = await client.connect();
    expect(hello.t).toBe("hello");
    expect(hello.engine).toBe("fake");
    expect(await client.runCommand("say hi")).toEqual([]);
  });

  it("returns a multi-line reply verbatim, in order, sentinel excluded", async () => {
    // The client does no parsing of its own: whatever the engine printed between the
    // command and its sentinel is what a tool sees.
    const reply = ["Line one", "  indented two", "", "three"];
    bridge = await FakeBridge.start();
    bridge.respondTo("dumpactors", reply);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();

    expect(await client.runCommand("dumpactors")).toEqual(reply);
  });

  it.each([
    ["zandronum", "ArtiBoostArmor"],
  ])("drives list-actors end-to-end through the real client + parser on the %s golden", async (engineId, sample) => {
    const fixture = golden(engineId);
    bridge = await FakeBridge.start();
    bridge.respondTo("dumpactors", fixture);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();

    const actors = parseDumpActors(await client.runCommand("dumpactors"));

    expect(actors).toEqual(parseDumpActors(fixture));
    expect(actors).toHaveLength(4);
    expect(actors.map((a) => a.name)).toContain(sample);
  });

  it("correlates two serial commands independently", async () => {
    bridge = await FakeBridge.start();
    bridge.respondTo("version", ["Zandronum 3.2.1"]).respondTo("mapname", ["MAP01"]);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();

    expect(await client.runCommand("version")).toEqual(["Zandronum 3.2.1"]);
    expect(await client.runCommand("mapname")).toEqual(["MAP01"]);
  });

  it("emits unsolicited console output without attributing it to a command", async () => {
    bridge = await FakeBridge.start();
    bridge.respondTo("mapname", ["MAP01"]);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();

    // The engine prints constantly, including while no command is in flight.
    const seen = new Promise<string>((resolve) => client!.once("output", resolve));
    bridge.push("Player entered the game");
    expect(await seen).toBe("Player entered the game");

    // That chatter must not end up in the next command's output.
    expect(await client.runCommand("mapname")).toEqual(["MAP01"]);
  });

  it("serialises overlapping commands so their output can't cross-contaminate", async () => {
    bridge = await FakeBridge.start();
    bridge.respondTo("version", ["Zandronum 3.2.1"]).respondTo("mapname", ["MAP01"]);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();

    // Fired together, as parallel MCP tool calls would. Unserialised, the second
    // command's buffer would also collect the first's output and sentinel.
    const [first, second] = await Promise.all([
      client.runCommand("version"),
      client.runCommand("mapname"),
    ]);
    expect(first).toEqual(["Zandronum 3.2.1"]);
    expect(second).toEqual(["MAP01"]);

    // The second command must not even reach the wire until the first is done.
    const sent = bridge.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^version /);
    expect(sent[1]).toMatch(/^mapname /);
  });

  it("runs a queued command after the one ahead of it fails", async () => {
    bridge = await FakeBridge.start();
    bridge.swallow("hang").respondTo("mapname", ["MAP01"]);
    client = new BridgeClient({ port: bridge.port, commandTimeoutMs: 100 });
    await client.connect();

    const failing = client.runCommand("hang");
    const queued = client.runCommand("mapname");
    await expect(failing).rejects.toThrow(/timed out/);
    expect(await queued).toEqual(["MAP01"]);
  });

  it("times out cleanly if the engine never echoes the sentinel", async () => {
    bridge = await FakeBridge.start({ swallowCommands: true });
    client = new BridgeClient({ port: bridge.port, commandTimeoutMs: 100 });
    await client.connect();
    await expect(client.runCommand("hang")).rejects.toThrow(/timed out/);
  });

  it("rejects connect on a protocol version mismatch", async () => {
    bridge = await FakeBridge.start({ hello: { v: 2, t: "hello", engine: "fake" } });
    client = new BridgeClient({ port: bridge.port });
    await expect(client.connect()).rejects.toThrow(/protocol v2/);
  });

  it("accepts a hello with no version field (treats it as compatible)", async () => {
    bridge = await FakeBridge.start({ hello: { t: "hello", engine: "fake" } });
    client = new BridgeClient({ port: bridge.port });
    const hello = await client.connect();
    expect(hello.engine).toBe("fake");
  });

  it("rejects connect when nothing is listening", async () => {
    bridge = await FakeBridge.start();
    const deadPort = bridge.port;
    await bridge.close();
    bridge = undefined;
    const c = new BridgeClient({ port: deadPort });
    await expect(c.connect()).rejects.toThrow();
  });

  it("survives a socket reset after connecting (no unhandled 'error' crash)", async () => {
    bridge = await FakeBridge.start();
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    const closed = new Promise<void>((resolve) => client!.once("close", resolve));
    bridge.resetClients();
    await closed; // a swallowed socket error must not throw / crash the process
  });

  it("rejects in-flight commands when the connection closes", async () => {
    bridge = await FakeBridge.start({ swallowCommands: true });
    client = new BridgeClient({ port: bridge.port, commandTimeoutMs: 2000 });
    await client.connect();
    const inflight = client.runCommand("hang");
    bridge.endClients();
    await expect(inflight).rejects.toThrow(/closed/);
  });

  it("rejects runCommand (and no-ops close) before connecting", async () => {
    const c = new BridgeClient({ port: 1 });
    await expect(c.runCommand("x")).rejects.toThrow(/Not connected/);
    c.close(); // socket is undefined — exercises the optional-chaining path
  });

  it("defaults missing text/level on out messages", async () => {
    bridge = await FakeBridge.start();
    bridge.respondToRaw("weird", [{}]);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    expect(await client.runCommand("weird")).toEqual([""]);
  });

  it("reports capabilities advertised in the hello", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", caps: ["cmd", "event"] } });
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    expect(client.supports("event")).toBe(true);
    expect(client.supports("nope")).toBe(false);
  });

  it("reports the engine name from the hello, and undefined when it omits one", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: engine.id } });
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    expect(client.engineName).toBe(engine.id);
    client.close();

    await bridge.close();
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello" } });
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    expect(client.engineName).toBeUndefined();
  });

  it("defaults to no capabilities when the hello omits caps", async () => {
    bridge = await FakeBridge.start();
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    expect(client.supports("event")).toBe(false);
  });

  it("posts an input event to the bridge", async () => {
    bridge = await FakeBridge.start();
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    const received = bridge.waitForEvent();
    client.sendEvent(4, 1, 10, 0);
    expect(await received).toEqual({ evtype: 4, subtype: 1, data1: 10, data2: 0 });
  });

  it("throws when posting an event before connecting", () => {
    const c = new BridgeClient({ port: 1 });
    expect(() => c.sendEvent(4, 1, 10, 0)).toThrow(/Not connected/);
  });

  it("sends setpause(true) as paused:1", async () => {
    bridge = await FakeBridge.start();
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    const received = bridge.waitForPause();
    client.setPause(true);
    expect(await received).toBe(1);
  });

  it("sends setpause(false) as paused:0", async () => {
    bridge = await FakeBridge.start();
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    const received = bridge.waitForPause();
    client.setPause(false);
    expect(await received).toBe(0);
  });

  it("throws when setting pause before connecting", () => {
    const c = new BridgeClient({ port: 1 });
    expect(() => c.setPause(false)).toThrow(/Not connected/);
  });

  it("throws when sending a fire-and-forget command before connecting", () => {
    const c = new BridgeClient({ port: 1 });
    expect(() => c.sendCommand("quit")).toThrow(/Not connected/);
  });

  it("refreshStatus is a no-op without the status cap", async () => {
    bridge = await FakeBridge.start(); // default hello: no caps at all
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    await client.refreshStatus();
    expect(client.lastStatus).toBeUndefined();
    expect(bridge.received).toHaveLength(0);
  });

  it("refreshStatus populates lastStatus via a bare mcp_status probe", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", caps: ["cmd", "status"] } });
    bridge.setStatus({ paused: "1" });
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    await client.refreshStatus();
    expect(client.lastStatus).toMatchObject({ paused: "1" });
    const sent = bridge.received.filter((m) => m.t === "cmd");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/^mcp_status /);
  });

  it("drops another request's late sentinel line from a command's output", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", caps: ["cmd", "status"] } });
    bridge.respondTo("save s1", ["__MCPDONE_old__ paused=1 acstemp=0", "real line"]);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    expect(await client.runCommand("save s1")).toEqual(["real line"]);
    expect(client.lastStatus?.paused).not.toBe("1");
  });

  it("keeps a multi-line message that only quotes an old sentinel mid-line", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", caps: ["cmd", "status"] } });
    const hud = "MCP_HUD\ntext 0 0 __MCPDONE_old__ paused=0\nimage STBAR 0 168";
    bridge.respondTo("dumphud", [hud]);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    expect(await client.runCommand("dumphud")).toEqual([hud]);
  });

  it("resolves (not rejects) when a status refresh probe times out", async () => {
    bridge = await FakeBridge.start({
      hello: { v: 1, t: "hello", caps: ["cmd", "status"] },
      swallowCommands: true,
    });
    client = new BridgeClient({ port: bridge.port });
    await client.connect();
    await client.refreshStatus(); // readStatus resolves with no status after ~500ms
    expect(client.lastStatus).toBeUndefined();
  });

  describe("readStatus", () => {
    const statusHello = { hello: { v: 1, t: "hello", caps: ["cmd", "status"] } };

    /** Resolve once the client has seen `text` as console output. */
    const seen = (text: string) =>
      new Promise<void>((resolve) => {
        const on = (t: string) => t === text && (client!.off("output", on), resolve());
        client!.on("output", on);
      });

    it("resolves at once with nothing on a capless bridge", async () => {
      bridge = await FakeBridge.start();
      client = new BridgeClient({ port: bridge.port });
      await client.connect();
      expect(await client.readStatus(1000)).toEqual({ status: undefined, lines: [] });
      expect(bridge.received).toHaveLength(0);
    });

    it("returns the snapshot plus what printed since the last command, minus foreign replies", async () => {
      bridge = await FakeBridge.start(statusHello);
      bridge.respondTo("load bad", ["loading"], ["__MCPDONE_old__ paused=1", "Could not read savegame 'bad'"]);
      bridge.setStatus({ pending: "0" });
      client = new BridgeClient({ port: bridge.port });
      await client.connect();
      const late = seen("Could not read savegame 'bad'");
      expect(await client.runCommand("load bad")).toEqual(["loading"]);
      await late;
      const got = await client.readStatus(1000);
      expect(got.status).toMatchObject({ pending: "0" });
      expect(got.lines).toEqual(["Could not read savegame 'bad'"]);
      expect(client.lastStatus).toBe(got.status);
    });

    it("keeps only the newest idle-time messages", async () => {
      bridge = await FakeBridge.start(statusHello);
      const chatter = Array.from({ length: 55 }, (_, i) => `line ${i}`);
      bridge.respondTo("spam", [], chatter);
      client = new BridgeClient({ port: bridge.port });
      await client.connect();
      const last = seen("line 54");
      await client.runCommand("spam");
      await last;
      expect((await client.readStatus(1000)).lines).toEqual(chatter.slice(5));
    });

    it("forgets idle-time output once another command starts", async () => {
      bridge = await FakeBridge.start(statusHello);
      bridge.respondTo("load bad", [], ["late"]);
      client = new BridgeClient({ port: bridge.port });
      await client.connect();
      const late = seen("late");
      await client.runCommand("load bad");
      await late;
      await client.runCommand("echo hi");
      expect((await client.readStatus(1000)).lines).toEqual([]);
    });

    it("returns no status but the lines so far when the read times out", async () => {
      bridge = await FakeBridge.start({ ...statusHello, swallowCommands: true });
      client = new BridgeClient({ port: bridge.port });
      await client.connect();
      const read = client.readStatus(300);
      for (let i = 0; i < 100 && bridge.received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      bridge.push("busy loading");
      expect(await read).toEqual({ status: undefined, lines: ["busy loading"] });
      expect(client.lastStatus).toBeUndefined();
    });

    it("returns no status when the connection drops mid-read", async () => {
      bridge = await FakeBridge.start({ ...statusHello, swallowCommands: true });
      client = new BridgeClient({ port: bridge.port });
      await client.connect();
      const read = client.readStatus(2000);
      bridge.endClients();
      expect(await read).toEqual({ status: undefined, lines: [] });
    });
  });
});
