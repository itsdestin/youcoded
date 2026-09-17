// @vitest-environment jsdom
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readSource } from './helpers/guard-scope';

// WHY this test lives in the DESKTOP suite even though it checks an Android file:
// it is the only suite that runs on every change (scripts/verify.sh). Under Gradle
// alone this guard would only fire when someone happens to build the phone app, and
// the two lines below are exactly the kind that get dropped in a manifest cleanup
// and noticed months later by a user whose voice button does nothing.
// Test file is at desktop/tests/, so two levels up reaches the repo root.
const MANIFEST_PATH = join(__dirname, '..', '..', 'app', 'src', 'main', 'AndroidManifest.xml');

// WHY a real parser: a substring check on `toContain('android.speech.RecognitionService')`
// stays green even if the node it's asking about moves out of the <queries> block
// entirely, or the attribute it lives on gets renamed. Parsing the manifest as XML and
// reading the actual node is what electron-builder-style config readers do; do the same
// here. jsdom's DOMParser doesn't resolve the `android:` namespace prefix for
// attribute-selector matching, so nodes are found by tag name and the attribute read by
// getAttribute rather than a namespaced querySelector.
describe('AndroidManifest voice prompting requirements', () => {
  const doc = new DOMParser().parseFromString(readSource(MANIFEST_PATH), 'text/xml');

  it('declares the RECORD_AUDIO permission', () => {
    // Without the declaration, the runtime permission request cannot even be made,
    // so the microphone is unreachable on the phone.
    const permissions = Array.from(doc.getElementsByTagName('uses-permission'));
    const hasRecordAudio = permissions.some(
      (el) => el.getAttribute('android:name') === 'android.permission.RECORD_AUDIO',
    );
    expect(hasRecordAudio).toBe(true);
  });

  it('queries the speech RecognitionService so it is visible under package visibility', () => {
    // Android 11+ package visibility hides the recogniser unless it is queried here,
    // which makes SpeechRecognizer.isRecognitionAvailable() false on every phone.
    const actions = Array.from(doc.getElementsByTagName('action'));
    const queriesRecognitionService = actions.some(
      (el) => el.getAttribute('android:name') === 'android.speech.RecognitionService',
    );
    expect(queriesRecognitionService).toBe(true);
  });
});
