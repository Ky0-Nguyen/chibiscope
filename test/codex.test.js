import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexContext, normalizeCodexLine, watchCodex } from '../src/codex.js';

const line = (type, payload, ts = '2026-10-17T07:03:05.000Z') => ({ timestamp: ts, type, payload });

test('older rollout format: function_call + output', () => {
  const ctx = createCodexContext();
  const all = [
    line('session_meta', { id: 'sess-1', cwd: '/w/app', originator: 'codex_cli_rs' }),
    line('event_msg', { type: 'user_message', message: 'fix the bug' }),
    line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n Login src' }), call_id: 'c1' }),
    line('response_item', { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 0\nsrc/a.ts' }, '2026-10-17T07:03:06.500Z'),
    line('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /w/app/src/a.ts\n@@\n-x\n+y\n*** End Patch', call_id: 'c2' }),
    line('response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success' }),
    line('event_msg', { type: 'item_completed', item: { type: 'FileChange', id: 'c2', changes: { '/w/app/src/a.ts': { type: 'update' } } } }),
    line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'c3' }),
    line('response_item', { type: 'function_call_output', call_id: 'c3', output: 'Process exited with code 1' }),
    line('event_msg', { type: 'task_complete', last_agent_message: 'done', duration_ms: 4000 }),
  ].flatMap((o) => normalizeCodexLine(o, ctx));

  const types = all.map((e) => `${e.type}${e.cat ? ':' + e.cat : ''}`);
  assert.deepEqual(types, ['session.start', 'prompt', 'tool.start:search', 'tool.end:search', 'tool.start:write', 'tool.end:write', 'tool.start:test', 'tool.end:test', 'turn.end']);
  assert.equal(all[0].session, 'codex:sess-1');
  assert.equal(all[3].ms, 1500);
  assert.equal(all[4].target, 'src/a.ts');
  assert.equal(all[7].ok, false);
});

test('newer rollout format: exec orchestrator + completed items', () => {
  const ctx = createCodexContext('abc');
  ctx.cwd = '/w/site';
  const all = [
    line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'read the code' }] } }),
    line('response_item', { type: 'custom_tool_call', name: 'exec', input: 'await tools.exec_command({cmd:"pwd && git status"})', call_id: 'e1' }),
    line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc'], parsed_cmd: [{ type: 'read', cmd: 'cat package.json', path: 'package.json' }], status: 'completed', exit_code: 0, duration: { secs: 0, nanos: 120000000 } } }),
    line('event_msg', { type: 'item_completed', item: { type: 'McpToolCall', id: 'm1', server: 'computer-use', tool: 'list_apps', status: 'failed', duration: { secs: 2, nanos: 0 } } }),
    line('response_item', { type: 'custom_tool_call_output', call_id: 'e1', output: [{ type: 'input_text', text: 'Script completed' }] }),
    line('event_msg', { type: 'item_completed', item: { type: 'Reasoning', summary_text: ['**Planning**'] } }),
    line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: 't9', agent_path: '/root/architecture_review' } }),
    line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'All good' }] } }),
    line('event_msg', { type: 'agent_message', message: 'All good' }), // duplicate channel
  ].flatMap((o) => normalizeCodexLine(o, ctx));

  const types = all.map((e) => `${e.type}${e.cat ? ':' + e.cat : ''}`);
  assert.deepEqual(types, ['prompt', 'tool.start:shell', 'tool.start:read', 'tool.end:read', 'tool.start:mcp', 'tool.end:mcp', 'tool.end:shell', 'think', 'agent.start', 'say']);
  assert.equal(all[1].session, 'codex:abc');
  assert.equal(all[3].ms, 120);
  assert.equal(all[5].ok, false);
  assert.equal(all[5].mcp, 'computer-use');
  assert.equal(all[8].agentType, 'architecture_review');
});

test('watcher tails new rollout files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chibi-codex-'));
  const d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const got = [];
  const w = watchCodex((evs) => got.push(...evs), { home, interval: 40 });
  try {
    await new Promise((r) => setTimeout(r, 120));
    const file = path.join(dir, 'rollout-2026-10-18T10-00-00-01a14c00-0000-7000-8000-000000000001.jsonl');
    fs.writeFileSync(file, JSON.stringify(line('session_meta', { id: 'live-1', cwd: '/w/live' })) + '\n');
    await new Promise((r) => setTimeout(r, 150));
    fs.appendFileSync(file, JSON.stringify(line('event_msg', { type: 'user_message', message: 'hello' })) + '\n' + '{"partial":');
    await new Promise((r) => setTimeout(r, 150));
    fs.appendFileSync(file, 'true}\n');
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    w.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.deepEqual(got.map((e) => e.type), ['session.start', 'prompt']);
  assert.equal(got[1].session, 'codex:live-1');
  assert.equal(got[1].cwd, '/w/live');
});

test('a read boundary inside a Vietnamese character does not corrupt it', async () => {
  const { takeLines } = await import('../src/codex.js');
  const line = Buffer.from(JSON.stringify({ text: 'sửa lỗi đăng nhập' }) + '\n', 'utf8');
  const cut = line.indexOf(Buffer.from('ử')) + 1; // split inside the 3-byte "ử"
  const a = takeLines(Buffer.alloc(0), line.subarray(0, cut));
  assert.deepEqual(a.lines, []);
  const b = takeLines(a.rest, line.subarray(cut));
  assert.equal(JSON.parse(b.lines[0]).text, 'sửa lỗi đăng nhập');
  assert.equal(b.rest.length, 0);
});

test('watcher keeps multi-byte text intact across partial writes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chibi-codex-'));
  const d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const got = [];
  const w = watchCodex((evs) => got.push(...evs), { home, interval: 30 });
  try {
    await new Promise((r) => setTimeout(r, 80));
    const file = path.join(dir, 'rollout-2026-10-18T10-00-00-01a14c00-0000-7000-8000-000000000002.jsonl');
    fs.writeFileSync(file, JSON.stringify(line('session_meta', { id: 'vi-1', cwd: '/w/vi' })) + '\n');
    await new Promise((r) => setTimeout(r, 120));
    const bytes = Buffer.from(JSON.stringify(line('event_msg', { type: 'user_message', message: 'thêm tiếng Việt có dấu' })) + '\n');
    const cut = bytes.indexOf(Buffer.from('ế')) + 1;
    fs.appendFileSync(file, bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 120));
    fs.appendFileSync(file, bytes.subarray(cut));
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    w.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.equal(got.find((e) => e.type === 'prompt')?.text, 'thêm tiếng Việt có dấu');
});

test('the same prompt typed twice shows twice; the second-channel copy does not', () => {
  const ctx = createCodexContext('dup');
  const t0 = Date.parse('2026-10-18T07:00:00.000Z');
  const at = (ms) => new Date(t0 + ms).toISOString();
  const prompts = [
    line('event_msg', { type: 'user_message', message: 'tiếp tục' }, at(0)),
    line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'tiếp tục' }] } }, at(3)),
    line('event_msg', { type: 'user_message', message: 'tiếp tục' }, at(60000)),
  ].flatMap((o) => normalizeCodexLine(o, ctx)).filter((e) => e.type === 'prompt');
  assert.equal(prompts.length, 2);
});

test('quiet files are parked and resume from where they stopped', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chibi-codex-'));
  const d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const got = [];
  const w = watchCodex((evs) => got.push(...evs), { home, interval: 30, idleMs: 60 });
  const file = path.join(dir, 'rollout-2026-10-18T10-00-00-01a14c00-0000-7000-8000-000000000003.jsonl');
  try {
    await new Promise((r) => setTimeout(r, 60));
    fs.writeFileSync(file, JSON.stringify(line('session_meta', { id: 'park-1', cwd: '/w/park' })) + '\n');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(w.files.has(file), false, 'parked after going quiet');
    assert.equal(w.parked.has(file), true);
    fs.appendFileSync(file, JSON.stringify(line('event_msg', { type: 'user_message', message: 'back again' })) + '\n');
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    w.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
  const p = got.find((e) => e.type === 'prompt');
  assert.equal(p?.text, 'back again');
  assert.equal(p?.session, 'codex:park-1');
  assert.equal(p?.cwd, '/w/park');
});
