/**
 * Resolving the context-window capacity.
 *
 * This is the one metric Tier A genuinely cannot read. Real data proves it must
 * not be guessed from the model id: a sampled `claude-opus-5` session reached
 * 285,152 prompt tokens, and another 339,036 — both far past 200k. Hardcoding
 * 200000 would have rendered a 142%-full faucet.
 *
 * So capacity is resolved through an explicit ladder, and every rung except the
 * first is reported as an ESTIMATE so the UI can say so.
 */

export type CapacitySource = 'authoritative' | 'override' | 'inferred' | 'unknown';

export interface Capacity {
  tokens: number | null;
  source: CapacitySource;
  /** True unless the value came from Claude Code itself. */
  isEstimate: boolean;
  note: string;
}

/** Known window tiers, smallest first. Used only for inference. */
const TIERS = [200_000, 1_000_000];

export function resolveCapacity(opts: {
  /** From statusline `context_window.context_window_size`. Trusted absolutely. */
  authoritative?: number | null;
  /** User setting. 0/undefined means "infer". */
  override?: number | null;
  /** Largest prompt size observed in this session so far. */
  observedPeak?: number | null;
}): Capacity {
  const auth = num(opts.authoritative);
  if (auth !== null) {
    return {
      tokens: auth,
      source: 'authoritative',
      isEstimate: false,
      note: 'Reported by Claude Code.',
    };
  }

  const over = num(opts.override);
  if (over !== null) {
    return {
      tokens: over,
      source: 'override',
      isEstimate: true,
      note: 'From your stillwell.contextWindowOverride setting.',
    };
  }

  const peak = num(opts.observedPeak);
  if (peak === null) {
    return {
      tokens: null,
      source: 'unknown',
      isEstimate: true,
      note: 'No usage observed yet, so the window size is unknown.',
    };
  }

  // Smallest tier that actually contains what we have seen. No headroom margin:
  // an earlier 0.995 fudge pushed a legitimate 199,500-token reading (99.75% of a
  // 200k window) up to the 1M tier, which is the opposite of what it was for.
  // A prompt only rules out a tier by genuinely exceeding it.
  const tier = TIERS.find((t) => peak <= t) ?? TIERS[TIERS.length - 1];
  return {
    tokens: tier,
    source: 'inferred',
    isEstimate: true,
    note:
      `Inferred ${fmt(tier)} because the largest prompt seen was ${fmt(peak)}. ` +
      'Enable exact tracking for the real figure.',
  };
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.floor(v);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
