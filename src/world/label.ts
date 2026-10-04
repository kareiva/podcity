import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export function makeLabel(text: string, className = 'label'): CSS2DObject {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return new CSS2DObject(el);
}
