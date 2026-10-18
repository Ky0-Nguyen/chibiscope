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

test('out-of-order async hooks: end before start is ignored cleanly', () => {
  const st = createState();
  applyEvent(st, ev({ type: 'tool.end', call: 'z', cat: 'shell', ok: true }));
  applyEvent(st, ev({ type: 'tool.start', call: 'z', cat: 'shell', tool: 'Bash' }));
  assert.equal(st.sessions.get('s').active.size, 0);
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
