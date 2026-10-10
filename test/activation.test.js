/* Exercises activate() against a mocked VS Code API: verifies commands register,
   the supervisor starts, and a real snapshot flows without throwing. */
const path = require('path');
const Module = require('module');
const mockPath = path.join(__dirname, 'mock', 'vscode.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'vscode') return mockPath;
  return origResolve.call(this, req, ...rest);
};

const vscode = require('./mock/vscode.js');
const ext = require('../out/extension.js');

let pass=0, fail=0;
const t=(n,c,got)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+'  got: '+JSON.stringify(got));} };

(async () => {
  const subs = [];
  const ctx = {
    subscriptions: subs,
    extensionUri: vscode.Uri.file(path.join(__dirname, '..')),
    globalState: {
      _m: new Map(),
      get(k, d){ return this._m.has(k) ? this._m.get(k) : d; },
      update(k, v){ this._m.set(k, v); return Promise.resolve(); },
    },
  };

  let threw = null;
  try { ext.activate(ctx); } catch (e) { threw = e; }
  t('activate() does not throw', threw === null, threw && threw.message);

  const cmds = vscode.__test.commands;
  const expected = ['stillwell.openPanel','stillwell.focusView','stillwell.toggleAnimation',
    'stillwell.simulate','stillwell.exitSimulation','stillwell.selectSession',
    'stillwell.diagnostics','stillwell.resetStats'];
  for (const c of expected) t('command registered: '+c, cmds.has(c), [...cmds.keys()]);

  t('sidebar view provider registered', vscode.__test.views.includes('stillwell.faucet'), vscode.__test.views);
  t('disposables collected', subs.length >= 2, subs.length);

  // Let the supervisor find and read a real session.
  await new Promise(r => setTimeout(r, 1200));

  // Exercise commands that don't need user input.
  let e2=null; try { await vscode.commands.executeCommand('stillwell.toggleAnimation'); } catch(e){e2=e;}
  t('toggleAnimation runs', e2===null, e2 && e2.message);

  let e3=null; try { await vscode.commands.executeCommand('stillwell.diagnostics'); } catch(e){e3=e;}
  t('diagnostics runs', e3===null, e3 && e3.message);

  let e4=null; try { await vscode.commands.executeCommand('stillwell.exitSimulation'); } catch(e){e4=e;}
  t('exitSimulation runs', e4===null, e4 && e4.message);

  let e5=null; try { await vscode.commands.executeCommand('stillwell.openPanel'); } catch(e){e5=e;}
  t('openPanel runs', e5===null, e5 && e5.message);

  // Teardown must not throw.
  let e6=null; try { for(const d of subs) d.dispose && d.dispose(); ext.deactivate(); } catch(e){e6=e;}
  t('dispose/deactivate clean', e6===null, e6 && e6.message);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail?1:0);
})();
