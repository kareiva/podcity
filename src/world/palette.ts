// Color semantics shared by every district. Keep in sync with AGENTS.md.
export const palette = {
  ground: 0x8fa982,
  road: 0x55595e,
  wall: 0xb9b0a0,
  water: 0x3d7ab8,
  image: 0x3b82f6, // images and layers
  running: 0x22c55e,
  stopped: 0x9ca3af,
  error: 0xef4444,
  network: 0xf59e0b,
  storage: 0x8b5cf6,
  secret: 0xeab308,
  pod: 0x14b8a6,
  building: 0xe7e2d6,
  card: 0xf8fafc, // env var feedback cards
  tower: 0x475569,
  hostPath: 0x7a5c3a,
  scratch: 0x06b6d4,
  abandoned: 0x8a8178,
  boards: 0x5b4636,
  bars: 0x374151,
  marking: 0xf5f5f5, // road lane markings
  shipHull: 0x1f2a44,
  blueprint: 0x1e40af, // compose blueprint board
} as const;

/**
 * Stable per-image color from a hash of the image reference, so every layer
 * crate, manifest and arc of one image shares a hue. Semantic colors above
 * stay reserved for state.
 */
export function imageColor(ref: string): number {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < ref.length; i++) {
    h ^= ref.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hslToHex((h >>> 0) % 360, 0.6, 0.55);
}

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
