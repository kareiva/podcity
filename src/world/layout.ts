// Single source of truth for city geography. Units are metres-ish; +x east, +z south.
import { CatmullRomCurve3, Vector3 } from 'three';

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
  rnd: { x: -45, z: -46, w: 22, d: 14 }, // R&D department: writes Containerfiles, builds images
  quadlet: { x: -54, z: 28, w: 16, d: 12 }, // Quadlet department: writes unit files for systemd
  factories: { x: 10, z: -10, w: 60, d: 40 },
  lockers: { x: 36, z: 30, w: 30, d: 16 }, // secured yard, fenced; next to the freight station
  businessCenter: { x: -95, z: 60, w: 12, d: 12 }, // systemd / Quadlet: host side, outside the wall
  shoppingCenter: { x: 25, z: 62, w: 14, d: 10 }, // demo entry point, by the wall
  freight: { x: 65, z: 45, w: 20, d: 20 },
  hostLand: { x: 0, z: 100, w: 140, d: 12 }, // host filesystem: a highway beyond the wall
} satisfies Record<string, Pad>;

export type DistrictId = keyof typeof districts;

/** Conveyor from the seaport, through the wall, into the warehouse (control points). */
export const pullRoute: [number, number][] = [
  [-92, 0],
  [-CITY_RADIUS, 0],
  [-66, -8],
  [-50, -10],
];

/** Dense, evenly spaced points along a smooth (centripetal Catmull-Rom) curve through `route`. */
export function smoothPath(route: [number, number][], spacing = 0.5): [number, number][] {
  const curve = new CatmullRomCurve3(route.map(([x, z]) => new Vector3(x, 0, z)), false, 'centripetal');
  const n = Math.max(2, Math.ceil(curve.getLength() / spacing));
  return curve.getSpacedPoints(n).map((p) => [p.x, p.z]);
}

/** Position and heading at distance `d` along a polyline; used for belts and everything riding them. */
export function pathSampler(path: [number, number][]): { length: number; at(d: number): { x: number; z: number; yaw: number } } {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]));
  const length = cum.at(-1)!;
  return {
    length,
    at(d) {
      const t = Math.min(Math.max(d, 0), length);
      let i = 1;
      while (i < path.length - 1 && cum[i]! < t) i++;
      const [ax, az] = path[i - 1]!;
      const [bx, bz] = path[i]!;
      const seg = cum[i]! - cum[i - 1]! || 1;
      const k = (t - cum[i - 1]!) / seg;
      return { x: ax + (bx - ax) * k, z: az + (bz - az) * k, yaw: -Math.atan2(bz - az, bx - ax) };
    },
  };
}

/** Seaport: quay edge on the water side, gantry cranes along it, terminal shed and an idling container ship offshore. */
export function seaportLayout(): {
  quayX: number;
  cranes: { x: number; z: number }[];
  terminal: Pad;
  ship: { x: number; z: number; length: number; beam: number };
} {
  const s = districts.seaport;
  const quayX = s.x - s.w / 2;
  return {
    quayX,
    cranes: [-14, 10].map((dz) => ({ x: quayX + 4, z: s.z + dz })),
    terminal: { x: s.x + 4, z: s.z + 18, w: 14, d: 16 },
    ship: { x: quayX - 22, z: s.z - 2, length: 44, beam: 9 },
  };
}

/** Conveyor from the R&D department to the warehouse (control points). */
export const buildRoute: [number, number][] = [
  [-40, -42],
  [-40, -30],
  [-44, -19],
  [-50, -10],
];

/** The image delivery conveyors as smooth paths: seaport -> warehouse <- R&D. */
export const pullPath = smoothPath(pullRoute);
export const buildPath = smoothPath(buildRoute);

/** R&D lab building, Containerfile board and the bench where built layers wait. */
export function rndLab(): { building: { x: number; z: number }; board: { x: number; z: number } } {
  const r = districts.rnd;
  return { building: { x: r.x - 5, z: r.z - 1 }, board: { x: r.x + 3, z: r.z - 4 } };
}

export function labBenchSlot(n: number): { x: number; z: number } {
  const r = districts.rnd;
  return { x: r.x + 1 + n * 2.6, z: r.z + 3 };
}

/** Road from the Quadlet department south to the service road (which passes the wall gate). */
export const quadletRoad: [number, number][] = [
  [-48, 34],
  [-48, 62],
];

/** Route a unit file travels from the Quadlet department to the systemd Business Center. */
export const quadletRoute: [number, number][] = [...quadletRoad, [-89, 62]];

/** Quadlet office building and the board where the unit file is pinned. */
export function quadletOffice(): { building: { x: number; z: number }; board: { x: number; z: number } } {
  const q = districts.quadlet;
  return { building: { x: q.x - 3, z: q.z - 1 }, board: { x: q.x + 5, z: q.z + 2 } };
}

/** Plate for the n-th generated unit on the city-facing (east) wall of the systemd tower. */
export function unitPlateSlot(n: number): { x: number; y: number; z: number } {
  const b = districts.businessCenter;
  return { x: b.x + 4.2, y: 14 - n * 2, z: b.z };
}

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
const BELT_LANE = 3; // strip along the north edge of the factory district for network belts

/** ISO 20ft shipping container, metres (length x width x height). */
export const ISO_20FT = { l: 6.06, w: 2.44, h: 2.59 };

/** Container (factory) building: an ISO 20ft box scaled up, long side north-south, doors facing south. */
const FACTORY_SCALE = 8 / ISO_20FT.l;
export const FACTORY = { w: ISO_20FT.w * FACTORY_SCALE, h: ISO_20FT.h * FACTORY_SCALE, l: 8 };

/** Position of the n-th factory plot in the factory district. */
export function factorySlot(n: number): { x: number; z: number } {
  const f = districts.factories;
  const col = n % SLOT_COLS;
  const row = Math.floor(n / SLOT_COLS);
  return {
    x: f.x - f.w / 2 + SLOT_SPACING / 2 + col * SLOT_SPACING,
    z: f.z - f.d / 2 + BELT_LANE + SLOT_SPACING / 2 + row * SLOT_SPACING,
  };
}

/** Conveyor belt of the n-th network, running east-west along the north edge of the factory district. */
export function networkBelt(n: number): { x: number; z: number; length: number } {
  const f = districts.factories;
  return { x: f.x, z: f.z - f.d / 2 + 1.5 - n * 2.5, length: f.w - 4 };
}

/**
 * Feeder belt from a factory to a network belt: out of the east wall, then
 * north along the gap between plot columns so it never crosses other plots.
 */
export function feederRoute(factory: { x: number; z: number }, belt: { z: number }): [number, number][] {
  const gap = factory.x + FACTORY.w / 2 + 1;
  return [
    [factory.x + FACTORY.w / 2, factory.z],
    [gap, factory.z],
    [gap, belt.z],
  ];
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

/** Crates the warehouse hall is sized to hold (two shelf rows). */
export const SHELF_CAPACITY = 16;

/** Footprint of the translucent warehouse hall: the pad plus its shelf rows. */
export function warehouseHall(): Pad {
  const w = districts.warehouse;
  const margin = 2;
  const north = w.z - w.d / 2;
  const south = shelfSlot(SHELF_CAPACITY - 1).z + 1.2 + margin; // crates are 2.4 wide
  return { x: w.x, z: (north + south) / 2, w: w.w, d: south - north };
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

export const HIGHWAY_LANES = 3;

/** Plot for the n-th host path: a shed on the far roadside of the host highway. */
export function hostPathSlot(n: number): { x: number; z: number } {
  const h = districts.hostLand;
  return { x: h.x - h.w / 2 + 12 + n * 12, z: h.z + h.d / 2 + 4 };
}
