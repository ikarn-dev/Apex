#!/usr/bin/env node
/**
 * Print Anchor discriminators for the apex_racing program.
 *
 * Anchor derives an 8-byte prefix from sha256("global:<ix_name>") for
 * instructions and sha256("account:<AccountName>") for account data. The client
 * hardcodes these constants instead of shipping an IDL and an Anchor `Program`
 * instance, which keeps ~200KB of borsh/IDL machinery out of the game bundle.
 *
 * Run `node scripts/discriminators.mjs` after adding or renaming an instruction
 * and paste the output into src/chain/program/discriminators.ts.
 */

import { createHash } from "node:crypto";

const INSTRUCTIONS = [
  "initialize_driver",
  "open_session",
  "delegate_session",
  "tick",
  "finish_race",
  "bank_run",
  "settle_run",
  "claim_xp",
  "abandon_session",
];

const ACCOUNTS = ["DriverProfile", "RaceSession"];

function discriminator(preimage) {
  return [...createHash("sha256").update(preimage).digest().subarray(0, 8)];
}

function emit(label, entries, prefix) {
  console.log(`\n// ${label}`);
  for (const name of entries) {
    const bytes = discriminator(`${prefix}:${name}`);
    console.log(`${name}: [${bytes.join(", ")}],`);
  }
}

emit("instructions — sha256('global:<name>')[0..8]", INSTRUCTIONS, "global");
emit("accounts — sha256('account:<Name>')[0..8]", ACCOUNTS, "account");
console.log();
