/**
 * Minimal Borsh reader/writer.
 *
 * Only the field types `apex_racing` actually uses. Written by hand rather than
 * pulled from a library because the account layouts are small and fixed, and a
 * game bundle should not carry a general-purpose schema engine.
 *
 * Borsh is little-endian throughout.
 */

import { PublicKey } from "@solana/web3.js";

export class BorshWriter {
  private buf: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(bytes: number): void {
    if (this.offset + bytes <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.offset + bytes) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf);
    this.buf = grown;
    this.view = new DataView(this.buf.buffer);
  }

  u8(value: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, value & 0xff);
    this.offset += 1;
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u16(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, value & 0xffff, true);
    this.offset += 2;
    return this;
  }

  u32(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }

  u64(value: bigint | number): this {
    this.ensure(8);
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
    return this;
  }

  i64(value: bigint | number): this {
    this.ensure(8);
    this.view.setBigInt64(this.offset, BigInt(value), true);
    this.offset += 8;
    return this;
  }

  pubkey(key: PublicKey): this {
    return this.bytes(key.toBytes());
  }

  /** Raw bytes, no length prefix. */
  bytes(data: Uint8Array): this {
    this.ensure(data.length);
    this.buf.set(data, this.offset);
    this.offset += data.length;
    return this;
  }

  /** Length-prefixed byte vector. */
  vecU8(data: Uint8Array): this {
    this.u32(data.length);
    return this.bytes(data);
  }

  /** Length-prefixed UTF-8 string. */
  string(value: string): this {
    return this.vecU8(new TextEncoder().encode(value));
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.offset));
  }
}

export class BorshReader {
  private view: DataView;
  private offset: number;

  constructor(
    private data: Uint8Array,
    startOffset = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = startOffset;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  skip(bytes: number): this {
    this.offset += bytes;
    return this;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  bool(): boolean {
    return this.u8() === 1;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  pubkey(): PublicKey {
    const bytes = this.data.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(bytes);
  }

  fixedBytes(length: number): Uint8Array {
    const bytes = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  /** Borsh `Option<T>`: one tag byte then the value. */
  option<T>(read: (reader: BorshReader) => T): T | null {
    return this.u8() === 1 ? read(this) : null;
  }

  /** Fixed-length array of u32. */
  u32Array(length: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < length; i += 1) out.push(this.u32());
    return out;
  }
}

/** `bigint` -> `number`, saturating rather than throwing. XP fits comfortably. */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (value < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
  return Number(value);
}
