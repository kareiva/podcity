import * as THREE from 'three';
import { palette } from './palette';

/** Two pillars and a beam framing a road that runs along x or z. */
export function makeGate(width: number, roadAlongX: boolean, color: number = palette.wall): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({ color, flatShading: true });
  const g = new THREE.Group();
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 5, 1.4), mat);
    const off = (side * (width + 1.4)) / 2;
    pillar.position.set(roadAlongX ? 0 : off, 2.5, roadAlongX ? off : 0);
    pillar.castShadow = true;
    g.add(pillar);
  }
  const span = width + 2.8;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(roadAlongX ? 1 : span, 0.8, roadAlongX ? span : 1), mat);
  beam.position.y = 5.2;
  g.add(beam);
  return g;
}
