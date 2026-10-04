import type { Digest, EnvVar, Mount, SimEvent } from './events';
import { createRng, shortDigest } from './rng';

export interface ScheduledEvent {
  at: number; // simulation seconds from the start of its step
  event: SimEvent;
}

export type StepId = 'pull' | 'deploy' | 'storage' | 'env' | 'expose';

export interface Step {
  id: StepId;
  title: string;
  summary: string;
  events: ScheduledEvent[];
}

const NGINX = 'docker.io/library/nginx:latest';
const POSTGRES = 'docker.io/library/postgres:17';

/**
 * Default walkthrough as independently replayable steps. Mounts, env and
 * published ports are fixed at create time in Podman, so later steps
 * re-create containers (`podman run --replace` = rm -f + create).
 * Times are slowed down to be watchable, not real Podman timings.
 */
export function defaultSteps(seed = 42): Step[] {
  const rng = createRng(seed);
  const base: Digest = shortDigest(rng); // shared debian base layer
  const nginxLayers: Digest[] = [base, shortDigest(rng), shortDigest(rng)];
  const postgresLayers: Digest[] = [base, shortDigest(rng), shortDigest(rng), shortDigest(rng)];

  const webMounts: Mount[] = [
    { kind: 'bind', source: '/home/user/site', target: '/usr/share/nginx/html', readOnly: true },
    { kind: 'tmpfs', source: 'tmpfs', target: '/var/cache/nginx' },
  ];
  const dbMounts: Mount[] = [{ kind: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }];
  const dbEnv: EnvVar[] = [
    { name: 'POSTGRES_USER', value: 'app' },
    { name: 'POSTGRES_DB', value: 'app' },
    { name: 'POSTGRES_PASSWORD', value: '', secret: true },
  ];

  return [
    step('pull', 'Image pull', 'Layers ship from the registry; the base layer shared by both images is fetched only once.', (at) => {
      at(0, { type: 'image.pull.start', image: NGINX, layers: nginxLayers });
      for (const layer of nginxLayers) at(1.2, { type: 'image.layer.done', image: NGINX, layer, cached: false });
      at(0.5, { type: 'image.pull.done', image: NGINX });
      at(1.5, { type: 'image.pull.start', image: POSTGRES, layers: postgresLayers });
      postgresLayers.forEach((layer, i) =>
        at(i === 0 ? 0.6 : 1.2, { type: 'image.layer.done', image: POSTGRES, layer, cached: layer === base }),
      );
      at(0.5, { type: 'image.pull.done', image: POSTGRES });
    }),

    step('deploy', 'Deploy', 'Containers start from the images. db exits immediately without a password and is left abandoned.', (at) => {
      at(0, { type: 'container.create', id: 'web-1', name: 'web', image: NGINX, mounts: [], env: [] });
      at(2, { type: 'container.start', id: 'web-1' });
      at(1, { type: 'container.create', id: 'db-1', name: 'db', image: POSTGRES, mounts: [], env: [] });
      at(2, { type: 'container.start', id: 'db-1' });
      at(1.5, { type: 'container.exit', id: 'db-1', code: 1, reason: 'POSTGRES_PASSWORD is not specified' });
    }),

    step('storage', 'Storage', 'Three kinds of storage: a named volume, a host path, and tmpfs scratch space. Mounts are set at create time, so containers are re-created.', (at) => {
      at(0, { type: 'volume.create', name: 'pgdata' });
      at(1.5, { type: 'container.remove', id: 'web-1' });
      at(0.5, { type: 'container.create', id: 'web-2', name: 'web', image: NGINX, mounts: webMounts, env: [] });
      at(2.5, { type: 'container.start', id: 'web-2' });
      at(1.5, { type: 'container.remove', id: 'db-1' });
      at(0.5, { type: 'container.create', id: 'db-2', name: 'db', image: POSTGRES, mounts: dbMounts, env: [] });
    }),

    step('env', 'Environment', 'Configuration arrives as customer feedback cards. db is re-created with them and finally runs.', (at) => {
      at(0, { type: 'container.remove', id: 'db-2' });
      at(0.5, { type: 'container.create', id: 'db-3', name: 'db', image: POSTGRES, mounts: dbMounts, env: dbEnv });
      at(3.5, { type: 'container.start', id: 'db-3' });
    }),

    step('expose', 'Expose', 'web is re-created with -p 8080:80; a road leads through a gate in the wall to the host.', (at) => {
      at(0, { type: 'container.remove', id: 'web-2' });
      at(0.5, { type: 'container.create', id: 'web-3', name: 'web', image: NGINX, mounts: webMounts, env: [] });
      at(2.5, { type: 'container.start', id: 'web-3' });
      at(1, { type: 'network.connect', container: 'web-3', network: 'podman', ports: [{ host: 8080, container: 80, protocol: 'tcp' }] });
    }),
  ];
}

function step(id: StepId, title: string, summary: string, build: (at: (dt: number, e: SimEvent) => void) => void): Step {
  const events: ScheduledEvent[] = [];
  let t = 0.5;
  build((dt, event) => {
    t += dt;
    events.push({ at: t, event });
  });
  return { id, title, summary, events };
}
