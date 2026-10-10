/**
 * The normalized usage model. This is the ONLY shape the webview ever sees.
 *
 * Two deliberately separate measurements (see docs/FEASIBILITY.md §5):
 *   - `context`    : occupancy of the live context window, from the MOST RECENT request only.
 *   - `cumulative` : running per-category totals across the session. Never mixed into `context`.
 *
 * Invariants enforced across this file:
 *   - A missing/unknown number is `null`. It is NEVER coerced to 0.
 *     `null` occupancy means "unknown" (fresh session, or post-/compact before the next
 *     API call); 0 means "verified empty". The faucet renders these differently.
 *   - Percentages are clamped to [0, 100] only for *display*; the raw ratio is kept so a
 *     >100% reading (which real data produced: 285k tokens against an assumed 200k window)
 *     surfaces as a capacity problem instead of being silently flattened.
 */

/** Where a snapshot came from. Shown in the UI at all times. */
export type DataSource =
  | 'statusline'  // Tier B: authoritative, Claude Code pre-calculated the percentage
  | 'transcript'  // Tier A: derived from the session JSONL; percentage is an ESTIMATE
  | 'simulated'   // operator-driven test data. Must always be visibly labelled.
  | 'none';       // nothing observed yet

/** Liveness of the data, judged by timestamp rather than by assuming updates keep arriving. */
export type Freshness = 'live' | 'stale' | 'idle' | 'unknown';

/** Claude Code session lifecycle, as far as the active integration can tell. */
export type Lifecycle = 'new' | 'active' | 'resumed' | 'compacted' | 'ended' | 'unknown';

/** Occupancy of the live context window. */
export interface ContextState {
  /** Prompt tokens in the most recent request: input + cache_creation + cache_read. */
  tokens: number | null;
  /** Window capacity. Only ever set from an authoritative source; never hardcoded. */
  capacity: number | null;
  /** Raw ratio (0..1+, may exceed 1 if capacity is wrong/unknown). null = unknown. */
  ratio: number | null;
  /** True when `ratio` was derived rather than read from `context_window.used_percentage`. */
  isEstimate: boolean;
}

/**
 * Cumulative session usage, per category.
 *
 * These are NOT added together into a headline number by default, because
 * `cacheRead` legitimately reached 27.4M in a session whose context was only ~285k
 * (every request re-reads the cached prefix). Any combined figure must state its rule.
 */
export interface CumulativeState {
  /** Fresh, uncached input tokens. */
  freshInput: number;
  /** Tokens written to the prompt cache. */
  cacheCreation: number;
  /** Tokens read from the prompt cache. Grows fast; not a context measure. */
  cacheRead: number;
  /** Generated output tokens. */
  output: number;
  /** Deduped request count (duplicate requestIds are discarded, see §4 Finding 1). */
  requests: number;
}

/** Subagent traffic. Real spend, but NOT part of the main conversation's context window. */
export interface SidechainState {
  promptTokens: number;
  output: number;
  requests: number;
}

/** A context compaction that actually occurred. */
export interface CompactionEvent {
  at: number;
  trigger: 'manual' | 'auto' | 'unknown';
  preTokens: number | null;
  postTokens: number | null;
}

/** The complete snapshot handed to the UI. */
export interface UsageSnapshot {
  sessionId: string | null;
  /** Short display form of the session id. */
  shortId: string | null;
  model: string | null;
  cwd: string | null;

  context: ContextState;
  cumulative: CumulativeState | null;
  sidechain: SidechainState | null;

  compactions: CompactionEvent[];
  /** Tokens dropped by compaction across the session, if the source reports it. */
  droppedTokens: number | null;

  source: DataSource;
  freshness: Freshness;
  lifecycle: Lifecycle;
  /** epoch ms of the last successful observation, or null if never. */
  lastUpdate: number | null;
  /** Operator-facing notes: why data is missing, what is estimated. */
  notes: string[];
}

export function emptyCumulative(): CumulativeState {
  return { freshInput: 0, cacheCreation: 0, cacheRead: 0, output: 0, requests: 0 };
}

export function idleSnapshot(): UsageSnapshot {
  return {
    sessionId: null,
    shortId: null,
    model: null,
    cwd: null,
    context: { tokens: null, capacity: null, ratio: null, isEstimate: false },
    cumulative: null,
    sidechain: null,
    compactions: [],
    droppedTokens: null,
    source: 'none',
    freshness: 'unknown',
    lifecycle: 'unknown',
    lastUpdate: null,
    notes: ['No Claude Code session observed yet.'],
  };
}

export function shortenId(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 8 ? id : id.slice(0, 8);
}

/**
 * Occupancy as a display percentage.
 * Returns null for unknown so callers must handle it explicitly rather than
 * receiving a misleading 0.
 */
export function displayPercent(c: ContextState): number | null {
  if (c.ratio === null || !Number.isFinite(c.ratio)) return null;
  return Math.max(0, Math.min(100, c.ratio * 100));
}

/** True when the reading exceeds the capacity we believe in — a capacity problem, not a full tank. */
export function isOverCapacity(c: ContextState): boolean {
  return c.ratio !== null && Number.isFinite(c.ratio) && c.ratio > 1.0001;
}

/** Judge freshness from elapsed time. Never assumes updates are still arriving. */
export function freshnessFor(
  lastUpdate: number | null,
  staleAfterMs: number,
  now = Date.now(),
): Freshness {
  if (lastUpdate === null) return 'unknown';
  const age = now - lastUpdate;
  if (age < 0) return 'unknown';
  if (age <= staleAfterMs) return 'live';
  if (age <= staleAfterMs * 4) return 'stale';
  return 'idle';
}

/** Clamp + sanitize any externally supplied number. Rejects NaN/Infinity/negatives. */
export function safeCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}
