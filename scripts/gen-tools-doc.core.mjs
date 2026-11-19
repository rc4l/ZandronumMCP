// The pure steps behind gen-tools-doc.mjs, kept apart so the tests can import them.

/** Each tool's category is the last `// --- label ---` above its `register("name"`, `registerTool("name"` or `registerLive("name"` literal. */
export function categorize(source, tools) {
  const lines = source.split("\n");
  const sections = [];
  lines.forEach((text, i) => {
    const m = text.match(/^\s*\/\/ ---+\s*(.*?)\s*-*\s*$/);
    if (m) sections.push({ line: i, label: m[1].replace(/\s*\(.*\)\s*$/, "").trim() });
  });
  const lineOfName = new Map();
  for (const m of source.matchAll(/\b(?:register|registerTool|registerLive)\(\s*"([a-z_]+)"/g)) {
    lineOfName.set(m[1], source.slice(0, m.index).split("\n").length - 1);
  }
  return tools.map((t) => {
    const line = lineOfName.get(t.name);
    if (line === undefined) {
      throw new Error(`No register("${t.name}"/registerLive("${t.name}" literal in src/tools.ts to categorize it.`);
    }
    return { ...t, category: sections.findLast((s) => s.line < line)?.label ?? "General" };
  });
}

/** README.tools.md for categorized tools, categories in first-seen (registration) order. */
export function renderToolsDoc(tools) {
  const byCat = new Map();
  for (const t of tools) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t]);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let md = `# Tools

> **Auto-generated** from \`src/tools.ts\` by \`scripts/gen-tools-doc.mjs\` — do not
> edit by hand; run \`npm run docs:tools\` to regenerate.

The MCP server exposes **${tools.length} tools**. Your agent also discovers them at
runtime via each tool's \`description\`, so this is mainly for browsing.
`;
  for (const [cat, list] of byCat) {
    md += `\n## ${cap(cat)}\n\n`;
    for (const t of list) md += `- **\`${t.name}\`** — ${t.description}\n`;
  }
  return md;
}

/** The `[path, text]` outputs whose file is missing or differs, with CRLF counting as fresh. */
export function staleOutputs(outputs, read) {
  return outputs.filter(([path, text]) => read(path)?.replace(/\r\n/g, "\n") !== text);
}
