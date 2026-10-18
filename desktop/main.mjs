// ChibiScope desktop: keeps the local event server alive in the menu bar /
// system tray, shows the agent map in a window, and pings you when an agent
// needs you or finishes a long turn.

import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, shell, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { subscribe } from './lib/feed.mjs';
import { HOOK_HOME, LAUNCHER, hookStatus, installHooks, removeHooks, writeHookFiles } from './lib/hooks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged: server/web/hooks ship as real files in Resources/chibiscope.
const CORE = app.isPackaged ? path.join(process.resourcesPath, 'chibiscope') : path.resolve(here, '..');
const load = (rel) => import(pathToFileURL(path.join(CORE, rel)).href);
const PORT = Number(process.env.CHIBISCOPE_PORT) || 4777;
const BASE = `http://127.0.0.1:${PORT}/`;
const isMac = process.platform === 'darwin';
const hookCtx = { coreDir: CORE, appExe: process.execPath };

let serverMod, installer, S;
let server = null; // set only when this app started the server
let state = null;
let win = null;
let tray = null;
let feed = null;
let quitting = false;
let settings = { notifyWait: true, notifyDone: true };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', (_e, argv) => { if (!applyLoginFlag(argv)) showWindow(); });

// Plain-text log in the profile folder, for "why isn't it working" moments.
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'main.log'), line); } catch { /* read-only profile */ }
}

function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ['--hidden'] });
  const st = app.getLoginItemSettings();
  log(`launch at login ${on ? 'on' : 'off'} -> openAtLogin=${st.openAtLogin} status=${st.status ?? 'n/a'}`);
}

/** `--login-item=on|off` toggles launch-at-login without the menu (scripts, installers). */
function applyLoginFlag(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--login-item='));
  if (!arg || process.platform === 'linux') return false;
  setLogin(arg.endsWith('=on'));
  return true;
}

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch { /* read-only profile */ }
}

/* ------------------------------------------------------------------ server */

let ensuring = null;
function ensureServer() {
  ensuring ||= (async () => {
    if (server || (await serverMod.probe(PORT))) return; // ours, or the CLI / editor's
    try {
      server = await serverMod.startServer({ port: PORT, codex: true, log: (m) => log('[server]', m) });
    } catch (e) {
      if (!(await serverMod.probe(PORT))) throw e;
    }
  })().finally(() => { ensuring = null; });
  return ensuring;
}

/* ------------------------------------------------------------------ window */

function showWindow(sessionId, query = '') {
  if (!win) {
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 820,
      minHeight: 560,
      title: 'ChibiScope',
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a1630' : '#fbf6ef',
      icon: path.join(here, 'assets', 'icon.png'),
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault(); // keep running in the tray
      win.hide();
      if (isMac) app.dock?.hide();
    });
    win.on('closed', () => { win = null; });
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('did-fail-load', () => setTimeout(() => win?.loadURL(BASE), 1200));
    win.once('ready-to-show', () => win.show());
    win.loadURL(BASE + query + (sessionId ? `#session=${encodeURIComponent(sessionId)}` : ''));
  } else if (query) {
    win.loadURL(BASE + query);
  } else if (sessionId) {
    win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('session=' + sessionId)}`).catch(() => {});
  }
  if (isMac) app.dock?.show();
  win.show();
  win.focus();
}

/* ------------------------------------------------------------------ live state + notifications */

const lastPing = new Map();
function notify(ev, s) {
  if (!Notification.isSupported() || ev.meta?.demo) return;
  const m = S.sourceMeta(s.source);
  let title;
  let body;
  if (ev.type === 'wait' && settings.notifyWait) {
    title = `${s.project} needs you`;
    body = ev.text || `${m.name} is waiting for your input`;
  } else if (ev.type === 'turn.end' && settings.notifyDone) {
    const took = s.turn ? ev.ts - s.turn.startedAt : 0;
    if (took < 20000 || win?.isFocused()) return; // quick answers need no ping
    title = ev.ok === false ? `${s.project} stopped with an error` : `${s.project} is done ✨`;
    body = ev.text || `${m.name} finished in ${Math.round(took / 1000)}s`;
  } else {
    return;
  }
  const key = `${s.id}|${ev.type}`;
  if (Date.now() - (lastPing.get(key) || 0) < 8000) return; // PermissionRequest + Notification arrive together
  lastPing.set(key, Date.now());
  if (process.env.CHIBISCOPE_DEBUG) console.log(`[notify] ${title} — ${body}`);
  const n = new Notification({ title, subtitle: m.name, body: body.replace(/\s+/g, ' ').slice(0, 180), silent: ev.type !== 'wait' });
  n.on('click', () => showWindow(s.id));
  n.show();
}

let trayTimer = null;
function scheduleTray() {
  if (trayTimer) return;
  trayTimer = setTimeout(() => { trayTimer = null; updateTray(); }, 400);
}

const MOOD = { working: '🛠', thinking: '💭', waiting: '❗', error: '💦', done: '✨', idle: '·', sleep: '💤', ended: '👋' };

function confirmHooks(target, file) {
  const r = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Connect', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Connect ${target === 'claude' ? 'Claude Code' : 'Cursor'} to ChibiScope?`,
    detail: `Adds observe-only, non-blocking hooks to:\n${file}\n\nYour other hooks stay untouched and a .chibiscope.bak backup is kept. ${target === 'cursor' ? 'Reload Cursor afterwards.' : 'New Claude Code sessions pick them up.'}`,
  });
  return r === 0;
}

function hookItems() {
  let st;
  try { st = hookStatus(installer); } catch { return [{ label: 'Hook status unavailable', enabled: false }]; }
  const item = (target, name) => {
    const s = st[target];
    const how = s.plugin ? '✓ plugin' : s.installed ? '✓ connected' : 'not connected';
    const items = [{ label: `${name} — ${how}`, enabled: false }];
    if (!s.installed) {
      items.push({
        label: `Connect ${name}…`,
        click: () => {
          if (!confirmHooks(target, s.file)) return;
          try { installHooks(installer, target, hookCtx); } catch (e) { dialog.showErrorBox('ChibiScope', e.message); }
          updateTray();
        },
      });
    } else if (!s.plugin) {
      items.push({ label: `Disconnect ${name}`, click: () => { try { removeHooks(installer, target); } catch (e) { dialog.showErrorBox('ChibiScope', e.message); } updateTray(); } });
    }
    return items;
  };
  return [
    ...item('claude', 'Claude Code'),
    { type: 'separator' },
    ...item('cursor', 'Cursor'),
    { type: 'separator' },
    { label: `Codex — ${st.codex.found ? '✓ watching sessions' : 'not found'}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Hooks Folder', click: () => { fs.mkdirSync(HOOK_HOME, { recursive: true }); shell.openPath(HOOK_HOME); } },
  ];
}

function updateTray() {
  if (!tray || !S) return;
  const now = Date.now();
  const live = [...state.sessions.values()].filter((s) => !S.isStale(s, now)).sort((a, b) => b.lastAt - a.lastAt);
  const moods = live.map((s) => S.moodOf(s, now));
  const waiting = moods.filter((m) => m === 'waiting').length;
  const busy = moods.filter((m) => m === 'working' || m === 'thinking').length;
  if (isMac) tray.setTitle(waiting ? ` ❗${waiting}` : busy ? ` ${busy}` : '', { fontType: 'monospacedDigit' });
  tray.setToolTip(live.length ? `ChibiScope — ${live.length} agent${live.length > 1 ? 's' : ''}, ${busy} busy${waiting ? `, ${waiting} need you` : ''}` : 'ChibiScope — no agents running');

  const sessions = live.slice(0, 8).map((s, i) => {
    const text = (s.statusText || s.turn?.prompt || '').replace(/\s+/g, ' ');
    return {
      label: `${MOOD[moods[i]] || '·'}  ${s.project} — ${text.length > 46 ? text.slice(0, 45) + '…' : text || S.sourceMeta(s.source).name}`,
      click: () => showWindow(s.id),
    };
  });
  const login = app.getLoginItemSettings();
  const menu = Menu.buildFromTemplate([
    { label: live.length ? `${live.length} agent${live.length > 1 ? 's' : ''} on the map` : 'No agents running', enabled: false },
    ...sessions,
    { type: 'separator' },
    { label: 'Open Agent Map', accelerator: 'CmdOrCtrl+O', click: () => showWindow() },
    { label: 'Play Demo', click: () => showWindow(null, '?demo') },
    { label: 'Open in Browser', click: () => shell.openExternal(BASE) },
    { type: 'separator' },
    { label: 'Agents', submenu: hookItems() },
    {
      label: 'Notifications',
      submenu: [
        { label: 'When an agent needs me', type: 'checkbox', checked: settings.notifyWait, click: (i) => { settings.notifyWait = i.checked; saveSettings(); } },
        { label: 'When a long turn finishes', type: 'checkbox', checked: settings.notifyDone, click: (i) => { settings.notifyDone = i.checked; saveSettings(); } },
      ],
    },
    ...(process.platform === 'linux' ? [] : [{
      label: 'Launch at Login',
      type: 'checkbox',
      checked: !!login.openAtLogin,
      click: (i) => setLogin(i.checked),
    }]),
    { type: 'separator' },
    { label: server ? `Server: 127.0.0.1:${PORT}` : `Server: shared on :${PORT}`, enabled: false },
    { label: 'Quit ChibiScope', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  if (process.env.CHIBISCOPE_DEBUG) {
    const labels = (items) => items.map((i) => (i.type === 'separator' ? '—' : `${i.checked ? '[x] ' : ''}${i.label}${i.submenu ? ` { ${labels(i.submenu.items).join(' | ')} }` : ''}`));
    console.log(`[tray] title=${JSON.stringify(isMac ? tray.getTitle() : '')} tooltip=${JSON.stringify(tray.getToolTip?.() ?? '')}\n  ${labels(menu.items).join('\n  ')}`);
  }
}

function trayImage() {
  const img = nativeImage.createFromPath(path.join(here, 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) img.setTemplateImage(true);
  return img;
}

/* ------------------------------------------------------------------ lifecycle */

app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('activate', () => showWindow());
app.on('before-quit', () => { quitting = true; feed?.close(); });
app.on('will-quit', (e) => {
  if (!server) return;
  e.preventDefault();
  const s = server;
  server = null;
  s.close().finally(() => app.exit(0));
});

app.whenReady().then(async () => {
  if (!primary) return;
  try { const f = path.join(app.getPath('userData'), 'main.log'); if (fs.statSync(f).size > 1 << 20) fs.truncateSync(f, 0); } catch { /* none yet */ }
  [serverMod, installer, S] = await Promise.all([load('src/server.js'), load('src/install.js'), load('web/js/state.js')]);
  state = S.createState();
  loadSettings();

  // Keep the hook launcher pointing at this binary (the app may have moved).
  try { if (fs.existsSync(LAUNCHER)) writeHookFiles(hookCtx); } catch (e) { console.warn('[chibiscope] hook refresh failed', e.message); }

  try {
    await ensureServer();
  } catch (e) {
    dialog.showErrorBox('ChibiScope', `Could not start the local server on port ${PORT}.\n${e.message}`);
  }

  tray = new Tray(trayImage());
  if (!isMac) tray.on('click', () => showWindow());
  updateTray();

  feed = subscribe(PORT, {
    onSnapshot: (data) => {
      state = S.createState();
      for (const ev of data.events || []) S.applyEvent(state, ev);
      scheduleTray();
    },
    onEvent: (ev) => {
      const res = S.applyEvent(state, ev);
      if (res) notify(ev, res.session);
      scheduleTray();
    },
    onClear: () => { state = S.createState(); scheduleTray(); },
    onDown: () => { ensureServer().catch(() => {}); },
  });
  setInterval(scheduleTray, 15000); // moods decay (done → idle → napping)

  // macOS 13+ registers login items through SMAppService, which drops --hidden;
  // wasOpenedAtLogin tells us we were started by the login item instead.
  const loginInfo = app.getLoginItemSettings();
  const hidden = process.argv.includes('--hidden') || loginInfo.wasOpenedAsHidden || loginInfo.wasOpenedAtLogin;
  applyLoginFlag();
  log(`started v${app.getVersion()} port=${PORT} ${server ? 'own server' : 'shared server'}${hidden ? ' (hidden)' : ''}`);
  if (hidden) { if (isMac) app.dock?.hide(); } else showWindow();
});
