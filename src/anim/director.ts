import * as THREE from 'three';
import type { EventBus } from '../sim/bus';
import type { EventOf, Mount } from '../sim/events';
import type { Tweener } from '../engine/tween';
import { ease } from '../engine/tween';
import { addRoad } from '../world/city';
import { CONVEYOR_TOP } from '../world/conveyor';
import { keys, tag, type EntityInfo } from '../world/entity';
import { makeGate } from '../world/gate';
import { makeLabel } from '../world/label';
import {
  FACTORY,
  districts,
  doorQueueSlot,
  factorySlot,
  feederRoute,
  buildPath,
  hostPathSlot,
  labBenchSlot,
  lockerSlot,
  manifestSlot,
  networkBelt,
  pathSampler,
  pullPath,
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
const SHED_SIZE = new THREE.Vector3(5, 3, 5);
const BELT_HEIGHT = 1.2;
const BELT_WIDTH = 1.6;
const SLAT_SPACING = 1.5;
const BELT_SPEED = 1.2; // metres per simulation second

interface Factory {
  name: string;
  group: THREE.Group;
  slot: { x: number; z: number };
  cards: THREE.Mesh[]; // env var feedback cards, at the door until start
  extras: THREE.Object3D[]; // scene-level parts owned by this factory (roads, gates, feeders)
  oneOff: boolean; // --rm: removed as soon as it exits, never left abandoned
}

/** A network as a conveyor belt; slats move along it to show it carries traffic. */
interface Belt {
  group: THREE.Group;
  slats: THREE.InstancedMesh;
  length: number;
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
  private manifests = new Map<string, THREE.Group>();
  private imageLayers = new Map<string, string[]>(); // image ref -> layer digests
  private selectedImage: string | null = null;
  private crates = new Map<string, THREE.Mesh>();
  private lockers = new Map<string, THREE.Mesh>();
  private hostPaths = new Map<string, THREE.Mesh>();
  private trucks = new Map<string, THREE.Mesh>();
  private belts = new Map<string, Belt>(); // network name -> conveyor
  private quadlets = new Map<string, THREE.Group>(); // quadlet file -> pinned board
  private units = new Map<string, THREE.Mesh>(); // generated systemd unit -> plate on the tower
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

    bus.on('image.pull.start', (e) => this.enqueue(`image:${e.image}`, () => this.truckArrives(e)));
    bus.on('image.layer.done', (e) => this.enqueue(`image:${e.image}`, () => this.shelveLayer(e)));
    bus.on('image.pull.done', (e) => this.enqueue(`image:${e.image}`, () => this.truckLeaves(e)));
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
    bus.on('container.start', (e) => this.enqueue(this.site(e.id), () => this.startFactory(e.id)));
    bus.on('container.stop', (e) => this.enqueue(this.site(e.id), () => this.abandonFactory(e.id, false)));
    bus.on('container.exit', (e) =>
      this.enqueue(this.site(e.id), () =>
        this.factories.get(e.id)?.oneOff && e.code === 0 ? this.finishOneOff(e.id) : this.abandonFactory(e.id, e.code !== 0),
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
    for (const m of [this.names, this.plots, this.factories, this.manifests, this.imageLayers, this.crates, this.lockers, this.hostPaths, this.trucks, this.belts, this.builds, this.quadlets, this.units])
      m.clear();
    this.selectedImage = null;
    this.crateCount = 0;
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
    const from = this.manifests.get(image)!.position.clone().setY(4.5);
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

  private async truckArrives(e: EventOf<'image.pull.start'>): Promise<void> {
    const short = shortRef(e.image);
    const color = imageColor(e.image);
    // A cargo box riding the conveyor from the seaport; crates are unloaded from it at the warehouse.
    const truck = this.mesh(color);
    truck.scale.set(3.6, 1.6, 2.2);
    const [sx, sz] = pullPath[0]!;
    truck.position.set(sx, CONVEYOR_TOP + 0.8, sz);
    truck.add(makeLabel(short));
    tag(truck, { key: `pull:${e.image}`, kind: 'image pull', name: short });
    this.root.add(truck);
    this.trucks.set(e.image, truck);

    await Promise.all([this.ride(truck, pullPath), this.addManifest(e.image, e.layers)]);
  }

  /** Manifest board: the image itself, grouping its layer crates. */
  private async addManifest(ref: string, layers: string[]): Promise<void> {
    const slot = manifestSlot(this.manifests.size);
    const manifest = new THREE.Group();
    manifest.position.set(slot.x, 0.3, slot.z);
    const pole = this.mesh(palette.stopped);
    pole.scale.set(0.3, 3, 0.3);
    pole.position.y = 1.5;
    const board = this.mesh(imageColor(ref));
    board.scale.set(3, 2, 0.3);
    board.position.y = 3.5;
    manifest.add(pole, board);
    tag(manifest, { key: keys.image(ref), kind: 'image', name: shortRef(ref) });
    this.root.add(manifest);
    this.manifests.set(ref, manifest);
    this.imageLayers.set(ref, [...layers]);
    await this.tw.tween({ duration: 0.8, ease: ease.outBack, update: (k) => manifest.scale.setScalar(Math.max(k, 0.01)) });
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

    const reused = (this.imageLayers.get(e.base) ?? []).flatMap((l) => this.crates.get(l) ?? []);
    const manifest = this.manifests.get(e.base);
    const boardMesh = manifest?.children[1];
    await Promise.all([
      ...reused.map((c) => this.flash(c)),
      ...(boardMesh instanceof THREE.Mesh ? [this.flash(boardMesh)] : []),
    ]);
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

  /** A van carries the new crates to the warehouse; the image gets its manifest and a FROM arc to its base. */
  private async deliverBuild(e: EventOf<'image.build.done'>): Promise<void> {
    const build = this.builds.get(e.image);
    if (!build) return;
    // A flat tray riding the conveyor from R&D to the warehouse.
    const van = new THREE.Group();
    const body = this.mesh(imageColor(e.image));
    body.scale.set(4.5, 0.4, 2.2);
    van.add(body);
    const [sx, sz] = buildPath[0]!;
    van.position.set(sx, CONVEYOR_TOP + 0.2, sz);
    tag(van, { key: `build-van:${e.image}`, kind: 'image pull', name: `${shortRef(e.image)} delivery` });
    this.root.add(van);

    // Load the bench crates onto the tray, then ride the belt to the warehouse.
    await Promise.all(
      build.crates.map(async (crate, i) => {
        const to = new THREE.Vector3(sx, CONVEYOR_TOP + 1.4, sz - 1 + i * 2.2);
        await this.hop(crate, crate.position.clone(), to, 0.6, 2, i * 0.15);
        crate.scale.setScalar(2);
        van.attach(crate);
      }),
    );
    await this.ride(van, buildPath);

    await this.addManifest(e.image, e.layers);
    await Promise.all(
      build.crates.map(async (crate, i) => {
        this.root.attach(crate);
        crate.rotation.set(0, 0, 0);
        crate.scale.setScalar(2.4);
        const slot = shelfSlot(this.crateCount++);
        await this.hop(crate, crate.position.clone(), new THREE.Vector3(slot.x, slot.y + 1.2, slot.z), 0.8, 4, i * 0.2);
      }),
    );
    const base = this.manifests.get(build.base);
    const self = this.manifests.get(e.image)!;
    const arc = base
      ? this.arcs.connect(keys.image(build.base), keys.image(e.image), base.position.clone().setY(4.5), self.position.clone().setY(4.5), imageColor(build.base))
      : Promise.resolve();
    await Promise.all([arc, this.vanish(van)]);
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
    await this.vanish(truck); // unloaded at the end of the belt
    this.trucks.delete(e.image);
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
    const manifest = this.manifests.get(e.image);
    if (manifest) {
      const to = sheet.position.clone().setY(5);
      await this.arcs.connect(keys.image(e.image), keys.quadlet(e.file), manifest.position.clone().setY(4.5), to, imageColor(e.image));
    }
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
    plate.scale.set(0.3, 1.4, 4);
    plate.position.set(slot.x, slot.y, slot.z);
    const label = makeLabel(unit);
    label.position.set(1, 0, 0);
    plate.add(label);
    tag(plate, { key: keys.unit(unit), kind: 'systemd', name: `${unit} · generated from ${file}` });
    this.root.add(plate);
    this.units.set(unit, plate);
    await this.tw.tween({ duration: 0.6, ease: ease.outBack, update: (k) => plate.scale.set(0.3, 1.4 * Math.max(k, 0.01), 4) });
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
    stack.scale.set(0.7, 3, 0.7);
    stack.position.set(0, FACTORY_SIZE.y + 1.5, -FACTORY_SIZE.z / 2 + 1.2); // at the rear of the roof
    group.add(stack);
    const boards = this.makeBoards();
    group.add(boards);
    const label = makeLabel(`${e.name} (${e.id})${e.autoRemove ? ' · --rm' : ''}`);
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
    const factory: Factory = { name: e.name, group, slot, cards: [], extras: [], oneOff: !!e.autoRemove };
    this.factories.set(e.id, factory);
    // TODO: unboxing — carry crates from the shelf and stack them as layers.
    await this.rise(body, FACTORY_SIZE, 0);
    const band = group.getObjectByName('band');
    if (band) band.visible = true;

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
  }

  /** Stopped or exited: the building stays, dark and boarded up, no green stack. */
  private async abandonFactory(id: string, failed: boolean): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
    await Promise.all([
      this.recolor(this.part(f, 'body'), palette.abandoned),
      this.recolor(this.part(f, 'stack'), failed ? palette.error : palette.abandoned),
      ...this.feeders(f).map((m) => this.recolor(m, palette.abandoned)), // no network namespace while down
    ]);
    const boards = this.part(f, 'boards')!;
    boards.visible = true;
    await this.tw.tween({ duration: 0.4, ease: ease.outBack, update: (k) => boards.scale.setScalar(Math.max(k, 0.01)) });
  }

  /** A one-off that succeeded: lights go out and the stack flashes once; --rm removes it next. */
  private async finishOneOff(id: string): Promise<void> {
    const f = this.factories.get(id);
    if (!f) return;
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

    const belt: Belt = { group, slats, length: lane.length };
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
          seg.position.set(ax + ((bx - ax) * k) / 2, BELT_HEIGHT - 0.15, az + ((bz - az) * k) / 2);
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
