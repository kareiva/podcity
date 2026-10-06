import { describe, expect, it } from 'vitest';
import { hostSidewalks, CITY_WALL, insideWall, wallGates, bayToFreightRoute, freightToBayRoute, freightToLotRoute, freightLayout, TRAIN, parkingLot, parkingStalls, lotToBayRoute, extraTruckBays, FOOTBRIDGE, portBridge, visitorBridge, wallZ, containerfileStand, truckRoads, composeStand, spareLockerSlots, LOCKER, lockerSlot, quadletPavilionSlot, CITY_RADIUS, serviceGate, roundedPath, bayToStopRoute, secretStop, shopStop, stopToPlotRoute, stopToStopRoute, deployLaneZ, deployRoute, truckBay, FACTORY, ISO_20FT, buildCranes, buildWaypoints, pullCranes, pullWaypoints, unpackSpot, smoothPath, seaportLayout, hostPathSlot, quadletRoad, serviceRoute, labBenchSlot, SHELF_CAPACITY, districts, factorySlot, feederRoute, manifestSlot, networkBelt, shelfSlot, warehouseHall, type Pad } from './layout';

const OUTSIDE = new Set(['seaport', 'hostLand', 'businessCenter']);

/** Whether a whole pad lies inside the wall (and clear of it by `margin`). */
const padInside = (p: Pad, margin = 0) => insideWall(p.x - p.w / 2, p.z - p.d / 2, margin) && insideWall(p.x + p.w / 2, p.z + p.d / 2, margin);
/** Whether a whole pad lies outside the wall, south of it (the host side). */
const southOfWall = (p: Pad) => p.z - p.d / 2 > CITY_WALL.south + CITY_WALL.thickness / 2;
const overlaps = (a: Pad, b: Pad) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;

describe('city layout', () => {
  const inside = Object.entries(districts).filter(([id]) => !OUTSIDE.has(id));

  it('keeps inner districts within the wall', () => {
    for (const [id, pad] of inside) expect(padInside(pad), id).toBe(true);
  });

  it('has no overlapping inner districts', () => {
    for (const [a, pa] of inside)
      for (const [b, pb] of inside) if (a < b) expect(overlaps(pa, pb), `${a}/${b}`).toBe(false);
  });

  it('places the systemd Business Center outside the wall, beside the host highway, with its road through a wall gate', () => {
    const b = districts.businessCenter;
    const h = districts.hostLand;
    expect(southOfWall(b)).toBe(true);
    expect(h.z - h.d / 2 - (b.z + b.d / 2)).toBeGreaterThanOrEqual(0); // on the roadside, not on the road
    expect(h.z - h.d / 2 - (b.z + b.d / 2)).toBeLessThan(3);
    const gate = serviceGate();
    expect(gate.z).toBe(CITY_WALL.south);
    expect(wallGates().some((g) => g.side === 'south' && g.at === gate.x)).toBe(true); // an opening in the wall
    expect(gate.z).toBeGreaterThan(serviceRoute[1]![1]); // the road crosses the wall between its first two points
    expect(gate.z).toBeLessThan(serviceRoute[0]![1]);
  });

  it('places the Environmental Shopping Center next to the Quadlet department, clear of the published-port bridges', () => {
    const sc = districts.shoppingCenter;
    const q = districts.quadlet;
    expect(Math.hypot(sc.x - q.x, sc.z - q.z)).toBeLessThan(25);
    // Port bridges run due south from each factory plot's roof to the host highway.
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
    expect(padInside(hall)).toBe(true);
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
    expect(insideWall(x, z)).toBe(true); // inside the wall, so the unit file uses the service gate
  });

  it('lays roads under every truck route, clear of the buildings they pass', () => {
    const roads = truckRoads();
    const half = 0.5; // sample points every half metre along each road
    const onRoad = ([x, z]: [number, number]) =>
      roads.some(({ points, width }) =>
        points.slice(1).some(([bx, bz], i) => {
          const [ax, az] = points[i]!;
          const len = Math.hypot(bx - ax, bz - az);
          const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (len * len)));
          return Math.hypot(x - (ax + (bx - ax) * t), z - (az + (bz - az) * t)) <= width / 2 + half;
        }),
      );
    const routes = [
      bayToStopRoute(shopStop()),
      stopToStopRoute(shopStop(), secretStop()),
      ...Array.from({ length: 5 }, (_, n) => stopToPlotRoute(secretStop(), factorySlot(n))),
      ...Array.from({ length: 5 }, (_, n) => deployRoute(factorySlot(n))),
      ...parkingStalls.map((stall, i) => lotToBayRoute(stall, extraTruckBays[i]!).filter(([x]) => x < parkingLot.x - parkingLot.w / 2)), // out of the car park
      ...[truckBay, ...extraTruckBays].flatMap((bay) => [bayToFreightRoute(bay).filter(([x]) => x > bay.x + 4), freightToBayRoute(bay).filter(([x]) => x > bay.x + 4)]), // to the freight station and round the loop
      ...parkingStalls.map((stall) => freightToLotRoute(stall).filter(([x]) => x > parkingLot.x + parkingLot.w / 2)), // round the loop into the car park
    ];
    for (const route of routes) for (const p of route) expect(onRoad(p), `${p}`).toBe(true);
    const blocked: Pad[] = [warehouseHall(), districts.secrets, districts.shoppingCenter, ...Array.from({ length: 5 }, (_, n) => ({ ...factorySlot(n), w: FACTORY.w, d: FACTORY.l }))];
    for (const { points, width } of roads)
      for (const [x, z] of points)
        for (const b of blocked) expect(Math.abs(x - b.x) < b.w / 2 + width / 2 - 1 && Math.abs(z - b.z) < b.d / 2 + width / 2 - 1, `${x},${z}`).toBe(false);
  });

  it('stands the compose billboard right of the Containerfile billboard, facing the highway, clear of everything there', () => {
    const h = districts.hostLand;
    const stand = { x: composeStand.x, z: composeStand.z, w: 8.8, d: 2.4 }; // turned: billboard runs east-west
    expect(stand.x).toBeGreaterThan(containerfileStand.x); // to its right
    expect(stand.x - containerfileStand.x).toBeLessThan(15); // next to it
    expect(stand.z + stand.d / 2).toBeLessThan(h.z - h.d / 2); // on the roadside, not on the highway
    expect(Math.abs(stand.x - h.x) + stand.w / 2).toBeLessThan(h.w / 2);
    expect(southOfWall(stand)).toBe(true); // outside the wall
    expect(overlaps(stand, { x: containerfileStand.x, z: containerfileStand.z, w: 8.8, d: 2.4 })).toBe(false);
    for (let n = 0; n < 5; n++) expect(overlaps(stand, { ...hostPathSlot(n), w: 5, d: 5 }), `office ${n}`).toBe(false);
    for (let c = 0; c < 5; c++) expect(Math.abs(factorySlot(c).x - stand.x), `port bridge ${c}`).toBeGreaterThan(stand.w / 2 + 2.5 / 2);
  });

  it('fills the locker yard with spare lockers that fit inside it, the volume row among them', () => {
    const y = districts.lockers;
    const spares = spareLockerSlots();
    expect(spares.length).toBeGreaterThan(6);
    for (const s of spares) {
      expect(Math.abs(s.x - y.x) + LOCKER.w / 2).toBeLessThanOrEqual(y.w / 2);
      expect(Math.abs(s.z - y.z) + LOCKER.d / 2).toBeLessThanOrEqual(y.d / 2);
    }
    expect(spares).toContainEqual(lockerSlot(0)); // a volume's locker rises over a spare
  });

  it('keeps host path offices on the near roadside: off the highway, outside the wall, clear of systemd and port bridges', () => {
    const h = districts.hostLand;
    const office = (n: number) => ({ ...hostPathSlot(n), w: 5, d: 5 });
    const roadHalf = 2.5 / 2;
    for (let n = 0; n < 5; n++) {
      const o = office(n);
      expect(o.z + o.d / 2, `office ${n}`).toBeLessThan(h.z - h.d / 2); // north of the highway
      expect(Math.abs(o.x - h.x) + o.w / 2, `office ${n}`).toBeLessThan(h.w / 2);
      expect(southOfWall({ ...o, d: o.d + 2 }), `office ${n} (and its SELinux fence) outside the wall`).toBe(true);
      expect(overlaps(o, districts.businessCenter)).toBe(false);
      for (let p = 0; p < 3; p++) expect(overlaps(o, { ...quadletPavilionSlot(p), w: 4.4, d: 4.4 }), `office ${n} / pavilion ${p}`).toBe(false);
      for (let c = 0; c < 5; c++) expect(Math.abs(factorySlot(c).x - o.x), `office ${n} / port road ${c}`).toBeGreaterThan(o.w / 2 + roadHalf);
    }
  });

  it('stands the Containerfile billboard right of the host offices, facing the highway, clear of everything there', () => {
    const h = districts.hostLand;
    const stand = { x: containerfileStand.x, z: containerfileStand.z, w: 8.8, d: 2.4 }; // turned: board runs east-west
    expect(stand.z + stand.d / 2).toBeLessThan(h.z - h.d / 2); // on the roadside, not on the highway
    expect(Math.abs(stand.x - h.x) + stand.w / 2).toBeLessThan(h.w / 2);
    expect(southOfWall(stand)).toBe(true); // outside the wall
    expect(stand.x).toBeGreaterThan(hostPathSlot(1).x); // right of the scenario's two offices
    for (let n = 0; n < 5; n++) expect(overlaps(stand, { ...hostPathSlot(n), w: 5, d: 5 }), `office ${n}`).toBe(false);
    for (let c = 0; c < 5; c++) expect(Math.abs(factorySlot(c).x - stand.x), `port road ${c}`).toBeGreaterThan(stand.w / 2 + 2.5 / 2);
    expect(overlaps(stand, districts.businessCenter)).toBe(false);
    expect(overlaps(stand, { x: composeStand.x, z: composeStand.z, w: 8.8, d: 2.4 })).toBe(false);
  });

  it('carries published ports on visitor bridges that clear the trucks, keep piers off the roads and land on the highway', () => {
    const truckTop = 1.1 + ISO_20FT.h + 0.5; // bed, container, cards on its roof
    expect(FOOTBRIDGE.deck - 0.7).toBeGreaterThan(truckTop); // girders above the plot lanes
    expect(FOOTBRIDGE.gate).toBeGreaterThan(FOOTBRIDGE.deck + 2.2); // visitors walk under the port gate
    const f = districts.factories;
    const h = districts.hostLand;
    for (let c = 0; c < 5; c++) {
      const b = portBridge(factorySlot(c), 0);
      expect(b.from).toBeLessThan(factorySlot(c).z + FACTORY.l / 2); // kiosk on the roof
      expect(b.to).toBe(h.z - h.d / 2); // stair ends at the highway's edge
      expect(b.landing).toBeGreaterThan(wallZ(b.x) + 2); // stair outside the wall
      for (const z of b.piers) {
        expect(z).toBeGreaterThan(f.z + f.d / 2); // no piers among the plots and lanes
        expect(Math.abs(z - wallZ(b.x))).toBeGreaterThan(2);
        for (const { points, width } of truckRoads())
          for (const [i, [bx, bz]] of points.slice(1).entries()) {
            const [ax, az] = points[i]!;
            const road = { x: (ax + bx) / 2, z: (az + bz) / 2, w: Math.abs(bx - ax) || width, d: Math.abs(bz - az) || width };
            expect(overlaps({ x: b.x, z, w: 1, d: 1 }, road)).toBe(false);
          }
      }
      expect(b.piers.length).toBeGreaterThan(3);
    }
    // The city's bridge stands in the first plot's column; only a published port takes it into the hall.
    const web = factorySlot(0);
    expect(visitorBridge.x).toBe(web.x);
    expect(visitorBridge.stub).toBe(visitorBridge.piers[0]); // ends at its last column...
    expect(visitorBridge.stub).toBeGreaterThan(districts.factories.z + districts.factories.d / 2); // ...outside the hall
    expect(visitorBridge.from).toBeLessThan(web.z + FACTORY.l / 2); // a published port links it to a kiosk on the roof
  });

  it('puts the car park between the visitor bridge and the Locker Yard, clear of everything, a stall per extra truck', () => {
    const lot = parkingLot;
    const yard = districts.lockers;
    expect(lot.x - lot.w / 2).toBeGreaterThan(visitorBridge.x + FOOTBRIDGE.width / 2 + 1); // east of the bridge
    expect(lot.x + lot.w / 2).toBeLessThan(yard.x - yard.w / 2); // west of the Locker Yard
    for (const [id, d] of Object.entries(districts)) expect(overlaps(lot, d), id).toBe(false);
    expect(overlaps(lot, warehouseHall())).toBe(false);
    const corners = [[lot.x - lot.w / 2, lot.z - lot.d / 2], [lot.x + lot.w / 2, lot.z + lot.d / 2], [lot.x - lot.w / 2, lot.z + lot.d / 2], [lot.x + lot.w / 2, lot.z - lot.d / 2]];
    for (const [x, z] of corners) expect(insideWall(x!, z!)).toBe(true);
    expect(parkingStalls).toHaveLength(extraTruckBays.length);
    const truck = { l: 8.4, w: 2.7 };
    for (const s of parkingStalls) {
      expect(Math.abs(s.x - lot.x) + truck.l / 2).toBeLessThan(lot.w / 2);
      expect(Math.abs(s.z - lot.z) + truck.w / 2).toBeLessThan(lot.d / 2);
    }
    // The exit lane passes under the visitor bridge between two of its piers.
    for (const z of visitorBridge.piers) expect(Math.abs(z - lot.z)).toBeGreaterThan(2 + 0.5);
  });

  it('puts the freight station south of the car park, its crane over lane and track, the railway leaving east', () => {
    const f = districts.freight;
    const fl = freightLayout();
    expect(f.z - f.d / 2).toBeGreaterThan(parkingLot.z + parkingLot.d / 2); // south of the car park
    expect(Math.abs(f.x - parkingLot.x)).toBeLessThan(f.w / 2);
    expect(f.x - f.w / 2).toBeGreaterThan(visitorBridge.x + 2); // clear of the visitor bridge's piers
    // A truck road reaches the loading lane, and passes under the crane.
    const lane = truckRoads().find(({ points }) => points.some(([, z]) => z === fl.loadZ))!;
    expect(lane.points.some(([x, z]) => z === fl.loadZ && x > fl.crane.x + ISO_20FT.l / 2)).toBe(true); // carries on past the crane into the loop
    for (const z of visitorBridge.piers) expect(Math.abs(z - fl.loadZ)).toBeGreaterThan(lane.width / 2 + 0.5);
    // The crane spans both, inside the station.
    expect(fl.crane.z - fl.crane.span / 2).toBeLessThan(fl.loadZ - lane.width / 2);
    expect(fl.crane.z + fl.crane.span / 2).toBeGreaterThan(fl.railZ + TRAIN.gauge / 2 + ISO_20FT.w / 2);
    expect(Math.abs(fl.crane.z - f.z) + fl.crane.span / 2).toBeLessThan(f.d / 2);
    // The train stands on the track inside the station, the crane over its middle flatcar, locomotive east.
    expect(fl.train.cars[0]! - TRAIN.car / 2).toBeGreaterThan(fl.track.from);
    expect(fl.train.loco).toBeGreaterThan(Math.max(...fl.train.cars));
    expect(fl.crane.x).toBe(fl.train.cars[1]);
    expect(fl.train.loco + TRAIN.loco / 2).toBeLessThan(fl.portal.x);
    // The railway leaves through the east wall and runs on to the edge of the map, clear of the Locker Yard.
    expect(fl.portal.x).toBe(CITY_WALL.east);
    expect(wallGates().some((g) => g.side === 'east' && g.at === fl.railZ)).toBe(true); // an opening in the wall
    expect(fl.track.to).toBeGreaterThan(CITY_WALL.east);
    expect(Math.hypot(fl.track.to, fl.railZ)).toBeLessThan(CITY_RADIUS + 50);
    const yard = districts.lockers;
    expect(fl.railZ - TRAIN.gauge).toBeGreaterThan(yard.z + yard.d / 2);
    // The loop round the car park stays clear of it, the Locker Yard and the Factory District.
    const lot = { ...parkingLot };
    for (const { points, width } of truckRoads())
      for (const [i, [bx, bz]] of points.slice(1).entries()) {
        const [ax, az] = points[i]!;
        const seg = { x: (ax + bx) / 2, z: (az + bz) / 2, w: Math.abs(bx - ax) || width, d: Math.abs(bz - az) || width };
        expect(overlaps(seg, districts.lockers), `${ax},${az} -> ${bx},${bz}`).toBe(false);
        if (ax > lot.x + lot.w / 2 || bx > lot.x + lot.w / 2) expect(overlaps({ ...seg, w: Math.max(seg.w - 0.1, 0.1) }, { ...lot, w: lot.w - 0.2 })).toBe(false);
      }
  });

  it('walls the city with straight sides, north right behind R&D, east just past the Locker Yard, gates on the south side', () => {
    const w = CITY_WALL;
    expect(w.west).toBe(-CITY_RADIUS);
    const rnd = districts.rnd;
    expect(rnd.z - rnd.d / 2 - w.north).toBeGreaterThan(1); // the north side runs right behind R&D...
    expect(rnd.z - rnd.d / 2 - w.north).toBeLessThan(3);
    const yard = districts.lockers;
    expect(w.east - (yard.x + yard.w / 2)).toBeGreaterThan(2); // ...the east side just past the Locker Yard
    expect(w.east - (yard.x + yard.w / 2)).toBeLessThan(6);
    expect(w.height).toBe(3);
    // The south side runs between the city and the host: every inner district, road and the car park north of it,
    // systemd, its pavilions, the stands and the host offices south of it.
    for (const [id, pad] of inside) expect(padInside(pad, 1), id).toBe(true);
    for (const { points } of truckRoads()) for (const [x, z] of points) expect(insideWall(x, z, 1), `${x},${z}`).toBe(true);
    expect(padInside(parkingLot, 1)).toBe(true);
    expect(southOfWall(districts.businessCenter)).toBe(true);
    for (let p = 0; p < 3; p++) expect(southOfWall({ ...quadletPavilionSlot(p), w: 4.4, d: 4.4 })).toBe(true);
    // Openings: the service road on the south side, the railway on the east. The wall stays closed under the
    // visitor bridge, whose deck clears it.
    expect(wallGates().filter((g) => g.side === 'south').map((g) => g.at)).toEqual([serviceGate().x]);
    expect(FOOTBRIDGE.deck - 0.7).toBeGreaterThan(w.height + 0.2);
    expect(visitorBridge.landing).toBeGreaterThan(w.south + 2); // the bridge's stair comes down outside
  });

  it('lines the host highway with equally broad sidewalks on both sides', () => {
    const h = districts.hostLand;
    const { north, south } = hostSidewalks();
    expect(north.z + north.d / 2).toBeCloseTo(h.z - h.d / 2); // against the road
    expect(south.z - south.d / 2).toBeCloseTo(h.z + h.d / 2);
    expect(north.d).toBe(south.d);
    expect([north.w, south.w]).toEqual([h.w, h.w]);
    expect(north.z - north.d / 2).toBeGreaterThan(CITY_WALL.south + CITY_WALL.thickness); // clear of the wall
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
      expect(insideWall(m.x, m.z, 2), `${m.name} inside the wall`).toBe(true);
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
      districts.rnd,
      ...Array.from({ length: 10 }, (_, n) => ({ ...factorySlot(n), w: FACTORY.w + 3, d: FACTORY.l })), // incl. scratch bins
    ];
    const inside = ([x, z]: [number, number], p: Pad) => Math.abs(x - p.x) < p.w / 2 + half && Math.abs(z - p.z) < p.d / 2 + half;
    const routes = [
      bayToStopRoute(shopStop()),
      bayToStopRoute(secretStop()), // secret-only env
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

  it('puts the Secret Facility behind the factory hall, clear of the hall, belts and R&D', () => {
    const f = districts.secrets;
    const hall = districts.factories;
    expect(f.z + f.d / 2).toBeLessThan(hall.z - hall.d / 2); // north of the hall
    expect(secretStop().z - (f.z + f.d / 2)).toBeGreaterThan(1.32); // the truck stops in front, not inside
    expect(secretStop().z + 1.32).toBeLessThan(hall.z - hall.d / 2 - 1); // ...and outside the hall
    expect(secretStop().z + 1.32).toBeLessThan(networkBelt(1).z - 0.5); // ...clear of a second network's belt
    expect(overlaps(f, districts.rnd)).toBe(false);
    expect(padInside(f)).toBe(true);
  });
});
