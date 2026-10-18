// REST response bodies are the state contract. Do not omit fields from comparison.
export function stateSignature(value: unknown): string { return JSON.stringify(value); }

export function createStateRefresh<T>(opts: {
  read: () => Promise<T>;
  apply: (state: T) => void;
  onError: (error: Error | null) => void;
  onSettled: () => void;
  isCurrent: () => boolean;
}) {
  let active = true;
  let dirty = false;
  let running: Promise<void> | null = null;
  let revision = 0;
  const current = () => active && opts.isCurrent();
  const request = (): Promise<void> => {
    if (!current()) return Promise.resolve();
    if (running) { dirty = true; return running; }
    running = (async () => {
      do {
        dirty = false;
        const started = revision;
        try {
          const state = await opts.read();
          if (current() && !dirty && started === revision) {
            opts.apply(state);
            opts.onError(null);
          }
        } catch (error) {
          if (current() && !dirty && started === revision) opts.onError(error instanceof Error ? error : new Error('状态读取失败'));
        }
      } while (dirty && current());
    })().finally(() => {
      running = null;
      if (current()) opts.onSettled();
    });
    return running;
  };
  return {
    request,
    invalidate: () => { revision++; if (running) dirty = true; },
    close: () => { active = false; revision++; },
  };
}
