import type { SimClock } from '../engine/clock';
import type { Player } from '../player';
import type { EventBus } from '../sim/bus';
import type { EnvVar, SimEvent } from '../sim/events';

const SPEEDS = [0.5, 1, 2, 4];
/** Lines kept in the command log; older ones scroll away. */
const FEED_LINES = 500;

export function mountControls(root: HTMLElement, clock: SimClock, bus: EventBus, player: Player, mode: 'simulated' | 'live'): void {
  const bar = document.createElement('div');
  bar.className = 'controls';

  const badge = document.createElement('span');
  badge.className = `mode ${mode}`;
  badge.textContent = mode === 'live' ? 'LIVE podman' : 'Simulated';
  bar.append(badge);

  const pause = button('Pause', () => {
    clock.paused = !clock.paused;
    pause.textContent = clock.paused ? 'Play' : 'Pause';
  });
  bar.append(pause);

  const speedButtons = SPEEDS.map((s) =>
    button(`${s}×`, () => {
      clock.speed = s;
      speedButtons.forEach((b, i) => b.classList.toggle('active', SPEEDS[i] === s));
    }),
  );
  speedButtons[SPEEDS.indexOf(clock.speed)]?.classList.add('active');
  bar.append(...speedButtons);

  const auto = document.createElement('label');
  const autoBox = document.createElement('input');
  autoBox.type = 'checkbox';
  autoBox.checked = player.autoplay;
  autoBox.addEventListener('change', () => (player.autoplay = autoBox.checked));
  auto.append(autoBox, ' Autoplay');
  bar.append(auto);

  const loop = document.createElement('label');
  const loopBox = document.createElement('input');
  loopBox.type = 'checkbox';
  loopBox.checked = player.loop;
  loopBox.addEventListener('change', () => (player.loop = loopBox.checked));
  loop.append(loopBox, ' Loop');
  loop.title = 'After the last step, fade the city out and start again from step 1';
  bar.append(loop);
  const syncLoop = () => (loopBox.disabled = !autoBox.checked);
  autoBox.addEventListener('change', syncLoop);
  syncLoop();
  root.append(bar);

  // Steps: click any step to replay it from a clean scene.
  const panel = document.createElement('div');
  panel.className = 'steps';
  const list = document.createElement('ol');
  const summary = document.createElement('p');
  panel.append(list, summary);
  root.append(panel);

  // Terminal-style log of the current step only: cleared as each step starts (turn autoplay off to keep a
  // finished step's log on screen). Oldest first, scrollable, follows new lines unless scrolled back.
  const feed = document.createElement('ol');
  feed.className = 'feed';
  feed.setAttribute('aria-label', 'podman command log');
  root.append(feed);

  const goTo = (i: number) => void player.goTo(i);

  player.onStep((i) => {
    const title = document.createElement('li');
    title.className = 'comment';
    title.textContent = `# ${i + 1}. ${player.steps[i]?.title ?? ''}`;
    feed.replaceChildren(title);
    feed.scrollTop = 0;
  });

  const stepButtons = player.steps.map((s, i) => {
    const li = document.createElement('li');
    const b = button(`${i + 1}. ${s.title}`, () => goTo(i));
    b.title = 'Replay this step';
    li.append(b);
    list.append(li);
    return b;
  });

  const nextButton = button('Next ▶', () => goTo(player.current + 1));
  nextButton.className = 'next';
  panel.append(nextButton);

  const render = () => {
    const cur = player.current;
    stepButtons.forEach((b, i) => {
      b.classList.toggle('active', i === cur);
      b.classList.toggle('done', i < cur || (i === cur && player.stepFinished));
    });
    summary.textContent = player.steps[cur]?.summary ?? '';
    nextButton.hidden = !player.stepFinished || cur >= player.steps.length - 1 || player.autoplay;
  };
  player.onChange(render);
  autoBox.addEventListener('change', render);

  bus.on('*', (e) => {
    if (player.fastForwarding) return; // earlier steps replayed instantly: not this step's log
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24;
    const line = describe(e);
    // Indented lines are what podman prints (stdout); the rest are commands typed in (stdin).
    const output = line.startsWith('  ');
    const li = document.createElement('li');
    li.className = output ? 'stdout' : 'stdin';
    li.textContent = output ? line.trimStart() : line;
    feed.append(li);
    while (feed.children.length > FEED_LINES) feed.firstElementChild?.remove();
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  });
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** `-e NAME`, or `--secret` for a value that comes from a podman secret. */
function envFlag(v: EnvVar): string {
  return v.secretName ? ` --secret ${v.secretName},type=env,target=${v.name}` : ` -e ${v.name}`;
}

function mountFlag(m: Extract<SimEvent, { type: 'container.create' }>['mounts'][number]): string {
  if (m.kind === 'tmpfs') return ` --tmpfs ${m.target}`;
  return ` -v ${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`;
}

/** `--network`, `-p`, mounts and env, in the order podman's docs usually show them. */
function createFlags(e: Extract<SimEvent, { type: 'container.create' }>): string {
  const network = e.network ? ` --network ${e.network}` : '';
  const ports = (e.ports ?? []).map((p) => ` -p ${p.host}:${p.container}${p.protocol === 'udp' ? '/udp' : ''}`).join('');
  return `${network}${ports}${e.mounts.map(mountFlag).join('')}${e.env.map(envFlag).join('')}`;
}

/** Human-readable line, roughly the podman command that caused the event. */
function describe(e: SimEvent): string {
  switch (e.type) {
    case 'image.pull.start': return `podman pull ${e.image}`;
    case 'image.layer.done': return `  ${e.cached ? 'Copying blob' : 'Fetched blob'} ${e.layer}${e.cached ? ' skipped: already exists' : ''}`;
    case 'image.pull.done': return `  ${e.image} stored`;
    case 'image.build.start': return `podman build -t ${e.image} -f Containerfile .`;
    case 'image.build.stage': return `  [${e.stage}] FROM ${e.base} AS ${e.stage}`;
    case 'image.build.layer': return `  ${e.stage ? `[${e.stage}] ` : ''}${e.instruction} --> ${e.layer}`;
    case 'image.build.discard': return `  [${e.stage}] intermediate stage removed`;
    case 'image.build.done': return `  COMMIT ${e.image}`;
    case 'compose.up': return `podman compose -f ${e.path} up -d --build --force-recreate  # ${e.services.join(', ')}`;
    case 'container.create':
      if (e.compose) return `  [${e.compose}] recreate ${e.name}`;
      if (e.restart) return `podman run -d --restart=${e.restart} --name ${e.name}${createFlags(e)} ${e.image.split('/').pop()}${e.command ? ` ${e.command}` : ''}`;
      if (e.autoRemove) return `podman run --rm --name ${e.name}${createFlags(e)} ${e.image.split('/').pop()}${e.command ? ` ${e.command}` : ''}`;
      return `podman create --name ${e.name}${createFlags(e)} ${e.image.split('/').pop()}`;
    case 'container.start': return e.restart ? `  ${e.id} restarted (--restart=always)` : `podman start ${e.id}`;
    case 'container.stop': return `podman stop ${e.id}`;
    case 'container.exit': return `  ${e.id} exited (${e.code})${e.reason ? `: ${e.reason}` : ''}`;
    case 'container.remove': return `podman rm -f ${e.id}`;
    case 'secret.create': return `podman secret create ${e.name} -   # value from stdin, never shown`;
    case 'volume.create': return `podman volume create ${e.name}`;
    case 'volume.remove': return `podman volume rm ${e.name}`;
    case 'network.create': return `podman network create --driver ${e.driver} --subnet ${e.subnet} ${e.name}`;
    case 'network.connect': return `  ${e.container} on ${e.network} ${e.ports.map((p) => `${p.host}->${p.container}/${p.protocol}`).join(' ')}`;
    case 'quadlet.create': return `cat > ${e.path}`;
    case 'systemd.daemon-reload': return `systemctl --user daemon-reload  # ${e.generated.map((g) => `${g.quadlet} -> ${g.unit}`).join(', ')}`;
    case 'network.request': return `  ${e.from} -> ${e.to} on ${e.network}: ${e.label}`;
    case 'pod.create': return `podman pod create --name ${e.name}`;
    case 'kube.generate': return `podman kube generate ${e.pod}`;
    case 'resource.sample': return `  ${e.id} cpu ${(e.cpu * 100).toFixed(0)}%`;
  }
}
