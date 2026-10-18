#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { startServer, probe, DEFAULT_PORT, VERSION } from '../src/server.js';
import { install, uninstall, status } from '../src/install.js';
import { demoTimeline } from '../web/js/demo.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--port'));
const cmd = positional[0] || 'start';
const port = Number(opt('port', process.env.CHIBISCOPE_PORT || DEFAULT_PORT));
const quiet = flag('quiet');
const say = (...m) => { if (!quiet) console.log(...m); };

const HELP = `
  ChibiScope ${VERSION} — watch AI coding agents work, chibi style.

  Usage
    chibiscope [start] [--port 4777] [--open] [--no-codex]   start the local dashboard
    chibiscope install claude|cursor [--project] [--dry-run]  add observe-only hooks
    chibiscope uninstall claude|cursor [--project]            remove them again
    chibiscope status                                         server + hook status
    chibiscope demo [--speed 1]                               stream a demo into a running server

  Codex needs no install: ~/.codex/sessions is tailed automatically.
  Any other agent can POST normalized events to /ingest/events (see README).
`;

function openUrl(url) {
  const c = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(c, a, { stdio: 'ignore', detached: true }).unref(); } catch { /* headless */ }
}

async function start() {
  const existing = await probe(port);
  const url = `http://127.0.0.1:${port}`;
  if (existing) {
    say(`ChibiScope ${existing.version} is already running at ${url}`);
    if (flag('open')) openUrl(url);
    return;
  }
  const srv = await startServer({ port, codex: !flag('no-codex'), log: (m) => say(`  · ${m}`) });
  say(`\n  🐣 ChibiScope ${VERSION} live at ${srv.url}\n`);
  const st = status();
  say(`  Claude Code hooks: ${st.claude.installed ? (st.claude.plugin ? '✓ plugin' : '✓ installed') : '– not installed (chibiscope install claude, or use the plugin)'}`);
  say(`  Cursor hooks:      ${st.cursor.installed ? '✓ installed' : '– not installed (chibiscope install cursor)'}`);
  say(`  Codex sessions:    ${st.codex.found ? '✓ watching ' + st.codex.dir : '– ' + st.codex.dir + ' not found'}\n`);
  if (flag('open')) openUrl(srv.url);
  const stop = async () => { await srv.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function postEvents(events) {
  const body = JSON.stringify(events);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ingest/events', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(body);
  });
}

async function demo() {
  if (!(await probe(port))) {
    console.error(`No ChibiScope server on port ${port}. Start one first: npx chibiscope --open`);
    process.exit(1);
  }
  const speed = Number(opt('speed', 1)) || 1;
  const timeline = demoTimeline();
  say(`Streaming ${timeline.length} demo events to http://127.0.0.1:${port} …`);
  const t0 = Date.now();
  for (const { at, ev } of timeline) {
    const wait = at / speed - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await postEvents([{ ...ev, ts: Date.now() }]);
  }
  say('Demo finished.');
}

async function main() {
  if (flag('help') || cmd === 'help' || flag('h')) return console.log(HELP);
  if (flag('version') || cmd === 'version') return console.log(VERSION);
  switch (cmd) {
    case 'start':
      return start();
    case 'install': {
      const target = positional[1];
      if (target === 'codex') return say('Codex needs no hooks — ChibiScope tails ~/.codex/sessions automatically. ✓');
      const r = install(target, { project: flag('project'), dryRun: flag('dry-run') });
      if (flag('dry-run')) return console.log(JSON.stringify(r.data, null, 2));
      say(`✓ ChibiScope hooks added to ${r.file}`);
      say(`  events: ${r.events.join(', ')}`);
      say(`  backup: ${r.file}.chibiscope.bak (if the file existed)`);
      say(target === 'cursor' ? '  Restart Cursor (or reload the window) to pick them up.' : '  New Claude Code sessions will report in. Run /hooks to review.');
      return;
    }
    case 'uninstall': {
      const r = uninstall(positional[1], { project: flag('project') });
      return say(r.changed ? `✓ removed ChibiScope hooks from ${r.file}` : `nothing to remove (${r.file} not found)`);
    }
    case 'status': {
      const s = status({ project: flag('project') });
      const live = await probe(port);
      console.log(`server   ${live ? `✓ running v${live.version} on :${port} (${live.clients} viewers, ${live.events} events)` : `– not running on :${port}`}`);
      console.log(`claude   ${s.claude.installed ? '✓' : '–'} ${s.claude.plugin ? 'plugin chibiscope@chibiscope' : s.claude.file}`);
      console.log(`cursor   ${s.cursor.installed ? '✓' : '–'} ${s.cursor.file}`);
      console.log(`codex    ${s.codex.found ? '✓' : '–'} ${s.codex.dir}`);
      return;
    }
    case 'demo':
      return demo();
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`chibiscope: ${e.message}`);
  process.exit(1);
});
