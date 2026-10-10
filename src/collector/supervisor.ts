import * as vscode from 'vscode';
import {
  SessionRef, TranscriptReader, defaultTranscriptRoot, listSessions, slugForPath, watchFile,
} from './transcript';
import { resolveCapacity } from './capacity';
import { UsageSnapshot, freshnessFor, idleSnapshot } from '../model/usage';

/**
 * Owns data collection and hands the UI a normalized snapshot.
 *
 * The UI never reads a file, never computes a token figure, and never invents a
 * number: whatever this emits is what gets drawn.
 */
export class Supervisor implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<UsageSnapshot>();
  readonly onSnapshot = this.emitter.event;

  private reader: TranscriptReader | null = null;
  private watcher: { dispose(): void } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private current: SessionRef | null = null;
  private pinnedSessionId: string | null = null;

  /** Largest prompt size seen, used only for capacity inference. */
  private observedPeak = 0;

  /** Simulation overrides real data while set. Always visibly labelled. */
  private simulated: number | null = null;

  private last: UsageSnapshot = idleSnapshot();

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.pinnedSessionId = ctx.globalState.get<string>('stillwell.pinnedSession') ?? null;
    this.observedPeak = ctx.globalState.get<number>('stillwell.observedPeak') ?? 0;
  }

  get snapshot(): UsageSnapshot { return this.last; }
  get isSimulating(): boolean { return this.simulated !== null; }
  get activeSession(): SessionRef | null { return this.current; }

  private cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('stillwell').get<T>(key) ?? fallback;
  }

  async start(): Promise<void> {
    await this.pickSession();
    // Re-scan periodically: a brand-new Claude Code session creates a NEW file,
    // which an fs.watch on the old file would never report.
    this.timer = setInterval(() => { void this.tick(); }, 2500);
  }

  /** Choose which session to follow: an explicit pin, else best match for this workspace. */
  async pickSession(explicitId?: string): Promise<void> {
    const root = defaultTranscriptRoot(this.cfg<string>('transcriptRoot', ''));
    const sessions = await listSessions(root);
    if (sessions.length === 0) { this.attach(null); return; }

    let chosen: SessionRef | undefined;
    const wanted = explicitId ?? this.pinnedSessionId;
    if (wanted) chosen = sessions.find((s) => s.sessionId === wanted);

    if (!chosen) {
      // Prefer a session whose directory slug matches an open workspace folder,
      // so the faucet follows the project you are actually in.
      const folders = vscode.workspace.workspaceFolders ?? [];
      for (const f of folders) {
        const slug = slugForPath(f.uri.fsPath);
        const hit = sessions.find((s) => s.slug === slug);
        if (hit) { chosen = hit; break; }
      }
    }
    chosen ??= sessions[0]; // most recently modified
    if (explicitId) {
      this.pinnedSessionId = explicitId;
      await this.ctx.globalState.update('stillwell.pinnedSession', explicitId);
    }
    this.attach(chosen);
  }

  async listAvailableSessions(): Promise<SessionRef[]> {
    return listSessions(defaultTranscriptRoot(this.cfg<string>('transcriptRoot', '')));
  }

  private attach(ref: SessionRef | null): void {
    if (ref && this.current && ref.file === this.current.file) return;
    this.watcher?.dispose();
    this.watcher = null;
    this.current = ref;
    this.reader = ref ? new TranscriptReader(ref.file) : null;
    if (ref) {
      this.watcher = watchFile(ref.file, () => { void this.tick(); });
      void this.tick();
    } else {
      this.publish(idleSnapshot());
    }
  }

  /** Re-read and emit. Safe to call as often as the watcher fires. */
  async tick(): Promise<void> {
    // A newer session may have appeared (new Claude Code session => new file).
    if (!this.pinnedSessionId) {
      const sessions = await this.listAvailableSessions();
      const best = this.bestFor(sessions);
      if (best && (!this.current || best.file !== this.current.file)) {
        // Only switch to a session that is genuinely newer, so a stale file
        // doesn't yank the display away mid-conversation.
        if (!this.current || best.mtimeMs > this.current.mtimeMs + 1000) {
          this.attach(best);
          return;
        }
      }
    }

    if (!this.reader) { this.publish(idleSnapshot()); return; }
    await this.reader.refresh();

    const staleMs = Math.max(15, this.cfg<number>('staleAfterSeconds', 180)) * 1000;
    const base = this.reader.snapshot(null);

    if (base.context.tokens !== null && base.context.tokens > this.observedPeak) {
      this.observedPeak = base.context.tokens;
      void this.ctx.globalState.update('stillwell.observedPeak', this.observedPeak);
    }

    const cap = resolveCapacity({
      authoritative: null, // Tier B not wired yet; see docs/FEASIBILITY.md §7
      override: this.cfg<number>('contextWindowOverride', 0),
      observedPeak: this.observedPeak || base.context.tokens,
    });

    const snap: UsageSnapshot = {
      ...base,
      context: {
        tokens: base.context.tokens,
        capacity: cap.tokens,
        ratio:
          base.context.tokens !== null && cap.tokens
            ? base.context.tokens / cap.tokens
            : null,
        isEstimate: cap.isEstimate,
      },
      freshness: freshnessFor(base.lastUpdate, staleMs),
      notes: [...base.notes, cap.note],
    };

    this.publish(this.applySimulation(snap));
  }

  private bestFor(sessions: SessionRef[]): SessionRef | null {
    if (sessions.length === 0) return null;
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      const slug = slugForPath(f.uri.fsPath);
      const hit = sessions.find((s) => s.slug === slug);
      if (hit) return hit;
    }
    return sessions[0];
  }

  /** Simulation replaces the ratio only, and stamps the source so the UI can label it. */
  private applySimulation(snap: UsageSnapshot): UsageSnapshot {
    if (this.simulated === null) return snap;
    return {
      ...snap,
      context: { ...snap.context, ratio: this.simulated, isEstimate: true },
      source: 'simulated',
      freshness: 'unknown',
      notes: ['SIMULATED DATA — not a real reading.', ...snap.notes],
    };
  }

  setSimulation(pct: number | null): void {
    this.simulated = pct === null ? null : Math.max(0, Math.min(1, pct / 100));
    this.publish(this.applySimulation({ ...this.last, source: this.last.source }));
    void this.tick();
  }

  /** Clear derived statistics for the active session. */
  async resetStats(): Promise<void> {
    this.reader?.reset();
    this.observedPeak = 0;
    await this.ctx.globalState.update('stillwell.observedPeak', 0);
    await this.tick();
  }

  async unpinSession(): Promise<void> {
    this.pinnedSessionId = null;
    await this.ctx.globalState.update('stillwell.pinnedSession', undefined);
    await this.pickSession();
  }

  private publish(s: UsageSnapshot): void {
    this.last = s;
    this.emitter.fire(s);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}
