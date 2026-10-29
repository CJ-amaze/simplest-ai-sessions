import { afterEach, describe, expect, it, vi } from 'vitest';
import { singleFlight, SnapshotGeneration } from '../src/polling';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe('polling', () => {
  it('shares startup and periodic reads, even after 60 seconds', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const task = vi.fn(() => pending.promise);
    const run = singleFlight(task);
    const first = run();
    await Promise.resolve();
    vi.advanceTimersByTime(65_000);
    expect(run()).toBe(first);
    expect(task).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;
    await run();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('discards stale mapping results without letting the old completion unlock the new flight', async () => {
    vi.useFakeTimers();
    const pending = [deferred(), deferred()];
    const snapshots = new SnapshotGeneration();
    const applied: number[] = [];
    let calls = 0;
    const run = singleFlight(async () => {
      const id = calls++;
      const isCurrent = snapshots.begin();
      await pending[id].promise;
      if (isCurrent()) applied.push(id);
    }, { staleMs: 60_000 });
    const old = run();
    await Promise.resolve();
    vi.advanceTimersByTime(60_001);
    const current = run();
    await Promise.resolve();
    pending[0].resolve();
    await old;
    expect(applied).toEqual([]);
    expect(run()).toBe(current);
    expect(calls).toBe(2);
    pending[1].resolve();
    await current;
    expect(applied).toEqual([1]);
  });

  it('distinguishes snapshots begun within the same millisecond', () => {
    const snapshots = new SnapshotGeneration();
    const old = snapshots.begin();
    const current = snapshots.begin();
    expect(old()).toBe(false);
    expect(current()).toBe(true);
  });

  it('releases a rejected read so the next interval can recover', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(undefined);
    const run = singleFlight(task);
    await expect(run()).rejects.toThrow('read failed');
    await expect(run()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
