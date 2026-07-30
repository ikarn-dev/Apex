import { PublicKey } from "@solana/web3.js";
import { APEX_PROGRAM_ID_BASE58, CHAIN_ENABLED } from "./config";

/**
 * The parsed `apex_racing` program id, or `null` in Simulation mode.
 *
 * Kept out of `./config` deliberately: this module imports `@solana/web3.js`, so
 * anything that touches it pays 226KB gzip. Only real chain code should.
 */
function parse(): PublicKey | null {
  if (!CHAIN_ENABLED) return null;
  try {
    return new PublicKey(APEX_PROGRAM_ID_BASE58);
  } catch {
    console.warn(
      `[apex] NEXT_PUBLIC_APEX_PROGRAM_ID is not a valid public key: ${APEX_PROGRAM_ID_BASE58}. Running in simulation mode.`,
    );
    return null;
  }
}

export const APEX_PROGRAM_ID: PublicKey | null = parse();
