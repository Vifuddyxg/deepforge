'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const state = require('./state');
const registry = require('./registry');
const orchestrator = require('./orchestrator');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0e0f13',
    title: 'DeepForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Stream orchestrator events to the renderer.
for (const ev of ['log', 'status', 'plan', 'phase', 'cost', 'files']) {
  orchestrator.on(ev, (data) => send(`orch:${ev}`, data));
}

function projectSnapshot(p) {
  const cfg = state.ensure(p);
  registry.add(p, (cfg && cfg.name) || undefined);
  return {
    path: p,
    config: cfg,
    plan: state.readPlan(p),
    files: {
      roadmap: state.read(p, 'ROADMAP.md'),
      state: state.read(p, 'STATE.md'),
      decisions: state.read(p, 'DECISIONS.md'),
      session: state.read(p, 'SESSION.md')
    }
  };
}

ipcMain.handle('pick-project', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return projectSnapshot(r.filePaths[0]);
});

ipcMain.handle('load-project', async (_e, p) => {
  if (!p || !fs.existsSync(p)) return null;
  return projectSnapshot(p);
});

ipcMain.handle('save-config', async (_e, { path: p, patch }) => state.updateConfig(p, patch));

ipcMain.handle('list-projects', async () => registry.list());
ipcMain.handle('remove-project', async (_e, p) => registry.remove(p));

// Connection check: confirm the local `claude` CLI is present (it carries the user's auth).
ipcMain.handle('check-connection', async () => new Promise((resolve) => {
  execFile('claude', ['--version'], { timeout: 8000, shell: process.platform === 'win32' }, (err, stdout) => {
    if (err) return resolve({ ok: false, version: null, error: err.message });
    resolve({ ok: true, version: String(stdout || '').trim() });
  });
}));

// ── Setup wizard: detect tools, install the agent CLI, open the login flow ────
// Lets a non-CLI user connect to Claude/Codex with buttons instead of a terminal.
const CLI_PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };

function probeVersion(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, shell: process.platform === 'win32' }, (err, stdout) => {
      resolve(err ? { ok: false, version: null } : { ok: true, version: String(stdout || '').trim().split('\n')[0] });
    });
  });
}

// Which tools are present + their versions — drives the wizard's status rows.
ipcMain.handle('detect-tools', async () => ({
  node: await probeVersion('node', ['--version']),
  npm: await probeVersion('npm', ['--version']),
  claude: await probeVersion('claude', ['--version']),
  codex: await probeVersion('codex', ['--version']),
  ollama: await probeVersion('ollama', ['--version'])
}));

// `npm install -g <pkg>` with live output streamed to the renderer (setup:log).
ipcMain.handle('install-cli', async (_e, which) => new Promise((resolve) => {
  const pkg = CLI_PACKAGES[which];
  if (!pkg) return resolve({ ok: false, error: 'unknown CLI' });
  send('setup:log', `$ npm install -g ${pkg}\n(this can take a minute…)\n`);
  let child;
  try {
    child = spawn('npm', ['install', '-g', pkg], { shell: process.platform === 'win32', env: process.env });
  } catch (err) {
    send('setup:log', `\n✗ ${err.message} — is Node.js installed?\n`);
    return resolve({ ok: false, error: err.message });
  }
  child.stdout.on('data', (d) => send('setup:log', d.toString()));
  child.stderr.on('data', (d) => send('setup:log', d.toString()));
  child.on('error', (err) => { send('setup:log', `\n✗ ${err.message} — is Node.js installed?\n`); resolve({ ok: false, error: err.message }); });
  child.on('close', (code) => { send('setup:log', `\n${code === 0 ? '✓ Installed.' : '✗ Failed (exit ' + code + ')'}\n`); resolve({ ok: code === 0 }); });
}));

// Open the interactive login in a real terminal window (it opens a browser for OAuth).
// Best-effort per OS; the UI always shows the command as a fallback.
ipcMain.handle('open-login', async (_e, which) => {
  const cmd = which === 'codex' ? 'codex login' : 'claude';
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '"DeepForge login"', 'cmd', '/k', cmd], { shell: true, detached: true });
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd}"`, '-e', 'tell application "Terminal" to activate'], { detached: true });
    } else {
      const tries = [
        ['x-terminal-emulator', ['-e', `bash -lc "${cmd}; exec bash"`]],
        ['gnome-terminal', ['--', 'bash', '-lc', `${cmd}; exec bash`]],
        ['konsole', ['-e', `bash -lc "${cmd}; exec bash"`]],
        ['xterm', ['-e', `bash -lc "${cmd}; exec bash"`]]
      ];
      for (const [t, a] of tries) {
        let failed = false;
        const c = spawn(t, a, { detached: true });
        c.on('error', () => { failed = true; });
        await new Promise((r) => setTimeout(r, 150));
        if (!failed) { c.unref(); break; }
      }
    }
    return { ok: true, command: cmd };
  } catch (err) {
    return { ok: false, error: err.message, command: cmd };
  }
});

ipcMain.handle('open-external', async (_e, url) => { shell.openExternal(String(url)); return true; });

ipcMain.handle('start', async (_e, { path: p, mode }) => { orchestrator.start(p, mode); return true; });
ipcMain.handle('stop', async () => { orchestrator.requestStop(); return true; });
ipcMain.handle('is-running', async () => orchestrator.running);

ipcMain.handle('directive', async (_e, { path: p, text }) => {
  const cur = state.read(p, 'DIRECTIVES.md');
  state.write(p, 'DIRECTIVES.md', (cur ? cur + '\n' : '') + text);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  orchestrator.requestStop();
  if (process.platform !== 'darwin') app.quit();
});
