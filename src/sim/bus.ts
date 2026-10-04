import type { EventOf, SimEvent, SimEventType } from './events';

type Handler<E> = (event: E) => void;

export class EventBus {
  private handlers = new Map<SimEventType | '*', Set<Handler<never>>>();

  on<T extends SimEventType>(type: T, handler: Handler<EventOf<T>>): () => void;
  on(type: '*', handler: Handler<SimEvent>): () => void;
  on(type: SimEventType | '*', handler: Handler<never>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  emit(event: SimEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) (h as Handler<SimEvent>)(event);
    for (const h of this.handlers.get('*') ?? []) (h as Handler<SimEvent>)(event);
  }
}
