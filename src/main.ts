import './style.css';
import { Director } from './anim/director';
import { SimClock } from './engine/clock';
import { setupPicking } from './engine/picking';
import { createEngine } from './engine/renderer';
import { Tweener } from './engine/tween';
import { Player } from './player';
import { EventBus } from './sim/bus';
import { defaultSteps } from './sim/scenario';
import { Simulator } from './sim/simulator';
import { mountControls } from './ui/controls';
import { createTooltip } from './ui/tooltip';
import { buildCity } from './world/city';

const app = document.querySelector<HTMLElement>('#app')!;
const ui = document.querySelector<HTMLElement>('#ui')!;

const engine = createEngine(app);
const clock = new SimClock();
const tweener = new Tweener();
const bus = new EventBus();

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reducedMotion) tweener.durationScale = 0.05;

const city = buildCity(engine.scene);
const director = new Director(engine.scene, tweener, bus);
const sim = new Simulator(bus, defaultSteps());
const player = new Player(sim, director, tweener, clock);
mountControls(ui, clock, bus, player, 'simulated');

const tooltip = createTooltip(document.body);
setupPicking(engine, (info, x, y) => {
  if (info) tooltip.show(info, x, y);
  else tooltip.hide();
  director.select(info?.key ?? null);
});

void player.goTo(0);

engine.start((realDt) => {
  clock.tick(realDt);
  player.update(clock.now);
  tweener.update(clock.now);
  if (!reducedMotion) {
    director.update(clock.now);
    city.update(clock.now);
  }
});
