/** A screen owns its work. Re-entering the same screen still creates a new owner. */
export class Requests {
  private readonly pending = new Map<string, AbortController>();
  start(key: string): { signal: AbortSignal; current: () => boolean } {
    this.pending.get(key)?.abort();
    const controller = new AbortController();
    this.pending.set(key, controller);
    return { signal: controller.signal, current: () => !controller.signal.aborted };
  }
  cancel(): void {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}
