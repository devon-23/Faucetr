# Stillwell

An ambient pixel faucet for VS Code. It runs clear when your Claude Code context
window is fresh and turns amber, then murky, then near-black as the context fills.

The water is driven by **real observed usage** from your Claude Code session. It does
not drift with elapsed time and it does not move randomly.

> **Status:** Stages 1–3 complete and tested; Stage 4 (Tier A real tracking) implemented
> and verified against live transcripts. Tier B ("exact tracking") is specified but
> **not yet wired** — see [Known limitations](#known-limitations).

---

## Requirements

| | |
|---|---|
| VS Code | 1.90 or newer (developed against **1.140.0**) |
| Claude Code | developed against **2.1.287** |
| Node.js | 18+ to build (developed against **v26.5.0**) |

No API key, no account, no backend, no network access, no telemetry.

## Install and run from source

```bash
npm install && npm run compile
```

Then open this folder in VS Code and press **F5** ("Run Stillwell"). A second VS Code
window opens with the extension loaded. Click the Stillwell icon in the Activity Bar.

To build an installable package:

```bash
npx @vscode/vsce package
```

That produces `stillwell-0.1.0.vsix`, installable via
**Extensions → ⋯ → Install from VSIX**.

## How the tracking works

Claude Code writes a JSONL transcript per session to
`~/.claude/projects/<path-slug>/<session-uuid>.jsonl`, appending as you work.
Stillwell tails that file incrementally and extracts **only** `usage` objects and
envelope metadata.

**It never reads, stores, or transmits message content.**

This needs **zero configuration** — nothing in your Claude Code settings changes.

### Two separate measurements

Stillwell keeps these strictly apart, because conflating them produces nonsense:

**Context occupancy** (drives the water) is the prompt size of the **most recent
request only**: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
This matches how Claude Code itself computes `used_percentage`.

**Cumulative session usage** is a per-category running total across deduplicated
requests. These are *not* summed into one headline number — in a real sampled session
cumulative cache reads reached **27.4 million tokens** while the context held only
**285,152**, because every request re-reads the cached prefix. Adding those together
would be meaningless.

Cumulative figures are **per session**. They are not daily totals, not account-wide
usage, and not billing figures.

### Things verified against real data

- **Deduplication is mandatory.** Streaming writes several envelopes per API call;
  one sampled session had 158 duplicate `requestId`s against 142 real requests.
  Without dedup, cumulative totals roughly double.
- **Context limits must not be hardcoded.** A sampled session reached 285,152 prompt
  tokens and another 339,036 — both far beyond 200k. A fixed 200,000 constant would
  have drawn a 142%-full faucet.
- **Compaction preserves cumulative totals.** A session with two compactions kept all
  1,307 requests of history while the water level dropped.
- **Subagent traffic is separated.** `isSidechain` requests are tracked apart, since
  they are real spend but are not in your main conversation's context window.

## Reading the display

The faucet is the primary readout; exact numbers sit underneath, with a collapsible
details table.

| Indicator | Meaning |
|---|---|
| `transcript · live` | Reading your session file, data is current |
| `· stale` | No update recently; the reading may no longer be current |
| `· idle` | No recent activity at all |
| `SIMULATED` (blue banner) | **Not real data.** Operator-driven test mode |
| `estimate` | The percentage relies on an inferred context-window size |
| `unknown` | Occupancy genuinely unknown — *never* shown as 0% |

`unknown` and `0%` are deliberately different. Claude Code reports no occupancy before
the first API call **and again right after `/compact`**; showing 0% there would claim a
fresh context when the truth is simply unmeasured.

## Commands

| Command | Purpose |
|---|---|
| `Stillwell: Open Faucet Panel` | Larger panel beside your editor |
| `Stillwell: Show Faucet in Sidebar` | Focus the sidebar view |
| `Stillwell: Pause / Resume Animation` | Stops drawing; **data collection continues** |
| `Stillwell: Simulate Context Usage…` | Test the animation at 0/25/50/75/90/100% |
| `Stillwell: Exit Simulation Mode` | Return to real tracking |
| `Stillwell: Select Claude Code Session…` | Choose which session to follow |
| `Stillwell: Show Tracking Diagnostics` | Full dump of what is and isn't available |
| `Stillwell: Reset Local Statistics…` | Clear local counters (asks first) |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `stillwell.animation.enabled` | `true` | Animate the water |
| `stillwell.animation.respectReducedMotion` | `true` | Honour system reduce-motion |
| `stillwell.staleAfterSeconds` | `180` | When to mark data stale |
| `stillwell.warnAtPercent` | `85` | Low-capacity warning threshold |
| `stillwell.transcriptRoot` | `""` | Override `~/.claude/projects` |
| `stillwell.contextWindowOverride` | `0` | Context size when none is authoritative; `0` infers |

## Verifying it actually tracks

1. Open the Stillwell sidebar with a Claude Code session running in this project.
2. Run `Stillwell: Show Tracking Diagnostics`. Confirm `source: transcript`,
   a real `session`, and a non-zero `context tokens`.
3. Send Claude Code a message. Within a few seconds `context tokens` and `requests`
   should both rise, and the water should darken slightly.
4. Run `/compact` in Claude Code. The water should **lighten smoothly**, while
   `requests` and cumulative totals **keep their values**.

If step 3 does nothing, the transcript may not be where Stillwell expects — check
the `transcript` path in diagnostics.

## Known limitations

1. **The percentage is an estimate.** Tier A cannot read the true context-window
   size, so Stillwell infers it (200k, or 1M once a larger prompt is seen) and labels
   the figure `estimate`. The authoritative value comes from Claude Code's status-line
   integration, which is **not yet wired** — see `docs/FEASIBILITY.md` §7.
2. **One session at a time.** All sessions are discovered and you can pick between
   them, but only the selected one is displayed. Totals are never mixed.
3. **Transcripts lag slightly.** Claude Code writes them asynchronously, so the
   newest turn can appear a moment late.
4. **Cumulative totals are per session**, not daily or account-wide, and not billing.
5. **Compaction detection is verified from recorded transcripts**, but has not yet
   been observed landing live.

## Privacy

- Message content is never read, stored, or transmitted.
- Persisted data: session id, token counters, capacities, timestamps. Nothing else.
- No network access, no telemetry, no API key, no listening ports.
- Webview runs under a strict CSP with nonce'd scripts and no remote origins; it
  receives data by `postMessage` only and cannot execute commands.

## Uninstalling

Stillwell currently changes **nothing** outside its own extension storage — it only
reads files Claude Code already writes. Uninstall the extension and it is fully gone.
No Claude Code settings are modified.

(If Tier B exact tracking is enabled later, it adds a `statusLine` entry to
`~/.claude/settings.json`. Removal is deleting that one key. You will be shown the
exact change and asked before anything is written.)

## Development

```bash
npm run compile     # build
npm run watch       # rebuild on change
npm test            # 55 tests: collector, capacity, activation
```

`devharness/` holds a browser-based harness for iterating on the animation without
launching an extension host (`sheet.html` renders all occupancy levels side by side).

## Project layout

```
src/model/usage.ts         normalized data model (the UI contract)
src/collector/transcript.ts  Tier A JSONL reader: dedup, compaction, sidechains
src/collector/capacity.ts    context-window capacity resolution ladder
src/collector/supervisor.ts  session selection, watching, snapshot emission
src/webview.ts             CSP-locked webview host
src/extension.ts           activation and commands
media/sim.js               falling-sand pixel faucet
media/main.js              webview controller (renders, never computes)
docs/FEASIBILITY.md        Stage 1 technical report
```
