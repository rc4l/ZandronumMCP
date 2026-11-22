#!/usr/bin/env node
//
// gen-tools-doc.mjs -- auto-generate README.tools.md from the tools as registered, so it lists exactly what a client sees.
//
// Run: `npm run docs:tools`, or `npm run docs:tools:check` (CI) to exit 1 on stale files.
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { registerTools } from "../src/tools.ts";
import { engine } from "../src/engine.ts";
import { envName } from "../src/adapter.ts";
import { categorize, renderToolsDoc, staleOutputs } from "./gen-tools-doc.core.mjs";

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

// Registration may read only the engine adapter, so any other ctx access throws.
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

const categorized = categorize(source, tools);
const md = renderToolsDoc(categorized);

// The shields.io endpoint JSON behind the "tools" README badge.
const githubDir = join(root, ".github");
const outputs = [[outPath, md]];
if (existsSync(githubDir)) {
  outputs.push([
    join(githubDir, "badges", "tools.json"),
    JSON.stringify({ schemaVersion: 1, label: "tools", message: String(tools.length), color: "blueviolet" }) + "\n",
  ]);
}

const names = (list) => list.map(([path]) => relative(root, path)).join(", ");

if (check) {
  const stale = staleOutputs(outputs, (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined));
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

console.log(`Wrote ${names(outputs)} — ${tools.length} tools across ${new Set(categorized.map((t) => t.category)).size} categories.`);
