import { describe, it, expect } from "vitest";
import { parseProcMemory, procMismatch, procName, procStatusPath } from "../src/process/procstatus.js";

const STATUS = "Name:\tzandronum\r\nState:\tS (sleeping)\nVmSize:\t  812340 kB\nVmHWM:\t  402112 kB\nVmRSS:\t  398000 kB\n";

describe("procstatus", () => {
  it("reads the name and memory fields, or names the missing ones", () => {
    expect(procStatusPath(42)).toBe("/proc/42/status");
    expect(procName(STATUS)).toBe("zandronum");
    expect(procName("State:\tZ\n")).toBeUndefined();
    expect(parseProcMemory(STATUS)).toEqual({ vmRssKib: 398000, vmHwmKib: 402112, vmSizeKib: 812340 });
    expect(parseProcMemory("Name:\tkworker\nVmSize:\t1 kB\n")).toEqual({ missing: ["VmRSS", "VmHWM"] });
  });

  it("matches comm against the exe basename cut to 15 characters", () => {
    expect(procMismatch(7, "zandronum", "/opt/zan/zandronum")).toBeUndefined();
    expect(procMismatch(7, "zandronum-serve", "/opt/zandronum-server")).toBeUndefined();
    expect(procMismatch(7, "bash", "/opt/zan/zandronum")).toMatch(/^PID 7 is bash, not zandronum: not this instance's engine/);
    expect(procMismatch(7, undefined, "/opt/zan/zandronum")).toMatch(/^PID 7 is unnamed, not zandronum/);
  });
});
