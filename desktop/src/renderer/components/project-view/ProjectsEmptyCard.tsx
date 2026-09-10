// ProjectsEmptyCard — what the Projects screen shows when the index holds NO
// projects at all (first-run guide, spec §1 item 5 / §3 "Projects explainer").
// Someone who skipped the buddy's tour lands here with no idea what a project
// is, so this card says it in plain words, and offers exactly ONE thing to do.
//
// WHY a card of its own rather than the hero + tabs with zeros: three tabs
// with "0" badges over an empty grid is a dashboard for nothing — it reads as
// broken, not as "you haven't started". ProjectView swaps this in for the whole
// hero/seg-row/tab block, and keeps only the screen header (title + back).
//
// Surface: the same card species as the rest of the screen (guide §4.4 —
// `panel`, `edge`, radius `lg`), centred in the content area, capped at a
// reading width. NOT `.layer-surface`: that is radius-xl with a popup shadow
// and overflow:hidden, which reads as a floating overlay, not an in-flow card
// (ContextIntroBanner has to override its shadow for the same reason).
import { Button } from '../ui';
import { ThemeMascot, WelcomeAppIcon } from '../Icons';

interface ProjectsEmptyCardProps {
  /** Opens the existing add-project flow (ProjectView's AddProjectModal). */
  onAdd: () => void;
}

export function ProjectsEmptyCard({ onAdd }: ProjectsEmptyCardProps) {
  return (
    // Centring wrapper: fills the main column below the header so the card
    // sits in the middle of the screen on desktop. On a phone (the narrow
    // page-scroll layout) it sits near the top instead — vertically centring
    // in a viewport the keyboard or browser chrome can shrink jumps around.
    <div className="flex-1 flex items-center justify-center max-sm:items-start px-4 py-8 min-h-0">
      <div
        className="w-full max-w-[34rem] bg-panel border border-edge rounded-lg p-5 sm:p-6 flex flex-col items-center text-center gap-4 sm:flex-row sm:items-start sm:text-left"
        // The first-run tour's Files stop rings this card when there is no
        // project yet (the Files tab it would ring does not exist without one).
        data-guide-anchor="projects-empty"
      >
        {/* The buddy, in its welcome pose, beside the words — the same
            character that gives the tour, so a skipped tour still meets it
            here. Decorative: the text carries the meaning. small={false}
            because this is hero-sized art, not the 24px silhouette. */}
        <span aria-hidden="true" className="shrink-0 inline-flex">
          <ThemeMascot small={false} variant="welcome" fallback={WelcomeAppIcon} className="w-16 h-16 text-fg-dim" />
        </span>
        <div className="min-w-0 flex flex-col gap-3 items-center sm:items-start">
          <div>
            {/* Eyebrow: same micro-label as ContextIntroBanner's "About context",
                at the guide's text-2xs floor for anything that carries meaning. */}
            <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase mb-1">Projects</div>
            <h3 className="text-base font-semibold text-fg leading-snug">A project is a folder you keep coming back to</h3>
          </div>
          {/* Two plain sentences. "Files", never "artifacts" — user-facing copy. */}
          <p className="text-sm text-fg-2 leading-relaxed">
            The assistant keeps a project&rsquo;s instructions, memories and conversations
            together, and this screen lists the files it made there.
          </p>
          <p className="text-sm text-fg-2 leading-relaxed">
            Any folder can be one. Start with the one you work in most.
          </p>
          {/* The ONE primary on this screen (G-4). No second button on purpose. */}
          <Button variant="primary" onClick={onAdd} data-guide-anchor="add-project">
            Add a project
          </Button>
        </div>
      </div>
    </div>
  );
}
