import path from "node:path";

// Fixture paths in the form the code under test returns on this OS: `\` separators, and a drive letter where it resolves.

/** A fixture path as the code builds it with path.join: `\demos\m1.lmp` on Windows. */
export const norm = (p: string): string => path.normalize(p);

/** A fixture path as the code resolves it: `D:\a\eng-mcp.ini` on Windows. */
export const abs = (p: string): string => path.resolve(p);
