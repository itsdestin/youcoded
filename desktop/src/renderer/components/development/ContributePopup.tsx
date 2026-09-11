// desktop/src/renderer/components/development/ContributePopup.tsx
//
// The entry point for "Contribute to YouCoded". Everything it does now lives in
// ContributionDesign; this file is the name the rest of the app imports.
//
// HISTORY (2026-09-10): this used to hold a second, legacy screen that cloned into
// a fixed ~/youcoded-dev via dev:install-workspace, pulled into that folder if it
// recognised the remote, and offered only "Done" when anything failed. It was
// replaced feature for feature — progress, the finished path, opening the project —
// by a setup that never touches an existing folder (contract R9), keeps running when
// you close the dialog (R10), and says why it stopped. The legacy screen was deleted
// rather than left unreachable behind a green suite.
//
// installWorkspace() itself still exists in main and is still reached by the legacy
// ticket flow's "Let Claude Try". Managed setup must never call it, and
// DevelopmentDesign.test.tsx pins that.
import { ContributionDesign } from './ContributionDesign';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ContributePopup(props: Props) {
  return <ContributionDesign {...props} />;
}
