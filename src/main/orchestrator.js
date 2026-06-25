'use strict';
const { EventEmitter } = require('events');
const state = require('./state');
const git = require('./git');
const gates = require('./gates');
const prompts = require('./prompts');
const { runAgent } = require('./agent');

// --- Model routing: pick the smallest capable model per task, for efficiency ---
// The architect classifies each task's complexity; the worker runs on the matching tier.
const TIERS = {
  trivial: { model: 'claude-haiku-4-5', effort: 'low' },
  standard: { model: 'claude-sonnet-4-6', effort: 'medium' },
  complex: { model: 'claude-opus-4-8', effort: 'high' }
};
// Fixed roles: planning needs the strongest model; compaction is mechanical.
const ROLE_DEFAULTS = {
  architect: { model: 'claude-opus-4-8', effort: 'high' },
  reviewer: { model: 'claude-sonnet-4-6', effort: 'medium' },
  compactor: { model: 'claude-haiku-4-5', effort: 'low' }
};

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  try { return JSON.parse(t); } catch (_) {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function briefMarkdown(id, task) {
  return `# ${id} — ${task.title}\n\n` +
    `- **Capability:** ${task.capability}\n` +
    `- **Complexity:** ${task.complexity || 'standard'}\n` +
    `- **Rationale:** ${task.rationale || ''}\n` +
    `- **Depth note:** ${task.depth_note || ''}\n\n` +
    `## Files\n${(task.files || []).map((f) => `- \`${f}\``).join('\n')}\n\n` +
    `## Contracts\n${task.contracts || 'none'}\n\n` +
    `## Brief\n${task.brief}\n\n` +
    `## Acceptance criteria\n${(task.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`;
}

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.stopRequested = false;
    this.projectPath = null;
    this.config = {};
    this.cycle = 0;
    this.totalCost = 0;
  }

  log(level, msg, extra) { this.emit('log', { level, msg, ts: Date.now(), ...(extra || {}) }); }
  status(s) { this.emit('status', s); }
  account(out) {
    if (out && out.cost) { this.totalCost += out.cost; this.emit('cost', { total: this.totalCost, last: out.cost }); }
  }
  budget() { const b = this.config.maxBudgetUsdPerAgent; return b && b > 0 ? b : undefined; }

  // Decide which model + effort a given role/task should use.
  route(role, task) {
    if (this.config.model) return { model: this.config.model, effort: this.config.effort || 'high' };
    if (this.config.autoRoute === false) return { model: undefined, effort: this.config.effort || 'high' };
    if (role === 'worker' || role === 'fix') {
      const tier = (task && task.complexity) || 'standard';
      return TIERS[tier] || TIERS.standard;
    }
    const def = ROLE_DEFAULTS[role] || { model: undefined, effort: 'high' };
    // Optional per-role overrides (config) so token cost can be tuned WITHOUT code
    // edits. Empty/unset keeps the quality default (architect=Opus, reviewer=Sonnet).
    const modelKey = { architect: 'architectModel', reviewer: 'reviewerModel', compactor: 'compactorModel' }[role];
    const effortKey = { architect: 'architectEffort', reviewer: 'reviewerEffort' }[role];
    return {
      model: (modelKey && this.config[modelKey]) || def.model,
      effort: (effortKey && this.config[effortKey]) || def.effort
    };
  }

  // Run one fresh Claude session for a role, with routed model/effort.
  async runRole(role, { prompt, allowedTools, timeoutMs, task }) {
    const r = this.route(role, task);
    const provider = this.config.provider || 'claude';
    // route()'s default models (claude-opus-4-8, …) are Claude-specific. For other
    // providers only honor an explicit user-set model; otherwise let that CLI pick
    // its own default rather than handing it a Claude model name it can't resolve.
    const model = provider === 'claude' ? r.model : (this.config.model || undefined);
    this.log('route', `${role}: ${provider}:${model || 'default'} · effort ${r.effort}`);
    if (provider === 'ollama' && (role === 'worker' || role === 'fix')) {
      this.log('warn', 'Provider "ollama" is TEXT-ONLY: it cannot edit files or run tools, so this worker will not apply real changes. Use ollama only for planning, or switch to claude/codex for workers.');
    }
    const out = await runAgent({
      provider,
      cwd: this.projectPath,
      prompt,
      allowedTools,
      maxBudgetUsd: this.budget(),
      model,
      effort: r.effort,
      timeoutMs
    });
    this.account(out);
    if (out && out.limited && !this.stopRequested) {
      this.log('warn', 'Claude usage/rate limit reached — stopping cleanly. Resumes after your subscription window resets (no charge on a subscription).');
      this.stopRequested = true;
      this.status('stopping');
    }
    return out;
  }

  async start(projectPath, mode) {
    if (this.running) return;
    this.projectPath = projectPath;
    this.mode = mode === 'roadmap' ? 'roadmap' : 'allday';
    this.running = true;
    this.stopRequested = false;
    this.cycle = 0;
    this.totalCost = 0;

    git.ensureRepo(projectPath);
    state.ensure(projectPath);
    this.config = state.readConfig(projectPath);
    if (!git.hasHead(projectPath)) git.commitAll(projectPath, 'deepforge: initialize orchestrator state');

    // Recover orphaned work: a task left "doing" by a previous interrupted run
    // never reached its commit, and the architect only ever sees todo/blocked —
    // so it would be silently lost. Re-queue it so nothing vanishes on a restart.
    const recoverPlan = state.readPlan(projectPath);
    const orphaned = recoverPlan.tasks.filter((t) => t.status === 'doing');
    if (orphaned.length) {
      for (const t of orphaned) t.status = 'todo';
      state.writePlan(projectPath, recoverPlan);
      this.log('info', `Recovered ${orphaned.length} interrupted task(s) from a previous run → re-queued for the architect.`);
    }

    this.status('running');
    this.log('info', `Run started on ${projectPath} · mode: ${this.mode === 'roadmap' ? 'finish the whole roadmap' : 'work all day'}`);
    this.emit('plan', state.readPlan(projectPath));

    try {
      await this.loop();
    } catch (e) {
      this.log('error', `Loop crashed: ${e && e.message}`);
    } finally {
      this.running = false;
      this.writeHandoff();
      this.status('stopped');
      this.log('info', `Run stopped. Cycles: ${this.cycle} · Est. usage ~$${this.totalCost.toFixed(2)} (subscription: not a real charge)`);
    }
  }

  requestStop() {
    if (!this.running) return;
    this.stopRequested = true;
    this.status('stopping');
    this.log('info', 'Stop requested — finishing the current cycle cleanly...');
  }

  async loop() {
    const maxCycles = this.config.maxCyclesPerRun || 0;
    const maxRunUsd = this.config.maxRunUsd || 0; // self-imposed estimated-usage ceiling per run (0 = off)
    const compactEvery = this.config.compactEvery || 10;
    while (!this.stopRequested) {
      if (maxCycles && this.cycle >= maxCycles) { this.log('info', `Reached maxCyclesPerRun=${maxCycles}.`); break; }
      if (maxRunUsd && this.totalCost >= maxRunUsd) { this.log('warn', `Reached run usage ceiling ~$${maxRunUsd} estimated — stopping before consuming more of your limit.`); break; }
      const keepGoing = await this.runCycle();
      if (!keepGoing) break;
      if (compactEvery && this.cycle > 0 && this.cycle % compactEvery === 0 && !this.stopRequested) {
        await this.compact();
      }
    }
  }

  async runCycle() {
    this.cycle++;
    const pp = this.projectPath;
    this.config = state.readConfig(pp); // re-read so live config edits apply
    this.log('info', `── Cycle ${this.cycle} ──`);

    const directives = state.drainDirectives(pp);
    if (directives) this.log('info', `Applying directives: ${directives.slice(0, 200)}`);

    // 1. ARCHITECT (fresh, read-only) decides + classifies the next task
    this.emit('phase', 'architect');
    this.log('agent', 'Architect deciding next task (fresh context)...');
    const plan = state.readPlan(pp);
    const architectArgs = {
      prompt: prompts.architectPrompt({
        productGoal: this.config.productGoal,
        roadmap: state.read(pp, 'ROADMAP.md'),
        plan,
        state: state.read(pp, 'STATE.md'),
        decisions: state.read(pp, 'DECISIONS.md'),
        directives,
        depthFirst: this.config.depthFirst !== false,
        finishRoadmap: this.mode === 'roadmap'
      }),
      allowedTools: ['Read', 'Grep', 'Glob'],
      timeoutMs: 1000 * 60 * 12
    };
    // Retry once on a transient failure / unparseable decision before giving up,
    // so one bad response can't end an all-day run. A usage-limit stop is not transient.
    let archOut = null;
    let decision = null;
    for (let attempt = 1; attempt <= 2 && !this.stopRequested; attempt++) {
      archOut = await this.runRole('architect', architectArgs);
      if (this.stopRequested) return false;
      if (!archOut.ok) {
        this.log('error', `Architect failed: ${archOut.error}`);
        if (archOut.limited) return false;
        continue;
      }
      decision = extractJson(archOut.result);
      if (decision) break;
      this.log('warn', `Architect returned unparseable decision (try ${attempt}/2)${attempt < 2 ? '; retrying fresh...' : '.'}`);
    }
    if (!decision) { this.log('error', 'Architect produced no usable decision after retries; stopping.'); return false; }

    if (Array.isArray(decision.roadmap_additions) && decision.roadmap_additions.length) {
      if (this.mode === 'roadmap') {
        this.log('info', `Ignoring ${decision.roadmap_additions.length} roadmap addition(s) — finish-roadmap mode sticks to the existing roadmap.`);
      } else {
        const rm = state.read(pp, 'ROADMAP.md') + '\n' + decision.roadmap_additions.map((s) => `- ${s}`).join('\n') + '\n';
        state.write(pp, 'ROADMAP.md', rm);
        this.log('info', `Roadmap extended (+${decision.roadmap_additions.length}).`);
        this.emitFiles();
      }
    }
    if (decision.state_update && typeof decision.state_update === 'string') {
      state.write(pp, 'STATE.md', decision.state_update);
      this.emitFiles();
    }

    if (decision.action === 'done') { this.log('success', `Architect: DONE — ${decision.reason || ''}`); this.status('done'); return false; }
    if (decision.action === 'blocked') { this.log('warn', `Architect: BLOCKED — ${decision.reason || ''}`); this.status('blocked'); return false; }
    if (decision.action === 'extend_roadmap') { this.log('info', 'Roadmap extended; next cycle picks a task.'); return true; }

    const task = decision.task;

    // 2. BRIEF GATE — reject vague tasks before burning a worker
    const bg = gates.briefGate(task);
    if (!bg.ok) {
      this.log('warn', `Brief rejected: ${bg.reasons.join('; ')} — re-deciding next cycle.`);
      state.logCycle(pp, { cycle: this.cycle, event: 'brief_rejected', reasons: bg.reasons });
      return true;
    }

    const full = state.readPlan(pp);
    const id = `task-${String(full.nextId).padStart(3, '0')}`;
    full.nextId++;
    const rec = {
      id, title: task.title, capability: task.capability,
      complexity: task.complexity || 'standard', status: 'doing', files: task.files, created: Date.now()
    };
    full.tasks.push(rec);
    state.writePlan(pp, full);
    state.write(pp, `briefs/${id}.md`, briefMarkdown(id, task));
    this.emit('plan', full);
    this.log('agent', `${id}: ${task.title}  [${rec.complexity}]`);

    const baseSha = git.currentSha(pp);

    // 3. WORKER (fresh, routed model) implements the task
    this.emit('phase', 'worker');
    this.log('agent', `Worker implementing ${id} (fresh context)...`);
    const wOut = await this.runRole('worker', {
      task,
      prompt: prompts.workerPrompt({ productGoal: this.config.productGoal, task, state: state.read(pp, 'STATE.md') }),
      allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
      timeoutMs: 1000 * 60 * 25
    });
    if (!wOut.ok) this.log('warn', `Worker reported error: ${wOut.error}`);

    // 4. OBJECTIVE GATES — hallucination dies here
    this.emit('phase', 'gates');
    this.log('info', 'Running objective gates...');
    let gate = gates.run(pp, this.config, (m) => this.log('gate', m));
    this.log(gate.skipped ? 'warn' : (gate.pass ? 'success' : 'warn'),
      `Gates: ${gate.skipped ? 'skipped (' + gate.note + ')' : (gate.pass ? 'PASS' : 'FAIL')}`);

    let attempts = 0;
    while (!gate.pass && !gate.skipped && attempts < 2 && !this.stopRequested) {
      attempts++;
      this.emit('phase', 'fix');
      this.log('agent', `Fix attempt ${attempts} for ${id} (fresh worker)...`);
      await this.runRole('fix', {
        task,
        prompt: prompts.fixPrompt({ task, issues: [], gateResults: gate }),
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        timeoutMs: 1000 * 60 * 20
      });
      gate = gates.run(pp, this.config, (m) => this.log('gate', m));
      this.log(gate.pass ? 'success' : 'warn', `Gates after fix ${attempts}: ${gate.pass ? 'PASS' : 'FAIL'}`);
    }

    if (!gate.pass && !gate.skipped) {
      rec.status = 'blocked';
      this.updateTask(pp, rec);
      const sha = git.commitAll(pp, `${id}: ${task.title} [BLOCKED: gates failing]`);
      this.log('error', `${id} BLOCKED after ${attempts} fix attempts${sha ? ' (committed ' + sha.slice(0, 8) + ' for inspection)' : ''}.`);
      state.appendDecision(pp, `\n## ${id} — ${task.title} [BLOCKED]\n- Gates failed after ${attempts} fix attempts. Needs human or architect re-plan.\n`);
      state.logCycle(pp, { cycle: this.cycle, task: id, event: 'blocked_gates' });
      this.emit('plan', state.readPlan(pp));
      this.emitFiles();
      return true;
    }

    // 5. REVIEWER (fresh) — skipped for trivial mechanical tasks the architect flagged
    const diff = git.captureDiff(pp, baseSha);
    const skipReview = this.config.autoRoute !== false && task.skip_review === true;
    let review = { verdict: 'pass', issues: [], summary: skipReview ? 'review skipped (trivial)' : 'no diff to review' };
    if (skipReview) {
      this.log('info', `Reviewer skipped for ${id} (trivial mechanical task).`);
    } else if (diff && diff.trim()) {
      this.emit('phase', 'review');
      this.log('agent', 'Independent reviewer checking depth/completeness (fresh)...');
      const rOut = await this.runRole('reviewer', {
        prompt: prompts.reviewerPrompt({ task, diff, gateResults: gate }),
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
        timeoutMs: 1000 * 60 * 12
      });
      const rv = extractJson(rOut.result);
      if (rv && rv.verdict) review = rv;
      this.log(review.verdict === 'pass' ? 'success' : 'warn', `Reviewer: ${review.verdict} — ${review.summary || ''}`);
    } else {
      this.log('warn', `No file changes detected for ${id}.`);
    }

    if (review.verdict === 'reopen' && Array.isArray(review.issues) && review.issues.length && !this.stopRequested) {
      this.emit('phase', 'fix');
      this.log('agent', `Worker addressing ${review.issues.length} reviewer issue(s) (fresh)...`);
      await this.runRole('fix', {
        task,
        prompt: prompts.fixPrompt({ task, issues: review.issues, gateResults: gate }),
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        timeoutMs: 1000 * 60 * 20
      });
      gate = gates.run(pp, this.config, () => {});
      if (!gate.pass && !gate.skipped) {
        rec.status = 'blocked';
        this.updateTask(pp, rec);
        const bsha = git.commitAll(pp, `${id}: ${task.title} [BLOCKED: gates regressed after review-fix]`);
        this.log('error', `${id} BLOCKED: gates regressed after reviewer-fix${bsha ? ' (committed ' + bsha.slice(0, 8) + ' for inspection)' : ''}.`);
        state.appendDecision(pp, `\n## ${id} — ${task.title} [BLOCKED]\n- Gates regressed after reviewer-fix. Needs human or architect re-plan.\n`);
        state.logCycle(pp, { cycle: this.cycle, task: id, event: 'blocked_review_regress' });
        this.emit('plan', state.readPlan(pp));
        this.emitFiles();
        return true;
      }
    }

    // 6. INTEGRATE — commit + record decision
    const sha = git.commitAll(pp, `${id}: ${task.title}`);
    if (sha) this.log('success', `Committed ${id} (${sha.slice(0, 8)})`);
    rec.status = 'done';
    rec.completed = Date.now();
    this.updateTask(pp, rec);
    state.appendDecision(pp,
      `\n## ${id} — ${task.title}\n- Capability: ${task.capability}\n- Complexity: ${rec.complexity}\n- Rationale: ${task.rationale || ''}\n- Reviewer: ${review.summary || review.verdict}\n`);
    state.logCycle(pp, { cycle: this.cycle, task: id, event: 'done', cost: this.totalCost });
    this.emitFiles();
    this.log('success', `Cycle ${this.cycle} complete. Est. usage so far ~$${this.totalCost.toFixed(2)} (subscription: not a real charge)`);
    return true;
  }

  updateTask(pp, rec) {
    const plan = state.readPlan(pp);
    const idx = plan.tasks.findIndex((t) => t.id === rec.id);
    if (idx >= 0) plan.tasks[idx] = rec;
    state.writePlan(pp, plan);
    this.emit('plan', plan);
  }

  async compact() {
    const pp = this.projectPath;
    this.emit('phase', 'compact');
    this.log('info', 'Compacting state (anti-rot)...');
    const out = await this.runRole('compactor', {
      prompt: prompts.compactorPrompt({
        state: state.read(pp, 'STATE.md'),
        decisions: state.read(pp, 'DECISIONS.md'),
        plan: state.readPlan(pp)
      }),
      allowedTools: ['Read'],
      timeoutMs: 1000 * 60 * 10
    });
    const j = extractJson(out.result);
    if (!j || (typeof j.state !== 'string' && typeof j.decisions !== 'string')) {
      this.log('warn', 'Compaction produced no valid state; skipping write — existing memory preserved.');
      return;
    }
    // STATE.md / DECISIONS.md are the source of truth across fresh contexts.
    // Validate non-trivial output and back up (.bak) before overwriting, so a
    // bad compaction can never silently destroy accumulated memory.
    if (typeof j.state === 'string' && j.state.trim().length >= 40) {
      state.write(pp, 'STATE.md.bak', state.read(pp, 'STATE.md'));
      state.write(pp, 'STATE.md', j.state);
    } else {
      this.log('warn', 'Compaction state too short/empty; kept previous STATE.md.');
    }
    if (typeof j.decisions === 'string' && j.decisions.trim().length >= 20) {
      state.write(pp, 'DECISIONS.md.bak', state.read(pp, 'DECISIONS.md'));
      state.write(pp, 'DECISIONS.md', j.decisions);
    }
    this.emitFiles();
    this.log('success', 'State compacted (previous kept as .bak).');
  }

  emitFiles() {
    if (!this.projectPath) return;
    this.emit('files', {
      roadmap: state.read(this.projectPath, 'ROADMAP.md'),
      state: state.read(this.projectPath, 'STATE.md'),
      decisions: state.read(this.projectPath, 'DECISIONS.md'),
      session: state.read(this.projectPath, 'SESSION.md')
    });
  }

  writeHandoff() {
    if (!this.projectPath) return;
    const plan = state.readPlan(this.projectPath);
    const by = (s) => plan.tasks.filter((t) => t.status === s);
    const todo = by('todo');
    const md = `# Session Handoff\n\n` +
      `- Cycles this session: ${this.cycle}\n` +
      `- Spend this session: $${this.totalCost.toFixed(3)}\n` +
      `- Done: ${by('done').length} · In-flight: ${by('doing').length} · Blocked: ${by('blocked').length}\n\n` +
      `## Next up\n${todo.slice(0, 5).map((t) => `- ${t.id}: ${t.title}`).join('\n') || '- (architect will decide)'}\n\n` +
      `Press Start to continue — agents reconstruct everything from \`.orchestrator/\`. Nothing is lost.\n`;
    state.write(this.projectPath, 'SESSION.md', md);
    this.emitFiles();
  }
}

module.exports = new Orchestrator();
