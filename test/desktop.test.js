import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { subscribe } from '../desktop/lib/feed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('desktop hook installer writes a launcher that works without node on PATH', { skip: process.platform === 'win32' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chibi-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // hooks.mjs resolves ~/.chibiscope at import time
  t.after(() => { process.env.HOME = prevHome; fs.rmSync(home, { recursive: true, force: true }); });

  const installer = await import(`../src/install.js?home=${Date.now()}`);
  const { installHooks, hookStatus, LAUNCHER } = await import(`../desktop/lib/hooks.mjs?home=${Date.now()}`);
  assert.ok(LAUNCHER.startsWith(home));

  const r = installHooks(installer, 'cursor', { coreDir: root, appExe: '/Applications/Chibi Scope.app/Contents/MacOS/ChibiScope' });
  assert.equal(r.file, path.join(home, '.cursor', 'hooks.json'));
  assert.equal(r.data.hooks.stop[0].command, `/bin/sh "${LAUNCHER}" cursor --chibiscope`);
  assert.ok(fs.existsSync(path.join(home, '.chibiscope', 'hooks', 'emit.mjs')));
  assert.match(fs.readFileSync(LAUNCHER, 'utf8'), /APP='\/Applications\/Chibi Scope\.app\/Contents\/MacOS\/ChibiScope'/);
  assert.equal(hookStatus(installer).cursor.viaApp, true);

  const out = await new Promise((resolve) => {
    const child = spawn('/bin/sh', [LAUNCHER, 'cursor', '--chibiscope'], { env: { PATH: '/usr/bin:/bin', HOME: home, CHIBISCOPE_NODE: process.execPath, CHIBISCOPE_PORT: '1' } });
    let s = '';
    child.stdout.on('data', (c) => (s += c));
    child.on('close', (code) => resolve({ code, s }));
    child.stdin.end('{"hook_event_name":"beforeSubmitPrompt","conversation_id":"c"}');
  });
  assert.deepEqual(out, { code: 0, s: '{"continue":true}' });
});

test('desktop feed client gets snapshot, live events and clear', async (t) => {
  const port = 48000 + Math.floor(Math.random() * 900);
  const srv = await startServer({ port, codex: false });
  srv.hub.push([{ v: 1, ts: Date.now(), source: 'claude', session: 's', type: 'prompt', text: 'old' }]);
  const seen = [];
  const feed = subscribe(port, {
    onSnapshot: (d) => seen.push(`snapshot:${d.events.length}`),
    onEvent: (e) => seen.push(`event:${e.type}`),
    onClear: () => seen.push('clear'),
  });
  t.after(async () => { feed.close(); await srv.close(); });
  await new Promise((r) => setTimeout(r, 150));
  srv.hub.push([{ v: 1, ts: Date.now(), source: 'claude', session: 's', type: 'turn.end', ok: true }]);
  srv.hub.clear();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(seen, ['snapshot:1', 'event:turn.end', 'clear']);
});
