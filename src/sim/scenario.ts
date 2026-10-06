import type { Digest, EnvVar, Mount, Port, SimEvent } from './events';
import { createRng, shortDigest } from './rng';

export interface ScheduledEvent {
  at: number; // simulation seconds from the start of its step
  event: SimEvent;
}

export type StepId = 'pull' | 'network' | 'deploy' | 'env' | 'expose' | 'storage' | 'migrate' | 'metrics' | 'build' | 'compose' | 'quadlet' | 'openshift';

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
const PG_SECRET = 'pgpass';
const CUSTOM = 'localhost/podcity-api:1.0';
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

  // :Z relabels the site for each web container: container_file_t with that container's MCS categories,
  // so no other container can read it. Podman picks the categories at create; seeded here.
  const mcsRng = createRng(seed ^ 0x5e11);
  const mcsLevel = (): string => {
    const a = Math.floor(mcsRng() * 1024);
    const b = (a + 1 + Math.floor(mcsRng() * 1023)) % 1024;
    return `s0:c${Math.min(a, b)},c${Math.max(a, b)}`;
  };
  const webMounts: Mount[] = [
    { kind: 'bind', source: '/home/user/site', target: '/opt/app-root/src', readOnly: true, relabel: 'private' },
    { kind: 'tmpfs', source: 'tmpfs', target: '/var/lib/nginx/tmp' },
  ];
  const web3Level = mcsLevel(); // storage step
  const web4Level = mcsLevel(); // compose
  const webPort: Port = { host: 8080, container: 8080, protocol: 'tcp' };
  const dbMounts: Mount[] = [{ kind: 'volume', source: 'pgdata', target: '/var/lib/pgsql/data' }];
  const dbEnv: EnvVar[] = [
    { name: 'POSTGRESQL_USER', value: 'app' },
    { name: 'POSTGRESQL_DATABASE', value: 'app' },
    { name: 'POSTGRESQL_PASSWORD', value: '', secret: true, secretName: PG_SECRET },
  ];

  // podcity-api starts from plain UBI and installs nginx itself.
  const containerfile = [
    `FROM ${UBI}`,
    'RUN dnf -y install nginx && dnf clean all',
    'COPY site/ /usr/share/nginx/html/',
    'COPY podcity.conf /etc/nginx/conf.d/',
    'CMD nginx -g "daemon off;"',
  ];
  const copyLayers: Digest[] = [shortDigest(rng), shortDigest(rng)]; // one per COPY; CMD is metadata only
  const customLayers: Digest[] = [shortDigest(rng), ...copyLayers]; // RUN (nginx), then the two COPYs


  const migrateMounts: Mount[] = [{ kind: 'bind', source: '/home/user/migrations', target: '/migrations', readOnly: true }];
  const migrateEnv: EnvVar[] = [
    { name: 'PGHOST', value: 'db' },
    { name: 'PGUSER', value: 'app' },
    { name: 'PGDATABASE', value: 'app' },
    { name: 'PGPASSWORD', value: '', secret: true, secretName: PG_SECRET },
  ];

  // Compose: the whole stack in one file, with the settings the earlier steps built up by hand.
  const metricsCommand = `sh -c 'curl -s http://web:8080/ >/dev/null; sleep ${METRICS_EVERY}'`;
  const composeFile = [
    'services:',
    '  db:',
    `    image: ${POSTGRES}`,
    '    container_name: db',
    '    networks: [backend]',
    '    volumes: [pgdata:/var/lib/pgsql/data]',
    '    environment:',
    '      POSTGRESQL_USER: app',
    '      POSTGRESQL_DATABASE: app',
    '    secrets:',
    `      - { source: ${PG_SECRET}, type: env, target: POSTGRESQL_PASSWORD }`,
    '  api:',
    `    image: ${CUSTOM}`,
    '    build: { context: ., dockerfile: Containerfile }',
    '    container_name: podcity-api',
    '    networks: [backend]',
    '    depends_on: [db]',
    '  web:',
    `    image: ${NGINX}`,
    '    container_name: web',
    '    networks: [backend]',
    '    depends_on: [db]',
    '    ports: ["8080:8080"]',
    '    volumes: [/home/user/site:/opt/app-root/src:ro,Z]',
    '    tmpfs: [/var/lib/nginx/tmp]',
    '  metrics:',
    '    image: registry.access.redhat.com/ubi9/ubi:latest',
    '    container_name: metrics-collector',
    '    networks: [backend]',
    '    depends_on: [db]',
    '    restart: always',
    `    command: ${metricsCommand}`,
    'networks:',
    `  ${NET}: { external: true }`,
    'volumes:',
    '  pgdata: { external: true }',
    'secrets:',
    `  ${PG_SECRET}: { external: true }`,
  ];
  const PROJECT = 'podcity';
  // Each old container is removed and a new one created from the same settings. db goes first (the others
  // depend on it); then the rest go out farthest plot first, so the trucks never pass each other on the lane.
  const composeStack: { old: string; create: Extract<SimEvent, { type: 'container.create' }>; ports: Port[] }[] = [
    { old: 'db-3', create: { type: 'container.create', id: 'db-4', name: 'db', image: POSTGRES, mounts: dbMounts, env: dbEnv, compose: PROJECT }, ports: [] },
    { old: 'api-1', create: { type: 'container.create', id: 'api-2', name: 'podcity-api', image: CUSTOM, mounts: [], env: [], compose: PROJECT, dependsOn: ['db'] }, ports: [] },
    {
      old: 'metrics-1',
      create: { type: 'container.create', id: 'metrics-2', name: 'metrics-collector', image: UBI, mounts: [], env: [], restart: 'always', command: metricsCommand, runFor: METRICS_EVERY, compose: PROJECT, dependsOn: ['db'] },
      ports: [],
    },
    { old: 'web-3', create: { type: 'container.create', id: 'web-4', name: 'web', image: NGINX, mounts: webMounts, env: [], compose: PROJECT, dependsOn: ['db'], selinuxLevel: web4Level }, ports: [webPort] },
  ];

  // Quadlets for the final city: the same settings podman run used, as unit files systemd can start at boot.
  const unitFile = (description: string, container: string[]) => [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Container]',
    ...container,
    `Network=${NET}`,
    '',
    '[Install]',
    'WantedBy=default.target',
  ];
  const quadlets: { file: string; image: string; lines: string[] }[] = [
    {
      file: 'web.container',
      image: NGINX,
      lines: unitFile('podcity web', [
        `Image=${NGINX}`,
        'ContainerName=web',
        'PublishPort=8080:8080',
        'Volume=/home/user/site:/opt/app-root/src:ro,Z',
        'Tmpfs=/var/lib/nginx/tmp',
      ]),
    },
    {
      file: 'api.container',
      image: CUSTOM,
      lines: unitFile('podcity api', [`Image=${CUSTOM}`, 'ContainerName=podcity-api']),
    },
    {
      file: 'db.container',
      image: POSTGRES,
      lines: unitFile('podcity database', [
        `Image=${POSTGRES}`,
        'ContainerName=db',
        'Volume=pgdata:/var/lib/pgsql/data',
        'Environment=POSTGRESQL_USER=app',
        'Environment=POSTGRESQL_DATABASE=app',
        `Secret=${PG_SECRET},type=env,target=POSTGRESQL_PASSWORD`,
      ]),
    },
  ];

  // OpenShift: the web and podcity-api containers as one Kubernetes Pod (podman kube generate), shipped to the cluster.
  const podMembers = [
    { id: 'web-4', name: 'web', image: NGINX },
    { id: 'api-2', name: 'podcity-api', image: CUSTOM },
  ];
  const podYaml = [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    '  name: podcity',
    '  labels: { app: podcity }',
    'spec:',
    '  containers:',
    '  - name: web',
    `    image: ${NGINX}`,
    '    ports:',
    '    - containerPort: 8080',
    '      hostPort: 8080',
    '  - name: podcity-api',
    `    image: ${CUSTOM}`,
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

    step('env', 'Environment', 'The password goes into a podman secret held at the Secret Facility; plain settings arrive as customer feedback cards. The truck collects both on its way, and db is re-created with them and finally runs.', (at) => {
      at(0, { type: 'secret.create', name: PG_SECRET });
      at(1, { type: 'container.remove', id: 'db-1' });
      at(0.5, { type: 'container.create', id: 'db-2', name: 'db', image: POSTGRES, mounts: [], env: dbEnv });
      at(3.5, { type: 'container.start', id: 'db-2' });
      at(0.3, { type: 'network.connect', container: 'db-2', network: NET, ports: [] });
    }),

    step('expose', 'Expose', 'web is re-created with -p 8080:8080 (UBI nginx listens on 8080 as non-root); the visitor bridge, ending at its last pier outside the factory hall until now, extends into the hall and connects web to the host highway.', (at) => {
      at(0, { type: 'container.remove', id: 'web-1' });
      at(0.5, { type: 'container.create', id: 'web-2', name: 'web', image: NGINX, mounts: [], env: [] });
      at(2.5, { type: 'container.start', id: 'web-2' });
      at(0.3, { type: 'network.connect', container: 'web-2', network: NET, ports: [webPort] });
    }),

    step('storage', 'Storage', 'Three kinds of storage: a named volume, a host path, and tmpfs scratch space. Mounts are set at create time, so both containers are re-created, keeping their env, port and network. The site is mounted with :Z, so SELinux relabels it for web alone: a fence round its house shows the label, container_file_t with web\'s MCS categories.', (at) => {
      at(0, { type: 'volume.create', name: 'pgdata' });
      at(1.5, { type: 'container.remove', id: 'web-2' });
      at(0.5, { type: 'container.create', id: 'web-3', name: 'web', image: NGINX, mounts: webMounts, env: [], selinuxLevel: web3Level });
      at(2.5, { type: 'container.start', id: 'web-3' });
      at(0.3, { type: 'network.connect', container: 'web-3', network: NET, ports: [webPort] });
      at(1.5, { type: 'container.remove', id: 'db-2' });
      at(0.5, { type: 'container.create', id: 'db-3', name: 'db', image: POSTGRES, mounts: dbMounts, env: dbEnv });
      at(3.5, { type: 'container.start', id: 'db-3' });
      at(0.3, { type: 'network.connect', container: 'db-3', network: NET, ports: [] });
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
      at(1, { type: 'network.request', from: 'migrate-1', to: 'db-3', network: NET, label: 'psql -> db:5432 · 001_init.sql' });
      at(3, { type: 'container.exit', id: 'migrate-1', code: 0 });
      at(0.5, { type: 'container.remove', id: 'migrate-1' }); // --rm
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
        command: metricsCommand,
        runFor: METRICS_EVERY,
      });
      at(3.5, { type: 'container.start', id: 'metrics-1' });
      at(0.3, { type: 'network.connect', container: 'metrics-1', network: NET, ports: [] });
    }),

    step('build', 'Containerfile', 'The R&D department writes a Containerfile FROM ubi:latest, put up as an advertising stand on the host roadside next to the host offices and wired to R&D (click it to read it). The crane brings a copy of the UBI image over from the warehouse as the starting point: its layer is reused, not copied. RUN installs nginx and each COPY adds the site and its config, one new layer each; they are packed into the UBI copy, which becomes podcity-api and goes back to the warehouse. It is then deployed as a container on backend like any other image.', (at) => {
      at(0, { type: 'image.build.start', image: CUSTOM, base: UBI, containerfile });
      containerfile
        .filter((line) => /^(RUN|COPY)\s/.test(line))
        .forEach((instruction, i) => at(1.5, { type: 'image.build.layer', image: CUSTOM, instruction, layer: customLayers[i]! }));
      at(1.5, { type: 'image.build.done', image: CUSTOM, layers: [...ubiLayers, ...customLayers] });
      // The truck waits for the image to reach the warehouse, then deploys it like any other.
      at(1, { type: 'container.create', id: 'api-1', name: 'podcity-api', image: CUSTOM, mounts: [], env: [] });
      at(3.5, { type: 'container.start', id: 'api-1' });
      at(0.3, { type: 'network.connect', container: 'api-1', network: NET, ports: [] });
    }),

    step('compose', 'Compose', 'An advertising stand by the host highway, right of the Containerfile stand, holds compose.yaml (click it to read it): the whole stack (db, podcity-api, web, metrics-collector) with its network, volume, secret, ports and mounts in one file. podman compose up --build --force-recreate first rebuilds podcity-api from the same Containerfile: every step hits the build cache, so its container just goes over to R&D and back and it is the same image. Then the stack is redeployed: the deploy truck takes db, and as soon as it leaves, three more trucks drive from the car park south of the factory hall to the bays and load podcity-api, metrics-collector and web; they wait until db is up (the others depend_on it), then deliver at once.', (at) => {
      at(0, { type: 'compose.up', project: PROJECT, path: '~/podcity/compose.yaml', lines: composeFile, services: composeStack.map((c) => c.create.name) });
      // --build: podcity-api is rebuilt from the same Containerfile; every step hits the build cache, so it is the same image.
      at(1, { type: 'image.build.cached', image: CUSTOM, containerfile, layers: [...ubiLayers, ...customLayers] });
      // Then the stack (the director holds it until the build is in): every old container goes, db comes up
      // first on the city's own truck, and only then the services that depend on it, three trucks at once.
      composeStack.forEach((c, i) => at(i === 0 ? 1.5 : 0.1, { type: 'container.remove', id: c.old, compose: PROJECT }));
      const [db, ...dependents] = composeStack;
      for (const group of [[db!], dependents]) {
        group.forEach((c, i) => at(i === 0 ? 0.5 : 0.4, c.create));
        group.forEach((c, i) => at(i === 0 ? 3.5 : 0.1, { type: 'container.start', id: c.create.id }));
        group.forEach((c) => at(0.1, { type: 'network.connect', container: c.create.id, network: NET, ports: c.ports }));
      }
    }),

    step('quadlet', 'Quadlet', 'The Quadlet department writes web.container, api.container and db.container and sends them to systemd, where each gets a pavilion beside the tower (click one to read it). On daemon-reload the Quadlet generator turns each into a .service, which systemd can now start at boot and restart on failure.', (at) => {
      quadlets.forEach((q, i) =>
        at(i === 0 ? 0 : 1.5, { type: 'quadlet.create', file: q.file, path: `~/.config/containers/systemd/${q.file}`, image: q.image, lines: q.lines }),
      );
      at(2, { type: 'systemd.daemon-reload', generated: quadlets.map((q) => ({ quadlet: q.file, unit: q.file.replace(/\.container$/, '.service') })) });
    }),

    step('openshift', 'OpenShift', 'podman kube generate turns the running web and podcity-api containers into one Kubernetes Pod YAML, posted as the timetable next to the freight station. Two trucks take copies of the containers to the station, the crane loads them onto the train, where they form the pod, and oc apply sends the train east out of the city to the OpenShift metropolis.', (at) => {
      at(0, { type: 'kube.generate', pod: 'podcity', path: '~/podcity/podcity-pod.yaml', containers: podMembers, yaml: podYaml });
      at(20, { type: 'kube.deploy', pod: 'podcity', path: '~/podcity/podcity-pod.yaml', cluster: 'OpenShift' });
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
  // --network and -p are given at create time: copy them from the container's network.connect onto its create.
  for (const { event } of events) {
    if (event.type !== 'container.create') continue;
    const connect = events.find((x) => x.event.type === 'network.connect' && x.event.container === event.id)?.event;
    if (connect?.type === 'network.connect') {
      event.network = connect.network;
      event.ports = connect.ports;
    }
  }
  return { id, title, summary, events };
}
