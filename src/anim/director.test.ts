// @vitest-environment happy-dom
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Tweener } from '../engine/tween';
import { EventBus } from '../sim/bus';
import { defaultSteps } from '../sim/scenario';
import { Simulator } from '../sim/simulator';
import { entityOf, type EntityKind } from '../world/entity';
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

describe('Director fast-forward', () => {
  it('builds the final city without any frames', async () => {
    const { scene, director } = await fastForward(5);
    expect(director.isIdle).toBe(true);
    const k = kinds(scene);
    expect(k.get('container')?.sort()).toEqual(['ctr:db-3', 'ctr:web-3']);
    expect(k.get('volume')).toEqual(['vol:pgdata']);
    expect(k.get('host path')).toEqual(['host:/home/user/site']);
    expect(k.get('scratch')).toHaveLength(1);
    expect(k.get('port')).toHaveLength(1);
    expect(k.get('secret')).toHaveLength(1);
    expect(k.get('env var')).toHaveLength(2);
    expect(k.get('layer')).toHaveLength(6); // 3 + 4, base layer shared
    expect(k.get('image pull')).toBeUndefined(); // trucks left
  });

  it('leaves the crashed db boarded up after deploy', async () => {
    const { scene } = await fastForward(2);
    const db = scene.getObjectByProperty('name', 'boards');
    const boarded: string[] = [];
    scene.traverse((o) => {
      if (o.name === 'boards' && o.visible) boarded.push(entityOf(o)!.key);
    });
    expect(db).toBeDefined();
    expect(boarded).toEqual(['ctr:db-1']);
  });

  it('reset clears everything for a replay', async () => {
    const { scene, director } = await fastForward(5);
    director.reset();
    expect(kinds(scene).size).toBe(0);
  });
});
