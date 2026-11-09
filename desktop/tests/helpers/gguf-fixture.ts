// A minimal GGUF v3 writer, so a fixture is a list of key/value pairs. Shared by
// the header reader's tests and every test that needs a model FILE on disk whose
// header says something (layers, MTP heads) — the real files are gigabytes.
export const T = { u32: 4, i32: 5, f32: 6, bool: 7, string: 8, array: 9, u64: 10 } as const;

export interface Kv { key: string; type: number; value: any; elemType?: number }

export function u64(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
export function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
export function str(s: string): Buffer { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]); }

function scalar(type: number, v: any): Buffer {
  switch (type) {
    case T.u32: return u32(v);
    case T.i32: { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; }
    case T.f32: { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; }
    case T.bool: return Buffer.from([v ? 1 : 0]);
    case T.u64: return u64(v);
    case T.string: return str(v);
    default: throw new Error(`fixture writer has no case for type ${type}`);
  }
}

function value(kv: Kv): Buffer {
  if (kv.type !== T.array) return scalar(kv.type, kv.value);
  const et = kv.elemType!;
  const items = (kv.value as any[]).map((v) => scalar(et, v));
  return Buffer.concat([u32(et), u64(items.length), ...items]);
}

export function buildGguf(kvs: Kv[], opts: { version?: number; magic?: string } = {}): Buffer {
  const parts: Buffer[] = [
    Buffer.from(opts.magic ?? 'GGUF', 'ascii'),
    u32(opts.version ?? 3),
    u64(0), // tensor count — the tensor table is never read
    u64(kvs.length),
  ];
  for (const kv of kvs) parts.push(str(kv.key), u32(kv.type), value(kv));
  return Buffer.concat(parts);
}

