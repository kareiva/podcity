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
| Container registry (registry.access.redhat.com, quay.io, docker.io) | **Seaport** outside the city wall | 95% transparent terminal shed and two ship-to-shore gantry cranes on the quay (not pickable); a container ship idles offshore, bobbing on the sim clock (still under reduced motion) |
| Image pull | **Shipping container** (real ISO 20ft size, image's color) craned port -> warehouse | One tall tower crane (mast inside the wall) lifts it from the quay over the wall straight to the warehouse; one crate per layer inside. Conveyor belts are reserved for networks |
| Image unpacking | **Unpacking gantry** (small crane) in the warehouse | Lifts the container's lid; layer crates hop out onto the shelves; lid goes back on and the empty container is cleared |
| Image layer (content-addressed blob) | **Crate** labelled with short digest | Colored by a hash of the image name, so one image's layers share a unique color. Shared layers are stored once, keep the color of the image that first brought them, and flash when another image reuses them |
| Local image store (`containers/storage`) | **Image Warehouse** | Shelves of crates under a 95% transparent gabled hall (not pickable); image = its shipping container, kept in a row along the warehouse front after unpacking (lid closed, labelled), in the image's color |
| `podman build` + Containerfile | **R&D Department** north of the warehouse | Lab with antenna; the Containerfile is an **advertising stand** (billboard) on the host highway's north roadside, right (east) of the first host-path offices in the next gap between plot columns and facing the highway, wired to R&D by an arc: its blue face shows one tile per instruction, the text only on click (tooltip). `FROM` flashes the base image's crates (reused, not copied) and a copy of the base's container is craned over from the warehouse to the R&D yard as the starting point; each `COPY`/`RUN` commits a new crate (the new image's color) on top of the base copy; the new crates form the new image's container standing on the base copy, which one tall tower crane (between R&D and the warehouse) lifts to the warehouse's unpacking gantry; the base copy left in the yard then explodes; after unpacking the container is kept in the warehouse row as the new image |
| Deploying an image to a container | **Deploy truck**: small container truck parked at a bay between the warehouse and the Factory District (compose brings three more, parked in a **car park** south of the factory hall between the visitor bridge and the Locker Yard). Roads follow its routes: the pickup lane in front of the Environmental Shopping Center, the corridor north between the warehouse and the factories, the bay apron with its link to the corridor, the lane in front of the plot row, the strip behind the factory hall to the Secret Facility, and the car park's exit lane west under the visitor bridge to the corridor | Carries a copy of the image's container to the plot and unloads it; the factory rises around it |
| OCI runtime (crun/runc) | **Construction crew** | Builds a factory from a blueprint |
| Container | **Factory building** shaped like an ISO 20ft shipping container (long side north-south, doors south; the ship's cargo uses the same proportions) in the Factory District, under a 95% transparent sawtooth-roofed hall with a chimney (not pickable) | Green smokestack when running. Stopped or exited containers remain as **abandoned buildings**: weathered, boarded up, no green stack (red stack if exited non-zero) |
| Container rootfs (overlay) | **Unboxing floor** inside factory | Read-only crates stacked (lowerdirs), thin glass floor on top (upperdir) |
| Restart policy (`--restart=always`) | **Factory that restarts in place** | On exit it is not boarded up: stack and feeder go amber until podman starts it again; label shows `--restart=always` and a restart count (`↻ n`) |
| One-off container (`podman run --rm`) | **Temporary factory** with a cyan band round the top and `--rm` in its label | Runs, exits 0, and folds away immediately; never left abandoned. Its image, volumes and host-path offices stay |
| conmon | **Night watchman hut** beside each factory | Holds the logbook (logs) and exit code |
| Namespaces | **Fences** around the factory | Different fence colors per namespace type when inspecting |
| cgroups / resource limits | **Power and water meters** | Gauges for CPU/memory; meter turns red near limit |
| Pod | **Factory campus** | Several factories inside one shared fence |
| Infra container (pause) | **Campus gatehouse** | Owns the campus network address; all factories exit through it |
| Network (netavark bridge) | **Conveyor belt** along the north edge of the Factory District | One belt per network, labelled with name and subnet; two-sided with a rail down the middle, traffic keeping right: the south half's slats run east, the north half's west; each connected factory gets a feeder belt from its east wall (gray while the container is down) |
| DNS (aardvark-dns) | **Signpost office** at network junction | Name -> address lookups shown as sign flashes |
| Port publishing (`-p 8080:8080`) | **Pedestrian visitor bridge** through a **gate in the city wall** | Elevated gray footbridge (only the handrails amber) on piers that always stands in the first plot's column (where `web` is built), from its last pier just outside the Factory District hall, over the wall under a tall gray gate, down a stair to the host highway. Unconnected until a port is published; then a stair kiosk rises on the factory roof, the deck extends from the last pier into the transparent hall to it, the gate is labelled with the port, and visitors walk it while the container runs |
| Rootless networking (pasta) | **Tunnel** under the wall | Used when the user is rootless |
| Named volume | **Storage locker** in the Locker Yard | Yard is secured: barred fence with a single gate. Unused lockers stand in two rows as faint, see-through purple boxes (not pickable); a volume's solid locker rises over a spare in the front row. Survives factory demolition |
| Host (outside the wall) | **Host highway** south of the wall; systemd stands on its north roadside (asphalt plot) | Narrow three-lane asphalt highway with white edge lines and dashed lane markings; published-port visitor bridges end at its edge |
| Bind mount / host path | **Small office building** on the host highway's near (north) roadside, between the wall and the highway, east of systemd and its pavilions, each in the gap between two plot columns so port bridges pass between them (the third and fourth gaps are the Containerfile and compose stands') | Two storeys, blue windows, brown roof, door facing the highway (south); labelled with the path. Arc from factory over the wall; survives factory demolition |
| Scratch space (tmpfs) | **Scratch bin** beside the factory | Ephemeral; demolished with the factory |
| Environment variables | **Customer feedback cards** | Collected by the deploy truck at the Environmental Shopping Center on its way to the plot (they ride on the container roof), dropped at the factory door to queue, and are pinned to the factory wall when it starts; one card per `KEY=value`. Secret-backed vars are gold sealed cards, collected at the Secret Facility |
| Config / mounted config files | **Blueprint binder** delivered with factory | |
| Secrets | **Armored courier + safe** inside factory | Contents never shown, only name and mount target |
| Secret store (`podman secret create`) | **Secret Facility** behind (north of) the Factory District hall | Windowless vault with a gold door facing the hall, reached by the truck road along the strip behind the hall; each secret is a sealed gold plaque by the door (name only). The deploy truck detours up the corridor and along the strip behind the hall to collect sealed cards |
| Quadlet unit files (`.container`) | **Quadlet Department** inside the wall, between the Image Warehouse and the systemd Business Center | Clerk's office (slate roof like systemd); unit files are pinned on a board (newest on top, its text shown). Its road joins the service road and reaches systemd through the wall gate; on daemon-reload each board travels there and a small open **pavilion** (posts, pyramid roof) rises round it, in a row east of the systemd tower on the highway's north roadside. Clicking a pavilion shows the unit file in the tooltip |
| systemd / generated units | **systemd Business Center** on the host highway's north roadside, outside the Podman perimeter (city wall); its road runs north through a gate in the south wall | Office tower: a lobby block plus **one floor per generated service unit** (green `<name>.service` plate on its city-facing wall), so it grows taller as services are added; decides which factories start at boot and restarts failed ones |
| Demo entry point | **Environmental Shopping Center** next to the Quadlet Department, clear of the published-port visitor bridges to the south | Where visitors arrive and see the running app; its front faces south onto the road that comes in through the wall gate from the systemd Business Center |
| `podman compose` (`compose.yaml`) | **Advertising stand** (billboard) on the host highway's north roadside, right (east) of the Containerfile stand in the next gap between plot columns | Billboard on two posts facing the highway, with a catwalk and floodlights; its blue face advertises the stack with one white tile per service, labelled `compose.yaml · <project>`; the compose file's contents are shown only on click (tooltip). `compose up` redeploys every service it lists, with an arc from the stand to each new factory |
| `podman kube generate` + OpenShift | **Freight rail station** to the metropolis | Campus packed into a shipping container, train leaves for the OpenShift metro |

---

## How elements connect

The city is a pipeline. Every visual connection corresponds to a real
dependency in Podman, and the inspector should explain it when clicked.

```
 Seaport (registry)          R&D Department (podman build)
     | pull: a crane lifts a     | build: a crane lifts a container
     | container of layer crates | of new crates; FROM reuses base
     v                           v
 Image Warehouse --blueprint--> Construction crew (crun)
     | crates (read-only lowers)       | builds
     v                                 v
 Factory (container) <-- watchman (conmon)
     |  ^  ^  ^
     |  |  |  +-- feedback cards (env), binder (config), safe (secrets)
     |  |  +----- storage: locker (volume) / host office (bind) / scratch bin (tmpfs)
     |  +-------- meters (cgroups), fences (namespaces)
     v
 Feeder -> Conveyor belt (network) -> Signpost (DNS) -> City gate (published port)
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
  paths (host offices) outlive containers; a new factory reconnects to them.
  Scratch space (tmpfs bins) is demolished with its factory.
- **Stopped is not removed.** A stopped or exited container stays as an
  abandoned building until `podman rm` - unless it was started with `--rm`
  (one-off), which removes it as soon as it exits.
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
- **The Environmental Shopping Center depends on the systemd Business Center.** The
  road between them stands for systemd starting and supervising the
  containers the demo needs.

### Connection arcs

Thin arcs drawn between related objects make dependencies visible without
the user reading the inspector:

| From | To | Meaning |
|---|---|---|
| Image (container in the warehouse row) | Container (factory) | Container was created from this image |
| Base image (container) | Built image (container) | Image was built `FROM` this base |
| Image (container) | Quadlet (unit file board / pavilion) | Quadlet runs this image (`Image=`) |
| Quadlet (pavilion) | Unit (floor plate on systemd tower) | systemd generated this `.service` from the quadlet |
| Compose (advertising stand) | Container | Container was (re)created by `podman compose up` from this file |
| Containerfile (advertising stand) | R&D Department | R&D builds the image from this Containerfile |
| Container | Volume (locker) | Container mounts this volume |
| Container | Host path (office) | Container bind-mounts this host path |
| Image (container, when selected) | Layer (crate on shelf) | Image is made of this layer; shared layers (e.g. UBI base) get an arc from every image that uses them. Drawn only while the image is selected |

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
  | { type: 'image.build.start'; image: string; base: string; containerfile: string[] }
  | { type: 'image.build.stage'; image: string; stage: string; base: string }        // FROM base AS stage
  | { type: 'image.build.layer'; image: string; instruction: string; layer: Digest; stage?: string; from?: string }
  | { type: 'image.build.discard'; image: string; stage: string; layers: Digest[] } // intermediate stage dropped
  | { type: 'image.build.done'; image: string; layers: Digest[] }
  | { type: 'image.build.cached'; image: string; containerfile: string[]; layers: Digest[] } // every step from cache
  | { type: 'container.create'; id: string; image: string; mounts: Mount[]; env: Env[]; autoRemove?: boolean; command?: string; restart?: 'always'; runFor?: number; compose?: string; dependsOn?: string[] }
  | { type: 'container.start'; id: string; restart?: boolean }
  | { type: 'container.stop' | 'container.remove'; id: string }
  | { type: 'container.exit'; id: string; code: number }
  | { type: 'volume.create' | 'volume.remove'; name: string }
  | { type: 'network.connect'; container: string; network: string; ports: Port[] }
  | { type: 'network.request'; from: string; to: string; network: string; label: string }
  | { type: 'pod.create'; id: string; members: string[] }
  | { type: 'kube.generate'; pod: string }
  | { type: 'resource.sample'; id: string; cpu: number; mem: number; memLimit?: number };
```

### Steps

The simulation is split into steps that play in order and can each be
replayed on their own. Replaying step N resets the scene, applies steps
0..N-1 instantly (tweens complete immediately), then plays step N at normal
speed. Autoplay advances to the next step after a short pause. With **Loop**
on (needs autoplay), the last step runs for a while, then every created
object fades out and playback starts again from step 1.

The podman command log overlay (commands typed = stdin in white, podman's
output = stdout in green) shows only the step being played: it is cleared
as each step starts, headed `# n. Title`, and earlier steps applied
instantly on a replay are not logged. To read or copy a step's log, turn
autoplay off so the finished step stays on screen.

| # | Step | What happens |
|---|---|---|
| 1 | Image pull | Red Hat UBI base (`ubi9/ubi`) pulled first; `ubi9/nginx-124` and `ubi9/postgresql-16` are both built on it, so their UBI layer (and the shared `s2i-core` layer) flash "already here" instead of being fetched again |
| 2 | Network | `podman network create backend` (bridge, `10.89.0.0/24`); a conveyor belt unrolls along the north edge of the Factory District |
| 3 | Deploy | `web` and `db` created with `--network backend` and started, each hooked onto the belt by a feeder as it starts; `db` exits (no `POSTGRESQL_*` credentials) and is left abandoned |
| 4 | Environment | Feedback cards (env + secret password) delivered; `db` re-created with them and runs |
| 5 | Expose | `web` re-created with `-p 8080:8080` (UBI nginx listens on 8080, non-root); the visitor bridge, which has ended at its last pier outside the Factory District hall since the start, extends into the hall to `web` and connects to it; visitors walk it while `web` runs |
| 6 | Storage | `pgdata` volume, `/home/user/site` host path and a tmpfs scratch bin; both containers re-created with mounts, keeping env, port and network |
| 7 | Migrate | One-off `db-migrate` from the same `postgresql-16` image: `podman run --rm --network backend -v /home/user/migrations:/migrations:ro` with `PG*` env (password from the secret); a packet travels the belt to `db` (`db-3`, now with its `pgdata` volume) by name, it exits 0 and is auto-removed |
| 8 | Metrics | `metrics-collector` from the plain `ubi9/ubi` image: `podman run -d --restart=always --network backend ubi sh -c 'curl -s http://web:8080/ >/dev/null; sleep 10'`. The workload exits 0 after 10 s and podman starts it again after a 1 s back-off, forever; the simulator (not the script) drives this restart loop |
| 9 | Containerfile | R&D Department writes a Containerfile `FROM ubi9/ubi:latest` with `RUN dnf -y install nginx` and two `COPY` steps; the crane brings a copy of the UBI container to R&D as the base, `podman build` reuses the UBI crate and commits three new ones on top of that copy, they form the `podcity-api` container, the crane delivers it `localhost/podcity-api:1.0` to the warehouse and the UBI copy in the yard explodes; the deploy truck then takes a copy to a new plot and `podcity-api` runs on `backend` |
| 10 | Compose | An advertising stand rises on the host highway's roadside, right of the Containerfile stand, for `~/podcity/compose.yaml`: `db`, `podcity-api`, `web` and `metrics-collector` with the network, volume, secret, port and mounts from the earlier steps (all external resources); `podcity-api`, `web` and `metrics-collector` have `depends_on: [db]`. `podman compose up -d --build --force-recreate` first rebuilds `podcity-api` (its service has `build:`) from step 9's Containerfile: every step hits the build cache, so it is the same `podcity-api:1.0` image (`image.build.cached`), and its container just goes over to R&D and back. Only then are the four old containers removed. The city's deploy truck takes `db` (detouring for its env cards and secret); as soon as it leaves, three extra trucks pop in at the car park, drive to bays beside the main one and load the other three images, wait there until `db` is up, then deliver simultaneously (farthest plot first), each to its old plot, with an arc from the stand, and drive back to the car park |
| 11 | Quadlet | Quadlet Department writes `web.container` (UBI nginx, `8080:8080`, site bind mount, tmpfs), `api.container` (`localhost/podcity-api:1.0`) and `db.container` (postgresql, `pgdata` volume, env + `pgpass` secret) into `~/.config/containers/systemd/`, all on `backend`; on `systemctl --user daemon-reload` they travel one by one to pavilions next to systemd, which generates `web.service`, `api.service` and `db.service`, each adding a floor to the tower |

Mounts, env and published ports are fixed at create time in Podman, so
steps 4, 5, 6 and 10 re-create containers in place (`podman run --replace`: rm + create
on the same plot), rather than changing a running one.

The scenario uses Red Hat UBI images to show layer reuse:

```
ubi9/ubi            [ubi]
ubi9/nginx-124      [ubi][s2i-core][nginx]
ubi9/postgresql-16  [ubi][s2i-core][postgresql][...]
```

The UBI crate keeps the UBI color on the shelf, and arrives once even though
three images reference it.

### Key choreographies

| Event | Sequence |
|---|---|
| Image pull | Container pops up on the quay -> the tall tower crane swings to it, hooks it, lifts it over the wall, swings and sets it down under the unpacking gantry (positions from `layout.ts`: the mast stands so both ends lie on the jib circle, 120 degree swing) -> the unpacking gantry lifts the lid -> new layers hop out onto the shelves, cached layers flash "already here" -> lid back on -> the container hops into its place in the warehouse row and from then on is the image (clickable, arc anchor). The crane and each drop-off spot hold one container at a time, so overlapping pulls queue |
| Image build | Containerfile advertising stand rises on the host roadside beside the host offices and an arc wires it to R&D -> base image crates and container flash (FROM) -> a copy of the base's container hops from the warehouse row to the unpacking spot and the R&D crane lifts it over to the R&D yard -> one crate per COPY/RUN pops out of the lab onto the base copy's roof -> the crates come together and the new image's container forms round them, standing on the base copy -> the R&D crane lifts it off the stack to the unpacking gantry -> the base copy in the yard explodes (fireball and fragments) -> lid off -> crates shelved -> lid on, container joins the warehouse row -> FROM arc drawn from the base image's container |
| Multi-stage build (supported, not in the default scenario) | Containerfile advertising stand replaced (same spot, same arc to R&D), final-stage base crates flash -> `FROM … AS builder`: a copy of the builder base's container hops from the warehouse row to the unpacking spot and the R&D crane lifts it back over to the R&D yard -> builder-stage crates (own color) land on top of it -> `COPY --from=builder`: its last crate flashes and the result hops off it onto the lab bench -> the builder container tips into the skip behind the yard and is gone (its layers are not kept) -> once the builder has left the yard, the final stage's base copy is craned in (as in a single-stage build) -> crates waiting on the bench move onto its roof, the remaining layer lands there too, the new container forms on top and is craned to the warehouse, and the base copy explodes, as usual; crates whose digest is already shelved merge into it and flash, and if the image already stands in the row (same layers) the new container merges into it |
| Cached build (`image.build.cached`) | The Containerfile stand flashes -> the image's own container hops from the warehouse row to the unpacking spot and the R&D crane lifts it to the R&D yard -> its layer crates and container flash (`Using cache`) -> the crane takes it back and it hops into its place in the row. Nothing new is shelved |
| Compose up | Advertising stand pops up right of the Containerfile stand, its face flashes; with `--build`, no container is removed or recreated until every image build in flight is back in the warehouse; three more deploy trucks pop in at their stalls in the car park -> all old factories fold away -> the city's truck takes the service the others `depend_on` (db) -> as soon as it leaves, each car park truck drives out (one at a time through the exit lane) to its bay beside the main one and loads one dependent service's image copy -> they wait, loaded, until db is up, then deliver in parallel -> as each factory rises the board flashes and an arc runs from the stand to it -> the extra trucks drive back to their stalls and stay parked until the scene resets |
| Quadlet + daemon-reload | Unit file board rises in the Quadlet Department (on top of earlier ones), arc from its image -> on reload each board in turn travels the road and service gate to its spot beside the systemd tower, a pavilion rises round it and the board shrinks to a notice board inside (image arc redrawn there) -> the tower's roof lifts and a new floor grows under it with a green `<name>.service` plate on its city-facing wall, arc from the quadlet |
| Container create (env) | The deploy truck, loaded with the image copy, detours to the Environmental Shopping Center: one card per env var hops onto the container roof -> truck drives up the corridor between warehouse and factories to the plot -> copy unloaded, cards hop to the door queue; on start they are pinned to the front wall. Without a truck (tests) cards fly straight to the door |
| Container create | A copy of the image's container hops out of the warehouse row (the original stays) onto the deploy truck at its bay -> (with env vars: via the Environmental Shopping Center for the cards) -> the truck drives along the lane south of the plot row (rounded-corner routes from `layout.ts` that never cut through buildings) -> the copy is unloaded onto the plot -> the factory rises around it while the truck turns and drives back to the bay (one truck: deliveries queue) (the copy stays inside as the rootfs) -> image arc drawn. Planned: crew walks from warehouse with blueprint -> foundation + fences rise -> crates carried in and **unboxed**: lids pop, contents settle as stacked translucent layers -> glass upper floor slides on top -> watchman hut appears |
| Container start | Lights on floor by floor, smokestack starts, meters come alive, driveway opens to the road |
| Network traffic (ambient) | While two or more containers on a network are running, small white crates shuttle both ways between each pair (feeder -> belt -> feeder), each direction on its right-hand half of the belt and feeders. Position is a pure function of the sim clock: pauses with it, needs no state on replay, stops when either side stops |
| Network request | A packet rides from the sender's feeder along the network belt to the receiver's feeder on the right-hand half (caption e.g. `psql -> db:5432`), the receiver flashes, and the packet rides back on the other half |
| Restart (`--restart=always`) | Exit: stack flashes and turns amber, feeder grays, network traffic to it pauses -> after the back-off it starts again: stack green, label counter `↻ n` goes up. The simulator schedules exits (`runFor`) and restarts itself; `begin()` re-arms them after a replay |
| One-off exit (`--rm`, code 0) | Stack flashes once and goes gray, feeder grays; the remove that follows folds it away. A non-zero exit is boarded up like any other |
| Container stop / exit | Building darkens to weathered gray, planks board up the front, stack goes gray (red if non-zero exit); building remains |
| Container remove | Arcs fade, factory folds down with its scratch bins and port bridges; crates, lockers and host offices stay |
| Storage mount | Locker / host office rises if new, arc drawn to it; tmpfs bin rises beside the factory |
| Volume mount (planned) | Pipe extrudes from locker to factory along a curve; flow particles on writes |
| Port publish (expose) | The standing visitor bridge connects to the factory: a stair kiosk rises on the front of its roof, the deck slides north from the bridge's end at its last pier, into the transparent hall, to the kiosk door, and the gate in the wall is labelled `8080 → 8080/tcp`. While the container runs, visitors walk it both ways, keeping right (position a pure function of the sim clock, like network traffic). When the container is removed the kiosk and link fold away with it; the bridge stays. A port on another plot first gets a bridge of its own |
| Network create | Belt unrolls from the west end along the north edge of the Factory District, labelled `name · subnet` |
| Network connect | After the factory starts, a feeder belt extends from its east wall along the gap between plot columns to the network belt; the belt flashes. Feeder goes gray when the container stops or exits |
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
- [x] Thin arc connections: image -> container, container -> volume, image -> layers on select
- [x] Rename City Hall to **Environmental Shopping Center** (was Demo Shopping Center), move it next to the city
      wall, and add a **systemd Business Center** connected to it by road
- [x] Environment variables as customer feedback cards processed in the
      factory district
- [x] Layer crates colored per image (name hash)
- [x] Stopped containers remain as abandoned buildings
- [x] Secured Locker Yard (barred fence, single gate)
- [x] Three storage types: volumes, host paths, scratch space (tmpfs)
- [x] systemd Business Center moved outside the Podman perimeter
- [x] Simulation split into replayable steps: pull, network, deploy, env, expose, storage, migrate, metrics, Containerfile, Compose, quadlet
- [x] Networks as conveyor belts in the Factory District; containers hooked on at start
- [x] R&D Department: Containerfile + `podman build` delivering a custom image
- [x] Quadlet Department: `web`, `api` and `db` `.container` unit files, deployed as pavilions beside systemd; each generated `.service` adds a tower floor
- [x] One-off `db-migrate` container (`--rm`) from the db image, talking to `db` over the belt
- [x] `metrics-collector` from the UBI image with `--restart=always`, restarting every 10 s
- [x] Compose: `compose.yaml` advertising stand that redeploys db first, then web, api and metrics (`depends_on`), from a car park of extra trucks
- [ ] Container unboxing (crates from shelf stacked as layers)
- [ ] Pod campus and OpenShift shipping choreographies
- [ ] Full inspector and guided tour
- [ ] Live mode via the Podman REST API proxy
