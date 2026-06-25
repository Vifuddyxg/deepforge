'use strict';
const $ = (id) => document.getElementById(id);
const api = window.df;

let project = null;        // { path, config, plan, files }
let running = false;

// ---- project loading ----
async function applySnapshot(snap) {
  if (!snap) return;
  project = snap;
  const c = snap.config || {};
  $('projName').textContent = c.name || snap.path.split('/').pop();
  $('projPath').value = snap.path;
  $('goal').value = c.productGoal || '';
  $('directive').value = '';
  $('autoRoute').checked = c.autoRoute !== false;
  $('effort').value = c.effort || 'high';
  $('model').value = c.model || '';
  $('maxCycles').value = c.maxCyclesPerRun || 0;
  $('depthFirst').value = String(c.depthFirst !== false);
  $('toggleBtn').disabled = false;
  $('roadmapBtn').disabled = false;
  document.body.classList.remove('no-project');
  renderPlan(snap.plan);
  renderFiles(snap.files);
  localStorage.setItem('df:lastProject', snap.path);
  renderProjects();
}

async function loadAndApply(path) {
  const snap = await api.loadProject(path);
  if (snap) applySnapshot(snap);
}

async function renderProjects() {
  const el = $('projectList');
  const projects = await api.listProjects();
  el.innerHTML = '';
  if (!projects.length) { el.innerHTML = '<div class="empty">No projects yet — press + Open.</div>'; return; }
  const current = project && project.path;
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'projrow' + (p.path === current ? ' active' : '');
    row.innerHTML = '<span class="pname"></span><button class="premove" title="Remove from list">×</button><span class="ppath"></span>';
    row.querySelector('.pname').textContent = p.name;
    row.querySelector('.ppath').textContent = p.path;
    row.querySelector('.pname').onclick = () => loadAndApply(p.path);
    row.querySelector('.premove').onclick = async (e) => { e.stopPropagation(); await api.removeProject(p.path); renderProjects(); };
    el.appendChild(row);
  }
}

const openProject = async () => applySnapshot(await api.pickProject());
$('pickBtn').onclick = openProject;
$('welcomeOpen').onclick = openProject;

// ---- config ----
$('saveGoalBtn').onclick = saveConfig;
async function saveConfig() {
  if (!project) return;
  const patch = {
    productGoal: $('goal').value,
    autoRoute: $('autoRoute').checked,
    effort: $('effort').value,
    model: $('model').value.trim(),
    maxCyclesPerRun: parseInt($('maxCycles').value, 10) || 0,
    depthFirst: $('depthFirst').value === 'true'
  };
  project.config = await api.saveConfig(project.path, patch);
  flash($('saveGoalBtn'), 'Saved ✓');
}

// ---- About this project: AI-generate the description (saved into productGoal) ----
$('genDescBtn').onclick = async () => {
  if (!project) return;
  const btn = $('genDescBtn');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '✨ Generating…';
  let done = '';
  try {
    const r = await api.generateDescription(project.path);
    if (r && r.ok && r.text) {
      $('goal').value = r.text;
      if (project.config) project.config.productGoal = r.text;
      done = '✓ Generated';
    } else {
      done = '✗ ' + ((r && r.error) || 'failed');
    }
  } catch (e) {
    done = '✗ failed';
  } finally {
    btn.disabled = false;
    btn.textContent = done || old;
    setTimeout(() => { btn.textContent = old; }, 1400);
  }
};
for (const id of ['autoRoute', 'effort', 'model', 'maxCycles', 'depthFirst']) $(id).addEventListener('change', saveConfig);

// advanced collapse
$('advToggle').onclick = () => {
  const b = $('advBody');
  b.classList.toggle('hidden');
  $('advToggle').textContent = b.classList.contains('hidden') ? '⚙ Advanced settings ▾' : '⚙ Advanced settings ▴';
};

// ---- start / stop toggle ----
$('toggleBtn').onclick = async () => {
  if (!project) return;
  if (running) { await api.stop(); return; }
  await saveConfig();
  await api.start(project.path, 'allday');
};
$('roadmapBtn').onclick = async () => {
  if (!project || running) return;
  await saveConfig();
  await api.start(project.path, 'roadmap');
};
function setRunning(state) {
  running = state;
  const b = $('toggleBtn');
  b.classList.toggle('on', state);
  b.textContent = state ? '■ Stop (toggle off)' : '▶ Start — work all day';
  const rb = $('roadmapBtn');
  rb.disabled = state || !project;
  rb.style.display = state ? 'none' : '';
}

// ---- directives ----
$('sendDirective').onclick = async () => {
  const t = $('directive').value.trim();
  if (!t || !project) return;
  await api.directive(project.path, t);
  $('directive').value = '';
  addLog({ level: 'info', msg: '→ directive queued for next cycle', ts: Date.now() });
};

// ---- rendering ----
function renderPlan(plan) {
  const el = $('plan');
  el.innerHTML = '';
  const tasks = (plan && plan.tasks) || [];
  if (!tasks.length) { el.innerHTML = '<div class="empty">No tasks yet.<br>Press Start — the architect will plan the first one.</div>'; return; }
  const rank = { doing: 0, todo: 1, blocked: 2, done: 3 };
  [...tasks].sort((a, b) => (rank[a.status] - rank[b.status]) || a.id.localeCompare(b.id)).forEach((t) => {
    const d = document.createElement('div');
    d.className = `task ${t.status}`;
    d.innerHTML = '<span class="dot"></span><span class="tid"></span><span class="ttl"></span><span class="cx"></span><span class="cap"></span>';
    d.querySelector('.tid').textContent = t.id;
    d.querySelector('.ttl').textContent = t.title;
    d.querySelector('.cx').textContent = t.complexity || 'standard';
    d.querySelector('.cap').textContent = t.capability || '';
    el.appendChild(d);
  });
}

function renderFiles(files) {
  if (!files) return;
  if (files.roadmap != null) $('roadmap').textContent = files.roadmap;
  if (files.state != null) $('state').textContent = files.state;
  if (files.decisions != null) $('decisions').textContent = files.decisions;
  if (files.session != null) $('session').textContent = files.session;
}

function pad(n) { return String(n).padStart(2, '0'); }
function addLog({ level, msg, ts }) {
  const log = $('log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const d = new Date(ts || Date.now());
  const line = document.createElement('div');
  line.className = `line ${level || 'info'}`;
  line.innerHTML = `<span class="t">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span><span class="m"></span>`;
  line.querySelector('.m').textContent = msg;
  log.appendChild(line);
  while (log.childElementCount > 1500) log.removeChild(log.firstChild);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}
$('clearLog').onclick = () => { $('log').innerHTML = ''; };

// friendly "what's happening now" line
const PHASE_TEXT = {
  architect: '🧠 Architect is planning the next task…',
  worker: '🔨 Worker is building…',
  gates: '✅ Running tests & checks…',
  review: '🔍 Reviewer is checking the work…',
  fix: '🩹 Fixing issues…',
  compact: '🧹 Tidying project memory…'
};
function nowLine(spin, text) {
  $('nowline').innerHTML = `<span class="${spin ? 'spin' : 'dot-idle'}"></span><span class="now-text"></span>`;
  $('nowline').querySelector('.now-text').textContent = text;
}
function setPhase(phase) {
  if (PHASE_TEXT[phase]) nowLine(true, PHASE_TEXT[phase]);
  else if (running) nowLine(true, 'Working…');
  else nowLine(false, 'Idle — press Start to begin.');
}
function setStatus(s) {
  const b = $('statusBadge');
  b.className = `badge ${s}`;
  b.textContent = s;
  if (s === 'running' || s === 'stopping') setRunning(true);
  if (s === 'stopped' || s === 'idle') { setRunning(false); nowLine(false, 'Idle — press Start to begin.'); }
  if (s === 'done') { setRunning(false); nowLine(false, '✓ All planned work is complete.'); }
  if (s === 'blocked') { setRunning(false); nowLine(false, '⚠ Blocked — check the Activity log.'); }
}
function flash(btn, text) { const o = btn.textContent; btn.textContent = text; setTimeout(() => (btn.textContent = o), 1000); }

// ---- tabs ----
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  };
});

// ---- connection check (any provider) ----
async function checkConn() {
  const el = $('connBadge');
  try {
    const t = await api.detectTools();
    const ready = (t.claude && t.claude.ok) || (t.codex && t.codex.ok);
    if (ready) {
      const name = t.claude && t.claude.ok ? 'Claude' : 'Codex';
      el.className = 'conn ok'; el.textContent = `● ${name} ready`; el.title = 'Click to manage AI setup';
    } else {
      el.className = 'conn bad'; el.textContent = '○ Connect to AI'; el.title = 'Click to set up Claude / Codex';
    }
    return t;
  } catch (_) { el.className = 'conn bad'; el.textContent = '○ not connected'; return null; }
}

// ---- setup wizard (connect to Claude / Codex without a terminal) ----
const setup = {
  open() { $('setupOverlay').classList.remove('hidden'); refreshTools(); },
  close() { $('setupOverlay').classList.add('hidden'); checkConn(); }
};
$('connBadge').onclick = setup.open;
$('setupClose').onclick = setup.close;
$('setupDone').onclick = setup.close;
$('setupRecheck').onclick = () => refreshTools();

function setStat(elId, info, okLabel) {
  const el = $(elId);
  el.className = 'setup-stat ' + (info && info.ok ? 'ok' : 'bad');
  el.textContent = info && info.ok ? (okLabel || ('✓ ' + (info.version || 'installed'))) : 'not installed';
}

async function refreshTools() {
  const t = await api.detectTools();
  const hasNpm = t.npm && t.npm.ok;
  setStat('nodeStatus', t.node, '✓ ' + (t.node.version || 'installed'));
  $('nodeBtn').classList.toggle('hidden', !!(t.node && t.node.ok));
  for (const k of ['claude', 'codex', 'ollama']) setStat(k + 'Status', t[k]);
  for (const k of ['claude', 'codex']) {
    $(k + 'Install').classList.toggle('hidden', !!(t[k] && t[k].ok));
    $(k + 'Install').disabled = !hasNpm;
    $(k + 'Login').disabled = !(t[k] && t[k].ok);
  }
  $('ollamaBtn').classList.toggle('hidden', !!(t.ollama && t.ollama.ok));
  return t;
}

async function doInstall(which) {
  $('setupLog').classList.remove('hidden');
  $('setupLog').textContent = '';
  const btn = $(which + 'Install');
  const old = btn.textContent; btn.disabled = true; btn.textContent = 'Installing…';
  const r = await api.installCli(which);
  btn.textContent = old;
  await refreshTools();
  if (!(r && r.ok)) btn.disabled = false;
}
$('claudeInstall').onclick = () => doInstall('claude');
$('codexInstall').onclick = () => doInstall('codex');

async function doLogin(which) { $('loginHint').classList.remove('hidden'); await api.openLogin(which); }
$('claudeLogin').onclick = () => doLogin('claude');
$('codexLogin').onclick = () => doLogin('codex');
$('nodeBtn').onclick = () => api.openExternal('https://nodejs.org/en/download');
$('ollamaBtn').onclick = () => api.openExternal('https://ollama.com/download');

api.on('setup:log', (chunk) => {
  const el = $('setupLog');
  el.classList.remove('hidden');
  el.textContent += chunk;
  el.scrollTop = el.scrollHeight;
});

// ---- event wiring ----
api.on('orch:log', addLog);
api.on('orch:status', setStatus);
api.on('orch:phase', setPhase);
api.on('orch:plan', renderPlan);
api.on('orch:files', renderFiles);
api.on('orch:cost', (c) => { $('cost').textContent = '~$' + (c.total || 0).toFixed(2) + ' est.'; });

// ---- boot ----
(async () => {
  const tools = await checkConn();
  // First-run helper: if no agent is connected yet, open the setup wizard.
  if (!(tools && ((tools.claude && tools.claude.ok) || (tools.codex && tools.codex.ok)))) setup.open();
  await renderProjects();
  const last = localStorage.getItem('df:lastProject');
  if (last) {
    const snap = await api.loadProject(last);
    if (snap) applySnapshot(snap);
  }
  setRunning(await api.isRunning());
})();
