import { describe, expect, it } from 'vitest';
import { EventBus } from './bus';
import type { SimEvent } from './events';
import { defaultSteps } from './scenario';
import { Simulator } from './simulator';
import { applyEvent, canRemoveImage, createState } from './state';

describe('podman state', () => {
  it('keeps layers and volumes after a container is removed', () => {
    const s = createState();
    const events: SimEvent[] = [
      { type: 'image.pull.start', image: 'nginx', layers: ['a', 'b'] },
      { type: 'image.layer.done', image: 'nginx', layer: 'a', cached: false },
      { type: 'image.layer.done', image: 'nginx', layer: 'b', cached: false },
      { type: 'volume.create', name: 'data' },
      { type: 'container.create', id: 'c1', name: 'web', image: 'nginx', mounts: [{ kind: 'volume', source: 'data', target: '/d' }], env: [] },
      { type: 'container.remove', id: 'c1' },
    ];
    events.forEach((e) => applyEvent(s, e));
    expect(s.containers.size).toBe(0);
    expect([...s.layers]).toEqual(['a', 'b']);
    expect(s.volumes.has('data')).toBe(true);
  });

  it('refuses image removal while a container uses it', () => {
    const s = createState();
    applyEvent(s, { type: 'container.create', id: 'c1', name: 'web', image: 'nginx', mounts: [], env: [] });
    expect(canRemoveImage(s, 'nginx')).toBe(false);
    applyEvent(s, { type: 'container.remove', id: 'c1' });
    expect(canRemoveImage(s, 'nginx')).toBe(true);
  });

  it('tracks pod membership', () => {
    const s = createState();
    applyEvent(s, { type: 'pod.create', id: 'p', name: 'app' });
    applyEvent(s, { type: 'container.create', id: 'c1', name: 'web', image: 'nginx', mounts: [], env: [], pod: 'p' });
    expect(s.pods.get('p')?.members).toEqual(['c1']);
  });
});

describe('default steps', () => {
  it('is deterministic and reuses the UBI base layer for nginx and postgresql', () => {
    expect(defaultSteps(7)).toEqual(defaultSteps(7));
    const pull = defaultSteps().find((s) => s.id === 'pull')!;
    const starts = pull.events.flatMap((e) => (e.event.type === 'image.pull.start' ? [e.event] : []));
    const [ubi, nginx, postgres] = starts;
    expect(starts.map((e) => e.image.split('/').pop())).toEqual(['ubi:latest', 'nginx-124:latest', 'postgresql-16:latest']);
    expect(nginx!.layers[0]).toBe(ubi!.layers[0]);
    expect(postgres!.layers[0]).toBe(ubi!.layers[0]);
    const cached = pull.events.flatMap((e) => (e.event.type === 'image.layer.done' && e.event.cached ? [e.event] : []));
    expect(cached.filter((e) => e.layer === ubi!.layers[0]).map((e) => e.image)).toEqual([nginx!.image, postgres!.image]);
  });

  it('keeps events in time order within each step', () => {
    for (const s of defaultSteps()) {
      const times = s.events.map((e) => e.at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('plays each step in turn to the final deployment', () => {
    const bus = new EventBus();
    const steps = defaultSteps();
    const sim = new Simulator(bus, steps);
    steps.forEach((_, i) => {
      sim.begin(i, 0);
      sim.update(Number.POSITIVE_INFINITY);
      expect(sim.stepDone).toBe(true);
    });
    const s = sim.state;
    expect([...s.containers.keys()].sort()).toEqual(['db-3', 'web-3']);
    expect(s.containers.get('db-3')).toMatchObject({ status: 'running', mounts: [{ kind: 'volume', source: 'pgdata' }] });
    expect(s.containers.get('db-3')?.env.map((e) => e.name)).toContain('POSTGRESQL_PASSWORD');
    expect(s.containers.get('web-3')?.mounts.map((m) => m.kind).sort()).toEqual(['bind', 'tmpfs']);
    const nginx = s.images.get('registry.access.redhat.com/ubi9/nginx-124:latest')!;
    const custom = s.images.get('localhost/podcity-web:1.0')!;
    expect(custom.layers.slice(0, nginx.layers.length)).toEqual(nginx.layers); // built FROM nginx: its layers reused
    expect(custom.layers).toHaveLength(nginx.layers.length + 2); // one per COPY
    expect(s.containers.has('migrate-1')).toBe(false); // --rm
    expect(s.images.size).toBe(4); // the one-off left its image behind
    expect(s.quadlets.get('web.container')).toMatchObject({ image: 'localhost/podcity-web:1.0', unit: 'web.service' });
    expect(s.networks.get('backend')).toMatchObject({ driver: 'bridge', subnet: '10.89.0.0/24' });
    for (const id of ['db-3', 'web-3']) expect(s.containers.get(id)?.networks, id).toEqual(['backend']);
    expect(s.containers.get('web-3')?.ports).toEqual([{ host: 8080, container: 8080, protocol: 'tcp' }]);
  });

  it('fast-forward reaches the same state as playing step by step', () => {
    const steps = defaultSteps();
    const throughEnv = steps.findIndex((s) => s.id === 'env') + 1;
    const played = new Simulator(new EventBus(), steps);
    steps.slice(0, throughEnv).forEach((_, i) => {
      played.begin(i, 0);
      played.update(Number.POSITIVE_INFINITY);
    });
    const jumped = new Simulator(new EventBus(), steps);
    jumped.fastForward(throughEnv);
    expect(jumped.state).toEqual(played.state);
    expect(jumped.current).toBe(throughEnv - 1);
    expect(jumped.state.containers.get('db-1')).toBeUndefined();
  });

  it('leaves the crashed db abandoned after deploy', () => {
    const steps = defaultSteps();
    const sim = new Simulator(new EventBus(), steps);
    sim.fastForward(steps.findIndex((s) => s.id === 'deploy') + 1);
    expect(sim.state.containers.get('db-1')).toMatchObject({ status: 'exited', exitCode: 1 });
  });

  it('runs db-migrate as a one-off from the db image that exits 0 and is auto-removed', () => {
    const migrate = defaultSteps().find((s) => s.id === 'migrate')!.events.map((e) => e.event);
    const create = migrate.find((e) => e.type === 'container.create');
    expect(create).toMatchObject({ name: 'db-migrate', image: 'registry.access.redhat.com/ubi9/postgresql-16:latest', autoRemove: true });
    expect(migrate.map((e) => e.type).slice(-2)).toEqual(['container.exit', 'container.remove']);
    expect(migrate.find((e) => e.type === 'container.exit')).toMatchObject({ code: 0 });
  });
});
