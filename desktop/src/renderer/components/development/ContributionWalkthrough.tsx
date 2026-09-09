import { useState } from 'react';
import { SettingRow } from '../ui';

export function ContributionWalkthrough() {
  const [expanded, setExpanded] = useState(false);
  return <div>
    {/* WHY: reuse the settings disclosure row, with a full click/tap target. */}
    <SettingRow title="How contributing works" expanded={expanded} onClick={() => setExpanded(!expanded)} />
    {expanded && <div id="contribution-walkthrough" className="space-y-3 mt-2 text-sm text-fg-2">
      <p>You don’t need to know how to code. Start with an idea, like clearer wording or an easier-to-use screen.</p>
      <ol className="list-decimal pl-5 space-y-3">
        <li><strong className="font-medium text-fg">Describe your idea</strong><p>The assistant reads the project’s shared guidance and checks the roadmap with you.</p></li>
        <li><strong className="font-medium text-fg">Review the design</strong><p>Choose what should change before anything is built.</p></li>
        <li><strong className="font-medium text-fg">Try an isolated preview</strong><p>A separate working copy keeps unfinished changes away from your installed app.</p></li>
        <li><strong className="font-medium text-fg">Check the result</strong><p>The assistant runs checks; you try the change and review what it does.</p></li>
        <li><strong className="font-medium text-fg">Choose whether to propose it</strong><p>Only your explicit approval sends a public proposal to GitHub. Maintainers decide whether to accept it.</p></li>
      </ol>
    </div>}
  </div>;
}
