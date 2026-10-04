import * as THREE from 'three';
import { entityOf, type EntityInfo } from '../world/entity';
import type { Engine } from './renderer';

const CLICK_SLOP_PX = 5;

/**
 * Click-to-select on tagged objects. A drag (camera orbit) is not a click.
 * `onPick` receives null when the click hits nothing selectable.
 */
export function setupPicking(engine: Engine, onPick: (info: EntityInfo | null, x: number, y: number) => void): void {
  const el = engine.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down: { x: number; y: number } | null = null;

  const pick = (e: PointerEvent): EntityInfo | null => {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, engine.camera);
    const hit = raycaster.intersectObjects(engine.scene.children, true)[0];
    return (hit && entityOf(hit.object)) ?? null;
  };

  el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  el.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_SLOP_PX) onPick(pick(e), e.clientX, e.clientY);
    down = null;
  });
  el.addEventListener('pointermove', (e) => {
    if (e.buttons === 0) el.style.cursor = pick(e) ? 'pointer' : '';
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onPick(null, 0, 0);
  });
}
