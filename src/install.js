// Adds / removes ChibiScope's observe-only hooks in Claude Code and Cursor
// config files. Every entry carries the `--chibiscope` marker so we can update
// or remove exactly our own entries and leave everything else untouched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '--chibiscope';
const here = path.dirname(fileURLToPath(import.meta.url));
export const EMIT = path.resolve(here, '..', 'hooks', 'emit.js');

export const CLAUDE_EVENTS = {
  SessionStart: false,
  SessionEnd: false,
  UserPromptSubmit: false,
  PreToolUse: true, // true = tool event, gets matcher "*"
  PostToolUse: true,
  PostToolUseFailure: true,
  PermissionRequest: true,
  Notification: false,
  Stop: false,
  SubagentStart: false,
  SubagentStop: false,
  PreCompact: false,
};

// Only hooks that cannot approve/deny anything. preToolUse, beforeShellExecution,
// beforeReadFile... are permission hooks in Cursor, so we deliberately skip them.
export const CURSOR_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'postToolUse',
  'postToolUseFailure',
  'afterAgentThought',
  'afterAgentResponse',
  'subagentStop',
  'preCompact',
  'stop',
];

const q = (s) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s);
export function hookCommand(source, node = process.execPath, emit = EMIT) {
  return `${q(node)} ${q(emit)} ${source} ${MARKER}`;
}

export function claudeSettingsPath({ project } = {}) {
  return project ? path.join(process.cwd(), '.claude', 'settings.local.json') : path.join(os.homedir(), '.claude', 'settings.json');
}
export function cursorHooksPath({ project } = {}) {
  return project ? path.join(process.cwd(), '.cursor', 'hooks.json') : path.join(os.homedir(), '.cursor', 'hooks.json');
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return structuredClone(fallback);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); not touching it.`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.chibiscope.bak`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARKER);

/* ------------------------------------------------------------------ Claude */

export function mergeClaude(settings, command) {
  const s = settings && typeof settings === 'object' ? settings : {};
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  stripClaude(s);
  s.hooks ||= {};
  for (const [event, isTool] of Object.entries(CLAUDE_EVENTS)) {
    const group = { hooks: [{ type: 'command', command, async: true, timeout: 5 }] };
    if (isTool) group.matcher = '*';
    s.hooks[event] = [...(Array.isArray(s.hooks[event]) ? s.hooks[event] : []), group];
  }
  return s;
}

export function stripClaude(s) {
  if (!s?.hooks || typeof s.hooks !== 'object') return s;
  for (const event of Object.keys(s.hooks)) {
    const groups = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      const hooks = Array.isArray(g?.hooks) ? g.hooks.filter((h) => !isOurs(h)) : g?.hooks;
      if (Array.isArray(g?.hooks) && hooks.length === 0) continue;
      kept.push(Array.isArray(g?.hooks) ? { ...g, hooks } : g);
    }
    if (kept.length) s.hooks[event] = kept;
    else delete s.hooks[event];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

/* ------------------------------------------------------------------ Cursor */

export function mergeCursor(config, command) {
  const c = config && typeof config === 'object' ? config : {};
  c.version = c.version || 1;
  c.hooks = c.hooks && typeof c.hooks === 'object' ? c.hooks : {};
  stripCursor(c);
  c.hooks = c.hooks || {};
  for (const event of CURSOR_EVENTS) {
    c.hooks[event] = [...(Array.isArray(c.hooks[event]) ? c.hooks[event] : []), { command, timeout: 5 }];
  }
  return c;
}

export function stripCursor(c) {
  if (!c?.hooks || typeof c.hooks !== 'object') return c;
  for (const event of Object.keys(c.hooks)) {
    const kept = (Array.isArray(c.hooks[event]) ? c.hooks[event] : []).filter((h) => !isOurs(h));
    if (kept.length) c.hooks[event] = kept;
    else delete c.hooks[event];
  }
  return c;
}

/* ------------------------------------------------------------------ API */

/** opts: { project, dryRun, command } — `command` overrides the hook command line. */
export function install(target, opts = {}) {
  if (target === 'claude') {
    const file = claudeSettingsPath(opts);
    const next = mergeClaude(readJson(file, {}), opts.command || hookCommand('claude'));
    if (!opts.dryRun) writeJson(file, next);
    return { file, events: Object.keys(CLAUDE_EVENTS), data: next };
  }
  if (target === 'cursor') {
    const file = cursorHooksPath(opts);
    const next = mergeCursor(readJson(file, { version: 1, hooks: {} }), opts.command || hookCommand('cursor'));
    if (!opts.dryRun) writeJson(file, next);
    return { file, events: CURSOR_EVENTS, data: next };
  }
  throw new Error(`unknown target "${target}" (use claude or cursor; Codex needs no install)`);
}

export function uninstall(target, opts = {}) {
  if (target === 'claude') {
    const file = claudeSettingsPath(opts);
    if (!fs.existsSync(file)) return { file, changed: false };
    const next = stripClaude(readJson(file, {}));
    if (!opts.dryRun) writeJson(file, next);
    return { file, changed: true };
  }
  if (target === 'cursor') {
    const file = cursorHooksPath(opts);
    if (!fs.existsSync(file)) return { file, changed: false };
    const next = stripCursor(readJson(file, { version: 1, hooks: {} }));
    if (!opts.dryRun) writeJson(file, next);
    return { file, changed: true };
  }
  throw new Error(`unknown target "${target}"`);
}

export function status(opts = {}) {
  const check = (file) => {
    try { return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARKER); } catch { return false; }
  };
  const pluginOn = () => {
    try {
      const s = JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf8'));
      return Object.entries(s.enabledPlugins || {}).some(([k, v]) => k.startsWith('chibiscope@') && v);
    } catch { return false; }
  };
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const plugin = pluginOn();
  return {
    claude: { file: claudeSettingsPath(opts), installed: plugin || check(claudeSettingsPath(opts)), plugin },
    cursor: { file: cursorHooksPath(opts), installed: check(cursorHooksPath(opts)) },
    codex: { dir: path.join(codexHome, 'sessions'), found: fs.existsSync(path.join(codexHome, 'sessions')) },
  };
}
