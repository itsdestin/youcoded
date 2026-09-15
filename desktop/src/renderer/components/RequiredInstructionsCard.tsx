import React, { useEffect, useState } from 'react';
import { CloudFileConsent } from './project-view/CloudFileConsent';

type Request = { id: string; sessionId: string; file: string; phase: 'ask' | 'denied' | 'waiting' };
/** Mounted in the affected conversation, not a blocking application dialog.
 * Pull on mount AND on invalidation: startup can park before this chat mounts. */
export function RequiredInstructionsCard({ sessionId }: { sessionId: string }) {
  const [requests, setRequests] = useState<Request[]>([]);
  useEffect(() => {
    let active = true;
    const api = (window.claude as any)?.artifacts;
    const refresh = () => {
      void Promise.resolve(api?.instructionDownloads?.(sessionId)).then(result => {
        if (active) setRequests(Array.isArray(result) ? result : []);
      }, () => { if (active) setRequests([]); });
    };
    const unsubscribe = api?.onInstructionDownloadsChanged?.(refresh);
    refresh();
    return () => { active = false; if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [sessionId]);
  if (!requests.length) return null;
  return <div className="px-4 pt-3 space-y-2">{requests.map(request =>
    <CloudFileConsent key={request.id} folder="" state={{ file: request.file, phase: request.phase, purpose: 'instructions' }}
      onAction={action => { void (window.claude as any).artifacts.answerInstructionDownload(request.id, sessionId, action); }} />
  )}</div>;
}
