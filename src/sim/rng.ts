// Seeded PRNG (mulberry32) so scenarios replay identically.
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shortDigest(rng: () => number): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(rng() * 16).toString(16);
  return s;
}
