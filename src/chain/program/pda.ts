import { PublicKey } from "@solana/web3.js";
import { APEX_PROGRAM_ID } from "../programId";

export const DRIVER_SEED = Buffer.from("driver");
export const SESSION_SEED = Buffer.from("session");

/** Throws when called in Simulation mode. Callers must check `CHAIN_ENABLED`. */
function programId(): PublicKey {
  if (!APEX_PROGRAM_ID) {
    throw new Error("apex_racing program id is not configured");
  }
  return APEX_PROGRAM_ID;
}

/** `["driver", authority]` — permanent, one per wallet. */
export function driverProfilePda(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DRIVER_SEED, authority.toBuffer()],
    programId(),
  )[0];
}

/** u64 little-endian, matching `nonce.to_le_bytes()` in the program. */
export function nonceToLeBytes(nonce: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(nonce);
  return buf;
}

/** `["session", authority, nonce_le]` — one per run. */
export function raceSessionPda(authority: PublicKey, nonce: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SESSION_SEED, authority.toBuffer(), nonceToLeBytes(nonce)],
    programId(),
  )[0];
}
