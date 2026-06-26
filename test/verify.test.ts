import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBridge, BRIDGE_MARKER } from "../src/process/verify.js";

const tmpDirs: string[] = [];
function tmpFile(contents: Buffer | string): string {
  const d = mkdtempSync(join(tmpdir(), "verify-"));
  tmpDirs.push(d);
  const p = join(d, "zandronum.exe");
  writeFileSync(p, contents);
  return p;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hasBridge", () => {
  it("returns true for a binary containing the bridge marker (default read)", () => {
    const p = tmpFile(Buffer.concat([Buffer.from("\x00\x01rubbish"), Buffer.from(BRIDGE_MARKER), Buffer.from("more\x00")]));
    expect(hasBridge(p)).toBe(true);
  });

  it("returns false for a stock binary without the marker (default read)", () => {
    expect(hasBridge(tmpFile("just some\x00stock bytes, no marker here"))).toBe(false);
  });

  it("uses the injected reader when provided", () => {
    const read = (_p: string) => Buffer.from(`prefix ${BRIDGE_MARKER} suffix`);
    expect(hasBridge("/anywhere", read)).toBe(true);
    expect(hasBridge("/anywhere", () => Buffer.from("nope"))).toBe(false);
  });
});
