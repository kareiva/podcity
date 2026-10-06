// @vitest-environment happy-dom
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Tweener } from '../engine/tween';
import { EventBus } from '../sim/bus';
import { defaultSteps } from '../sim/scenario';
import { Simulator } from '../sim/simulator';
import { entityOf, keys, type EntityKind } from '../world/entity';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Director } from './director';

function kinds(scene: THREE.Scene): Map<EntityKind, string[]> {
  const out = new Map<EntityKind, string[]>();
  scene.traverse((o) => {
    const info = o.userData.entity ? entityOf(o) : undefined;
    if (info) out.set(info.kind, [...(out.get(info.kind) ?? []), info.key]);
  });
  return out;
}

async function fastForward(upTo: number) {
  const scene = new THREE.Scene();
  const tw = new Tweener();
  const bus = new EventBus();
  const director = new Director(scene, tw, bus);
  const sim = new Simulator(bus, defaultSteps());
  tw.instant = true;
  sim.fastForward(upTo);
  await director.idle();
  return { scene, director, sim };
}

describe('Director selection', () => {
  it('draws arcs from a selected image to its layers, including shared ones', async () => {
    const { director, sim } = await fastForward(1);
    const [ubi, , postgres] = [...sim.state.images.keys()];
    director.select(keys.image(postgres!));
    expect(director.layerArcs.size).toBe(sim.state.images.get(postgres!)!.layers.length);
    director.select(keys.image(ubi!));
    await director.idle();
    expect(director.layerArcs.size).toBe(1);
    director.select(null);
    expect(director.layerArcs.size).toBe(0);
  });
});

describe('Director fast-forward', () => {
  it('builds the final city without any frames', async () => {
    const { scene, director } = await fastForward(defaultSteps().length);
    expect(director.isIdle).toBe(true);
    const k = kinds(scene);
    expect(k.get('container')?.sort()).toEqual(['ctr:api-2', 'ctr:db-4', 'ctr:metrics-2', 'ctr:web-4']);
    expect(k.get('volume')).toEqual(['vol:pgdata']);
    expect(k.get('host path')?.sort()).toEqual(['host:/home/user/migrations', 'host:/home/user/site']); // sheds outlive the one-off
    expect(k.get('scratch')).toHaveLength(1);
    expect(k.get('port')).toHaveLength(1);
    expect(k.get('secret')?.sort()).toEqual(['env:db-4:POSTGRESQL_PASSWORD', 'secret:pgpass']); // sealed card + the secret itself
    expect(k.get('env var')).toHaveLength(2);
    expect(k.get('layer')).toHaveLength(8); // ubi, nginx-124, postgresql-16 share UBI/s2i-core; podcity-api adds 3 on top of ubi (rebuild adds none)
    expect(k.get('image')).toHaveLength(4);
    // Images are kept as their shipping containers; every factory holds a copy of its image's container.
    scene.traverse((o) => {
      const info = o.userData.entity as { kind: string } | undefined;
      if (info?.kind === 'image') expect(o.getObjectByName('lid')).toBeDefined();
      if (info?.kind === 'container') expect(o.getObjectByName('rootfs')).toBeDefined();
    });
    expect(k.get('containerfile')).toEqual(['build:localhost/podcity-api:1.0']);
    expect(k.get('image pull')).toBeUndefined(); // trucks and the R&D van left
    expect(k.get('compose')).toEqual(['compose:podcity']);
    expect(director.arcs.size).toBeGreaterThan(0);
    expect(k.get('quadlet')?.sort()).toEqual(['quadlet:api.container', 'quadlet:db.container', 'quadlet:web.container']);
    // Deployed quadlets stand in front of the systemd tower; their tooltip shows the unit file.
    scene.traverse((o) => {
      const info = o.userData.entity as { kind: string; detail?: string } | undefined;
      if (info?.kind !== 'quadlet') return;
      expect(o.position.z).toBeGreaterThan(80); // in a pavilion beside the systemd tower
      expect(o.getObjectByName('paper')).toBeDefined();
      expect(info.detail).toMatch(/\[Container\]\nImage=/);
    });
    expect(k.get('systemd')?.sort()).toEqual(['unit:api.service', 'unit:api.service', 'unit:db.service', 'unit:db.service', 'unit:web.service', 'unit:web.service']); // a tower floor and its plate each // the static tower is not part of the director's scene
    expect(k.get('network')?.sort()).toEqual(['net:backend', 'netlink:api-2:backend', 'netlink:db-4:backend', 'netlink:metrics-2:backend', 'netlink:web-4:backend']);
  });

  it('hooks each container onto the backend belt when it starts in the deploy step', async () => {
    const steps = defaultSteps();
    const { scene } = await fastForward(steps.findIndex((s) => s.id === 'deploy') + 1);
    const k = kinds(scene);
    expect(k.get('network')?.sort()).toEqual(['net:backend', 'netlink:db-1:backend', 'netlink:web-1:backend']);
  });

  it('leaves the crashed db boarded up after deploy', async () => {
    const { scene } = await fastForward(defaultSteps().findIndex((s) => s.id === 'deploy') + 1);
    const db = scene.getObjectByProperty('name', 'boards');
    const boarded: string[] = [];
    scene.traverse((o) => {
      if (o.name === 'boards' && o.visible) boarded.push(entityOf(o)!.key);
    });
    expect(db).toBeDefined();
    expect(boarded).toEqual(['ctr:db-1']);
  });

  it('runs the one-off migration without boarding it up, then removes it', async () => {
    const steps = defaultSteps();
    const migrate = steps.findIndex((s) => s.id === 'migrate');
    const { scene, director, sim } = await fastForward(migrate);
    const events = steps[migrate]!.events.map((e) => e.event);
    const removal = events.findIndex((e) => e.type === 'container.remove');
    sim.begin(migrate, 0);
    sim.update(steps[migrate]!.events[removal - 1]!.at); // up to the exit, before --rm removes it
    await director.idle();
    const boarded: string[] = [];
    scene.traverse((o) => {
      if (o.name === 'boards' && o.visible) boarded.push(entityOf(o)!.key);
    });
    expect(kinds(scene).get('container')).toContain('ctr:migrate-1');
    expect(boarded).toEqual([]);
    sim.update(Number.POSITIVE_INFINITY);
    await director.idle();
    expect(kinds(scene).get('container')).not.toContain('ctr:migrate-1');
  });

  it('runs crates between web and db over the belt only while both are running', async () => {
    const steps = defaultSteps();
    const through = (id: string) => steps.findIndex((s) => s.id === id) + 1;
    const afterDeploy = await fastForward(through('deploy')); // db crashed
    afterDeploy.director.update(10);
    expect(afterDeploy.director.trafficCount('backend')).toBe(0);
    const afterEnv = await fastForward(through('env')); // db re-created and running
    afterEnv.director.update(10);
    expect(afterEnv.director.trafficCount('backend')).toBeGreaterThan(0);
    expect(afterEnv.director.trafficCount('backend') % 2).toBe(0); // both directions
  });

  it('restarts the metrics collector in place: never boarded up, counting restarts', async () => {
    const steps = defaultSteps();
    const metrics = steps.findIndex((s) => s.id === 'metrics');
    const { scene, director, sim } = await fastForward(metrics);
    sim.begin(metrics, 0);
    sim.update(60); // step events, then a few exit/restart cycles
    await director.idle();
    const ctr = [...(kinds(scene).get('container') ?? [])];
    expect(ctr).toContain('ctr:metrics-1');
    const boarded: string[] = [];
    scene.traverse((o) => {
      if (o.name === 'boards' && o.visible) boarded.push(entityOf(o)!.key);
    });
    expect(boarded).toEqual([]);
    const restarts = sim.state.containers.get('metrics-1')!.restarts;
    expect(restarts).toBeGreaterThanOrEqual(3);
    let label = '';
    scene.traverse((o) => {
      if (entityOf(o)?.key === 'ctr:metrics-1' && o instanceof CSS2DObject) label = o.element.textContent ?? '';
    });
    expect(label).toContain(`↻ ${restarts}`);
  });

  it('reset clears everything for a replay', async () => {
    const { scene, director } = await fastForward(defaultSteps().length);
    director.reset();
    expect(kinds(scene).size).toBe(0);
  });
});
