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
import { Button, CARD_LEVEL_1, CARD_LEVEL_2, Chip, SectionLabel, Tooltip } from '../ui';
import { Dialog } from '../ui/Dialog';
import { TrashIcon } from '../project-view/icons';
import { PageGlyph } from './page-icons';
import { CombinedRisk, ConnectionLine, FolderField, splitAddress } from './page-connections';
import { getCapabilities } from '../../platform';
import { publishPages } from './use-pages';

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

function PageSettingsBody({ page, onConnect, onEdit }: { page: PageSummary; onConnect: (pageId: string) => void; onEdit?: (page: PageSummary) => void }) {
  const all = page.connections ?? [];
  // WHY files apart (deck 2 Q-settingswindow: sections for What it can reach, Files,
  // …): a page's own files are not a place it "reaches" on the network, and each
  // files line has its own things to change (the folder, the remembered files).
  const list = all.filter((c) => c.kind !== 'files');
  const files = all.filter((c) => c.kind === 'files');
  const sites = page.openSites ?? [];
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
    </div>
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
