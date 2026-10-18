import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyEvent, moodOf } from '../web/js/state.js';
import { demoTimeline } from '../web/js/demo.js';

const ev = (o) => ({ source: 'claude', session: 's', cwd: '/x/proj', ts: Date.now(), ...o });

test('tool lifecycle drives status and sequence rows', () => {
  const st = createState();
  applyEvent(st, ev({ type: 'prompt', text: 'do it' }));
  const s = st.sessions.get('s');
  assert.equal(s.project, 'proj');
  assert.equal(s.status, 'thinking');
  applyEvent(st, ev({ type: 'tool.start', call: 'a', cat: 'read', tool: 'Read', target: 'a.ts' }));
  assert.equal(s.status, 'working');
  assert.equal(s.active.size, 1);
  applyEvent(st, ev({ type: 'tool.end', call: 'a', cat: 'read', ok: true, ms: 12 }));
  assert.equal(s.active.size, 0);
  assert.equal(s.turn.rows.at(-1).state, 'ok');
  applyEvent(st, ev({ type: 'turn.end', ok: true }));
  assert.equal(moodOf(s), 'done');
});

test('out-of-order async hooks: an end before its start still counts once', () => {
  const st = createState();
  applyEvent(st, ev({ type: 'prompt', text: 'go' }));
  applyEvent(st, ev({ type: 'tool.end', call: 'z', cat: 'read', tool: 'Read', target: 'a.ts', ok: true, ms: 4 }));
  applyEvent(st, ev({ type: 'tool.start', call: 'z', cat: 'read', tool: 'Read', target: 'a.ts' }));
  const s = st.sessions.get('s');
  assert.equal(s.active.size, 0); // never stuck "working"
  assert.equal(s.tools, 1);
  assert.equal(s.counts.read, 1);
  assert.equal(s.files.get('a.ts').n, 1);
  const rows = s.turn.rows.filter((r) => r.call === 'z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'ok');
});

test('an end for a call that started long ago is not double counted', () => {
  const st = createState();
  applyEvent(st, ev({ type: 'tool.start', call: 'q', cat: 'shell', tool: 'Bash' }));
  applyEvent(st, ev({ type: 'turn.end', ok: true })); // clears active
  applyEvent(st, ev({ type: 'tool.end', call: 'q', cat: 'shell', ok: true }));
  assert.equal(st.sessions.get('s').tools, 1);
});

test('subagents get their own actor state', () => {
  const st = createState();
  applyEvent(st, ev({ type: 'agent.start', agent: 'g1', agentType: 'Explore' }));
  applyEvent(st, ev({ type: 'tool.start', call: 'c', cat: 'search', agent: 'g1', agentType: 'Explore' }));
  const s = st.sessions.get('s');
  assert.equal(s.agents.get('g1').active.size, 1);
  applyEvent(st, ev({ type: 'agent.end', agent: 'g1' }));
  assert.equal(s.agents.get('g1').done, true);
  assert.equal(s.active.size, 0);
});

test('the demo script is self-consistent', () => {
  const st = createState();
  for (const { ev: e } of demoTimeline('t')) applyEvent(st, { ...e, ts: Date.now() });
  for (const s of st.sessions.values()) {
    assert.equal(s.active.size, 0, s.id);
    assert.equal(s.status, 'done', s.id);
  }
  assert.equal(st.sessions.size, 3);
});
