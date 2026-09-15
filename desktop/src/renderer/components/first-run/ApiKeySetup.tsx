import { useState } from 'react';
import { Button, Select, TextInput } from '../ui';
import { KEY_SERVICES, KEY_SERVICE_LABEL, recogniseKey, type KeyService } from './recognise-key';

/**
 * "Use an API key" on the first-run sign-in card, as its own page (round 3
 * review A-7, Destin 2026-09-14: "this should open a second page, like the local
 * model button"). Any key the app supports (F-1), run on YouCoded's own assistant
 * (F-2).
 */

// WHY every action is the card's outlined pill: first-run rule, Destin 2026-09-14.
const PILL = 'px-6 py-3 rounded-full font-semibold text-base w-full';

export function ApiKeySetup({ onBack, onSubmit }: { onBack: () => void; onSubmit: (key: string, service: KeyService) => void }) {
  const [apiKey, setApiKey] = useState('');
  // F-1 "recognise it": the prefix names the service; only a key the prefixes
  // cannot place asks which service it is for.
  const [pickedService, setPickedService] = useState<KeyService>('openai');
  const recognised = recogniseKey(apiKey);
  const unrecognised = !recognised && apiKey.trim().length >= 8;
  const keyService: KeyService | null = recognised ?? (unrecognised ? pickedService : null);

  return (
    <div className="w-full flex flex-col items-center gap-4">
      <div className="text-center">
        <p className="text-base font-medium text-fg">Use an API key</p>
        <p className="mt-1 text-sm text-fg-dim leading-relaxed">
          Paste a key from Anthropic, OpenAI, Google or OpenRouter.
        </p>
      </div>

      <TextInput
        type="password"
        size="md"
        aria-label="API key"
        className="w-full"
        placeholder="Paste your API key"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      {recognised && (
        <p className="text-xs text-fg-dim text-center">{KEY_SERVICE_LABEL[recognised]} key</p>
      )}
      {unrecognised && (
        <div className="w-full flex flex-col gap-1.5">
          <span className="text-xs text-fg-dim">Which service is this key for?</span>
          <Select
            size="md"
            aria-label="Which service is this key for?"
            options={KEY_SERVICES.map((s) => ({ value: s, label: KEY_SERVICE_LABEL[s] }))}
            value={pickedService}
            onChange={(v) => setPickedService(v as KeyService)}
          />
        </div>
      )}

      <div className="flex flex-col items-stretch gap-3 w-full">
        <Button variant="secondary" onClick={() => { if (keyService) onSubmit(apiKey, keyService); }} disabled={!keyService} className={PILL}>
          Verify &amp; Continue
        </Button>
        <Button variant="secondary" onClick={onBack} className={PILL}>
          Back to sign-in
        </Button>
      </div>
    </div>
  );
}
