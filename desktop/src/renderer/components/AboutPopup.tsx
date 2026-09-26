import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscClose } from '../hooks/use-esc-close';
import { Toggle } from './SettingsPanel';
import { Dialog, SectionLabel, SettingRow } from './ui';
import { formatVersionLine } from '../../shared/version-line';

// Shared About popup for Desktop and Android settings. Previously this was an
// inline collapsible inside SettingsPanel on both platforms, which didn't match
// the rest of the settings menu popups (PreferencesPopup, ModelPicker, etc.).
// Now it's a proper layer-2 overlay: centered, theme-driven glass surface,
// scrim-to-dismiss, Escape-to-close.

interface AboutPopupProps {
  open: boolean;
  onClose: () => void;
  platform: 'desktop' | 'android';
  version: string;
  build?: string;
  /** Build channel (e.g. 'BETA') — set only by test builds, never by releases. */
  channel?: string;
}

// Canonical homes of the two policy documents (TERMS.md §11 names this URL as
// the always-current copy). Also linked from the landing-page footer.
const PRIVACY_POLICY_URL = 'https://github.com/itsdestin/youcoded/blob/master/PRIVACY.md';
const TERMS_OF_SERVICE_URL = 'https://github.com/itsdestin/youcoded/blob/master/TERMS.md';

const DESKTOP_LIBS: { lib: string; license: string; source: string }[] = [
  { lib: 'Electron', license: 'MIT', source: 'github.com/electron/electron' },
  { lib: 'React', license: 'MIT', source: 'github.com/facebook/react' },
  { lib: 'Vite', license: 'MIT', source: 'github.com/vitejs/vite' },
  { lib: 'xterm.js', license: 'MIT', source: 'github.com/xtermjs/xterm.js' },
  { lib: 'node-pty', license: 'MIT', source: 'github.com/microsoft/node-pty' },
  { lib: 'Tailwind CSS', license: 'MIT', source: 'github.com/tailwindlabs/tailwindcss' },
  { lib: 'highlight.js', license: 'BSD 3-Clause', source: 'github.com/highlightjs/highlight.js' },
  { lib: 'partysocket / PartyKit', license: 'MIT / ISC', source: 'github.com/partykit/partykit' },
  { lib: 'Cascadia Code', license: 'SIL OFL', source: 'github.com/microsoft/cascadia-code' },
];

const ANDROID_LIBS: { lib: string; license: string; source: string }[] = [
  // Termux's LICENSE.md carves terminal-emulator out as Apache 2.0 (the rest of
  // termux-app is GPLv3). terminal-view is no longer linked — see app/build.gradle.kts.
  { lib: 'Termux terminal-emulator', license: 'Apache 2.0', source: 'github.com/termux/termux-app' },
  { lib: 'AndroidX / Jetpack Compose', license: 'Apache 2.0', source: 'developer.android.com' },
  { lib: 'Apache Commons Compress', license: 'Apache 2.0', source: 'commons.apache.org' },
  { lib: 'CommonMark', license: 'BSD 2-Clause', source: 'github.com/commonmark/commonmark-java' },
  { lib: 'XZ for Java', license: 'Public Domain', source: 'tukaani.org/xz' },
  { lib: 'Zstd-JNI', license: 'BSD', source: 'github.com/luben/zstd-jni' },
  { lib: 'Cascadia Mono', license: 'SIL OFL', source: 'github.com/microsoft/cascadia-code' },
];

// Opt-out toggle for anonymous analytics.
// Matches the shape of the skip-permissions toggle in SettingsPanel — label row
// + description row + <Toggle>. Default ON; single click flips. No confirmation
// dialog (parallel with skip-permissions and reduced-effects). No destructive red.
function AnalyticsOptInToggle() {
  const [optIn, setOptIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.claude.analytics.getOptIn().then((v) => { if (!cancelled) setOptIn(v); });
    return () => { cancelled = true; };
  }, []);

  // Don't render until we know the state — avoids a visible flicker from OFF → ON.
  if (optIn === null) return null;

  const flip = () => {
    const next = !optIn;
    setOptIn(next);  // optimistic
    window.claude.analytics.setOptIn(next).catch(() => setOptIn(!next));  // revert on failure
  };

  return (
    <SettingRow
      className="mt-2"
      variant="item"
      title="Share anonymous usage stats"
      description="Sends a daily ping with the fields listed above."
      control={<Toggle enabled={optIn} onToggle={flip} label="Share anonymous usage stats" />}
    />
  );
}

export default function AboutPopup({ open, onClose, platform, version, build, channel }: AboutPopupProps) {

  // Escape-to-close, matching PreferencesPopup/ModelPickerPopup convention.
  useEscClose(open, onClose);

  if (!open) return null;

  const libs = platform === 'desktop' ? DESKTOP_LIBS : ANDROID_LIBS;
  const versionLine = formatVersionLine({ version, build, channel });

  return createPortal(
    <>
      <Dialog open onClose={onClose} title="About" size="panel">
          {/* WHY: keep the chosen one-line header without dropping the version;
              it appears first in the scrolling About body on both platforms. */}
          <div className="text-3xs text-fg-muted">{versionLine}</div>
          {/* Disclaimer — identical on both platforms */}
          <section className="space-y-1.5">
            {/* WHY SectionLabel reading (fix batch 2, 2026-09-26): a label over a
                section of READING text is the small grey label, normal case, with a
                soft underline under its words (decisions.md "Labels over reading
                sections", final#F-1 — About's Disclaimer is the guide's example). */}
            <SectionLabel reading>Disclaimer</SectionLabel>
            <p className="text-2xs text-fg-dim leading-relaxed">
              YouCoded is an independent, community-built project. It is not affiliated with, endorsed by, or officially supported by Anthropic.
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              "Claude" and "Claude Code" are trademarks of Anthropic, PBC.
            </p>
            <p className="text-2xs text-fg-dim leading-relaxed">
              Thanks to the Anthropic team for building Claude Code. This project exists because of their work.
            </p>
          </section>

          {/* Privacy — platform-specific. Copy is user-approved (see
              docs/superpowers/specs/2026-04-23-analytics-privacy-copy-draft.md);
              do not edit wording without re-approval. The <AnalyticsOptInToggle />
              lives inline so the toggle sits right next to the explanation
              of what it does. The "Friends & presence" paragraph + the updated
              games line were added by accounts Phase 2 (wording approved by
              Destin 2026-07-09). */}
          <section className="space-y-1.5">
            <SectionLabel reading>Privacy</SectionLabel>
            {platform === 'desktop' ? (
              <>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  Your Claude Pro/Max sign-in is stored locally on your device. It is never transmitted to or collected by YouCoded. All Claude Code interactions happen directly between the on-device CLI and Anthropic's servers. YouCoded does not collect any personal data or message content.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  <strong className="text-fg-2 font-semibold">Your account (optional).</strong> Signing in with GitHub creates a YouCoded account. We store: your GitHub username, display name, avatar, and handle; your theme likes, plugin reviews, and install records. We never see your GitHub password or private repos — sign-in uses read-only access to your public profile. Delete your account any time in Settings → Account; deletion removes everything above immediately. Analytics stays separate: your account is never linked to the anonymous device statistics described below.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  <strong className="text-fg-2 font-semibold">Friends &amp; presence (optional).</strong> If you use friends, we store your friend list, pending requests, and your block list (your block list is visible only to you). While you're signed in with the app open, your friends — and only your friends — can see that you're online and, after you disconnect, a single "last seen" time. We never keep a history of when you were online. You can appear offline any time (incognito in the games panel), download everything we store (Settings → Account → Download my data), and deleting your account removes all of it immediately.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  By default, your device may send anonymous usage data to YouCoded once per day, including:
                </p>
                <ul className="text-2xs text-fg-dim leading-relaxed list-disc pl-5 space-y-0.5">
                  <li>An irreversible hash of your device's hardware ID (the raw ID never leaves your device — it's hashed locally before transmission)</li>
                  <li>Installed app version (e.g. <code>1.3.0</code>)</li>
                  <li>Platform and OS (e.g. <code>desktop / mac</code>)</li>
                  <li>Country and approximate region (e.g. US state), derived from your IP address by Cloudflare. IP addresses are never stored.</li>
                </ul>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  No message content, no usernames, no tokens, no file paths. The collection of this information helps improve YouCoded for yourself and future users. You may disable this below at any time.
                </p>
                <AnalyticsOptInToggle />
                <p className="text-2xs text-fg-dim leading-relaxed pt-2">
                  Remote access (when enabled) serves the UI over your local network or Tailscale. Remote connections are NOT TLS-encrypted — use Tailscale for sensitive conversations since it provides WireGuard encryption end-to-end.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  Multiplayer game moves are relayed through a PartyKit server (Cloudflare) only while a game is open; challenges and the friends lobby go through the YouCoded server. No game traffic is retained server-side beyond the active room.
                </p>
              </>
            ) : (
              <>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  Your Claude Pro/Max sign-in is stored locally on your device. It is never transmitted to or collected by YouCoded. All Claude Code interactions happen directly between the on-device CLI and Anthropic's servers. YouCoded does not collect any personal data or message content.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  <strong className="text-fg-2 font-semibold">Your account (optional).</strong> Signing in with GitHub creates a YouCoded account. We store: your GitHub username, display name, avatar, and handle; your theme likes, plugin reviews, and install records. We never see your GitHub password or private repos — sign-in uses read-only access to your public profile. Delete your account any time in Settings → Account; deletion removes everything above immediately. Analytics stays separate: your account is never linked to the anonymous device statistics described below.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  <strong className="text-fg-2 font-semibold">Friends &amp; presence (optional).</strong> If you use friends, we store your friend list, pending requests, and your block list (your block list is visible only to you). While you're signed in with the app open, your friends — and only your friends — can see that you're online and, after you disconnect, a single "last seen" time. We never keep a history of when you were online. You can appear offline any time (incognito in the games panel), download everything we store (Settings → Account → Download my data), and deleting your account removes all of it immediately.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  By default, your device may send anonymous usage data to YouCoded once per day, including:
                </p>
                <ul className="text-2xs text-fg-dim leading-relaxed list-disc pl-5 space-y-0.5">
                  <li>An irreversible hash of your device's hardware ID (the raw ID never leaves your device — it's hashed locally before transmission)</li>
                  <li>Installed app version (e.g. <code>1.3.0</code>)</li>
                  <li>Platform (<code>android</code>)</li>
                  <li>Country and approximate region (e.g. US state), derived from your IP address by Cloudflare. IP addresses are never stored.</li>
                </ul>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  No message content, no usernames, no tokens, no file paths. The collection of this information helps improve YouCoded for yourself and future users. You may disable this below at any time.
                </p>
                <AnalyticsOptInToggle />
                <p className="text-2xs text-fg-dim leading-relaxed pt-2">
                  During initial setup, Termux runtime packages are downloaded from packages.termux.dev over HTTPS with SHA256 verification.
                </p>
              </>
            )}
          </section>

          {/* Licenses — platform-specific intro + lib list */}
          <section className="space-y-1.5">
            <SectionLabel reading>Licenses</SectionLabel>
            {platform === 'desktop' ? (
              <>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  The YouCoded desktop application is licensed under the MIT License.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  The YouCoded Android application is MIT-licensed as well; it includes Termux&apos;s terminal-emulator library under the Apache License 2.0.
                </p>
              </>
            ) : (
              <>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  The YouCoded Android application is licensed under the MIT License, the same as the desktop app and the shared interface that powers both.
                </p>
                <p className="text-2xs text-fg-dim leading-relaxed">
                  It includes a copy of Termux&apos;s terminal-emulator library, which is licensed under the Apache License 2.0; its license and NOTICE ship with the app.
                </p>
              </>
            )}
            <div className="mt-2 space-y-1 pl-2">
              {libs.map(({ lib, license, source }) => (
                <div key={lib}>
                  <span className="text-3xs text-fg-2 font-medium">{lib}</span>
                  <span className="text-3xs text-fg-muted ml-1">· {license} · {source}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Policies — one row, two links. Google Play and Apple require a
              reachable privacy policy, and before this row nothing in the app
              pointed at PRIVACY.md or TERMS.md at all. Opened through
              window.claude.shell.openExternal like every other outbound link in
              settings (ModelProvidersPopup, StatusBar); on Android the shim routes
              it to an ACTION_VIEW intent, so the same code serves both platforms. */}
          <section className="space-y-1.5">
            <SectionLabel reading>Policies</SectionLabel>
            <p className="text-2xs text-fg-dim leading-relaxed flex flex-wrap gap-x-4">
              <button
                type="button"
                className="text-link hover:text-link-hover underline"
                onClick={() => void window.claude.shell.openExternal(PRIVACY_POLICY_URL)}
              >
                Privacy policy
              </button>
              <button
                type="button"
                className="text-link hover:text-link-hover underline"
                onClick={() => void window.claude.shell.openExternal(TERMS_OF_SERVICE_URL)}
              >
                Terms of service
              </button>
            </p>
          </section>
      </Dialog>
    </>,
    document.body,
  );
}
