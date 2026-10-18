import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_EVENTS, CURSOR_EVENTS, MARKER, hookCommand, mergeClaude, stripClaude, mergeCursor, stripCursor } from '../src/install.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Claude merge keeps user hooks and is idempotent', () => {
  const mine = { type: 'command', command: 'echo mine' };
  const settings = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } };
  const cmd = hookCommand('claude', '/usr/bin/node', '/opt/chibi/hooks/emit.js');
  const once = mergeClaude(structuredClone(settings), cmd);
  const twice = mergeClaude(structuredClone(once), cmd);
  assert.deepEqual(once, twice);
  assert.equal(once.model, 'opus');
  assert.deepEqual(once.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [mine] });
  assert.equal(once.hooks.PreToolUse[1].matcher, '*');
  assert.equal(once.hooks.PreToolUse[1].hooks[0].async, true);
  assert.equal(once.hooks.Stop[0].matcher, undefined);
  for (const e of Object.keys(CLAUDE_EVENTS)) assert.ok(once.hooks[e].some((g) => g.hooks.some((h) => h.command.includes(MARKER))), e);
  assert.deepEqual(stripClaude(structuredClone(once)), settings);
});

test('Claude strip removes a hook object entirely when only ours remain', () => {
  const s = mergeClaude({}, hookCommand('claude'));
  assert.deepEqual(stripClaude(s), {});
});

test('Cursor merge only adds non-permission hooks', () => {
  const cfg = { version: 1, hooks: { afterFileEdit: [{ command: './hooks/format.sh' }] } };
  const merged = mergeCursor(structuredClone(cfg), hookCommand('cursor'));
  for (const bad of ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'subagentStart']) {
    assert.equal(merged.hooks[bad], undefined, bad);
  }
  assert.equal(merged.hooks.afterFileEdit.length, 1);
  assert.equal(merged.hooks.postToolUse.length, 1);
  assert.deepEqual(stripCursor(merged), cfg);
  assert.deepEqual(CURSOR_EVENTS.length, Object.keys(mergeCursor({}, 'x --chibiscope').hooks).length);
});

test('hook command quotes paths with spaces', () => {
  const c = hookCommand('cursor', '/Applications/My Node/node', '/Users/me/Git Hub/chibiscope/hooks/emit.js');
  assert.equal(c, '"/Applications/My Node/node" "/Users/me/Git Hub/chibiscope/hooks/emit.js" cursor --chibiscope');
});

test('plugin hooks.json registers the same events as the installer', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(plugin.hooks).sort(), Object.keys(CLAUDE_EVENTS).sort());
  for (const groups of Object.values(plugin.hooks)) {
    const h = groups[0].hooks[0];
    assert.equal(h.async, true);
    assert.match(h.command, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run\.sh" claude --chibiscope$/);
  }
});
