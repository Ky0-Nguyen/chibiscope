// Pure reducer: unified events -> per-session state. No DOM here, so it can be
// unit-tested in Node and reused by the VS Code status bar.

export const CATS = {
  read: { label: 'Code Library', sub: 'Read · view', icon: '📚', verb: 'Reading' },
  search: { label: 'Search Index', sub: 'Grep · Glob · ls', icon: '🔎', verb: 'Searching' },
  write: { label: 'Workshop', sub: 'Edit · Write', icon: '🛠️', verb: 'Editing' },
  shell: { label: 'Terminal', sub: 'Bash · exec', icon: '💻', verb: 'Running' },
  test: { label: 'Test Lab', sub: 'jest · pytest', icon: '🧪', verb: 'Testing' },
  git: { label: 'Git Vault', sub: 'git · gh', icon: '🌿', verb: 'Git' },
  web: { label: 'Internet', sub: 'fetch · search', icon: '🌐', verb: 'Browsing' },
  mcp: { label: 'MCP Hub', sub: 'tool servers', icon: '🔌', verb: 'Calling' },
  agent: { label: 'Subagent Pool', sub: 'Task · spawn', icon: '🐣', verb: 'Delegating' },
  plan: { label: 'Planner', sub: 'todos · plans', icon: '📋', verb: 'Planning' },
  ask: { label: 'User', sub: 'prompt · approve', icon: '🙋', verb: 'Asking' },
  other: { label: 'Toolbox', sub: 'skills · misc', icon: '🧰', verb: 'Using' },
};

export const SOURCES = {
  claude: { name: 'Claude Code', color: '#E07A5F', accent: '#FFD6C2', gear: 'antenna' },
  codex: { name: 'Codex', color: '#2BA88F', accent: '#C9F2E6', gear: 'headphones' },
  cursor: { name: 'Cursor', color: '#5B6B9C', accent: '#DCE2F7', gear: 'cap' },
  agent: { name: 'Agent', color: '#9B7BEA', accent: '#E8DEFF', gear: 'ears' },
};
export const sourceMeta = (s) => SOURCES[s] || { ...SOURCES.agent, name: s || 'Agent' };

const STALE_MS = 45 * 60e3;

export function basename(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

export function createState() {
  return { sessions: new Map(), seq: 0 };
}

function newSession(ev) {
  return {
    id: ev.session,
    source: ev.source,
    cwd: ev.cwd,
    project: basename(ev.cwd) || ev.session.split(':').pop().slice(0, 8),
    startedAt: ev.ts,
    lastAt: ev.ts,
    status: 'idle', // idle | thinking | working | waiting | done | error | ended
    statusText: '',
    active: new Map(), // call -> tool.start event
    finished: new Set(), // calls that ended (guards against out-of-order hooks)
    counts: {},
    tools: 0,
    errors: 0,
    files: new Map(), // path -> { n, cat, ts }
    mcps: new Map(), // server -> count
    agents: new Map(), // agentId -> { id, type, label, active: Map, status, ts }
    turn: null,
    turns: 0,
    tokens: null,
    ended: false,
    order: 0,
  };
}

function ensureAgent(s, ev) {
  const id = ev.agent;
  if (!id) return null;
  let a = s.agents.get(id);
  if (!a) {
    a = { id, type: ev.agentType || 'subagent', label: ev.agentType || 'subagent', active: new Map(), status: 'working', ts: ev.ts, done: false };
    s.agents.set(id, a);
  } else if (ev.agentType && a.type === 'subagent') {
    a.type = a.label = ev.agentType;
  }
  return a;
}

function newTurn(s, ev, prompt) {
  s.turns += 1;
  s.turn = { n: s.turns, startedAt: ev.ts, prompt: prompt || '', rows: [], endedAt: null, ok: null };
  return s.turn;
}

function row(s, r) {
  if (!s.turn) newTurn(s, r, '');
  s.turn.rows.push(r);
  if (s.turn.rows.length > 160) s.turn.rows.splice(0, s.turn.rows.length - 160);
  return r;
}

export const participantOf = (ev) => (ev.cat === 'mcp' && ev.mcp ? `mcp:${ev.mcp}` : ev.cat === 'ask' ? 'user' : ev.cat);

/**
 * Apply one event. Returns { session, created } so the renderer can animate.
 */
export function applyEvent(state, ev) {
  if (!ev || !ev.session) return null;
  let s = state.sessions.get(ev.session);
  let created = false;
  if (!s) {
    s = newSession(ev);
    s.order = ++state.seq;
    state.sessions.set(ev.session, s);
    created = true;
  }
  if (ev.cwd && !s.cwd) { s.cwd = ev.cwd; s.project = basename(ev.cwd) || s.project; }
  s.lastAt = Math.max(s.lastAt, ev.ts || 0);
  if (s.ended && ev.type !== 'session.end') s.ended = false;
  const actor = ev.agent ? ensureAgent(s, ev) : null;
  if (actor) actor.ts = Math.max(actor.ts || 0, ev.ts || 0);
  const from = actor ? `agent:${actor.id}` : 'core';

  switch (ev.type) {
    case 'session.start':
      if (ev.meta?.model) s.model = ev.meta.model;
      if (s.status === 'ended') s.status = 'idle';
      break;
    case 'session.end':
      s.status = 'ended';
      s.ended = true;
      s.statusText = ev.text ? `Session ended (${ev.text})` : 'Session ended';
      s.active.clear();
      break;
    case 'prompt':
      newTurn(s, ev, ev.text);
      row(s, { kind: 'msg', from: 'user', to: 'core', label: ev.text || 'prompt', cat: 'ask', ts: ev.ts, state: 'ok' });
      s.status = 'thinking';
      s.statusText = 'Reading your request…';
      break;
    case 'think':
      row(s, { kind: 'note', at: from, icon: '💭', text: ev.text, ts: ev.ts });
      if (!s.active.size) { s.status = 'thinking'; s.statusText = ev.text || 'Thinking…'; }
      break;
    case 'say':
      row(s, { kind: 'note', at: from, icon: '💬', text: ev.text, ts: ev.ts });
      if (!s.active.size && s.status !== 'done') { s.status = 'thinking'; s.statusText = ev.text || ''; }
      break;
    case 'tool.start': {
      if (ev.call && s.finished.has(ev.call)) break; // end already arrived
      if (ev.call && s.active.has(ev.call)) break; // duplicate start
      const call = ev.call || `anon-${ev.id ?? ev.ts}`;
      const rec = { ...ev, call, from, row: null };
      s.active.set(call, rec);
      if (actor) actor.active.set(call, rec);
      s.tools += 1;
      s.counts[ev.cat] = (s.counts[ev.cat] || 0) + 1;
      if (ev.cat === 'mcp' && ev.mcp) s.mcps.set(ev.mcp, (s.mcps.get(ev.mcp) || 0) + 1);
      if ((ev.cat === 'read' || ev.cat === 'write') && ev.target) {
        const f = s.files.get(ev.target) || { n: 0 };
        s.files.set(ev.target, { n: f.n + 1, cat: ev.cat, ts: ev.ts });
      }
      rec.row = row(s, { kind: 'msg', from, to: participantOf(ev), label: ev.target || ev.tool, cat: ev.cat, ts: ev.ts, state: 'open', call });
      s.status = 'working';
      s.statusText = `${CATS[ev.cat]?.verb || 'Using'} ${ev.target || ev.tool || ''}`.trim();
      break;
    }
    case 'tool.end': {
      const call = ev.call;
      if (call) {
        s.finished.add(call);
        if (s.finished.size > 4000) s.finished = new Set([...s.finished].slice(-2000));
      }
      const rec = call && s.active.get(call);
      if (rec) {
        s.active.delete(call);
        for (const a of s.agents.values()) a.active.delete(call);
        if (rec.row) {
          rec.row.state = ev.ok === false ? 'fail' : 'ok';
          rec.row.ms = ev.ms ?? Math.max(0, (ev.ts || 0) - (rec.ts || 0));
        }
      }
      if (ev.ok === false) {
        s.errors += 1;
        s.status = 'error';
        s.statusText = `Oops: ${ev.text || ev.target || ev.tool || 'tool failed'}`;
      } else if (!s.active.size) {
        s.status = 'thinking';
        s.statusText = 'Thinking about the result…';
      } else {
        const last = [...s.active.values()].pop();
        s.statusText = `${CATS[last.cat]?.verb || 'Using'} ${last.target || last.tool || ''}`.trim();
      }
      break;
    }
    case 'agent.start': {
      const a = ensureAgent(s, ev);
      if (a) { a.status = 'working'; a.done = false; a.task = ev.text; }
      row(s, { kind: 'msg', from: 'core', to: `agent:${ev.agent}`, label: `spawn ${a?.type || 'subagent'}`, cat: 'agent', ts: ev.ts, state: 'ok' });
      break;
    }
    case 'agent.end': {
      let a = ev.agent ? s.agents.get(ev.agent) : null;
      if (!a) a = [...s.agents.values()].reverse().find((x) => !x.done && (!ev.agentType || x.type === ev.agentType));
      if (a) {
        a.done = true;
        a.doneAt = ev.ts;
        a.status = ev.ok === false ? 'error' : 'done';
        for (const call of a.active.keys()) s.active.delete(call);
        a.active.clear();
        row(s, { kind: 'msg', from: `agent:${a.id}`, to: 'core', label: ev.text ? `report: ${ev.text}` : 'report back', cat: 'agent', ts: ev.ts, state: ev.ok === false ? 'fail' : 'ok', ret: true });
      }
      break;
    }
    case 'wait':
      row(s, { kind: 'msg', from, to: 'user', label: ev.text || 'needs your input', cat: 'ask', ts: ev.ts, state: 'open' });
      s.status = 'waiting';
      s.statusText = ev.text || 'Waiting for you…';
      break;
    case 'compact':
      row(s, { kind: 'note', at: 'core', icon: '🗜️', text: 'context compacted', ts: ev.ts });
      s.statusText = 'Tidying up memory…';
      break;
    case 'turn.end':
      row(s, { kind: 'msg', from: 'core', to: 'user', label: ev.text || 'done', cat: 'ask', ts: ev.ts, state: ev.ok === false ? 'fail' : 'ok', ret: true });
      if (s.turn) { s.turn.endedAt = ev.ts; s.turn.ok = ev.ok !== false; }
      for (const r of s.turn?.rows || []) if (r.state === 'open') r.state = 'ok';
      s.active.clear();
      for (const a of s.agents.values()) { a.active.clear(); if (!a.done) { a.done = true; a.doneAt = ev.ts; a.status = 'done'; } }
      s.status = ev.ok === false ? 'error' : 'done';
      s.statusText = ev.ok === false ? 'Turn ended with an error' : 'All done! ✨';
      break;
    case 'usage':
      s.tokens = ev.meta || s.tokens;
      break;
    default:
      break;
  }
  s.rev = (s.rev || 0) + 1;
  return { session: s, created, actor };
}

export function isStale(s, now = Date.now()) {
  return s.ended || now - s.lastAt > STALE_MS;
}

/** Effective mood for the renderer, decaying "done" into idle/sleep over time. */
export function moodOf(s, now = Date.now()) {
  if (s.ended) return 'ended';
  const idle = now - s.lastAt;
  if (s.status === 'working') return s.active.size ? 'working' : 'thinking';
  if (s.status === 'waiting') return 'waiting';
  if (s.status === 'error') return idle > 20e3 ? 'idle' : 'error';
  if (s.status === 'done') return idle > 3 * 60e3 ? 'sleep' : idle > 25e3 ? 'idle' : 'done';
  if (s.status === 'thinking') return idle > 3 * 60e3 ? 'sleep' : 'thinking';
  return idle > 3 * 60e3 ? 'sleep' : 'idle';
}
