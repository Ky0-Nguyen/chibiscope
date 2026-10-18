import { createState, applyEvent, CATS, sourceMeta, moodOf, isStale } from './state.js';
import { createMap } from './map.js';
import { renderSequence } from './sequence.js';
import { playDemo } from './demo.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let state = createState();
let selected = null;
let codexDir = null;
let stopDemo = null;
const timeline = []; // { ev, li }

const map = createMap($('#map'), { onSelect: (id) => select(id) });

/* ------------------------------------------------------------------ events */

function ingest(ev, live = true) {
  const res = applyEvent(state, ev);
  if (!res) return;
  if (live) map.effect(ev, res.session);
  addTimeline(ev, res.session, live);
  schedule();
}

function reset() {
  state = createState();
  lastSeq = null;
  byCall.clear();
  timeline.length = 0;
  $('#timeline').innerHTML = '';
  schedule(true);
}

let pending = 0;
let pendingInstant = false;
function schedule(instant = false) {
  pendingInstant ||= instant;
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    render(pendingInstant);
    pendingInstant = false;
  });
}

function render(instant) {
  const now = Date.now();
  const { live } = map.refresh(state, selected, now, { instant });
  $('#empty').classList.toggle('show', live === 0 && ![...state.sessions.values()].some((s) => !isStale(s, now)));
  renderSessions(now);
  renderSeq();
}

/* ------------------------------------------------------------------ sidebar */

const MOOD_LABEL = { working: 'working', thinking: 'thinking', waiting: 'needs you', error: 'hit a snag', done: 'done', idle: 'idle', sleep: 'napping', ended: 'ended' };

function ago(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

function renderSessions(now) {
  const list = [...state.sessions.values()].sort((a, b) => (isStale(a, now) - isStale(b, now)) || b.lastAt - a.lastAt);
  const host = $('#sessions');
  if (!list.length) { setHtml(host, '<p class="muted">No agents yet.</p>'); return; }
  setHtml(host, list.slice(0, 30).map((s) => {
    const m = sourceMeta(s.source);
    const mood = moodOf(s, now);
    const total = Object.values(s.counts).reduce((a, b) => a + b, 0) || 1;
    const bar = Object.entries(s.counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<i class="cat-${c}" style="flex:${n}" title="${esc(CATS[c]?.label || c)}: ${n}"></i>`).join('');
    const agents = [...s.agents.values()].filter((a) => !a.done).length;
    return `<button class="sess${selected === s.id ? ' on' : ''}${isStale(s, now) ? ' stale' : ''}" data-id="${esc(s.id)}" style="--src:${m.color}">
      <span class="sess-dot"></span>
      <span class="sess-main">
        <span class="sess-top"><b>${esc(s.project)}</b><em>${esc(m.name)}</em><span class="mood mood-${mood}">${MOOD_LABEL[mood] || mood}</span></span>
        <span class="sess-text">${esc(s.statusText || (s.turn?.prompt ? '“' + s.turn.prompt + '”' : '…'))}</span>
        <span class="sess-bar">${total > 1 || s.tools ? bar : ''}</span>
        <span class="sess-meta">${s.tools} calls${s.errors ? ` · <span class="bad">${s.errors} errors</span>` : ''}${agents ? ` · ${agents} subagent${agents > 1 ? 's' : ''}` : ''}${s.tokens?.tokens ? ` · ${Math.round(s.tokens.tokens / 1000)}k tok` : ''} · ${ago(s.lastAt, now)} ago</span>
      </span>
    </button>`;
  }).join(''));
}

function setHtml(node, html) {
  if (node._html === html) return;
  node._html = html;
  node.innerHTML = html;
}

// pointerdown, not click: the list re-renders every second and a click whose
// mousedown/mouseup straddle a re-render would be lost.
$('#sessions').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.sess');
  if (b) select(selected === b.dataset.id ? null : b.dataset.id);
});

function select(id) {
  selected = id || null;
  for (const t of timeline) t.li.hidden = !!selected && t.ev.session !== selected;
  $('#filter-note').textContent = selected ? `· ${state.sessions.get(selected)?.project || ''}` : '';
  $('#btn-all').hidden = !selected;
  schedule();
}
$('#btn-all').addEventListener('click', () => select(null));

/* ------------------------------------------------------------------ timeline */

const ICON = { prompt: '✉️', think: '💭', say: '💬', 'agent.start': '🐣', 'agent.end': '📨', wait: '❗', compact: '🗜️', 'turn.end': '🎉', 'session.start': '👋', 'session.end': '🚪' };

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

const byCall = new Map();
function addTimeline(ev, s, live) {
  if (ev.type === 'usage') return;
  if (ev.type === 'tool.end') {
    const t = byCall.get(`${ev.session}|${ev.call}`);
    if (t) {
      t.li.classList.add(ev.ok === false ? 'fail' : 'ok');
      const res = t.li.querySelector('.res');
      if (res) res.textContent = `${ev.ok === false ? '✗' : '✓'}${ev.ms != null ? ' ' + (ev.ms < 1000 ? ev.ms + 'ms' : (ev.ms / 1000).toFixed(1) + 's') : ''}`;
      return;
    }
  }
  if (ev.type === 'tool.start' && byCall.has(`${ev.session}|${ev.call}`)) return;
  const m = sourceMeta(ev.source);
  const li = document.createElement('li');
  li.className = `ev ev-${ev.type.replace('.', '-')}${ev.cat ? ' cat-' + ev.cat : ''}${live ? ' fresh' : ''}`;
  li.style.setProperty('--src', m.color);
  let icon = ICON[ev.type] || '•';
  let text = ev.text || '';
  if (ev.type === 'tool.start' || ev.type === 'tool.end') {
    icon = CATS[ev.cat]?.icon || '🧰';
    text = `<b>${esc(ev.tool || '')}</b> ${esc(ev.target || '')}`;
  } else if (ev.type === 'turn.end') {
    icon = ev.ok === false ? '⚠️' : '🎉';
    text = esc(text || 'turn finished');
  } else if (ev.type === 'session.start' || ev.type === 'session.end') {
    text = `session ${ev.type === 'session.start' ? 'started' : 'ended'}${ev.text ? ' (' + esc(ev.text) + ')' : ''}`;
  } else if (ev.type === 'agent.start') {
    text = `spawned <b>${esc(ev.agentType || 'subagent')}</b> ${esc(ev.text || '')}`;
  } else {
    text = esc(text || ev.type);
  }
  const who = ev.agent ? `${esc(s.project)} › ${esc(ev.agentType || 'sub')}` : esc(s.project);
  li.innerHTML = `<span class="t">${fmtTime(ev.ts)}</span><span class="i">${icon}</span><span class="x"><span class="who">${who}</span> ${text}</span><span class="res"></span>`;
  li.hidden = !!selected && ev.session !== selected;
  li.addEventListener('click', () => select(ev.session));
  const ol = $('#timeline');
  ol.prepend(li);
  const item = { ev, li };
  timeline.push(item);
  if (ev.type === 'tool.start') byCall.set(`${ev.session}|${ev.call}`, item);
  if (ev.type === 'tool.end') {
    // end arrived before its start (async hooks): show it as a finished call
    li.classList.add(ev.ok === false ? 'fail' : 'ok');
    li.querySelector('.res').textContent = `${ev.ok === false ? '✗' : '✓'}${ev.ms != null ? ' ' + (ev.ms < 1000 ? ev.ms + 'ms' : (ev.ms / 1000).toFixed(1) + 's') : ''}`;
    if (ev.call) byCall.set(`${ev.session}|${ev.call}`, item);
  }
  if (timeline.length > 400) {
    const old = timeline.shift();
    old.li.remove();
    byCall.delete(`${old.ev.session}|${old.ev.call}`);
  }
}

/* ------------------------------------------------------------------ sequence */

let lastSeq = null;
function renderSeq() {
  const now = Date.now();
  let s = selected ? state.sessions.get(selected) : null;
  if (!s) s = [...state.sessions.values()].filter((x) => !isStale(x, now)).sort((a, b) => b.lastAt - a.lastAt)[0];
  const sig = s ? `${s.id}|${s.rev}` : '';
  if (sig === lastSeq) return;
  lastSeq = sig;
  const m = s ? sourceMeta(s.source) : null;
  $('#seq-title').innerHTML = s ?`<span class="chip" style="--src:${m.color}">${esc(m.name)}</span> ${esc(s.project)} · turn #${s.turn?.n || 0}${s.turn?.prompt ? ` — <em>${esc(s.turn.prompt.slice(0, 90))}</em>` : ''}` : '';
  renderSequence($('#seq'), s);
}

$('#seq-toggle').addEventListener('click', () => {
  const c = document.body.classList.toggle('seq-collapsed');
  store.set('chibiscope.seq', c ? '0' : '1');
});
if (store.get('chibiscope.seq') === '0') document.body.classList.add('seq-collapsed');

/* ------------------------------------------------------------------ connection */

function connect() {
  const pill = $('#conn');
  if (location.protocol === 'file:') { pill.textContent = 'offline · demo only'; pill.className = 'pill off'; return; }
  const es = new EventSource('events');
  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    reset();
    codexDir = data.codex;
    for (const ev of data.events) ingest(ev, false);
    schedule(true);
    pill.textContent = `live · v${data.version}`;
    pill.className = 'pill on';
    updateEmpty();
  });
  es.addEventListener('clear', () => reset());
  es.onmessage = (e) => { try { ingest(JSON.parse(e.data), true); } catch (err) { console.warn('bad event', err); } };
  es.onerror = () => { pill.textContent = 'reconnecting…'; pill.className = 'pill warn'; };
}

function updateEmpty() {
  $('#codex-status').textContent = codexDir ? `✓ watching ${codexDir.replace(/^\/Users\/[^/]+/, '~')}` : 'not found yet — install Codex and it will be picked up';
}

/* ------------------------------------------------------------------ controls */

function demo() {
  stopDemo?.();
  stopDemo = playDemo((ev) => ingest(ev, true));
}
$('#btn-demo').addEventListener('click', demo);
$('#empty-demo').addEventListener('click', demo);

$('#btn-clear').addEventListener('click', async () => {
  stopDemo?.();
  if (location.protocol !== 'file:') { try { await fetch('api/clear', { method: 'POST' }); } catch { /* offline */ } }
  reset();
});

const THEMES = ['auto', 'pastel', 'blueprint'];
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t === 'blueprint' ? 'dark' : 'light');
  $('#btn-theme').textContent = t === 'auto' ? '🌓 Auto' : t === 'pastel' ? '🌸 Pastel' : '📐 Blueprint';
  store.set('chibiscope.theme', t);
}
const urlTheme = new URLSearchParams(location.search).get('theme');
let theme = THEMES.includes(urlTheme) ? urlTheme : store.get('chibiscope.theme') || 'auto';
applyTheme(theme);
$('#btn-theme').addEventListener('click', () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; applyTheme(theme); });

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,select')) return;
  if (e.key === 'Escape') select(null);
  if (e.key === 'd') demo();
});

// #session=<id> focuses one agent (used by the desktop tray menu).
function applyHash() {
  const m = location.hash.match(/session=([^&]+)/);
  if (m) select(decodeURIComponent(m[1]));
}
window.addEventListener('hashchange', applyHash);

setInterval(() => schedule(), 1000);
const params = new URLSearchParams(location.search);
if (params.has('demo')) demo();
if (params.has('offline')) { $('#conn').textContent = 'offline · demo'; $('#conn').className = 'pill off'; } else connect();
applyHash();
render(true);
