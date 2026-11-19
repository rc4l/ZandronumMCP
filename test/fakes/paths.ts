import path from "node:path";

// Fixture paths in the form the code under test returns on this OS: `\` separators, and a drive letter where it resolves.

/** A fixture path as the code builds it with path.join: `\demos\m1.lmp` on Windows. */
export const norm = (p: string): string => path.normalize(p);

/** A fixture path as the code resolves it: `D:\a\eng-mcp.ini` on Windows. */
export const abs = (p: string): string => path.resolve(p);

/** `re` with each `\/` matching the host's separator instead, for a path built with path.join. */
export const sepRe = (re: RegExp): RegExp => new RegExp(re.source.replaceAll("\\/", path.sep === "/" ? "\\/" : "\\\\"), re.flags);

/** A Map keyed by resolved path, so the code's `\engine\x.log` and a fixture's `/engine/x.log` meet. */
export class PathMap<V> extends Map<string, V> {
  override get(key: string): V | undefined {
    return super.get(path.resolve(key));
  }
  override set(key: string, value: V): this {
    return super.set(path.resolve(key), value);
  }
  override has(key: string): boolean {
    return super.has(path.resolve(key));
  }
  override delete(key: string): boolean {
    return super.delete(path.resolve(key));
  }
}

/** `text` with CRLF line ends made LF: a Windows checkout's sources, a native program's text-mode stdout. */
export const lf = (text: string): string => text.replace(/\r\n/g, "\n");
