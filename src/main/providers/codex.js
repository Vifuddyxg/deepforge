'use strict';
const { crossSpawn } = require('../cross-spawn');

/**
 * Run ONE fresh OpenAI Codex headless session (`codex exec`).
 *
 * Codex is an AGENT like Claude Code — it edits files and runs commands — so it
 * is a true peer to the Claude provider. Every call is a fresh context (no resume),
 * matching DeepForge's freshness guarantee.
 *
 * The prompt is fed via stdin (no positional arg) to avoid ARG_MAX on large briefs.
 * Interface verified against codex 0.x: `codex exec --json` emits JSONL events
 * (thread.started → turn.started → item.completed{agent_message} → turn.completed{usage}).
 */

// Full-autonomy flags — the Codex analog of Claude Code's `--permission-mode
// bypassPermissions`. DeepForge agents must edit files and run commands without
// prompts; this removes the Codex sandbox + approvals. Same trust posture the
// Claude provider already runs under. `--skip-git-repo-check` lets it run before
// the repo is initialised on the very first cycle.
const AUTONOMY_ARGS = ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'];

function isLimitError(text) {
  if (!text) return false;
  return /usage limit|rate.?limit|rate_limit|quota|too many requests|overloaded|insufficient_quota|\b429\b|\b529\b/i.test(String(text));
}

function runCodex({ cwd, prompt, model, timeoutMs = 1000 * 60 * 20, onStderr } = {}) {
  return new Promise((resolve) => {
    const args = ['exec', '--json', ...AUTONOMY_ARGS];
    if (cwd) args.push('--cd', cwd);
    if (model) args.push('--model', model);

    let child;
    try {
      child = crossSpawn('codex', args, { cwd, env: process.env });
    } catch (err) {
      return resolve({ ok: false, error: `spawn failed: ${err.message} (is the codex CLI installed?)`, result: '', cost: 0 });
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
      const parsed = parseCodex(stdout);
      const limited = isLimitError(stderr + ' ' + stdout);
      if (!parsed.result && code !== 0) {
        return resolve({
          ok: false,
          limited,
          error: `codex failed (exit ${code}): ${(stderr || stdout).slice(-500)}`,
          result: '',
          cost: 0,
        });
      }
      resolve({
        ok: code === 0 && !!parsed.result,
        limited,
        error: code === 0 ? null : `codex exit ${code}`,
        result: parsed.result || '',
        sessionId: parsed.threadId || null,
        // Codex `--json` reports token usage, not a dollar cost. We surface tokens
        // for transparency but report cost 0 — the USD budget cap stays Claude-only.
        cost: 0,
        tokens: parsed.tokens || null,
        numTurns: parsed.turns || 0,
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.write(prompt || '');
    child.stdin.end();
  });
}

// Codex prints JSONL events; the final assistant text is the LAST `agent_message`.
function parseCodex(stdout) {
  const out = { result: '', threadId: null, tokens: null, turns: 0 };
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch (_) { continue; }
    if (ev.type === 'thread.started' && ev.thread_id) {
      out.threadId = ev.thread_id;
    } else if (ev.type === 'turn.completed') {
      out.turns++;
      if (ev.usage) out.tokens = ev.usage;
    } else if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
      out.result = ev.item.text; // keep the latest — the final summary message
    }
  }
  return out;
}

module.exports = { runCodex };
