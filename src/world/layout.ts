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
  lockers: { x: 36, z: 30, w: 30, d: 16 }, // secured yard, fenced
  businessCenter: { x: -48, z: 87, w: 12, d: 12 }, // systemd: host side, outside the wall, on the host highway's north roadside
  shoppingCenter: { x: -34, z: 30, w: 14, d: 10 }, // demo entry point, next to the Quadlet department, clear of the port bridges south
  secrets: { x: 10, z: -41, w: 7, d: 8 }, // Secret Facility: behind (north of) the factory hall, off the road network; door faces the hall
  freight: { x: 8, z: 53, w: 28, d: 16 }, // freight station: south of the car park; its railway leaves through the east wall
  hostLand: { x: 0, z: 100, w: 140, d: 12 }, // host filesystem: a highway beyond the wall
} satisfies Record<string, Pad>;

export type DistrictId = keyof typeof districts;

/** Where image containers are opened in the warehouse, under the unpacking gantry. */
export const unpackSpot = { x: -54, z: -8 };

/** Drop-off points an image container is craned between: seaport quay -> (over the wall) -> warehouse. */
export const pullWaypoints: [number, number][] = [
  [-96, 0],
  [unpackSpot.x, unpackSpot.z],
];

/** R&D yard -> warehouse. */
export const buildWaypoints: [number, number][] = [
  [-37, -45],
  [unpackSpot.x, unpackSpot.z],
];

export const CRANE_HEIGHT = 20; // tall enough for one crane to span each route
export const UNPACK_GANTRY_HEIGHT = 7;

/** A tower crane lifting containers from one drop-off point to the next; both lie on its jib's circle. */
export interface CraneSpec {
  name: string;
  x: number;
  z: number;
  radius: number;
  from: [number, number];
  to: [number, number];
}

/**
 * One crane per leg between waypoints. The mast stands off to one side of the
 * leg (`side`), so the jib swings 120 degrees between pick-up and drop-off.
 */
function relayCranes(prefix: string, waypoints: [number, number][], side: 1 | -1): CraneSpec[] {
  return waypoints.slice(1).map((to, i) => {
    const from = waypoints[i]!;
    const dx = to[0] - from[0];
    const dz = to[1] - from[1];
    const d = Math.hypot(dx, dz);
    const offset = d / 2 / Math.tan(Math.PI / 3);
    const x = (from[0] + to[0]) / 2 + (-dz / d) * offset * side;
    const z = (from[1] + to[1]) / 2 + (dx / d) * offset * side;
    return { name: `${prefix}:${i}`, x, z, radius: Math.hypot(d / 2, offset), from, to };
  });
}

// Masts stand inside the wall: between the wall and the warehouse, and between the warehouse and R&D.
export const pullCranes = relayCranes('crane:pull', pullWaypoints, 1);
export const buildCranes = relayCranes('crane:build', buildWaypoints, 1);

/** Slewing angle (rotation about y) that points a crane's jib (local +x) at a ground point. */
export function craneYaw(crane: { x: number; z: number }, [x, z]: [number, number]): number {
  return Math.atan2(-(z - crane.z), x - crane.x);
}

/** Dense, evenly spaced points along a smooth (centripetal Catmull-Rom) curve through `route`. */
export function smoothPath(route: [number, number][], spacing = 0.5): [number, number][] {
  const curve = new CatmullRomCurve3(route.map(([x, z]) => new Vector3(x, 0, z)), false, 'centripetal');
  const n = Math.max(2, Math.ceil(curve.getLength() / spacing));
  return curve.getSpacedPoints(n).map((p) => [p.x, p.z]);
}

/**
 * Polyline with each corner rounded by a quadratic curve of up to `radius`,
 * resampled evenly. Unlike a spline it never swings outside its corners, so
 * vehicles can follow it between buildings.
 */
export function roundedPath(route: [number, number][], radius = 3, spacing = 0.5): [number, number][] {
  const raw: [number, number][] = [route[0]!];
  for (let i = 1; i < route.length - 1; i++) {
    const [px, pz] = route[i - 1]!;
    const [cx, cz] = route[i]!;
    const [nx, nz] = route[i + 1]!;
    const inLen = Math.hypot(cx - px, cz - pz);
    const outLen = Math.hypot(nx - cx, nz - cz);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a: [number, number] = [cx - ((cx - px) / inLen) * r, cz - ((cz - pz) / inLen) * r];
    const b: [number, number] = [cx + ((nx - cx) / outLen) * r, cz + ((nz - cz) / outLen) * r];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const u = 1 - t;
      raw.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cz + t * t * b[1]]);
    }
  }
  raw.push(route.at(-1)!);
  const s = pathSampler(raw);
  const n = Math.max(1, Math.ceil(s.length / spacing));
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = s.at((i / n) * s.length);
    return [p.x, p.z];
  });
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
  [-48, 40],
];

/** Route a unit file travels from the Quadlet department to the systemd Business Center. */
export const quadletRoute: [number, number][] = [...quadletRoad, [-48, 81]];

/** Quadlet office building and the board where the unit file is pinned. */
export function quadletOffice(): { building: { x: number; z: number }; board: { x: number; z: number } } {
  const q = districts.quadlet;
  return { building: { x: q.x - 3, z: q.z - 1 }, board: { x: q.x + 5, z: q.z + 2 } };
}

/** Pavilion for the n-th deployed quadlet: a row on the host highway's north roadside, east of the systemd tower. */
export function quadletPavilionSlot(n: number): { x: number; z: number } {
  const b = districts.businessCenter;
  return { x: b.x + 9 + n * 6.5, z: b.z + 1 };
}

/** systemd tower: a lobby block, then one floor per generated service unit on top. */
export const SYSTEMD_TOWER = { w: 8, base: 9, floor: 3 };

/** Height of the systemd tower with n unit floors. */
export function systemdTowerHeight(n: number): number {
  return SYSTEMD_TOWER.base + n * SYSTEMD_TOWER.floor;
}

/** Plate for the n-th generated unit, on the city-facing (north) wall of its own floor of the systemd tower. */
export function unitPlateSlot(n: number): { x: number; y: number; z: number } {
  const b = districts.businessCenter;
  return { x: b.x, y: 0.3 + systemdTowerHeight(n) + SYSTEMD_TOWER.floor / 2, z: b.z - SYSTEMD_TOWER.w / 2 - 0.05 };
}

/** Road from the systemd Business Center north through a gate in the south wall, to the Environmental Shopping Center's front. */
export const serviceRoute: [number, number][] = [
  [-48, 81],
  [-48, 40],
  [-34, 40],
  [-34, 35],
];

/** Where the service road passes through the city wall. */
export function serviceGate(): { x: number; z: number } {
  const [x] = serviceRoute[0]!;
  return { x, z: wallZ(x) };
}

/**
 * The factory wall round the city: straight sides, 3 m high. The west side stands where the old round perimeter
 * reached (CITY_RADIUS from the centre); the north side runs right behind the R&D Department, the east side just past
 * the Locker Yard (with the railway portal), and the south side straight between the city and the host highway, with
 * a gate where the service road passes through (the visitor bridge passes over it).
 */
export const CITY_WALL = {
  west: -CITY_RADIUS,
  east: districts.lockers.x + districts.lockers.w / 2 + 4,
  north: districts.rnd.z - districts.rnd.d / 2 - 2,
  south: 76,
  height: 3,
  thickness: 0.8,
};

/** Whether a ground point lies inside the wall, at least `margin` from it. */
export function insideWall(x: number, z: number, margin = 0): boolean {
  const w = CITY_WALL;
  return x > w.west + margin && x < w.east - margin && z > w.north + margin && z < w.south - margin;
}

/** z where a north-south line at x crosses the (south) wall. */
export function wallZ(_x: number): number {
  return CITY_WALL.south;
}

const SLOT_COLS = 5;
const SLOT_SPACING = 12;
const BELT_LANE = 3; // strip along the north edge of the factory district for network belts

/** ISO 20ft shipping container, metres (length x width x height). */
export const ISO_20FT = { l: 6.06, w: 2.44, h: 2.59 };

/** Container (factory) building: an ISO 20ft box scaled up, long side north-south, doors facing south. */
const FACTORY_SCALE = 8 / ISO_20FT.l;
export const FACTORY = { w: ISO_20FT.w * FACTORY_SCALE, h: ISO_20FT.h * FACTORY_SCALE, l: 8 };

/**
 * Pedestrian visitor bridge for a published port: deck height (clears the deploy trucks on the plot lanes), deck
 * width, length of the stair down to the host highway, and height of the port gate it passes under in the wall.
 */
export const FOOTBRIDGE = { deck: FACTORY.h + 2, width: 2.2, stairs: 9, gate: 8.5 };

/** Visitor bridge for a factory's i-th published port, running due south along z. */
export interface PortBridge {
  x: number;
  from: number; // stair kiosk on the front of the factory roof
  stub: number; // where the always-standing deck stops: its northernmost pier, outside the hall; a published port extends it to the kiosk
  landing: number; // where the deck ends and the stair down begins
  to: number; // foot of the stair, at the host highway's edge
  piers: number[]; // z of each pier under the deck
}

/**
 * Visitor bridge for a factory's i-th published port: from a stair kiosk on the front of its roof, due south over
 * the plot lanes and the city wall (through the port gate), then a stair down to the host highway's edge. Piers
 * stand only south of the Factory District, clear of the wall, so no truck lane or plot is blocked.
 */
export function portBridge(factory: { x: number; z: number }, i: number): PortBridge {
  const x = factory.x + i * 3;
  const to = districts.hostLand.z - districts.hostLand.d / 2;
  const landing = to - FOOTBRIDGE.stairs;
  const f = districts.factories;
  const wall = wallZ(x);
  const piers: number[] = [];
  for (let z = f.z + f.d / 2 + 4; z < landing - 1; z += 8) if (Math.abs(z - wall) > 2) piers.push(z);
  const front = factory.z + FACTORY.l / 2;
  return { x, from: front - 1.2, stub: piers[0] ?? front + 2.5, landing, to, piers };
}

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

/**
 * The city's visitor bridge: always standing, in the column of the first factory plot (where `web`, the container
 * whose port is published, is built), its deck ending at its northernmost pier, outside the Factory District hall,
 * until a port is published there and the extension runs into the hall to the factory.
 */
export const visitorBridge = portBridge(factorySlot(0), 0);

/** Where the deploy truck parks and loads image containers: between the warehouse and the factory district. */
export const truckBay = { x: -31, z: -12 };

/** Bays for the extra trucks compose brings in to deploy a whole stack at once, beside the main bay. */
export const extraTruckBays = [
  { x: -31, z: -16.5 },
  { x: -31, z: -7.5 },
  { x: -31, z: -3 },
];

/**
 * Car park for the three extra trucks compose brings in: south of the Factory District hall, between the visitor
 * bridge and the Locker Yard. Its exit lane runs west under the bridge to the truck corridor.
 */
export const parkingLot = { x: 2, z: 33, w: 14, d: 12 };

/** Stalls in the car park, one per extra truck (and its loading bay): side by side, parked facing west to the exit. */
export const parkingStalls = [-3.5, 0, 3.5].map((dz) => ({ x: parkingLot.x + 0.5, z: parkingLot.z + dz }));

/** Lane south of a plot row (clear of the buildings and the next row) the truck drives along to a plot. */
export function deployLaneZ(factory: { z: number }): number {
  return factory.z + FACTORY.l / 2 + 2; // middle of the 4 m gap between plot rows
}

/** Truck route from the loading bay to just in front of a factory plot. */
export function deployRoute(factory: { x: number; z: number }, bay: { x: number; z: number } = truckBay): [number, number][] {
  const lane = deployLaneZ(factory);
  return roundedPath([
    [bay.x, bay.z],
    [bay.x + 5, lane],
    [factory.x - 6, lane],
    [factory.x, lane],
  ]);
}

/** North-south corridor between the warehouse hall and the factory district, used by the truck. */
const TRUCK_CORRIDOR_X = -24;

/** East-west lane in front of the Environmental Shopping Center, where the truck picks up env cards. */
export function pickupLaneZ(): number {
  const sc = districts.shoppingCenter;
  return sc.z + sc.d / 2 + 4;
}

/** Where the truck stops in front of the Environmental Shopping Center to pick up env cards. */
export function shopStop(): { x: number; z: number } {
  return { x: districts.shoppingCenter.x, z: pickupLaneZ() };
}

/**
 * Where the truck stops in front of the Secret Facility (behind the factory
 * hall) to collect sealed secret documents. No road leads there: the truck
 * reaches it up the corridor and along the strip north of the hall.
 */
export function secretStop(): { x: number; z: number } {
  const f = districts.secrets;
  return { x: f.x, z: f.z + f.d / 2 + 3 };
}

/** Bay -> first pickup stop: along the corridor (south to the shopping center, north to the Secret Facility), then along its lane. */
export function bayToStopRoute(stop: { x: number; z: number }, bay: { x: number; z: number } = truckBay): [number, number][] {
  const dir = Math.sign(stop.z - bay.z);
  return roundedPath([
    [bay.x, bay.z],
    [TRUCK_CORRIDOR_X, bay.z + 6 * dir],
    [TRUCK_CORRIDOR_X, stop.z],
    [stop.x, stop.z],
  ]);
}

/** Lane down the east edge of the truck bays, next to the corridor: how the car park's trucks reach their bays. */
const BAY_LINK_X = TRUCK_CORRIDOR_X - 1.5;

/**
 * Car park stall -> loading bay: out of the car park, west along its exit lane under the visitor bridge to the
 * corridor, north up the corridor's west edge past the main truck, and west into the bay (arriving facing west).
 */
export function lotToBayRoute(stall: { x: number; z: number }, bay: { x: number; z: number }): [number, number][] {
  const exit = parkingLot.x - parkingLot.w / 2;
  return roundedPath([
    [stall.x, stall.z],
    [exit, parkingLot.z],
    [BAY_LINK_X, parkingLot.z],
    [BAY_LINK_X, bay.z],
    [bay.x, bay.z],
  ]);
}

/**
 * Roads under the deploy truck's routes (the routes above, straightened): the pickup lane in front of the
 * Environmental Shopping Center, the corridor north between the warehouse and the factories, the strip
 * behind the factory hall to the Secret Facility, the apron of the truck bays with its spur and link to the
 * corridor, the lane in front of the first row of plots, the car park's exit lane to the corridor, the corridor's
 * extension south to the freight station's loading lane, and the loop from its east end round the car park back to the
 * corridor, with a spur into the car park.
 * Published-port footbridges cross over them.
 */
export function truckRoads(): { points: [number, number][]; width: number }[] {
  const shop = shopStop();
  const secret = secretStop();
  const bays = [truckBay, ...extraTruckBays];
  const bayZ = bays.map((b) => b.z);
  const lane = deployLaneZ(factorySlot(0));
  const lastPlot = factorySlot(SLOT_COLS - 1);
  const freight = freightLayout();
  return [
    { points: [[shop.x, shop.z], [TRUCK_CORRIDOR_X, shop.z], [TRUCK_CORRIDOR_X, secret.z], [secret.x, secret.z]], width: 4 },
    { points: [[truckBay.x, Math.min(...bayZ) - 1.5], [truckBay.x, Math.max(...bayZ) + 1.5]], width: 8 }, // bay apron, trucks park across it
    { points: [[truckBay.x + 4, truckBay.z], [TRUCK_CORRIDOR_X, truckBay.z]], width: 4 },
    { points: [[TRUCK_CORRIDOR_X, lane], [lastPlot.x, lane]], width: 3 }, // fits the gap in front of the plot row
    { points: [[parkingLot.x - parkingLot.w / 2, parkingLot.z], [TRUCK_CORRIDOR_X, parkingLot.z]], width: 4 }, // car park exit
    { points: [[BAY_LINK_X, Math.min(...bayZ) - 1.5], [BAY_LINK_X, Math.max(...bayZ) + 1.5]], width: 3 }, // bays <-> corridor link
    { points: [[TRUCK_CORRIDOR_X, shop.z], [TRUCK_CORRIDOR_X, freight.loadZ], [FREIGHT_LOOP_X, freight.loadZ], [FREIGHT_LOOP_X, FREIGHT_LOOP_Z], [TRUCK_CORRIDOR_X, FREIGHT_LOOP_Z]], width: 4 }, // freight loading lane and loop
    { points: [[FREIGHT_LOOP_X, parkingLot.z], [parkingLot.x + parkingLot.w / 2, parkingLot.z]], width: 4 }, // loop -> car park spur
  ];
}

/** One pickup stop to the next: straight along a shared lane, otherwise via the corridor. */
export function stopToStopRoute(from: { x: number; z: number }, to: { x: number; z: number }): [number, number][] {
  if (from.z === to.z) return roundedPath([[from.x, from.z], [to.x, to.z]]);
  return roundedPath([
    [from.x, from.z],
    [TRUCK_CORRIDOR_X, from.z],
    [TRUCK_CORRIDOR_X, to.z],
    [to.x, to.z],
  ]);
}

/** Last pickup stop -> back to the corridor, along it to the plot row's lane, and along the lane to the plot. */
export function stopToPlotRoute(stop: { x: number; z: number }, factory: { x: number; z: number }): [number, number][] {
  const lane = deployLaneZ(factory);
  return roundedPath([
    [stop.x, stop.z],
    [TRUCK_CORRIDOR_X, stop.z],
    [TRUCK_CORRIDOR_X, lane],
    [factory.x, lane],
  ]);
}

/** Freight train: a flatcar carries one 20ft container; the locomotive is a bit shorter. */
export const TRAIN = { car: ISO_20FT.l + 1.2, loco: 6, gauge: 1.5 };

/**
 * Freight station south of the car park: trucks come down the corridor and along the loading lane on its north
 * side; a gantry crane spans the lane and the track on its south side and loads containers onto the waiting train,
 * which leaves east along the railway, through a portal in the wall, towards the OpenShift metropolis.
 */
export function freightLayout(): {
  loadZ: number; // loading lane, under the crane
  railZ: number; // track
  crane: { x: number; z: number; span: number }; // gantry centre (over the middle flatcar) and its span (north-south)
  train: { loco: number; cars: number[] }; // x of the waiting train's locomotive (east end) and of each flatcar
  track: { from: number; to: number }; // x of the buffer stop (west) and where the rails run off the ground (east)
  portal: { x: number; z: number }; // where the railway passes through the east wall
} {
  const f = districts.freight;
  const loadZ = f.z - 3;
  const railZ = f.z + 4;
  const groundEdge = Math.sqrt((CITY_RADIUS + 50) ** 2 - railZ ** 2);
  const buffer = f.x - f.w / 2 + 1.5;
  // Three flatcars from just east of the buffer stop, the locomotive at the east end, facing the exit.
  const cars = [0, 1, 2].map((i) => buffer + 0.5 + TRAIN.car / 2 + i * TRAIN.car);
  const crane = { x: cars[1]!, z: (loadZ + railZ) / 2 - 0.25, span: railZ - loadZ + 5.5 };
  return {
    loadZ,
    railZ,
    crane,
    train: { loco: cars.at(-1)! + TRAIN.car / 2 + TRAIN.loco / 2, cars },
    track: { from: buffer, to: groundEdge - 4 },
    portal: { x: CITY_WALL.east, z: railZ },
  };
}

/** Timetable board by the freight station: east of it, beside the end of the loading lane, facing south. */
export function timetableStand(): { x: number; z: number } {
  const f = districts.freight;
  return { x: f.x + f.w / 2 + 5, z: f.z - 3 };
}

/**
 * The freight loop: past the crane the loading lane carries on east, then north up the car park's east side
 * (with a spur west into the car park) and west along the gap between the factory hall and the car park (between
 * two visitor bridge piers) back to the corridor. Trucks drive on round it after unloading, so the next can come
 * down the lane at once.
 */
const FREIGHT_LOOP_X = parkingLot.x + parkingLot.w / 2 + 7;
const FREIGHT_LOOP_Z = districts.factories.z + districts.factories.d / 2 + 8;

/** After unloading at the crane: round the loop and up the corridor back to the loading bay (arriving facing west). */
export function freightToBayRoute(bay: { x: number; z: number }): [number, number][] {
  const fl = freightLayout();
  return roundedPath([
    [fl.crane.x, fl.loadZ],
    [FREIGHT_LOOP_X, fl.loadZ],
    [FREIGHT_LOOP_X, FREIGHT_LOOP_Z],
    [TRUCK_CORRIDOR_X, FREIGHT_LOOP_Z],
    [TRUCK_CORRIDOR_X, bay.z],
    [bay.x, bay.z],
  ]);
}

/** After unloading at the crane: up the loop and in by the car park's east spur to its stall (arriving facing west). */
export function freightToLotRoute(stall: { x: number; z: number }): [number, number][] {
  const fl = freightLayout();
  return roundedPath([
    [fl.crane.x, fl.loadZ],
    [FREIGHT_LOOP_X, fl.loadZ],
    [FREIGHT_LOOP_X, parkingLot.z],
    [parkingLot.x + parkingLot.w / 2, parkingLot.z],
    [stall.x, stall.z],
  ]);
}

/** Truck route from a loading bay east to the corridor, south down it and east along the freight loading lane to the crane. */
export function bayToFreightRoute(bay: { x: number; z: number }): [number, number][] {
  const fl = freightLayout();
  return roundedPath([
    [bay.x, bay.z],
    [TRUCK_CORRIDOR_X, bay.z],
    [TRUCK_CORRIDOR_X, fl.loadZ],
    [fl.crane.x, fl.loadZ],
  ]);
}

/** Width of each sidewalk along the host highway. */
export const SIDEWALK = 2.5;

/** Sidewalks along both sides of the host highway, as long as it and equally broad. */
export function hostSidewalks(): { north: Pad; south: Pad } {
  const h = districts.hostLand;
  return {
    north: { x: h.x, z: h.z - h.d / 2 - SIDEWALK / 2, w: h.w, d: SIDEWALK },
    south: { x: h.x, z: h.z + h.d / 2 + SIDEWALK / 2, w: h.w, d: SIDEWALK },
  };
}

/** Gate pillars are 1.4 m wide each side of the opening. */
const GATE_PILLAR = 1.4;

/**
 * Openings in the wall, each the width of what passes through plus its gate's pillars: on the south side the
 * service road's gate; on the east side the railway portal. The wall stays closed under the visitor bridge, whose
 * deck passes over it through its port gate.
 */
export function wallGates(): { side: 'south' | 'east'; at: number; width: number }[] {
  return [
    { side: 'south', at: serviceGate().x, width: 4 + 2 * GATE_PILLAR },
    { side: 'east', at: freightLayout().railZ, width: TRAIN.gauge + 2.6 + 2 * GATE_PILLAR },
  ];
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

/** A storage locker (named volume). */
export const LOCKER = { w: 3.5, h: 4, d: 3.5 };

/** Lockers that fit in one row of the yard. */
export const LOCKERS_PER_ROW = Math.floor((districts.lockers.w - 3 + LOCKER.w / 2) / 5) + 1;

/**
 * Empty lockers waiting for a volume: every slot of the volume row, plus a
 * second row behind it (south, away from the gate). Volumes fill the first row.
 */
export function spareLockerSlots(): { x: number; z: number }[] {
  const front = Array.from({ length: LOCKERS_PER_ROW }, (_, n) => lockerSlot(n));
  return [...front, ...front.map(({ x, z }) => ({ x, z: z + 5 }))];
}

/** Where the n-th image (its shipping container, standing north-south) is kept along the warehouse front. */
export function manifestSlot(n: number): { x: number; z: number } {
  const w = districts.warehouse;
  return { x: w.x - w.w / 2 + 3 + n * 6.5, z: w.z - w.d / 2 + 5 };
}

/** Where the n-th feedback card waits outside a factory door. */
export function doorQueueSlot(factory: { x: number; z: number }, n: number): { x: number; z: number } {
  return { x: factory.x - 3 + (n % 5) * 1.5, z: factory.z + 5.5 + Math.floor(n / 5) * 1.2 };
}

export const HIGHWAY_LANES = 3;

/** Gaps between plot columns (east of systemd) the advertising stands take, right of the first host offices. */
const CONTAINERFILE_GAP = 2;
const COMPOSE_GAP = 3; // right of the Containerfile stand

/** x of the n-th gap between two factory plot columns, the first between columns 0 and 1. */
function columnGapX(n: number): number {
  const f = districts.factories;
  return f.x - f.w / 2 + SLOT_SPACING + n * SLOT_SPACING;
}

/**
 * Plot for the n-th host path: an office on the near (north) roadside of the host highway, between the wall
 * and the road. East of the systemd Business Center and its quadlet pavilions, each in the gap between two
 * factory plot columns, so published-port bridges (which run due south from a plot column) pass between them.
 * The gaps the Containerfile and compose stands stand in are skipped.
 */
export function hostPathSlot(n: number): { x: number; z: number } {
  const h = districts.hostLand;
  return { x: columnGapX(n < CONTAINERFILE_GAP ? n : n + 2), z: h.z - h.d / 2 - 4 };
}

/**
 * Containerfile advertising stand: on the host highway's north roadside, right (east) of the first host-path
 * offices in the next gap between plot columns, its board facing the highway (south) like the compose stand.
 * Wired to R&D by an arc. Billboards are built facing west; `yaw` turns them.
 */
export const containerfileStand = { x: columnGapX(CONTAINERFILE_GAP), z: districts.hostLand.z - districts.hostLand.d / 2 - 6, yaw: Math.PI / 2 };

/**
 * Compose advertising stand: on the host highway's north roadside, right (east) of the Containerfile stand in the
 * next gap between plot columns, its board facing the highway (south). `yaw` turns the stand, whose board is drawn
 * facing west, round to face south.
 */
export const composeStand = { x: columnGapX(COMPOSE_GAP), z: containerfileStand.z, yaw: Math.PI / 2 };
