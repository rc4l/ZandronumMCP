#!/usr/bin/env node
//
// apply-bridge.mjs -- apply the MCP engine bridge overlay to a Zandronum source tree.
//
// Cross-platform (Windows/Linux/macOS); Node 20+ is already a project dependency,
// so this runs everywhere without PowerShell. The logic lives in
// apply-bridge.core.mjs (unit-tested); this file is just the CLI shell.
//
// Usage:
//   node engine-bridge/apply-bridge.mjs --src /path/to/zandronum
//   node engine-bridge/apply-bridge.mjs --src /path/to/zandronum --revert
//
// Designed to run AFTER `hg update` on a pristine tree, then before the build.
//
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, applyBridge } from "./apply-bridge.core.mjs";

const { src, revert } = parseArgs(process.argv.slice(2));
if (!src) {
  console.error("Usage: node apply-bridge.mjs --src <zandronum-repo-root> [--revert]");
  process.exit(1);
}

const overlayDir = join(dirname(fileURLToPath(import.meta.url)), "overlay");
applyBridge({ src, revert, overlayDir, log: (m) => console.log(m) });
