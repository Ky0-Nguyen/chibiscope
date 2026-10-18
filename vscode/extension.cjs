// VS Code / Cursor / Windsurf extension: hosts the ChibiScope server inside the
// editor and shows the live map in a webview panel.

const vscode = require('vscode');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

let server = null;
let panel = null;
let output = null;

function cfg() {
  const c = vscode.workspace.getConfiguration('chibiscope');
  return { port: c.get('port', 4777), autoStart: c.get('autoStart', true), watchCodex: c.get('watchCodex', true) };
}

/** Start the server in this editor unless one is already listening on the port. */
async function ensureServer() {
  const { port, watchCodex } = cfg();
  const mod = await load('src/server.js');
  if (server) return port;
  if (await mod.probe(port)) return port; // another window / the CLI owns it
  try {
    server = await mod.startServer({ port, codex: watchCodex, log: (m) => output.appendLine(m) });
    output.appendLine(`ChibiScope server listening on ${server.url}`);
  } catch (e) {
    if (e.code === 'EADDRINUSE' && (await mod.probe(port))) return port;
    throw e;
  }
  return port;
}

async function openPanel(query = '') {
  const port = await ensureServer();
  const local = vscode.Uri.parse(`http://127.0.0.1:${port}/${query}`);
  const external = await vscode.env.asExternalUri(local);
  const src = external.toString(true);
  const origin = `${external.scheme}://${external.authority}`;
  if (!panel) {
    panel = vscode.window.createWebviewPanel('chibiscope', 'ChibiScope', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      portMapping: [{ webviewPort: port, extensionHostPort: port }],
    });
    panel.iconPath = vscode.Uri.file(path.join(root, 'web', 'favicon.svg'));
    panel.onDidDispose(() => { panel = null; });
  } else {
    panel.reveal(undefined, true);
  }
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin} http://127.0.0.1:${port} http://localhost:${port}; style-src 'unsafe-inline';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
</head><body><iframe src="${src}" allow="clipboard-write"></iframe></body></html>`;
}

async function installHooks(target) {
  const { install, claudeSettingsPath, cursorHooksPath } = await load('src/install.js');
  const file = target === 'claude' ? claudeSettingsPath() : cursorHooksPath();
  const pickedLabel = 'Add hooks';
  const ok = await vscode.window.showInformationMessage(
    `ChibiScope will add observe-only, non-blocking hooks to ${file} (a .chibiscope.bak backup is kept). Continue?`,
    { modal: true },
    pickedLabel,
  );
  if (ok !== pickedLabel) return;
  try {
    const r = install(target);
    vscode.window.showInformationMessage(`ChibiScope hooks added to ${r.file}.${target === 'cursor' ? ' Reload Cursor to pick them up.' : ''}`);
  } catch (e) {
    vscode.window.showErrorMessage(`ChibiScope: ${e.message}`);
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('ChibiScope');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.text = '$(eye) ChibiScope';
  status.tooltip = 'Open the live agent map';
  status.command = 'chibiscope.open';
  status.show();

  const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { vscode.window.showErrorMessage(`ChibiScope: ${e.message}`); } };
  context.subscriptions.push(
    output,
    status,
    vscode.commands.registerCommand('chibiscope.open', run(() => openPanel())),
    vscode.commands.registerCommand('chibiscope.demo', run(() => openPanel('?demo'))),
    vscode.commands.registerCommand('chibiscope.openBrowser', run(async () => {
      const port = await ensureServer();
      await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
    })),
    vscode.commands.registerCommand('chibiscope.installClaude', run(() => installHooks('claude'))),
    vscode.commands.registerCommand('chibiscope.installCursor', run(() => installHooks('cursor'))),
    { dispose: () => { server?.close(); server = null; } },
  );

  if (cfg().autoStart) ensureServer().catch((e) => output.appendLine(`autostart failed: ${e.message}`));
}

function deactivate() {
  return server?.close();
}

module.exports = { activate, deactivate };
