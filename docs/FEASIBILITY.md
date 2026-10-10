# STILLWELL — Stage 1 Technical Feasibility Report

**Date:** 2026-10-09
**Verified against:** Claude Code `2.1.287`, Node `v26.5.0`, macOS (Darwin 24.0.0)
**Status:** Discovery complete. No tracking code written yet.

Every claim below is tagged:
- **[VERIFIED]** — I ran it against real local data or quoted current official docs.
- **[DOCUMENTED]** — Official docs state it; I have not yet exercised it end to end.
- **[ASSUMPTION]** — Inference. Must be proven in Stage 4 before being relied on.

---

## 1. Executive summary

Real context-usage tracking is **feasible**, and better than I expected going in: Claude Code
*pre-calculates* the context-window percentage and hands it to a status-line command. There is also a
completely zero-configuration fallback — the session transcript on disk — that yields token counts
without the user changing a single setting.

The recommendation is a **two-tier collector**:

| Tier | Source | Config needed | Gives us |
|---|---|---|---|
| **A — Transcript reader** (default, always on) | `~/.claude/projects/<slug>/<session>.jsonl` | **None** | Cumulative tokens, per-request prompt size, compaction events, session list, model |
| **B — Status-line bridge** (opt-in, recommended) | Claude Code `statusLine` command → stdin JSON | One additive settings entry, reversible | **Authoritative `used_percentage`**, true `context_window_size`, cost, cache health |

Tier A makes the extension work the moment it is installed. Tier B upgrades the percentage from
*estimated* to *authoritative*. The UI will always state which tier is live.

**The one blocker needing your decision** is whether I may add a status-line entry to your Claude Code
settings. Details and exact diff in §7.

---

## 2. What I actually inspected, and why

| What | Why | Result |
|---|---|---|
| `claude --version` | Pin minimum version claims | `2.1.287` **[VERIFIED]** |
| Official status-line reference | Primary candidate data source | Full stdin schema recovered **[VERIFIED]** |
| Official hooks reference | Session/compaction lifecycle | Event list + `SessionStart` schema **[VERIFIED]** |
| `~/.claude/settings.json` | Check for an existing status line I must not clobber | **No `statusLine` key present** — adding one is purely additive **[VERIFIED]** |
| `~/.claude/projects/*/*.jsonl` structure | Fallback source viability | Confirmed; shapes below **[VERIFIED]** |

I read transcript **structure only** — JSON keys, `usage` objects, timestamps, IDs. I did not read, and
the extension will never store, message content. See §8.

---

## 3. Source A — the status-line command (authoritative)

Claude Code runs a shell command you configure and pipes session JSON to **stdin**. The relevant slice,
quoted from the current official reference **[VERIFIED]**:

```json
{
  "session_id": "abc123...",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "model": { "id": "claude-opus-5-5", "display_name": "Opus" },
  "version": "2.1.90",
  "cost": {
    "total_cost_usd": 0.01234,
    "total_duration_ms": 45000,
    "total_api_duration_ms": 2300
  },
  "context_window": {
    "total_input_tokens": 15500,
    "total_output_tokens": 1200,
    "context_window_size": 200000,
    "used_percentage": 8,
    "remaining_percentage": 92,
    "current_usage": {
      "input_tokens": 8500,
      "output_tokens": 1200,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 2000
    }
  },
  "exceeds_200k_tokens": false
}
```

### Field-by-field verdict

| Field | Obtainable? | Notes |
|---|---|---|
| `context_window.used_percentage` | **Yes — authoritative** | Pre-calculated by Claude Code. **This drives the faucet.** |
| `context_window.context_window_size` | **Yes** | `200000`, or `1000000` on extended-context models. **Never hardcode.** |
| `context_window.current_usage.*` | Yes | Per-category breakdown of the *current* prompt |
| `session_id`, `transcript_path`, `cwd` | Yes | Session identity + links Tier B to Tier A |
| `model.id` / `display_name` | Yes | Display + capacity context |
| `cost.total_cost_usd` | Yes | **Client-side estimate at list price**, not a bill. Label as such. |
| **Cumulative session tokens** | **NO** | *Not available here.* See the trap in §5. |

### Documented semantics that constrain the design **[VERIFIED — quoted]**

> `used_percentage` field is calculated from input tokens only:
> `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. It does not include `output_tokens`.

So when Tier A estimates a percentage, it **must use the same input-only formula** or the two tiers
would disagree.

> `context_window.current_usage`: `null` before the first API call in a session, and again after
> `/compact` until the next API call repopulates it

> `context_window.used_percentage`, `remaining_percentage`: may be `null` early in the session

**This kills the naive "null → 0%" shortcut.** A fresh session and a post-compact session both report
`null`, and 0% is a *lie* in the second case. The model needs an explicit `unknown` occupancy state,
distinct from "0% / clear water".

### Update cadence **[VERIFIED — quoted]**

> Claude Code debounces updates at 300ms... If a new update triggers while your script is still
> running, Claude Code cancels the in-flight script.

Event-driven, 300 ms debounce, **and in-flight runs get cancelled**. Consequences for the bridge script:
it must be *fast* (single read, single atomic write, no network, no `git`), and it must tolerate being
killed mid-run — hence atomic `write-temp + rename`, never in-place mutation. Triggers go quiet while
the session idles, so freshness must be judged by timestamp, not by assuming updates keep arriving.

---

## 4. Source B — the transcript JSONL (zero-config fallback)

Path: `~/.claude/projects/<path-slug>/<session-uuid>.jsonl`, appended live.
**[VERIFIED]** — this session's file was already 333 KB and growing while I worked.

A real `usage` object I pulled from this very session **[VERIFIED]**:

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 4437,
  "cache_read_input_tokens": 64787,
  "output_tokens": 971,
  "output_tokens_details": { "thinking_tokens": 35 },
  "cache_creation": { "ephemeral_1h_input_tokens": 4437, "ephemeral_5m_input_tokens": 0 },
  "service_tier": "standard"
}
```

Envelope fields that matter: `sessionId`, `requestId`, `uuid`, `timestamp`, `type`, `isSidechain`,
`message.model`, `cwd`, `gitBranch`, `version`.

### Three findings that materially shaped the architecture

**Finding 1 — duplicate `requestId`s are rampant. [VERIFIED]**
Replaying one real 142-request session: **158 duplicate `requestId` entries** against 142 unique
requests. Streaming writes multiple envelopes per API call. Summing naively would have **over-reported
cumulative usage by roughly 2×**. Dedupe by `requestId` is mandatory, not defensive polish.
(All 300 usage entries carried a `requestId`; zero were missing.)

**Finding 2 — a 200 000 constant would already be wrong. [VERIFIED]**
In that same session the final prompt measured **285 152 tokens**, climbing monotonically with no
compaction. That is **142% of 200k** — a >200k (extended-context) window. Any hardcoded limit would have
shown a nonsensical 142%-full faucet. `context_window_size` must come from the data.

**Finding 3 — compaction is recorded, with rich metadata. [VERIFIED]**
A `type: "system"` entry carries:

```json
{
  "trigger": "manual",
  "preTokens": 816891,
  "postTokens": 16108,
  "durationMs": 146386,
  "cumulativeDroppedTokens": 800783
}
```

Paired with a `type: "user"` entry flagged `isCompactSummary: true`. `trigger` is `manual` or `auto`;
`cumulativeDroppedTokens` survives across multiple compactions. This is exactly the signal needed to
drop the water level smoothly instead of guessing from a token cliff — and to prove a drop was a
*compaction*, not a data glitch.

**Also verified:** file order matches timestamp order, so a simple incremental tail is safe.

### Tier A's honest limitation

The transcript gives tokens but **not** `context_window_size`. Finding 2 shows the model ID alone does
not settle it. So Tier A reports occupancy as an **estimate** and the UI says so. Tier B is what makes
the percentage exact. I will not dress an estimate up as a precise number.

---

## 5. Cumulative usage: the double-counting trap

The brief warned about this, and real data shows the trap is severe. Same 142-request session, deduped
**[VERIFIED]**:

| Category | Total |
|---|---|
| Fresh `input_tokens` | 308 |
| `cache_creation_input_tokens` | 467 559 |
| `cache_read_input_tokens` | **27 402 813** |
| `output_tokens` | 142 467 |

Cache reads sum to **27.4 million** — because every request re-reads the whole cached prefix. That
number is a legitimate *cumulative API* figure, but presenting it as "tokens used" or adding it toward a
context total would be grossly misleading: the context itself was only ~285k.

**Therefore the data model keeps these strictly separate:**
- **Context occupancy** = `input + cache_creation + cache_read` of the **single most recent** request (never summed across requests).
- **Cumulative session usage** = per-category running totals across deduped requests, each labelled, with the summing rule shown in the UI.
- **Sidechain (subagent) traffic** is tracked separately via `isSidechain` — it is real spend but is *not* in your main conversation's context window.

---

## 6. Lifecycle events available **[DOCUMENTED]**

`SessionStart` fires with `source` ∈ `startup` | `resume` | `clear` | `compact` | `fork`. This directly
answers the brief's concern that session-start ≠ new session. On `resume`/`fork` it additionally carries
**`context_tokens`**, `seconds_since_last_response`, and `prompt_cache_likely_expired` — enough to
restore the faucet to the right level immediately on resume rather than starting falsely clear.

Also available: `PreCompact` / `PostCompact` (matcher `manual` | `auto`), and `SessionEnd`
(`clear` | `resume` | `logout` | `prompt_input_exit` | `other`).

Hooks are a **Stage 5** refinement. Tiers A and B already cover the core metrics, and I would rather not
ask you to install hooks until they earn their place. Note the documented caveat that the transcript
"is written asynchronously and may lag the in-memory conversation."

---

## 7. The one thing I need your decision on

Tier B needs a status-line entry in `~/.claude/settings.json`. Your file currently has **`theme` and
`autoMode` only — no `statusLine`** **[VERIFIED]**, so this is purely additive.

Proposed addition, nothing else touched:

```json
"statusLine": {
  "type": "command",
  "command": "~/.claude/stillwell-bridge.sh"
}
```

The bridge script would: read stdin, pick out the documented fields, write one small JSON file to the
extension's private storage via temp-file + atomic rename, and print a status line. No network, no
secrets, no dependency on the extension running.

**Two honest trade-offs.** It occupies the single `statusLine` slot (Claude Code allows one), so if you
later want a different status line we would merge them rather than fight. And a custom status line
suppresses some built-in footer keyboard hints — that is Claude Code's documented behavior, not
something I introduce.

**Removal** is deleting that one key and the script. I would back up `settings.json` first and never
write a key I did not add.

Your options, in the order I would pick them:
1. **Hybrid (recommended)** — ship Tier A now, offer Tier B via an explicit in-extension "Enable exact tracking" button you press, showing the diff first.
2. **Tier A only** — zero config forever; percentage stays labelled an estimate.
3. **Tier B now** — I write the bridge and settings entry during Stage 4.

---

## 8. Privacy posture

- Transcripts are parsed **streaming, for `usage` objects and envelope metadata only**. Message content
  is never extracted, persisted, or sent to the webview.
- Persisted state: session IDs, token counters, capacities, timestamps, source tier. No prompts, no code,
  no file contents.
- No network calls, no telemetry, no API key, no listening ports.
- Webview locked down: strict CSP, nonce'd scripts, `localResourceRoots` confined to the bundle,
  no `enableCommandUris`. Data flows extension → webview one way; the webview cannot run commands.
- All external JSON treated as hostile: schema-validated, range-clamped, missing ≠ zero.

---

## 9. Known limitations, stated up front

1. Tier-A percentage is an **estimate** until Tier B supplies `context_window_size`.
2. `used_percentage` is `null` before the first API call and after `/compact` — rendered as **unknown**, never 0%.
3. `cost.total_cost_usd` is a **client-side list-price estimate**, not your actual bill.
4. Only **one** status line slot exists, so Tier B is exclusive.
5. Session totals are **per session** — not daily, not account-wide, not billing. The UI will say so.
6. Status-line triggers go quiet while idle; freshness is judged by timestamp, with a stale state after a threshold.
7. Multiple concurrent sessions: v1 discovers all and lets you **pick** which one the faucet shows, clearly labelled.
8. Compaction detection via `compactMetadata` is **[VERIFIED]** as present in transcripts, but I have not yet watched one land live — Stage 5.

## 10. Verification still owed

- [ ] Status-line bridge receives real stdin JSON in a live session (needs §7 consent)
- [ ] Tier A and Tier B percentages agree within rounding on the same session
- [ ] A live compaction lowers the water without zeroing cumulative totals
- [ ] Resume restores totals rather than starting a phantom session
- [ ] Idle → stale transition fires correctly
