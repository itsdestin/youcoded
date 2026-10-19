import React from 'react';
import { AnchorTip, CARD_LEVEL_1, SegmentedTabs, SettingRow } from '../ui';

import type { ContextPreferences } from '../../../shared/context-preferences';
export type { ContextMode, ContextPreferences } from '../../../shared/context-preferences';
export { DEFAULT_CONTEXT_PREFERENCES } from '../../../shared/context-preferences';
export type ContextSettingsProps = {
  value: ContextPreferences;
  onChange: (value: ContextPreferences) => void;
};

const CONTEXT_OPTIONS = [{ id: 'standard', label: '250k' }, { id: 'medium', label: '500k' }, { id: 'long', label: '1M' }];
const PROVIDERS = [{ id: 'openrouter', label: 'OpenRouter' }, { id: 'chatgpt', label: 'ChatGPT' }] as const;

export default function ContextSettings({ value, onChange }: ContextSettingsProps) {
  // WHY: this preview is controlled and provider-specific; choosing a larger window
  // must not silently opt the other provider into higher cost or plan usage.
  return <section className={`${CARD_LEVEL_1} px-3 py-2.5 space-y-2`} aria-label="Context">
    <div className="flex items-center gap-1">
      <h3 className="text-xs font-medium text-fg">Context</h3>
      <AnchorTip label="About context" title="Context" className="coarse-hit">
        <div className="space-y-2 text-xs">
          <p>Context is how much of the conversation the model can use at once, measured in tokens (pieces of text).</p>
          <p>Choose 250k, 500k or 1M. These sizes are approximate: smaller models may stay below the selected size, while supported long windows are around 800k–1.2M, depending on the model and provider.</p>
          <p>Longer context means fewer summaries in long conversations, but can cost more on OpenRouter or use more of your ChatGPT plan allowance.</p>
          <p>Selecting 500k or 1M does not send that many tokens with every message. Usage depends on what is actually sent and generated.</p>
          <p>500k is the default for both providers. These choices apply only to OpenRouter and ChatGPT; local models are unchanged.</p>
        </div>
      </AnchorTip>
    </div>
    {/* WHY: short provider labels and three choices fit side by side on desktop;
        stack below the shared breakpoint without the old full-row padding. */}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
    {PROVIDERS.map((provider) => <SettingRow key={provider.id} title={provider.label} variant="item"
      header control={
        <SegmentedTabs aria-label={`${provider.label} context`} variant="nested"
          tabs={CONTEXT_OPTIONS} value={value[provider.id]}
          onChange={(mode) => {
            if (mode === 'standard' || mode === 'medium' || mode === 'long') onChange({ ...value, [provider.id]: mode });
          }} />
      } />)}
    </div>
  </section>;
}
