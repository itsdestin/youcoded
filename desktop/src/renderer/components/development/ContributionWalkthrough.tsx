import { FoldRow } from '../ui';

export function ContributionWalkthrough() {
  // WHY the shared FoldRow (submit-ticket-3): a fold opens INSIDE its own box (guide
  // "A folded box opens inside itself"); this hand-built one opened its steps below the row.
  return <FoldRow title="How contributing works">
    {/* WHY it scrolls (UX review U7): expanding the five steps overflowed the dialog,
        cutting step 4 in half and pushing the only button off the bottom — the design
        guide's own rule is that a scrolling surface must be reviewed at a height where
        it actually overflows, and this one never was. */}
    <div id="contribution-walkthrough" className="space-y-3 pl-1 pr-2 text-sm text-fg-2 max-h-[46vh] overflow-y-auto scroll-fade">
      <p>You don’t need to know how to code. Start with an idea, like clearer wording or an easier-to-use screen.</p>
      <ol className="list-decimal ml-5 space-y-3">
        <li><strong className="font-medium text-fg">Describe your idea</strong><p>The assistant reads the project’s shared guidance and checks the roadmap with you.</p></li>
        <li><strong className="font-medium text-fg">Review the design</strong><p>Choose what should change before anything is built.</p></li>
        <li><strong className="font-medium text-fg">Try an isolated preview</strong><p>Your assistant’s own copy of the code keeps unfinished changes away from your installed app.</p></li>
        <li><strong className="font-medium text-fg">Check the result</strong><p>The assistant runs checks; you try the change and review what it does.</p></li>
        <li><strong className="font-medium text-fg">Choose whether to propose it</strong><p>Only your explicit approval sends a public proposal to GitHub. Maintainers decide whether to accept it.</p></li>
      </ol>
    </div>
  </FoldRow>;
}
