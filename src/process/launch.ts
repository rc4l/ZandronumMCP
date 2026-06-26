import net from "node:net";

/** Game options that map to Zandronum command-line arguments. */
export interface LaunchOptions {
  iwad?: string;
  files?: string[];
  map?: string;
  skill?: number;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  extraArgs?: string[];
}

/** Build the argv for launching Zandronum from structured options. */
export function buildLaunchArgs(o: LaunchOptions): string[] {
  const args: string[] = [];
  if (o.iwad) args.push("-iwad", o.iwad);
  if (o.files?.length) args.push("-file", ...o.files);
  if (o.skill !== undefined) args.push("-skill", String(o.skill));
  if (o.map) args.push("+map", o.map);
  if (o.fullscreen !== undefined) args.push("+set", "fullscreen", o.fullscreen ? "1" : "0");
  if (o.width !== undefined) args.push("+set", "vid_defwidth", String(o.width));
  if (o.height !== undefined) args.push("+set", "vid_defheight", String(o.height));
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  return args;
}

/** Resolve true once a TCP connection to host:port succeeds, false otherwise. */
export function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Poll until host:port accepts a connection, or throw after `attempts` tries. */
export async function waitForPort(
  host: string,
  port: number,
  attempts = 60,
  intervalMs = 700,
  connect: (h: string, p: number) => Promise<boolean> = tryConnect,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await connect(host, port)) return;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(`bridge port ${host}:${port} never opened`);
}
