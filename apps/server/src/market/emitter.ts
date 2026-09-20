/**
 * A tiny typed event emitter.
 *
 * Node's built-in EventEmitter works, but its event names are strings and its
 * payloads are `any[]`, so nothing stops a typo in an event name or a mismatched
 * payload from compiling. Here the event map is a type parameter, so both are
 * checked.
 *
 * `on` returns an unsubscribe function rather than requiring a matching `off` with
 * the identical function reference. That matters because every listener in this
 * system belongs to a client connection that will eventually disappear, and a
 * subscription that outlives its owner is a memory leak that also keeps
 * serialising frames for a socket nobody is reading.
 */

type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);

    let active = true;
    return () => {
      // Guarded so calling the unsubscribe twice cannot remove a listener that a
      // later subscription happens to have registered.
      if (!active) return;
      active = false;
      set.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy before iterating: a listener is allowed to unsubscribe itself, and
    // mutating a Set while iterating it would skip entries.
    for (const listener of [...set]) {
      (listener as Listener<Events[K]>)(payload);
    }
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
