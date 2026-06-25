'use strict';
const { spawn } = require('child_process');

/**
 * Cross-platform child-process spawn.
 *
 * WHY THIS EXISTS — Windows support.
 * npm-installed CLIs (claude, codex) land on Windows as `.cmd` shim scripts, not
 * native `.exe` files. Node's CreateProcess cannot launch a `.cmd` directly, so a
 * plain `spawn('claude', …)` throws ENOENT on Windows. Routing through the shell on
 * win32 lets cmd.exe resolve `.cmd`/`.exe`/`.bat` via PATHEXT. On macOS/Linux we keep
 * `shell:false` (no quoting surprises, safer).
 *
 * SAFETY: prompts are ALWAYS passed via stdin, never argv, so argv stays simple
 * flag/value pairs — there is no user free-text on the command line to escape.
 */
function crossSpawn(command, args = [], options = {}) {
  return spawn(command, args, {
    windowsHide: true,
    ...options,
    shell: process.platform === 'win32' ? true : (options.shell || false),
  });
}

/** Same idea for execFile callers (the `--version` connectivity checks). */
function shellOnWin(options = {}) {
  return { ...options, shell: process.platform === 'win32' };
}

module.exports = { crossSpawn, shellOnWin };
