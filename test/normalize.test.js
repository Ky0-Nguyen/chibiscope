import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, classifyTool, stripShell } from '../src/classify.js';
import { normalizeClaude, normalizeCursor, normalizeGeneric } from '../src/normalize.js';

test('shell commands land in the right zone', () => {
  assert.equal(classifyCommand('cd /x && npm test'), 'test');
  assert.equal(classifyCommand('pnpm vitest run'), 'test');
  assert.equal(classifyCommand('pytest -q tests/'), 'test');
  assert.equal(classifyCommand('git status --short'), 'git');
  assert.equal(classifyCommand('gh pr create --fill'), 'git');
  assert.equal(classifyCommand("sed -n '1,80p' src/app.ts"), 'read');
  assert.equal(classifyCommand('rg -n "Login" src'), 'search');
  assert.equal(classifyCommand('curl -s https://example.com'), 'web');
  assert.equal(classifyCommand('npm run build'), 'shell');
  assert.equal(classifyCommand('npm run lint:check'), 'shell');
  assert.equal(classifyCommand('cargo check'), 'shell');
  assert.equal(classifyCommand('npm run test:unit'), 'test');
  assert.equal(classifyCommand(['/bin/zsh', '-lc', 'git diff']), 'git');
  assert.equal(stripShell("bash -lc 'FOO=1 npm test'"), 'npm test');
  assert.equal(classifyCommand('cat test/fixtures.json'), 'read');
  assert.equal(classifyCommand("(command -v rg >/dev/null && rg -n 'x' .)"), 'search');
});

test('tool names from all three agents classify', () => {
  assert.equal(classifyTool('Read', { file_path: '/a/b.ts' }).cat, 'read');
  assert.equal(classifyTool('Edit', { file_path: '/a/b.ts' }).cat, 'write');
  assert.equal(classifyTool('MultiEdit', {}).cat, 'write');
  assert.equal(classifyTool('Grep', { pattern: 'x' }).cat, 'search');
  assert.equal(classifyTool('Glob', { pattern: '**/*.ts' }).cat, 'search');
  assert.equal(classifyTool('WebFetch', { url: 'https://x.dev' }).cat, 'web');
  assert.equal(classifyTool('WebSearch', { query: 'q' }).cat, 'web');
  assert.equal(classifyTool('Task', { description: 'explore' }).cat, 'agent');
  assert.equal(classifyTool('TodoWrite', {}).cat, 'plan');
  assert.equal(classifyTool('AskUserQuestion', {}).cat, 'ask');
  assert.equal(classifyTool('Bash', { command: 'npm test' }).cat, 'test');
  assert.equal(classifyTool('Shell', { command: 'git log' }).cat, 'git');
  assert.equal(classifyTool('StrReplace', {}).cat, 'write');
  assert.equal(classifyTool('apply_patch', 'patch').cat, 'write');
  assert.equal(classifyTool('update_plan', {}).cat, 'plan');
  const m = classifyTool('mcp__github__create_pull_request', {});
  assert.deepEqual([m.cat, m.mcp], ['mcp', 'github']);
  const ns = classifyTool('_create_pull_request', {}, 'mcp__codex_apps__github');
  assert.deepEqual([ns.cat, ns.mcp], ['mcp', 'github']);
  assert.equal(classifyTool('Skill', { skill: 'pdf' }).cat, 'other');
});

test('Claude Code hook payloads normalize', () => {
  const base = { session_id: 's1', cwd: '/home/me/proj', transcript_path: '/t.jsonl' };
  const [pre] = normalizeClaude({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/home/me/proj/src/a.ts' }, tool_use_id: 'tu1' }, 1000);
  assert.equal(pre.type, 'tool.start');
  assert.equal(pre.cat, 'read');
  assert.equal(pre.target, 'src/a.ts');
  assert.equal(pre.call, 'tu1');
  assert.equal(pre.session, 'claude:s1');

  const [post] = normalizeClaude({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'tu1' });
  assert.equal(post.type, 'tool.end');
  assert.equal(post.ok, true);

  const [fail] = normalizeClaude({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu2', error: 'exit 1' });
  assert.equal(fail.ok, false);
  assert.equal(fail.cat, 'test');

  const [sub] = normalizeClaude({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 'tu3', agent_id: 'ag1', agent_type: 'Explore' });
  assert.equal(sub.agent, 'ag1');
  assert.equal(sub.agentType, 'Explore');

  assert.equal(normalizeClaude({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' })[0].type, 'prompt');
  assert.equal(normalizeClaude({ ...base, hook_event_name: 'Stop' })[0].type, 'turn.end');
  const note = normalizeClaude({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '<system-reminder>\nThe session "x" finished a turn.\n</system-reminder>' })[0];
  assert.equal(note.text, '[system-reminder] The session "x" finished a turn.');
  assert.equal(note.meta.system, 'system-reminder');
  assert.equal(normalizeClaude({ ...base, hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'Plan' })[0].type, 'agent.start');
  assert.equal(normalizeClaude({ ...base, hook_event_name: 'Notification', message: 'Claude needs your permission' })[0].type, 'wait');
  assert.equal(normalizeClaude({ ...base, hook_event_name: 'PostCompact' }).length, 0);
  assert.equal(normalizeClaude(null).length, 0);
});

test('Cursor post-only hooks synthesize a start', () => {
  const p = { conversation_id: 'c1', generation_id: 'g1', workspace_roots: ['/w/site'], hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'npm run build' }, tool_use_id: 'x1', duration: 1200, _ts: 10000 };
  const [start, end] = normalizeCursor(p);
  assert.equal(start.type, 'tool.start');
  assert.equal(start.ts, 8800);
  assert.equal(end.type, 'tool.end');
  assert.equal(end.ms, 1200);
  assert.equal(end.cwd, '/w/site');
  assert.equal(normalizeCursor({ conversation_id: 'c1', hook_event_name: 'beforeSubmitPrompt', prompt: 'go' })[0].type, 'prompt');
  assert.equal(normalizeCursor({ conversation_id: 'c1', hook_event_name: 'afterAgentThought', text: 'hmm' })[0].type, 'think');
  assert.equal(normalizeCursor({ conversation_id: 'c1', hook_event_name: 'stop', status: 'completed' })[0].ok, true);
  const [mcp] = normalizeCursor({ conversation_id: 'c1', hook_event_name: 'afterMCPExecution', mcp_server_name: 'figma', tool_name: 'get_code', tool_input: {} });
  assert.equal(mcp.mcp, 'figma');
});

test('generic events validate and enrich', () => {
  const out = normalizeGeneric([
    { type: 'tool.start', session: 'aider:1', source: 'aider', tool: 'Bash', input: { command: 'pytest' }, call: 'c' },
    { type: 'bogus', session: 'x' },
    { type: 'prompt' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].cat, 'test');
  assert.equal(out[0].source, 'aider');
});
