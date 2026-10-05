import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { EventBus } from '../sim/bus';
import type { EventOf, Mount } from '../sim/events';
import type { Tweener } from '../engine/tween';
import { ease } from '../engine/tween';
import { HOIST_REST, TRUCK_BED, addRoad } from '../world/city';
import { keys, tag, type EntityInfo } from '../world/entity';
import { makeGate } from '../world/gate';
import { makeLabel } from '../world/label';
import {
  CRANE_HEIGHT,
  FACTORY,
  ISO_20FT,
  UNPACK_GANTRY_HEIGHT,
  buildCranes,
  buildWaypoints,
  craneYaw,
  deployRoute,
  districts,
  shopRoute,
  shopToPlotRoute,
  truckBay,
  pullCranes,
  pullWaypoints,
  type CraneSpec,
  doorQueueSlot,
  factorySlot,
  feederRoute,
  hostPathSlot,
  labBenchSlot,
  lockerSlot,
  manifestSlot,
  networkBelt,
  pathSampler,
  smoothPath,
  quadletOffice,
  quadletRoute,
  rndLab,
  shelfSlot,
  unitPlateSlot,
  wallZ,
} from '../world/layout';
import { imageColor, palette } from '../world/palette';
import { ArcLayer } from './arcs';

const FACTORY_SIZE = new THREE.Vector3(FACTORY.w, FACTORY.h, FACTORY.l); // ISO 20ft proportions
const LOCKER_SIZE = new THREE.Vector3(3.5, 4, 3.5);
const OFFICE = { w: 5, h: 6, d: 5 }; // host path: small office building on the host highway
const CARGO = ISO_20FT; // images travel as real-size 20ft shipping containers
const HOIST_CARRY = 4; // hook length while a crane swings a container (clears the city wall)
const BELT_HEIGHT = 1.2;
const BELT_WIDTH = 1.6;
const SLAT_SPACING = 1.5;
const BELT_SPEED = 1.2; // metres per simulation second
const TRAFFIC_SPEED = 2.5; // ambient crates between running containers
const TRAFFIC_GAP = 7; // metres between crates in one direction
const TRAFFIC_MAX = 96; // crates per network

interface Factory {
  name: string;
  group: THREE.Group;
  slot: { x: number; z: number };
  cards: THREE.Mesh[]; // env var feedback cards, at the door until start
  extras: THREE.Object3D[]; // scene-level parts owned by this factory (roads, gates, feeders)
  oneOff: boolean; // --rm: removed as soon as it exits, never left abandoned
  restartAlways: boolean; // --restart=always: podman starts it again whenever it exits
  restarts: number;
  label: CSS2DObject;
  baseLabel: string;
  running: boolean;
  networks: Set<string>; // networks it is hooked onto with a feeder
}

/** A network as a conveyor belt; slats move along it to show it carries traffic. */
interface Belt {
  group: THREE.Group;
  slats: THREE.InstancedMesh;
  length: number;
  traffic: THREE.InstancedMesh; // ambient crates between running members, in world coordinates
}

/**
 * Maps simulation events to choreographies. Events for the same site play in
 * order on one queue; a re-created container (same name) reuses its plot and
 * waits for the old building to be demolished first.
 */
export class Director {
  arcs: ArcLayer;
  /** Image -> layer arcs, shown only while an image is selected. */
  layerArcs: ArcLayer;

  private root = new THREE.Group();
  private gen = 0; // bumped by reset(); stale choreographies stop on mismatch
  private busy = 0;
  private queues = new Map<string, Promise<void>>();
  private names = new Map<string, string>(); // container id -> name
  private plots = new Map<string, number>(); // container name -> factory plot
  private factories = new Map<string, Factory>();
  private manifests = new Map<string, THREE.Group>(); // image ref -> its container, kept in the warehouse
  private imageSlots = new Map<string, number>(); // image ref -> reserved row slot in the warehouse
  private imageStored = new Map<string, { done: Promise<void>; resolve: () => void }>(); // pulls/builds in flight
  private imageLayers = new Map<string, string[]>(); // image ref -> layer digests
  private selectedImage: string | null = null;
  private crates = new Map<string, THREE.Mesh>();
  private lockers = new Map<string, THREE.Mesh>();
  private hostPaths = new Map<string, THREE.Group>();
  private cargo = new Map<string, THREE.Group>(); // image -> its shipping container while delivered
  private locks = new Map<string, Promise<void>>(); // cranes and drop-off spots, one container at a time
  private spotRelease = new Map<string, () => void>(); // image -> frees the unpacking spot once it is gone
  private belts = new Map<string, Belt>(); // network name -> conveyor
  private quadlets = new Map<string, THREE.Group>(); // quadlet file -> pinned board
  private units = new Map<string, THREE.Mesh>(); // generated systemd unit -> plate on the tower
  private trafficPaths = new Map<string, ReturnType<typeof pathSampler>>(); // `net|a|b` -> feeder-belt-feeder path
  private builds = new Map<string, { base: string; crates: THREE.Mesh[] }>(); // image being built in R&D
  private crateCount = 0;

  private readonly box = new THREE.BoxGeometry(1, 1, 1);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly tw: Tweener,
    bus: EventBus,
  ) {
    scene.add(this.root);
    this.arcs = new ArcLayer(this.root, tw);
    this.layerArcs = new ArcLayer(this.root, tw);

    // Registered synchronously, so anything that needs the image (a factory copying it) waits for it to be stored.
    bus.on('image.pull.start', (e) => this.expectImage(e.image));
    bus.on('image.build.start', (e) => this.expectImage(e.image));
    bus.on('image.pull.start', (e) => this.enqueue(`image:${e.image}`, () => this.pullArrives(e)));
    bus.on('image.layer.done', (e) => this.enqueue(`image:${e.image}`, () => this.shelveLayer(e)));
    bus.on('image.pull.done', (e) => this.enqueue(`image:${e.image}`, () => this.pullDone(e)));
    bus.on('image.build.start', (e) => this.enqueue(`image:${e.image}`, () => this.writeContainerfile(e)));
    bus.on('image.build.layer', (e) => this.enqueue(`image:${e.image}`, () => this.commitLayer(e)));
    bus.on('image.build.done', (e) => this.enqueue(`image:${e.image}`, () => this.deliverBuild(e)));
    bus.on('quadlet.create', (e) => this.enqueue(`quadlet:${e.file}`, () => this.writeQuadlet(e)));
    bus.on('systemd.daemon-reload', (e) => {
      for (const g of e.generated) this.enqueue(`quadlet:${g.quadlet}`, () => this.generateUnit(g.quadlet, g.unit));
    });
    bus.on('volume.create', (e) => this.enqueue(`volume:${e.name}`, () => this.buildLocker(e)));
    bus.on('volume.remove', (e) => this.enqueue(`volume:${e.name}`, () => this.removeLocker(e.name)));
    bus.on('container.create', (e) => {
      this.names.set(e.id, e.name);
      this.enqueue(this.site(e.id), () => this.buildFactory(e));
    });
    bus.on('container.start', (e) => this.enqueue(this.site(e.id), () => this.startFactory(e.id, e.restart)));
    bus.on('container.stop', (e) => this.enqueue(this.site(e.id), () => this.abandonFactory(e.id, false)));
    bus.on('container.exit', (e) =>
      this.enqueue(this.site(e.id), () =>
        this.factories.get(e.id)?.restartAlways
          ? this.awaitRestart(e.id)
          : this.factories.get(e.id)?.oneOff && e.code === 0
            ? this.finishOneOff(e.id)
            : this.abandonFactory(e.id, e.code !== 0),
      ),
    );
    bus.on('network.request', (e) => this.enqueue(this.site(e.from), () => this.sendRequest(e)));
    bus.on('container.remove', (e) => this.enqueue(this.site(e.id), () => this.demolishFactory(e.id)));
    bus.on('network.create', (e) => this.enqueue(`network:${e.name}`, () => this.buildBelt(e)));
    bus.on('network.connect', (e) =>
      this.enqueue(this.site(e.container), async () => {
        await this.connectNetwork(e);
        await this.expose(e);
      }),
    );
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
    this.layerArcs = new ArcLayer(this.root, this.tw);
    for (const m of [this.names, this.plots, this.factories, this.manifests, this.imageSlots, this.imageStored, this.imageLayers, this.crates, this.lockers, this.hostPaths, this.cargo, this.locks, this.spotRelease, this.belts, this.builds, this.quadlets, this.units, this.trafficPaths])
      m.clear();
    this.selectedImage = null;
    this.crateCount = 0;
    this.restCranes();
  }

  /** Cranes are part of the static city: put them back in their idle pose and drop anything they hold. */
  private restCranes(): void {
    for (const spec of [...pullCranes, ...buildCranes, { name: 'crane:unpack' }]) {
      const crane = this.scene.getObjectByName(spec.name);
      if (!crane) continue;
      const slew = crane.getObjectByName('slew');
      if (slew && 'from' in spec) slew.rotation.y = craneYaw(spec, spec.from);
      const hoist = crane.getObjectByName('hoist')!;
      this.setHoist(hoist, HOIST_REST);
      const hook = hoist.getObjectByName('hook')!;
      for (const load of hook.children.filter((c) => c.name !== 'block')) this.dispose(load);
    }
    const truck = this.scene.getObjectByName('truck:deploy');
    if (truck) {
      truck.position.set(truckBay.x, 0.3, truckBay.z);
      truck.rotation.set(0, 0, 0);
      for (const load of truck.children.filter((c) => c.name === 'rootfs' || c.userData.entity)) this.dispose(load); // copy, env cards
    }
  }

  /** Resolves when every queued choreography has finished. */
  async idle(): Promise<void> {
    await Promise.all(this.queues.values());
  }

  get isIdle(): boolean {
    return this.busy === 0;
  }

  /** Per-frame ambient motion that is not part of any choreography: belt slats. */
  update(now: number): void {
    const m = new THREE.Matrix4();
    for (const belt of this.belts.values()) {
      const offset = (now * BELT_SPEED) % SLAT_SPACING;
      for (let i = 0; i < belt.slats.count; i++) {
        belt.slats.setMatrixAt(i, m.makeTranslation(-belt.length / 2 + offset + i * SLAT_SPACING, BELT_HEIGHT + 0.08, 0));
      }
      belt.slats.instanceMatrix.needsUpdate = true;
    }
    this.updateTraffic(now);
  }

  /**
   * Cosmetic traffic: crates shuttle both ways between every pair of running
   * containers on the same network, feeder -> belt -> feeder. Positions are a
   * pure function of time, so pausing, replays and fast-forward need no state.
   */
  private updateTraffic(now: number): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const y = 0.3 + BELT_HEIGHT + 0.3;
    for (const [network, belt] of this.belts) {
      const members = [...this.factories.entries()].filter(([, f]) => f.running && f.networks.has(network));
      let n = 0;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const sampler = this.trafficPath(network, belt, members[i]!, members[j]!);
          const per = Math.max(1, Math.floor(sampler.length / TRAFFIC_GAP));
          for (let k = 0; k < per; k++) {
            const d = (now * TRAFFIC_SPEED + (k * sampler.length) / per) % sampler.length;
            for (const [dist, lane] of [[d, 0.45], [sampler.length - d, -0.45]] as const) {
              if (n >= TRAFFIC_MAX) break;
              const p = sampler.at(dist);
              // Two lanes side by side: requests on one, replies on the other.
              pos.set(p.x + Math.sin(p.yaw) * lane, y, p.z + Math.cos(p.yaw) * lane);
              belt.traffic.setMatrixAt(n++, m.compose(pos, q.setFromAxisAngle(up, p.yaw), one));
            }
          }
        }
      }
      belt.traffic.count = n;
      belt.traffic.instanceMatrix.needsUpdate = true;
    }
  }

  /** Crates currently shown on a network (after the last update). */
  trafficCount(network: string): number {
    return this.belts.get(network)?.traffic.count ?? 0;
  }

  private trafficPath(network: string, belt: Belt, [a, fa]: [string, Factory], [b, fb]: [string, Factory]) {
    const key = `${network}|${a}|${b}`;
    let sampler = this.trafficPaths.get(key);
    if (!sampler) {
      const beltZ = { z: belt.group.position.z + BELT_WIDTH / 2 };
      sampler = pathSampler([...feederRoute(fa.slot, beltZ), ...[...feederRoute(fb.slot, beltZ)].reverse()]);
      this.trafficPaths.set(key, sampler);
    }
    return sampler;
  }

  /**
   * Select an entity (null clears): highlight its arcs and dim the rest.
   * Selecting an image also draws arcs from its manifest board to each of
   * its layer crates, including shared layers another image brought in.
   */
  select(key: string | null): void {
    this.arcs.highlight(key);
    const image = [...this.manifests.keys()].find((ref) => keys.image(ref) === key) ?? null;
    if (image === this.selectedImage) return;
    if (this.selectedImage) void this.layerArcs.disconnect(keys.image(this.selectedImage));
    this.selectedImage = image;
    if (!image) return;

    this.layerArcs.highlight(keys.image(image));
    const from = this.imageTop(image)!;
    for (const layer of this.imageLayers.get(image) ?? []) {
      const crate = this.crates.get(layer);
      if (!crate) continue; // not shelved yet
      const to = crate.position.clone().setY(crate.position.y + 1.3);
      void this.layerArcs.connect(keys.image(image), keys.layer(layer), from, to, imageColor(image));
    }
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

  /** The image arrives at the quay as a shipping container and is craned, leg by leg, to the warehouse. */
  private async pullArrives(e: EventOf<'image.pull.start'>): Promise<void> {
    const releaseQuay = await this.acquire(spotKey(pullWaypoints[0]!));
    const cargo = this.makeCargo(e.image, pullWaypoints[0]!);
    this.reserveImage(e.image, e.layers);
    await this.popIn(cargo);
    this.spotRelease.set(e.image, await this.relay(cargo, pullWaypoints, pullCranes, releaseQuay));
    await this.openCargo(cargo);
  }

  /** Shipping container in the image's color with a liftable lid (no label, not tagged). */
  private makeShell(ref: string): THREE.Group {
    const shell = new THREE.Group();
    const body = this.mesh(imageColor(ref));
    body.name = 'shell';
    body.scale.set(CARGO.l, CARGO.h - 0.15, CARGO.w);
    body.position.y = -0.075;
    const lid = this.mesh(imageColor(ref));
    lid.name = 'lid';
    lid.scale.set(CARGO.l, 0.15, CARGO.w);
    lid.position.y = CARGO.h / 2 - 0.075;
    shell.add(body, lid);
    return shell;
  }

  /** The image as a labelled shipping container; layer crates travel inside, and it is kept in the warehouse afterwards. */
  private makeCargo(ref: string, [x, z]: [number, number]): THREE.Group {
    const cargo = this.makeShell(ref);
    cargo.position.set(x, 0.3 + CARGO.h / 2, z);
    const label = makeLabel(shortRef(ref));
    label.position.y = CARGO.h / 2 + 1;
    cargo.add(label);
    tag(cargo, { key: `cargo:${ref}`, kind: 'image pull', name: `${shortRef(ref)} · in transit` });
    this.root.add(cargo);
    this.cargo.set(ref, cargo);
    return cargo;
  }

  private async popIn(obj: THREE.Object3D): Promise<void> {
    await this.tw.tween({ duration: 0.5, ease: ease.outBack, update: (k) => obj.scale.setScalar(Math.max(k, 0.01)) });
  }

  /**
   * Hand a container from crane to crane along `waypoints`. Each drop-off spot
   * and crane takes one container at a time, so overlapping deliveries queue
   * instead of stacking. Returns the release of the final (unpacking) spot.
   */
  private async relay(cargo: THREE.Group, waypoints: [number, number][], cranes: CraneSpec[], releaseStart: () => void): Promise<() => void> {
    let releaseSpot = releaseStart;
    for (const [i, spec] of cranes.entries()) {
      const releaseNext = await this.acquire(spotKey(waypoints[i + 1]!));
      const releaseCrane = await this.acquire(spec.name);
      await this.craneLift(spec, cargo);
      releaseCrane();
      releaseSpot();
      releaseSpot = releaseNext;
    }
    return releaseSpot;
  }

  /** Swing to the pick-up point, hook the container, lift, swing to the drop-off point, set it down. */
  private async craneLift(spec: CraneSpec, cargo: THREE.Group): Promise<void> {
    const crane = this.scene.getObjectByName(spec.name);
    const slew = crane?.getObjectByName('slew');
    const hoist = slew?.getObjectByName('hoist');
    if (slew && hoist) {
      const hook = hoist.getObjectByName('hook')!;
      const pick = CRANE_HEIGHT - CARGO.h - 0.3; // hook block resting on the container roof
      await this.slewTo(slew, craneYaw(spec, spec.from), 1);
      await this.hoistTo(hoist, pick, 1);
      hook.attach(cargo);
      await this.hoistTo(hoist, HOIST_CARRY, 1);
      await this.slewTo(slew, craneYaw(spec, spec.to), 2.4);
      await this.hoistTo(hoist, pick, 1);
      this.root.attach(cargo);
      void this.hoistTo(hoist, HOIST_REST, 0.8);
    }
    // Snap exactly onto the drop-off point (also the whole move when there is no city, as in tests).
    cargo.position.set(spec.to[0], 0.3 + CARGO.h / 2, spec.to[1]);
  }

  /** The unpacking gantry lifts the lid off; layer crates can then come out. */
  private async openCargo(cargo: THREE.Group): Promise<void> {
    const hoist = this.scene.getObjectByName('crane:unpack')?.getObjectByName('hoist');
    const lid = cargo.getObjectByName('lid')!;
    if (!hoist) return;
    await this.hoistTo(hoist, UNPACK_GANTRY_HEIGHT - CARGO.h - 0.3, 0.6);
    hoist.getObjectByName('hook')!.attach(lid);
    await this.hoistTo(hoist, HOIST_REST, 0.6);
  }

  /** The gantry puts the lid back on. */
  private async closeCargo(cargo: THREE.Group): Promise<void> {
    const hoist = this.scene.getObjectByName('crane:unpack')?.getObjectByName('hoist');
    const lid = hoist?.getObjectByName('lid');
    if (!hoist || !lid) return;
    await this.hoistTo(hoist, UNPACK_GANTRY_HEIGHT - CARGO.h - 0.3, 0.6);
    cargo.attach(lid);
    void this.hoistTo(hoist, HOIST_REST, 0.6);
  }

  /** Reserve the image's place in the warehouse row and remember its layers. */
  private reserveImage(ref: string, layers: string[]): void {
    if (!this.imageSlots.has(ref)) this.imageSlots.set(ref, this.imageSlots.size);
    this.imageLayers.set(ref, [...layers]);
  }

  /**
   * The unpacked container is kept: it moves into its place in the warehouse
   * row and from now on stands for the image itself.
   */
  private async storeImage(ref: string, cargo: THREE.Group): Promise<void> {
    const slot = manifestSlot(this.imageSlots.get(ref) ?? this.imageSlots.size);
    const from = cargo.position.clone();
    const to = new THREE.Vector3(slot.x, 0.3 + CARGO.h / 2, slot.z);
    const yaw0 = cargo.rotation.y;
    const yaw1 = Math.PI / 2; // lengthwise north-south, side by side along the row
    const turn = THREE.MathUtils.euclideanModulo(yaw1 - yaw0 + Math.PI, Math.PI * 2) - Math.PI;
    await this.tw.tween({
      duration: 1.2,
      update: (k) => {
        cargo.position.lerpVectors(from, to, k);
        cargo.position.y += Math.sin(k * Math.PI) * 3;
        cargo.rotation.y = yaw0 + turn * k;
      },
    });
    tag(cargo, { key: keys.image(ref), kind: 'image', name: shortRef(ref) });
    // Neighbours in the row stagger their labels so the names do not overlap.
    const label = cargo.children.find((c) => c instanceof CSS2DObject);
    if (label) label.position.y = CARGO.h / 2 + 1 + ((this.imageSlots.get(ref) ?? 0) % 2) * 1.6;
    this.manifests.set(ref, cargo);
    this.cargo.delete(ref);
    this.imageStored.get(ref)?.resolve();
  }

  private expectImage(ref: string): void {
    if (this.imageStored.has(ref)) return;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    this.imageStored.set(ref, { done, resolve });
  }

  /** Resolves once the image's container is in the warehouse (immediately for images never pulled or built). */
  private whenImage(ref: string): Promise<void> {
    return this.imageStored.get(ref)?.done ?? Promise.resolve();
  }

  /** Point just above an image's container, where its arcs start. */
  private imageTop(ref: string): THREE.Vector3 | undefined {
    return this.manifests.get(ref)?.position.clone().setY(0.3 + CARGO.h + 0.5);
  }

  private async slewTo(slew: THREE.Object3D, yaw: number, duration: number): Promise<void> {
    const from = slew.rotation.y;
    const delta = THREE.MathUtils.euclideanModulo(yaw - from + Math.PI, Math.PI * 2) - Math.PI; // shortest way round
    await this.tw.tween({ duration, update: (k) => (slew.rotation.y = from + delta * k) });
  }

  private async hoistTo(hoist: THREE.Object3D, length: number, duration: number): Promise<void> {
    const from = hoist.getObjectByName('cable')!.scale.y;
    await this.tw.tween({ duration, update: (k) => this.setHoist(hoist, from + (length - from) * k) });
  }

  private setHoist(hoist: THREE.Object3D, length: number): void {
    const cable = hoist.getObjectByName('cable')!;
    cable.scale.y = length;
    cable.position.y = -length / 2;
    hoist.getObjectByName('hook')!.position.y = -length;
  }

  /** Simple FIFO lock; resolves with the function that releases it. */
  private acquire(name: string): Promise<() => void> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    this.locks.set(name, prev.then(() => held));
    return prev.then(() => release);
  }

  // --- Image build: R&D department ------------------------------------------

  /** The Containerfile is pinned up in R&D; FROM resolves to the local base image, whose crates flash. */
  private async writeContainerfile(e: EventOf<'image.build.start'>): Promise<void> {
    this.builds.set(e.image, { base: e.base, crates: [] });
    await this.pinDocument(rndLab().board, e.containerfile, {
      key: keys.build(e.image),
      kind: 'containerfile',
      name: `Containerfile · ${shortRef(e.image)}`,
    });

    await this.whenImage(e.base);
    const reused = (this.imageLayers.get(e.base) ?? []).flatMap((l) => this.crates.get(l) ?? []);
    const base = this.manifests.get(e.base)?.getObjectByName('shell');
    await Promise.all([...reused.map((c) => this.flash(c)), ...(base instanceof THREE.Mesh ? [this.flash(base)] : [])]);
  }

  /** A text document (Containerfile, unit file) pinned on a board, its text floating above. */
  private async pinDocument(at: { x: number; z: number }, lines: string[], info: EntityInfo): Promise<THREE.Group> {
    const sheet = new THREE.Group();
    sheet.position.set(at.x, 0.3, at.z);
    const paper = this.mesh(palette.card);
    paper.scale.set(3, 4, 0.2);
    paper.position.y = 2.6;
    const post = this.mesh(palette.bars);
    post.scale.set(0.3, 0.6, 0.3);
    post.position.y = 0.3;
    sheet.add(paper, post);
    const text = makeLabel(lines.join('\n'), 'label containerfile');
    text.position.set(0, 5, 0); // just above the paper, below the district label
    sheet.add(text);
    tag(sheet, info);
    this.root.add(sheet);
    await this.tw.tween({ duration: 0.8, ease: ease.outBack, update: (k) => sheet.scale.setScalar(Math.max(k, 0.01)) });
    return sheet;
  }

  /** A layer-creating instruction (COPY, RUN) commits a new crate on the lab bench. */
  private async commitLayer(e: EventOf<'image.build.layer'>): Promise<void> {
    const build = this.builds.get(e.image);
    if (!build) return;
    const { building } = rndLab();
    const slot = labBenchSlot(build.crates.length);
    const crate = this.mesh(imageColor(e.image));
    crate.scale.setScalar(2.4);
    tag(crate, { key: keys.layer(e.layer), kind: 'layer', name: `${e.layer} · ${shortRef(e.image)} · ${e.instruction}` });
    this.root.add(crate);
    this.crates.set(e.layer, crate);
    build.crates.push(crate);
    await this.hop(crate, new THREE.Vector3(building.x, 3, building.z), new THREE.Vector3(slot.x, 1.5, slot.z), 0.9, 3);
  }

  /** The new crates are packed into a container at R&D, craned to the warehouse and unpacked onto the shelves. */
  private async deliverBuild(e: EventOf<'image.build.done'>): Promise<void> {
    const build = this.builds.get(e.image);
    if (!build) return;
    const releaseYard = await this.acquire(spotKey(buildWaypoints[0]!));
    const cargo = this.makeCargo(e.image, buildWaypoints[0]!);
    this.reserveImage(e.image, e.layers);
    const lid = cargo.getObjectByName('lid')!;
    await this.popIn(cargo);

    // Lid up, crates in, lid down.
    await this.tw.tween({ duration: 0.4, update: (k) => (lid.position.y = CARGO.h / 2 - 0.075 + 2.5 * k) });
    await Promise.all(
      build.crates.map(async (crate, i) => {
        const to = cargo.position.clone().add(new THREE.Vector3(-1.4 + i * 2.8, 0, 0));
        await this.hop(crate, crate.position.clone(), to, 0.6, 3, i * 0.15);
        crate.scale.setScalar(2.2);
        cargo.attach(crate);
      }),
    );
    await this.tw.tween({ duration: 0.4, update: (k) => (lid.position.y = CARGO.h / 2 - 0.075 + 2.5 * (1 - k)) });

    const releaseUnpack = await this.relay(cargo, buildWaypoints, buildCranes, releaseYard);
    await this.openCargo(cargo);
    await Promise.all(
      build.crates.map(async (crate, i) => {
        this.root.attach(crate);
        crate.rotation.set(0, 0, 0);
        const slot = shelfSlot(this.crateCount++);
        await this.hop(crate, crate.position.clone(), new THREE.Vector3(slot.x, slot.y + 1.2, slot.z), 0.8, 4, i * 0.2);
        crate.scale.setScalar(2.4);
      }),
    );
    await this.closeCargo(cargo);
    await this.storeImage(e.image, cargo);
    releaseUnpack();
    const from = this.imageTop(build.base);
    if (from) await this.arcs.connect(keys.image(build.base), keys.image(e.image), from, this.imageTop(e.image)!, imageColor(build.base));
    this.builds.delete(e.image);
  }

  private async shelveLayer(e: EventOf<'image.layer.done'>): Promise<void> {
    if (e.cached) {
      // Layer already in local storage: flash the existing crate instead.
      // A shared layer keeps the color of the image that first brought it.
      const crate = this.crates.get(e.layer);
      if (crate) await this.flash(crate);
      return;
    }
    const cargo = this.cargo.get(e.image);
    const slot = shelfSlot(this.crateCount++);
    const crate = this.mesh(imageColor(e.image));
    crate.scale.setScalar(2.2);
    const from = cargo ? cargo.position.clone() : new THREE.Vector3(slot.x, 6, slot.z);
    crate.position.copy(from);
    tag(crate, { key: keys.layer(e.layer), kind: 'layer', name: `${e.layer} · ${shortRef(e.image)}` });
    this.root.add(crate);
    this.crates.set(e.layer, crate);
    // Out of the open container, onto the shelf.
    await this.hop(crate, from, new THREE.Vector3(slot.x, slot.y + 1.2, slot.z), 0.8, 4);
    crate.scale.setScalar(2.4);
  }

  /** All layers are shelved: close the container and keep it in the warehouse row, freeing the unpacking spot. */
  private async pullDone(e: EventOf<'image.pull.done'>): Promise<void> {
    const cargo = this.cargo.get(e.image);
    if (cargo) {
      await this.closeCargo(cargo);
      await this.storeImage(e.image, cargo);
    }
    this.spotRelease.get(e.image)?.();
    this.spotRelease.delete(e.image);
  }

  // --- Quadlet: unit files for systemd --------------------------------------

  /** The unit file is pinned up in the Quadlet department, with an arc from the image it runs. */
  private async writeQuadlet(e: EventOf<'quadlet.create'>): Promise<void> {
    const sheet = await this.pinDocument(quadletOffice().board, [`# ${e.path}`, ...e.lines], {
      key: keys.quadlet(e.file),
      kind: 'quadlet',
      name: e.file,
    });
    this.quadlets.set(e.file, sheet);
    await this.whenImage(e.image);
    const from = this.imageTop(e.image);
    if (from) await this.arcs.connect(keys.image(e.image), keys.quadlet(e.file), from, sheet.position.clone().setY(5), imageColor(e.image));
  }

  /**
   * daemon-reload: a copy of the unit file travels the service road through
   * the wall gate to systemd, whose generator turns it into a .service plate.
   */
  private async generateUnit(file: string, unit: string): Promise<void> {
    const sheet = this.quadlets.get(file);
    if (!sheet) return;
    const courier = this.mesh(palette.card);
    courier.scale.set(1.4, 0.3, 1.8);
    const [sx, sz] = quadletRoute[0]!;
    courier.position.set(sx, 1.2, sz);
    this.root.add(courier);
    await this.ride(courier, smoothPath(quadletRoute), 3.5);
    this.dispose(courier);

    const slot = unitPlateSlot(this.units.size);
    const plate = this.mesh(palette.running);
    plate.scale.set(4, 1.4, 0.3);
    plate.position.set(slot.x, slot.y, slot.z);
    const label = makeLabel(unit);
    label.position.set(0, 0, -1);
    plate.add(label);
    tag(plate, { key: keys.unit(unit), kind: 'systemd', name: `${unit} · generated from ${file}` });
    this.root.add(plate);
    this.units.set(unit, plate);
    await this.tw.tween({ duration: 0.6, ease: ease.outBack, update: (k) => plate.scale.set(4, 1.4 * Math.max(k, 0.01), 0.3) });
    await Promise.all([
      this.flash(plate),
      this.arcs.connect(keys.quadlet(file), keys.unit(unit), sheet.position.clone().setY(5), plate.position.clone(), palette.tower),
    ]);
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
  /** A host path is a small two-storey office building on the far side of the host highway. */
  private async ensureHostPath(path: string): Promise<THREE.Group> {
    const existing = this.hostPaths.get(path);
    if (existing) return existing;
    const slot = hostPathSlot(this.hostPaths.size);
    const office = new THREE.Group();
    office.position.set(slot.x, 0.3, slot.z);
    const body = this.mesh(palette.building);
    body.scale.set(OFFICE.w, OFFICE.h, OFFICE.d);
    body.position.y = OFFICE.h / 2;
    const roof = this.mesh(palette.hostPath);
    roof.scale.set(OFFICE.w + 0.3, 0.4, OFFICE.d + 0.3);
    roof.position.y = OFFICE.h + 0.2;
    const unit = this.mesh(palette.stopped); // rooftop plant
    unit.scale.set(1.4, 0.8, 1.2);
    unit.position.set(1, OFFICE.h + 0.8, -1);
    const door = this.mesh(palette.hostPath);
    door.scale.set(1.1, 1.8, 0.1);
    door.position.set(0, 0.9, -OFFICE.d / 2 - 0.05); // faces the highway (north)
    office.add(body, roof, unit, door);
    // Two floors of windows on every side.
    for (let floor = 0; floor < 2; floor++)
      for (const side of [0, 1, 2, 3])
        for (const across of [-1.2, 1.2]) {
          if (floor === 0 && side === 0 && Math.abs(across) < 2) continue; // ground floor front: the door
          const win = this.mesh(palette.water);
          const along = side % 2 === 0;
          win.scale.set(along ? 1.1 : 0.08, 1, along ? 0.08 : 1.1);
          const out = (side < 2 ? -1 : 1) * ((along ? OFFICE.d : OFFICE.w) / 2 + 0.04);
          win.position.set(along ? across : out, 1.6 + floor * 2.4, along ? out : across);
          office.add(win);
        }
    const label = makeLabel(path);
    label.position.y = OFFICE.h + 2;
    office.add(label);
    tag(office, { key: keys.hostPath(path), kind: 'host path', name: path });
    this.root.add(office);
    this.hostPaths.set(path, office);
    await this.tw.tween({ duration: 1, ease: ease.outBack, update: (k) => office.scale.set(1, Math.max(k, 0.01), 1) });
    return office;
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
            const to = shed.position.clone().setY(OFFICE.h + 1);
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
    await this.whenImage(e.image); // the image's container must be in the warehouse to be copied
    const group = new THREE.Group();
    group.position.set(slot.x, 0.3, slot.z);

    const body = this.mesh(palette.building);
    body.name = 'body';
    group.add(body);
    const stack = this.mesh(palette.stopped);
    stack.name = 'stack';
    stack.scale.set(0.7, 3, 0.7);
    stack.position.set(0, FACTORY_SIZE.y + 1.5, -FACTORY_SIZE.z / 2 + 1.2); // at the rear of the roof
    group.add(stack);
    const boards = this.makeBoards();
    group.add(boards);
    const baseLabel = `${e.name} (${e.id})${e.autoRemove ? ' · --rm' : ''}${e.restart ? ' · --restart=always' : ''}`;
    const label = makeLabel(baseLabel);
    label.position.set(0, FACTORY_SIZE.y + 4, 0);
    group.add(label);
    if (e.autoRemove) {
      // One-off: a cyan band (ephemeral, like tmpfs scratch) round the top marks it as temporary.
      const band = this.mesh(palette.scratch);
      band.scale.set(FACTORY_SIZE.x + 0.1, 0.4, FACTORY_SIZE.z + 0.1);
      band.position.y = FACTORY_SIZE.y - 0.3;
      band.visible = false; // shown once the body has risen
      band.name = 'band';
      group.add(band);
    }
    tag(group, { key: keys.container(e.id), kind: 'container', name: `${e.name} · ${e.id}` });

    this.root.add(group);
    const factory: Factory = {
      name: e.name,
      group,
      slot,
      cards: [],
      extras: [],
      oneOff: !!e.autoRemove,
      restartAlways: e.restart === 'always',
      restarts: 0,
      label,
      baseLabel,
      running: false,
      networks: new Set(),
    };
    this.factories.set(e.id, factory);
    // A copy of the image's container (the warehouse keeps the original) is trucked to the plot
    // and unloaded there; the factory rises around it. With env vars, the truck first collects
    // their feedback cards at the Demo Shopping Center.
    const image = this.manifests.get(e.image);
    if (image) {
      const copy = this.makeShell(e.image);
      copy.name = 'rootfs';
      copy.position.copy(image.position);
      copy.rotation.copy(image.rotation);
      this.root.add(copy);
      await this.truckToPlot(copy, factory, e.env.length ? () => this.makeCards(e, factory) : undefined);
      group.attach(copy);
    }
    await this.rise(body, FACTORY_SIZE, 0);
    const band = group.getObjectByName('band');
    if (band) band.visible = true;

    const roof = new THREE.Vector3(slot.x, FACTORY_SIZE.y + 0.5, slot.z);
    const links: Promise<void>[] = [this.deliverFeedback(e, factory), this.connectStorage(e.id, factory, e.mounts)];
    const from = this.imageTop(e.image);
    if (from) links.push(this.arcs.connect(keys.image(e.image), keys.container(e.id), from, roof, imageColor(e.image)));
    await Promise.all(links);
  }

  /**
   * The deploy truck loads `copy` at its bay, drives to the plot, unloads it
   * onto the plot and heads back. One truck: deliveries queue for it.
   */
  private async truckToPlot(copy: THREE.Group, factory: Factory, pickup?: () => THREE.Mesh[]): Promise<void> {
    const slot = factory.slot;
    const onPlot = new THREE.Vector3(slot.x, 0.3 + CARGO.h / 2, slot.z);
    const truck = this.scene.getObjectByName('truck:deploy');
    if (!truck) {
      copy.position.copy(onPlot); // no city (tests): just place it
      copy.rotation.set(0, Math.PI / 2, 0);
      return;
    }
    const release = await this.acquire('truck:deploy');
    const route = deployRoute(slot);
    const bed = new THREE.Vector3(TRUCK_BED.x, TRUCK_BED.top + CARGO.h / 2, 0);

    // Load: the copy hops out of the warehouse row onto the flatbed.
    await this.placeOn(copy, truck.localToWorld(bed.clone()), truck.rotation.y, 1);
    truck.attach(copy);
    copy.position.copy(bed);
    copy.rotation.set(0, 0, 0);

    let cards: THREE.Mesh[] = [];
    if (pickup) {
      // Detour via the Demo Shopping Center: env cards hop onto the container roof.
      await this.ride(truck, shopRoute(), 3);
      cards = pickup();
      await Promise.all(
        cards.map(async (card, i) => {
          const onRoof = new THREE.Vector3(TRUCK_BED.x - 2.2 + (i % 4) * 1.5, TRUCK_BED.top + CARGO.h + 0.1 + Math.floor(i / 4) * 0.2, 0);
          await this.hop(card, card.position.clone(), truck.localToWorld(onRoof.clone()), 0.8, 4, i * 0.15);
          truck.attach(card);
          card.rotation.set(0, 0, 0);
        }),
      );
      const onward = shopToPlotRoute(slot);
      await this.turnTo(truck, pathSampler(onward).at(0).yaw, 0.5);
      await this.ride(truck, onward, 3.5);
    } else {
      await this.ride(truck, route, 3);
    }

    // Unload onto the plot, lengthwise north-south like the factory that will rise around it;
    // the cards queue at the door until the container starts.
    this.root.attach(copy);
    await Promise.all([
      this.placeOn(copy, onPlot, Math.PI / 2, 0.8, 2),
      ...cards.map(async (card, i) => {
        this.root.attach(card);
        const q = doorQueueSlot(slot, i);
        await this.hop(card, card.position.clone(), new THREE.Vector3(q.x, 0.45, q.z), 0.6, 2, 0.3 + i * 0.12);
        card.rotation.set(0, 0, 0);
      }),
    ]);

    // Turn round and drive back to the bay; the factory carries on without waiting.
    void (async () => {
      const back = [...route].reverse();
      await this.turnTo(truck, pathSampler(back).at(0).yaw, 0.5);
      await this.ride(truck, back, 2.5);
      await this.turnTo(truck, 0, 0.5); // parked facing east, ready for the next load
      release();
    })();
  }

  private async turnTo(obj: THREE.Object3D, yaw: number, duration: number): Promise<void> {
    const yaw0 = obj.rotation.y;
    const turn = THREE.MathUtils.euclideanModulo(yaw - yaw0 + Math.PI, Math.PI * 2) - Math.PI;
    await this.tw.tween({ duration, update: (k) => (obj.rotation.y = yaw0 + turn * k) });
  }

  /** Lift `obj` in an arc to `to`, turning it to `yaw` on the way. */
  private async placeOn(obj: THREE.Object3D, to: THREE.Vector3, yaw: number, duration: number, height = 4): Promise<void> {
    const from = obj.position.clone();
    const yaw0 = obj.rotation.y;
    const turn = THREE.MathUtils.euclideanModulo(yaw - yaw0 + Math.PI, Math.PI * 2) - Math.PI;
    await this.tw.tween({
      duration,
      update: (k) => {
        obj.position.lerpVectors(from, to, k);
        obj.position.y += Math.sin(k * Math.PI) * height;
        obj.rotation.y = yaw0 + turn * k;
      },
    });
  }

  /** Crossed planks over the front wall, hidden until the building is abandoned. */
  private makeBoards(): THREE.Group {
    const boards = new THREE.Group();
    boards.name = 'boards';
    const diagonal = Math.atan2(FACTORY_SIZE.y, FACTORY_SIZE.x);
    for (const angle of [diagonal, -diagonal]) {
      const plank = this.mesh(palette.boards);
      plank.scale.set(Math.hypot(FACTORY_SIZE.x, FACTORY_SIZE.y) * 0.85, 0.4, 0.15);
      plank.rotation.z = angle;
      boards.add(plank);
    }
    boards.position.set(0, FACTORY_SIZE.y / 2, FACTORY_SIZE.z / 2 + 0.15);
    boards.visible = false;
    return boards;
  }

  /** Env vars arrive from the Demo Shopping Center as feedback cards and queue at the door. */
  /** One feedback card per env var, waiting at the Demo Shopping Center. */
  private makeCards(e: EventOf<'container.create'>, factory: Factory): THREE.Mesh[] {
    const sc = districts.shoppingCenter;
    return e.env.map((env) => {
      const card = this.mesh(env.secret ? palette.secret : palette.card);
      card.scale.set(1.2, 0.15, 0.9);
      card.position.set(sc.x, 4, sc.z);
      tag(card, { key: keys.env(e.id, env.name), kind: env.secret ? 'secret' : 'env var', name: env.name });
      this.root.add(card);
      factory.cards.push(card);
      return card;
    });
  }

  /** Env cards not brought by the truck (no city, or no image to deploy) fly straight to the door queue. */
  private async deliverFeedback(e: EventOf<'container.create'>, factory: Factory): Promise<void> {
    if (factory.cards.length) return; // already delivered by the deploy truck
    const cards = this.makeCards(e, factory);
    await Promise.all(
      cards.map((card, i) => {
        const q = doorQueueSlot(factory.slot, i);
        return this.hop(card, card.position.clone(), new THREE.Vector3(q.x, 0.45, q.z), 1.6, 10, i * 0.25);
      }),
    );
  }

  private async startFactory(id: string, restart = false): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    if (restart) {
      // Started again by the restart policy: count it on the label.
      f.restarts++;
      f.label.element.textContent = `${f.baseLabel} · ↻ ${f.restarts}`;
    }
    // Feedback is processed at start: cards go in and are pinned to the front (door) wall, two per row.
    const wall = f.slot.z + FACTORY_SIZE.z / 2 + 0.1;
    const waiting = f.cards.filter((c) => c.parent !== f.group);
    await Promise.all(
      waiting.map(async (card, i) => {
        const from = card.position.clone();
        const to = new THREE.Vector3(f.slot.x - 0.8 + (i % 2) * 1.6, 0.9 + Math.floor(i / 2) * 1.0, wall);
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
    await Promise.all([
      this.recolor(this.part(f, 'body'), palette.building),
      this.recolor(this.part(f, 'stack'), palette.running),
      ...this.feeders(f).map((m) => this.recolor(m, palette.network)),
    ]);
    f.running = true;
  }

  /** Stopped or exited: the building stays, dark and boarded up, no green stack. */
  private async abandonFactory(id: string, failed: boolean): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    f.running = false;
    await Promise.all([
      this.recolor(this.part(f, 'body'), palette.abandoned),
      this.recolor(this.part(f, 'stack'), failed ? palette.error : palette.abandoned),
      ...this.feeders(f).map((m) => this.recolor(m, palette.abandoned)), // no network namespace while down
    ]);
    const boards = this.part(f, 'boards')!;
    boards.visible = true;
    await this.tw.tween({ duration: 0.4, ease: ease.outBack, update: (k) => boards.scale.setScalar(Math.max(k, 0.01)) });
  }

  /**
   * Exited under --restart=always: not abandoned, just between runs. The stack
   * and feeders go amber until podman starts it again.
   */
  private async awaitRestart(id: string): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    f.running = false;
    const stack = this.part(f, 'stack');
    if (stack) await this.flash(stack);
    await Promise.all([this.recolor(stack, palette.network), ...this.feeders(f).map((m) => this.recolor(m, palette.abandoned))]);
  }

  /** A one-off that succeeded: lights go out and the stack flashes once; --rm removes it next. */
  private async finishOneOff(id: string): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    f.running = false;
    const stack = this.part(f, 'stack');
    if (stack) await this.flash(stack);
    await Promise.all([this.recolor(stack, palette.stopped), ...this.feeders(f).map((m) => this.recolor(m, palette.abandoned))]);
  }

  /** A packet travels from one container's feeder, along the network belt, to another's and back. */
  private async sendRequest(e: EventOf<'network.request'>): Promise<void> {
    const from = this.factories.get(e.from);
    const to = this.factories.get(e.to);
    const belt = this.belts.get(e.network);
    if (!from || !to || !belt) return;
    const beltZ = { z: belt.group.position.z + BELT_WIDTH / 2 };
    const path: [number, number][] = [...feederRoute(from.slot, beltZ), ...[...feederRoute(to.slot, beltZ)].reverse()];
    const packet = this.mesh(palette.network);
    packet.scale.setScalar(0.8);
    packet.position.y = BELT_HEIGHT + 0.5;
    const label = makeLabel(e.label);
    label.position.y = 2.5; // packet is scaled 0.8, so this sits ~2 above it
    packet.add(label);
    this.root.add(packet);
    await this.ride(packet, path, 3);
    await this.flash(this.part(to, 'body')!);
    label.removeFromParent(); // the reply carries no caption
    await this.ride(packet, [...path].reverse(), 2.5);
    await this.vanish(packet);
  }

  private async demolishFactory(id: string): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    f.running = false;
    for (const key of this.trafficPaths.keys()) if (key.split('|').includes(id)) this.trafficPaths.delete(key);
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

  // --- Network: conveyor belts ----------------------------------------------

  /** `podman network create`: a belt unrolls along the north edge of the factory district. */
  private async buildBelt(e: EventOf<'network.create'>): Promise<void> {
    const lane = networkBelt(this.belts.size);
    const group = new THREE.Group();
    group.position.set(lane.x, 0.3, lane.z);

    const frame = this.mesh(palette.bars);
    frame.scale.set(lane.length, BELT_HEIGHT - 0.2, BELT_WIDTH - 0.2);
    frame.position.y = (BELT_HEIGHT - 0.2) / 2;
    const rubber = this.mesh(palette.road);
    rubber.scale.set(lane.length, 0.2, BELT_WIDTH);
    rubber.position.y = BELT_HEIGHT - 0.1;
    group.add(frame, rubber);
    for (const end of [-1, 1]) {
      const roller = new THREE.Mesh(
        new THREE.CylinderGeometry(BELT_HEIGHT / 2, BELT_HEIGHT / 2, BELT_WIDTH + 0.2, 10),
        new THREE.MeshStandardMaterial({ color: palette.network, flatShading: true }),
      );
      roller.rotation.x = Math.PI / 2;
      roller.position.set((end * lane.length) / 2, BELT_HEIGHT / 2, 0);
      group.add(roller);
    }
    const slats = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.35, 0.06, BELT_WIDTH - 0.1),
      new THREE.MeshStandardMaterial({ color: palette.network, flatShading: true }),
      Math.floor(lane.length / SLAT_SPACING),
    );
    group.add(slats);
    const label = makeLabel(`${e.name} · ${e.subnet}`);
    label.position.set(lane.length / 2 - 6, 3, 0); // east end, clear of factory labels
    group.add(label);
    tag(group, { key: keys.network(e.name), kind: 'network', name: `${e.name} · ${e.driver} ${e.subnet}` });
    this.root.add(group);

    const traffic = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.6, 0.5, 0.6),
      new THREE.MeshStandardMaterial({ color: palette.card, flatShading: true }),
      TRAFFIC_MAX,
    );
    traffic.count = 0;
    traffic.frustumCulled = false; // instances span the whole district, not the base geometry's bounds
    this.root.add(traffic);
    const belt: Belt = { group, slats, length: lane.length, traffic };
    this.belts.set(e.name, belt);
    this.update(0);
    // Unroll from the west end.
    await this.tw.tween({
      duration: 1.5,
      update: (k) => {
        group.scale.x = Math.max(k, 0.001);
        group.position.x = lane.x - (lane.length / 2) * (1 - k);
      },
    });
  }

  /** The started factory is hooked onto the network belt with a feeder belt. */
  private async connectNetwork(e: EventOf<'network.connect'>): Promise<void> {
    const f = this.factories.get(e.container);
    const belt = this.belts.get(e.network);
    if (!f || !belt) return;
    const material = new THREE.MeshStandardMaterial({ color: palette.network, flatShading: true });
    const feeder = new THREE.Group();
    feeder.name = 'feeder';
    tag(feeder, { key: `netlink:${e.container}:${e.network}`, kind: 'network', name: `${e.network} · ${f.name}` });
    this.root.add(feeder);
    f.extras.push(feeder);
    f.networks.add(e.network);

    // Lay each segment from its start point, like a belt being extended.
    const route = feederRoute(f.slot, { z: belt.group.position.z + BELT_WIDTH / 2 });
    for (let i = 0; i < route.length - 1; i++) {
      const [ax, az] = route[i]!;
      const [bx, bz] = route[i + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      const seg = new THREE.Mesh(this.box, material);
      seg.rotation.y = -Math.atan2(bz - az, bx - ax);
      seg.castShadow = true;
      feeder.add(seg);
      await this.tw.tween({
        duration: 0.25 + len * 0.04,
        ease: ease.linear,
        update: (k) => {
          seg.scale.set(Math.max(len * k, 0.01), 0.3, 1);
          seg.position.set(ax + ((bx - ax) * k) / 2, 0.3 + BELT_HEIGHT - 0.15, az + ((bz - az) * k) / 2); // top flush with the belt
        },
      });
    }
    await this.flash(belt.group.children[1] as THREE.Mesh);
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

  /** One mesh per feeder; its segments share the material. */
  private feeders(f: Factory): THREE.Mesh[] {
    return f.extras.flatMap((o) => (o.name === 'feeder' && o.children[0] instanceof THREE.Mesh ? [o.children[0]] : []));
  }

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

  /** Move along a smooth path at constant speed, facing along it, like cargo on a belt. */
  private async ride(obj: THREE.Object3D, path: [number, number][], duration = 4): Promise<void> {
    const sampler = pathSampler(path);
    await this.tw.tween({
      duration,
      ease: ease.linear,
      update: (k) => {
        const p = sampler.at(k * sampler.length);
        obj.position.x = p.x;
        obj.position.z = p.z;
        obj.rotation.y = p.yaw;
      },
    });
  }

  /** Shrink away and remove. */
  private async vanish(obj: THREE.Object3D): Promise<void> {
    const start = obj.scale.clone();
    await this.tw.tween({ duration: 0.5, update: (k) => obj.scale.copy(start).multiplyScalar(Math.max(1 - k, 0.01)) });
    this.dispose(obj);
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

function spotKey([x, z]: [number, number]): string {
  return `spot:${x},${z}`;
}
