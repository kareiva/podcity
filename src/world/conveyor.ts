import * as THREE from 'three';
import { pathSampler } from './layout';
import { palette } from './palette';

export const CONVEYOR_TOP = 1.2; // belt surface height; cargo rides on it
const WIDTH = 2.6;
const SLAT_SPACING = 1.4;
const SPEED = 1.5; // metres per simulation second

export interface Conveyor {
  group: THREE.Group;
  update(now: number): void;
}

/**
 * A belt following a smooth path: a ribbon surface with side skirts and
 * slats that move along it toward the last point of `path`.
 */
export function addConveyor(parent: THREE.Object3D, path: [number, number][]): Conveyor {
  const sampler = pathSampler(path);
  const group = new THREE.Group();

  const belt = new THREE.Mesh(ribbonGeometry(path, WIDTH, CONVEYOR_TOP), new THREE.MeshStandardMaterial({ color: palette.road, side: THREE.DoubleSide }));
  belt.receiveShadow = true;
  const skirt = new THREE.Mesh(skirtGeometry(path, WIDTH, 0.3, CONVEYOR_TOP), new THREE.MeshStandardMaterial({ color: palette.bars, side: THREE.DoubleSide }));
  skirt.castShadow = true;
  group.add(belt, skirt);

  const slats = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.35, 0.06, WIDTH - 0.2),
    new THREE.MeshStandardMaterial({ color: palette.image, flatShading: true }),
    Math.floor(sampler.length / SLAT_SPACING),
  );
  group.add(slats);
  parent.add(group);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const update = (now: number) => {
    const offset = (now * SPEED) % SLAT_SPACING;
    for (let i = 0; i < slats.count; i++) {
      const p = sampler.at(offset + i * SLAT_SPACING);
      slats.setMatrixAt(i, m.compose(pos.set(p.x, CONVEYOR_TOP + 0.04, p.z), q.setFromAxisAngle(up, p.yaw), one));
    }
    slats.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { group, update };
}

/** Left/right edge offsets of a path, perpendicular to its local direction. */
function edges(path: [number, number][], width: number): { l: [number, number]; r: [number, number] }[] {
  return path.map(([x, z], i) => {
    const [ax, az] = path[Math.max(i - 1, 0)]!;
    const [bx, bz] = path[Math.min(i + 1, path.length - 1)]!;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const nx = -(bz - az) / len;
    const nz = (bx - ax) / len;
    const h = width / 2;
    return { l: [x + nx * h, z + nz * h], r: [x - nx * h, z - nz * h] };
  });
}

function ribbonGeometry(path: [number, number][], width: number, y: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const { l, r } of edges(path, width)) pos.push(l[0], y, l[1], r[0], y, r[1]);
  return strip(pos, path.length);
}

/** Both vertical sides of the belt, from `y0` up to `y1`. */
function skirtGeometry(path: [number, number][], width: number, y0: number, y1: number): THREE.BufferGeometry {
  const sides = edges(path, width);
  const geos = (['l', 'r'] as const).map((side) => {
    const pos: number[] = [];
    for (const e of sides) pos.push(e[side][0], y0, e[side][1], e[side][0], y1, e[side][1]);
    return strip(pos, path.length);
  });
  const merged = new THREE.BufferGeometry();
  const a = geos[0]!.getAttribute('position').array as Float32Array;
  const b = geos[1]!.getAttribute('position').array as Float32Array;
  merged.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b], 3));
  const ia = [...geos[0]!.getIndex()!.array];
  merged.setIndex([...ia, ...ia.map((i) => i + a.length / 3)]);
  merged.computeVertexNormals();
  return merged;
}

/** Triangle strip from vertex pairs (2 per path point) as an indexed geometry. */
function strip(pos: number[], points: number): THREE.BufferGeometry {
  const idx: number[] = [];
  for (let i = 0; i < points - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
