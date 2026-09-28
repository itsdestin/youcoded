// Which documents are open in Office, and which is in front. A module store
// (performance rule 3: a slice store, not a Context) so the tabs outlive the
// page view: going back to chat and returning finds the same documents.
import { useSyncExternalStore } from 'react';
import type { OfficeBridge, OfficeFile } from '../../../shared/office-types';

export const HOME_TAB = 'home';

interface OpenDoc {
  file: OfficeFile;
  /** Closed in the background to save memory (office-questions#Q-sleep). */
  asleep: boolean;
}

interface OfficeTabs {
  docs: OpenDoc[];
  active: string;
  /** The file whose Versions window is open, if any. */
  versionsFor: OfficeFile | null;
}

let state: OfficeTabs = { docs: [], active: HOME_TAB, versionsFor: null };
const listeners = new Set<() => void>();
function set(next: OfficeTabs) { state = next; listeners.forEach((l) => l()); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useOfficeTabs(): OfficeTabs {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Open a file, or bring it forward if it is already open. */
export function openDoc(file: OfficeFile): void {
  const existing = state.docs.find((d) => d.file.path === file.path);
  const docs = existing
    ? state.docs.map((d) => (d.file.path === file.path ? { ...d, asleep: false } : d))
    : [...state.docs, { file, asleep: false }];
  set({ ...state, docs, active: file.path });
}

/** Choosing a sleeping tab wakes it: its editor opens again where it was. */
export function selectTab(id: string): void {
  set({ ...state, docs: state.docs.map((d) => (d.file.path === id ? { ...d, asleep: false } : d)), active: id });
}

export function closeDoc(path: string): void {
  const i = state.docs.findIndex((d) => d.file.path === path);
  if (i < 0) return;
  const docs = state.docs.filter((d) => d.file.path !== path);
  // Closing the front tab shows its neighbour, like a browser; the last one shows Home.
  const active = state.active !== path ? state.active : (docs[i] ?? docs[i - 1])?.file.path ?? HOME_TAB;
  set({ ...state, docs, active });
}

export function showVersions(file: OfficeFile | null): void {
  set({ ...state, versionsFor: file });
}

/** Workbench and screenshots only: lay out a given set of tabs at once. */
function setOfficeTabsForPreview(docs: OpenDoc[], active: string, versionsFor: OfficeFile | null = null): void {
  set({ docs, active, versionsFor });
}

/** Photo-only (`shoot`): three recent files open, the third asleep, the given
 *  one in front — optionally with its Versions window open. */
export async function previewOfficeTabs(front: number, withVersions = false): Promise<void> {
  const b = (window as unknown as { claude?: { office?: OfficeBridge } }).claude?.office;
  const recent = (await b?.status())?.recent ?? [];
  const docs = recent.slice(0, 3).map((file, i) => ({ file, asleep: i === 2 }));
  const f = docs[front]?.file;
  setOfficeTabsForPreview(docs, f?.path ?? HOME_TAB, withVersions && f ? f : null);
}
