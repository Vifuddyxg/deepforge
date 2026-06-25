'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Registry of known projects, so DeepForge can list & switch between them.
// Stored outside any single project, in the user's home.
const DIR = path.join(os.homedir(), '.deepforge');
const FILE = path.join(DIR, 'projects.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { projects: [] }; }
}
function writeAll(data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}
function list() {
  // drop entries whose folder no longer exists
  const data = read();
  const live = (data.projects || []).filter((x) => x && x.path && fs.existsSync(x.path));
  if (live.length !== (data.projects || []).length) writeAll({ projects: live });
  return live;
}
function add(p, name) {
  if (!p) return list();
  const data = read();
  data.projects = data.projects || [];
  const existing = data.projects.find((x) => x.path === p);
  if (existing) { if (name) existing.name = name; }
  else data.projects.push({ path: p, name: name || path.basename(p), addedAt: Date.now() });
  writeAll(data);
  return data.projects;
}
function remove(p) {
  const data = read();
  data.projects = (data.projects || []).filter((x) => x.path !== p);
  writeAll(data);
  return data.projects;
}

module.exports = { list, add, remove, FILE };
