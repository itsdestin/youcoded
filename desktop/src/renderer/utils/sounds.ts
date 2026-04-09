/**
 * Sound engine — synthesized notification sounds via Web Audio API.
 *
 * Three sound categories, each with selectable presets:
 * - completion: played when Claude finishes a response
 * - attention:  played when a session turns red (awaiting approval)
 * - ready:      played when a session turns blue (response ready, unseen)
 */

// ── Storage keys ─────────────────────────────────────────────────────────────

export const SOUND_MUTED_KEY     = 'destincode-sound-muted';
export const SOUND_VOLUME_KEY    = 'destincode-sound-volume';
export const SOUND_PRESET_KEY    = 'destincode-sound-preset';       // completion preset
export const SOUND_ATTENTION_KEY = 'destincode-sound-attention';    // red status preset
export const SOUND_READY_KEY     = 'destincode-sound-ready';        // blue status preset
export const SOUND_ATTENTION_ENABLED_KEY = 'destincode-sound-attention-enabled';
export const SOUND_READY_ENABLED_KEY     = 'destincode-sound-ready-enabled';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SoundPreset {
  id: string;
  label: string;
  /** Synthesize the sound at the given volume (0–1) */
  play: (volume: number) => void;
}

export type SoundCategory = 'completion' | 'attention' | 'ready';

// ── Synthesizer helpers ──────────────────────────────────────────────────────

function synth(recipe: (ctx: AudioContext, gain: GainNode) => void, volume: number) {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    recipe(ctx, gain);
    setTimeout(() => ctx.close(), 1500);
  } catch { /* audio not available */ }
}

/** Two-tone ascending chime */
function twoTone(freqs: [number, number], type: OscillatorType = 'sine') {
  return (volume: number) => synth((ctx, gain) => {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.3);
    });
  }, volume);
}

/** Three-note arpeggio */
function triTone(freqs: [number, number, number], type: OscillatorType = 'sine') {
  return (volume: number) => synth((ctx, gain) => {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.1);
      osc.stop(ctx.currentTime + i * 0.1 + 0.25);
    });
  }, volume);
}

/** Single short pulse */
function pulse(freq: number, type: OscillatorType = 'sine', duration = 0.15) {
  return (volume: number) => synth((ctx, gain) => {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration + 0.05);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }, volume);
}

/** Two-tone descending (for alerts) */
function descending(freqs: [number, number], type: OscillatorType = 'sine') {
  return (volume: number) => synth((ctx, gain) => {
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.3);
    });
  }, volume);
}

/** Soft double-tap */
function doubleTap(freq: number, type: OscillatorType = 'sine') {
  return (volume: number) => synth((ctx, gain) => {
    [0, 0.12].forEach((offset) => {
      const g = ctx.createGain();
      g.connect(gain);
      g.gain.setValueAtTime(1, ctx.currentTime + offset);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.1);
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(g);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.1);
    });
  }, volume);
}

// ── Preset definitions ───────────────────────────────────────────────────────

// Completion presets — played when Claude finishes
export const COMPLETION_PRESETS: SoundPreset[] = [
  { id: 'chime',     label: 'Chime',     play: twoTone([523.25, 659.25]) },           // C5 → E5
  { id: 'bell',      label: 'Bell',      play: twoTone([659.25, 783.99], 'triangle') }, // E5 → G5
  { id: 'arpeggio',  label: 'Arpeggio',  play: triTone([523.25, 659.25, 783.99]) },   // C5 → E5 → G5
  { id: 'soft',      label: 'Soft',      play: pulse(440, 'sine', 0.25) },             // A4 gentle
  { id: 'sparkle',   label: 'Sparkle',   play: triTone([783.99, 987.77, 1174.66], 'triangle') }, // G5 → B5 → D6
  { id: 'drop',      label: 'Drop',      play: descending([783.99, 523.25]) },          // G5 → C5
];

// Attention presets — played when status turns red (needs approval)
export const ATTENTION_PRESETS: SoundPreset[] = [
  { id: 'nudge',     label: 'Nudge',     play: doubleTap(440) },                        // A4 double tap
  { id: 'alert',     label: 'Alert',     play: descending([880, 659.25]) },             // A5 → E5
  { id: 'ping',      label: 'Ping',      play: pulse(880, 'triangle', 0.12) },          // A5 short
  { id: 'knock',     label: 'Knock',     play: doubleTap(330, 'triangle') },            // E4 soft knock
  { id: 'urgent',    label: 'Urgent',    play: triTone([880, 698.46, 880], 'square') }, // A5 → F5 → A5
];

// Ready presets — played when status turns blue (response ready)
export const READY_PRESETS: SoundPreset[] = [
  { id: 'pop',       label: 'Pop',       play: pulse(587.33, 'sine', 0.1) },            // D5 short pop
  { id: 'blip',      label: 'Blip',      play: pulse(698.46, 'triangle', 0.08) },       // F5 blip
  { id: 'rise',      label: 'Rise',      play: twoTone([392, 523.25]) },                // G4 → C5
  { id: 'bubble',    label: 'Bubble',    play: twoTone([493.88, 587.33], 'triangle') }, // B4 → D5
  { id: 'ding',      label: 'Ding',      play: pulse(1046.5, 'sine', 0.15) },           // C6 ding
];

// ── Lookup helpers ───────────────────────────────────────────────────────────

const PRESETS_BY_CATEGORY: Record<SoundCategory, SoundPreset[]> = {
  completion: COMPLETION_PRESETS,
  attention:  ATTENTION_PRESETS,
  ready:      READY_PRESETS,
};

const STORAGE_KEYS: Record<SoundCategory, string> = {
  completion: SOUND_PRESET_KEY,
  attention:  SOUND_ATTENTION_KEY,
  ready:      SOUND_READY_KEY,
};

export function getPresetsForCategory(cat: SoundCategory): SoundPreset[] {
  return PRESETS_BY_CATEGORY[cat];
}

export function getSelectedPresetId(cat: SoundCategory): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS[cat]);
    if (stored && PRESETS_BY_CATEGORY[cat].some((p) => p.id === stored)) return stored;
  } catch {}
  return PRESETS_BY_CATEGORY[cat][0].id; // default to first
}

export function setSelectedPresetId(cat: SoundCategory, id: string) {
  try { localStorage.setItem(STORAGE_KEYS[cat], id); } catch {}
}

// ── Global getters ───────────────────────────────────────────────────────────

export function isSoundMuted(): boolean {
  try { return localStorage.getItem(SOUND_MUTED_KEY) === '1'; } catch { return false; }
}

export function getSoundVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(SOUND_VOLUME_KEY) || '0.3');
    return isNaN(v) ? 0.3 : Math.max(0, Math.min(1, v));
  } catch { return 0.3; }
}

export function isCategoryEnabled(cat: SoundCategory): boolean {
  if (cat === 'completion') return !isSoundMuted(); // completion uses the main mute toggle
  const key = cat === 'attention' ? SOUND_ATTENTION_ENABLED_KEY : SOUND_READY_ENABLED_KEY;
  try {
    const v = localStorage.getItem(key);
    // Default: enabled for attention, enabled for ready
    return v === null ? true : v === '1';
  } catch { return true; }
}

export function setCategoryEnabled(cat: SoundCategory, enabled: boolean) {
  if (cat === 'completion') {
    try { localStorage.setItem(SOUND_MUTED_KEY, enabled ? '0' : '1'); } catch {}
    return;
  }
  const key = cat === 'attention' ? SOUND_ATTENTION_ENABLED_KEY : SOUND_READY_ENABLED_KEY;
  try { localStorage.setItem(key, enabled ? '1' : '0'); } catch {}
}

// ── Play by category ─────────────────────────────────────────────────────────

/** Play the user's selected sound for a category, respecting mute & volume */
export function playSound(cat: SoundCategory) {
  if (isSoundMuted() && cat === 'completion') return;
  if (!isCategoryEnabled(cat)) return;
  const vol = getSoundVolume();
  const presetId = getSelectedPresetId(cat);
  const preset = PRESETS_BY_CATEGORY[cat].find((p) => p.id === presetId) || PRESETS_BY_CATEGORY[cat][0];
  preset.play(vol);
}

/** Play a specific preset at current volume (for preview/test) */
export function playPreview(cat: SoundCategory, presetId: string) {
  const vol = getSoundVolume();
  const preset = PRESETS_BY_CATEGORY[cat].find((p) => p.id === presetId) || PRESETS_BY_CATEGORY[cat][0];
  preset.play(vol);
}
