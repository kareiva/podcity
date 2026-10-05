import * as THREE from 'three';
import type { Tweener } from '../engine/tween';

interface Arc {
  from: string;
  to: string;
  group: THREE.Group;
  material: THREE.MeshBasicMaterial;
  fade: number; // 0..1 from fade-in/out tweens
}

const OPACITY_IDLE = 0.6;
const OPACITY_FOCUS = 1;
const OPACITY_DIM = 0.1;

/** Curve from a to b, raised above the ground in proportion to its length. */
export function arcCurve(a: THREE.Vector3, b: THREE.Vector3): THREE.QuadraticBezierCurve3 {
  const mid = a.clone().lerp(b, 0.5);
  mid.y = Math.max(a.y, b.y) + Math.max(4, a.distanceTo(b) * 0.3);
  return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
}

/**
 * Thin directional arcs between related entities (image -> container,
 * container -> volume). Arcs are not pickable and fade with their endpoints.
 */
export class ArcLayer {
  private arcs = new Map<string, Arc>();
  private selected: string | null = null;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly tw: Tweener,
  ) {}

  async connect(from: string, to: string, a: THREE.Vector3, b: THREE.Vector3, color: number): Promise<void> {
    const id = `${from}->${to}`;
    if (this.arcs.has(id)) return;

    const curve = arcCurve(a, b);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.1, 5, false), material));

    // Arrowhead near the target shows direction.
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 8), material);
    head.position.copy(curve.getPointAt(0.96));
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangentAt(0.96));
    group.add(head);
    group.traverse((o) => (o.raycast = () => {}));
    this.parent.add(group);

    const arc: Arc = { from, to, group, material, fade: 0 };
    this.arcs.set(id, arc);
    await this.tw.tween({ duration: 0.6, update: (k) => this.setFade(arc, k) });
  }

  /** Number of arcs currently drawn (including ones fading in). */
  get size(): number {
    return this.arcs.size;
  }

  /** Fade out and remove every arc that touches `key`. */
  async disconnect(key: string): Promise<void> {
    const gone = [...this.arcs].filter(([, a]) => a.from === key || a.to === key);
    for (const [id] of gone) this.arcs.delete(id);
    await Promise.all(
      gone.map(async ([, arc]) => {
        const start = arc.fade;
        await this.tw.tween({ duration: 0.4, update: (k) => this.setFade(arc, start * (1 - k)) });
        arc.group.removeFromParent();
        arc.group.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
        arc.material.dispose();
      }),
    );
    if (this.selected === key) this.highlight(null);
  }

  /** Emphasise arcs touching `key` and dim the rest; null restores all. */
  highlight(key: string | null): void {
    this.selected = key;
    for (const arc of this.arcs.values()) this.setFade(arc, arc.fade);
  }

  private setFade(arc: Arc, fade: number): void {
    arc.fade = fade;
    const s = this.selected;
    const level = s === null ? OPACITY_IDLE : arc.from === s || arc.to === s ? OPACITY_FOCUS : OPACITY_DIM;
    arc.material.opacity = level * fade;
  }
}
