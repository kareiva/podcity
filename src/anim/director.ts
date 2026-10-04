import * as THREE from 'three';
import type { EventBus } from '../sim/bus';
import type { EventOf, Mount } from '../sim/events';
import type { Tweener } from '../engine/tween';
import { ease } from '../engine/tween';
import { addRoad } from '../world/city';
import { keys, tag } from '../world/entity';
import { makeGate } from '../world/gate';
import { makeLabel } from '../world/label';
import {
  districts,
  doorQueueSlot,
  factorySlot,
  hostPathSlot,
  lockerSlot,
  manifestSlot,
  pullRoute,
  shelfSlot,
  wallZ,
} from '../world/layout';
import { imageColor, palette } from '../world/palette';
import { ArcLayer } from './arcs';

const FACTORY_SIZE = new THREE.Vector3(8, 6, 8);
const LOCKER_SIZE = new THREE.Vector3(3.5, 4, 3.5);
const SHED_SIZE = new THREE.Vector3(5, 3, 5);

interface Factory {
  name: string;
  group: THREE.Group;
  slot: { x: number; z: number };
  cards: THREE.Mesh[]; // env var feedback cards, at the door until start
  extras: THREE.Object3D[]; // scene-level parts owned by this factory (roads, gates)
}

/**
 * Maps simulation events to choreographies. Events for the same site play in
 * order on one queue; a re-created container (same name) reuses its plot and
 * waits for the old building to be demolished first.
 */
export class Director {
  arcs: ArcLayer;

  private root = new THREE.Group();
  private gen = 0; // bumped by reset(); stale choreographies stop on mismatch
  private busy = 0;
  private queues = new Map<string, Promise<void>>();
  private names = new Map<string, string>(); // container id -> name
  private plots = new Map<string, number>(); // container name -> factory plot
  private factories = new Map<string, Factory>();
  private manifests = new Map<string, THREE.Group>();
  private crates = new Map<string, THREE.Mesh>();
  private lockers = new Map<string, THREE.Mesh>();
  private hostPaths = new Map<string, THREE.Mesh>();
  private trucks = new Map<string, THREE.Mesh>();
  private crateCount = 0;

  private readonly box = new THREE.BoxGeometry(1, 1, 1);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly tw: Tweener,
    bus: EventBus,
  ) {
    scene.add(this.root);
    this.arcs = new ArcLayer(this.root, tw);

    bus.on('image.pull.start', (e) => this.enqueue(`image:${e.image}`, () => this.truckArrives(e)));
    bus.on('image.layer.done', (e) => this.enqueue(`image:${e.image}`, () => this.shelveLayer(e)));
    bus.on('image.pull.done', (e) => this.enqueue(`image:${e.image}`, () => this.truckLeaves(e)));
    bus.on('volume.create', (e) => this.enqueue(`volume:${e.name}`, () => this.buildLocker(e)));
    bus.on('volume.remove', (e) => this.enqueue(`volume:${e.name}`, () => this.removeLocker(e.name)));
    bus.on('container.create', (e) => {
      this.names.set(e.id, e.name);
      this.enqueue(this.site(e.id), () => this.buildFactory(e));
    });
    bus.on('container.start', (e) => this.enqueue(this.site(e.id), () => this.startFactory(e.id)));
    bus.on('container.stop', (e) => this.enqueue(this.site(e.id), () => this.abandonFactory(e.id, false)));
    bus.on('container.exit', (e) => this.enqueue(this.site(e.id), () => this.abandonFactory(e.id, e.code !== 0)));
    bus.on('container.remove', (e) => this.enqueue(this.site(e.id), () => this.demolishFactory(e.id)));
    bus.on('network.connect', (e) => this.enqueue(this.site(e.container), () => this.expose(e)));
    // TODO: pod.create, kube.generate choreographies.
  }

  /** Drop every dynamic object and pending choreography. */
  reset(): void {
    this.gen++;
    this.busy = 0;
    this.tw.clear();
    this.queues.clear();
    this.dispose(this.root);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.arcs = new ArcLayer(this.root, this.tw);
    for (const m of [this.names, this.plots, this.factories, this.manifests, this.crates, this.lockers, this.hostPaths, this.trucks])
      m.clear();
    this.crateCount = 0;
  }

  /** Resolves when every queued choreography has finished. */
  async idle(): Promise<void> {
    await Promise.all(this.queues.values());
  }

  get isIdle(): boolean {
    return this.busy === 0;
  }

  private site(id: string): string {
    return `site:${this.names.get(id) ?? id}`;
  }

  private enqueue(key: string, run: () => Promise<void>): void {
    const gen = this.gen;
    this.busy++;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => (gen === this.gen ? run() : undefined))
      .catch((err) => console.error(`choreography ${key} failed`, err))
      .finally(() => {
        if (gen === this.gen) this.busy--;
      });
    this.queues.set(key, next);
  }

  private mesh(color: number): THREE.Mesh {
    const m = new THREE.Mesh(this.box, new THREE.MeshStandardMaterial({ color, flatShading: true }));
    m.castShadow = true;
    return m;
  }

  // --- Image pull: cargo delivery -------------------------------------------

  private async truckArrives(e: EventOf<'image.pull.start'>): Promise<void> {
    const short = shortRef(e.image);
    const color = imageColor(e.image);
    const truck = this.mesh(color);
    truck.scale.set(5, 2.5, 2.5);
    const [sx, sz] = pullRoute[0]!;
    truck.position.set(sx, 1.6, sz);
    truck.add(makeLabel(short));
    tag(truck, { key: `pull:${e.image}`, kind: 'image pull', name: short });
    this.root.add(truck);
    this.trucks.set(e.image, truck);

    // Manifest board: the image itself, grouping its layer crates.
    const slot = manifestSlot(this.manifests.size);
    const manifest = new THREE.Group();
    manifest.position.set(slot.x, 0.3, slot.z);
    const pole = this.mesh(palette.stopped);
    pole.scale.set(0.3, 3, 0.3);
    pole.position.y = 1.5;
    const board = this.mesh(color);
    board.scale.set(3, 2, 0.3);
    board.position.y = 3.5;
    manifest.add(pole, board);
    tag(manifest, { key: keys.image(e.image), kind: 'image', name: short });
    this.root.add(manifest);
    this.manifests.set(e.image, manifest);

    await Promise.all([
      this.driveAlong(truck, pullRoute, 3),
      this.tw.tween({ duration: 0.8, ease: ease.outBack, update: (k) => manifest.scale.setScalar(Math.max(k, 0.01)) }),
    ]);
  }

  private async shelveLayer(e: EventOf<'image.layer.done'>): Promise<void> {
    if (e.cached) {
      // Layer already in local storage: flash the existing crate instead.
      // A shared layer keeps the color of the image that first brought it.
      const crate = this.crates.get(e.layer);
      if (crate) await this.flash(crate);
      return;
    }
    const truck = this.trucks.get(e.image);
    const slot = shelfSlot(this.crateCount++);
    const crate = this.mesh(imageColor(e.image));
    crate.scale.setScalar(2.4);
    const from = truck ? truck.position.clone() : new THREE.Vector3(slot.x, 6, slot.z);
    crate.position.copy(from);
    tag(crate, { key: keys.layer(e.layer), kind: 'layer', name: `${e.layer} · ${shortRef(e.image)}` });
    this.root.add(crate);
    this.crates.set(e.layer, crate);
    await this.hop(crate, from, new THREE.Vector3(slot.x, slot.y + 1.2, slot.z), 0.8, 4);
  }

  private async truckLeaves(e: EventOf<'image.pull.done'>): Promise<void> {
    const truck = this.trucks.get(e.image);
    if (!truck) return;
    await this.driveAlong(truck, [...pullRoute].reverse(), 2.5);
    this.dispose(truck);
    this.trucks.delete(e.image);
  }

  // --- Storage: lockers, host paths, scratch space --------------------------

  private async buildLocker(e: EventOf<'volume.create'>): Promise<void> {
    const slot = lockerSlot(this.lockers.size);
    const locker = this.mesh(palette.storage);
    locker.position.set(slot.x, 0.3, slot.z);
    locker.add(makeLabel(e.name));
    tag(locker, { key: keys.volume(e.name), kind: 'volume', name: e.name });
    this.root.add(locker);
    this.lockers.set(e.name, locker);
    await this.rise(locker, LOCKER_SIZE, 0.3);
  }

  private async removeLocker(name: string): Promise<void> {
    const locker = this.lockers.get(name);
    if (!locker) return;
    await this.arcs.disconnect(keys.volume(name));
    this.dispose(locker);
    this.lockers.delete(name);
  }

  /** Host paths live on the host land and outlive every container. */
  private async ensureHostPath(path: string): Promise<THREE.Mesh> {
    const existing = this.hostPaths.get(path);
    if (existing) return existing;
    const slot = hostPathSlot(this.hostPaths.size);
    const shed = this.mesh(palette.hostPath);
    shed.position.set(slot.x, 0.3, slot.z);
    shed.add(makeLabel(path));
    tag(shed, { key: keys.hostPath(path), kind: 'host path', name: path });
    this.root.add(shed);
    this.hostPaths.set(path, shed);
    await this.rise(shed, SHED_SIZE, 0.3);
    return shed;
  }

  /** Scratch space (tmpfs) is a bin beside the factory and is demolished with it. */
  private addScratch(f: Factory, m: Mount, n: number): Promise<void> {
    const bin = this.mesh(palette.scratch);
    bin.position.set(-FACTORY_SIZE.x / 2 - 1.2, 0, -2 + n * 2);
    tag(bin, { key: `scratch:${f.name}:${m.target}`, kind: 'scratch', name: m.target });
    f.group.add(bin);
    return this.rise(bin, new THREE.Vector3(1.4, 1.4, 1.4), 0);
  }

  private async connectStorage(id: string, f: Factory, mounts: Mount[]): Promise<void> {
    const roof = new THREE.Vector3(f.slot.x, FACTORY_SIZE.y + 0.5, f.slot.z);
    let scratch = 0;
    await Promise.all(
      mounts.map(async (m) => {
        switch (m.kind) {
          case 'volume': {
            const locker = this.lockers.get(m.source);
            if (!locker) return;
            const to = locker.position.clone().setY(LOCKER_SIZE.y + 0.5);
            return this.arcs.connect(keys.container(id), keys.volume(m.source), roof, to, palette.storage);
          }
          case 'bind': {
            const shed = await this.ensureHostPath(m.source);
            const to = shed.position.clone().setY(SHED_SIZE.y + 0.5);
            return this.arcs.connect(keys.container(id), keys.hostPath(m.source), roof, to, palette.hostPath);
          }
          case 'tmpfs':
            return this.addScratch(f, m, scratch++);
        }
      }),
    );
  }

  // --- Containers: factories ------------------------------------------------

  private async buildFactory(e: EventOf<'container.create'>): Promise<void> {
    let plot = this.plots.get(e.name);
    if (plot === undefined) this.plots.set(e.name, (plot = this.plots.size));
    const slot = factorySlot(plot);
    const group = new THREE.Group();
    group.position.set(slot.x, 0.3, slot.z);

    const body = this.mesh(palette.building);
    body.name = 'body';
    group.add(body);
    const stack = this.mesh(palette.stopped);
    stack.name = 'stack';
    stack.scale.set(1, 4, 1);
    stack.position.set(2.5, 6, 2.5);
    group.add(stack);
    const boards = this.makeBoards();
    group.add(boards);
    const label = makeLabel(`${e.name} (${e.id})`);
    label.position.set(0, 9, 0);
    group.add(label);
    tag(group, { key: keys.container(e.id), kind: 'container', name: `${e.name} · ${e.id}` });

    this.root.add(group);
    const factory: Factory = { name: e.name, group, slot, cards: [], extras: [] };
    this.factories.set(e.id, factory);
    // TODO: unboxing — carry crates from the shelf and stack them as layers.
    await this.rise(body, FACTORY_SIZE, 0);

    const roof = new THREE.Vector3(slot.x, FACTORY_SIZE.y + 0.5, slot.z);
    const links: Promise<void>[] = [this.deliverFeedback(e, factory), this.connectStorage(e.id, factory, e.mounts)];
    const manifest = this.manifests.get(e.image);
    if (manifest) {
      const from = manifest.position.clone().setY(4.5);
      links.push(this.arcs.connect(keys.image(e.image), keys.container(e.id), from, roof, imageColor(e.image)));
    }
    await Promise.all(links);
  }

  /** Crossed planks over the front wall, hidden until the building is abandoned. */
  private makeBoards(): THREE.Group {
    const boards = new THREE.Group();
    boards.name = 'boards';
    for (const angle of [0.6, -0.6]) {
      const plank = this.mesh(palette.boards);
      plank.scale.set(6, 0.6, 0.2);
      plank.rotation.z = angle;
      boards.add(plank);
    }
    boards.position.set(0, FACTORY_SIZE.y / 2, FACTORY_SIZE.z / 2 + 0.15);
    boards.visible = false;
    return boards;
  }

  /** Env vars arrive from the Demo Shopping Center as feedback cards and queue at the door. */
  private async deliverFeedback(e: EventOf<'container.create'>, factory: Factory): Promise<void> {
    const sc = districts.shoppingCenter;
    const origin = new THREE.Vector3(sc.x, 4, sc.z);
    await Promise.all(
      e.env.map((env, i) => {
        const card = this.mesh(env.secret ? palette.secret : palette.card);
        card.scale.set(1.2, 0.15, 0.9);
        card.position.copy(origin);
        tag(card, { key: keys.env(e.id, env.name), kind: env.secret ? 'secret' : 'env var', name: env.name });
        this.root.add(card);
        factory.cards.push(card);
        const q = doorQueueSlot(factory.slot, i);
        return this.hop(card, origin, new THREE.Vector3(q.x, 0.45, q.z), 1.6, 10, i * 0.25);
      }),
    );
  }

  private async startFactory(id: string): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    // Feedback is processed at start: cards go in and are pinned to the front wall.
    const wall = f.slot.z + FACTORY_SIZE.z / 2 + 0.1;
    const waiting = f.cards.filter((c) => c.parent !== f.group);
    await Promise.all(
      waiting.map(async (card, i) => {
        const from = card.position.clone();
        const to = new THREE.Vector3(f.slot.x - 2.5 + (i % 4) * 1.6, 1.5 + Math.floor(i / 4) * 1.2, wall);
        await this.tw.tween({
          duration: 0.7,
          delay: i * 0.2,
          update: (k) => {
            card.position.lerpVectors(from, to, k);
            card.rotation.x = (Math.PI / 2) * k;
            card.scale.set(1.2 - 0.3 * k, 0.15, 0.9 - 0.2 * k);
          },
        });
        f.group.attach(card);
      }),
    );
    const body = this.part(f, 'body');
    if (body && waiting.length) await this.flash(body);
    this.part(f, 'boards')!.visible = false;
    await Promise.all([this.recolor(this.part(f, 'body'), palette.building), this.recolor(this.part(f, 'stack'), palette.running)]);
  }

  /** Stopped or exited: the building stays, dark and boarded up, no green stack. */
  private async abandonFactory(id: string, failed: boolean): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    await Promise.all([
      this.recolor(this.part(f, 'body'), palette.abandoned),
      this.recolor(this.part(f, 'stack'), failed ? palette.error : palette.abandoned),
    ]);
    const boards = this.part(f, 'boards')!;
    boards.visible = true;
    await this.tw.tween({ duration: 0.4, ease: ease.outBack, update: (k) => boards.scale.setScalar(Math.max(k, 0.01)) });
  }

  private async demolishFactory(id: string): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    await this.arcs.disconnect(keys.container(id));
    // Cards still waiting at the door and expose roads are not children of the group.
    const loose = [...f.cards.filter((c) => c.parent !== f.group), ...f.extras];
    await this.tw.tween({
      duration: 0.8,
      update: (k) => {
        f.group.scale.set(1, 1 - k * 0.99, 1);
        loose.forEach((o) => o.scale.setScalar(Math.max(1 - k, 0.01)));
      },
    });
    loose.forEach((o) => this.dispose(o));
    this.dispose(f.group);
    this.factories.delete(id);
  }

  // --- Network: exposing to the host ----------------------------------------

  /** Published ports: a road from the factory door through a wall gate to the host land. */
  private async expose(e: EventOf<'network.connect'>): Promise<void> {
    const f = this.factories.get(e.container);
    if (!f) return;
    const hostEdge = districts.hostLand.z - districts.hostLand.d / 2;
    await Promise.all(
      e.ports.map(async (p, i) => {
        const x = f.slot.x + i * 3;
        const z0 = f.slot.z + FACTORY_SIZE.z / 2;
        const road = addRoad(this.root, [[x, z0], [x, hostEdge]], palette.network, 2.5);
        const gate = makeGate(2.5, false, palette.network);
        gate.position.set(x, 0, wallZ(x));
        const label = makeLabel(`${p.host} → ${p.container}/${p.protocol}`);
        label.position.set(0, 6.5, 0);
        gate.add(label);
        tag(gate, { key: `port:${e.container}:${p.host}`, kind: 'port', name: `${p.host} → ${p.container}/${p.protocol}` });
        this.root.add(gate);
        f.extras.push(road, gate);

        // Pave from the factory outwards, then raise the gate.
        road.position.z = z0;
        road.children.forEach((c) => (c.position.z -= z0));
        await this.tw.tween({ duration: 1.5, update: (k) => road.scale.set(1, 1, Math.max(k, 0.001)) });
        await this.tw.tween({ duration: 0.6, ease: ease.outBack, update: (k) => gate.scale.set(1, Math.max(k, 0.01), 1) });
      }),
    );
  }

  // --- Helpers --------------------------------------------------------------

  private part(f: Factory, name: string): THREE.Mesh | undefined {
    return f.group.getObjectByName(name) as THREE.Mesh | undefined;
  }

  private async recolor(obj: THREE.Mesh | undefined, color: number): Promise<void> {
    if (!obj) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    const from = mat.color.clone();
    const to = new THREE.Color(color);
    await this.tw.tween({ duration: 0.6, update: (k) => mat.color.lerpColors(from, to, k) });
  }

  /** Grow from the ground to `size`, keeping the base at `baseY`. */
  private async rise(obj: THREE.Object3D, size: THREE.Vector3, baseY: number): Promise<void> {
    await this.tw.tween({
      duration: 1,
      ease: ease.outBack,
      update: (k) => {
        const h = Math.max(size.y * k, 0.01);
        obj.scale.set(size.x, h, size.z);
        obj.position.y = baseY + h / 2;
      },
    });
  }

  /** Ballistic-looking move from a to b peaking `height` above the straight line. */
  private hop(obj: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, duration: number, height: number, delay = 0) {
    return this.tw.tween({
      duration,
      delay,
      update: (k) => {
        obj.position.lerpVectors(a, b, k);
        obj.position.y += Math.sin(k * Math.PI) * height;
      },
    });
  }

  private async flash(obj: THREE.Mesh): Promise<void> {
    const mat = obj.material as THREE.MeshStandardMaterial;
    await this.tw.tween({
      duration: 0.8,
      ease: ease.linear,
      update: (k) => mat.emissive.setRGB(Math.sin(k * Math.PI) * 0.6, Math.sin(k * Math.PI) * 0.6, 0),
    });
  }

  private async driveAlong(obj: THREE.Object3D, route: [number, number][], duration: number): Promise<void> {
    const curve = new THREE.CatmullRomCurve3(route.map(([x, z]) => new THREE.Vector3(x, obj.position.y, z)), false, 'catmullrom', 0.1);
    await this.tw.tween({
      duration,
      update: (k) => {
        obj.position.copy(curve.getPointAt(k));
        const t = curve.getTangentAt(Math.min(k, 0.999));
        obj.rotation.y = -Math.atan2(t.z, t.x);
      },
    });
  }

  private dispose(obj: THREE.Object3D): void {
    obj.removeFromParent();
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        (o.material as THREE.Material).dispose();
        if (o.geometry !== this.box) o.geometry.dispose();
      }
      // CSS2DObject elements stay in the DOM unless removed explicitly.
      if ('element' in o && o.element instanceof HTMLElement) o.element.remove();
    });
  }
}

function shortRef(ref: string): string {
  return ref.split('/').pop() ?? ref;
}
