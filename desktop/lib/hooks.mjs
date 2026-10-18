// Hook installation for the desktop app. The machine may have no Node.js, so
// the hooks run the bridge with the app's own Electron binary
// (ELECTRON_RUN_AS_NODE=1), falling back from a system Node if one exists.
// Scripts live in ~/.chibiscope/hooks so they survive app moves and updates;
// the launcher is rewritten on every app start with the current binary path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOOK_HOME = path.join(os.homedir(), '.chibiscope', 'hooks');
const isWin = process.platform === 'win32';
export const LAUNCHER = path.join(HOOK_HOME, isWin ? 'chibiscope-hook.cmd' : 'chibiscope-hook');

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function launcherScript(appExe) {
  if (isWin) {
    return [
      '@echo off',
      'rem ChibiScope hook launcher (written by the desktop app). Never fails the agent.',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${appExe}" "%~dp0emit.mjs" %*`,
      'exit /b 0',
      '',
    ].join('\r\n');
  }
  return `#!/bin/sh
# ChibiScope hook launcher (written by the desktop app). Never fails the agent.
DIR="\${0%/*}"
APP=${shQuote(appExe)}
for c in "$CHIBISCOPE_NODE" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then exec "$c" "$DIR/emit.mjs" "$@"; fi
done
if [ -x "$APP" ]; then ELECTRON_RUN_AS_NODE=1 exec "$APP" "$DIR/emit.mjs" "$@"; fi
input="$(cat)"
if [ "$1" = "cursor" ]; then
  case "$input" in *beforeSubmitPrompt*) printf '{"continue":true}' ;; *) printf '{}' ;; esac
fi
exit 0
`;
}

/** Copy the bridge and (re)write the launcher. Safe to call on every start. */
export function writeHookFiles({ coreDir, appExe }) {
  fs.mkdirSync(HOOK_HOME, { recursive: true });
  // .mjs so it runs as ESM without a package.json next to it
  fs.copyFileSync(path.join(coreDir, 'hooks', 'emit.js'), path.join(HOOK_HOME, 'emit.mjs'));
  fs.writeFileSync(LAUNCHER, launcherScript(appExe), { mode: 0o755 });
  return LAUNCHER;
}

export function hookCommandFor(source) {
  return isWin ? `"${LAUNCHER}" ${source} --chibiscope` : `/bin/sh "${LAUNCHER}" ${source} --chibiscope`;
}

/** Status of each integration, using the shared installer module. */
export function hookStatus(installer) {
  const s = installer.status();
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  return {
    claude: { ...s.claude, viaApp: read(s.claude.file).includes(LAUNCHER) },
    cursor: { ...s.cursor, viaApp: read(s.cursor.file).includes(LAUNCHER) },
    codex: s.codex,
  };
}

export function installHooks(installer, target, ctx) {
  writeHookFiles(ctx);
  return installer.install(target, { command: hookCommandFor(target) });
}

export function removeHooks(installer, target) {
  return installer.uninstall(target);
}
