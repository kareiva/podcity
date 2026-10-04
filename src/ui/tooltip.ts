import type { EntityInfo } from '../world/entity';

/** Brief name + type card shown where the user clicked. */
export function createTooltip(root: HTMLElement): { show(info: EntityInfo, x: number, y: number): void; hide(): void } {
  const el = document.createElement('div');
  el.className = 'tooltip';
  el.hidden = true;
  const kind = document.createElement('span');
  kind.className = 'kind';
  const name = document.createElement('span');
  name.className = 'name';
  el.append(kind, name);
  root.append(el);

  return {
    show(info, x, y) {
      kind.textContent = info.kind;
      name.textContent = info.name;
      el.hidden = false;
      const pad = 8;
      const { width, height } = el.getBoundingClientRect();
      el.style.left = `${Math.min(x + 12, innerWidth - width - pad)}px`;
      el.style.top = `${Math.min(y + 12, innerHeight - height - pad)}px`;
    },
    hide() {
      el.hidden = true;
    },
  };
}
