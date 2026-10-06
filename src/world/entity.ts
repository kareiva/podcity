import type { Object3D } from 'three';

export type EntityKind =
  | 'container'
  | 'image'
  | 'layer'
  | 'image pull'
  | 'containerfile'
  | 'quadlet'
  | 'compose'
  | 'volume'
  | 'host path'
  | 'scratch'
  | 'port'
  | 'network'
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
  /** Longer text shown under the name in the tooltip, e.g. a unit file's contents. */
  detail?: string;
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
  build: (ref: string) => `build:${ref}`,
  quadlet: (file: string) => `quadlet:${file}`,
  unit: (name: string) => `unit:${name}`,
  compose: (project: string) => `compose:${project}`,
  volume: (name: string) => `vol:${name}`,
  network: (name: string) => `net:${name}`,
  hostPath: (path: string) => `host:${path}`,
  env: (container: string, name: string) => `env:${container}:${name}`,
};
