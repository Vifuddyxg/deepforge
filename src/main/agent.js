'use strict';

/**
 * Provider dispatcher — picks which agent backend runs one fresh session.
 *
 * All providers share the SAME return shape so the orchestrator never has to care
 * which one is active:
 *   { ok, limited, error, result, sessionId, cost, numTurns, ... }
 *
 * Providers:
 *   claude  — Claude Code CLI (`claude -p`). Full agent. Default. Honors model,
 *             effort, allowedTools, maxBudgetUsd.
 *   codex   — OpenAI Codex CLI (`codex exec`). Full agent. Honors model.
 *   ollama  — local LLM (`ollama run`). TEXT-ONLY: cannot edit files / use tools
 *             (see providers/ollama.js). Honors model.
 *
 * Unknown options are ignored by providers that don't use them, so the caller can
 * pass the union of fields safely.
 */
const { runClaude } = require('./claude');
const { runCodex } = require('./providers/codex');
const { runOllama } = require('./providers/ollama');

const PROVIDERS = {
  claude: runClaude,
  codex: runCodex,
  ollama: runOllama,
};

function runAgent({ provider = 'claude', ...opts } = {}) {
  const run = PROVIDERS[provider] || runClaude;
  return run(opts);
}

module.exports = { runAgent, PROVIDERS };
