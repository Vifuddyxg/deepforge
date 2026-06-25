'use strict';
const { crossSpawn } = require('../cross-spawn');

/**
 * Ollama provider — LOCAL LLM, TEXT-ONLY.
 *
 * ⚠️ HONEST LIMITATION — READ THIS:
 * Ollama is a raw text generator, NOT an agent. Unlike the Claude and Codex
 * providers, it CANNOT edit files, run commands, use tools, or commit. It only
 * returns text for the prompt it is given.
 *
 * In DeepForge's loop this means Ollama is only useful for *thinking* roles —
 * e.g. an architect drafting a brief/plan as text. A WORKER backed by Ollama will
 * describe the changes it would make but will NOT actually apply them, so cycles
 * driven by an Ollama worker produce no real file edits. The orchestrator emits a
 * warning when you select ollama for a worker/fix role.
 *
 * Interface: written to the documented `ollama run <model>` stdin→stdout contract.
 * NOTE: not verified on the integration machine (the `ollama` CLI was not installed
 * at the time). If a call fails, confirm `ollama` is on PATH and the model is pulled
 * (`ollama pull <model>`).
 */
function runOllama({ cwd, prompt, model, timeoutMs = 1000 * 60 * 20, onStderr } = {}) {
  return new Promise((resolve) => {
    const m = model || 'llama3';
    let child;
    try {
      child = crossSpawn('ollama', ['run', m], { cwd, env: process.env });
    } catch (err) {
      return resolve({ ok: false, error: `spawn failed: ${err.message} (is the ollama CLI installed?)`, result: '', cost: 0 });
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
      resolve({ ok: false, error: `process error: ${err.message} (is ollama installed and running?)`, result: '', cost: 0 });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        return resolve({ ok: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s`, result: '', cost: 0 });
      }
      const result = stdout.trim();
      resolve({
        ok: code === 0 && !!result,
        limited: false,
        error: code === 0 ? null : `ollama exit ${code}: ${(stderr || '').slice(-300)}`,
        result,
        sessionId: null,
        cost: 0,          // local model — no API cost
        textOnly: true,   // signal: this provider does NOT edit files or use tools
        numTurns: 1,
      });
    });

    child.stdin.on('error', () => {});
    child.stdin.write(prompt || '');
    child.stdin.end();
  });
}

module.exports = { runOllama };
