import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureScreenshot, screenshotName, type CaptureIo } from "../src/screenshot/capture.js";
import { CAPTURE_TAG, captureTag } from "../src/screenshot/tag.js";
import type { BridgeClient } from "../src/bridge/transport.js";
import { norm } from "./fakes/paths.js";

// A stub client — capture only needs runCommand, and we drive the filesystem
// ourselves, so we don't need a real engine or bridge here.
const stubClient = { runCommand: async () => [] } as unknown as BridgeClient;

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mcpshot-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("screenshotName", () => {
  it("formats a sequence into a name", () => {
    expect(screenshotName(3, "4242_ab12cd")).toBe("mcp_shot_4242_ab12cd_3");
    // Defaults to this process's tag, so two servers can't collide on one filename.
    expect(screenshotName(3)).toBe(`mcp_shot_${CAPTURE_TAG}_3`);
  });
});

describe("captureTag", () => {
  it("is the PID plus a hex token, so sandboxed servers sharing a PID still differ", () => {
    expect(captureTag(2, Buffer.from([0xab, 0x01, 0xff]))).toBe("2_ab01ff");
    expect(CAPTURE_TAG).toMatch(new RegExp(`^${process.pid}_[0-9a-f]{6}$`));
  });
});

describe("captureScreenshot", () => {
  it("returns the file base64 and deletes it on success (default name)", async () => {
    const unlinked: string[] = [];
    const io: CaptureIo = {
      readFile: async () => Buffer.from("PNGDATA"),
      unlink: async (p) => {
        unlinked.push(p);
      },
      sleep: async () => {
        throw new Error("should not sleep when the file is already there");
      },
    };
    const shot = await captureScreenshot(stubClient, { dir: "/anywhere" }, io);
    expect(shot.name).toMatch(/^mcp_shot_\d+_[0-9a-f]{6}_\d+$/);
    expect(shot.base64).toBe(Buffer.from("PNGDATA").toString("base64"));
    expect(unlinked).toEqual([shot.path]);
  });

  it("still returns if cleanup (unlink) fails", async () => {
    const io: CaptureIo = {
      readFile: async () => Buffer.from("PNGDATA"),
      unlink: async () => {
        throw new Error("EPERM");
      },
      sleep: async () => {},
    };
    const shot = await captureScreenshot(stubClient, { dir: "/d", name: "x" }, io);
    expect(shot.base64).toBe(Buffer.from("PNGDATA").toString("base64"));
  });

  it("retries until the file appears", async () => {
    let calls = 0;
    let slept = 0;
    const io: CaptureIo = {
      readFile: async () => {
        calls += 1;
        if (calls < 3) throw new Error("ENOENT");
        return Buffer.from("LATE");
      },
      unlink: async () => {},
      sleep: async () => {
        slept += 1;
      },
    };
    const shot = await captureScreenshot(
      stubClient,
      { dir: "/d", name: "x", attempts: 5, intervalMs: 1 },
      io,
    );
    expect(shot.base64).toBe(Buffer.from("LATE").toString("base64"));
    expect(calls).toBe(3);
    expect(slept).toBe(2);
  });

  it("throws if the file never appears", async () => {
    const io: CaptureIo = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      unlink: async () => {},
      sleep: async () => {},
    };
    await expect(
      captureScreenshot(stubClient, { dir: "/d", name: "y", attempts: 2, intervalMs: 1 }, io),
    ).rejects.toThrow(/did not appear/);
  });

  it("keeps the file, clearing any stale one of the same name first", async () => {
    const unlinked: string[] = [];
    let ran = false;
    const client = {
      runCommand: async () => {
        ran = true;
        return [];
      },
    } as unknown as BridgeClient;
    const io: CaptureIo = {
      readFile: async () => {
        if (!ran) throw new Error("read before the command ran");
        return Buffer.from("NEW");
      },
      unlink: async (p) => {
        expect(ran).toBe(false); // only the pre-capture clear, never after the read
        unlinked.push(p);
        throw new Error("ENOENT"); // nothing stale there: tolerated
      },
      sleep: async () => {},
    };
    const shot = await captureScreenshot(client, { dir: "/d", name: "k", keep: true }, io);
    expect(shot.base64).toBe(Buffer.from("NEW").toString("base64"));
    expect(unlinked).toEqual([norm("/d/k.png")]);
  });

  it("reads then deletes a real file via the default IO", async () => {
    const dir = freshDir();
    const path = join(dir, "late.png");
    setTimeout(() => writeFileSync(path, Buffer.from("REALPNG")), 80);
    const shot = await captureScreenshot(stubClient, {
      dir,
      name: "late",
      attempts: 30,
      intervalMs: 25,
    });
    expect(shot.path).toBe(path);
    expect(shot.base64).toBe(Buffer.from("REALPNG").toString("base64"));
    expect(existsSync(path)).toBe(false); // cleaned up
  });
});
