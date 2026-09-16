import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLED_PLUGIN_IDS } from '../src/shared/bundled-plugins';
import { readSource } from './helpers/guard-scope';

// Both platforms auto-install bundled plugins from their own list. Until now the
// two lists were kept in sync by a comment only — a plugin added to one and not
// the other silently ships on one platform. This is the guard.
const KOTLIN_MIRROR = path.resolve(
  __dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'skills', 'BundledPlugins.kt'
);

describe('bundled plugin parity', () => {
  it('the Kotlin mirror exists where the parity comment says it does', () => {
    expect(fs.existsSync(KOTLIN_MIRROR)).toBe(true);
  });

  it('BundledPlugins.kt lists exactly the same ids in the same order', () => {
    const src = readSource(KOTLIN_MIRROR);
    const block = src.match(/val\s+IDS\s*=\s*listOf\(([\s\S]*?)\)/);
    expect(block, 'could not find `val IDS = listOf(...)` in BundledPlugins.kt').not.toBeNull();

    const kotlinIds = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(kotlinIds).toEqual([...BUNDLED_PLUGIN_IDS]);
  });

  it('includes chatsearch on both platforms', () => {
    expect([...BUNDLED_PLUGIN_IDS]).toContain('youcoded-chatsearch');
  });

  // Task B5: Android's PluginInstaller/LocalSkillProvider must expose the
  // same reconcile entry points desktop's plugin-installer.ts/skill-provider.ts
  // added in Track B (readPluginVersion, refreshLocalMarketplaceCache,
  // upgradePluginFromLocal, reconcileBundledPlugins) — a bundled-plugin
  // upgrade fix that lands on only one platform is worse than no fix at all.
  it('the Kotlin installer implements the same reconcile entry points', () => {
    const kt = (f: string) => readSource(path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'skills', f));
    expect(kt('LocalSkillProvider.kt')).toMatch(/fun reconcileBundledPlugins\(/);
    expect(kt('PluginInstaller.kt')).toMatch(/fun upgradeFromLocal\(/);
    expect(kt('PluginInstaller.kt')).toMatch(/fun refreshLocalMarketplaceCache\(/);
    expect(kt('VersionCompare.kt')).toMatch(/fun isNewer\(/);
  });

  // Fix (Track B final review, Finding F8): the four checks above pass even
  // if reconcileBundledPlugins() is an empty stub, if upgradeFromLocal
  // deletes-then-copies instead of stage-then-swap, or if the 1h cache gate
  // is removed — they only grep that a function NAME exists, not what it
  // does. The one regression that actually matters here: Android must never
  // grow desktop's YOUCODED_PROFILE dev-instance guard. That guard exists
  // ONLY because a dev Electron build shares ~/.claude with Destin's real,
  // live desktop install and must not silently upgrade it out from under
  // him — Android has no dev-instance concept (no second app sharing one
  // real profile), so the same guard there would just make ordinary
  // upgrades disappear on some inputs. This is a real code-shape check that
  // would fail if that guard were ever copied over.
  //
  // Matches actual GUARD CODE (an env/property read gating on the literal
  // env var name), not the file's own explanatory comment documenting that
  // Android deliberately has no such guard — that comment legitimately
  // contains the string "YOUCODED_PROFILE" and must not trip this check.
  //
  // Fix (Track B minor hardening review): `/getenv\(\s*"YOUCODED_PROFILE"/`
  // only matches the direct-call form `getenv("YOUCODED_PROFILE")`. Valid
  // Kotlin can also read it via map access — `System.getenv()["YOUCODED_PROFILE"]`
  // — which that regex never sees. Widened to allow up to 20 chars of
  // anything (no newline) between `getenv` and the literal, so both call
  // shapes are caught, while still not tripping on the explanatory comment
  // (verified below: the comment's own text keeps "getenv" and
  // "YOUCODED_PROFILE" far enough apart, and on the wrong side, to stay
  // outside this window).
  it('LocalSkillProvider.kt never grows desktop\'s dev-instance guard', () => {
    const kt = (f: string) => readSource(path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'skills', f));
    // WHY: Android has no dev-instance concept — YOUCODED_PROFILE only exists
    // to protect desktop's real ~/.claude from a run-dev.sh copy. Porting it
    // to Android would silently skip real upgrades with no equivalent reason.
    expect(kt('LocalSkillProvider.kt')).not.toMatch(/getenv[^\n]{0,20}YOUCODED_PROFILE/);
  });
});
