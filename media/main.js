/* Webview controller. Receives normalized snapshots and drives the faucet.
   It never computes a usage figure of its own. */
'use strict';
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('faucet');
  const faucet = new Faucet(canvas);

  let paused = false;
  let calm = false;
  let snap = null;

  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat();

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotion = () => { calm = reduce.matches; faucet.calm = calm; };
  applyMotion();
  reduce.addEventListener?.('change', applyMotion);

  function fmt(n) { return n === null || n === undefined ? null : nf.format(n); }

  function row(k, v) {
    const na = v === null || v === undefined;
    return `<tr><td class="k">${k}</td><td class="v${na ? ' na' : ''}">${na ? 'unavailable' : v}</td></tr>`;
  }

  function render(s) {
    snap = s;
    const c = s.context;
    const pctEl = $('pct');
    const known = c.ratio !== null && c.ratio !== undefined;

    // `null` ratio means UNKNOWN, never 0%. Rendering it as 0 would claim a fresh
    // context right after a compaction, which is exactly backwards.
    if (known) {
      const p = Math.max(0, Math.min(100, c.ratio * 100));
      pctEl.textContent = p.toFixed(p < 10 ? 1 : 0) + '%';
      pctEl.className = '';
    } else {
      pctEl.textContent = 'unknown';
      pctEl.className = 'unknown';
    }

    $('sub').textContent = c.tokens !== null
      ? fmt(c.tokens) + (c.capacity ? ' / ' + fmt(c.capacity) : '') + ' tok'
      : 'no usage observed';
    $('est').textContent = known && c.isEstimate ? 'estimate' : '';

    const srcLabel = {
      statusline: 'exact tracking', transcript: 'transcript', simulated: 'SIMULATED', none: 'no source',
    }[s.source] || s.source;
    const freshLabel = { live: 'live', stale: 'stale', idle: 'idle', unknown: '—' }[s.freshness] || '—';
    const dotCls = s.source === 'simulated' ? 'sim'
      : s.source === 'none' ? 'none' : s.freshness;
    $('status').innerHTML =
      `<span class="dot ${dotCls}"></span><span>${srcLabel} · ${freshLabel}` +
      (s.shortId ? ' · ' + s.shortId : '') + '</span>';

    // Banner priority: simulation is the loudest, because mistaking fake data for
    // real is the worst failure this UI can have.
    const b = $('banner');
    const warnAt = (s.warnAtPercent ?? 85) / 100;
    if (s.source === 'simulated') { b.hidden = false; b.className = 'sim'; b.textContent = 'simulated data'; }
    else if (s.freshness === 'stale' || s.freshness === 'idle') {
      b.hidden = false; b.className = 'stale';
      b.textContent = s.freshness === 'stale' ? 'data may be stale' : 'no recent activity';
    } else if (known && c.ratio >= warnAt) {
      b.hidden = false; b.className = 'warn'; b.textContent = 'context capacity low';
    } else { b.hidden = true; }

    const cu = s.cumulative;
    const sc = s.sidechain;
    $('tbl').innerHTML =
      row('session', s.shortId || null) +
      row('model', s.model || null) +
      row('context tokens', fmt(c.tokens)) +
      row('window', c.capacity ? fmt(c.capacity) + (c.isEstimate ? ' (est)' : '') : null) +
      `<tr><td colspan="2" class="sec">cumulative · this session</td></tr>` +
      row('requests', cu ? fmt(cu.requests) : null) +
      row('input (fresh)', cu ? fmt(cu.freshInput) : null) +
      row('output', cu ? fmt(cu.output) : null) +
      row('cache write', cu ? fmt(cu.cacheCreation) : null) +
      row('cache read', cu ? fmt(cu.cacheRead) : null) +
      (sc ? `<tr><td colspan="2" class="sec">subagents</td></tr>` +
            row('requests', fmt(sc.requests)) +
            row('prompt tokens', fmt(sc.promptTokens)) +
            row('output', fmt(sc.output)) : '') +
      (s.compactions && s.compactions.length
        ? `<tr><td colspan="2" class="sec">compaction</td></tr>` +
          row('events', fmt(s.compactions.length)) +
          row('tokens dropped', fmt(s.droppedTokens))
        : '');

    $('notes').innerHTML = (s.notes || []).map((n) => `<div>${esc(n)}</div>`).join('');

    faucet.setUsage({
      ratio: known ? c.ratio : 0,
      known,
      flowing: known && s.freshness !== 'idle',
      warn: known && c.ratio >= warnAt,
    });
  }

  function esc(t) {
    return String(t).replace(/[&<>"]/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  $('toggle').addEventListener('click', () => {
    const d = $('details');
    const open = d.classList.toggle('open');
    $('toggle').textContent = open ? '▾ hide details' : '▸ details';
    vscode.setState({ open });
  });

  const saved = vscode.getState();
  if (saved && saved.open) { $('details').classList.add('open'); $('toggle').textContent = '▾ hide details'; }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'snapshot') render(m.payload);
    else if (m.type === 'paused') paused = m.value;
    else if (m.type === 'clearWater') faucet.clearWater();
  });

  let lastT = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    // ~30fps for the sim: the automaton looks right at that rate and it keeps the
    // webview cheap enough to leave open all day.
    const interval = calm ? 100 : 33;
    if (ts - lastT < interval) return;
    lastT = ts;
    if (!paused) faucet.step();
    faucet.render(!snap || snap.source === 'none' || snap.freshness === 'idle');
  }
  requestAnimationFrame(loop);

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => faucet.resize(), 120);
  });

  vscode.postMessage({ type: 'ready' });
})();
