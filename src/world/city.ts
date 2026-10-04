import * as THREE from 'three';
import { tag } from './entity';
import { makeGate } from './gate';
import { makeLabel } from './label';
import { CITY_RADIUS, districts, pullRoute, serviceRoute, wallXWest, type DistrictId, type Pad } from './layout';
import { palette } from './palette';

const DISTRICT_NAMES: Record<DistrictId, string> = {
  seaport: 'Seaport · registries',
  warehouse: 'Image Warehouse',
  factories: 'Factory District · containers',
  lockers: 'Locker Yard · volumes',
  businessCenter: 'systemd Business Center · host',
  shoppingCenter: 'Demo Shopping Center',
  freight: 'Freight Station → OpenShift',
  hostLand: 'Host filesystem · host paths',
};

const mat = (color: number) => new THREE.MeshStandardMaterial({ color, flatShading: true });

/** Static city: ground, wall, water, district pads, roads and fixed buildings. */
export function buildCity(scene: THREE.Scene): void {
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
    const color = id === 'hostLand' || id === 'businessCenter' ? palette.host : 0xa9b89d;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(pad.w, 0.3, pad.d), mat(color));
    mesh.position.set(pad.x, 0.15, pad.z);
    mesh.receiveShadow = true;
    tag(mesh, { key: `district:${id}`, kind: 'district', name: DISTRICT_NAMES[id] });
    scene.add(mesh);
    const label = makeLabel(DISTRICT_NAMES[id], 'label district');
    label.position.set(pad.x, 0.5, pad.z - pad.d / 2 - 2);
    scene.add(label);
  }

  addRoad(scene, pullRoute);
  addRoad(scene, serviceRoute);
  // The service road enters the city through a gate: systemd lives on the host.
  const [, [, serviceZ]] = serviceRoute as [[number, number], [number, number]];
  const gate = makeGate(4, true);
  gate.position.set(wallXWest(serviceZ), 0, serviceZ);
  scene.add(gate);

  buildLockerFence(scene);
  buildBusinessCenter(scene);
  buildShoppingCenter(scene);
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

/** Secured access: vertical bars all round the locker yard, with a gated entrance facing the factories. */
function buildLockerFence(scene: THREE.Scene): void {
  const p = districts.lockers;
  const margin = 1.5;
  const x0 = p.x - p.w / 2 - margin;
  const x1 = p.x + p.w / 2 + margin;
  const z0 = p.z - p.d / 2 - margin;
  const z1 = p.z + p.d / 2 + margin;
  const gateHalf = 2.5;
  const spacing = 0.9;
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

/** Demo entry point by the wall: where visitors see the running app. */
function buildShoppingCenter(scene: THREE.Scene): void {
  const p = districts.shoppingCenter;
  const group = new THREE.Group();
  group.position.set(p.x, 0.3, p.z);
  const hall = new THREE.Mesh(new THREE.BoxGeometry(12, 4, 8), mat(palette.building));
  hall.position.y = 2;
  const awning = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.4, 2), mat(palette.network));
  awning.position.set(0, 3.2, -4.6);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(6, 1.6, 0.3), mat(palette.pod));
  sign.position.set(0, 5, -3);
  for (const m of [hall, awning, sign]) {
    m.castShadow = true;
    group.add(m);
  }
  tag(group, { key: 'svc:demo', kind: 'demo', name: 'Demo Shopping Center' });
  scene.add(group);
}
