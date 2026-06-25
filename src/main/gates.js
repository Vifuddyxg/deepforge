'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Objective verification gates. This is where hallucination dies: a task is
// only "done" if real commands pass — never because an agent claimed success.
function detect(cwd, config) {
  const g = (config && config.gates) || {};
  let scripts = {};
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try { scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts || {}; } catch (_) {}
  }
  const hasCargo = fs.existsSync(path.join(cwd, 'Cargo.toml'));
  const hasTsconfig = fs.existsSync(path.join(cwd, 'tsconfig.json'));
  const hasGo = fs.existsSync(path.join(cwd, 'go.mod'));
  const hasPytest = fs.existsSync(path.join(cwd, 'pytest.ini')) ||
    fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
    fs.existsSync(path.join(cwd, 'tests'));

  const resolve = (key, autoFn) => {
    const v = g[key];
    if (v === '' || v === 'off' || v === false || v === null) return null; // disabled — check FIRST
    if (v && v !== 'auto') return v;                 // explicit command string
    return autoFn();                                 // 'auto' or undefined → detect
  };

  const gates = [];
  const typecheck = resolve('typecheck', () => {
    if (scripts.typecheck) return 'npm run typecheck --silent';
    if (hasTsconfig) return 'npx --no-install tsc --noEmit';
    return null;
  });
  const build = resolve('build', () => {
    if (scripts.build) return 'npm run build --silent';
    if (hasCargo) return 'cargo build --quiet';
    if (hasGo) return 'go build ./...';
    return null;
  });
  const test = resolve('test', () => {
    if (scripts.test) return 'npm test --silent';
    if (hasCargo) return 'cargo test --quiet';
    if (hasGo) return 'go test ./...';
    if (hasPytest) return 'python -m pytest -q';
    return null;
  });

  if (typecheck) gates.push({ name: 'typecheck', cmd: typecheck });
  if (build) gates.push({ name: 'build', cmd: build });
  if (test) gates.push({ name: 'test', cmd: test });
  return gates;
}

function run(cwd, config, onLog) {
  const gates = detect(cwd, config);
  if (!gates.length) {
    return {
      pass: true, skipped: true, results: [],
      note: 'no gates detected — set gates.{test,build,typecheck} in .orchestrator/config.json to enable real verification'
    };
  }
  const results = [];
  let allPass = true;
  for (const gate of gates) {
    if (onLog) onLog(`${gate.name}: ${gate.cmd}`);
    try {
      const out = execSync(gate.cmd, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000 * 60 * 10
      });
      results.push({ name: gate.name, pass: true, output: tail(out) });
    } catch (e) {
      allPass = false;
      results.push({ name: gate.name, pass: false, output: tail(`${e.stdout || ''}\n${e.stderr || e.message || ''}`) });
    }
  }
  return { pass: allPass, skipped: false, results };
}

function tail(s, n = 2000) { s = String(s || ''); return s.length > n ? '...' + s.slice(-n) : s; }

// Reject vague tasks BEFORE spending a worker. Depth is enforced by structure.
function briefGate(task) {
  const reasons = [];
  if (!task || typeof task !== 'object') return { ok: false, reasons: ['no task object'] };
  if (!task.title || String(task.title).length < 8) reasons.push('title too short/missing');
  if (!task.brief || String(task.brief).length < 120) reasons.push('brief too thin — needs concrete, detailed instructions');
  if (!Array.isArray(task.files) || task.files.length === 0) reasons.push('no target files declared');
  if (!Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length < 2) reasons.push('need >= 2 verifiable acceptance criteria');
  if (!task.capability) reasons.push('not tied to a roadmap capability');
  if (!task.rationale) reasons.push('missing rationale (why this task now)');
  return { ok: reasons.length === 0, reasons };
}

module.exports = { detect, run, briefGate };
