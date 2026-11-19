import path from "node:path";

/** The memory figures `process_stats` reports, in KiB, from a Linux `/proc/<pid>/status` file. */
export interface ProcMemory {
  vmRssKib: number;
  vmHwmKib: number;
  vmSizeKib: number;
}

const FIELDS: Record<keyof ProcMemory, string> = { vmRssKib: "VmRSS", vmHwmKib: "VmHWM", vmSizeKib: "VmSize" };

/** Where the kernel publishes a process's status. */
export function procStatusPath(pid: number): string {
  return `/proc/${pid}/status`;
}

/** The status file's `Name:` (the kernel's comm, at most 15 characters), or undefined if absent. */
export function procName(text: string): string | undefined {
  return /^Name:\s*(.*?)\r?$/m.exec(text)?.[1];
}

/** Why PID `pid`, named `name`, isn't the engine `exe`, or undefined when it can be: comm is the exe's basename cut to 15 characters. */
export function procMismatch(pid: number, name: string | undefined, exe: string): string | undefined {
  const want = path.basename(exe).slice(0, 15);
  if (name === want) return undefined;
  return `PID ${pid} is ${name ?? "unnamed"}, not ${want}: not this instance's engine (a server outside the engine's PID namespace?).`;
}

/** The memory fields, or the names of the ones missing (a zombie or kernel thread has none). */
export function parseProcMemory(text: string): ProcMemory | { missing: string[] } {
  const out: Partial<ProcMemory> = {};
  const missing: string[] = [];
  for (const [key, field] of Object.entries(FIELDS) as [keyof ProcMemory, string][]) {
    const m = new RegExp(`^${field}:\\s*(\\d+) kB\\r?$`, "m").exec(text);
    if (m) out[key] = Number(m[1]);
    else missing.push(field);
  }
  return missing.length > 0 ? { missing } : (out as ProcMemory);
}
