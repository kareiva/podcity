// Single source of truth for city geography. Units are metres-ish; +x east, +z south.

export interface Pad {
  x: number;
  z: number;
  w: number; // extent along x
  d: number; // extent along z
}

export const CITY_RADIUS = 80;

export const districts = {
  seaport: { x: -105, z: 0, w: 30, d: 60 }, // outside the wall, on the water
  warehouse: { x: -50, z: -10, w: 30, d: 24 },
  factories: { x: 10, z: -10, w: 60, d: 40 },
  lockers: { x: -35, z: 40, w: 30, d: 16 }, // secured yard, fenced
  businessCenter: { x: -95, z: 60, w: 12, d: 12 }, // systemd / Quadlet: host side, outside the wall
  shoppingCenter: { x: 25, z: 62, w: 14, d: 10 }, // demo entry point, by the wall
  freight: { x: 65, z: 45, w: 20, d: 20 },
  hostLand: { x: 0, z: 110, w: 140, d: 30 }, // host filesystem, beyond the wall
} satisfies Record<string, Pad>;

export type DistrictId = keyof typeof districts;

/** Highway from the seaport gate to the warehouse. */
export const pullRoute: [number, number][] = [
  [-92, 0],
  [-CITY_RADIUS, 0],
  [-66, -10],
  [-50, -10],
];

/** Road from the systemd Business Center to the Demo Shopping Center. */
export const serviceRoute: [number, number][] = [
  [-89, 62],
  [18, 62],
];

/** z where the wall crosses a north-south line at x (south side). */
export function wallZ(x: number): number {
  return Math.sqrt(Math.max(CITY_RADIUS ** 2 - x ** 2, 0));
}

/** x where the wall crosses an east-west line at z (west side). */
export function wallXWest(z: number): number {
  return -Math.sqrt(Math.max(CITY_RADIUS ** 2 - z ** 2, 0));
}

const SLOT_COLS = 5;
const SLOT_SPACING = 12;

/** Position of the n-th factory plot in the factory district. */
export function factorySlot(n: number): { x: number; z: number } {
  const f = districts.factories;
  const col = n % SLOT_COLS;
  const row = Math.floor(n / SLOT_COLS);
  return {
    x: f.x - f.w / 2 + SLOT_SPACING / 2 + col * SLOT_SPACING,
    z: f.z - f.d / 2 + SLOT_SPACING / 2 + row * SLOT_SPACING,
  };
}

/** Position of the n-th crate on the warehouse shelves. */
export function shelfSlot(n: number): { x: number; y: number; z: number } {
  const w = districts.warehouse;
  const perRow = 8;
  return {
    x: w.x - w.w / 2 + 3 + (n % perRow) * 3.2,
    y: 1,
    z: w.z + w.d / 2 + 3 + Math.floor(n / perRow) * 3.2,
  };
}

/** Position of the n-th locker in the locker yard. */
export function lockerSlot(n: number): { x: number; z: number } {
  const l = districts.lockers;
  return { x: l.x - l.w / 2 + 3 + n * 5, z: l.z };
}

/** Position of the n-th image manifest board along the warehouse front. */
export function manifestSlot(n: number): { x: number; z: number } {
  const w = districts.warehouse;
  return { x: w.x - w.w / 2 + 3 + n * 5, z: w.z - w.d / 2 + 3 };
}

/** Where the n-th feedback card waits outside a factory door. */
export function doorQueueSlot(factory: { x: number; z: number }, n: number): { x: number; z: number } {
  return { x: factory.x - 3 + (n % 5) * 1.5, z: factory.z + 5.5 + Math.floor(n / 5) * 1.2 };
}

/** Plot for the n-th host path in the host land beyond the wall. */
export function hostPathSlot(n: number): { x: number; z: number } {
  const h = districts.hostLand;
  return { x: h.x - h.w / 2 + 12 + n * 12, z: h.z };
}
