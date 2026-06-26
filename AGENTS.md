# AGENTS.md

Keep `src/` at 100% test coverage (statements, branches, functions, lines) — every change must leave `npm run coverage` passing at 100%.

Don't write anti-patterns. Prefer generic, reusable helpers over hand-maintained boilerplate that grows per case. If you catch yourself copy-pasting a function for each new command/parser/tool, factor out the shared part instead.
