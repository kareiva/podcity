import { describe, expect, it } from 'vitest';
import { CITY_RADIUS, serviceGate, roundedPath, bayToStopRoute, secretStop, shopStop, stopToPlotRoute, stopToStopRoute, deployLaneZ, deployRoute, truckBay, FACTORY, ISO_20FT, buildCranes, buildWaypoints, pullCranes, pullWaypoints, unpackSpot, smoothPath, seaportLayout, hostPathSlot, quadletRoad, serviceRoute, labBenchSlot, SHELF_CAPACITY, districts, factorySlot, feederRoute, manifestSlot, networkBelt, shelfSlot, warehouseHall, type Pad } from './layout';

const OUTSIDE = new Set(['seaport', 'hostLand', 'freight', 'businessCenter']);

const farthestCorner = (p: Pad) => Math.hypot(Math.abs(p.x) + p.w / 2, Math.abs(p.z) + p.d / 2);
const nearestPoint = (p: Pad) => Math.hypot(Math.max(Math.abs(p.x) - p.w / 2, 0), Math.max(Math.abs(p.z) - p.d / 2, 0));
const overlaps = (a: Pad, b: Pad) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;

describe('city layout', () => {
  const inside = Object.entries(districts).filter(([id]) => !OUTSIDE.has(id));

  it('keeps inner districts within the wall', () => {
    for (const [id, pad] of inside) expect(farthestCorner(pad), id).toBeLessThan(CITY_RADIUS);
  });

  it('has no overlapping inner districts', () => {
    for (const [a, pa] of inside)
      for (const [b, pb] of inside) if (a < b) expect(overlaps(pa, pb), `${a}/${b}`).toBe(false);
  });

  it('places the systemd Business Center outside the wall, beside the host highway, with its road through a wall gate', () => {
    const b = districts.businessCenter;
    const h = districts.hostLand;
    expect(nearestPoint(b)).toBeGreaterThan(CITY_RADIUS);
    expect(h.z - h.d / 2 - (b.z + b.d / 2)).toBeGreaterThanOrEqual(0); // on the roadside, not on the road
    expect(h.z - h.d / 2 - (b.z + b.d / 2)).toBeLessThan(3);
    const gate = serviceGate();
    expect(Math.hypot(gate.x, gate.z)).toBeCloseTo(CITY_RADIUS);
    expect(gate.z).toBeGreaterThan(serviceRoute[1]![1]); // the road crosses the wall between its first two points
    expect(gate.z).toBeLessThan(serviceRoute[0]![1]);
  });

  it('places the Environmental Shopping Center next to the Quadlet department, clear of the published-port roads', () => {
    const sc = districts.shoppingCenter;
    const q = districts.quadlet;
    expect(Math.hypot(sc.x - q.x, sc.z - q.z)).toBeLessThan(25);
    // Port roads run due south from each factory plot's door to the host highway.
    for (let n = 0; n < 15; n++) {
      const x = factorySlot(n).x;
      expect(Math.abs(x - sc.x), `plot ${n} port road`).toBeGreaterThan(sc.w / 2 + 2);
    }
    // Its road still enters through the wall gate from systemd.
    expect(serviceRoute.at(-1)![1]).toBeCloseTo(sc.z + sc.d / 2);
  });

  it('covers the manifest boards and shelves with the warehouse hall', () => {
    const hall = warehouseHall();
    const covers = (p: { x: number; z: number }) => Math.abs(p.x - hall.x) < hall.w / 2 && Math.abs(p.z - hall.z) < hall.d / 2;
    for (let n = 0; n < 3; n++) expect(covers(manifestSlot(n)), `manifest ${n}`).toBe(true);
    for (let n = 0; n < SHELF_CAPACITY; n++) expect(covers(shelfSlot(n)), `shelf ${n}`).toBe(true);
    expect(farthestCorner(hall)).toBeLessThan(CITY_RADIUS);
    for (const [id, pad] of inside) if (id !== 'warehouse') expect(overlaps(hall, pad), id).toBe(false);
  });

  it('runs the network belt north of every factory plot, with feeders inside the district', () => {
    const f = districts.factories;
    const belt = networkBelt(0);
    expect(Math.abs(belt.z - f.z)).toBeLessThan(f.d / 2);
    for (let n = 0; n < 15; n++) {
      const slot = factorySlot(n);
      expect(slot.z - 4, `plot ${n} clears the belt`).toBeGreaterThan(belt.z + 1);
      expect(slot.z + 4, `plot ${n} inside the district`).toBeLessThan(f.z + f.d / 2);
      for (const [x, z] of feederRoute(slot, belt)) {
        expect(Math.abs(x - f.x), `feeder ${n}`).toBeLessThanOrEqual(f.w / 2);
        expect(Math.abs(z - f.z), `feeder ${n}`).toBeLessThanOrEqual(f.d / 2);
      }
      // The feeder's north run stays in the gap between this plot and the next column.
      const [, [gapX]] = feederRoute(slot, belt) as [unknown, [number, number]];
      expect(gapX - slot.x).toBeGreaterThan(FACTORY.w / 2);
      expect(gapX - slot.x).toBeLessThan(12 - 4);
    }
  });

  it('keeps the R&D department clear of the warehouse hall', () => {
    const rnd = districts.rnd;
    expect(overlaps(warehouseHall(), rnd)).toBe(false);
    for (let n = 0; n < 4; n++) {
      const b = labBenchSlot(n);
      expect(Math.abs(b.x - rnd.x) < rnd.w / 2 && Math.abs(b.z - rnd.z) < rnd.d / 2, `bench ${n}`).toBe(true);
    }
  });

  it('connects the Quadlet department to the service road inside the wall', () => {
    const q = districts.quadlet;
    const w = districts.warehouse;
    const b = districts.businessCenter;
    expect(q.z).toBeGreaterThan(w.z); // between the warehouse and systemd
    expect(q.z).toBeLessThan(b.z);
    const [x, z] = quadletRoad.at(-1)!;
    expect(serviceRoute.some(([sx, sz]) => sx === x && sz === z)).toBe(true); // joins the service road
    expect(Math.hypot(x, z)).toBeLessThan(CITY_RADIUS); // inside the wall, so the unit file uses the service gate
  });

  it('keeps host path sheds on the roadside, off the host highway', () => {
    const h = districts.hostLand;
    for (let n = 0; n < 5; n++) {
      const shed = hostPathSlot(n);
      expect(shed.z - 2.5, `shed ${n}`).toBeGreaterThan(h.z + h.d / 2);
      expect(Math.abs(shed.x - h.x), `shed ${n}`).toBeLessThan(h.w / 2);
    }
  });

  it('puts the seaport terminal on the quay, clear of the container pick-up, and the ship on open water', () => {
    const port = seaportLayout();
    const s = districts.seaport;
    const t = port.terminal;
    expect(overlaps(t, s) && t.x - t.w / 2 >= s.x - s.w / 2 && t.z + t.d / 2 <= s.z + s.d / 2).toBe(true);
    const [, pickZ] = pullWaypoints[0]!;
    expect(Math.abs(t.z - pickZ)).toBeGreaterThan(t.d / 2 + 2);
    expect(port.ship.x + port.ship.beam / 2).toBeLessThan(port.quayX - 8); // room for the crane booms
  });

  it('smooths delivery paths through their endpoints with even spacing', () => {
    const route: [number, number][] = [[0, 0], [10, 0], [10, 10]];
    const path = smoothPath(route);
    expect(path[0]).toEqual([0, 0]);
    expect(path.at(-1)![0]).toBeCloseTo(10);
    expect(path.at(-1)![1]).toBeCloseTo(10);
    const steps = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i]![0], p[1] - path[i]![1]));
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.05);
  });

  it('relays image containers by crane from the quay and R&D to the unpacking spot in the warehouse', () => {
    const inPad = ([x, z]: [number, number], p: Pad) => Math.abs(x - p.x) < p.w / 2 && Math.abs(z - p.z) < p.d / 2;
    expect(inPad(pullWaypoints[0]!, districts.seaport)).toBe(true);
    expect(inPad(buildWaypoints[0]!, districts.rnd)).toBe(true);
    expect(inPad([unpackSpot.x, unpackSpot.z], warehouseHall())).toBe(true);
    for (const [cranes, waypoints] of [[pullCranes, pullWaypoints], [buildCranes, buildWaypoints]] as const) {
      expect(cranes).toHaveLength(1); // one tall crane spans each route
      expect(waypoints).toHaveLength(2);
      for (const c of cranes) {
        // Both ends of each leg lie on the jib's circle.
        expect(Math.hypot(c.from[0] - c.x, c.from[1] - c.z)).toBeCloseTo(c.radius);
        expect(Math.hypot(c.to[0] - c.x, c.to[1] - c.z)).toBeCloseTo(c.radius);
      }
    }
    // Masts stand clear of shelves, manifest boards, drop-off spots and each other.
    const masts = [...pullCranes, ...buildCranes];
    const keepOut = [
      ...Array.from({ length: SHELF_CAPACITY }, (_, n) => shelfSlot(n)),
      ...Array.from({ length: 4 }, (_, n) => manifestSlot(n)),
      ...[...pullWaypoints, ...buildWaypoints].map(([x, z]) => ({ x, z })),
    ];
    for (const m of masts) {
      expect(Math.hypot(m.x, m.z), `${m.name} inside the wall`).toBeLessThan(CITY_RADIUS - 2);
      for (const k of keepOut) expect(Math.hypot(m.x - k.x, m.z - k.z), m.name).toBeGreaterThan(4);
      for (const o of masts) if (o !== m) expect(Math.hypot(m.x - o.x, m.z - o.z)).toBeGreaterThan(4);
    }
  });

  it('shapes container buildings like ISO 20ft shipping containers', () => {
    expect(FACTORY.l / FACTORY.w).toBeCloseTo(ISO_20FT.l / ISO_20FT.w);
    expect(FACTORY.h / FACTORY.w).toBeCloseTo(ISO_20FT.h / ISO_20FT.w);
  });

  it('drives the deploy truck from its bay between the warehouse and factories along a lane clear of the plots', () => {
    expect(overlaps({ ...truckBay, w: 8, d: 3 }, warehouseHall())).toBe(false);
    expect(overlaps({ ...truckBay, w: 8, d: 3 }, districts.factories)).toBe(false);
    for (let n = 0; n < 10; n++) {
      const slot = factorySlot(n);
      const lane = deployLaneZ(slot);
      expect(lane - 1.35, `plot ${n}`).toBeGreaterThan(slot.z + FACTORY.l / 2); // south of the building
      expect(lane + 1.35, `plot ${n}`).toBeLessThan(slot.z + 12 - FACTORY.l / 2); // north of the next row
      const route = deployRoute(slot);
      expect(route[0]).toEqual([truckBay.x, truckBay.z]);
      expect(route.at(-1)![0]).toBeCloseTo(slot.x);
    }
  });

  it('routes the truck via the Environmental Shopping Center without driving through buildings', () => {
    const half = 1.32; // truck half-width (ISO width + bed overhang)
    const blocked: Pad[] = [
      warehouseHall(),
      districts.shoppingCenter,
      districts.quadlet,
      districts.secrets,
      ...Array.from({ length: 10 }, (_, n) => ({ ...factorySlot(n), w: FACTORY.w + 3, d: FACTORY.l })), // incl. scratch bins
    ];
    const inside = ([x, z]: [number, number], p: Pad) => Math.abs(x - p.x) < p.w / 2 + half && Math.abs(z - p.z) < p.d / 2 + half;
    const routes = [
      bayToStopRoute(shopStop()),
      stopToStopRoute(shopStop(), secretStop()),
      ...Array.from({ length: 5 }, (_, n) => stopToPlotRoute(secretStop(), factorySlot(n))),
      ...Array.from({ length: 5 }, (_, n) => stopToPlotRoute(shopStop(), factorySlot(n))),
    ];
    for (const route of routes)
      for (const p of route.slice(3, -3)) // ends sit at the bay/shop/plot fronts
        for (const b of blocked) expect(inside(p, b), `${p} in ${JSON.stringify(b)}`).toBe(false);
    const stop = shopStop();
    expect(stop.z - districts.shoppingCenter.z).toBeGreaterThan(districts.shoppingCenter.d / 2 + half); // in front, not inside
  });

  it('rounds truck route corners without overshooting them', () => {
    const path = roundedPath([[0, 0], [10, 0], [10, 10]], 3);
    expect(path[0]).toEqual([0, 0]);
    expect(path.at(-1)![0]).toBeCloseTo(10);
    expect(path.at(-1)![1]).toBeCloseTo(10);
    for (const [x, z] of path) {
      expect(x).toBeLessThanOrEqual(10 + 1e-9); // never past the corner
      expect(z).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('puts the Secret Facility between the shopping center and the locker yard, clear of every port road', () => {
    const f = districts.secrets;
    expect(f.x).toBeGreaterThan(districts.shoppingCenter.x);
    expect(f.x).toBeLessThan(districts.lockers.x);
    const roadHalf = 2.5 / 2;
    for (let n = 0; n < 5; n++) {
      // Port roads run due south from each plot column's door.
      expect(Math.abs(factorySlot(n).x - f.x), `column ${n}`).toBeGreaterThan(f.w / 2 + roadHalf);
    }
    expect(overlaps(f, districts.shoppingCenter)).toBe(false);
    expect(overlaps(f, districts.lockers)).toBe(false);
    expect(secretStop().z - (f.z + f.d / 2)).toBeGreaterThan(1.32); // the truck stops in front, not inside
  });
});
