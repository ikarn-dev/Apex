#!/usr/bin/env node
/**
 * HTTP smoke test against a running production build.
 *
 * Checks that each route serves real content rather than an error page, and
 * measures the actual JavaScript payload per route so the performance budget in
 * the PRD is a measured claim rather than an aspiration.
 *
 * Usage: npx next start & node scripts/smoke-http.mjs [baseUrl]
 */

import { gzipSync } from "node:zlib";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";

/** PRD F-P3: initial route JS. */
const MENU_BUDGET_KB = 250;

/**
 * Routes that cannot function without the chain layer, and so legitimately pay
 * for `@solana/web3.js` (226KB gzip) up front. Everything else must not.
 */
const CHAIN_BUDGET_KB = 460;

const ROUTES = [
  { path: "/", expect: ["Speed is free", "Ephemeral", "Start Act I"], budgetKb: MENU_BUDGET_KB },
  {
    path: "/campaign",
    expect: ["The Ephemeral", "Cold Start", "Delegation"],
    budgetKb: MENU_BUDGET_KB,
  },
  { path: "/garage", expect: ["EVO-37", "PHANTOM 765", "ZAGATO GT"], budgetKb: MENU_BUDGET_KB },
  { path: "/settings", expect: ["Tuning", "Quality tier", "Ephemeral Rollup"], budgetKb: MENU_BUDGET_KB },
  // Reads the on-chain driver account, so the wallet stack is unavoidable here.
  { path: "/profile", expect: ["Driver profile"], budgetKb: CHAIN_BUDGET_KB },
  // The engine and the wallet stack both load after first paint, so the eager
  // payload is small; the shell is what is measured.
  { path: "/race/act1-harbor", expect: ["APEX", "Opening the grid"], budgetKb: MENU_BUDGET_KB },
  { path: "/race/act5-apex", expect: ["APEX"], budgetKb: MENU_BUDGET_KB },
];

let failures = 0;
let checks = 0;

function check(ok, label, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const chunkCache = new Map();

async function chunkSize(url) {
  if (chunkCache.has(url)) return chunkCache.get(url);
  const response = await fetch(url);
  if (!response.ok) {
    chunkCache.set(url, 0);
    return 0;
  }
  const body = Buffer.from(await response.arrayBuffer());
  // Compare gzipped: that is what crosses the wire.
  const size = gzipSync(body).length;
  chunkCache.set(url, size);
  return size;
}

/** Sum the gzipped size of every script the document loads eagerly. */
async function measureJs(html) {
  const sources = new Set();
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    sources.add(match[1]);
  }
  // Turbopack also preloads route chunks via link rel=preload as=script.
  for (const match of html.matchAll(
    /<link[^>]+rel="preload"[^>]+as="script"[^>]+href="([^"]+)"/g,
  )) {
    sources.add(match[1]);
  }

  let total = 0;
  for (const source of sources) {
    const url = source.startsWith("http") ? source : `${BASE}${source}`;
    total += await chunkSize(url);
  }
  return { total, count: sources.size };
}

console.log(`\n  HTTP smoke test — ${BASE}\n`);

for (const route of ROUTES) {
  let response;
  try {
    response = await fetch(`${BASE}${route.path}`);
  } catch (error) {
    check(false, `${route.path} reachable`, String(error));
    continue;
  }

  check(response.status === 200, `${route.path} responds 200`, `status ${response.status}`);
  if (response.status !== 200) continue;

  const html = await response.text();

  for (const needle of route.expect) {
    check(html.includes(needle), `${route.path} renders "${needle}"`);
  }

  // A Next error page is served with 200 in some configurations, so check
  // explicitly rather than trusting the status alone.
  check(
    !html.includes("Application error") && !html.includes("__next_error__"),
    `${route.path} is not an error page`,
  );

  const { total, count } = await measureJs(html);
  const kb = total / 1024;
  check(
    kb <= route.budgetKb,
    `${route.path} JS within budget`,
    `${kb.toFixed(0)} KB gzip across ${count} chunks (budget ${route.budgetKb} KB)`,
  );
}

// The engine must not be in the menu bundle at all. This is the assertion that
// keeps the landing page fast as the game grows.
const landing = await (await fetch(`${BASE}/`)).text();
const landingJs = await measureJs(landing);
const raceJs = await measureJs(await (await fetch(`${BASE}/race/act1-harbor`)).text());
check(
  raceJs.total > landingJs.total,
  "race route carries more JS than the menu",
  `${(raceJs.total / 1024).toFixed(0)} KB vs ${(landingJs.total / 1024).toFixed(0)} KB`,
);

console.log(
  `\n  ${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed\n`,
);
process.exit(failures === 0 ? 0 : 1);
