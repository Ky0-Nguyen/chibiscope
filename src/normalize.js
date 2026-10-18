// Turns raw hook payloads into ChibiScope's unified event schema (v1).
//
//   { v, ts, source, session, cwd?, agent?, agentType?, type, call?, tool?,
//     cat?, target?, mcp?, ok?, ms?, text?, meta? }
//
// type: session.start | session.end | prompt | think | say | tool.start |
//       tool.end | agent.start | agent.end | wait | compact | turn.end | usage

import { classifyTool, clip, shortPath } from './classify.js';

const TEXT = 600;
const TARGET = 240;

function toolEvent(base, type, name, input, extra = {}) {
  const { cat, target, mcp } = classifyTool(name, input || {});
  return {
    ...base,
    type,
    tool: name,
    cat,
    target: clip(shortPath(target, base.cwd), TARGET),
    ...(mcp ? { mcp } : {}),
    ...extra,
  };
}

/* ---------------------------------------------------------------- Claude Code */

export function normalizeClaude(p, now = Date.now()) {
  if (!p || typeof p !== 'object') return [];
  const base = {
    v: 1,
    ts: Number(p._ts) || now,
    source: 'claude',
    session: 'claude:' + (p.session_id || 'unknown'),
    cwd: p.cwd,
  };
  if (p.agent_id) {
    base.agent = String(p.agent_id);
    if (p.agent_type) base.agentType = String(p.agent_type);
  }
  const ev = p.hook_event_name;
  switch (ev) {
    case 'SessionStart':
      return [{ ...base, type: 'session.start', text: p.source, meta: pick(p, ['model', 'session_title']) }];
    case 'SessionEnd':
      return [{ ...base, type: 'session.end', text: p.reason }];
    case 'UserPromptSubmit':
      return [{ ...base, type: 'prompt', ...promptText(p.prompt) }];
    case 'PreToolUse':
      return [toolEvent(base, 'tool.start', p.tool_name, p.tool_input, { call: p.tool_use_id })];
    case 'PostToolUse': {
      const r = p.tool_response;
      const failed = r && typeof r === 'object' && (r.is_error === true || r.interrupted === true || r.success === false);
      return [toolEvent(base, 'tool.end', p.tool_name, p.tool_input, { call: p.tool_use_id, ok: !failed })];
    }
    case 'PostToolUseFailure':
      return [toolEvent(base, 'tool.end', p.tool_name, p.tool_input, { call: p.tool_use_id, ok: false, text: clip(p.error, TEXT) })];
    case 'PermissionRequest':
      return [toolEvent(base, 'wait', p.tool_name, p.tool_input, { text: `Needs approval: ${p.tool_name}` })];
    case 'Notification':
      return [{ ...base, type: 'wait', text: clip(p.message || p.title, TEXT), meta: pick(p, ['notification_type']) }];
    case 'Stop':
      return [{ ...base, type: 'turn.end', ok: true, text: clip(p.last_assistant_message, TEXT) }];
    case 'StopFailure':
      return [{ ...base, type: 'turn.end', ok: false, text: clip(p.error || p.reason, TEXT) }];
    case 'SubagentStart':
      return [{ ...base, type: 'agent.start', text: p.agent_type }];
    case 'SubagentStop':
      return [{ ...base, type: 'agent.end', ok: true, text: clip(p.last_assistant_message, TEXT) }];
    case 'PreCompact':
      return [{ ...base, type: 'compact', text: p.trigger }];
    default:
      return [];
  }
}

/* --------------------------------------------------------------------- Cursor */

export function normalizeCursor(p, now = Date.now()) {
  if (!p || typeof p !== 'object') return [];
  const conv = p.conversation_id || p.session_id || 'cursor';
  const cwd = p.cwd || (Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : undefined);
  const base = {
    v: 1,
    ts: Number(p._ts) || now,
    source: 'cursor',
    session: 'cursor:' + conv,
    cwd,
  };
  const model = p.model ? { model: p.model } : undefined;
  const dur = Number(p.duration ?? p.duration_ms);
  const ms = Number.isFinite(dur) && dur >= 0 ? dur : undefined;
  const callId = p.tool_use_id || `${p.generation_id || conv}:${p.hook_event_name}:${base.ts}`;

  // Post-only hooks: synthesize the start so the chibi still walks there.
  const pair = (name, input, ok, extra = {}) => {
    const start = toolEvent({ ...base, ts: base.ts - (ms ?? 300) }, 'tool.start', name, input, { call: callId });
    const end = toolEvent(base, 'tool.end', name, input, { call: callId, ok, ...(ms != null ? { ms } : {}), ...extra });
    return [start, end];
  };

  switch (p.hook_event_name) {
    case 'sessionStart':
      return [{ ...base, type: 'session.start', meta: model }];
    case 'sessionEnd':
      return [{ ...base, type: 'session.end', text: p.reason || p.final_status }];
    case 'beforeSubmitPrompt':
      return [{ ...base, type: 'prompt', text: clip(p.prompt, TEXT), meta: model }];
    case 'preToolUse':
      return [toolEvent(base, 'tool.start', p.tool_name, p.tool_input, { call: callId })];
    case 'postToolUse':
      return pair(p.tool_name, p.tool_input, true);
    case 'postToolUseFailure':
      return pair(p.tool_name, p.tool_input, false, { text: clip(p.error_message, TEXT) });
    case 'beforeShellExecution':
      return [toolEvent(base, 'tool.start', 'Shell', { command: p.command }, { call: callId })];
    case 'afterShellExecution':
      return pair('Shell', { command: p.command }, true);
    case 'beforeMCPExecution':
      return [toolEvent(base, 'tool.start', `mcp__${p.mcp_server_name || 'mcp'}__${p.tool_name}`, p.tool_input, { call: callId })];
    case 'afterMCPExecution':
      return pair(`mcp__${p.mcp_server_name || 'mcp'}__${p.tool_name}`, p.tool_input, true);
    case 'beforeReadFile':
      return pair('Read', { file_path: p.file_path }, true);
    case 'afterFileEdit':
      return pair('Edit', { file_path: p.file_path }, true);
    case 'afterAgentThought':
      return [{ ...base, type: 'think', text: clip(p.text, TEXT), ...(Number.isFinite(p.duration_ms) ? { ms: p.duration_ms } : {}) }];
    case 'afterAgentResponse':
      return [{ ...base, type: 'say', text: clip(p.text, TEXT) }];
    case 'subagentStart':
      return [{ ...base, type: 'agent.start', agent: String(p.subagent_id || callId), agentType: p.subagent_type, text: clip(p.task, TEXT) }];
    case 'subagentStop':
      return [{ ...base, type: 'agent.end', agentType: p.subagent_type, ok: p.status !== 'error', text: clip(p.summary || p.description, TEXT), ...(Number.isFinite(p.duration_ms) ? { ms: p.duration_ms } : {}) }];
    case 'preCompact':
      return [{ ...base, type: 'compact', text: p.trigger }];
    case 'stop':
      return [{ ...base, type: 'turn.end', ok: p.status !== 'error', text: p.status }];
    default:
      return [];
  }
}

/* -------------------------------------------------------------------- Generic */

const TYPES = new Set(['session.start', 'session.end', 'prompt', 'think', 'say', 'tool.start', 'tool.end', 'agent.start', 'agent.end', 'wait', 'compact', 'turn.end', 'usage']);

/**
 * Already-normalized events from any other agent (Aider, Gemini CLI, your own
 * harness...). Missing cat/target are derived from `tool` + `input`.
 */
export function normalizeGeneric(p, now = Date.now()) {
  const list = Array.isArray(p) ? p : Array.isArray(p?.events) ? p.events : [p];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !TYPES.has(e.type) || !e.session) continue;
    const base = {
      v: 1,
      ts: Number(e.ts) || now,
      source: String(e.source || 'agent').slice(0, 32),
      session: String(e.session).slice(0, 200),
      cwd: e.cwd,
    };
    const ev = { ...base };
    for (const k of ['type', 'call', 'tool', 'cat', 'mcp', 'ok', 'ms', 'agent', 'agentType', 'meta']) if (e[k] !== undefined) ev[k] = e[k];
    if (e.target != null) ev.target = clip(String(e.target), TARGET);
    if (e.text != null) ev.text = clip(String(e.text), TEXT);
    if ((ev.type === 'tool.start' || ev.type === 'tool.end') && !ev.cat) {
      const c = classifyTool(e.tool, e.input || {});
      ev.cat = c.cat;
      if (ev.target == null) ev.target = clip(shortPath(c.target, base.cwd), TARGET);
      if (c.mcp && !ev.mcp) ev.mcp = c.mcp;
    }
    out.push(ev);
  }
  return out;
}

export function normalize(source, payload, now = Date.now()) {
  switch (source) {
    case 'claude': return normalizeClaude(payload, now);
    case 'cursor': return normalizeCursor(payload, now);
    default: return normalizeGeneric(payload, now);
  }
}

// Harnesses inject notes (<system-reminder>, <agent-message>, <task-notification>)
// as user turns. Show them as short system notes instead of raw XML.
export function promptText(prompt) {
  const raw = String(prompt ?? '');
  const tag = raw.match(/^\s*<([a-z][\w-]*)[\s>]/i);
  if (!tag) return { text: clip(raw, TEXT) };
  const body = raw.replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, ' ').replace(/\s+/g, ' ').trim();
  return { text: clip(`[${tag[1]}] ${body}`, 200), meta: { system: tag[1] } };
}

function pick(o, keys) {
  const r = {};
  let any = false;
  for (const k of keys) if (o[k] != null) { r[k] = o[k]; any = true; }
  return any ? r : undefined;
}
