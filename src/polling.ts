/** Share the in-flight promise, including during startup. Stateful transcript
 * readers must never overlap; only snapshot jobs may opt into stale recovery. */
export function singleFlight(
  task: () => Promise<void>,
  options: { staleMs?: number; onStale?: (ageMs: number) => void } = {},
): () => Promise<void> {
  let active: { startedAt: number; promise: Promise<void> } | undefined;
  return () => {
    const now = Date.now();
    if (active) {
      const age = now - active.startedAt;
      if (age < (options.staleMs ?? Infinity)) return active.promise;
      options.onStale?.(age);
    }
    const flight = { startedAt: now, promise: Promise.resolve() };
    active = flight;
    flight.promise = Promise.resolve().then(task).finally(() => {
      if (active === flight) active = undefined;
    });
    return flight.promise;
  };
}

/** Invalidates a delayed snapshot as soon as a newer collection starts. */
export class SnapshotGeneration {
  private current = 0;

  begin(): () => boolean {
    const generation = ++this.current;
    return () => generation === this.current;
  }
}
