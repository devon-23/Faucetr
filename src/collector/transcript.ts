import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CompactionEvent, CumulativeState, SidechainState, UsageSnapshot,
  emptyCumulative, safeCount, shortenId,
} from '../model/usage';

/**
 * Tier A collector: reads Claude Code session transcripts.
 *
 * Zero configuration — it reads files Claude Code already writes to
 * ~/.claude/projects/<path-slug>/<session-uuid>.jsonl.
 *
 * PRIVACY: this parser extracts ONLY `usage` objects, compaction metadata and
 * envelope identifiers. `message.content` is never read, stored or forwarded.
 *
 * Verified behaviours this implementation relies on (docs/FEASIBILITY.md §4):
 *   - Duplicate `requestId`s are common (158 dupes / 142 real requests in a sampled
 *     session). Deduplication is mandatory or cumulative totals roughly double.
 *   - File append order matches timestamp order, so an incremental byte-offset tail is safe.
 *   - Compaction appears as type:"system" with `compactMetadata`
 *     {trigger, preTokens, postTokens, cumulativeDroppedTokens}.
 */

export interface SessionRef {
  sessionId: string;
  file: string;
  slug: string;
  mtimeMs: number;
  sizeBytes: number;
  cwd: string | null;
}

/** Accumulated state for one session file, advanced incrementally. */
interface SessionAccumulator {
  file: string;
  sessionId: string | null;
  offset: number;
  /** Partial trailing line carried across reads (a write may split a JSON line). */
  carry: string;
  seenRequestIds: Set<string>;
  cumulative: CumulativeState;
  sidechain: SidechainState;
  /** Prompt size of the most recent main-chain request = context occupancy. */
  lastContextTokens: number | null;
  lastModel: string | null;
  lastTimestamp: number | null;
  cwd: string | null;
  compactions: CompactionEvent[];
  droppedTokens: number | null;
  /** True once any usage record has been seen. */
  sawUsage: boolean;
}

export function defaultTranscriptRoot(override?: string): string {
  if (override && override.trim()) {
    const o = override.trim();
    return o.startsWith('~') ? path.join(os.homedir(), o.slice(1)) : o;
  }
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Turn an absolute workspace path into Claude Code's directory slug. */
export function slugForPath(p: string): string {
  return p.replace(/[/\\.]/g, '-');
}

/** Discover sessions, newest first. Tolerates a missing or unreadable root. */
export async function listSessions(root: string, limit = 40): Promise<SessionRef[]> {
  let slugs: string[];
  try {
    slugs = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const out: SessionRef[] = [];
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const st = await fsp.stat(path.join(dir, name));
        if (!st.isFile()) continue;
        out.push({
          sessionId: name.replace(/\.jsonl$/, ''),
          file: path.join(dir, name),
          slug,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
          cwd: null,
        });
      } catch {
        /* vanished or permission denied — skip */
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

function newAccumulator(file: string): SessionAccumulator {
  return {
    file,
    sessionId: null,
    offset: 0,
    carry: '',
    seenRequestIds: new Set(),
    cumulative: emptyCumulative(),
    sidechain: { promptTokens: 0, output: 0, requests: 0 },
    lastContextTokens: null,
    lastModel: null,
    lastTimestamp: null,
    cwd: null,
    compactions: [],
    droppedTokens: null,
    sawUsage: false,
  };
}

/**
 * Reads a single transcript incrementally and folds it into normalized state.
 * Call `refresh()` whenever the file changes; it only reads newly appended bytes.
 */
export class TranscriptReader {
  private acc: SessionAccumulator;

  constructor(file: string) {
    this.acc = newAccumulator(file);
  }

  get file(): string {
    return this.acc.file;
  }

  /** Discard all derived state (used on reset / session switch). */
  reset(): void {
    this.acc = newAccumulator(this.acc.file);
  }

  /** Read appended bytes and fold them in. Returns true if anything new was parsed. */
  async refresh(): Promise<boolean> {
    let size: number;
    try {
      const st = await fsp.stat(this.acc.file);
      size = st.size;
    } catch {
      return false;
    }

    // File shrank or was replaced (e.g. /clear rewrote it) — start over honestly
    // rather than reading from a stale offset into the middle of a line.
    if (size < this.acc.offset) {
      const keepFile = this.acc.file;
      this.acc = newAccumulator(keepFile);
    }
    if (size === this.acc.offset) return false;

    const start = this.acc.offset;
    let chunk: string;
    try {
      const fh = await fsp.open(this.acc.file, 'r');
      try {
        const len = size - start;
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, start);
        chunk = buf.subarray(0, bytesRead).toString('utf8');
        this.acc.offset = start + bytesRead;
      } finally {
        await fh.close();
      }
    } catch {
      return false;
    }

    const text = this.acc.carry + chunk;
    const lines = text.split('\n');
    // Last element is either '' (clean newline end) or a partial line to carry.
    this.acc.carry = lines.pop() ?? '';

    let parsedAny = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (this.foldLine(line)) parsedAny = true;
    }
    return parsedAny;
  }

  /** Parse and fold one JSONL line. Malformed lines are skipped silently. */
  private foldLine(line: string): boolean {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return false; // truncated or malformed — not fatal
    }
    if (!o || typeof o !== 'object') return false;

    if (typeof o.sessionId === 'string') this.acc.sessionId = o.sessionId;
    if (typeof o.cwd === 'string') this.acc.cwd = o.cwd;

    // --- Compaction -------------------------------------------------------
    const cm = o.compactMetadata;
    if (cm && typeof cm === 'object') {
      const trig = cm.trigger === 'manual' || cm.trigger === 'auto' ? cm.trigger : 'unknown';
      this.acc.compactions.push({
        at: parseTs(o.timestamp) ?? Date.now(),
        trigger: trig,
        preTokens: safeCount(cm.preTokens),
        postTokens: safeCount(cm.postTokens),
      });
      const dropped = safeCount(cm.cumulativeDroppedTokens);
      if (dropped !== null) this.acc.droppedTokens = dropped;
      // Occupancy right after compaction is authoritative from postTokens until
      // the next API call repopulates it.
      const post = safeCount(cm.postTokens);
      if (post !== null) this.acc.lastContextTokens = post;
      return true;
    }

    // --- Usage ------------------------------------------------------------
    const usage = o.message?.usage;
    if (!usage || typeof usage !== 'object') return false;

    // Dedupe: streaming emits several envelopes per API call.
    const rid = typeof o.requestId === 'string' ? o.requestId : null;
    if (rid) {
      if (this.acc.seenRequestIds.has(rid)) return false;
      this.acc.seenRequestIds.add(rid);
    }

    const fresh = safeCount(usage.input_tokens) ?? 0;
    const cRead = safeCount(usage.cache_read_input_tokens) ?? 0;
    const cCreate = safeCount(usage.cache_creation_input_tokens) ?? 0;
    const out = safeCount(usage.output_tokens) ?? 0;
    const promptTokens = fresh + cRead + cCreate;

    this.acc.sawUsage = true;
    const ts = parseTs(o.timestamp);
    if (ts !== null) this.acc.lastTimestamp = ts;

    if (o.isSidechain === true) {
      // Subagent traffic: real spend, but NOT in the main context window.
      this.acc.sidechain.promptTokens += promptTokens;
      this.acc.sidechain.output += out;
      this.acc.sidechain.requests += 1;
      return true;
    }

    this.acc.cumulative.freshInput += fresh;
    this.acc.cumulative.cacheRead += cRead;
    this.acc.cumulative.cacheCreation += cCreate;
    this.acc.cumulative.output += out;
    this.acc.cumulative.requests += 1;

    // Context occupancy is the MOST RECENT prompt size — never a sum.
    this.acc.lastContextTokens = promptTokens;
    if (typeof o.message?.model === 'string') this.acc.lastModel = o.message.model;
    return true;
  }

  /**
   * Build a snapshot. Capacity is NOT guessed here: Tier A cannot know the real
   * window size (a sampled session legitimately reached 285,152 prompt tokens),
   * so `capacity`/`ratio` stay null unless a caller supplies an authoritative
   * capacity via `knownCapacity`.
   */
  snapshot(knownCapacity: number | null = null): UsageSnapshot {
    const a = this.acc;
    const notes: string[] = [];
    const tokens = a.lastContextTokens;

    let ratio: number | null = null;
    let isEstimate = false;
    if (tokens !== null && knownCapacity !== null && knownCapacity > 0) {
      ratio = tokens / knownCapacity;
      isEstimate = true;
      notes.push('Occupancy estimated from transcript token counts.');
    } else if (tokens !== null) {
      notes.push(
        'Context window size unknown — showing token count only. ' +
          'Enable exact tracking for a true percentage.',
      );
    }

    if (!a.sawUsage) notes.push('No API usage recorded in this transcript yet.');
    if (a.compactions.length > 0) {
      notes.push(
        `${a.compactions.length} compaction${a.compactions.length === 1 ? '' : 's'} observed; ` +
          'cumulative totals intentionally preserved.',
      );
    }

    return {
      sessionId: a.sessionId,
      shortId: shortenId(a.sessionId),
      model: a.lastModel,
      cwd: a.cwd,
      context: { tokens, capacity: knownCapacity, ratio, isEstimate },
      cumulative: a.sawUsage ? { ...a.cumulative } : null,
      sidechain: a.sidechain.requests > 0 ? { ...a.sidechain } : null,
      compactions: [...a.compactions],
      droppedTokens: a.droppedTokens,
      source: 'transcript',
      freshness: 'unknown', // assigned by the supervisor from lastUpdate
      lifecycle: a.compactions.length > 0 ? 'compacted' : a.sawUsage ? 'active' : 'new',
      lastUpdate: a.lastTimestamp,
      notes,
    };
  }
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Watch a file for appends. Falls back to polling when fs.watch is unavailable. */
export function watchFile(file: string, onChange: () => void): { dispose(): void } {
  let watcher: fs.FSWatcher | null = null;
  let poll: NodeJS.Timeout | null = null;

  try {
    watcher = fs.watch(file, { persistent: false }, () => onChange());
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
      poll = setInterval(onChange, 2000);
    });
  } catch {
    poll = setInterval(onChange, 2000);
  }

  return {
    dispose() {
      watcher?.close();
      if (poll) clearInterval(poll);
    },
  };
}
