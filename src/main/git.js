'use strict';
const { execFileSync } = require('child_process');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureRepo(cwd) {
  try { git(cwd, ['rev-parse', '--is-inside-work-tree']); }
  catch (_) { git(cwd, ['init', '-q']); }
  try { if (!git(cwd, ['config', 'user.email']).trim()) throw 0; }
  catch (_) { try { git(cwd, ['config', 'user.email', 'deepforge@local']); } catch (_) {} }
  try { if (!git(cwd, ['config', 'user.name']).trim()) throw 0; }
  catch (_) { try { git(cwd, ['config', 'user.name', 'DeepForge']); } catch (_) {} }
}

function hasHead(cwd) {
  try { git(cwd, ['rev-parse', 'HEAD']); return true; } catch (_) { return false; }
}

function hasChanges(cwd) {
  try { return git(cwd, ['status', '--porcelain']).trim().length > 0; } catch (_) { return false; }
}

function currentSha(cwd) {
  try { return git(cwd, ['rev-parse', 'HEAD']).trim(); } catch (_) { return null; }
}

// Stage everything and commit. Returns the new sha, or null if nothing to commit.
function commitAll(cwd, message) {
  try { git(cwd, ['add', '-A']); } catch (_) {}
  let staged = false;
  try { staged = git(cwd, ['diff', '--cached', '--name-only']).trim().length > 0; } catch (_) {}
  if (!staged) return null;
  try { git(cwd, ['commit', '-q', '-m', message]); return currentSha(cwd); } catch (_) { return null; }
}

// Diff (incl. new files) from baseSha to the current working tree, excluding
// orchestrator bookkeeping so the reviewer sees only real product changes.
function captureDiff(cwd, baseSha, maxChars = 24000) {
  try {
    git(cwd, ['add', '-A']);
    const excludes = [':(exclude).orchestrator', ':(exclude)node_modules', ':(exclude)*.lock', ':(exclude)package-lock.json'];
    const args = baseSha
      ? ['diff', '--cached', baseSha, '--', '.', ...excludes]
      : ['diff', '--cached', '--', '.', ...excludes];
    const out = git(cwd, args);
    return out.length > maxChars ? out.slice(0, maxChars) + '\n...[diff truncated]...' : out;
  } catch (_) { return ''; }
}

module.exports = { ensureRepo, hasHead, hasChanges, currentSha, commitAll, captureDiff };
