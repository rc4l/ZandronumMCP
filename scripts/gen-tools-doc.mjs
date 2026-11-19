#!/usr/bin/env node
//
// gen-tools-doc.mjs -- auto-generate README.tools.md from the registered tools.
//
// Runs under tsx (`npm run docs:tools`): registers src/tools.ts against a
// capturing fake server, so the listing is exactly what a client sees,
// descriptions built at registration time included. Tools are grouped by the
// `// --- section ---` header comments in tools.ts, matched to each tool's name
// literal, in registration order. With `--check` (`npm run docs:tools:check`,
// used by CI) it writes nothing and exits 1 if the files on disk are out of date.
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { registerTools } from "../src/tools.ts";
import { engine } from "../src/engine.ts";
import { envName } from "../src/adapter.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolsPath = join(root, "src", "tools.ts");
const outPath = join(root, "README.tools.md");
const args = process.argv.slice(2);
if (args.some((a) => a !== "--check")) {
  console.error(`Unknown argument(s): ${args.join(" ")}. The only option is --check.`);
  process.exit(2);
}
const check = args.includes("--check");
const source = readFileSync(toolsPath, "utf8");

// 1. Register every tool against a fake server that only records metadata.
//    Registration reads only the engine adapter; any other context access fails loudly.
const ctx = new Proxy(
  { engine, env: (suffix) => envName(engine, suffix) },
  {
    get: (t, key) => {
      if (key in t) return t[key];
      throw new Error(`registerTools read ctx.${String(key)} at registration time`);
    },
  },
);
const tools = [];
registerTools(
  {
    registerTool: (name, meta) =>
      tools.push({
        name,
        title: meta.title ?? "",
        description: (meta.description ?? "").replace(/\s+/g, " ").trim(),
      }),
  },
  ctx,
);

// 2. `// --- label ----` comment lines become category headers; each tool takes
//    the last header above its `register("name"` / `registerLive("name"` call.
const lines = source.split("\n");
const sections = [];
lines.forEach((text, i) => {
  const m = text.match(/^\s*\/\/ ---+\s*(.*?)\s*-*\s*$/);
  if (m) sections.push({ line: i, label: m[1].replace(/\s*\(.*\)\s*$/, "").trim() });
});
const categoryForLine = (line) => {
  let cat = "General";
  for (const s of sections) {
    if (s.line < line) cat = s.label;
    else break;
  }
  return cat;
};
const lineOfName = new Map();
for (const m of source.matchAll(/\b(?:register|registerTool|registerLive)\(\s*"([a-z_]+)"/g)) {
  lineOfName.set(m[1], source.slice(0, m.index).split("\n").length - 1);
}
for (const t of tools) {
  const line = lineOfName.get(t.name);
  if (line === undefined) {
    console.error(`No register("${t.name}"/registerLive("${t.name}" literal in src/tools.ts to categorize it.`);
    process.exit(1);
  }
  t.category = categoryForLine(line);
}

// A floor rather than `=== 0`, so a registration path that silently drops some
// tools still fails. The exact set is pinned by test/tools-listing.test.ts.
const MIN_EXPECTED_TOOLS = 66;
if (tools.length < MIN_EXPECTED_TOOLS) {
  console.error(`Registered only ${tools.length} tools (expected at least ${MIN_EXPECTED_TOOLS}).`);
  process.exit(1);
}

// 3. Group by category in first-seen (registration) order and emit markdown.
const order = [];
const byCat = new Map();
for (const t of tools) {
  if (!byCat.has(t.category)) {
    byCat.set(t.category, []);
    order.push(t.category);
  }
  byCat.get(t.category).push(t);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

let md = `# Tools

> **Auto-generated** from \`src/tools.ts\` by \`scripts/gen-tools-doc.mjs\` — do not
> edit by hand; run \`npm run docs:tools\` to regenerate.

The MCP server exposes **${tools.length} tools**. Your agent also discovers them at
runtime via each tool's \`description\`, so this is mainly for browsing.
`;
for (const cat of order) {
  md += `\n## ${cap(cat)}\n\n`;
  for (const t of byCat.get(cat)) {
    md += `- **\`${t.name}\`** — ${t.description}\n`;
  }
}

// 4. Also emit the shields.io endpoint JSON for the "tools" README badge, where
//    the repo has a .github/ to hold it.
const githubDir = join(root, ".github");
const outputs = [[outPath, md]];
if (existsSync(githubDir)) {
  outputs.push([
    join(githubDir, "badges", "tools.json"),
    JSON.stringify({ schemaVersion: 1, label: "tools", message: String(tools.length), color: "blueviolet" }) + "\n",
  ]);
}

const names = (list) => list.map(([path]) => relative(root, path)).join(", ");

// 5. `--check` compares with the files on disk instead of writing them (CRLF checkouts count as fresh).
if (check) {
  const onDisk = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const stale = outputs.filter(([path, text]) => !existsSync(path) || onDisk(path) !== text);
  if (stale.length) {
    console.error(`Out of date: ${names(stale)}. Run \`npm run docs:tools\` and commit the result.`);
    process.exit(1);
  }
  console.log(`Up to date: ${names(outputs)} (${tools.length} tools).`);
  process.exit(0);
}

for (const [path, text] of outputs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

console.log(`Wrote ${names(outputs)} — ${tools.length} tools across ${order.length} categories.`);
