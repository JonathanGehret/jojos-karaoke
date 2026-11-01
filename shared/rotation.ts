// Fair queue rotation: round-robin by singer, so one person can't fill the queue.

export interface QueueEntry { id: string; memberId: string }

/** Where to insert a new entry for `memberId`, given the queue (excluding the song now
 * playing). Round-robin: the singer's k-th pending song goes after everybody else's k-th
 * song. Entries pinned with `playNext` stay at the front untouched. */
export function fairInsertIndex<T extends QueueEntry>(queue: T[], memberId: string, fair = true): number {
  if (!fair) return queue.length;
  const mine = queue.filter((q) => q.memberId === memberId).length; // new entry is round mine+1
  const roundOf = new Map<string, number>();
  let insertAt = queue.length;
  for (let i = 0; i < queue.length; i++) {
    const m = queue[i].memberId;
    const r = (roundOf.get(m) ?? 0) + 1;
    roundOf.set(m, r);
    if (r > mine + 1) { insertAt = i; break; }
  }
  return insertAt;
}

export function countFor<T extends QueueEntry>(queue: T[], memberId: string): number {
  return queue.filter((q) => q.memberId === memberId).length;
}

/** Move the entry at `from` to `to` (both indices into the same array). Returns a new array. */
export function moveEntry<T>(queue: T[], from: number, to: number): T[] {
  const out = [...queue];
  if (from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x);
  return out;
}
