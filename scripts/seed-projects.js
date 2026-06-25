'use strict';
// One-off: register trustgate-ai (SafeVico) and duocode into DeepForge,
// seeding each .orchestrator/ with its EXISTING roadmap + an accurate STATE.md
// so the architect builds on top of mature work instead of redoing it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const state = require('../src/main/state');
const registry = require('../src/main/registry');

function copyIfExists(src, destProject) {
  if (fs.existsSync(src)) {
    state.write(destProject, 'ROADMAP.md', fs.readFileSync(src, 'utf8'));
    return true;
  }
  return false;
}

// ---------- SafeVico / trustgate-ai ----------
const TG = '/home/gentoobdw/trustgate-ai';
if (fs.existsSync(TG)) {
  state.ensure(TG);
  state.updateConfig(TG, {
    name: 'SafeVico (trustgate-ai)',
    productGoal: 'SafeVico — real-time AI governance & control platform: monitor AI usage in organizations, prevent sensitive-data leaks to ChatGPT/Claude/Gemini, enforce policies, and prove GDPR / EU AI Act compliance. B2B SaaS, multi-tenant.',
    depthFirst: true,
    effort: 'high',
    maxBudgetUsdPerAgent: 0,
    gates: { typecheck: 'npm run typecheck', test: 'npm run test:unit', build: 'off' }
  });
  copyIfExists(path.join(os.homedir(), '.roadvico', 'ROADMAP.md'), TG);
  state.write(TG, 'STATE.md', `# Current State of the World — SafeVico (trustgate-ai)

Mature B2B SaaS, "real-time AI governance & control" (rescoped from an audit tool).
Next.js 16 App Router, Clerk auth, Prisma 7 + PostgreSQL, @base-ui/react primitives.

## Built — do NOT rebuild
- Phases 0-7 of the roadmap are CODE-COMPLETE: \`npm run build\` passes (~356 routes), unit tests green.
- Core: Onboarding, Dashboard command center, Assessments, Reports, Policies, Fix Plans,
  Tools Registry, append-only Evidence Log (hash chain), Launch Gate + Launch Certificates.
- Scanners: client-side project folder scanner (FSAA, contextual rules), SSRF-protected Site Scanner, AI Launch Review.
- AI governance: AI Systems registry + EU-AI-Act classifier; AI Policy engine (AiPolicy model,
  /api/ai-policies + evaluate cache); AI DLP / prompt scanner (local, stores SHA-256 only); AI insights.
- Compliance: /compliance (GDPR, EU AI Act, audit-trail) + export CSV/JSON/PDF.
- Integrations: Slack + SIEM forwarders, marketplace, PR-workflow foundation. Billing (Stripe, ENFORCE_BILLING=false in beta).
  Team invites, RBAC hardening, share portals, risk history.
- DLP evaluation harness (precision/recall per rule) already exists — it MEASURES, does not add features.

## What remains — architect: harden & close real gaps, do NOT add shallow features
- Per the roadmap reconciliation (2026-06-10), most remaining items are NON-code (pilot outreach,
  live OAuth creds, legal/DPO review of report text, OCR-on-Vercel, load/perf testing).
- Concrete code targets worth hardening (from the DLP harness baselines):
  phone_number F1 ~50% (US-shaped regex misses RO formats, matches CNP digit-runs);
  password_literal double-classifies \`SECRET=...\` as env_var; email matches \`user:pass@host\` in DB URLs;
  person_name gazetteer gaps + false positives; credit_card requires contiguous digits.
- Raise unit-test coverage; close documented DoD code gaps; tighten validation at API boundaries.

## Conventions — critical
- Multi-tenant: EVERY Prisma query MUST include orgId. Mutations use requireAuthRole(minRole).
- Read Next.js 16 local docs (node_modules/next/dist/docs/) before API changes.
- Zod 4: z.record(z.string(), z.unknown()). Serialize Prisma Date fields before client components.
- @base-ui/react (not Radix). Button has no asChild — use buttonVariants on a Link.

## Gates
- typecheck = \`npm run typecheck\` (tsc --noEmit), test = \`npm run test:unit\` (node, fast).
- build (next build) and Playwright E2E are OFF for per-cycle speed/reliability (E2E needs a live server + DB).
`);
  registry.add(TG, 'SafeVico (trustgate-ai)');
  console.log('seeded SafeVico (trustgate-ai)');
} else {
  console.log('SKIP trustgate-ai (not found)');
}

// ---------- DuoCode ----------
const DC = '/home/gentoobdw/duocode';
if (fs.existsSync(DC)) {
  state.ensure(DC);
  state.updateConfig(DC, {
    name: 'DuoCode',
    productGoal: 'DuoCode — a Duolingo-style app for learning programming (C, TypeScript, C++, Python, Rust, Assembly, Java, C#, Robotics, Lua). Offline-first, bilingual RO/EN, with real in-browser runners where feasible and rigorous hand-verified exercise outputs.',
    depthFirst: true,
    effort: 'high',
    maxBudgetUsdPerAgent: 0,
    gates: { build: 'npm run build', typecheck: 'off', test: 'off' }
  });
  copyIfExists(path.join(DC, 'ROADMAP.md'), DC);
  state.write(DC, 'STATE.md', `# Current State of the World — DuoCode

Mature Duolingo-style learn-to-code app. React 18 + Vite 5 + TS strict + Tailwind v3.
Offline-first. Bilingual RO/EN (src/i18n.tsx, LocalizedString + L in types.ts).

## Built — do NOT rebuild
- 10 courses: C (core + gui[raylib/sdl2] + backend + x11), TypeScript (core + frontend + react),
  C++ (core + algo), Python (core + data), Rust (core + collections + structs + errors),
  Assembly (x86-64 NASM), Java (core + oop + collections + errors + advanced), Robotics (Arduino/C++),
  C# (core), Lua (core + Roblox/Luau track). The English course was deliberately removed.
- 9 exercise types (info/choice/output/fill/order/type/predict/build/match), 4 level types (learn/practice/project/boss).
- Real offline runners: TS/JS via sucrase, C/C++ via JSCPP, Python via Skulpt. Rust/Assembly/Java/Robotics/C#/Lua
  are NON-runnable by design (honest error → graded via accept[]/RegExp/AI).
- Engine: progress/XP/hearts (regen 1/30min)/streak/daily goal/achievements/stats, dark mode, Web Audio sounds,
  JSON backup export/import, weekly league with 6 divisions + promotion/relegation, friends leaderboard
  (shareable codes, no server), accuracy-by-exercise-type chart, SM-2 spaced-repetition review.

## Conventions — critical (from ROADMAP)
- Adding content: ONE unitN.ts file per unit, aggregated in index.ts. New language → extend Lang (types.ts),
  LANG_NAME (ai/client.ts), route in run/index.ts.
- predict/build exercises with \`expect\`: outputs MUST be hand-computed OR verified in the real runner BEFORE
  writing. Beware float repr (Skulpt vs CPython) and language traps: left-to-right + concat, int/int truncation,
  bool capitalization (True/False in C#), non-deterministic HashMap/HashSet order (predict only on get/size/contains).
- Every change keeps \`npx tsc --noEmit && npm run build\` GREEN with ZERO regressions. Add i18n keys before
  parallel work to avoid collisions in src/i18n.tsx.
- New content must be ADDITIVE with gentle state migration — never lose a user's localStorage progress.

## Depth-first
- Prefer hardening, clarity passes (analogy-before-syntax pedagogy), and fixing weak spots over adding ever
  more courses/units. The roadmap's recent phases are clarity + engine polish, not breadth.

## Gates
- build = \`npm run build\` (runs tsc --noEmit && vite build — the real project gate, fully offline). typecheck/test folded in.
`);
  registry.add(DC, 'DuoCode');
  console.log('seeded DuoCode');
} else {
  console.log('SKIP duocode (not found)');
}

console.log('\nregistry now:', JSON.stringify(registry.list().map((p) => p.name), null, 0));
console.log('registry file:', registry.FILE);
