#!/usr/bin/env node
// Split a bridge tee log (mcp-bridge-<port>.log) into conformance fixtures.
//
// The capture run sends `echo CAPTURE <name>` before each CCMD under test
// (sequence: test/fixtures/conformance/README.md). Every line between one
// marker's own correlator line and the next marker is that capture's reply,
// correlator lines dropped. `<name>.txt` gets the reply; a `status*` capture
// (marker only, no command) gets its marker's correlator line instead.
//
//   node scripts/split-captures.mjs <tee.log> test/fixtures/<engine>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [log, outDir] = process.argv.slice(2);
if (!log || !outDir) {
  console.error("usage: split-captures.mjs <tee.log> <out dir>");
  process.exit(2);
}

const SENTINEL = /^__MCPDONE_/;
const MARKER = /^CAPTURE (\S+)$/;
const lines = readFileSync(log, "utf8").split(/\r?\n/);
const captures = [];
for (const line of lines) {
  const m = MARKER.exec(line);
  if (m) captures.push({ name: m[1], status: undefined, body: [] });
  else if (captures.length === 0) continue;
  else if (SENTINEL.test(line)) captures.at(-1).status ??= line;
  else if (captures.at(-1).status !== undefined) captures.at(-1).body.push(line);
}

mkdirSync(outDir, { recursive: true });
for (const { name, status, body } of captures) {
  if (name === "end") continue;
  while (body.length && body.at(-1) === "") body.pop();
  const text = name.startsWith("status") ? [status ?? ""] : body;
  writeFileSync(join(outDir, `${name}.txt`), text.join("\n") + "\n");
  console.log(`${name}: ${text.length} line(s)`);
}
