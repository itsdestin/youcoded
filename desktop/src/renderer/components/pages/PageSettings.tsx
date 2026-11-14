// Page settings — one window per page (pages-finish deck 2, Q-settingswindow:
// "Each page gets one Settings window that replaces today's 'connections'
// window, opened from its card and its top band").
//
// WHY one window: every later step of finishing Pages (files, chat, assistants,
// spending, sharing) adds a section HERE instead of a popup of its own, so a
// person learns one place to see and stop what a page can do. Step 1 has two
// sections: what the page can reach, and the websites it may open without
// asking (deck 1, Q-popups). Later sections are added by their own steps — none
// is drawn empty ahead of time.
//
// Shape: Session details / the Marketplace detail pages (guide "Detail pages"):
// titled by kind, the page itself in the top card with no label, then a small
// label over one card per group. Settings save as you change them, so no Save.
import React, { useState } from 'react';
import type { PageSummary, PagesBridge } from '../../../shared/pages-types';
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Callout, Chip, SectionLabel, Tooltip } from '../ui';
import { Dialog } from '../ui/Dialog';
import { TrashIcon } from '../project-view/icons';
import { PageGlyph } from './page-icons';
import { CombinedRisk, ConnectionLine, FolderField, splitAddress } from './page-connections';
import { getCapabilities } from '../../platform';
import { publishPages } from './use-pages';
import { SettingRow, Toggle } from '../ui';
import { automationsBridge, publishAutomations, useAutomations } from '../automations/use-automations';
import { startWords } from '../automations/automation-words';
import { ChoicePill } from '../automations/AutomationPermissions';
import { isWorkbenchMode } from '../../workbench-mode';
import { AUTOMATIONS_PAGE_ID } from '../../../shared/automation-types';

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** Where the page lives, as the library card says it. */
function homeWords(page: PageSummary): string {
  return page.home.kind === 'personal' ? 'Personal' : page.home.kind === 'builtin' ? 'Built in' : page.home.name;
}

export function PageSettingsDialog({ page, onClose, onConnect, onEdit }: { page: PageSummary | null; onClose: () => void; onConnect: (pageId: string) => void; onEdit?: (page: PageSummary) => void }) {
  return (
    <Dialog screen="pages/library/settings" open={page !== null} onClose={onClose} layer={3} size="document" title="Page settings">
      {page && <PageSettingsBody page={page} onConnect={onConnect} onEdit={onEdit} />}
    </Dialog>
  );
}

/** Photo-only build: which part of Page settings a picture opens on. */
function photoView(): string | null {
  return isWorkbenchMode() ? new URLSearchParams(location.search).get('pagesSettingsView') : null;
}

function PageSettingsBody({ page, onConnect, onEdit }: { page: PageSummary; onConnect: (pageId: string) => void; onEdit?: (page: PageSummary) => void }) {
  const all = page.connections ?? [];
  // WHY files apart (deck 2 Q-settingswindow: sections for What it can reach, Files,
  // …): a page's own files are not a place it "reaches" on the network, and each
  // files line has its own things to change (the folder, the remembered files).
  const list = all.filter((c) => c.kind !== 'files');
  const files = all.filter((c) => c.kind === 'files');
  const sites = page.openSites ?? [];
  const foot = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (photoView() === 'foot') foot.current?.scrollIntoView({ block: 'end' }); }, []);
  return (
    <div className="flex flex-col gap-4" data-page-settings={page.id}>
      {/* The subject card: no label above it (guide "A label comes first" —
          the card about the popup's own subject is the exception). */}
      <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-3`}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="shrink-0 w-10 h-10 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-fg-2">
          <PageGlyph icon={page.icon} customIcon={page.customIcon} className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <div className="text-base font-semibold text-fg leading-snug break-words">{page.name}</div>
          <div className="flex items-center gap-1.5 overflow-x-auto scroll-mask-x">
            <Chip>{homeWords(page)}</Chip>
            <Chip>{list.length === 0 ? 'Reaches nothing outside' : list.length === 1 ? 'Reaches 1 thing' : `Reaches ${list.length} things`}</Chip>
          </div>
          {page.description && <div className="text-xs text-fg-muted leading-relaxed">{page.description}</div>}
        </div>
      </div>
      {/* WHY here (step 1 review, S-card-gear: "edit could probably become a
          button within settings instead of its own icon"): the card keeps two
          quick buttons, and changing the page sits with everything else about it.
          Outlined: it only opens more (guide "Buttons"). Full width, alone. */}
      {onEdit && (
        <Button variant="secondary" className="w-full" data-page-settings-edit onClick={() => onEdit(page)}>Edit in chat</Button>
      )}
      </div>

      <section className="flex flex-col gap-2">
        <SectionLabel>What it can reach</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
          {list.length === 0 && <div className="text-xs text-fg-muted">This page reaches nothing outside itself.</div>}
          {list.map((c) => <ReachRow key={c.id} page={page} c={c} onConnect={onConnect} />)}
          <CombinedRisk connections={all} openSites={sites} />
          {list.length > 0 && (
            <div className="text-xs text-fg-muted leading-relaxed">Saved keys are kept under Settings › Account › Connected services.</div>
          )}
        </div>
      </section>

      {/* Only for a page that asks for files: an empty section would be a promise of nothing. */}
      {files.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel>Files</SectionLabel>
          <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
            {files.map((c) => <ReachRow key={c.id} page={page} c={c} onConnect={onConnect} />)}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SectionLabel>Websites it opens without asking</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
          {sites.length > 0 && (
            // Short names in ONE shared box (guide: "Lists of short names").
            <div className={`${CARD_LEVEL_2} py-1`} data-open-sites>
              {sites.map((s) => <SiteRow key={s} page={page} site={s} />)}
            </div>
          )}
          <div className="text-xs text-fg-muted leading-relaxed">
            {sites.length > 0
              ? 'Links to any other website ask you first.'
              : 'None yet. Links to websites this page cannot already reach ask you first, and you can choose not to be asked again for a site.'}
          </div>
        </div>
      </section>

      <PageAutomations pageId={page.id} onOpen={onConnect} />
      <div ref={foot}><DeletePage page={page} /></div>
    </div>
  );
}

/** Pages-finish step 4 (design stage): this page's own automations, listed here as well as on the
 *  Automations page (Q-belongs). Only for a page that has some: an empty section is a promise of
 *  nothing. Each row's switch pauses it; the button opens Automations, where its settings are. */
function PageAutomations({ pageId, onOpen }: { pageId: string; onOpen: (pageId: string) => void }) {
  const { jobs } = useAutomations();
  // Every automation linked to this page, wherever it was made (plan deck Q-pagejobs).
  const mine = jobs.filter((j) => j.links.some((l) => l.kind === 'page' && l.id === pageId));
  if (mine.length === 0) return null;
  const setEnabled = async (id: string, on: boolean) => {
    const b = automationsBridge();
    if (b) publishAutomations(await b.setEnabled(id, on));
  };
  return (
    <section className="flex flex-col gap-2" data-page-automations>
      <SectionLabel>Automations</SectionLabel>
      <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-2`}>
        {mine.map((j) => (
          <SettingRow key={j.id} variant="item" title={j.name}
            description={j.waiting ? `Waiting for you: ${j.waiting.action}` : startWords(j.start)}
            control={<Toggle checked={j.enabled} onChange={(on) => void setEnabled(j.id, on)} aria-label={j.enabled ? `Pause ${j.name}` : `Turn on ${j.name}`} />} />
        ))}
        {/* UX review 1 U2: through onConnect, which closes this window first — otherwise it stayed over Automations. */}
        <Button variant="secondary" className="w-full" onClick={() => onOpen(AUTOMATIONS_PAGE_ID)}>Open in Automations</Button>
      </div>
    </section>
  );
}

/** Delete page, at the foot of Page settings (step 4d deck, Q-deletepage: "add a Delete page button in Page
 *  settings"; review deck 2026-11-10: deleting a page removes its versions and chats behind a danger confirmation).
 *
 *  WHY the same shape as Delete automation (approved, D-delete): a quiet red-outlined button at the right that
 *  turns into the red notice with Keep it / Delete inside, so the app has one way to delete a thing you made.
 *  WHY a Keep / Delete choice per automation (his answer): an automation linked to this page may still be wanted
 *  (it can serve another page too), so each is listed and decided on its own. One that only serves this page
 *  starts on Delete, because it has nothing left to work on; one shared with another page starts on Keep. */
function DeletePage({ page }: { page: PageSummary }) {
  // `?pagesSettingsView=delete` opens the warning directly in the workbench, so it is a screen of its own;
  // `=foot` only scrolls to the button (PageSettingsBody).
  const [asking, setAsking] = useState(() => photoView() === 'delete');
  const ref = React.useRef<HTMLDivElement>(null);
  // WHY: the warning is taller than the button it replaces and sits at the very foot, so without this its
  // Delete / Keep it buttons open below the edge of the window.
  React.useEffect(() => { if (asking) ref.current?.scrollIntoView({ block: 'end' }); }, [asking]);
  const { jobs } = useAutomations();
  const mine = jobs.filter((j) => j.links.some((l) => l.kind === 'page' && l.id === page.id));
  const [choice, setChoice] = useState<Record<string, 'keep' | 'delete'>>({});
  const others = (id: string) => mine.find((j) => j.id === id)?.links.filter((l) => !(l.kind === 'page' && l.id === page.id)) ?? [];
  const chosen = (id: string): 'keep' | 'delete' => choice[id] ?? (others(id).length > 0 ? 'keep' : 'delete');
  const remove = async () => {
    const b = bridge();
    if (!b?.deletePage) return;
    publishPages(await b.deletePage(page.id, mine.filter((j) => chosen(j.id) === 'delete').map((j) => j.id)));
    const a = automationsBridge();
    if (a) publishAutomations(await a.list());
  };
  if (!asking) return <div ref={ref} className="flex justify-end"><Button variant="danger-outline" size="sm" data-page-delete onClick={() => setAsking(true)}>Delete page</Button></div>;
  return (
    <div ref={ref}><Callout tone="danger" actionsPlacement="below" data-page-delete-confirm
      actions={<><Button variant="secondary" size="sm" onClick={() => setAsking(false)}>Keep it</Button><Button variant="danger" size="sm" onClick={() => { void remove(); }}>Delete</Button></>}>
      <div>Delete &ldquo;{page.name}&rdquo;? The page, its earlier versions and its chats are removed. This can&rsquo;t be undone.</div>
      {mine.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5" data-page-delete-automations>
          <div className="text-fg-2">Its automations</div>
          {mine.map((j) => (
            <div key={j.id} className={`${CARD_LEVEL_2} flex items-center gap-2 pl-3 pr-1.5 py-1.5`}>
              <span className="min-w-0 flex-1 flex flex-col">
                <span className="text-xs text-fg truncate">{j.name}</span>
                {others(j.id).length > 0 && <span className="text-2xs text-fg-muted truncate">Also used by {others(j.id).map((l) => l.name).join(', ')}</span>}
              </span>
              <ChoicePill name={j.name} value={chosen(j.id)} onChange={(v) => setChoice((m) => ({ ...m, [j.id]: v }))} choices={[['keep', 'Keep'], ['delete', 'Delete']]} />
            </div>
          ))}
        </div>
      )}
    </Callout></div>
  );
}

/** One thing the page can reach: its sentence, and Remove (or Connect when it
 *  is still waiting). Remove asks first, in place, because it cannot undo what
 *  was already sent (Remove "stops future use", never "revokes"). */
function ReachRow({ page, c, onConnect }: { page: PageSummary; c: NonNullable<PageSummary['connections']>[number]; onConnect: (pageId: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  // Files (step 2): change the folder, or forget one remembered file. Neither can
  // widen what the page reaches, so neither asks first.
  const changeFolder = async (): Promise<string | undefined> => {
    const b = bridge();
    const r = await b?.chooseFolder?.();
    if (r?.ok && b?.setFolder) { publishPages(await b.setFolder(page.id, c.id, r.token)); return undefined; }
    return r && 'message' in r ? r.message : undefined;
  };
  const forgetFile = async (fileId: string) => {
    const b = bridge();
    if (b?.forgetFile) publishPages(await b.forgetFile(page.id, c.id, fileId));
  };
  const remove = async () => {
    const b = bridge();
    if (!b?.removeConnection) return;
    publishPages(await b.removeConnection(page.id, c.id));
    setConfirming(false);
  };
  return (
    <div className={`${CARD_LEVEL_2} p-3 flex flex-col gap-2`} data-reach-row={c.kind}>
      <ConnectionLine c={c} small />
      {c.kind === 'files' && c.level === 'folder' && c.approved && (
        <FolderField folder={c.folder} canChoose={getCapabilities().openInOs} onChoose={changeFolder} />
      )}
      {c.kind === 'files' && c.level === 'remember' && c.approved && (
        (c.remembered ?? []).length === 0
          ? <div className="text-xs text-fg-muted">No files remembered yet.</div>
          // Short names in ONE shared box (guide "Lists of short names"), a bin on each.
          : <div className="flex flex-col py-0.5" data-remembered-files>
              {(c.remembered ?? []).map((f) => (
                <div key={f.id} className="flex items-center gap-2 py-0.5 text-xs text-fg">
                  <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
                  <Tooltip text="Forget this file" placement="bottom">
                    <Button size="icon-sm" variant="ghost" aria-label={`Forget ${f.name}`} className="hover:text-destructive-fg" onClick={() => { void forgetFile(f.id); }}>
                      <TrashIcon size={14} />
                    </Button>
                  </Tooltip>
                </div>
              ))}
            </div>
      )}
      {confirming ? (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-fg-2 leading-relaxed" data-remove-confirm>
            This stops future use. It cannot undo anything the page already sent or received. The page will ask again next time it opens.
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>Keep it</Button>
            <Button variant="danger" size="sm" onClick={() => { void remove(); }}>Remove</Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          {c.approved
            ? <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>Remove</Button>
            // Waiting for a yes: the page's own approval card is the one place
            // a connection is agreed to, so Connect opens the page.
            : <Button variant="primary" size="sm" data-connect onClick={() => onConnect(page.id)}>Connect</Button>}
        </div>
      )}
    </div>
  );
}

/** A site the page may open without asking. The bin takes it off the list, so
 *  its links ask again; nothing else changes, so it needs no confirmation. */
function SiteRow({ page, site }: { page: PageSummary; site: string }) {
  const { prefix, site: main } = splitAddress(site);
  const forget = async () => {
    const b = bridge();
    if (!b?.forgetOpenSite) return;
    publishPages(await b.forgetOpenSite(page.id, site));
  };
  return (
    <div className="group flex items-center gap-2 px-3 py-1.5 text-sm" data-open-site={site}>
      <span className="min-w-0 flex-1 truncate">
        {prefix && <span className="text-fg-dim">{prefix}</span>}
        <span className="text-fg">{main}</span>
      </span>
      <Tooltip text="Ask before opening" placement="bottom">
        <Button size="icon-sm" variant="ghost" aria-label={`Ask before opening ${site}`} className="hover:text-destructive-fg" onClick={() => { void forget(); }}>
          <TrashIcon size={14} />
        </Button>
      </Tooltip>
    </div>
  );
}
