// Maps raw tool names / shell commands from any agent onto the architecture
// "zones" the UI draws: read, search, write, shell, test, git, web, mcp,
// agent, plan, ask, other.

export const CATEGORIES = ['read', 'search', 'write', 'shell', 'test', 'git', 'web', 'mcp', 'agent', 'plan', 'ask', 'other'];

const TEST_RUNNER = /^(jest|vitest|pytest|py\.test|mocha|ava|playwright|cypress|rspec|phpunit|tox|nox|ctest|karma|detox|maestro)\b/;
const TEST_VIA = /^(npm|pnpm|yarn|bun|npx|bunx|make|go|cargo|python3?|uv|poetry|deno|mvn|gradle|\.\/gradlew|gradlew|xcodebuild|swift|dotnet|flutter|dart|mix|rails|bundle|php|composer|turbo|nx)\b.*\b(test|tests|spec|e2e|vitest|jest|pytest)\b/; // not "check": lint:check, cargo check, typecheck are not tests
const GIT = /^(git|gh|glab|hub)\b/;
const READ = /^(cat|head|tail|less|more|bat|nl|wc|sed\s+-n|awk|jq|yq|stat|file|xxd|od|strings|plutil\s+-p)\b/;
const SEARCH = /^(rg|grep|egrep|fgrep|ag|ack|fd|find|ls|tree|locate|which|du|mdfind)\b/;
const WEB = /^(curl|wget|http|https|xh|httpie)\b/;

/** Strip shell wrappers so `cd x && FOO=1 npm test` classifies as `npm test`. */
export function stripShell(cmd) {
  // argv form: ['/bin/zsh', '-lc', 'git diff']
  if (Array.isArray(cmd)) cmd = /^-l?c$/.test(cmd[1] || '') && cmd.length > 2 ? cmd.slice(2).join(' ') : cmd.join(' ');
  let c = String(cmd ?? '');
  // unwrap `bash -lc "..."` / `zsh -c '...'`
  const wrapped = c.match(/^\s*(?:\/\S+\/)?(?:ba|z|da|fi)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/);
  if (wrapped) c = wrapped[2];
  c = c.trim();
  for (let i = 0; i < 6; i++) {
    const before = c;
    c = c.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
    c = c.replace(/^\(+\s*/, ''); // subshell
    c = c.replace(/^command\s+-v\s+\S+\s*(>\s*\/dev\/null\s*)?(2>&1\s*)?&&\s*/, ''); // `command -v rg && rg …`
    c = c.replace(/^(sudo|time|env|nohup|command|exec)\s+/, '');
    c = c.replace(/^[A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, '');
    if (c === before) break;
  }
  return c.trim();
}

export function classifyCommand(cmd) {
  const c = stripShell(cmd);
  if (GIT.test(c)) return 'git';
  if (TEST_RUNNER.test(c) || TEST_VIA.test(c)) return 'test';
  if (READ.test(c)) return 'read';
  if (SEARCH.test(c)) return 'search';
  if (WEB.test(c)) return 'web';
  return 'shell';
}

/** `mcp__github__create_pr` / `mcp:github:create_pr` / namespace `mcp__codex_apps__github` */
export function parseMcp(name, namespace) {
  if (namespace && /^mcp__/.test(namespace)) {
    const server = namespace.replace(/^mcp__/, '').split('__').filter(Boolean).pop() || 'mcp';
    return { server, tool: String(name || '').replace(/^_+/, '') };
  }
  const n = String(name || '');
  let m = n.match(/^mcp__(.+?)__(.+)$/);
  if (m) return { server: m[1], tool: m[2] };
  m = n.match(/^mcp[:_](.+?)[:/](.+)$/i);
  if (m) return { server: m[1], tool: m[2] };
  return null;
}

export function pickTarget(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  const keys = ['file_path', 'notebook_path', 'path', 'target_file', 'filePath', 'command', 'cmd', 'pattern', 'query', 'url', 'description', 'prompt', 'skill', 'subject'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && v.length) return v.join(' ');
  }
  return '';
}

/**
 * Classify a tool call. Returns { cat, target, mcp? }.
 * Works for Claude Code, Cursor and Codex tool names (case-insensitive heuristics).
 */
export function classifyTool(name, input = {}, namespace) {
  const raw = String(name ?? '');
  const target = pickTarget(input);
  const mcp = parseMcp(raw, namespace);
  if (mcp) return { cat: 'mcp', target: mcp.tool + (target ? ` ${target}` : ''), mcp: mcp.server };

  const n = raw.toLowerCase();
  const cmd = input && (input.command ?? input.cmd);

  // Shell-ish tools: classify by the command they run.
  if (/^(bash|shell|run_terminal_cmd|terminal|exec_command|local_shell_call|local_shell|container\.exec|run_command|execute_command|powershell|zsh|sh)$/.test(n) ||
      (cmd && /shell|bash|terminal|command|exec/.test(n))) {
    return { cat: classifyCommand(cmd ?? target), target: stripShell(cmd ?? target) };
  }
  if (/^(bashoutput|write_stdin|killshell|killbash|kill_shell|monitor|taskoutput|taskstop)$/.test(n)) return { cat: 'shell', target: target || raw };
  if (n === 'exec') return { cat: 'shell', target: 'script' + (target ? `: ${target}` : '') };

  if (/^(read|notebookread|view_image|read_file|readfile|view|open_file|imageview)$/.test(n) || /^read[_ ]?(file|many|lints?)/.test(n)) return { cat: 'read', target };
  if (/^(write|edit|multiedit|notebookedit|editnotebook|apply_patch|applypatch|str_replace|strreplace|create_file|edit_file|search_replace|delete|delete_file|write_file|filechange)$/.test(n) || /(^|_)(edit|write|patch|replace)(_|$)/.test(n)) return { cat: 'write', target };
  if (/^(webfetch|websearch|web_search|web_search_call|fetch|web_fetch|browse|open_url|search_web)$/.test(n) || /web/.test(n)) return { cat: 'web', target };
  if (/^(grep|glob|ls|list_dir|list_directory|codebase_search|file_search|grep_search|search|find|toolsearch|tool_search|tool_search_call|semantic_search|list_files)$/.test(n) || /(grep|glob|search)/.test(n)) return { cat: 'search', target };
  if (/^(task|agent|spawn_agent|send_message|subagent|run_subagent|launch_agent|teamcreate)$/.test(n) || /subagent/.test(n)) return { cat: 'agent', target: (input && (input.description || input.subagent_type || input.agent_type)) || target };
  if (/^(todowrite|todo_write|update_plan|exitplanmode|enterplanmode|taskcreate|taskupdate|tasklist|taskget|plan)$/.test(n) || /todo|plan/.test(n)) return { cat: 'plan', target: target || raw };
  if (/^(askuserquestion|request_user_input|request_user_input_async|ask_user|ask_followup_question)$/.test(n) || /ask_?user|user_input/.test(n)) return { cat: 'ask', target: target || 'question' };
  return { cat: 'other', target: target || raw };
}

export function shortPath(p, cwd) {
  if (!p) return '';
  let s = String(p).replace(/^file:\/\//, '');
  if (cwd && s.startsWith(cwd + '/')) s = s.slice(cwd.length + 1);
  const home = typeof process !== 'undefined' && process.env && process.env.HOME;
  if (home && s.startsWith(home + '/')) s = '~/' + s.slice(home.length + 1);
  return s;
}

export function clip(s, n = 300) {
  if (s == null) return undefined;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
