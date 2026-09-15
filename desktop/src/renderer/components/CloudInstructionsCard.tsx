import React, { useState } from 'react';
import { CloudFileConsent, cloudConsentTransition, type CloudConsentPreview } from './project-view/CloudFileConsent';

/** WHY: required instructions belong to the waiting conversation, not Projects.
 * The parent supplies only a registered workbench fixture, never real startup. */
export function CloudInstructionsCard({ preview }: { preview: CloudConsentPreview }) {
  const folder = preview.folder || '/project';
  const [state, setState] = useState(preview.initial);
  return <div className="px-4 py-3" data-testid="cloud-instructions-card">
    <CloudFileConsent folder={folder} provider={preview.provider} state={state} onAction={(action) => {
      setState(cloudConsentTransition(state, action));
    }} />
  </div>;
}
