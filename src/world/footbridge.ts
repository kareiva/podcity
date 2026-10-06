import * as THREE from 'three';
import { makeGate } from './gate';
import { FACTORY, FOOTBRIDGE, wallZ, type PortBridge } from './layout';
import { palette } from './palette';

const DECK_COLOR = 0x9ca3af; // gray concrete deck; only the handrails are amber
const GIRDER_COLOR = 0x6b7280;
const RAIL_H = 1.1;
const POST_GAP = 2;
const KIOSK_DOOR = 0.9; // kiosk door, south of the kiosk's centre

/** Box helper: adds a flat-shaded box to the group at (x, y, z). */
function boxes(g: THREE.Group) {
  return (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
}

/** A flat deck section between z0 and z1 (local z), with girders along both edges and handrails. */
function deckSection(g: THREE.Group, z0: number, z1: number, deckMat: THREE.Material, girderMat: THREE.Material, railMat: THREE.Material): void {
  const box = boxes(g);
  const { deck, width } = FOOTBRIDGE;
  const half = width / 2;
  const length = z1 - z0;
  const mid = (z0 + z1) / 2;
  box(width, 0.2, length, deckMat, 0, deck, mid);
  for (const side of [-1, 1]) {
    box(0.25, 0.6, length, girderMat, side * (half - 0.12), deck - 0.4, mid);
    const x = side * (half - 0.05);
    box(0.08, 0.08, length, railMat, x, deck + RAIL_H, mid).castShadow = false;
    for (let z = z0; z <= z1 + 0.01; z += Math.min(POST_GAP, length)) box(0.08, RAIL_H, 0.08, railMat, x, deck + RAIL_H / 2, z);
  }
}

/**
 * The city's pedestrian visitor bridge, always standing: its deck starts at its northernmost pier (`stub`), outside
 * the Factory District hall, and runs due south on piers, through a tall gate in the wall, and down a stair to the host
 * highway. Built with its origin at (x, 0, 0), so local z is world z. Until a port is published it is not
 * connected to any factory; see `makeBridgeLink`.
 */
export function makeFootbridge(b: PortBridge, railColor: number = palette.network): THREE.Group {
  const g = new THREE.Group();
  g.position.x = b.x;
  const box = boxes(g);
  const deckMat = new THREE.MeshStandardMaterial({ color: DECK_COLOR, flatShading: true });
  const railMat = new THREE.MeshStandardMaterial({ color: railColor, flatShading: true });
  const girderMat = new THREE.MeshStandardMaterial({ color: GIRDER_COLOR, flatShading: true });
  const pierMat = new THREE.MeshStandardMaterial({ color: palette.wall, flatShading: true });
  const { deck, width } = FOOTBRIDGE;
  const half = width / 2;

  deckSection(g, b.stub, b.landing, deckMat, girderMat, railMat);

  // Stair down to the road: an inclined flight with treads and handrails.
  const run = b.to - b.landing;
  const slope = Math.atan2(deck, run);
  const flightLen = Math.hypot(deck, run);
  box(width, 0.2, flightLen, deckMat, 0, deck / 2, b.landing + run / 2).rotation.x = slope;
  const steps = Math.round(deck / 0.35);
  for (let s = 0; s < steps; s++) {
    const k = (s + 0.5) / steps;
    box(width, 0.08, 0.3, girderMat, 0, deck * (1 - k) + 0.12, b.landing + run * k);
  }
  for (const side of [-1, 1]) {
    const x = side * (half - 0.05);
    box(0.08, 0.08, flightLen, railMat, x, deck / 2 + RAIL_H, b.landing + run / 2).rotation.x = slope;
    for (let k = 0; k <= 1.001; k += POST_GAP / run) box(0.08, RAIL_H, 0.08, railMat, x, deck * (1 - k) + RAIL_H / 2, b.landing + run * k);
  }

  // Piers south of the Factory District, each a column under a crossbeam.
  for (const z of b.piers) {
    box(0.6, deck - 0.7, 0.6, pierMat, 0, (deck - 0.7) / 2, z);
    box(width + 0.4, 0.3, 0.6, pierMat, 0, deck - 0.6, z);
  }

  const gate = makeGate(width + 0.6, false, GIRDER_COLOR, FOOTBRIDGE.gate);
  gate.position.z = wallZ(b.x);
  g.add(gate);
  return g;
}

/**
 * What a published port adds to the standing bridge: a stair kiosk on the front of the factory roof and the short
 * deck from its door to the bridge's `stub`. Origin at the kiosk on the ground, (x, 0, from), so it folds into the
 * factory. The kiosk is pivoted on the roof (grow it with scale.y) and the link deck at the stub (extend it north
 * with scale.z).
 */
export function makeBridgeLink(b: PortBridge, railColor: number = palette.network): { group: THREE.Group; kiosk: THREE.Group; deck: THREE.Group } {
  const g = new THREE.Group();
  g.position.set(b.x, 0, b.from);
  const deckMat = new THREE.MeshStandardMaterial({ color: DECK_COLOR, flatShading: true });
  const railMat = new THREE.MeshStandardMaterial({ color: railColor, flatShading: true });
  const girderMat = new THREE.MeshStandardMaterial({ color: GIRDER_COLOR, flatShading: true });

  const kiosk = new THREE.Group();
  kiosk.position.set(0, FACTORY.h, 0);
  const height = FOOTBRIDGE.deck + 2.4 - FACTORY.h;
  const box = boxes(kiosk);
  box(1.8, height, 1.8, deckMat, 0, height / 2, 0);
  box(2.2, 0.25, 2.2, girderMat, 0, height + 0.12, 0);
  box(1, 2, 0.05, new THREE.MeshStandardMaterial({ color: 0x334155 }), 0, FOOTBRIDGE.deck - FACTORY.h + 1.05, 0.93);

  const deck = new THREE.Group();
  deck.position.z = b.stub - b.from;
  deckSection(deck, KIOSK_DOOR - (b.stub - b.from), 0, deckMat, girderMat, railMat);

  g.add(kiosk, deck);
  return { group: g, kiosk, deck };
}

/** The path visitors walk, in the link's local coordinates (origin at the kiosk): kiosk door, top of the stair, foot of the stair. */
export function bridgeWalkway(b: PortBridge): THREE.Vector3[] {
  const y = FOOTBRIDGE.deck + 0.1;
  return [new THREE.Vector3(0, y, KIOSK_DOOR), new THREE.Vector3(0, y, b.landing - b.from), new THREE.Vector3(0, 0.1, b.to - b.from)];
}
