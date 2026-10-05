import { describe, expect, it } from 'vitest';
import { CITY_RADIUS, FACTORY, ISO_20FT, pathSampler, pullPath, smoothPath, pullRoute, seaportLayout, hostPathSlot, quadletRoad, serviceRoute, wallXWest, buildRoute, labBenchSlot, SHELF_CAPACITY, districts, factorySlot, feederRoute, manifestSlot, networkBelt, shelfSlot, warehouseHall, type Pad } from './layout';

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

  it('places the systemd Business Center outside the wall', () => {
    expect(nearestPoint(districts.businessCenter)).toBeGreaterThan(CITY_RADIUS);
  });

  it('places the Demo Shopping Center next to the wall', () => {
    expect(farthestCorner(districts.shoppingCenter)).toBeGreaterThan(CITY_RADIUS - 10);
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

  it('keeps the R&D department clear of the warehouse hall, with its road ending in the warehouse', () => {
    const rnd = districts.rnd;
    expect(overlaps(warehouseHall(), rnd)).toBe(false);
    for (let n = 0; n < 4; n++) {
      const b = labBenchSlot(n);
      expect(Math.abs(b.x - rnd.x) < rnd.w / 2 && Math.abs(b.z - rnd.z) < rnd.d / 2, `bench ${n}`).toBe(true);
    }
    const [x, z] = buildRoute.at(-1)!;
    const w = districts.warehouse;
    expect(Math.abs(x - w.x) < w.w / 2 && Math.abs(z - w.z) < w.d / 2).toBe(true);
  });

  it('connects the Quadlet department to the service road inside the wall', () => {
    const q = districts.quadlet;
    const w = districts.warehouse;
    const b = districts.businessCenter;
    expect(q.z).toBeGreaterThan(w.z); // between the warehouse and systemd
    expect(q.z).toBeLessThan(b.z);
    const [, [x, z]] = quadletRoad as [unknown, [number, number]];
    expect(z).toBe(serviceRoute[0]![1]);
    expect(x).toBeGreaterThan(wallXWest(z)); // joins inside the wall, so the unit file uses the service gate
  });

  it('keeps host path sheds on the roadside, off the host highway', () => {
    const h = districts.hostLand;
    for (let n = 0; n < 5; n++) {
      const shed = hostPathSlot(n);
      expect(shed.z - 2.5, `shed ${n}`).toBeGreaterThan(h.z + h.d / 2);
      expect(Math.abs(shed.x - h.x), `shed ${n}`).toBeLessThan(h.w / 2);
    }
  });

  it('puts the seaport terminal on the quay, clear of the pull road, and the ship on open water', () => {
    const port = seaportLayout();
    const s = districts.seaport;
    const t = port.terminal;
    expect(overlaps(t, s) && t.x - t.w / 2 >= s.x - s.w / 2 && t.z + t.d / 2 <= s.z + s.d / 2).toBe(true);
    const [, roadZ] = pullRoute[0]!;
    expect(Math.abs(t.z - roadZ)).toBeGreaterThan(t.d / 2 + 2);
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
    const s = pathSampler(pullPath);
    expect(s.at(s.length).x).toBeCloseTo(districts.warehouse.x); // the pull belt ends in the warehouse
  });

  it('shapes container buildings like ISO 20ft shipping containers', () => {
    expect(FACTORY.l / FACTORY.w).toBeCloseTo(ISO_20FT.l / ISO_20FT.w);
    expect(FACTORY.h / FACTORY.w).toBeCloseTo(ISO_20FT.h / ISO_20FT.w);
  });
});
