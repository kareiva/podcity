import type { SimClock } from '../engine/clock';
import type { Player } from '../player';
import type { EventBus } from '../sim/bus';
import type { SimEvent } from '../sim/events';

const SPEEDS = [0.5, 1, 2, 4];

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
  root.append(bar);

  // Steps: click any step to replay it from a clean scene.
  const panel = document.createElement('div');
  panel.className = 'steps';
  const list = document.createElement('ol');
  const summary = document.createElement('p');
  panel.append(list, summary);
  root.append(panel);

  const feed = document.createElement('ol');
  feed.className = 'feed';
  root.append(feed);

  const goTo = (i: number) => {
    feed.replaceChildren();
    void player.goTo(i);
  };

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
    const li = document.createElement('li');
    li.textContent = describe(e);
    feed.prepend(li);
    while (feed.children.length > 12) feed.lastElementChild?.remove();
  });
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function mountFlag(m: Extract<SimEvent, { type: 'container.create' }>['mounts'][number]): string {
  if (m.kind === 'tmpfs') return ` --tmpfs ${m.target}`;
  return ` -v ${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`;
}

/** Human-readable line, roughly the podman command that caused the event. */
function describe(e: SimEvent): string {
  switch (e.type) {
    case 'image.pull.start': return `podman pull ${e.image}`;
    case 'image.layer.done': return `  ${e.cached ? 'Copying blob' : 'Fetched blob'} ${e.layer}${e.cached ? ' skipped: already exists' : ''}`;
    case 'image.pull.done': return `  ${e.image} stored`;
    case 'image.build.start': return `podman build -t ${e.image} -f Containerfile .`;
    case 'image.build.layer': return `  ${e.instruction} --> ${e.layer}`;
    case 'image.build.done': return `  COMMIT ${e.image}`;
    case 'container.create':
      if (e.restart) return `podman run -d --restart=${e.restart} --name ${e.name}${e.mounts.map(mountFlag).join('')}${e.env.map((v) => ` -e ${v.name}`).join('')} ${e.image.split('/').pop()}${e.command ? ` ${e.command}` : ''}`;
      if (e.autoRemove) return `podman run --rm --name ${e.name}${e.mounts.map(mountFlag).join('')}${e.env.map((v) => ` -e ${v.name}`).join('')} ${e.image.split('/').pop()}${e.command ? ` ${e.command}` : ''}`;
      return `podman create --name ${e.name}${e.mounts.map(mountFlag).join('')}${e.env.map((v) => ` -e ${v.name}`).join('')} ${e.image.split('/').pop()}`;
    case 'container.start': return e.restart ? `  ${e.id} restarted (--restart=always)` : `podman start ${e.id}`;
    case 'container.stop': return `podman stop ${e.id}`;
    case 'container.exit': return `  ${e.id} exited (${e.code})${e.reason ? `: ${e.reason}` : ''}`;
    case 'container.remove': return `podman rm -f ${e.id}`;
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
