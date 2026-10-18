#!/usr/bin/env node
// Hook bridge: reads the hook payload on stdin and forwards it to the local
// ChibiScope server. It must never slow down or break the agent, so:
//   - it always exits 0, even when the server is down
//   - it gives up on the network after a few hundred ms
//   - for Cursor it prints the "carry on" response each hook expects
//
// usage: node emit.js <claude|cursor|any-source> [--chibiscope]

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ts = Date.now();
const source = (process.argv[2] || 'agent').replace(/[^a-z0-9_-]/gi, '');
const port = Number(process.env.CHIBISCOPE_PORT) || 4777;

// Responses Cursor wants on stdout. For Cursor only non-permission hooks are
// installed; Claude Code hooks (PermissionRequest included) run with
// async: true and print nothing. Either way this bridge cannot approve or
// deny an action.
function cursorReply(event) {
  if (event === 'beforeSubmitPrompt') return { continue: true };
  return {};
}

function readStdin(limitMs = 1500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), limitMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

function post(body, timeout = 700) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/ingest/${source}`, method: 'POST', timeout, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', () => resolve(true)); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

function autostart() {
  if (process.env.CHIBISCOPE_AUTOSTART !== '1') return;
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'chibiscope.js');
  const child = spawn(process.execPath, [cli, 'start', '--quiet'], { detached: true, stdio: 'ignore' });
  child.unref();
}

const raw = await readStdin();
let payload = null;
try { payload = JSON.parse(raw); } catch { /* not JSON: forward nothing */ }

if (source === 'cursor') process.stdout.write(JSON.stringify(cursorReply(payload?.hook_event_name)));

// Cursor also runs Claude Code hooks found in ~/.claude/settings.json. Cursor
// activity is reported by its own hooks.json, so ignore Cursor calling the
// Claude bridge instead of mislabelling it as Claude.
const cursorAsClaude = source === 'claude' && payload?.cursor_version != null;

if (payload && typeof payload === 'object' && !cursorAsClaude) {
  payload._ts = ts;
  const ok = await post(JSON.stringify(payload));
  if (!ok && /^(SessionStart|sessionStart)$/.test(payload.hook_event_name || '')) autostart();
}
process.exit(0);
