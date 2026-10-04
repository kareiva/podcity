# podcity

Explorable 3d factory where buildings represent Podman container internals and shows their interaction.

Inspired by https://github.com/NikolayS/pgsimcity

Image pull displayed as cargo delivery

Container unboxing animated

Volumes and host paths as storage lockers for persistence

Network as roads between factories

Display secrets and configurations, environment variables

Connection to wider metropolitan area is OpenShift - pack containers to pods and ship out

---

## Technology

Follow the pgsimcity approach unless there is a reason not to.

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | No `any` in `sim/` |
| Build | Vite | Static build, deployable as plain files |
| Runtime | Node.js >= 22 for tooling only | The app runs entirely in the browser |
| 3D | three.js | The only heavy runtime dependency. No React/R3F |
| Tweening | Own small tween/timeline module in `engine/` | Avoid GSAP; keeps animation deterministic and testable |
| UI overlays | Plain DOM + CSS over the canvas | Inspector, legend, tour, controls |
| Tests | Vitest for `sim/` and `world/layout` | Simulation must be testable without WebGL |

### Source layout

```
src/
  sim/            Podman model: state + event bus. MUST NOT import three.js
  world/          City geometry. layout.ts is the single source of truth for positions
  anim/           Choreographies: turn sim events into timed visual sequences
  engine/         Renderer, camera, picking, instancing, tween clock, audio
  ui/             Inspector panel, legend, guided tour, speed controls, search
  live/           Optional adapter to a real Podman (see Data sources)
  player.ts       Step playback and replay (resets director, fast-forwards sim)
```

Dependency direction is one-way: `sim` <- `anim` <- `world`/`engine` <- `ui`.
`sim` knows nothing about rendering; `world` never mutates sim state.

### Data sources

1. **Simulated (default).** `sim/` runs a scripted, seeded scenario split into
   steps (see Steps below). Timing is slowed down and sizes scaled so it is
   watchable.
2. **Live (optional).** `live/` reads from the Podman REST API (`podman system
   service`) and `podman events --format json`. Browsers cannot reach the unix
   socket, so a tiny local proxy (`tools/podcity-proxy`) exposes it over HTTP/SSE.
   Live events are translated into the same sim event types, so the rendering
   code is identical in both modes. The UI must label which mode is active.

---

## City map: Podman concept -> building

| Podman concept | City element | Visual cues |
|---|---|---|
| Container registry (quay.io, docker.io) | **Seaport** outside the city wall | Cargo ships, cranes |
| Image pull | **Cargo truck** driving port -> warehouse | One crate per layer |
| Image layer (content-addressed blob) | **Crate** labelled with short digest | Colored by a hash of the image name, so one image's layers share a unique color. Shared layers are stored once, keep the color of the image that first brought them, and flash when another image reuses them |
| Local image store (`containers/storage`) | **Image Warehouse** | Shelves of crates; image = manifest board in the image's color |
| OCI runtime (crun/runc) | **Construction crew** | Builds a factory from a blueprint |
| Container | **Factory building** | Green smokestack when running. Stopped or exited containers remain as **abandoned buildings**: weathered, boarded up, no green stack (red stack if exited non-zero) |
| Container rootfs (overlay) | **Unboxing floor** inside factory | Read-only crates stacked (lowerdirs), thin glass floor on top (upperdir) |
| conmon | **Night watchman hut** beside each factory | Holds the logbook (logs) and exit code |
| Namespaces | **Fences** around the factory | Different fence colors per namespace type when inspecting |
| cgroups / resource limits | **Power and water meters** | Gauges for CPU/memory; meter turns red near limit |
| Pod | **Factory campus** | Several factories inside one shared fence |
| Infra container (pause) | **Campus gatehouse** | Owns the campus network address; all factories exit through it |
| Network (netavark bridge) | **Road network** | Ring road per network, factories connected by driveways |
| DNS (aardvark-dns) | **Signpost office** at network junction | Name -> address lookups shown as sign flashes |
| Port publishing (`-p 8080:80`) | **Gate in city wall** | Numbered gate with road to the factory door |
| Rootless networking (pasta) | **Tunnel** under the wall | Used when the user is rootless |
| Named volume | **Storage locker** in the Locker Yard | Yard is secured: barred fence with a single gate. Survives factory demolition |
| Bind mount / host path | **Shed on the host land** beyond the wall | Arc from factory over the wall; survives factory demolition |
| Scratch space (tmpfs) | **Scratch bin** beside the factory | Ephemeral; demolished with the factory |
| Environment variables | **Customer feedback cards** | Fly in from the Demo Shopping Center, queue at the factory door, and are pinned to the factory wall when it starts; one card per `KEY=value`. Secret-backed vars are gold sealed cards |
| Config / mounted config files | **Blueprint binder** delivered with factory | |
| Secrets | **Armored courier + safe** inside factory | Contents never shown, only name and mount target |
| systemd / Quadlet units | **systemd Business Center** on host land, outside the Podman perimeter (city wall) | Office tower holding the unit files; decides which factories start at boot and restarts failed ones |
| Demo entry point | **Demo Shopping Center** near the city wall | Where visitors arrive and see the running app; connected by a road through a wall gate to the systemd Business Center |
| `podman kube generate` + OpenShift | **Freight rail station** to the metropolis | Campus packed into a shipping container, train leaves for the OpenShift metro |

---

## How elements connect

The city is a pipeline. Every visual connection corresponds to a real
dependency in Podman, and the inspector should explain it when clicked.

```
 Seaport (registry)
     | pull: truck carries layer crates
     v
 Image Warehouse --blueprint--> Construction crew (crun)
     | crates (read-only lowers)       | builds
     v                                 v
 Factory (container) <-- watchman (conmon)
     |  ^  ^  ^
     |  |  |  +-- feedback cards (env), binder (config), safe (secrets)
     |  |  +----- storage: locker (volume) / host shed (bind) / scratch bin (tmpfs)
     |  +-------- meters (cgroups), fences (namespaces)
     v
 Driveway -> Road (network) -> Signpost (DNS) -> City gate (published port)
     |
 grouped into Campus (pod) behind Gatehouse (infra container)
     |
 Freight station -> OpenShift metropolis (kube YAML, deploy)
```

Rules that the scene must respect:

- **Images are shared, containers are not.** Two factories from the same image
  reference the same warehouse shelf; delete a factory and the crates stay.
  Removing an image with live containers is refused (show a red stamp).
- **Three kinds of storage, three lifetimes.** Volumes (lockers) and host
  paths (sheds) outlive containers; a new factory reconnects to them.
  Scratch space (tmpfs bins) is demolished with its factory.
- **Stopped is not removed.** A stopped or exited container stays as an
  abandoned building until `podman rm`.
- **systemd is the host's, not Podman's.** The Business Center sits outside
  the wall; its road enters the city through a gate.
- **Pod members share the network.** Factories in a campus have no own
  driveway; all traffic exits via the gatehouse. Inside the campus they talk
  over `localhost` (short internal walkway).
- **Writes go to the top layer only.** Changes inside a running factory appear
  on the glass upper floor, never on the warehouse crates.
- **Secrets never render content.** Only name, target, and access event.
- **Environment is fixed at create time.** Feedback cards are processed when
  the factory starts; changing them means building a new factory, not
  editing a running one.
- **The Demo Shopping Center depends on the systemd Business Center.** The
  road between them stands for systemd starting and supervising the
  containers the demo needs.

### Connection arcs

Thin arcs drawn between related objects make dependencies visible without
the user reading the inspector:

| From | To | Meaning |
|---|---|---|
| Image (manifest on warehouse shelf) | Container (factory) | Container was created from this image |
| Container | Volume (locker) | Container mounts this volume |
| Container | Host path (shed) | Container bind-mounts this host path |

- Arcs are thin, slightly raised curves (quadratic bezier over the ground),
  colored by the source's semantic color, with a direction cue (arrowhead or
  dash flow toward the target).
- Created and removed by the same choreographies as the objects they link;
  an arc fades out when either end is removed.
- Hovering or selecting an object highlights its arcs and dims the rest.

---

## Animation

### Event-driven choreography

`sim/` emits typed events on a bus; `anim/` maps each event to a
**choreography** (a timeline of tweens). Events, not per-frame polling, drive
everything, so live mode and simulated mode behave the same.

```ts
type SimEvent =
  | { type: 'image.pull.start'; image: string; layers: Digest[] }
  | { type: 'image.layer.done'; image: string; layer: Digest; cached: boolean }
  | { type: 'container.create'; id: string; image: string; mounts: Mount[]; env: Env[] }
  | { type: 'container.start' | 'container.stop' | 'container.remove'; id: string }
  | { type: 'container.exit'; id: string; code: number }
  | { type: 'volume.create' | 'volume.remove'; name: string }
  | { type: 'network.connect'; container: string; network: string; ports: Port[] }
  | { type: 'pod.create'; id: string; members: string[] }
  | { type: 'kube.generate'; pod: string }
  | { type: 'resource.sample'; id: string; cpu: number; mem: number; memLimit?: number };
```

### Steps

The simulation is split into steps that play in order and can each be
replayed on their own. Replaying step N resets the scene, applies steps
0..N-1 instantly (tweens complete immediately), then plays step N at normal
speed. Autoplay advances to the next step after a short pause.

| # | Step | What happens |
|---|---|---|
| 1 | Image pull | nginx and postgres pulled; shared base layer fetched once |
| 2 | Deploy | `web` and `db` created and started; `db` exits (no password) and is left abandoned |
| 3 | Storage | `pgdata` volume, `/home/user/site` host path and a tmpfs scratch bin; containers re-created with mounts |
| 4 | Environment | Feedback cards (env + secret password) delivered; `db` re-created with them and runs |
| 5 | Expose | `web` re-created with `-p 8080:80`; road from factory through a wall gate to the host |

Mounts, env and published ports are fixed at create time in Podman, so
steps 3-5 re-create containers in place (`podman run --replace`: rm + create
on the same plot), rather than changing a running one.

### Key choreographies

| Event | Sequence |
|---|---|
| Image pull | Ship docks -> crane unloads crates -> truck drives highway (path along road spline) -> cached layers flash "already here" and are skipped -> crates shelved -> manifest clipboard pins them together |
| Container create (env) | Feedback cards travel into the factory district and queue at the factory door; on start they are fed into the factory |
| Container create | Crew walks from warehouse with blueprint -> foundation + fences rise -> crates carried in and **unboxed**: lids pop, contents settle as stacked translucent layers -> glass upper floor slides on top -> watchman hut appears |
| Container start | Lights on floor by floor, smokestack starts, meters come alive, driveway opens to the road |
| Container stop / exit | Building darkens to weathered gray, planks board up the front, stack goes gray (red if non-zero exit); building remains |
| Container remove | Arcs fade, factory folds down with its scratch bins and port roads; crates, lockers and host sheds stay |
| Storage mount | Locker / host shed rises if new, arc drawn to it; tmpfs bin rises beside the factory |
| Volume mount (planned) | Pipe extrudes from locker to factory along a curve; flow particles on writes |
| Port publish (expose) | Amber road paves from the factory door south to the host land; gate rises in the wall labelled `8080 → 80/tcp` |
| Network connect (planned) | Driveway paves to ring road; packets as small vans |
| Pod create | Shared fence draws around members, gatehouse rises, member driveways merge into one |
| Kube generate / ship | Campus lifts onto flatbed, shrink-wraps into a shipping container, drives to freight station, train departs to the metropolis skyline |

### Engine rules

- One `requestAnimationFrame` loop in `engine/`; a global **sim clock** with
  speed control (pause, 0.5x, 1x, 4x) that scales all tweens.
- Choreographies are queued per entity so overlapping events don't fight
  (a stop arriving during a start finishes start first, then plays stop).
- Use `InstancedMesh` for repeated items (crates, vans, particles, lights).
  Target 60 fps with ~200 containers.
- Low-poly, flat-shaded geometry generated in code; no large model assets.
- Consistent color semantics: images/layers = blue, running = green,
  stopped = gray, error = red, network = amber, storage = purple, secrets = gold.
- Camera: orbit + WASD fly.
- **Clickable objects.** Every object that stands for a Podman entity can be
  clicked (raycast picking). The first click shows a very brief tooltip with
  just **name** and **type** (container, image, layer, volume, pod, network,
  env var, secret, unit). A "more" action focuses the camera and opens the
  full inspector, which shows the real Podman command and data behind it
  (e.g. `podman inspect` fields, mount table, env list with secret values
  redacted).
- Respect `prefers-reduced-motion`: replace movement with fades.

### Guided tour

A scripted walkthrough of the default scenario, one step per concept, with
the camera flying to each district and a short caption explaining the real
Podman behavior being shown.

---

## Roadmap

Planned, not yet implemented. Do not start these until confirmed.

- [x] Clickable objects with a brief name + type tooltip ("more" / inspector pending)
- [x] Thin arc connections: image -> container, container -> volume
- [x] Rename City Hall to **Demo Shopping Center**, move it next to the city
      wall, and add a **systemd Business Center** connected to it by road
- [x] Environment variables as customer feedback cards processed in the
      factory district
- [x] Layer crates colored per image (name hash)
- [x] Stopped containers remain as abandoned buildings
- [x] Secured Locker Yard (barred fence, single gate)
- [x] Three storage types: volumes, host paths, scratch space (tmpfs)
- [x] systemd Business Center moved outside the Podman perimeter
- [x] Simulation split into replayable steps: pull, deploy, storage, env, expose
- [ ] Container unboxing (crates from shelf stacked as layers)
- [ ] Network, pod campus and OpenShift shipping choreographies
- [ ] Full inspector and guided tour
- [ ] Live mode via the Podman REST API proxy
