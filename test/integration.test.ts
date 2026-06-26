import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { BridgeClient } from "../src/bridge/transport.js";
import { parseDumpActors } from "../src/parsers/dumpactors.js";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/dumpactors.golden.txt", import.meta.url)),
  "utf8",
).split(/\r?\n/);

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

  it("drives list-actors end-to-end through the real client + parser", async () => {
    bridge = await FakeBridge.start();
    bridge.respondTo("dumpactors", fixture);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();

    const output = await client.runCommand("dumpactors");
    const actors = parseDumpActors(output);

    expect(actors).toContainEqual({
      name: "ArtiBoostArmor",
      edNum: 8041,
      spawnId: 22,
      filter: "4:Hexen",
      source: "zandronum.pk3:actors/hexen/boostarmor.txt",
    });
  });

  it("correlates two serial commands independently", async () => {
    bridge = await FakeBridge.start();
    bridge.respondTo("version", ["Zandronum 3.2.1"]).respondTo("mapname", ["MAP01"]);
    client = new BridgeClient({ port: bridge.port });
    await client.connect();

    expect(await client.runCommand("version")).toEqual(["Zandronum 3.2.1"]);
    expect(await client.runCommand("mapname")).toEqual(["MAP01"]);
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
});
