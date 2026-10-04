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
  it('is deterministic and shares the base layer between images', () => {
    expect(defaultSteps(7)).toEqual(defaultSteps(7));
    const pull = defaultSteps().find((s) => s.id === 'pull')!;
    expect(pull.events.filter((e) => e.event.type === 'image.layer.done' && e.event.cached)).toHaveLength(1);
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
    expect(s.containers.get('db-3')?.env.map((e) => e.name)).toContain('POSTGRES_PASSWORD');
    expect(s.containers.get('web-3')?.mounts.map((m) => m.kind).sort()).toEqual(['bind', 'tmpfs']);
    expect(s.containers.get('web-3')?.ports).toEqual([{ host: 8080, container: 80, protocol: 'tcp' }]);
  });

  it('fast-forward reaches the same state as playing step by step', () => {
    const steps = defaultSteps();
    const played = new Simulator(new EventBus(), steps);
    steps.slice(0, 3).forEach((_, i) => {
      played.begin(i, 0);
      played.update(Number.POSITIVE_INFINITY);
    });
    const jumped = new Simulator(new EventBus(), steps);
    jumped.fastForward(3);
    expect(jumped.state).toEqual(played.state);
    expect(jumped.current).toBe(2);
    expect(jumped.state.containers.get('db-1')).toBeUndefined();
  });

  it('leaves the crashed db abandoned after deploy', () => {
    const sim = new Simulator(new EventBus(), defaultSteps());
    sim.fastForward(2);
    expect(sim.state.containers.get('db-1')).toMatchObject({ status: 'exited', exitCode: 1 });
  });
});
