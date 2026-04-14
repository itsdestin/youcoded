// Feature flags — small, localStorage-backed boolean prefs. Used for dark-
// launching UI work that's big enough to warrant a rollback lever.
//
// Don't use this for permanent settings (font, theme, reduced-motion). This
// file exists for *unstable* surfaces that should either be merged and
// deleted (on win) or removed entirely (on rollback).

import { useSyncExternalStore } from "react";

type FlagKey = "newMarketplace";

const STORAGE_PREFIX = "destincode-flag-";

// Defaults: every flag starts false. Flip to true in the commit that ships
// the feature, then delete the flag + legacy code path in a cleanup PR.
const DEFAULTS: Record<FlagKey, boolean> = {
  newMarketplace: false,
};

function read(key: FlagKey): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return DEFAULTS[key];
    return raw === "1";
  } catch {
    return DEFAULTS[key];
  }
}

function write(key: FlagKey, value: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, value ? "1" : "0");
    // Nudge useSyncExternalStore subscribers via a storage-style event. The
    // real 'storage' event only fires across tabs, not within the same tab,
    // so we dispatch our own.
    window.dispatchEvent(new CustomEvent("destincode-flag-change", { detail: { key } }));
  } catch {
    /* localStorage not available */
  }
}

function subscribe(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener("destincode-flag-change", handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("destincode-flag-change", handler);
    window.removeEventListener("storage", handler);
  };
}

export function useFeatureFlag(key: FlagKey): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => DEFAULTS[key],
  );
  return [value, (v: boolean) => write(key, v)];
}

export function getFeatureFlag(key: FlagKey): boolean {
  return read(key);
}
