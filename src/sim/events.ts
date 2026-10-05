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
  // podman build: the base comes from local storage; each layer-creating instruction commits one layer
  | { type: 'image.build.start'; image: string; base: string; containerfile: string[] }
  | { type: 'image.build.layer'; image: string; instruction: string; layer: Digest }
  | { type: 'image.build.done'; image: string; layers: Digest[] }
  // autoRemove: `podman run --rm`, a one-off container removed as soon as it exits. command overrides the image's CMD.
  | { type: 'container.create'; id: string; name: string; image: string; mounts: Mount[]; env: EnvVar[]; pod?: string; autoRemove?: boolean; command?: string }
  | { type: 'container.start'; id: string }
  | { type: 'container.stop'; id: string }
  | { type: 'container.exit'; id: string; code: number; reason?: string }
  | { type: 'container.remove'; id: string }
  | { type: 'volume.create'; name: string }
  | { type: 'volume.remove'; name: string }
  | { type: 'network.create'; name: string; driver: 'bridge'; subnet: string }
  | { type: 'network.connect'; container: string; network: string; ports: Port[] }
  // Traffic between containers on a network; `to` is reached by name through aardvark-dns
  | { type: 'network.request'; from: string; to: string; network: string; label: string }
  // Quadlet: a unit file under ~/.config/containers/systemd; on daemon-reload systemd's generator turns it into a .service
  | { type: 'quadlet.create'; file: string; path: string; image: string; lines: string[] }
  | { type: 'systemd.daemon-reload'; generated: { quadlet: string; unit: string }[] }
  | { type: 'pod.create'; id: string; name: string }
  | { type: 'kube.generate'; pod: string }
  | { type: 'resource.sample'; id: string; cpu: number; mem: number; memLimit?: number };

export type SimEventType = SimEvent['type'];
export type EventOf<T extends SimEventType> = Extract<SimEvent, { type: T }>;
