import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBridge, bridgeMarker } from "../src/process/verify.js";
import { engine } from "../src/engine.js";

const MARKER = bridgeMarker(engine);
const tmpDirs: string[] = [];
function tmpFile(contents: Buffer | string): string {
  const d = mkdtempSync(join(tmpdir(), "verify-"));
  tmpDirs.push(d);
  const p = join(d, "engine.exe");
  writeFileSync(p, contents);
  return p;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("bridgeMarker", () => {
  it("is the engine's bridge-port env var", () => {
    expect(bridgeMarker({ envPrefix: "ENGINE" })).toBe("ENGINE_BRIDGE_PORT");
  });
});

describe("hasBridge", () => {
  it("returns true for a binary containing the bridge marker (default read)", () => {
    const p = tmpFile(Buffer.concat([Buffer.from("\x00\x01rubbish"), Buffer.from(MARKER), Buffer.from("more\x00")]));
    expect(hasBridge(p, MARKER)).toBe(true);
  });

  it("returns false for a stock binary without the marker (default read)", () => {
    expect(hasBridge(tmpFile("just some\x00stock bytes, no marker here"), MARKER)).toBe(false);
  });

  it("uses the injected reader when provided", () => {
    const read = (_p: string) => Buffer.from(`prefix ${MARKER} suffix`);
    expect(hasBridge("/anywhere", MARKER, read)).toBe(true);
    expect(hasBridge("/anywhere", MARKER, () => Buffer.from("nope"))).toBe(false);
  });
});
