import * as THREE from 'three';
import { tag } from './entity';
import { makeGate } from './gate';
import { makeLabel } from './label';
import {
  CITY_RADIUS,
  CRANE_HEIGHT,
  HIGHWAY_LANES,
  ISO_20FT,
  UNPACK_GANTRY_HEIGHT,
  buildCranes,
  craneYaw,
  pullCranes,
  unpackSpot,
  truckBay,
  type CraneSpec,
  seaportLayout,
  districts, quadletOffice, quadletRoad, rndLab, serviceGate, serviceRoute, warehouseHall, type DistrictId, type Pad } from './layout';
import { palette } from './palette';

const DISTRICT_NAMES: Record<DistrictId, string> = {
  seaport: 'Seaport · registries',
  warehouse: 'Image Warehouse',
  rnd: 'R&D Department · podman build',
  quadlet: 'Quadlet Department · unit files',
  factories: 'Factory District · containers',
  lockers: 'Locker Yard · volumes',
  businessCenter: 'systemd Business Center · host',
  shoppingCenter: 'Demo Shopping Center',
  freight: 'Freight Station → OpenShift',
  hostLand: 'Host filesystem · host paths',
};

const mat = (color: number) => new THREE.MeshStandardMaterial({ color, flatShading: true });

/** Ambient motion of the static city, driven by the sim clock (skipped for reduced motion). */
export interface City {
  update(now: number): void;
}

/** Static city: ground, wall, water, district pads, roads and fixed buildings. */
export function buildCity(scene: THREE.Scene): City {
  const ground = new THREE.Mesh(new THREE.CircleGeometry(CITY_RADIUS + 50, 64), mat(palette.ground));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(80, 400), mat(palette.water));
  water.rotation.x = -Math.PI / 2;
  water.position.set(-150, 0.05, 0);
  scene.add(water);

  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(CITY_RADIUS, CITY_RADIUS, 3, 96, 1, true),
    new THREE.MeshStandardMaterial({ color: palette.wall, side: THREE.DoubleSide, flatShading: true }),
  );
  wall.position.y = 1.5;
  wall.castShadow = true;
  scene.add(wall);

  for (const [id, pad] of Object.entries(districts) as [DistrictId, Pad][]) {
    const color = id === 'hostLand' || id === 'businessCenter' ? palette.road : 0xa9b89d; // host land is asphalt
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(pad.w, 0.3, pad.d), mat(color));
    mesh.position.set(pad.x, 0.15, pad.z);
    mesh.receiveShadow = true;
    tag(mesh, { key: `district:${id}`, kind: 'district', name: DISTRICT_NAMES[id] });
    scene.add(mesh);
    const label = makeLabel(DISTRICT_NAMES[id], 'label district');
    label.position.set(pad.x, 0.5, pad.z - pad.d / 2 - 2);
    scene.add(label);
  }

  addLaneMarkings(scene, districts.hostLand);
  addRoad(scene, serviceRoute);
  addRoad(scene, quadletRoad);
  // The service road enters the city through a gate in the south wall: systemd lives on the host.
  const gatePos = serviceGate();
  const gate = makeGate(4, false);
  gate.position.set(gatePos.x, 0, gatePos.z);
  scene.add(gate);

  buildWarehouseHall(scene);
  buildFactoryHall(scene);
  buildLockerFence(scene);
  buildRndLab(scene);
  buildQuadletOffice(scene);
  buildBusinessCenter(scene);
  buildShoppingCenter(scene);
  buildSeaportSilhouette(scene);
  const ship = buildContainerShip(scene);
  // Image delivery: tower cranes relay containers; a gantry in the warehouse opens them.
  for (const spec of [...pullCranes, ...buildCranes]) buildTowerCrane(scene, spec);
  buildUnpackGantry(scene);
  buildDeployTruck(scene);

  return {
    update(now) {
      // Idling at anchor: slow bob, roll and a little yaw on the swell.
      ship.group.position.y = ship.restY + Math.sin(now * 0.8) * 0.25;
      ship.group.rotation.x = Math.sin(now * 0.6) * 0.025;
      ship.group.rotation.y = Math.sin(now * 0.15) * 0.04;
    },
  };
}

/** Hook length (below the jib or gantry beam) when idle. */
export const HOIST_REST = 2;

/**
 * Hoist: a cable and hook block hanging from `anchor`. The director lengthens
 * the cable to lower the hook and attaches loads to the hook.
 */
function addHoist(anchor: THREE.Object3D, x: number): void {
  const hoist = new THREE.Group();
  hoist.name = 'hoist';
  hoist.position.x = x;
  const cable = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1, 0.08), mat(palette.bars));
  cable.name = 'cable';
  cable.scale.y = HOIST_REST;
  cable.position.y = -HOIST_REST / 2;
  const hook = new THREE.Group();
  hook.name = 'hook';
  hook.position.y = -HOIST_REST;
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat(palette.network));
  block.name = 'block';
  hook.add(block);
  hoist.add(cable, hook);
  anchor.add(hoist);
}

/** Tower crane: mast, and a slewing jib with counterweight, trolley and hoist at the jib's working radius. */
function buildTowerCrane(scene: THREE.Scene, spec: CraneSpec): void {
  const crane = new THREE.Group();
  crane.name = spec.name;
  crane.position.set(spec.x, 0.3, spec.z);
  const k = CRANE_HEIGHT / 12; // structural parts scale with the crane's height
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.9 * k, CRANE_HEIGHT, 0.9 * k), mat(palette.tower));
  mast.position.y = CRANE_HEIGHT / 2;
  const slew = new THREE.Group();
  slew.name = 'slew';
  slew.position.y = CRANE_HEIGHT;
  slew.rotation.y = craneYaw(spec, spec.from);
  const reach = spec.radius + 1.5;
  const jib = new THREE.Mesh(new THREE.BoxGeometry(reach, 0.6 * k, 0.6 * k), mat(palette.image));
  jib.position.x = reach / 2;
  const counterLen = reach * 0.3;
  const counterJib = new THREE.Mesh(new THREE.BoxGeometry(counterLen, 0.6 * k, 0.6 * k), mat(palette.image));
  counterJib.position.x = -counterLen / 2;
  const weight = new THREE.Mesh(new THREE.BoxGeometry(1.4 * k, 1.2 * k, 1.2 * k), mat(palette.stopped));
  weight.position.set(-counterLen + 0.7 * k, -0.6 * k, 0);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.4 * k, 1.2 * k, 1.2 * k), mat(palette.building));
  cab.position.set(0.9 * k, -0.6 * k, 0.9 * k);
  // Top of the tower above the slewing ring, with pendant ties out along the jib.
  const peak = new THREE.Mesh(new THREE.BoxGeometry(0.6 * k, 3 * k, 0.6 * k), mat(palette.tower));
  peak.position.y = 1.5 * k;
  slew.add(peak);
  for (const [len, sign] of [[reach * 0.7, 1], [counterLen, -1]] as const) {
    const tie = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(len, 3 * k), 0.1, 0.1), mat(palette.bars));
    tie.position.set((sign * len) / 2, 1.5 * k, 0);
    tie.rotation.z = -sign * Math.atan2(3 * k, len);
    slew.add(tie);
  }
  const trolley = new THREE.Mesh(new THREE.BoxGeometry(0.9 * k, 0.4 * k, 0.9 * k), mat(palette.bars));
  trolley.position.set(spec.radius, -0.4 * k, 0);
  slew.add(jib, counterJib, weight, cab, trolley);
  addHoist(slew, spec.radius);
  crane.add(mast, slew);
  crane.traverse((o) => (o.castShadow = true));
  tag(crane, { key: spec.name, kind: 'district', name: 'Crane · image delivery' });
  scene.add(crane);
}

/** Deploy truck flatbed: where a carried container sits, in the truck's local frame (cab at +x). */
export const TRUCK_BED = { x: -1.2, top: 1.1 };

/** Small container truck: cab, flatbed sized for a 20ft container, six wheels. Parked at its bay facing east. */
function buildDeployTruck(scene: THREE.Scene): void {
  const truck = new THREE.Group();
  truck.name = 'truck:deploy';
  truck.position.set(truckBay.x, 0.3, truckBay.z);
  const bedLen = ISO_20FT.l + 0.4;
  const bed = new THREE.Mesh(new THREE.BoxGeometry(bedLen, 0.3, ISO_20FT.w + 0.2), mat(palette.bars));
  bed.position.set(TRUCK_BED.x, TRUCK_BED.top - 0.15, 0);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.9, ISO_20FT.w + 0.2), mat(palette.network));
  cab.position.set(TRUCK_BED.x + bedLen / 2 + 1, 0.55 + 0.95, 0);
  const windscreen = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, ISO_20FT.w - 0.3), mat(palette.water));
  windscreen.position.set(TRUCK_BED.x + bedLen / 2 + 1.91, 1.9, 0);
  truck.add(bed, cab, windscreen);
  const wheel = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 10);
  for (const x of [TRUCK_BED.x - bedLen / 2 + 0.9, TRUCK_BED.x - bedLen / 2 + 2, TRUCK_BED.x + bedLen / 2 + 1])
    for (const z of [-1, 1]) {
      const w = new THREE.Mesh(wheel, mat(palette.road));
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.5, z * (ISO_20FT.w / 2 + 0.05));
      truck.add(w);
    }
  truck.traverse((o) => (o.castShadow = true));
  tag(truck, { key: 'truck:deploy', kind: 'district', name: 'Deploy truck · image -> factory' });
  scene.add(truck);
}

/** Small gantry over the unpacking spot: lifts container lids so the layer crates can come out. */
function buildUnpackGantry(scene: THREE.Scene): void {
  const gantry = new THREE.Group();
  gantry.name = 'crane:unpack';
  gantry.position.set(unpackSpot.x, 0.3, unpackSpot.z);
  const h = UNPACK_GANTRY_HEIGHT;
  const halfX = ISO_20FT.l / 2 + 1.2; // clears a container at any angle
  for (const x of [-halfX, halfX])
    for (const z of [-1.4, 1.4]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.35, h, 0.35), mat(palette.image));
      leg.position.set(x, h / 2, z);
      gantry.add(leg);
    }
  for (const z of [-1.4, 1.4]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(halfX * 2 + 0.35, 0.4, 0.35), mat(palette.image));
    beam.position.set(0, h, z);
    gantry.add(beam);
  }
  const bridge = new THREE.Group(); // the hoist hangs from the middle of the bridge
  bridge.position.y = h;
  const carriage = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 3.2), mat(palette.bars));
  bridge.add(carriage);
  addHoist(bridge, 0);
  gantry.add(bridge);
  gantry.traverse((o) => (o.castShadow = true));
  tag(gantry, { key: 'crane:unpack', kind: 'district', name: 'Unpacking crane · image -> layers' });
  scene.add(gantry);
}

/** Near-invisible terminal shed and ship-to-shore gantry cranes reaching over the water. */
function buildSeaportSilhouette(scene: THREE.Scene): void {
  const port = seaportLayout();
  const t = port.terminal;
  const halfD = t.d / 2;
  const shed = ghostBuilding([[-halfD, 0], [halfD, 0], [halfD, 6], [0, 8.5], [-halfD, 6]], t.w);
  shed.rotation.y = Math.PI / 2;
  shed.position.set(t.x, 0.3, t.z);
  scene.add(shed);

  for (const c of port.cranes) {
    const crane = new THREE.Group();
    crane.position.set(c.x, 0.3, c.z);
    const part = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const p = ghostShell(new THREE.BoxGeometry(w, h, d));
      p.position.set(x, y, z);
      crane.add(p);
    };
    // Four legs straddling the quay, a portal beam, the boom out over the water and a back-reach.
    for (const lx of [-3, 3]) for (const lz of [-2.5, 2.5]) part(0.8, 16, 0.8, lx, 8, lz);
    part(7, 1.2, 6, 0, 16.6, 0);
    part(26, 1, 1.6, -14, 18, 0); // boom, seaward (west)
    part(8, 1, 1.6, 7, 18, 0); // back-reach
    part(3, 2.4, 3, 1.5, 19.7, 0); // machinery house
    part(0.6, 6, 0.6, 0, 21, 0); // A-frame
    scene.add(crane);
  }
}

/** A low-poly container ship idling offshore: hull with a pointed bow, stern bridge, stacked containers. */
function buildContainerShip(scene: THREE.Scene): { group: THREE.Group; restY: number } {
  const { ship } = seaportLayout();
  const L = ship.length;
  const B = ship.beam;
  const hullH = 3.5;
  const group = new THREE.Group();

  // Hull: top-view outline with a pointed bow at -z, extruded downwards.
  const outline = new THREE.Shape([
    new THREE.Vector2(-B / 2, L / 2),
    new THREE.Vector2(B / 2, L / 2),
    new THREE.Vector2(B / 2, -L / 2 + 7),
    new THREE.Vector2(0, -L / 2),
    new THREE.Vector2(-B / 2, -L / 2 + 7),
  ]);
  const hullGeo = new THREE.ExtrudeGeometry(outline, { depth: hullH, bevelEnabled: false });
  hullGeo.rotateX(Math.PI / 2); // outline y -> world z (bow north), extrusion -> downwards from the deck
  const hull = new THREE.Mesh(hullGeo, mat(palette.shipHull));
  hull.position.y = 1.5; // deck height above the water line
  const boot = new THREE.Mesh(new THREE.BoxGeometry(B + 0.05, 0.6, L - 7.5), mat(palette.error)); // red waterline band
  boot.position.set(0, 0.2, 3.7);
  group.add(hull, boot);

  // Bridge at the stern.
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(B - 1, 6, 4), mat(palette.building));
  bridge.position.set(0, 1.5 + 3, L / 2 - 3);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(B + 1, 0.4, 2), mat(palette.building));
  wing.position.set(0, 1.5 + 5.5, L / 2 - 4.5);
  const funnel = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.5, 1.6), mat(palette.shipHull));
  funnel.position.set(0, 1.5 + 7.2, L / 2 - 2);
  group.add(bridge, wing, funnel);

  // Container stacks between bow and bridge.
  const colors = [palette.image, palette.error, palette.network, palette.running, palette.storage, palette.pod, palette.stopped];
  const box = { w: ISO_20FT.w / 2, h: ISO_20FT.h / 2, l: ISO_20FT.l / 2 }; // 20ft boxes, same proportions as the factories
  const rows = Math.floor((B - 1.5) / box.w); // across the beam
  const bays = Math.floor((L - 16) / (box.l + 0.2));
  const containers = new THREE.InstancedMesh(new THREE.BoxGeometry(box.w - 0.06, box.h - 0.04, box.l), new THREE.MeshStandardMaterial({ flatShading: true }), rows * bays * 3);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  let n = 0;
  for (let bay = 0; bay < bays; bay++) {
    for (let row = 0; row < rows; row++) {
      const tiers = 1 + ((bay * 7 + row * 3) % 3); // uneven stacks read as cargo
      for (let tier = 0; tier < tiers; tier++) {
        m.makeTranslation((row - (rows - 1) / 2) * box.w, 1.5 + box.h / 2 + tier * box.h, -L / 2 + 8 + bay * (box.l + 0.2));
        containers.setMatrixAt(n, m);
        containers.setColorAt(n, c.setHex(colors[(bay * 5 + row * 2 + tier * 3) % colors.length]!));
        n++;
      }
    }
  }
  containers.count = n;
  group.add(containers);

  group.traverse((o) => (o.castShadow = true));
  const restY = 0.05;
  group.position.set(ship.x, restY, ship.z);
  tag(group, { key: 'ship:registry', kind: 'district', name: 'Container ship · registry cargo' });
  scene.add(group);
  return { group, restY };
}

/** White solid edge lines and dashed lane dividers along an east-west highway. */
function addLaneMarkings(scene: THREE.Scene, pad: Pad): void {
  const m = new THREE.MeshBasicMaterial({ color: palette.marking });
  const y = 0.31;
  const lineW = 0.25;
  for (const side of [-1, 1]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(pad.w, 0.02, lineW), m);
    edge.position.set(pad.x, y, pad.z + side * (pad.d / 2 - 0.6));
    scene.add(edge);
  }
  const dash = 3;
  const gap = 3;
  const count = Math.floor(pad.w / (dash + gap));
  const dividers = HIGHWAY_LANES - 1;
  const dashes = new THREE.InstancedMesh(new THREE.BoxGeometry(dash, 0.02, lineW), m, count * dividers);
  const t = new THREE.Matrix4();
  const laneW = (pad.d - 1.2) / HIGHWAY_LANES;
  for (let d = 0; d < dividers; d++) {
    const z = pad.z - pad.d / 2 + 0.6 + laneW * (d + 1);
    for (let i = 0; i < count; i++) dashes.setMatrixAt(d * count + i, t.makeTranslation(pad.x - pad.w / 2 + dash / 2 + i * (dash + gap), y, z));
  }
  scene.add(dashes);
}

export function addRoad(parent: THREE.Object3D, points: [number, number][], color: number = palette.road, width = 4): THREE.Group {
  const group = new THREE.Group();
  const m = mat(color);
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, width), m);
    seg.position.set((ax + bx) / 2, 0.36, (az + bz) / 2);
    seg.rotation.y = -Math.atan2(bz - az, bx - ax);
    seg.receiveShadow = true;
    group.add(seg);
  }
  parent.add(group);
  return group;
}

/** Gabled hall over the Image Warehouse: the shelves read as indoor storage. */
function buildWarehouseHall(scene: THREE.Scene): void {
  const hall = warehouseHall();
  const h = 7;
  const halfD = hall.d / 2;
  const shell = ghostBuilding([[-halfD, 0], [halfD, 0], [halfD, h], [0, h + 3.5], [-halfD, h]], hall.w);
  shell.rotation.y = Math.PI / 2; // ridge runs east-west
  shell.position.set(hall.x, 0.3, hall.z);
  scene.add(shell);
}

/** Sawtooth-roofed hall with a chimney over the Factory District. */
function buildFactoryHall(scene: THREE.Scene): void {
  const pad = districts.factories;
  const h = 11; // clears the factories' smokestacks and labels
  const teeth = 5; // one per plot column
  const tooth = pad.w / teeth;
  const profile: [number, number][] = [[-pad.w / 2, 0], [pad.w / 2, 0], [pad.w / 2, h]];
  for (let i = teeth - 1; i >= 0; i--) {
    const left = -pad.w / 2 + i * tooth;
    profile.push([left, h + 3], [left, h]); // glazed riser, then the slope down to the next tooth
  }
  const shell = ghostBuilding(profile, pad.d);
  shell.position.set(pad.x, 0.3, pad.z);
  scene.add(shell);

  const chimney = ghostShell(new THREE.CylinderGeometry(1.4, 1.8, 22, 8));
  chimney.position.set(pad.x + pad.w / 2 + 2.5, 11.3, pad.z - pad.d / 2 + 6); // outside the east wall, clear of belts and plots
  scene.add(chimney);
}

/** Extrude a building profile (x/y) along z, centred on the origin. */
function ghostBuilding(profile: [number, number][], length: number): THREE.Group {
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x, y))), {
    depth: length,
    bevelEnabled: false,
  });
  geometry.translate(0, 0, -length / 2);
  return ghostShell(geometry);
}

/**
 * Near-invisible (95% transparent) shell with a faint outline. It encloses a
 * district without hiding it and never blocks picking of what is inside.
 */
function ghostShell(geometry: THREE.BufferGeometry): THREE.Group {
  const shell = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: palette.building, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }),
  );
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: palette.building, transparent: true, opacity: 0.25 }),
  );
  const group = new THREE.Group();
  group.add(shell, outline);
  group.traverse((o) => {
    o.renderOrder = 1; // draw after the opaque contents it encloses
    o.raycast = () => {};
  });
  return group;
}

/** R&D lab: a low research building with a rooftop antenna, where images are built. */
function buildRndLab(scene: THREE.Scene): void {
  const { building } = rndLab();
  const lab = new THREE.Group();
  lab.position.set(building.x, 0.3, building.z);
  const body = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 8), mat(palette.building));
  body.position.y = 2.5;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(10.4, 0.6, 8.4), mat(palette.image));
  roof.position.y = 5.3;
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4, 6), mat(palette.bars));
  antenna.position.set(3, 7.6, -2);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), mat(palette.card));
  dish.position.set(3, 9.6, -2);
  dish.rotation.x = Math.PI; // bowl facing up
  lab.add(body, roof, antenna, dish);
  lab.traverse((o) => (o.castShadow = true));
  tag(lab, { key: 'district:rnd', kind: 'district', name: 'R&D Department · podman build' });
  scene.add(lab);
}

/** Quadlet office: a small clerk's building under systemd's slate roof color. */
function buildQuadletOffice(scene: THREE.Scene): void {
  const { building } = quadletOffice();
  const office = new THREE.Group();
  office.position.set(building.x, 0.3, building.z);
  const body = new THREE.Mesh(new THREE.BoxGeometry(8, 4.5, 7), mat(palette.building));
  body.position.y = 2.25;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(6, 2.5, 4), mat(palette.tower));
  roof.position.y = 5.75;
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(1, 1, 0.9);
  const mailbox = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.8), mat(palette.running));
  mailbox.position.set(5, 0.6, 3.5);
  office.add(body, roof, mailbox);
  office.traverse((o) => (o.castShadow = true));
  tag(office, { key: 'district:quadlet', kind: 'district', name: 'Quadlet Department · unit files' });
  scene.add(office);
}

/** Secured access: vertical bars all round the locker yard, with a gated entrance facing the factories. */
function buildLockerFence(scene: THREE.Scene): void {
  const p = districts.lockers;
  const margin = 1.5;
  const x0 = p.x - p.w / 2 - margin;
  const x1 = p.x + p.w / 2 + margin;
  const z0 = p.z - p.d / 2 - margin;
  const z1 = p.z + p.d / 2 + margin;
  const gateHalf = 2.5;
  const spacing = 1.8;
  const height = 3.4;

  const bars: [number, number][] = [];
  for (let x = x0; x <= x1 + 1e-6; x += spacing) {
    if (Math.abs(x - p.x) > gateHalf) bars.push([x, z0]); // north side, gate gap
    bars.push([x, z1]);
  }
  for (let z = z0 + spacing; z < z1 - 1e-6; z += spacing) bars.push([x0, z], [x1, z]);

  const fence = new THREE.Group();
  const barMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.08, 0.08, height, 6),
    new THREE.MeshStandardMaterial({ color: palette.bars, metalness: 0.6, roughness: 0.4 }),
    bars.length,
  );
  const m = new THREE.Matrix4();
  bars.forEach(([x, z], i) => barMesh.setMatrixAt(i, m.makeTranslation(x, height / 2 + 0.3, z)));
  barMesh.castShadow = true;
  fence.add(barMesh);

  const railMat = mat(palette.bars);
  const rail = (len: number, alongX: boolean, x: number, z: number, y: number) => {
    const r = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : 0.15, 0.15, alongX ? 0.15 : len), railMat);
    r.position.set(x, y, z);
    fence.add(r);
  };
  for (const y of [1.2, height + 0.2]) {
    const westLen = p.x - gateHalf - x0;
    rail(westLen, true, x0 + westLen / 2, z0, y);
    rail(westLen, true, x1 - westLen / 2, z0, y);
    rail(x1 - x0, true, p.x, z1, y);
    rail(z1 - z0, false, x0, p.z, y);
    rail(z1 - z0, false, x1, p.z, y);
  }
  const gate = makeGate(gateHalf * 2 - 1.4, false, palette.bars);
  gate.position.set(p.x, 0.3, z0);
  fence.add(gate);

  tag(fence, { key: 'district:lockers', kind: 'district', name: 'Locker Yard · secured access' });
  scene.add(fence);
}

/** systemd / Quadlet: an office tower on the host that starts and supervises factories. */
function buildBusinessCenter(scene: THREE.Scene): void {
  const p = districts.businessCenter;
  const group = new THREE.Group();
  group.position.set(p.x, 0.3, p.z);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(8, 18, 8), mat(palette.tower));
  tower.position.y = 9;
  const top = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 5), mat(palette.running));
  top.position.y = 19.5;
  for (const m of [tower, top]) {
    m.castShadow = true;
    group.add(m);
  }
  tag(group, { key: 'svc:systemd', kind: 'systemd', name: 'systemd Business Center' });
  scene.add(group);
}

/** Demo entry point beside the Quadlet department: where visitors see the running app. Faces south, onto its road. */
function buildShoppingCenter(scene: THREE.Scene): void {
  const p = districts.shoppingCenter;
  const group = new THREE.Group();
  group.position.set(p.x, 0.3, p.z);
  const hall = new THREE.Mesh(new THREE.BoxGeometry(12, 4, 8), mat(palette.building));
  hall.position.y = 2;
  const awning = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.4, 2), mat(palette.network));
  awning.position.set(0, 3.2, 4.6);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(6, 1.6, 0.3), mat(palette.pod));
  sign.position.set(0, 5, 3);
  for (const m of [hall, awning, sign]) {
    m.castShadow = true;
    group.add(m);
  }
  tag(group, { key: 'svc:demo', kind: 'demo', name: 'Demo Shopping Center' });
  scene.add(group);
}
