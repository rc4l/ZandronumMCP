#!/usr/bin/env node
// Split a bridge tee log (mcp-bridge-<port>.log) at its `echo CAPTURE <name>` markers into conformance fixtures.
//
//   node --import tsx scripts/split-captures.mjs <tee.log> test/fixtures/<engine>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { splitCaptures } from "./split-captures.core.mjs";

const [log, outDir] = process.argv.slice(2);
if (!log || !outDir) {
  console.error("usage: split-captures.mjs <tee.log> <out dir>");
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
for (const { name, lines } of splitCaptures(readFileSync(log, "utf8").split(/\r?\n/))) {
  writeFileSync(join(outDir, `${name}.txt`), lines.join("\n") + "\n");
  console.log(`${name}: ${lines.length} line(s)`);
}
