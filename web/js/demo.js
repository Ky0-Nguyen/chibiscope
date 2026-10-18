// A scripted ~50s show with three agents working at once. Pure data so both
// the browser (▶ Demo button) and `chibiscope demo` (posts to the server) use it.

// Session ids are fixed so replaying the demo starts a new turn for the same
// three chibis; call ids get a per-run tag so they never collide.
export function demoTimeline(tag = Math.random().toString(36).slice(2, 7)) {
  const out = [];
  let n = 0;
  const S = {
    claude: { source: 'claude', session: 'demo:claude', cwd: '/demo/shop-api' },
    codex: { source: 'codex', session: 'demo:codex', cwd: '/demo/mobile-app' },
    cursor: { source: 'cursor', session: 'demo:cursor', cwd: '/demo/landing-web' },
  };
  const at = (t, who, ev) => out.push({ at: t, ev: { ...S[who], ...ev, meta: { ...(ev.meta || {}), demo: true } } });
  const tool = (t, who, cat, tool, target, dur, extra = {}) => {
    const call = `demo-${tag}-${++n}`;
    at(t, who, { type: 'tool.start', call, cat, tool, target, ...extra });
    at(t + dur, who, { type: 'tool.end', call, cat, tool, target, ok: extra.ok !== false, ms: dur, ...extra });
    return t + dur;
  };

  // ---- Claude Code: feature + tests + PR
  at(0, 'claude', { type: 'session.start' });
  at(300, 'claude', { type: 'prompt', text: 'Add rate limiting to the checkout API and cover it with tests' });
  tool(1500, 'claude', 'plan', 'TodoWrite', '4 todos', 500);
  tool(2400, 'claude', 'search', 'Grep', 'checkout', 900);
  tool(3600, 'claude', 'read', 'Read', 'src/routes/checkout.ts', 1100);
  tool(5000, 'claude', 'read', 'Read', 'src/middleware/index.ts', 900);
  tool(6300, 'claude', 'web', 'WebFetch', 'https://expressjs.com/en/advanced/best-practice-security', 1800);
  tool(8400, 'claude', 'agent', 'Task', 'Explore existing Redis usage', 7000);
  at(8800, 'claude', { type: 'agent.start', agent: `explore-${tag}`, agentType: 'Explore', text: 'Explore existing Redis usage' });
  tool(9300, 'claude', 'search', 'Glob', '**/*redis*', 900, { agent: `explore-${tag}`, agentType: 'Explore' });
  tool(10500, 'claude', 'read', 'Read', 'src/lib/redis.ts', 1200, { agent: `explore-${tag}`, agentType: 'Explore' });
  tool(12000, 'claude', 'read', 'Read', 'config/redis.yml', 900, { agent: `explore-${tag}`, agentType: 'Explore' });
  tool(13200, 'claude', 'search', 'Grep', 'createClient', 1000, { agent: `explore-${tag}`, agentType: 'Explore' });
  at(15000, 'claude', { type: 'agent.end', agent: `explore-${tag}`, agentType: 'Explore', ok: true, text: 'Redis client lives in src/lib/redis.ts' });
  tool(16200, 'claude', 'write', 'Write', 'src/middleware/rateLimit.ts', 1600);
  tool(18200, 'claude', 'write', 'Edit', 'src/routes/checkout.ts', 1200);
  tool(19800, 'claude', 'write', 'Write', 'test/rateLimit.test.ts', 1400);
  tool(21600, 'claude', 'test', 'Bash', 'npm test -- rateLimit', 3200, { ok: false, text: '1 failing: expected 429' });
  at(25000, 'claude', { type: 'think', text: 'The window resets too early — use a sliding window' });
  tool(26200, 'claude', 'write', 'Edit', 'src/middleware/rateLimit.ts', 1100);
  tool(27800, 'claude', 'test', 'Bash', 'npm test -- rateLimit', 2800);
  tool(31000, 'claude', 'git', 'Bash', 'git checkout -b feat/rate-limit && git commit -am "rate limit"', 1300);
  tool(32800, 'claude', 'mcp', 'mcp__github__create_pull_request', 'create_pull_request', 2200, { mcp: 'github' });
  at(35500, 'claude', { type: 'turn.end', ok: true, text: 'Rate limiting added, tests green, PR opened.' });

  // ---- Codex: bug hunt with shell-first habits
  at(2000, 'codex', { type: 'session.start' });
  at(2600, 'codex', { type: 'prompt', text: 'Fix the crash on the login screen when the token expires' });
  at(3800, 'codex', { type: 'think', text: 'Locate LoginScreen and the token refresh path' });
  tool(5200, 'codex', 'search', 'exec_command', 'rg -n "LoginScreen" src', 1100);
  tool(6800, 'codex', 'read', 'exec_command', "sed -n '1,160p' src/screens/LoginScreen.tsx", 900);
  tool(8200, 'codex', 'read', 'exec_command', 'cat src/auth/refreshToken.ts', 800);
  at(9400, 'codex', { type: 'say', text: 'Found it: refreshToken() returns undefined on 401.' });
  tool(10800, 'codex', 'web', 'web_search', 'react-native secure store token refresh race condition', 2400);
  tool(13800, 'codex', 'write', 'apply_patch', 'src/auth/refreshToken.ts, src/screens/LoginScreen.tsx', 1700);
  tool(16200, 'codex', 'test', 'exec_command', 'pnpm jest src/auth', 3600);
  tool(20400, 'codex', 'git', 'exec_command', 'git diff --stat', 700);
  tool(21800, 'codex', 'plan', 'update_plan', 'mark fix done', 500);
  at(22800, 'codex', { type: 'turn.end', ok: true, text: 'Login no longer crashes; added a guard + test.' });

  // ---- Cursor: UI tweak that needs approval
  at(4000, 'cursor', { type: 'session.start' });
  at(4600, 'cursor', { type: 'prompt', text: 'Make the hero section responsive on mobile' });
  at(5600, 'cursor', { type: 'think', text: 'Hero uses fixed widths — switch to clamp() + grid' });
  tool(7000, 'cursor', 'read', 'Read', 'app/components/Hero.tsx', 1000);
  tool(8600, 'cursor', 'mcp', 'mcp__figma__get_design_context', 'get_design_context', 2000, { mcp: 'figma' });
  tool(11200, 'cursor', 'write', 'Edit', 'app/components/Hero.tsx', 1500);
  tool(13200, 'cursor', 'write', 'Edit', 'app/globals.css', 900);
  at(14600, 'cursor', { type: 'wait', text: 'Allow running: npm run build?' });
  tool(19000, 'cursor', 'shell', 'Shell', 'npm run build', 4200);
  at(23800, 'cursor', { type: 'say', text: 'Hero now stacks under 640px and scales fonts with clamp().' });
  at(24600, 'cursor', { type: 'turn.end', ok: true, text: 'Responsive hero shipped.' });

  return out.sort((a, b) => a.at - b.at);
}

/** Schedule the timeline. `emit(event)` receives each event with a fresh ts. Returns a cancel fn. */
export function playDemo(emit, { speed = 1, tag } = {}) {
  const timers = demoTimeline(tag).map(({ at, ev }) => setTimeout(() => emit({ ...ev, ts: Date.now() }), at / speed));
  return () => timers.forEach(clearTimeout);
}
