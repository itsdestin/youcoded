import React from 'react';
import './Slider.css';

/**
 * The one slider — a round handle riding at the end of its fill, the fill's end
 * curving around the handle so the two read as one shape.
 *
 * WHY (Destin, submit-ticket-5#ST5-5: "i want a new slider style. use home assistant page
 * light slider as a reference. round handle, with fill that rounds around the edge of the
 * drag handle. use for volume too"): the app's sliders were the browser's own range input
 * tinted with the accent — a thin line and a small dot, unlike every other control. This is
 * Home Assistant's light-brightness shape: a thick track, the accent fill from the start to
 * the handle, its end a half-circle concentric with the handle.
 *
 * HOW: a real <input type="range"> lies over the drawing, invisible, so the keyboard, screen
 * readers, touch and dragging are the browser's own; its thumb is sized to the handle
 * (`.yc-slider-input` in Slider.css), so a press lands where the handle is drawn. The
 * drawing reads the value: the handle's centre runs from H/2 to (width − H/2), and the fill
 * ends H/2 past it — so its rounded end wraps the handle exactly.
 *
 * Round like the switch (Toggle is rounded-full): a slider's handle is a circle in every
 * theme, and its track follows it.
 */
type SliderProps = {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  /** Required: a slider with no name is unusable with a screen reader. */
  'aria-label': string;
  /** What a screen reader says for the value ("72%"), when the bare number would mislead. */
  'aria-valuetext'?: string;
  className?: string;
};

/** Track height in px — the handle's diameter plus its ring. */
const H = 20;

export function Slider({ value, min, max, step = 1, onChange, disabled = false, className = '', ...aria }: SliderProps) {
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (value - min) / span));
  return (
    <div className={`relative flex-1 min-w-16 ${disabled ? 'opacity-50' : ''} ${className}`.trim()} style={{ height: H }}>
      {/* The track. */}
      <div className="absolute inset-0 rounded-full bg-inset border border-edge-card" aria-hidden="true" />
      {/* The fill: from the start to H/2 past the handle's centre, so its rounded end wraps the handle. */}
      <div className="absolute inset-y-0 left-0 rounded-full bg-accent" aria-hidden="true"
        style={{ width: `calc(${H}px + ${t} * (100% - ${H}px))` }} />
      <input
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        aria-label={aria['aria-label']} aria-valuetext={aria['aria-valuetext']}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="yc-slider-input peer absolute inset-0 w-full h-full m-0 opacity-0 cursor-pointer disabled:cursor-not-allowed"
      />
      {/* The handle, centred in the fill's rounded end. The focus ring follows the keyboard. */}
      <div aria-hidden="true"
        className="pointer-events-none absolute top-0.75 rounded-full bg-white border border-edge-dim shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-accent transition-transform peer-active:scale-110"
        style={{ width: H - 6, height: H - 6, left: `calc(3px + ${t} * (100% - ${H}px))` }} />
    </div>
  );
}
