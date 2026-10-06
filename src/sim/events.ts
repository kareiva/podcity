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
  secretName?: string; // `--secret <name>,type=env,target=<env name>`: the value comes from a podman secret
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
  // Multi-stage: `FROM base AS stage` starts an intermediate stage; its layers carry `stage`.
  // `COPY --from=stage` commits a final-stage layer taken from that stage (`from`).
  | { type: 'image.build.stage'; image: string; stage: string; base: string }
  | { type: 'image.build.layer'; image: string; instruction: string; layer: Digest; stage?: string; from?: string }
  // The intermediate stage is thrown away once the final stage has taken what it needs.
  | { type: 'image.build.discard'; image: string; stage: string; layers: Digest[] }
  | { type: 'image.build.done'; image: string; layers: Digest[] }
  | { type: 'image.build.cached'; image: string; containerfile: string[]; layers: Digest[] } // every step from cache: image unchanged
  // autoRemove: `podman run --rm`, a one-off container removed as soon as it exits. command overrides the image's CMD.
  // restart: `--restart=always`, podman starts it again whenever it exits.
  // runFor (simulation only): seconds the workload runs before exiting by itself; drives the restart loop.
  | {
      type: 'container.create';
      id: string;
      name: string;
      image: string;
      mounts: Mount[];
      env: EnvVar[];
      pod?: string;
      autoRemove?: boolean;
      command?: string;
      restart?: 'always';
      runFor?: number;
      compose?: string; // compose project that (re)created it
      dependsOn?: string[]; // compose depends_on: names of services that must be up before this one is deployed
      // Create-time flags `--network` and `-p`; the connection itself is announced by network.connect when it starts.
      network?: string;
      ports?: Port[];
    }
  // restart: started again by its restart policy rather than by `podman start`
  | { type: 'container.start'; id: string; restart?: boolean }
  | { type: 'container.stop'; id: string }
  | { type: 'container.exit'; id: string; code: number; reason?: string }
  | { type: 'container.remove'; id: string; compose?: string } // compose: removed by `compose up` to recreate it
  | { type: 'secret.create'; name: string } // `podman secret create`; contents never leave the facility
  | { type: 'volume.create'; name: string }
  | { type: 'volume.remove'; name: string }
  | { type: 'network.create'; name: string; driver: 'bridge'; subnet: string }
  | { type: 'network.connect'; container: string; network: string; ports: Port[] }
  // Traffic between containers on a network; `to` is reached by name through aardvark-dns
  | { type: 'network.request'; from: string; to: string; network: string; label: string }
  // Quadlet: a unit file under ~/.config/containers/systemd; on daemon-reload systemd's generator turns it into a .service
  | { type: 'quadlet.create'; file: string; path: string; image: string; lines: string[] }
  | { type: 'systemd.daemon-reload'; generated: { quadlet: string; unit: string }[] }
  // podman compose up: the stack described in a compose file; its containers follow as container.* events tagged with the project
  | { type: 'compose.up'; project: string; path: string; lines: string[]; services: string[] }
  | { type: 'pod.create'; id: string; name: string }
  | { type: 'kube.generate'; pod: string }
  | { type: 'resource.sample'; id: string; cpu: number; mem: number; memLimit?: number };

export type SimEventType = SimEvent['type'];
export type EventOf<T extends SimEventType> = Extract<SimEvent, { type: T }>;
