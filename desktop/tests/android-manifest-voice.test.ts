import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// WHY this test lives in the DESKTOP suite even though it checks an Android file:
// it is the only suite that runs on every change (scripts/verify.sh). Under Gradle
// alone this guard would only fire when someone happens to build the phone app, and
// the two lines below are exactly the kind that get dropped in a manifest cleanup
// and noticed months later by a user whose voice button does nothing.
// Test file is at desktop/tests/, so two levels up reaches the repo root.
const MANIFEST_PATH = join(__dirname, '..', '..', 'app', 'src', 'main', 'AndroidManifest.xml');

describe('AndroidManifest voice prompting requirements', () => {
  const manifest = readFileSync(MANIFEST_PATH, 'utf8');

  it('declares the RECORD_AUDIO permission', () => {
    // Without the declaration, the runtime permission request cannot even be made,
    // so the microphone is unreachable on the phone.
    expect(manifest).toContain('android.permission.RECORD_AUDIO');
  });

  it('queries the speech RecognitionService so it is visible under package visibility', () => {
    // Android 11+ package visibility hides the recogniser unless it is queried here,
    // which makes SpeechRecognizer.isRecognitionAvailable() false on every phone.
    expect(manifest).toContain('android.speech.RecognitionService');
  });
});
