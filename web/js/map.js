// The architecture map: zones (trust boundaries), service nodes, an orthogonal
// "tool bus", and the chibis that walk between them. Actor placement is derived
// from session state on every refresh; packets/effects come from live events.

import { CATS, sourceMeta, moodOf, isStale } from './state.js';
import { el, makeChibi, setBubble, setLabel, setMood } from './chibi.js';

export const W = 1200;
export const H = 760;

const ZONES = [
  { id: 'client', x: 16, y: 20, w: 178, h: 270, label: 'CLIENT' },
  { id: 'extras', x: 16, y: 306, w: 178, h: 434, label: 'EXTRAS' },
  { id: 'runtime', x: 210, y: 20, w: 244, h: 720, label: 'AGENT RUNTIME' },
  { id: 'workspace', x: 470, y: 20, w: 714, h: 470, label: 'LOCAL WORKSPACE · trust boundary' },
  { id: 'external', x: 470, y: 506, w: 714, h: 234, label: 'EXTERNAL SERVICES · network' },
];

const NODES = {
  user: { x: 105, y: 120, zone: 'client', ...CATS.ask },
  other: { x: 105, y: 400, zone: 'extras', ...CATS.other },
  plan: { x: 332, y: 120, zone: 'runtime', ...CATS.plan },
  core: { x: 332, y: 375, zone: 'runtime', label: 'Agent Core', sub: 'LLM reasoning loop', icon: '🧠', w: 156, h: 100 },
  agent: { x: 332, y: 610, zone: 'runtime', ...CATS.agent },
  read: { x: 585, y: 110, zone: 'workspace', ...CATS.read },
  search: { x: 815, y: 110, zone: 'workspace', ...CATS.search },
  write: { x: 1045, y: 110, zone: 'workspace', ...CATS.write },
  shell: { x: 585, y: 305, zone: 'workspace', ...CATS.shell },
  test: { x: 815, y: 305, zone: 'workspace', ...CATS.test },
  git: { x: 1045, y: 305, zone: 'workspace', ...CATS.git },
  web: { x: 585, y: 602, zone: 'external', ...CATS.web },
  mcp: { x: 815, y: 602, zone: 'external', ...CATS.mcp },
};
for (const n of Object.values(NODES)) { n.w ??= 120; n.h ??= 80; }

const TRUNK_X = 462;
const WS_BUS_Y = 250;
const EXT_BUS_Y = 546;
const SAT_COLS = [1010, 1120];
const SAT_ROWS = [562, 606, 650, 694];

function route(id) {
  const c = NODES.core;
  const n = NODES[id];
  const right = c.x + c.w / 2;
  const left = c.x - c.w / 2;
  switch (id) {
    case 'plan': return [[c.x, c.y - c.h / 2], [n.x, n.y + n.h / 2]];
    case 'agent': return [[c.x, c.y + c.h / 2], [n.x, n.y - n.h / 2]];
    case 'user': return [[left, c.y - 20], [200, c.y - 20], [200, n.y], [n.x + n.w / 2, n.y]];
    case 'other': return [[left, c.y + 20], [200, c.y + 20], [200, n.y], [n.x + n.w / 2, n.y]];
    case 'web': case 'mcp':
      return [[right, c.y + 18], [TRUNK_X, c.y + 18], [TRUNK_X, EXT_BUS_Y], [n.x, EXT_BUS_Y], [n.x, n.y - n.h / 2]];
    default: {
      const top = n.y < WS_BUS_Y;
      return [[right, c.y - 18], [TRUNK_X, c.y - 18], [TRUNK_X, WS_BUS_Y], [n.x, WS_BUS_Y], [n.x, top ? n.y + n.h / 2 : n.y - n.h / 2]];
    }
  }
}

function roundedPath(pts, r = 14) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    const next = pts[i + 1];
    if (!next) { d += ` L${x},${y}`; break; }
    const [px, py] = pts[i - 1];
    const l1 = Math.hypot(x - px, y - py);
    const l2 = Math.hypot(next[0] - x, next[1] - y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x - ((x - px) / (l1 || 1)) * rr;
    const ay = y - ((y - py) / (l1 || 1)) * rr;
    const bx = x + ((next[0] - x) / (l2 || 1)) * rr;
    const by = y + ((next[1] - y) / (l2 || 1)) * rr;
    d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
  }
  return d;
}

// Where a chibi stands in front of a node. Core gets extra room so its label
// and live counter stay readable under the crowd.
const spot = (id) => {
  const n = NODES[id];
  return { x: n.x, y: n.y + n.h / 2 + (id === 'core' ? 98 : 58) };
};
const slotDx = (i) => (i === 0 ? 0 : (i % 2 ? -1 : 1) * Math.ceil(i / 2) * 42);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const nodeFor = (cat) => (cat === 'ask' ? 'user' : NODES[cat] ? cat : 'other');

export function createMap(svg, { onSelect } = {}) {
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const defs = el('defs', {}, svg);
  defs.innerHTML = `
    <filter id="soft" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="var(--shadow)" flood-opacity="1"/></filter>
    <filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" class="grid-line"/></pattern>`;
  el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#grid)', class: 'grid-bg' }, svg);

  const gZones = el('g', { class: 'zones' }, svg);
  const gEdges = el('g', { class: 'edges' }, svg);
  const gSat = el('g', { class: 'sats' }, svg);
  const gNodes = el('g', { class: 'nodes' }, svg);
  const gFiles = el('g', { class: 'hotfiles' }, svg);
  const gLegend = el('g', { class: 'legend' }, svg);
  const gPackets = el('g', { class: 'packets' }, svg);
  const gActors = el('g', { class: 'actors' }, svg);
  const gFx = el('g', { class: 'fx' }, svg);

  for (const z of ZONES) {
    const g = el('g', { class: `zone zone-${z.id}` }, gZones);
    el('rect', { x: z.x, y: z.y, width: z.w, height: z.h, rx: 22, class: 'zone-box' }, g);
    el('text', { x: z.x + 16, y: z.y + 22, class: 'zone-label' }, g).textContent = z.label;
  }

  const edges = {};
  for (const id of Object.keys(NODES)) {
    if (id === 'core') continue;
    const d = roundedPath(route(id));
    const g = el('g', { class: `edge edge-${id}` }, gEdges);
    el('path', { d, class: 'edge-base' }, g);
    const flow = el('path', { d, class: 'edge-flow' }, g);
    edges[id] = { g, path: flow, len: flow.getTotalLength?.() || 300 };
  }
  // Bus labels make the diagram read like an architecture drawing.
  el('text', { x: 486, y: WS_BUS_Y - 6, class: 'bus-label' }, gEdges).textContent = 'tool bus';
  el('text', { x: 486, y: EXT_BUS_Y + 15, class: 'bus-label' }, gEdges).textContent = 'egress';

  const nodes = {};
  for (const [id, n] of Object.entries(NODES)) {
    const g = el('g', { class: `node node-${id} zone-${n.zone}`, transform: `translate(${n.x},${n.y})` }, gNodes);
    el('rect', { x: -n.w / 2 - 5, y: -n.h / 2 - 5, width: n.w + 10, height: n.h + 10, rx: 21, class: 'node-halo' }, g);
    el('rect', { x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, rx: 17, class: 'node-card', filter: 'url(#soft)' }, g);
    el('text', { y: id === 'core' ? -14 : -8, class: 'node-icon', 'font-size': id === 'core' ? 34 : 28, 'text-anchor': 'middle' }, g).textContent = n.icon;
    el('text', { y: id === 'core' ? 20 : 19, class: 'node-label', 'text-anchor': 'middle' }, g).textContent = n.label;
    el('text', { y: id === 'core' ? 34 : 32, class: 'node-sub', 'text-anchor': 'middle' }, g).textContent = n.sub;
    const badge = el('g', { class: 'node-badge', transform: `translate(${n.w / 2 - 8},${-n.h / 2 + 8})` }, g);
    el('rect', { x: -14, y: -10, width: 28, height: 20, rx: 10 }, badge);
    const bt = el('text', { y: 4, 'text-anchor': 'middle' }, badge);
    nodes[id] = { g, badge, bt };
  }
  const coreLive = el('text', { y: 47, class: 'node-live', 'text-anchor': 'middle' }, nodes.core.g);

  // Legend: who is who.
  const legend = [['claude', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor']];
  el('text', { x: 32, y: 540, class: 'zone-label' }, gLegend).textContent = 'WHO IS WHO';
  legend.forEach(([src, name], i) => {
    const m = sourceMeta(src);
    const c = makeChibi({ key: 'legend-' + src, color: m.color, accent: m.accent, gear: m.gear, label: '', mini: true });
    c.root.classList.add('legend-chibi');
    c.root.setAttribute('transform', `translate(56,${600 + i * 56}) scale(0.62)`);
    c.root.querySelector('.tag').remove();
    c.root.querySelector('.bubble').remove();
    gLegend.appendChild(c.root);
    el('text', { x: 84, y: 590 + i * 56, class: 'legend-text' }, gLegend).textContent = name;
  });

  /* ------------------------------------------------------------ actors */
  const actors = new Map(); // key -> actor
  const packets = [];
  let raf = 0;
  let selected = null;

  function makeActor(key, s, agent) {
    const m = sourceMeta(s.source);
    const c = makeChibi({ key, color: m.color, accent: m.accent, gear: m.gear, label: agent ? agent.label : s.project, mini: !!agent });
    const home = agent ? spot('agent') : spot('core');
    const a = { key, session: s.id, agent: agent?.id, c, x: home.x, y: home.y, tx: home.x, ty: home.y, from: null, t0: 0, dur: 0, node: null, leaving: false };
    c.root.setAttribute('transform', `translate(${a.x},${a.y})`);
    c.root.addEventListener('click', (e) => { e.stopPropagation(); onSelect?.(s.id); });
    gActors.appendChild(c.root);
    poof(a.x, a.y - 30, m.color);
    actors.set(key, a);
    return a;
  }

  function walk(a, x, y) {
    if (Math.abs(a.tx - x) < 0.5 && Math.abs(a.ty - y) < 0.5) return;
    a.from = { x: a.x, y: a.y };
    a.tx = x;
    a.ty = y;
    a.t0 = performance.now();
    const dist = Math.hypot(x - a.x, y - a.y);
    a.dur = Math.max(260, Math.min(1100, dist / 0.55));
    a.hop = Math.min(26, dist * 0.07);
    a.flip = x < a.x - 2 ? -1 : x > a.x + 2 ? 1 : a.flip || 1;
    a.c.flip.setAttribute('transform', `scale(${a.flip},1)`);
    a.c.root.classList.add('walking');
    kick();
  }

  function remove(a) {
    if (a.leaving) return;
    a.leaving = true;
    a.c.root.classList.add('leaving');
    poof(a.x, a.y - 30, '#fff');
    setTimeout(() => { a.c.root.remove(); actors.delete(a.key); }, 900);
  }

  /* ------------------------------------------------------------ effects */
  function poof(x, y, color) {
    const g = el('g', { class: 'poof', transform: `translate(${x},${y})` }, gFx);
    for (let i = 0; i < 7; i++) {
      const ang = (i / 7) * Math.PI * 2;
      el('circle', { r: 5 + (i % 3), fill: color, style: `--dx:${Math.cos(ang) * 26}px;--dy:${Math.sin(ang) * 22}px` }, g);
    }
    setTimeout(() => g.remove(), 700);
  }

  function confetti(x, y) {
    const g = el('g', { class: 'confetti', transform: `translate(${x},${y})` }, gFx);
    const colors = ['#ff8fab', '#ffd166', '#06d6a0', '#7aa2ff', '#c792ea'];
    for (let i = 0; i < 14; i++) {
      el('rect', { width: 5, height: 8, rx: 1.5, fill: colors[i % colors.length], style: `--dx:${(Math.random() - 0.5) * 120}px;--dy:${-40 - Math.random() * 60}px;--r:${Math.random() * 720 - 360}deg;animation-delay:${Math.random() * 120}ms` }, g);
    }
    setTimeout(() => g.remove(), 1400);
  }

  function packet(node, { reverse = false, color, ok = true, emoji } = {}) {
    const e = edges[node];
    if (!e) return;
    let dot;
    if (emoji) {
      dot = el('text', { class: 'packet-emoji', 'text-anchor': 'middle', 'font-size': 16, y: 5 }, gPackets);
      dot.textContent = emoji;
    } else {
      dot = el('circle', { r: 5.5, class: `packet${ok ? '' : ' bad'}`, fill: color, filter: 'url(#glow)' }, gPackets);
    }
    packets.push({ el: dot, path: e.path, len: e.len, t0: performance.now(), dur: Math.max(380, Math.min(900, e.len * 1.4)), reverse });
    e.g.classList.add('pulse');
    setTimeout(() => e.g.classList.remove('pulse'), 700);
    kick();
  }

  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  function frame(now) {
    raf = 0;
    let busy = false;
    for (const a of actors.values()) {
      if (!a.from) continue;
      const t = Math.min(1, (now - a.t0) / a.dur);
      const k = ease(t);
      a.x = a.from.x + (a.tx - a.from.x) * k;
      a.y = a.from.y + (a.ty - a.from.y) * k - Math.sin(Math.PI * t) * a.hop;
      a.c.root.setAttribute('transform', `translate(${a.x.toFixed(1)},${a.y.toFixed(1)})`);
      if (t >= 1) { a.from = null; a.x = a.tx; a.y = a.ty; a.c.root.classList.remove('walking'); } else busy = true;
    }
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      const t = Math.min(1, (now - p.t0) / p.dur);
      const L = p.len * (p.reverse ? 1 - ease(t) : ease(t));
      const pt = p.path.getPointAtLength(L);
      p.el.setAttribute('transform', `translate(${pt.x.toFixed(1)},${pt.y.toFixed(1)})`);
      if (t >= 1) { p.el.remove(); packets.splice(i, 1); } else busy = true;
    }
    if (busy) kick();
  }

  /* ------------------------------------------------------------ derived refresh */

  function desired(state, now) {
    const want = new Map(); // key -> { s, agent, node, mood, cat, text, kind }
    for (const s of state.sessions.values()) {
      if (isStale(s, now)) continue;
      const mood = moodOf(s, now);
      const mainCalls = [...s.active.values()].filter((r) => !r.agent);
      const last = mainCalls[mainCalls.length - 1];
      const node = mood === 'waiting' ? 'user' : last ? nodeFor(last.cat) : 'core';
      const showText = mood === 'working' || mood === 'thinking' || mood === 'waiting' || mood === 'error' || (mood === 'done' && now - s.lastAt < 9000);
      want.set(s.id, { s, node, mood: last ? 'working' : mood === 'working' ? 'thinking' : mood, cat: last?.cat, text: showText ? s.statusText : '', kind: mood === 'thinking' ? 'think' : 'say' });
      for (const ag of s.agents.values()) {
        const recent = !ag.done || now - (ag.doneAt || 0) < 2500;
        if (!recent) continue;
        const calls = [...ag.active.values()];
        const l = calls[calls.length - 1];
        want.set(`${s.id}#${ag.id}`, {
          s, agent: ag,
          node: l ? nodeFor(l.cat) : 'agent',
          mood: ag.done ? (ag.status === 'error' ? 'error' : 'done') : l ? 'working' : 'thinking',
          cat: l?.cat,
          text: ag.done ? 'Report sent ✓' : l ? `${CATS[l.cat]?.verb || 'Using'} ${l.target || l.tool || ''}` : ag.task || ag.type,
          kind: l ? 'say' : 'think',
        });
      }
    }
    return want;
  }

  function refresh(state, sel, now = Date.now(), { instant = false } = {}) {
    selected = sel;
    const want = desired(state, now);
    for (const [key, a] of actors) if (!want.has(key)) remove(a);

    // group by node for slotting (stable order)
    const byNode = new Map();
    for (const [key, w] of want) {
      const n = w.node;
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n).push(key);
    }
    // Only the most recently active chibi per node talks (plus anyone who needs attention).
    const recency = (k) => { const w = want.get(k); return w.agent ? w.agent.ts || 0 : w.s.lastAt; };
    const talker = new Map([...byNode].map(([n, keys]) => [n, keys.reduce((a, b) => (recency(b) > recency(a) ? b : a))]));
    for (const [key, w] of want) {
      let a = actors.get(key);
      if (!a || a.leaving) a = makeActor(key, w.s, w.agent);
      const list = byNode.get(w.node);
      const i = list.indexOf(key);
      const talks = talker.get(w.node) === key || w.mood === 'waiting' || w.mood === 'error' || (sel && w.s.id === sel);
      a.c.tag.setAttribute('transform', `translate(0,${(w.agent ? 12 : 16) + (i % 2) * 15})`);
      const sp = spot(w.node);
      const mini = !!w.agent;
      const tx = sp.x + slotDx(i);
      const ty = sp.y - (mini ? 6 : 0) + (i > 4 ? 30 : 0);
      if (instant) {
        a.x = a.tx = tx; a.y = a.ty = ty; a.from = null;
        a.c.root.setAttribute('transform', `translate(${tx},${ty})`);
      } else walk(a, tx, ty);
      a.node = w.node;
      setMood(a.c, w.mood, w.cat);
      setBubble(a.c, talks ? w.text : '', w.kind);
      if (!w.agent) setLabel(a.c, w.s.project);
      a.c.root.classList.toggle('dim', !!sel && w.s.id !== sel);
      a.c.root.classList.toggle('selected', !!sel && w.s.id === sel);
    }
    // Keep working chibis on top. Moving a DOM node restarts its CSS
    // animations, so only reorder when the order actually changes.
    const rank = (el) => (el.classList.contains('selected') ? 2 : el.classList.contains('mood-working') ? 1 : 0);
    const current = [...gActors.children];
    const wanted = [...current].sort((p, q) => rank(p) - rank(q));
    if (wanted.some((n, i) => n !== current[i])) {
      let i = 0;
      while (i < wanted.length && wanted[i] === current[i]) i++;
      for (const n of wanted.slice(i)) gActors.appendChild(n);
    }

    // node badges, busy state, edge heat
    const counts = {};
    const busy = {};
    let live = 0;
    let calls = 0;
    const files = new Map();
    const mcps = new Map();
    for (const s of state.sessions.values()) {
      if (sel && s.id !== sel) continue;
      if (!isStale(s, now)) live++;
      for (const [cat, n] of Object.entries(s.counts)) counts[nodeFor(cat)] = (counts[nodeFor(cat)] || 0) + n;
      for (const r of s.active.values()) { busy[nodeFor(r.cat)] = (busy[nodeFor(r.cat)] || 0) + 1; calls++; }
      for (const [f, v] of s.files) { const o = files.get(f); if (!o || o.ts < v.ts) files.set(f, { ...v, n: (o?.n || 0) + v.n }); }
      for (const [m, n] of s.mcps) mcps.set(m, (mcps.get(m) || 0) + n);
    }
    for (const [id, n] of Object.entries(nodes)) {
      const c = counts[id] || 0;
      n.bt.textContent = c > 999 ? '999+' : String(c);
      n.badge.classList.toggle('zero', !c);
      n.g.classList.toggle('busy', !!busy[id]);
      const e = edges[id];
      if (e) {
        e.g.style.setProperty('--heat', String(Math.min(5, Math.log2(1 + c))));
        e.g.classList.toggle('active', !!busy[id]);
      }
    }
    nodes.core.g.classList.toggle('busy', live > 0);
    coreLive.textContent = live ? `${live} agent${live > 1 ? 's' : ''} · ${calls} in flight` : 'idle';
    drawFiles(files);
    drawSats(mcps, state, sel);
    return { live };
  }

  function drawFiles(files) {
    gFiles.innerHTML = '';
    const top = [...files.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 5);
    el('text', { x: 490, y: 466, class: 'bus-label' }, gFiles).textContent = top.length ? 'hot files' : '';
    let x = 556;
    for (const [f, v] of top) {
      const name = f.split(/[\\/]/).pop();
      const label = `${name.length > 18 ? name.slice(0, 17) + '…' : name}${v.n > 1 ? ` ×${v.n}` : ''}`;
      const w = Math.min(150, 26 + label.length * 6.3);
      if (x + w > 1172) break;
      const g = el('g', { class: `file-chip cat-${v.cat}`, transform: `translate(${x},450)` }, gFiles);
      el('title', {}, g).textContent = f;
      el('rect', { width: w, height: 24, rx: 12 }, g);
      el('text', { x: 10, y: 16 }, g).textContent = `${v.cat === 'write' ? '✏️' : '📄'} ${label}`;
      x += w + 8;
    }
  }

  function drawSats(mcps, state, sel) {
    gSat.innerHTML = '';
    const hub = NODES.mcp;
    const busySrv = new Set();
    for (const s of state.sessions.values()) {
      if (sel && s.id !== sel) continue;
      for (const r of s.active.values()) if (r.cat === 'mcp' && r.mcp) busySrv.add(r.mcp);
    }
    const list = [...mcps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    list.forEach(([name, n], i) => {
      const x = SAT_COLS[Math.floor(i / SAT_ROWS.length)];
      const y = SAT_ROWS[i % SAT_ROWS.length];
      const pts = [[hub.x + hub.w / 2, hub.y], [935, hub.y], [935, y], [x - 52, y]];
      el('path', { d: roundedPath(pts, 10), class: `edge-base sat-edge${busySrv.has(name) ? ' active' : ''}` }, gSat);
      const g = el('g', { class: `sat${busySrv.has(name) ? ' busy' : ''}`, transform: `translate(${x},${y})` }, gSat);
      el('rect', { x: -52, y: -15, width: 104, height: 30, rx: 15 }, g);
      el('text', { x: -40, y: 5 }, g).textContent = `🔌 ${name.length > 9 ? name.slice(0, 8) + '…' : name}`;
      el('text', { x: 44, y: 5, 'text-anchor': 'end', class: 'sat-n' }, g).textContent = n;
      el('title', {}, g).textContent = `MCP server: ${name}`;
    });
  }

  /** Live-only flourishes: packets, confetti, spawn puffs. */
  function effect(ev, s) {
    const m = sourceMeta(s.source);
    const key = ev.agent ? `${s.id}#${ev.agent}` : s.id;
    switch (ev.type) {
      case 'prompt': packet('user', { reverse: true, emoji: '✉️' }); break;
      case 'tool.start': packet(nodeFor(ev.cat), { color: m.color }); break;
      case 'tool.end': packet(nodeFor(ev.cat), { reverse: true, color: m.color, ok: ev.ok !== false }); break;
      case 'agent.start': packet('agent', { color: m.color }); break;
      case 'wait': packet('user', { emoji: '❓' }); break;
      case 'turn.end': {
        packet('user', { emoji: ev.ok === false ? '⚠️' : '🎁' });
        const a = actors.get(key);
        if (a && ev.ok !== false) setTimeout(() => confetti(a.x, a.y - 70), 350);
        break;
      }
      default: break;
    }
  }

  svg.addEventListener('click', () => onSelect?.(null));

  return { refresh, effect, actors, nodes: NODES };
}
