import type { Object3D } from 'three';

export type EntityKind =
  | 'container'
  | 'image'
  | 'layer'
  | 'image pull'
  | 'volume'
  | 'host path'
  | 'scratch'
  | 'port'
  | 'env var'
  | 'secret'
  | 'systemd'
  | 'demo'
  | 'district';

/** Identity of a clickable object. `key` is stable across the scene, e.g. `ctr:c-web`. */
export interface EntityInfo {
  key: string;
  kind: EntityKind;
  name: string;
}

export function tag(obj: Object3D, info: EntityInfo): void {
  obj.userData.entity = info;
}

/** Entity of an object or its nearest tagged ancestor. */
export function entityOf(obj: Object3D | null): EntityInfo | undefined {
  for (let o = obj; o; o = o.parent) {
    const info = o.userData.entity as EntityInfo | undefined;
    if (info) return info;
  }
  return undefined;
}

export const keys = {
  container: (id: string) => `ctr:${id}`,
  image: (ref: string) => `img:${ref}`,
  layer: (digest: string) => `layer:${digest}`,
  volume: (name: string) => `vol:${name}`,
  hostPath: (path: string) => `host:${path}`,
  env: (container: string, name: string) => `env:${container}:${name}`,
};
