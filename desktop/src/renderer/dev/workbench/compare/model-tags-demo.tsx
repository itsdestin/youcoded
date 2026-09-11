// Model-list tags, round 1 (docs/active/design/2026-09-11-model-picker-tags).
//
// The REAL ModelPicker, opened, under one of the three tag layouts. Nothing here
// draws a row: the candidates differ only in ModelTagStyleContext, so the winner is
// already the production component.
import React, { useRef, useState } from 'react';
import ModelPicker, { type ModelChoice } from '../../../components/model/ModelPicker';
import { ModelTagStyleContext, type ModelTagStyle } from '../../../components/model/ModelTags';

const FAV_KEY = 'youcoded-model-favorites';

// One row of every tag state, from real models: a Claude plan model (the selected
// row), a ChatGPT plan model, great / poor value, a priced model with no score
// (price level), a score with no price (no value tag), a fast and a slow local
// model with no score, and a downloaded copy borrowing its original's score with
// an estimated speed.
const DEMO_FAVOURITES = [
  'claude:opus[1m]',
  'chatgpt:gpt-5.6-luna',
  'pv-openrouter:deepseek/deepseek-v3.2',
  'pv-openrouter:anthropic/claude-sonnet-4-6',
  'pv-openrouter:google/gemini-3.8-flash',
  'pv-openrouter:x-ai/grok-4',
  'local:qwen3.6-35b-a3b',
  'local:qwen3.8-27b',
  'local:qwen2.5-coder:14b',
];

export function ModelTagsDemo({ style }: { style: ModelTagStyle }) {
  // WHY written before the picker mounts: the picker reads favourites once, in its
  // first render, from localStorage — there is no favourites channel to fake. This
  // overwrites the workbench profile's favourites on this origin only; the filming
  // workbench runs on its own port (5473), so the site and promo scenes keep theirs.
  const seeded = useRef(false);
  if (!seeded.current) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(DEMO_FAVOURITES)); } catch { /* storage blocked */ }
    seeded.current = true;
  }
  const [value, setValue] = useState<ModelChoice | null>({ runtime: 'claude', alias: 'opus[1m]' });
  return (
    <ModelTagStyleContext.Provider value={style}>
      {/* WHY the fixed height: the canvas frame centres its content, which put the
          model button halfway down the pane, and the list opens into the room BELOW
          its button — so only four of the nine example rows fitted. A tall block
          keeps the button at the top and gives the list the whole pane. */}
      <div className="p-3 h-[620px] w-full">
        <ModelPicker value={value} onSelect={(c) => setValue(c)} defaultOpen onManageModels={() => {}} />
      </div>
    </ModelTagStyleContext.Provider>
  );
}
