/**
 * Seeded deterministic RNG.
 *
 * The simulation must never call `Math.random()`: identical inputs have to
 * produce identical results so that a run can be re-derived from
 * `(seed, car, level, inputLog)` and hashed for on-chain verification.
 *
 * xorshift128 — small state, fast, good enough distribution for gameplay.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number | bigint) {
    // splitmix32 expansion so nearby seeds produce unrelated streams.
    let h = Number(BigInt(seed) & 0xffffffffn) >>> 0 || 0x9e3779b9;
    const next = (): number => {
      h = (h + 0x9e3779b9) >>> 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  /** Raw 32-bit unsigned value. */
  nextUint32(): number {
    const t = this.s3;
    const s = this.s0;
    this.s3 = this.s2;
    this.s2 = this.s1;
    this.s1 = s;
    let r = t ^ (t << 11);
    r ^= r >>> 8;
    this.s0 = (r ^ s ^ (s >>> 19)) >>> 0;
    return this.s0;
  }

  /** Float in `[0, 1)`. */
  next(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  /** Float in `[min, max)`. */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in `[min, max]`. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Random element, or `undefined` for an empty list. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.next() * items.length)];
  }

  /** Symmetric noise in `[-amount, amount)`. */
  jitter(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }
}

/**
 * FNV-1a 32-bit over a numeric stream, expanded to a 32-byte digest.
 *
 * Used to fingerprint a run (inputs + checkpoint splits) so the program can
 * bind the submitted result to a specific replay. Not a cryptographic
 * commitment — it makes silent tampering detectable, not impossible. Real
 * replay verification is v2.
 */
export class ReplayHasher {
  private lanes: Uint32Array;
  private index = 0;
  private count = 0;

  constructor() {
    this.lanes = new Uint32Array(8);
    for (let i = 0; i < 8; i += 1) this.lanes[i] = 0x811c9dc5 ^ (i * 0x01000193);
  }

  /** Absorb one value. Non-integers are quantised so it stays platform-stable. */
  push(value: number): void {
    const v = Math.round(value * 1000) | 0;
    const lane = this.index & 7;
    let h = this.lanes[lane]!;
    for (let shift = 0; shift < 32; shift += 8) {
      h ^= (v >>> shift) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    this.lanes[lane] = h >>> 0;
    this.index += 1;
    this.count += 1;
  }

  pushAll(values: readonly number[]): void {
    for (const v of values) this.push(v);
  }

  get samples(): number {
    return this.count;
  }

  /** 32-byte little-endian digest. */
  digest(): Uint8Array {
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i += 1) {
      const h = (this.lanes[i]! ^ Math.imul(this.count + i, 0x01000193)) >>> 0;
      out[i * 4 + 0] = h & 0xff;
      out[i * 4 + 1] = (h >>> 8) & 0xff;
      out[i * 4 + 2] = (h >>> 16) & 0xff;
      out[i * 4 + 3] = (h >>> 24) & 0xff;
    }
    return out;
  }

  digestHex(): string {
    return Array.from(this.digest())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

/** A fresh race seed. Uses crypto when available; only called outside the loop. */
export function generateSeed(): bigint {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let seed = 0n;
  for (let i = 0; i < 8; i += 1) seed = (seed << 8n) | BigInt(bytes[i]!);
  // Keep it inside i64/u64-safe territory for Borsh.
  return seed & 0x7fff_ffff_ffff_ffffn;
}
