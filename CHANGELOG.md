# Changelog

## 0.1.1

Fixes from a code review of 0.1.0, each covered by a regression test that fails on 0.1.0.

### Fixed

- **Codex: Vietnamese and other multi-byte text could turn into `�`.** When a read of a rollout
  file ended in the middle of a multi-byte UTF-8 character, that character was decoded in two
  halves. Lines are now split at the byte level and only whole lines are decoded.
  (0.1.0 showed `thêm ti���ng Việt` for `thêm tiếng Việt`.)
- **Codex: a prompt typed twice only showed once.** De-duplication compared text across the last
  40 messages, so a genuine repeat such as "tiếp tục" was swallowed. Now only the copy that newer
  Codex writes through a second channel within 5 seconds is dropped.
- **Fast tool calls could vanish from the map.** Claude Code runs async hooks in parallel, so a
  quick tool's `PostToolUse` sometimes arrived before its `PreToolUse` and the call was ignored.
  The server now holds hook events for about 150 ms and releases them in hook order, always putting
  a call's start before its end. If an end still arrives first, the call is recorded as finished
  (counted, shown in the timeline and sequence diagram) instead of being dropped.
- **`npm run lint:check` and `cargo check` were shown in the Test Lab.** "check" no longer counts as
  a test command.

### Changed

- **Codex watcher memory stays flat.** Rollout files that stay quiet for 30 minutes drop their
  parser state and keep only their read offset; they resume from that offset when Codex writes
  again, so nothing is missed.
- **Codex history sweep backs off.** The sweep that catches resumed sessions in old day folders now
  skips files it already tracks and runs less often as your history grows (every 15 s to 2 min).
- **Accurate safety notes.** The README and code comments now say plainly that web pages are
  blocked but local programs are not, and that Claude's `PermissionRequest` hook is async and
  cannot approve or deny anything.

## 0.1.0

First release: live chibi architecture map, sequence diagram and timeline; Claude Code plugin,
Cursor and Claude installers, Codex rollout watcher, VS Code / Cursor extension, and the Electron
desktop app.
