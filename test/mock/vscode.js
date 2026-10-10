/* Minimal mock of the VS Code API surface Stillwell actually uses, so activate()
   can be exercised outside an extension host. */
const commands = new Map();
const listeners = [];
let cfg = { warnAtPercent: 85, staleAfterSeconds: 180, transcriptRoot: '', contextWindowOverride: 0 };
const state = new Map();

class EventEmitter {
  constructor(){ this.h=[]; }
  get event(){ return (fn)=>{ this.h.push(fn); return {dispose(){}}; }; }
  fire(v){ for(const f of this.h) f(v); }
  dispose(){ this.h=[]; }
}
module.exports = {
  EventEmitter,
  Uri: { joinPath:(b,...p)=>({fsPath:[b.fsPath,...p].join('/'),toString(){return 'file://'+this.fsPath;}}),
         file:(p)=>({fsPath:p,toString(){return 'file://'+p;}}) },
  ViewColumn: { Beside: 2 },
  workspace: {
    workspaceFolders: [{ uri:{ fsPath: process.cwd() } }],
    getConfiguration: () => ({ get:(k)=>cfg[k] }),
    openTextDocument: async (o)=>({ ...o }),
  },
  window: {
    registerWebviewViewProvider: (id,p)=>{ listeners.push(id); return {dispose(){}}; },
    createWebviewPanel: ()=>({ webview:mockWebview(), onDidDispose(){}, dispose(){} }),
    showQuickPick: async ()=>undefined,
    showInputBox: async ()=>undefined,
    showInformationMessage: async ()=>undefined,
    showWarningMessage: async ()=>undefined,
    showTextDocument: async ()=>({}),
    setStatusBarMessage: ()=>({dispose(){}}),
  },
  commands: {
    registerCommand: (id,fn)=>{ commands.set(id,fn); return {dispose(){}}; },
    executeCommand: async (id,...a)=> commands.has(id)? commands.get(id)(...a) : undefined,
  },
  __test: { commands, views: listeners, state,
            setConfig:(o)=>Object.assign(cfg,o) },
};
function mockWebview(){
  return { options:{}, html:'', cspSource:'vscode-resource:',
           asWebviewUri:(u)=>u, onDidReceiveMessage:()=>({dispose(){}}),
           postMessage: async ()=>true };
}
