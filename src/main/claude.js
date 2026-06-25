'use strict';
const { crossSpawn } = require('./cross-spawn');

/**
 * Run ONE fresh Claude Code headless session.
 *
 * The whole point of DeepForge: every call here is a brand-new context
 * (no --resume), so each task runs with a clean, uncluttered window.
 * Freshness is guaranteed structurally, not hoped for.
 *
 * The prompt is fed via stdin to avoid ARG_MAX limits on large briefs/state.
 */
// Detect a subscription usage-limit / rate-limit / overload condition in CLI
// output, so the orchestrator can stop the run cleanly instead of spinning.
function isLimitError(text) {
  if (!text) return false;
  return /usage limit|rate.?limit|rate_limit|quota|too many requests|overloaded|resets? at|out of (credit|token)|\b429\b|\b529\b/i.test(String(text));
}

function runClaude({
  cwd,
  prompt,
  allowedTools,
  disallowedTools,
  maxBudgetUsd,
  model,
  effort,
  timeoutMs = 1000 * 60 * 20,
  onStderr,
} = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    if (Array.isArray(allowedTools) && allowedTools.length) args.push('--allowedTools', ...allowedTools);
    if (Array.isArray(disallowedTools) && disallowedTools.length) args.push('--disallowedTools', ...disallowedTools);
    if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    let child;
    try {
      child = crossSpawn('claude', args, { cwd, env: process.env });
    } catch (err) {
      return resolve({ ok: false, error: `spawn failed: ${err.message}`, result: '', cost: 0 });
    }

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `process error: ${err.message}`, result: '', cost: 0 });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        return resolve({ ok: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s`, result: '', cost: 0 });
      }
      const parsed = parseResult(stdout);
      if (!parsed) {
        return resolve({
          ok: false,
          limited: isLimitError(stderr || stdout),
          error: `unparseable output (exit ${code}): ${(stderr || stdout).slice(-500)}`,
          result: '',
          cost: 0,
        });
      }
      const errText = parsed.is_error ? (parsed.result || '') : '';
      resolve({
        ok: !parsed.is_error,
        limited: parsed.is_error ? isLimitError(errText + ' ' + stderr) : false,
        error: parsed.is_error ? (parsed.result || 'claude returned is_error') : null,
        result: parsed.result || '',
        sessionId: parsed.session_id || null,
        cost: parsed.total_cost_usd || 0,
        numTurns: parsed.num_turns || 0,
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.write(prompt || '');
    child.stdin.end();
  });
}

// The success object is a single JSON line; tolerate stray output around it.
function parseResult(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && obj.type === 'result') return obj;
  } catch (_) {}
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === 'result') return obj;
    } catch (_) {}
  }
  return null;
}

module.exports = { runClaude };
