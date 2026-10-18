// Codex has no hook API we can rely on, but every Codex surface (CLI, IDE
// extension, Desktop) appends a rollout JSONL file under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. We tail those files.
//
// Two generations of the format exist and both are handled:
//   - older: response_item function_call (exec_command, apply_patch...) + *_output
//   - newer: custom_tool_call "exec" (JS orchestrator) + event_msg item_completed
//            items (CommandExecution, FileChange, McpToolCall, WebSearch...)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCommand, classifyTool, clip, shortPath, stripShell } from './classify.js';

const TEXT = 600;
const TARGET = 240;

export function createCodexContext(sessionHint) {
  return {
    session: sessionHint ? 'codex:' + sessionHint : null,
    cwd: undefined,
    calls: new Map(), // call_id -> start event (open)
    seen: new Set(), // call ids we've already emitted a start for
    lastTexts: [], // de-dupe the same message arriving via two channels
  };
}

function remember(ctx, key) {
  if (ctx.lastTexts.includes(key)) return false;
  ctx.lastTexts.push(key);
  if (ctx.lastTexts.length > 40) ctx.lastTexts.shift();
  return true;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n').trim();
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  try { return JSON.parse(a); } catch { return a ? { _raw: String(a) } : {}; }
}

function patchFiles(input) {
  const s = typeof input === 'string' ? input : input?.input || input?.patch || '';
  const files = [...String(s).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  return files;
}

function exitOk(output) {
  const s = textOf(output) || (typeof output === 'string' ? output : '');
  const m = s.match(/(?:exit(?:ed)?(?: with)? code|exit_code"?)\s*:?\s*(-?\d+)/i);
  if (m) return Number(m[1]) === 0;
  return true;
}

/** Normalize one parsed rollout line. Returns zero or more unified events. */
export function normalizeCodexLine(o, ctx, now = Date.now()) {
  if (!o || typeof o !== 'object') return [];
  const p = o.payload;
  if (!p || typeof p !== 'object') return [];
  const ts = Date.parse(o.timestamp) || now;

  if (o.type === 'session_meta') {
    ctx.session = 'codex:' + (p.id || p.session_id || ctx.session || 'unknown');
    ctx.cwd = p.cwd || ctx.cwd;
    return [{ v: 1, ts, source: 'codex', session: ctx.session, cwd: ctx.cwd, type: 'session.start', meta: { originator: p.originator, version: p.cli_version } }];
  }
  if (o.type === 'turn_context' && p.cwd) ctx.cwd = p.cwd;
  if (!ctx.session) ctx.session = 'codex:unknown';
  const base = { v: 1, ts, source: 'codex', session: ctx.session, cwd: ctx.cwd };
  const out = [];

  const start = (call, name, input, namespace, override = {}) => {
    if (!call || ctx.seen.has(call)) return;
    ctx.seen.add(call);
    if (ctx.seen.size > 5000) ctx.seen.clear();
    let c;
    if (name === 'apply_patch') {
      const files = patchFiles(input);
      c = { cat: 'write', target: files.length ? files.map((f) => shortPath(f, ctx.cwd)).join(', ') : 'patch' };
    } else if (name === 'exec' && typeof input === 'string') {
      const inner = [...input.matchAll(/tools\.(\w+)\(/g)].map((m) => m[1]);
      const cmd = input.match(/cmd\s*:\s*["'`]([^"'`]+)/);
      c = { cat: cmd ? classifyCommand(cmd[1]) : 'shell', target: cmd ? stripShell(cmd[1]) : `script: ${[...new Set(inner)].join(', ') || 'js'}` };
    } else {
      c = classifyTool(name, typeof input === 'object' ? input : { _raw: input }, namespace);
    }
    const ev = { ...base, type: 'tool.start', call, tool: name, cat: c.cat, target: clip(shortPath(c.target, ctx.cwd), TARGET), ...override };
    if (c.mcp) ev.mcp = c.mcp;
    ctx.calls.set(call, ev);
    out.push(ev);
  };
  const end = (call, ok, extra = {}) => {
    const s = ctx.calls.get(call);
    if (!s) return;
    ctx.calls.delete(call);
    out.push({ ...base, type: 'tool.end', call, tool: s.tool, cat: s.cat, target: s.target, mcp: s.mcp, agent: s.agent, ok, ms: Math.max(0, ts - s.ts), ...extra });
  };
  const instant = (id, name, cat, target, ok, ms, extra = {}) => {
    if (id && ctx.seen.has(id)) return; // already shown via function_call
    if (id) ctx.seen.add(id);
    const call = id || `codex-item-${ts}-${Math.random().toString(36).slice(2, 7)}`;
    const dur = Number.isFinite(ms) ? ms : 200;
    const t = clip(shortPath(target, ctx.cwd), TARGET);
    out.push({ ...base, ts: ts - dur, type: 'tool.start', call, tool: name, cat, target: t, ...extra });
    out.push({ ...base, type: 'tool.end', call, tool: name, cat, target: t, ok, ms: dur, ...extra });
  };

  if (o.type === 'response_item') {
    switch (p.type) {
      case 'function_call':
        start(p.call_id || p.id, p.name, parseArgs(p.arguments), p.namespace);
        break;
      case 'custom_tool_call':
        start(p.call_id || p.id, p.name, p.input, p.namespace);
        break;
      case 'local_shell_call':
        start(p.call_id || p.id, 'local_shell_call', { command: p.action?.command }, undefined);
        break;
      case 'web_search_call':
        if (p.id && !ctx.seen.has(p.id)) {
          const q = p.action?.query || p.action?.queries?.[0] || 'web search';
          instant(p.id, 'web_search', 'web', q, p.status !== 'failed', undefined);
        }
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        end(p.call_id, exitOk(p.output));
        break;
      case 'reasoning': {
        const t = textOf(p.summary?.map?.((s) => s.text ?? s));
        if (t && remember(ctx, 'think:' + t)) out.push({ ...base, type: 'think', text: clip(t, TEXT) });
        break;
      }
      default:
        break;
    }
    return out;
  }

  if (o.type === 'compacted') return [{ ...base, type: 'compact' }];

  if (o.type === 'event_msg') {
    switch (p.type) {
      case 'user_message': {
        const t = p.message || textOf(p.content);
        if (t && remember(ctx, 'prompt:' + t)) out.push({ ...base, type: 'prompt', text: clip(t, TEXT) });
        break;
      }
      case 'agent_message':
        if (p.message && remember(ctx, 'say:' + p.message)) out.push({ ...base, type: 'say', text: clip(p.message, TEXT) });
        break;
      case 'agent_reasoning':
        if (p.text && remember(ctx, 'think:' + p.text)) out.push({ ...base, type: 'think', text: clip(p.text, TEXT) });
        break;
      case 'task_complete':
        out.push({ ...base, type: 'turn.end', ok: true, text: clip(p.last_agent_message, TEXT), ms: p.duration_ms });
        break;
      case 'turn_aborted':
        out.push({ ...base, type: 'turn.end', ok: false, text: 'aborted' });
        break;
      case 'token_count': {
        const u = p.info?.total_token_usage;
        if (u) out.push({ ...base, type: 'usage', meta: { tokens: u.total_tokens, window: p.info?.model_context_window, last: p.info?.last_token_usage?.total_tokens } });
        break;
      }
      case 'item_completed':
        normalizeItem(p.item || {}, p, { instant, out, base, ctx });
        break;
      default:
        break;
    }
  }
  return out;
}

function durationMs(d) {
  if (d == null) return undefined;
  if (typeof d === 'number') return d;
  if (typeof d === 'object') return (Number(d.secs) || 0) * 1000 + Math.round((Number(d.nanos) || 0) / 1e6);
  return undefined;
}

function normalizeItem(it, p, { instant, out, base, ctx }) {
  const ms = durationMs(it.duration) ?? (p.started_at_ms && p.completed_at_ms ? p.completed_at_ms - p.started_at_ms : undefined);
  switch (it.type) {
    case 'UserMessage': {
      const t = textOf(it.content);
      if (t && remember(ctx, 'prompt:' + t)) out.push({ ...base, type: 'prompt', text: clip(t, TEXT) });
      break;
    }
    case 'AgentMessage': {
      const t = textOf(it.content);
      if (t && remember(ctx, 'say:' + t)) out.push({ ...base, type: 'say', text: clip(t, TEXT), meta: it.phase ? { phase: it.phase } : undefined });
      break;
    }
    case 'Reasoning': {
      const t = (it.summary_text || []).join(' ').trim();
      if (t && remember(ctx, 'think:' + t)) out.push({ ...base, type: 'think', text: clip(t, TEXT) });
      break;
    }
    case 'CommandExecution': {
      const parsed = Array.isArray(it.parsed_cmd) ? it.parsed_cmd[0] : null;
      const cmd = parsed?.cmd || (Array.isArray(it.command) ? it.command.slice(2).join(' ') || it.command.join(' ') : it.command);
      let cat = classifyCommand(cmd);
      if (cat === 'shell' && parsed?.type === 'read') cat = 'read';
      if (cat === 'shell' && (parsed?.type === 'search' || parsed?.type === 'list_files')) cat = 'search';
      const ok = it.status !== 'failed' && (it.exit_code == null || it.exit_code === 0);
      instant(it.id, 'exec_command', cat, parsed?.path || stripShell(cmd), ok, ms);
      break;
    }
    case 'FileChange': {
      const files = Object.keys(it.changes || {});
      const t = files.length > 1 ? `${shortPath(files[0], ctx.cwd)} +${files.length - 1}` : shortPath(files[0] || 'patch', ctx.cwd);
      instant(it.id, 'apply_patch', 'write', t, it.status !== 'failed', ms);
      break;
    }
    case 'McpToolCall':
      instant(it.id, `mcp__${it.server}__${it.tool}`, 'mcp', it.tool, it.status !== 'failed', ms, { mcp: it.server });
      break;
    case 'WebSearch':
      instant(it.id, 'web_search', 'web', it.query || it.action?.query, true, ms);
      break;
    case 'Extension':
      if (String(it.kind).startsWith('web')) instant(it.id, it.kind, 'web', it.query || it.action?.query || it.url, true, ms);
      else instant(it.id, it.kind || 'extension', 'other', it.kind, it.status !== 'failed', ms);
      break;
    case 'ImageView':
      instant(it.id, 'view_image', 'read', it.path, true, ms);
      break;
    case 'SubAgentActivity':
      if (it.kind === 'started') out.push({ ...base, type: 'agent.start', agent: it.agent_thread_id || it.id, agentType: (it.agent_path || '').split('/').pop() || 'subagent', text: it.agent_path });
      else if (it.kind === 'completed' || it.kind === 'finished' || it.kind === 'stopped' || it.kind === 'failed') out.push({ ...base, type: 'agent.end', agent: it.agent_thread_id || it.id, ok: it.kind !== 'failed' });
      break;
    case 'ContextCompaction':
      out.push({ ...base, type: 'compact' });
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------- Watcher */

function pad(n) { return String(n).padStart(2, '0'); }
function dayDir(root, d) { return path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())); }

function listRollouts(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch { return []; }
}

function walkRecent(root, sinceMs, out = [], depth = 0) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory() && depth < 3) walkRecent(p, sinceMs, out, depth + 1);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* gone */ }
    }
  }
  return out;
}

function readFirstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1 << 20);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const s = buf.subarray(0, n).toString('utf8');
    const nl = s.indexOf('\n');
    return nl === -1 ? null : JSON.parse(s.slice(0, nl));
  } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
}

/**
 * Tail Codex rollout files. Calls `emit(events[])` for new activity.
 * Existing history is skipped; files created after start are read from byte 0.
 */
export function watchCodex(emit, { home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), interval = 800, log = () => {} } = {}) {
  const root = path.join(home, 'sessions');
  const startedAt = Date.now();
  const files = new Map(); // file -> { offset, rest, ctx }
  let ticks = 0;
  let stopped = false;

  const track = (file, fromStart) => {
    if (files.has(file)) return;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    const id = (path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/) || [])[1];
    const ctx = createCodexContext(id);
    const meta = readFirstLine(file);
    if (meta?.type === 'session_meta') {
      ctx.session = 'codex:' + (meta.payload?.id || id);
      ctx.cwd = meta.payload?.cwd;
    }
    files.set(file, { offset: fromStart ? 0 : size, rest: '', ctx });
    log(`codex: tracking ${path.basename(file)}${fromStart ? ' (new)' : ''}`);
  };

  const read = (file, st) => {
    let size;
    try { size = fs.statSync(file).size; } catch { files.delete(file); return; }
    if (size < st.offset) st.offset = 0; // truncated / rewritten
    if (size === st.offset) return;
    const len = Math.min(size - st.offset, 8 << 20);
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, st.offset);
    } catch { return; } finally { if (fd != null) fs.closeSync(fd); }
    st.offset += len;
    const chunk = st.rest + buf.toString('utf8');
    const lines = chunk.split('\n');
    st.rest = lines.pop() || '';
    const events = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      events.push(...normalizeCodexLine(o, st.ctx));
    }
    if (events.length) emit(events);
  };

  const scan = () => {
    if (stopped) return;
    ticks++;
    const now = new Date();
    const candidates = [...listRollouts(dayDir(root, now)), ...listRollouts(dayDir(root, new Date(now - 864e5)))];
    // Resumed sessions append to old files: do a wider sweep every ~15s.
    if (ticks % 20 === 1) candidates.push(...walkRecent(root, Date.now() - 10 * 60e3));
    for (const f of candidates) {
      if (files.has(f)) continue;
      let birth = 0;
      try { const s = fs.statSync(f); birth = s.birthtimeMs || s.ctimeMs; } catch { continue; }
      track(f, ticks > 1 && birth >= startedAt - 1000);
    }
    for (const [f, st] of files) read(f, st);
  };

  scan();
  const timer = setInterval(scan, interval);
  timer.unref?.();
  return { root, stop() { stopped = true; clearInterval(timer); }, files };
}
