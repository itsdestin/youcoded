import { isNativeStartupState, type NativeStartupState } from '../../shared/native-startup';

const states = new Map<string, NativeStartupState>();
const closed = new Map<string, { hostId: string; generation: number }>();
const listeners = new Map<string, Set<() => void>>();
const notify = (id: string) => { for (const listener of listeners.get(id) ?? []) listener(); };

export function getNativeStartup(id: string | null | undefined): NativeStartupState | undefined { return id ? states.get(id) : undefined; }
export function subscribeNativeStartup(id: string | null | undefined, listener: () => void): () => void {
  if (!id) return () => {};
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(listener);
  return () => { set!.delete(listener); if (set!.size === 0) listeners.delete(id); };
}
export function setNativeStartup(id: string, state: NativeStartupState): void {
  if (!id || !isNativeStartupState(state)) return;
  const gone = closed.get(id);
  if (gone?.hostId === state.hostId && state.generation <= gone.generation) return;
  const previous = states.get(id);
  // WHY version all facts: a delayed page fill must not relock a ready chat or
  // overwrite the state of a new incarnation of the same conversation ID.
  if (previous?.hostId === state.hostId && (state.generation < previous.generation ||
      (state.generation === previous.generation && state.revision <= previous.revision))) return;
  closed.delete(id);
  states.set(id, state);
  notify(id);
}
export function forgetNativeStartup(id: string): void {
  const previous = states.get(id);
  if (previous) closed.set(id, { hostId: previous.hostId, generation: previous.generation });
  // Tombstones fence late replies but must not grow for the lifetime of the app.
  if (closed.size > 1000) closed.delete(closed.keys().next().value!);
  if (states.delete(id)) notify(id);
}
export function resetNativeStartups(): void {
  const ids = [...states.keys()]; states.clear(); closed.clear();
  for (const id of ids) notify(id);
}
