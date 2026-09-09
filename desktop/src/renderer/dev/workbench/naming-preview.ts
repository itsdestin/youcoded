import type { NamingApi, NamingPreferences } from '../../components/assistant-settings/naming-api';

/** WHY: an in-memory fake lets the UI be reviewed without title generation,
 * disk writes, paid model calls, or promises about backend ordering. */
export function createNamingPreview(onTitle?: (id: string, title: string) => void, options?: {
  wait: () => Promise<void>; refuseWrites: () => boolean;
}): NamingApi {
  // WHY: delay BEFORE mutation so pending/refused previews cannot paint success.
  const wait = async (write = false) => {
    await options?.wait();
    if (write && options?.refuseWrites()) throw new Error('Preview save refused. Your changes were not saved.');
  };
  let preferences: NamingPreferences = { mode: 'basic', model: null };
  const titles = new Map<string, string>();
  const originals = new Map<string, string>();
  return {
    get: async () => { await wait(); return { ...preferences }; },
    set: async (value) => { await wait(true); preferences = { ...value }; },
    title: async (id, fallback) => {
      await wait();
      if (!originals.has(id)) originals.set(id, fallback);
      return { title: titles.get(id) ?? originals.get(id)!, manual: titles.has(id) };
    },
    rename: async (id, title) => {
      await wait(true);
      if (!title.trim()) throw new Error('Enter a name.');
      titles.set(id, title.trim()); onTitle?.(id, title.trim());
    },
    automatic: async (id) => {
      await wait(true);
      titles.delete(id);
      const original = originals.get(id);
      if (original) onTitle?.(id, original);
    },
  };
}
