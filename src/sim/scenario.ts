import type { Digest, EnvVar, Mount, Port, SimEvent } from './events';
import { createRng, shortDigest } from './rng';

export interface ScheduledEvent {
  at: number; // simulation seconds from the start of its step
  event: SimEvent;
}

export type StepId = 'pull' | 'network' | 'deploy' | 'env' | 'migrate' | 'expose' | 'storage' | 'build' | 'quadlet' | 'metrics';

export interface Step {
  id: StepId;
  title: string;
  summary: string;
  events: ScheduledEvent[];
}

// Red Hat UBI images: nginx and postgresql are both built FROM ubi9/s2i-core,
// which is FROM ubi9/ubi, so they share the UBI base layer (and s2i-core).
const UBI = 'registry.access.redhat.com/ubi9/ubi:latest';
const NGINX = 'registry.access.redhat.com/ubi9/nginx-124:latest';
const POSTGRES = 'registry.access.redhat.com/ubi9/postgresql-16:latest';
const NET = 'backend';
const CUSTOM = 'localhost/podcity-web:1.0';
const METRICS_EVERY = 10; // seconds the metrics collector runs before exiting and being restarted

/**
 * Default walkthrough as independently replayable steps. Mounts, env and
 * published ports are fixed at create time in Podman, so later steps
 * re-create containers (`podman run --replace` = rm -f + create).
 * Times are slowed down to be watchable, not real Podman timings.
 */
export function defaultSteps(seed = 42): Step[] {
  const rng = createRng(seed);
  const ubiBase: Digest = shortDigest(rng); // ubi9/ubi: the reusable base layer
  const s2iCore: Digest = shortDigest(rng); // ubi9/s2i-core: shared by nginx and postgresql
  const ubiLayers: Digest[] = [ubiBase];
  const nginxLayers: Digest[] = [ubiBase, s2iCore, shortDigest(rng)];
  const postgresLayers: Digest[] = [ubiBase, s2iCore, shortDigest(rng), shortDigest(rng)];

  const webMounts: Mount[] = [
    { kind: 'bind', source: '/home/user/site', target: '/opt/app-root/src', readOnly: true },
    { kind: 'tmpfs', source: 'tmpfs', target: '/var/lib/nginx/tmp' },
  ];
  const webPort: Port = { host: 8080, container: 8080, protocol: 'tcp' };
  const dbMounts: Mount[] = [{ kind: 'volume', source: 'pgdata', target: '/var/lib/pgsql/data' }];
  const dbEnv: EnvVar[] = [
    { name: 'POSTGRESQL_USER', value: 'app' },
    { name: 'POSTGRESQL_DATABASE', value: 'app' },
    { name: 'POSTGRESQL_PASSWORD', value: '', secret: true },
  ];

  const containerfile = [
    `FROM ${NGINX}`,
    'COPY site/ /opt/app-root/src/',
    'COPY podcity.conf /opt/app-root/etc/nginx.d/',
    'CMD nginx -g "daemon off;"',
  ];
  const customLayers: Digest[] = [shortDigest(rng), shortDigest(rng)]; // one per COPY; CMD is metadata only

  const migrateMounts: Mount[] = [{ kind: 'bind', source: '/home/user/migrations', target: '/migrations', readOnly: true }];
  const migrateEnv: EnvVar[] = [
    { name: 'PGHOST', value: 'db' },
    { name: 'PGUSER', value: 'app' },
    { name: 'PGDATABASE', value: 'app' },
    { name: 'PGPASSWORD', value: '', secret: true },
  ];

  const quadlet = [
    '[Unit]',
    'Description=podcity web',
    '',
    '[Container]',
    `Image=${CUSTOM}`,
    `Network=${NET}`,
    'PublishPort=8080:8080',
    '',
    '[Install]',
    'WantedBy=default.target',
  ];

  return [
    step('pull', 'Image pull', 'The UBI base image ships first. nginx and postgresql are both built on UBI, so their pulls reuse its layer instead of fetching it again.', (at) => {
      // Layers already in local storage are only flashed, not downloaded again.
      const stored = new Set<Digest>();
      const pull = (image: string, layers: Digest[], delay: number) => {
        at(delay, { type: 'image.pull.start', image, layers });
        for (const layer of layers) {
          const cached = stored.has(layer);
          stored.add(layer);
          at(cached ? 0.6 : 1.2, { type: 'image.layer.done', image, layer, cached });
        }
        at(0.5, { type: 'image.pull.done', image });
      };
      pull(UBI, ubiLayers, 0);
      pull(NGINX, nginxLayers, 1.5);
      pull(POSTGRES, postgresLayers, 1.5);
    }),

    step('network', 'Network', 'podman network create backend: a bridge network with its own subnet and DNS, laid out as a conveyor belt through the factory district.', (at) => {
      at(0, { type: 'network.create', name: NET, driver: 'bridge', subnet: '10.89.0.0/24' });
    }),

    step('deploy', 'Deploy', 'Containers start from the images with --network backend and are hooked onto the belt as they start. db exits immediately without credentials and is left abandoned.', (at) => {
      at(0, { type: 'container.create', id: 'web-1', name: 'web', image: NGINX, mounts: [], env: [] });
      at(2, { type: 'container.start', id: 'web-1' });
      at(0.3, { type: 'network.connect', container: 'web-1', network: NET, ports: [] });
      at(1, { type: 'container.create', id: 'db-1', name: 'db', image: POSTGRES, mounts: [], env: [] });
      at(2, { type: 'container.start', id: 'db-1' });
      at(0.3, { type: 'network.connect', container: 'db-1', network: NET, ports: [] });
      at(1.5, { type: 'container.exit', id: 'db-1', code: 1, reason: 'POSTGRESQL_USER, POSTGRESQL_PASSWORD and POSTGRESQL_DATABASE must be set' });
    }),

    step('env', 'Environment', 'Configuration arrives as customer feedback cards. db is re-created with them and finally runs.', (at) => {
      at(0, { type: 'container.remove', id: 'db-1' });
      at(0.5, { type: 'container.create', id: 'db-2', name: 'db', image: POSTGRES, mounts: [], env: dbEnv });
      at(3.5, { type: 'container.start', id: 'db-2' });
      at(0.3, { type: 'network.connect', container: 'db-2', network: NET, ports: [] });
    }),

    step('migrate', 'Migrate', 'A one-off db-migrate container from the same postgresql-16 image runs with --rm: it reaches db by name over backend, applies the migration, exits 0 and is removed straight away. The image stays.', (at) => {
      at(0, {
        type: 'container.create',
        id: 'migrate-1',
        name: 'db-migrate',
        image: POSTGRES,
        mounts: migrateMounts,
        env: migrateEnv,
        autoRemove: true,
        command: 'psql -f /migrations/001_init.sql',
      });
      at(3.5, { type: 'container.start', id: 'migrate-1' });
      at(0.3, { type: 'network.connect', container: 'migrate-1', network: NET, ports: [] });
      at(1, { type: 'network.request', from: 'migrate-1', to: 'db-2', network: NET, label: 'psql -> db:5432 · 001_init.sql' });
      at(3, { type: 'container.exit', id: 'migrate-1', code: 0 });
      at(0.5, { type: 'container.remove', id: 'migrate-1' }); // --rm
    }),

    step('expose', 'Expose', 'web is re-created with -p 8080:8080 (UBI nginx listens on 8080 as non-root); a road leads through a gate in the wall to the host.', (at) => {
      at(0, { type: 'container.remove', id: 'web-1' });
      at(0.5, { type: 'container.create', id: 'web-2', name: 'web', image: NGINX, mounts: [], env: [] });
      at(2.5, { type: 'container.start', id: 'web-2' });
      at(0.3, { type: 'network.connect', container: 'web-2', network: NET, ports: [webPort] });
    }),

    step('storage', 'Storage', 'Three kinds of storage: a named volume, a host path, and tmpfs scratch space. Mounts are set at create time, so both containers are re-created, keeping their env, port and network.', (at) => {
      at(0, { type: 'volume.create', name: 'pgdata' });
      at(1.5, { type: 'container.remove', id: 'web-2' });
      at(0.5, { type: 'container.create', id: 'web-3', name: 'web', image: NGINX, mounts: webMounts, env: [] });
      at(2.5, { type: 'container.start', id: 'web-3' });
      at(0.3, { type: 'network.connect', container: 'web-3', network: NET, ports: [webPort] });
      at(1.5, { type: 'container.remove', id: 'db-2' });
      at(0.5, { type: 'container.create', id: 'db-3', name: 'db', image: POSTGRES, mounts: dbMounts, env: dbEnv });
      at(3.5, { type: 'container.start', id: 'db-3' });
      at(0.3, { type: 'network.connect', container: 'db-3', network: NET, ports: [] });
    }),

    step('build', 'Containerfile', 'The R&D department writes a Containerfile FROM the UBI nginx image. podman build reuses all of its layers, commits one new layer per COPY, and delivers the custom image to the warehouse.', (at) => {
      at(0, { type: 'image.build.start', image: CUSTOM, base: NGINX, containerfile });
      containerfile
        .filter((line) => line.startsWith('COPY'))
        .forEach((instruction, i) => at(1.5, { type: 'image.build.layer', image: CUSTOM, instruction, layer: customLayers[i]! }));
      at(1.5, { type: 'image.build.done', image: CUSTOM, layers: [...nginxLayers, ...customLayers] });
    }),

    step('quadlet', 'Quadlet', 'The Quadlet department writes web.container for the custom image and sends it to systemd. On daemon-reload the Quadlet generator turns it into web.service, which systemd can now start at boot and restart on failure.', (at) => {
      at(0, { type: 'quadlet.create', file: 'web.container', path: '~/.config/containers/systemd/web.container', image: CUSTOM, lines: quadlet });
      at(2, { type: 'systemd.daemon-reload', generated: [{ quadlet: 'web.container', unit: 'web.service' }] });
    }),


    step('metrics', 'Metrics', `A metrics-collector from the plain UBI image runs a short scrape and exits; --restart=always starts it again, so it cycles every ${METRICS_EVERY} seconds for as long as the city runs.`, (at) => {
      at(0, {
        type: 'container.create',
        id: 'metrics-1',
        name: 'metrics-collector',
        image: UBI,
        mounts: [],
        env: [],
        restart: 'always',
        command: `sh -c 'curl -s http://web:8080/ >/dev/null; sleep ${METRICS_EVERY}'`,
        runFor: METRICS_EVERY,
      });
      at(3.5, { type: 'container.start', id: 'metrics-1' });
      at(0.3, { type: 'network.connect', container: 'metrics-1', network: NET, ports: [] });
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
