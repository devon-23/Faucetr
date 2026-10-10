import * as vscode from 'vscode';
import { UsageSnapshot } from './model/usage';

/** Builds the locked-down webview HTML. */
export function renderHtml(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = makeNonce();
  const uri = (...p: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(root, ...p)).toString();

  // CSP: no inline script, no remote anything, styles and images confined to the
  // bundle. The webview receives data by postMessage only and cannot run commands.
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('media', 'style.css')}">
<title>Stillwell</title>
</head>
<body>
  <div id="stage">
    <canvas id="faucet"></canvas>
    <div id="banner" hidden></div>
  </div>
  <div id="readout">
    <div class="head">
      <span id="pct" class="unknown">unknown</span>
      <span id="sub"></span>
      <span id="est"></span>
    </div>
    <div id="status"></div>
    <button id="toggle">&#9656; details</button>
    <div id="details">
      <table id="tbl"></table>
      <div id="notes"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${uri('media', 'sim.js')}"></script>
  <script nonce="${nonce}" src="${uri('media', 'main.js')}"></script>
</body>
</html>`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** Shared behaviour for both the sidebar view and the standalone panel. */
export class FaucetHost {
  constructor(
    private readonly webview: vscode.Webview,
    extUri: vscode.Uri,
    private readonly getSnapshot: () => UsageSnapshot,
    private readonly warnAt: () => number,
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')],
    };
    webview.html = renderHtml(webview, extUri);
    webview.onDidReceiveMessage((m) => {
      if (m?.type === 'ready') this.push(this.getSnapshot());
    });
  }

  push(s: UsageSnapshot): void {
    void this.webview.postMessage({
      type: 'snapshot',
      payload: { ...s, warnAtPercent: this.warnAt() },
    });
  }

  setPaused(v: boolean): void { void this.webview.postMessage({ type: 'paused', value: v }); }
  clearWater(): void { void this.webview.postMessage({ type: 'clearWater' }); }
}
