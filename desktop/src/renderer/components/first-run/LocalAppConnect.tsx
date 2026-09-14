import { useEffect, useState } from 'react';
import type { DetectedEndpoint } from '../../../shared/model-manager-types';
import { Button, FieldError, LoadingState, TextInput } from '../ui';
import { StatusStrip } from '../ui/StatusStrip';

/**
 * "Connect to an app on this computer" inside first-run local setup (Destin,
 * 2026-09-14): someone already running Ollama, LM Studio or another local
 * server gets YouCoded pointed at it instead of downloading a second copy.
 *
 * Reuses what Local Models settings already has: `models.detectEndpoints` finds
 * the servers it knows (Ollama, LM Studio today), and any other app is reached
 * through its OpenAI-compatible address — the same custom endpoint Settings adds.
 */

// WHY every action is the card's outlined pill: first-run rule, Destin 2026-09-14.
const PILL = 'px-6 py-3 rounded-full font-semibold text-base w-full';

const APP_NAME: Record<DetectedEndpoint['kind'], string> = { ollama: 'Ollama', lmstudio: 'LM Studio' };

export function LocalAppConnect({ onBack }: { onBack: () => void }) {
  const [hits, setHits] = useState<DetectedEndpoint[] | null>(null);
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);

  const detect = async () => {
    setHits(null);
    try { setHits(await (window as any).claude.models.detectEndpoints() as DetectedEndpoint[]); }
    catch { setHits([]); }
  };
  useEffect(() => { void detect(); }, []);

  const connect = (baseUrl: string, name: string) => {
    setConnectingTo(name);
    void (window as any).claude?.firstRun?.connectLocalApp?.(baseUrl, name);
  };

  const connectAddress = () => {
    const url = address.trim();
    // A shape check only — whether anything answers there is the backend's to report.
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setAddressError('Enter an address that starts with http://, like http://localhost:8080/v1');
      return;
    }
    connect(url, url);
  };

  if (connectingTo) {
    return (
      <div className="w-full flex flex-col items-center gap-4">
        <StatusStrip tone="busy" className="w-full" detail="YouCoded opens as soon as it answers.">
          Connecting to {connectingTo}…
        </StatusStrip>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col items-center gap-4">
      <div className="text-center">
        <p className="text-base font-medium text-fg">Use a model app on this computer</p>
        <p className="mt-1 text-sm text-fg-dim leading-relaxed">
          Already running Ollama, LM Studio or another model app? YouCoded can use it instead of downloading a model.
        </p>
      </div>

      {hits === null ? (
        <LoadingState what="model apps on this computer" verb="Looking for" />
      ) : hits.length === 0 ? (
        <p className="text-sm text-fg-dim text-center">No model apps found running right now.</p>
      ) : (
        <div className="flex flex-col items-stretch gap-3 w-full">
          <p className="text-2xs uppercase tracking-wide text-fg-muted text-center">Found on this computer</p>
          {hits.map((hit) => (
            <Button key={hit.baseUrl} variant="secondary" className={PILL} onClick={() => connect(hit.baseUrl, APP_NAME[hit.kind])}>
              Connect to {APP_NAME[hit.kind]}{hit.modelCount != null ? ` · ${hit.modelCount} ${hit.modelCount === 1 ? 'model' : 'models'}` : ''}
            </Button>
          ))}
        </div>
      )}

      <div className="w-full flex flex-col gap-1.5">
        <label htmlFor="first-run-local-app-address" className="text-xs text-fg-dim">Or enter its address</label>
        <TextInput
          id="first-run-local-app-address"
          size="md"
          className="w-full"
          placeholder="http://localhost:8080/v1"
          value={address}
          onChange={(e) => { setAddress(e.target.value); setAddressError(null); }}
        />
        {addressError && <FieldError as="p">{addressError}</FieldError>}
        <p className="text-2xs text-fg-muted">
          Works with any app that offers an OpenAI-compatible address, such as a llama.cpp server.
        </p>
      </div>

      <div className="flex flex-col items-stretch gap-3 w-full">
        <Button variant="secondary" className={PILL} onClick={connectAddress} disabled={!address.trim()}>
          Connect to this address
        </Button>
        {hits !== null && hits.length === 0 && (
          <Button variant="secondary" className={PILL} onClick={() => void detect()}>
            Check again
          </Button>
        )}
        <Button variant="secondary" className={PILL} onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}
