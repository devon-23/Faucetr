import * as vscode from 'vscode';
import { Supervisor } from './collector/supervisor';
import { FaucetHost } from './webview';
import { UsageSnapshot } from './model/usage';

let supervisor: Supervisor;
const hosts = new Set<FaucetHost>();
let paused = false;

function warnAt(): number {
  return vscode.workspace.getConfiguration('stillwell').get<number>('warnAtPercent') ?? 85;
}

class FaucetViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extUri: vscode.Uri) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    const host = new FaucetHost(view.webview, this.extUri, () => supervisor.snapshot, warnAt);
    hosts.add(host);
    host.setPaused(paused);
    view.onDidDispose(() => hosts.delete(host));
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  supervisor = new Supervisor(ctx);
  ctx.subscriptions.push(supervisor);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('stillwell.faucet', new FaucetViewProvider(ctx.extensionUri), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  supervisor.onSnapshot((s: UsageSnapshot) => { for (const h of hosts) h.push(s); });

  const cmd = (id: string, fn: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('stillwell.focusView', () => vscode.commands.executeCommand('stillwell.faucet.focus'));

  cmd('stillwell.openPanel', () => {
    const panel = vscode.window.createWebviewPanel(
      'stillwell.panel', 'Stillwell', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const host = new FaucetHost(panel.webview, ctx.extensionUri, () => supervisor.snapshot, warnAt);
    hosts.add(host);
    host.setPaused(paused);
    panel.onDidDispose(() => hosts.delete(host));
  });

  cmd('stillwell.toggleAnimation', () => {
    paused = !paused;
    for (const h of hosts) h.setPaused(paused);
    // Collection is untouched: pausing only stops drawing.
    vscode.window.setStatusBarMessage(
      `Stillwell: animation ${paused ? 'paused' : 'resumed'} (data collection continues)`, 3000);
  });

  cmd('stillwell.simulate', async () => {
    const picks = ['0', '25', '50', '75', '90', '100'];
    const choice = await vscode.window.showQuickPick(
      [...picks.map((p) => ({ label: `${p}%`, value: Number(p) })),
       { label: 'Custom…', value: -1 }],
      { title: 'Simulate context occupancy (clearly labelled as simulated)' },
    );
    if (!choice) return;
    let pct = choice.value;
    if (pct === -1) {
      const raw = await vscode.window.showInputBox({
        prompt: 'Simulated context occupancy, 0–100',
        validateInput: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 && n <= 100 ? null : 'Enter a number between 0 and 100';
        },
      });
      if (raw === undefined) return;
      pct = Number(raw);
    }
    supervisor.setSimulation(pct);
    vscode.window.showInformationMessage(
      `Stillwell is showing SIMULATED data at ${pct}%. Run “Exit Simulation Mode” to return to real tracking.`);
  });

  cmd('stillwell.exitSimulation', () => {
    supervisor.setSimulation(null);
    vscode.window.setStatusBarMessage('Stillwell: back to real tracking', 3000);
  });

  cmd('stillwell.selectSession', async () => {
    const sessions = await supervisor.listAvailableSessions();
    if (sessions.length === 0) {
      vscode.window.showWarningMessage('Stillwell: no Claude Code sessions found.');
      return;
    }
    const items = [
      { label: '$(sync) Follow the most relevant session automatically', id: '' },
      ...sessions.map((s) => ({
        label: s.sessionId.slice(0, 8),
        description: `${(s.sizeBytes / 1024).toFixed(0)}KB · ${new Date(s.mtimeMs).toLocaleString()}`,
        detail: s.slug,
        id: s.sessionId,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Stillwell: which Claude Code session should the faucet follow?',
    });
    if (!pick) return;
    if (pick.id === '') await supervisor.unpinSession();
    else await supervisor.pickSession(pick.id);
    for (const h of hosts) h.clearWater();
  });

  cmd('stillwell.diagnostics', async () => {
    const s = supervisor.snapshot;
    const sess = supervisor.activeSession;
    const lines = [
      '# Stillwell diagnostics',
      '',
      `source            : ${s.source}`,
      `freshness         : ${s.freshness}`,
      `lifecycle         : ${s.lifecycle}`,
      `simulating        : ${supervisor.isSimulating}`,
      `session           : ${s.sessionId ?? 'none'}`,
      `transcript        : ${sess?.file ?? 'none'}`,
      `last update       : ${s.lastUpdate ? new Date(s.lastUpdate).toISOString() : 'never'}`,
      `context tokens    : ${s.context.tokens ?? 'unavailable'}`,
      `context capacity  : ${s.context.capacity ?? 'unavailable'}${s.context.isEstimate ? ' (estimate)' : ''}`,
      `occupancy ratio   : ${s.context.ratio ?? 'unknown'}`,
      `compactions       : ${s.compactions.length}`,
      `dropped tokens    : ${s.droppedTokens ?? 'unavailable'}`,
      '',
      '## cumulative (this session only — not daily, not account-wide, not billing)',
      s.cumulative
        ? [
            `requests      : ${s.cumulative.requests}`,
            `input (fresh) : ${s.cumulative.freshInput}`,
            `output        : ${s.cumulative.output}`,
            `cache write   : ${s.cumulative.cacheCreation}`,
            `cache read    : ${s.cumulative.cacheRead}`,
          ].join('\n')
        : 'unavailable',
      '',
      '## notes',
      ...s.notes.map((n) => `- ${n}`),
    ];
    const doc = await vscode.workspace.openTextDocument({
      content: lines.join('\n'), language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  cmd('stillwell.resetStats', async () => {
    const yes = await vscode.window.showWarningMessage(
      'Reset Stillwell’s local statistics for this session? Cumulative token counts it has accumulated will be lost. Claude Code itself is not affected.',
      { modal: true }, 'Reset');
    if (yes !== 'Reset') return;
    await supervisor.resetStats();
    for (const h of hosts) h.clearWater();
  });

  void supervisor.start();
}

export function deactivate(): void { /* disposables handle teardown */ }
