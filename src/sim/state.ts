import type { Digest, EnvVar, Mount, Port, SimEvent } from './events';

export type ContainerStatus = 'created' | 'running' | 'stopped' | 'exited';

export interface ImageState {
  ref: string;
  layers: Digest[];
  complete: boolean;
}

export interface ContainerState {
  id: string;
  name: string;
  image: string;
  status: ContainerStatus;
  exitCode?: number;
  mounts: Mount[];
  env: EnvVar[];
  networks: string[];
  ports: Port[];
  pod?: string;
  autoRemove?: boolean;
  command?: string;
}

export interface NetworkState {
  name: string;
  driver: 'bridge';
  subnet: string;
}

export interface QuadletState {
  file: string; // e.g. web.container
  path: string;
  image: string;
  unit?: string; // generated systemd service, after daemon-reload
}

export interface PodState {
  id: string;
  name: string;
  members: string[];
}

export interface PodmanState {
  layers: Set<Digest>;
  images: Map<string, ImageState>;
  containers: Map<string, ContainerState>;
  volumes: Set<string>;
  networks: Map<string, NetworkState>;
  quadlets: Map<string, QuadletState>;
  pods: Map<string, PodState>;
}

export function createState(): PodmanState {
  return {
    layers: new Set(),
    images: new Map(),
    containers: new Map(),
    volumes: new Set(),
    networks: new Map(),
    quadlets: new Map(),
    pods: new Map(),
  };
}

/** Images are shared: an image cannot be removed while a container uses it. */
export function canRemoveImage(state: PodmanState, ref: string): boolean {
  for (const c of state.containers.values()) if (c.image === ref) return false;
  return true;
}

/** Layers already in local storage are not downloaded again. */
export function isLayerCached(state: PodmanState, layer: Digest): boolean {
  return state.layers.has(layer);
}

export function applyEvent(state: PodmanState, e: SimEvent): void {
  switch (e.type) {
    case 'image.pull.start':
      state.images.set(e.image, { ref: e.image, layers: [...e.layers], complete: false });
      break;
    case 'image.layer.done':
    case 'image.build.layer':
      state.layers.add(e.layer);
      break;
    case 'image.build.done':
      state.images.set(e.image, { ref: e.image, layers: [...e.layers], complete: true });
      break;
    case 'image.build.start':
      break;
    case 'image.pull.done': {
      const img = state.images.get(e.image);
      if (img) img.complete = true;
      break;
    }
    case 'container.create':
      state.containers.set(e.id, {
        id: e.id,
        name: e.name,
        image: e.image,
        status: 'created',
        mounts: e.mounts,
        env: e.env,
        networks: [],
        ports: [],
        pod: e.pod,
        autoRemove: e.autoRemove,
        command: e.command,
      });
      if (e.pod) state.pods.get(e.pod)?.members.push(e.id);
      break;
    case 'container.start':
      setStatus(state, e.id, 'running');
      break;
    case 'container.stop':
      setStatus(state, e.id, 'stopped');
      break;
    case 'container.exit': {
      const c = state.containers.get(e.id);
      if (c) {
        c.status = 'exited';
        c.exitCode = e.code;
      }
      break;
    }
    case 'container.remove': {
      // Layers and volumes deliberately outlive the container.
      const c = state.containers.get(e.id);
      if (c?.pod) {
        const pod = state.pods.get(c.pod);
        if (pod) pod.members = pod.members.filter((m) => m !== e.id);
      }
      state.containers.delete(e.id);
      break;
    }
    case 'volume.create':
      state.volumes.add(e.name);
      break;
    case 'volume.remove':
      state.volumes.delete(e.name);
      break;
    case 'network.create':
      state.networks.set(e.name, { name: e.name, driver: e.driver, subnet: e.subnet });
      break;
    case 'network.connect': {
      const c = state.containers.get(e.container);
      if (c) {
        if (!c.networks.includes(e.network)) c.networks.push(e.network);
        c.ports.push(...e.ports);
      }
      break;
    }
    case 'quadlet.create':
      state.quadlets.set(e.file, { file: e.file, path: e.path, image: e.image });
      break;
    case 'systemd.daemon-reload':
      for (const g of e.generated) {
        const q = state.quadlets.get(g.quadlet);
        if (q) q.unit = g.unit;
      }
      break;
    case 'pod.create':
      state.pods.set(e.id, { id: e.id, name: e.name, members: [] });
      break;
    case 'network.request':
    case 'kube.generate':
    case 'resource.sample':
      break;
  }
}

function setStatus(state: PodmanState, id: string, status: ContainerStatus): void {
  const c = state.containers.get(id);
  if (c) c.status = status;
}
