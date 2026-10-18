// Procedural chibi characters (original art, pure SVG). Feet sit at (0,0);
// the character is ~70 units tall at scale 1.

const NS = 'http://www.w3.org/2000/svg';
const HAIR = ['#3b2a2a', '#5a3d2b', '#2d2a4a', '#7a4b2a', '#1f2a37', '#8a5a44', '#4a2f4f'];
const SKIN = '#ffe3d1';

export const PROPS = {
  read: '📖', search: '🔍', write: '🔨', shell: '⌨️', test: '🧪', git: '🌿', web: '🌐',
  mcp: '🔌', agent: '📣', plan: '📝', ask: '🙋', other: '🧰',
};

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function gear(kind, color, accent) {
  switch (kind) {
    case 'antenna':
      return `<path d="M2,-21 Q6,-30 3,-35" stroke="#5b4636" stroke-width="2" fill="none" stroke-linecap="round"/>
              <circle class="antenna-ball" cx="3" cy="-37" r="4.2" fill="${color}" stroke="#fff" stroke-width="1.2"/>`;
    case 'headphones':
      return `<path d="M-21,-1 Q-22,-27 0,-27 Q22,-27 21,-1" stroke="#2b3440" stroke-width="3.2" fill="none"/>
              <rect x="-26" y="-6" width="8" height="13" rx="4" fill="${color}" stroke="#2b3440" stroke-width="1.5"/>
              <rect x="18" y="-6" width="8" height="13" rx="4" fill="${color}" stroke="#2b3440" stroke-width="1.5"/>`;
    case 'cap':
      return `<path d="M-20,-8 Q-20,-27 0,-27 Q20,-27 20,-8 Z" fill="${color}"/>
              <path d="M2,-10 Q22,-12 28,-6 Q20,-4 2,-6 Z" fill="${color}" stroke="rgba(0,0,0,.18)" stroke-width="1"/>
              <circle cx="0" cy="-26" r="2.4" fill="${accent}"/>`;
    default: // cat ears
      return `<path d="M-17,-13 L-19,-30 L-6,-20 Z" fill="${color}"/><path d="M17,-13 L19,-30 L6,-20 Z" fill="${color}"/>
              <path d="M-15,-16 L-16,-26 L-9,-20 Z" fill="#ffb3c7"/><path d="M15,-16 L16,-26 L9,-20 Z" fill="#ffb3c7"/>`;
  }
}

/**
 * Build a chibi <g>. Returns { root, flip, bubble, bubbleText, status, prop, tag }.
 * opts: { key, color, accent, gear, label, mini }
 */
export function makeChibi(opts) {
  const h = hash(opts.key || 'x');
  const hair = HAIR[h % HAIR.length];
  const { color, accent } = opts;
  const root = el('g', { class: `chibi${opts.mini ? ' mini' : ''} mood-idle`, 'data-key': opts.key });
  const scale = opts.mini ? 0.72 : 1;
  root.innerHTML = `
    <g class="scale" transform="scale(${scale})">
      <ellipse class="shadow" cx="0" cy="1" rx="17" ry="4.5"/>
      <g class="flip">
        <g class="bob">
          <g class="legs">
            <rect class="leg leg-l" x="-8" y="-15" width="6.5" height="14" rx="3.2" fill="#3a3550"/>
            <rect class="leg leg-r" x="1.5" y="-15" width="6.5" height="14" rx="3.2" fill="#3a3550"/>
          </g>
          <path class="body" d="M-14,-11 Q-15,-35 0,-35 Q15,-35 14,-11 Q0,-7 -14,-11 Z" fill="${color}"/>
          <path d="M-6,-33 L0,-26 L6,-33" fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round"/>
          <circle class="hand hand-l" cx="-15" cy="-20" r="4.3" fill="${SKIN}" stroke="rgba(0,0,0,.08)"/>
          <g class="hand-r-wrap">
            <circle class="hand hand-r" cx="15" cy="-20" r="4.3" fill="${SKIN}" stroke="rgba(0,0,0,.08)"/>
            <text class="prop" x="17" y="-17" font-size="15" text-anchor="middle"></text>
          </g>
          <g class="head" transform="translate(0,-55)">
            <path class="hair-back" d="M-23,2 Q-26,-25 0,-25 Q26,-25 23,2 Q24,14 18,18 L-18,18 Q-24,14 -23,2 Z" fill="${hair}"/>
            <circle class="face" r="21" cy="1" fill="${SKIN}"/>
            <path class="bangs" d="M-21,-2 Q-20,-23 0,-23 Q20,-23 21,-2 Q14,-11 7,-6 Q3,-14 -3,-7 Q-9,-13 -14,-5 Q-17,-8 -21,-2 Z" fill="${hair}"/>
            <g class="eyes eyes-open">
              <g class="eye"><ellipse cx="-8" cy="4" rx="3.7" ry="4.8" fill="#2b2340"/><circle cx="-6.7" cy="2.1" r="1.45" fill="#fff"/><circle cx="-9" cy="6" r=".8" fill="#fff" opacity=".7"/></g>
              <g class="eye"><ellipse cx="8" cy="4" rx="3.7" ry="4.8" fill="#2b2340"/><circle cx="9.3" cy="2.1" r="1.45" fill="#fff"/><circle cx="7" cy="6" r=".8" fill="#fff" opacity=".7"/></g>
            </g>
            <g class="eyes eyes-happy"><path d="M-11.5,5 Q-8,0 -4.5,5" /><path d="M4.5,5 Q8,0 11.5,5" /></g>
            <g class="eyes eyes-closed"><path d="M-11.5,4 Q-8,7 -4.5,4" /><path d="M4.5,4 Q8,7 11.5,4" /></g>
            <g class="eyes eyes-wide"><circle cx="-8" cy="4" r="4.2" fill="#fff" stroke="#2b2340" stroke-width="1.6"/><circle cx="-8" cy="4" r="1.7" fill="#2b2340"/><circle cx="8" cy="4" r="4.2" fill="#fff" stroke="#2b2340" stroke-width="1.6"/><circle cx="8" cy="4" r="1.7" fill="#2b2340"/></g>
            <ellipse cx="-13.5" cy="11" rx="4" ry="2.3" fill="#ff9bb3" opacity=".55"/>
            <ellipse cx="13.5" cy="11" rx="4" ry="2.3" fill="#ff9bb3" opacity=".55"/>
            <path class="mouth mouth-smile" d="M-3,12 Q0,15 3,12" />
            <path class="mouth mouth-o" d="M-2,12.5 Q0,16.5 2,12.5 Q0,10.5 -2,12.5 Z" />
            <path class="mouth mouth-flat" d="M-2.5,13 L2.5,13" />
            ${gear(opts.gear, color, accent)}
          </g>
        </g>
      </g>
      <text class="status-icon" x="20" y="-82" font-size="16" text-anchor="middle"></text>
    </g>
    <g class="tag" transform="translate(0,${opts.mini ? 12 : 16})">
      <rect class="tag-bg" rx="7" ry="7" height="15" fill="${color}"/>
      <text class="tag-text" y="11" text-anchor="middle"></text>
    </g>
    <g class="bubble hidden" transform="translate(0,${opts.mini ? -78 : -100})">
      <g class="bubble-in">
        <rect class="bubble-bg" rx="10" ry="10" height="24" />
        <path class="bubble-tail" d="M-6,23 L0,31 L6,23 Z" />
        <text class="bubble-text" y="16.5" text-anchor="middle"></text>
      </g>
    </g>`;
  const q = (s) => root.querySelector(s);
  const api = {
    root,
    flip: q('.flip'),
    bubble: q('.bubble'),
    bubbleBg: q('.bubble-bg'),
    bubbleText: q('.bubble-text'),
    status: q('.status-icon'),
    prop: q('.prop'),
    tag: q('.tag'),
    tagBg: q('.tag-bg'),
    tagText: q('.tag-text'),
  };
  setLabel(api, opts.label || '');
  return api;
}

const measure = (s, px) => Math.ceil([...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? px : /[ilj.,:;'|!]/.test(ch) ? px * 0.32 : /[mwMW@]/.test(ch) ? px * 0.86 : px * 0.58), 0));

export function setLabel(c, text) {
  const t = text.length > 18 ? text.slice(0, 17) + '…' : text;
  c.tagText.textContent = t;
  const w = measure(t, 10) + 14;
  c.tagBg.setAttribute('width', w);
  c.tagBg.setAttribute('x', -w / 2);
}

export function setBubble(c, text, kind = 'say') {
  if (!text) { c.bubble.classList.add('hidden'); return; }
  const t = text.replace(/\s+/g, ' ').trim();
  const s = t.length > 34 ? t.slice(0, 33) + '…' : t;
  if (c.bubbleText.textContent === s && c.bubble.dataset.kind === kind) { c.bubble.classList.remove('hidden'); return; }
  c.bubbleText.textContent = s;
  c.bubble.dataset.kind = kind;
  const w = Math.max(44, measure(s, 11) + 22);
  c.bubbleBg.setAttribute('width', w);
  c.bubbleBg.setAttribute('x', -w / 2);
  c.bubble.classList.remove('hidden');
  // restart the pop animation
  const inner = c.bubble.firstElementChild;
  inner.classList.remove('pop');
  void inner.getBoundingClientRect();
  inner.classList.add('pop');
}

const MOOD_ICON = { waiting: '❗', error: '💦', done: '✨', sleep: '💤', thinking: '💭', ended: '👋' };

export function setMood(c, mood, cat) {
  const cls = [...c.root.classList].filter((k) => !k.startsWith('mood-') && !k.startsWith('cat-'));
  c.root.setAttribute('class', [...cls, `mood-${mood}`, cat ? `cat-${cat}` : ''].join(' ').trim());
  c.status.textContent = MOOD_ICON[mood] || '';
  c.prop.textContent = mood === 'working' && cat ? PROPS[cat] || '' : '';
}
