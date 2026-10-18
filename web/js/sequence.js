// Live UML-style sequence diagram of one session's current turn.

import { CATS } from './state.js';

const COL = 124;
const PAD = 20;
const ROW = 34;
const NOTE = 28;
const ORDER = ['plan', 'read', 'search', 'write', 'shell', 'test', 'git', 'web', 'mcp', 'other'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60e3 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60e3)}m`);

function participants(rows, s) {
  const seen = new Set(['user', 'core']);
  const agents = [];
  const cats = new Set();
  const mcps = [];
  for (const r of rows) {
    for (const p of r.kind === 'msg' ? [r.from, r.to] : [r.at]) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      if (p.startsWith('agent:')) agents.push(p);
      else if (p.startsWith('mcp:')) mcps.push(p);
      else cats.add(p);
    }
  }
  const list = ['user', 'core', ...agents];
  for (const c of ORDER) {
    if (c === 'mcp') list.push(...mcps);
    if (cats.has(c)) list.push(c);
  }
  for (const c of cats) if (!list.includes(c)) list.push(c);
  return list.map((id) => ({ id, ...label(id, s) }));
}

function label(id, s) {
  if (id === 'user') return { icon: '🙋', name: 'User' };
  if (id === 'core') return { icon: '🧠', name: 'Agent' };
  if (id.startsWith('agent:')) return { icon: '🐣', name: s?.agents.get(id.slice(6))?.type || 'subagent' };
  if (id.startsWith('mcp:')) return { icon: '🔌', name: id.slice(4) };
  return { icon: CATS[id]?.icon || '🧰', name: CATS[id]?.label || id };
}

export function renderSequence(container, s) {
  const rows = s?.turn?.rows || [];
  if (!s || !rows.length) {
    container.innerHTML = `<div class="seq-empty">The live sequence diagram of the selected agent's current turn shows up here.</div>`;
    return;
  }
  const shown = rows.slice(-90);
  const ps = participants(shown, s);
  const idx = new Map(ps.map((p, i) => [p.id, i]));
  const x = (id) => PAD + COL / 2 + (idx.get(id) ?? 1) * COL;
  const width = PAD * 2 + ps.length * COL;

  let y = 14;
  const parts = [];
  for (const r of shown) {
    if (r.kind === 'note') {
      const cx = x(r.at);
      const w = Math.min(COL * 2.6, width - PAD * 2);
      const left = Math.max(PAD, Math.min(cx - w / 2, width - PAD - w));
      parts.push(`<g class="seq-note"><rect x="${left}" y="${y}" width="${w}" height="${NOTE - 6}" rx="8"/><text x="${left + 10}" y="${y + 15}">${esc(r.icon)} ${esc(cut(r.text || '', Math.floor(w / 6.4)))}</text><title>${esc(r.text)}</title></g>`);
      y += NOTE;
      continue;
    }
    const x1 = x(r.from);
    const x2 = x(r.to);
    const dir = x2 >= x1 ? 1 : -1;
    const ret = !!r.ret;
    const cls = `seq-msg cat-${r.cat} ${r.state}${ret ? ' ret' : ''}`;
    const lab = cut(r.label, Math.max(14, Math.floor((Math.abs(x2 - x1) || COL) / 6.6)));
    const lx = (x1 + x2) / 2;
    let g = `<g class="${cls}"><title>${esc(r.label)}</title>`;
    g += `<text class="seq-label" x="${lx}" y="${y + 9}" text-anchor="middle">${esc(lab)}</text>`;
    g += `<line x1="${x1}" y1="${y + 15}" x2="${x2 - dir * 7}" y2="${y + 15}"/><path class="head" d="M${x2},${y + 15} l${-dir * 8},-4.5 v9 z"/>`;
    if (!ret && r.from !== 'user' && r.to !== 'user') {
      if (r.state === 'open') {
        g += `<rect class="activation" x="${x2 - 4}" y="${y + 11}" width="8" height="${ROW - 6}" rx="3"/>`;
      } else {
        g += `<line class="return" x1="${x2}" y1="${y + 26}" x2="${x1 + dir * 7}" y2="${y + 26}"/><path class="head ret-head" d="M${x1},${y + 26} l${dir * 7},-3.5 v7 z"/>`;
        g += `<text class="seq-ms" x="${x2 - dir * 6}" y="${y + 23}" text-anchor="${dir > 0 ? 'end' : 'start'}">${r.state === 'fail' ? '✗' : '✓'} ${fmtMs(r.ms)}</text>`;
      }
    }
    g += '</g>';
    parts.push(g);
    y += ROW;
  }
  const height = y + 16;
  const lifelines = ps.map((p) => `<line class="lifeline${p.id === 'core' ? ' core' : ''}" x1="${x(p.id)}" y1="0" x2="${x(p.id)}" y2="${height}"/>`).join('');
  const head = ps.map((p) => `<div class="seq-p${p.id.startsWith('agent:') ? ' agent' : ''}" style="width:${COL}px" title="${esc(p.name)}"><span>${p.icon}</span><b>${esc(cut(p.name, 14))}</b></div>`).join('');

  const scroller = container.querySelector('.seq-scroll');
  const nearBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const prevLeft = scroller?.scrollLeft || 0;
  const prevTop = scroller?.scrollTop || 0;
  container.innerHTML = `<div class="seq-scroll"><div class="seq-head" style="width:${width}px;padding:0 ${PAD}px">${head}</div><svg class="seq-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${lifelines}${parts.join('')}</svg></div>`;
  const sc = container.querySelector('.seq-scroll');
  sc.scrollLeft = prevLeft;
  sc.scrollTop = nearBottom ? sc.scrollHeight : prevTop;
}
