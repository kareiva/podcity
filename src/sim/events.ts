// Typed events emitted by the simulation (or translated from live Podman).
// Rendering code only ever reacts to these.

export type Digest = string;

/** volume: named, managed by podman. bind: host path. tmpfs: scratch space, gone with the container. */
export interface Mount {
  kind: 'volume' | 'bind' | 'tmpfs';
  source: string; // volume name, host path, or 'tmpfs'
  target: string; // path inside the container
  readOnly?: boolean;
}

export interface EnvVar {
  name: string;
  value: string;
  secret?: boolean; // value must never be rendered
}

export interface Port {
  host: number;
  container: number;
  protocol: 'tcp' | 'udp';
}

export type SimEvent =
  | { type: 'image.pull.start'; image: string; layers: Digest[] }
  | { type: 'image.layer.done'; image: string; layer: Digest; cached: boolean }
  | { type: 'image.pull.done'; image: string }
  | { type: 'container.create'; id: string; name: string; image: string; mounts: Mount[]; env: EnvVar[]; pod?: string }
  | { type: 'container.start'; id: string }
  | { type: 'container.stop'; id: string }
  | { type: 'container.exit'; id: string; code: number; reason?: string }
  | { type: 'container.remove'; id: string }
  | { type: 'volume.create'; name: string }
  | { type: 'volume.remove'; name: string }
  | { type: 'network.connect'; container: string; network: string; ports: Port[] }
  | { type: 'pod.create'; id: string; name: string }
  | { type: 'kube.generate'; pod: string }
  | { type: 'resource.sample'; id: string; cpu: number; mem: number; memLimit?: number };

export type SimEventType = SimEvent['type'];
export type EventOf<T extends SimEventType> = Extract<SimEvent, { type: T }>;
