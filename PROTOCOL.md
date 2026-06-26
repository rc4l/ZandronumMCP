# Bridge protocol (v1)

The single source of truth for the wire contract between the **engine bridge**
(`engine-bridge/overlay/mcp_bridge.cpp`) and the **MCP server** (`src/`).

- **Transport:** loopback TCP, `127.0.0.1` only. Instance _N_ listens on
  `ZANDRONUM_BRIDGE_PORT + (N - 1)`.
- **Framing:** newline-delimited JSON (NDJSON). One JSON object per line.
- **Versioning:** every message carries `"v"`. The client checks the `hello`
  version and refuses to proceed on mismatch. Bump `v` ONLY when this contract
  changes (independent of npm semver and of the engine tag).

## Messages

### engine → MCP

`hello` — sent once, immediately on connect. `caps` lists what the bridge
supports so the client can degrade gracefully:
```json
{"v":1,"t":"hello","engine":"zandronum","bridge":"0.2.0","caps":["cmd","event"]}
```

`out` — one line of console output, streamed asynchronously:
```json
{"v":1,"t":"out","level":0,"text":"Unknown actor 'DoomImp'"}
```

### MCP → engine

`cmd` — a console command to execute:
```json
{"v":1,"t":"cmd","text":"summon DoomImp ; echo __MCPDONE_a1__"}
```

`event` — a raw input event posted via `D_PostEvent` (requires the `event` cap).
Fire-and-forget; the engine sends no reply. Menus read GUI key events
(`evtype=4` EV_GUI_Event, `subtype=1` EV_GUI_KeyDown, `data1=GK_*`):
```json
{"v":1,"t":"event","evtype":4,"subtype":1,"data1":10,"data2":0}
```

## Correlation

The bridge is intentionally dumb — it does not match output to commands. The MCP
server appends `; echo <sentinel>` to each command, then collects every `out`
line until it sees the sentinel echoed back. Because console output is a single
shared stream, **commands must be issued serially per instance.**

The bridge's only job: feed `text` to `AddCommandString`, and mirror every
printed line back as an `out` message. Everything else is the server's problem
(which is exactly why almost all of the code — and the tests — live in TS).
