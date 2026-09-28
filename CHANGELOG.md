# Changelog

All notable changes to YouCoded are documented in this file.

## [Unreleased]

Betas run on the `1.3.1-beta` line; the next release after 1.3.0 is **1.3.1**.

## [1.3.0] — 2026-09-20

**Claude Code CLI baseline:** v2.1.278

Everything between v1.2.4 (18 May) and this release: 3,200-odd commits. The body of this
entry was written for the 2026-09-11 beta; **Since the beta** below covers the nine days
of beta builds (1.3.0-beta.72 through 1.3.1-beta.87) that finished it.

The headline is that YouCoded stopped being only a window onto Claude Code. It now has
an assistant of its own that can run a conversation, use tools, ask permission, hire
helpers and work offline on a model running on your own machine — while Claude Code
sessions keep working exactly as before. Around that: a project workspace with real file
viewers and editing, conversations that sync between your devices, sign-in with a ChatGPT
plan, a rebuilt marketplace, a four-game arcade, remote access you can use from a phone, a
first-run tour, and a security review whose fixes all landed before this build.

### The assistant of your own

- **A built-in assistant** — conversations can run inside YouCoded instead of through
  Claude Code, with the same chat, tools and files.
- **It asks before it acts** — a permission card names the tool and what allowing it
  permits. "Always allow" is remembered, can be scoped to exactly this command or the
  whole tool, and every standing grant is listed and revocable in Settings.
- **Reading never interrupts you** — reading, searching or listing a file outside the
  project no longer stops the assistant with a Yes/No card. Writing and editing still
  ask, and credential files stay blocked outright.
- **Helpers (specialists)** — the assistant can hire separate helper sessions with their
  own limited permissions, shown as cards in the chat. They run in the background, survive
  a restart, can be steered mid-run or interrupted, and can be defined by your own files.
  Each hire can use a cheaper or stronger model.
- **Web search and page reading** — with your own Tavily or Exa key, entered and tested in
  Settings.
- **Tools it can use** — commands (including long-running ones that outlive a single
  step), file search, reading images and PDFs, and tools from connected MCP servers.
- **Standing rules** — finish the job, don't act on a question, don't touch your uncommitted
  edits, look at visual output the way you will, and treat a fetched web page as
  information rather than instructions.
- **Skills you can call** — typing a skill name starts it as a labelled card instead of
  pasting thousands of characters into your message. Skills defined inside a project load.
- **A step guard you control** — how many steps a session may take is a setting, not a
  hidden rule.

### Models: your own machine, and your own plans

- **Local models** — browse a curated catalogue or search Hugging Face, see whether a model
  fits your graphics card, download it (resumable, checksum-verified), and chat fully
  offline. The engine installs, supervises and stops itself.
- **Per-model settings** — context length, how long it stays loaded, GPU layers and extra
  engine options, applied without restarting the engine.
- **A real memory estimate** — the fit warning reads the model file's own structure and
  scores it against the graphics chip actually present, instead of charging every model a
  flat 2 GB.
- **Faster, cheaper generation** — speculative decoding on by default (16 → 104 tokens/sec
  on a file rewrite, measured) and 8-bit conversation cache (about +40% speed and half the
  memory at 16k of context).
- **Vision models can see** — a model with a vision file downloads into the layout the
  engine will pair, an attached image reaches it, and an earlier download can be moved into
  that layout safely.
- **Graphics acceleration** — "Switch to CUDA" works on Windows without NVIDIA's toolkit
  installed, and AMD ROCm is an opt-in on Linux and Windows, described by measurement
  rather than a claim (about 20% faster reading a prompt, 24–46% slower writing replies).
- **Interrupted downloads** — a partial download is its own row with Resume and Delete, and
  can never be offered in the picker as if it were installed.
- **Sign in with ChatGPT** — use a ChatGPT plan's own models inside YouCoded, with the plan's
  models in the picker, usage bars labelled by the real window, and a card naming the reset
  when the plan runs out, with an Upgrade plan button.
- **Cheaper repeat requests** — prompt caching is actually requested from Anthropic,
  OpenRouter conversations are pinned to one session, and long conversations compact before
  anything is trimmed, so small models stop collapsing to the newest message.
- **Model names** — version numbers dropped ("Sonnet", not "Sonnet 4.6"), Fable added,
  and chips for DeepSeek, Meta Llama, Mistral, Perplexity and Cohere.
- **Gemini** — removed as a provider.

### Chat

- **"What the assistant was given"** — a line above every conversation, with a panel behind
  it, showing the instructions, rules, skills and tools it started with and what was left
  out. It turns amber mainly when a small model has had the entire skill list dropped.
- **Stop button and a message queue** — messages you send while it is still answering line
  up, where you can edit or cancel them before they go.
- **Deliverables** — files the assistant hands you render as a card with previews inside the
  reply; it can also hand you a link that opens in your browser.
- **Question cards** — "Other" with your own answer, or a note alongside the option you
  picked. Dismissing one ends the turn instead of telling the model to guess.
- **Find in chat** — Ctrl+F searches and highlights the whole conversation.
- **Chat Search** — a searchable index of past conversations, with Preview and Resume from a
  result, and tagging, noting and flagging from search.
- **Rename a conversation** — from the switcher's pencil, its right-click menu or the saved
  list, and a name you choose is never overwritten by automatic naming.
- **Automatic naming stops interrupting** — Off and Basic never interrupt a reply; the AI
  setting asks after the 1st, 3rd, then every 25th reply, instead of roughly six times a
  conversation.
- **Collapsible thinking**, clickable links and file paths everywhere, a copy button on every
  code block, and tool cards written in plain verbs ("Read foo.ts", past tense once done).
- **Right-click menus and flick scrolling** in the chat and message box.
- **App chrome can't be selected or copied** — select-all no longer paints titles, chips and
  buttons; file names inside messages stay copyable.
- **Fixed:** scrolling up mid-reply no longer yanks you to the bottom; a stalled provider
  parks the turn with a retry instead of losing it; turns no longer end silently empty;
  duplicate and missing messages after a reload or reconnect; approval prompts attaching to
  the wrong tool; the app recovering a conversation, model and permission mode after a
  display crash; the phantom "Compacted" message and the thinking state that never cleared;
  a stray Enter answering prompts for you; typing on a brand-new local-model session being
  told the session is dead.

### Sessions

- **Tags and notes** — your own coloured tags and freeform notes on any session, shown in
  the status bar, the resume list and the closing prompt, and searchable there.
- **Conversations that sync between devices** — saved with real titles and dates, resumable
  on another machine, with a clean takeover prompt when one is open elsewhere.
- **The resume browser** — a preview pane showing what was actually said before you go back
  in, with rename, tags and complete on a floating card; filter pills for projects and tags;
  chronological by default; year-long history retention.
- **Multi-window** — move a session to a new window or another window from its pill's menu,
  and on Linux/Wayland by dragging it onto another window's chat area. The moved session
  keeps its history.
- **Sessions without a folder** — a "No folder" choice that runs in an empty folder the app
  owns.
- **Fixed:** resuming opening in the wrong folder, sessions showing "Untitled" despite having
  names, the header stuck on "Resuming…", a resumed session spinning forever, transcripts
  mis-filed for folders with unusual characters, and a background session repointing the
  conversation you were looking at.

### Projects and files

- **Project View** — a hub per project with Files, Conversations and Instructions & Memories
  tabs, a project switcher, a description that syncs, and live counts that agree with each
  other.
- **A session file drawer** — every file a conversation created, edited, read or deleted,
  with previews, rename, find-in-file, reveal in folder, copy path, sort and filters.
- **Real file viewers** — spreadsheets (with formats, merged cells, formulas and sheet tabs),
  PDFs, Word documents, images, HTML as live pages, and code with syntax highlighting.
  Pictures and PDFs open up to 50 MB; large text opens as a readable beginning with the rest
  on request.
- **Editing in the app** — a real editor with save, unsaved-change warnings and a discard
  guard, plus zoom and a hover magnifier for images and PDFs.
- **Search inside files** — across the whole project, grouped by name matches and content
  matches.
- **Review and commit** — changed files, include-in-commit, message, commit, or discard with
  an explicit confirmation.
- **"Ask about this"** — right-click a selection in a file to ask about it, line numbers
  included.
- **Fixed:** importing a file onto itself deleting it; files inside a project being filed as
  outside files; "no longer on disk" flashing while loading; the Conversations and Context
  tabs coming up empty on Windows; file history no longer growing forever (30 days, with the
  10 most recent versions per file always kept).

### Backup and sync

- **Sync through your own GitHub account** — projects and conversations kept in step between
  your machines, with near-instant change signals, a devices list, dated snapshots and
  automatic pruning.
- **Connecting GitHub without the terminal** — sign in with a code; the app installs the
  GitHub tool itself on macOS and Linux where it is needed.
- **Honest status** — the panel turns green only on evidence of a completed sync, repairs
  half-finished setup itself, and clears its own stale warnings.
- **Removed:** restoring from a backup, pending a redesign.

### Marketplace and skills

- **Rebuilt marketplace** — a real catalogue of 4,100+ listings with origin badges, a "What
  this can do" panel before you install, visible trust information, and 👍/👎 with comments.
- **Update actually updates** — both on a card and in the Library's Updates tab; bundled
  skills upgrade themselves at launch.
- **Its own address** — the service moved to api.youcoded.ai, which also made its rate
  limiting work for the first time. Older installs keep working.

### Remote access

- **Use the app from a phone or another browser** — with projects and account available, a
  narrow-window layout, compression and caching for a faster first load.
- **Security batch 1** — your computer listens only on its Tailscale address, the password is
  always required (the "any tailnet address gets in free" bypass is gone), paired devices are
  named records with Online/Offline and an Unpair that revokes, and the status light reports
  whether the listener is actually up. **Every existing pairing must be re-paired once.**

### Games

- **A four-game arcade** — Connect 4 and chess against friends, Flappy and 2048 solo, with
  leaderboards and head-to-head records. Your player identity comes from your YouCoded
  sign-in.
- **Playable without a mouse** — Connect 4 columns are real buttons with announcements for
  assistive tech, and the chess board fits its pane.

### The buddy

- **Every mascot redrawn** in the promo film's warmer style, with eight expressions each,
  three new characters, a sleep pose, and one for every theme in the registry.
- **Better behaviour** — hover-revealed actions, snapping to the screen edge with a peek,
  smoother animation, and an opt-in helper that lets you drag him on KDE Wayland.
- **Fixed:** the docked buddy drawing two poses at once, a bad saved position parking him
  behind the taskbar, and the floater's Resume Session button being a placeholder.

### Getting started, and getting help

- **A first-run tour** — after setup the buddy walks eight stops through the real app, and it
  can be replayed from Settings.
- **Tips, empty screens and first-time warnings** — one tip per sitting with a switch to stop
  them, "Start your first session" on a new install, an explained empty Projects screen, and
  an I-understand checkbox the first time you use Skip Permissions or Full auto.
- **Help & feedback in Settings** — the tour, the tips switch, r/youcoded, the bug report and
  known issues.
- **Bug reports start from the error** you hit, show every piece of evidence before it leaves
  your machine, work with no AI at all, and keep your draft through a failure.
- **Crashes and freezes leave a record** on your own machine (never uploaded) and a line in
  the log a bug report attaches.
- **Seventeen false error messages fixed** — "Uploaded!" for a failed backup, "Nothing
  installed yet" when the list could not load, "Launch failed" for a failed download. Every
  error state now offers an action, with Retry last.
- **The assistant is "your assistant"** — about 45 references to "Claude" in the app's own
  wording now name the assistant you chose.

### Look and feel

- **One consistent control set** across the app — buttons, inputs, toggles, dropdowns, empty
  states, loading states, dialogs — and Settings as one uniform list of rows.
- **Assistant settings in one place** — Model Providers, Session Defaults, Permissions and
  Specialists became one panel, sitting directly under Account.
- **Themes** — preview cards in the picker, readable muted text in every built-in theme,
  correct glass on floating-chrome themes, a terminal that stays readable under wallpapers,
  and Reduced Effects that also stops animation a community theme adds.
- **New app and installer icons** — the waving purple mascot across Windows, Mac, Linux and
  Android, with the installer named and marked distinctly from the app.

### Speed

- **Huge conversations open fast** — about half a second instead of 20+ seconds, with history
  loaded a page at a time, and far-off messages folded to a placeholder so scrolling stays
  smooth.
- **The app stops running out of memory** on long conversations (it crashed six times in one
  day before this).
- **Project view stops chugging** — eight rapid tab clicks went from 7.1 seconds of
  unresponsiveness to none; a cold open from 2.1s to about 0.8s.
- **Resume browser** — a 42.6 MB conversation previews in 21 ms instead of stalling.
- **A six-minute freeze after taking a sync lease** is gone, marketplace, theme preview and
  resume reads no longer block the window, and the live transcript reader is capped so one
  huge conversation cannot stall the app.

### Security and privacy

- **Pre-launch security review, all fixes in this build** — a community theme or a document
  preview could run code with the app's powers; an "Always allow" command grant could be
  chained past; the assistant could read stored-credential files or leak them through
  automatically loaded chat images (now tap-to-show); remote access had no origin check and
  accepted one-character passwords (now an 8-character minimum with a Generate button).
- **Signed updates** — the app verifies a signed update before launching it, from the next
  signed release onward, and every download in a release is listed in a signed manifest so it
  can be checked for tampering or corruption.
- **The file write-guard ships inside the app** — the old separate plugin is removed on
  launch and never installed for new users.

### Installer and updates

- **Real Linux installers** — .deb, .rpm and .pacman alongside the AppImage.
- **The Update button works again** — GitHub moved where downloads are served from, which had
  been failing for everyone, and the Windows updater stopped re-downloading on every reopen.
- **Betas can update to the full release** — a beta now offers 1.3.0 when it ships and
  verifies it before installing. **Betas up to 1.3.0-beta.76 cannot: install this build or
  1.3.0 from youcoded.ai instead.**
- **macOS signature restored** — lost to a build-tool bump in July, which had made those
  builds unopenable.
- **Windows first-run install made resilient** — no duplicate installs from Retry, the
  install found after it completes, downloads retried, and antivirus file locks explained.

### Android

- **Honest builds** — phone builds carry a real version number (every earlier beta shipped as
  1.2.4), the app asks for notification permission after setup (so Android 13+ stops
  silently dropping every prompt), and an unsupported request refuses cleanly instead of
  crashing Project View.
- **Parity fixes** — the same conversation history, names and timestamps as desktop, working
  marketplace updates, and presence that no longer flaps.
- **Removed:** the phone-only restore-from-backup flow.
- **Relicensed from GPLv3 to MIT** — the whole repository is now MIT. The GPL label rested on
  a misreading of Termux's licence: its terminal-emulator library (the only Termux code the
  app contains) is carved out as Apache 2.0, and no other Android dependency is copyleft. The
  vendored library keeps its Apache 2.0 LICENSE and NOTICE. No runtime change.

### Website

- **youcoded.ai rebuilt** for 1.3, with recordings of the real app instead of drawings, a live
  embed of the interface, a phone layout, and scroll motion across the page.
- **The right download for your machine** — Mac visitors choose Apple silicon or Intel (an
  Intel Mac cannot open the Apple silicon build), and Linux visitors get their distribution's
  package.
- **Company and policy details** — Privacy and Terms linked from the site and Settings →
  About, naming Destin's Adventures, LLC (Arizona), with support@youcoded.ai as the contact.

### Also changed

- **Local models are freed less aggressively** — a model sleeps after 15 minutes idle (was 5)
  and the engine shuts down after 25 minutes without requests (was 10). The next message
  wakes either one.

### Since the beta (11–20 September)

- **Pages** — a Pages button beside Settings and Projects. Ask the assistant to build a page
  (a tracker, a dashboard, a reference sheet), pin up to four, and open one edge to edge.
  Desktop only.
- **Project Files browses one folder at a time**, so a project of any size or depth opens
  with no wait and no limit.
- **Sign in with OpenRouter**, and a clear message when an OpenRouter key does not work.
- **Get beta builds** (Settings → Development, and under the release notes in the version
  pill) — an opt-in channel that offers pre-release builds. Off for a release build, on for
  a beta build, until you choose.
- **Speed** — long lists draw only what is on screen, tab switches no longer pop content in,
  a streamed reply no longer redraws the window for every word, and background timers run
  only while something is listening.
- **Fixes** — the status bar's numbers stay right after a conversation is compacted;
  ChatGPT-plan chats no longer claim "Claude Code sessions only"; the permission chip shows
  the real mode and keeps it across a resume; a stray Enter cannot answer a card in a chat
  you cannot see; sync refuses over-limit files honestly; Linux recovers sign-in when the
  keychain unlocks late; expanding the file panel no longer blanks another chat; on Windows,
  adding a file over one of the same name no longer silently did nothing.
- **Release checks** — the installer launch check now confirms the app's window actually
  renders (it had been watching for an unrelated log line, and could not catch a blank
  window), and every build of this release ran its full test suite on Windows, macOS and
  Linux.

## [1.2.4] — 2026-05-18

**Claude Code CLI baseline:** v2.1.143

- **Bug reports include a system check** — what's installed and whether GitHub is reachable,
  with personal paths and tokens removed, shown to you before sending.
- **Anonymous usage counts no longer double-count reinstalls.** Still opt-out in Settings → About.
- **Privacy policy, terms and security policy** published.
- **Fixed:** Claude Code's suggested next prompt sometimes sent itself without you typing it;
  Linux gaps (Node.js auto-install, window buttons, installs on minimal, Alpine and fish-shell
  systems); bug-report tools failing on Windows; theme particles drawing under the header.

## [1.2.3] — 2026-05-01

**Claude Code CLI baseline:** v2.1.126

- **Fixed:** installing any marketplace plugin on Android failed with "Permission denied"
  since 1.2.0; installed plugins sometimes showing as not installed; false "still waiting"
  banners during long replies; skill cards flickering while a reply streamed; long links and
  paths overflowing chat bubbles.

## [1.2.2] — 2026-04-29

**Claude Code CLI baseline:** v2.1.123

- **Open Tasks** — a status-bar chip listing the session's active tasks.
- **Context popup** — compact or clear the conversation from the status bar, with a plain
  explanation of what context is.
- **Resume browser filters** — by project and tag, with sorting.
- **Auto permission mode**, where your plan and model allow it.
- **Android** — a new terminal that matches desktop, the back button closes popups first, and a
  phone-friendly marketplace.
- **Your own themes** appear in the Library with a "Local" badge.
- **Claude Code installs with Anthropic's own installer** on desktop.
- **Anonymous, opt-out usage counts** (no personal data; turn off in About).
- **Report a bug from inside the app** (Settings → Development).
- **Long messages send reliably** on Windows, plus about 50 smaller fixes.

## [1.2.1] — 2026-04-23

**Claude Code CLI baseline:** v2.1.119

- **Android** — the keyboard slides smoothly with the input bar, terminal keys became chips in
  the input bar, `git push` and Google Drive sign-in work, and the git-branch and model chips
  show correctly.
- **Fixed:** projects in folders with spaces or dashes in their names failing to open, sync or
  resume.

## [1.2.0] — 2026-04-22

**Claude Code CLI baseline:** v2.1.117

- **Update from inside the app** — the version pill shows what's new, then downloads and
  launches the installer.
- **Esc closes the top popup**, or stops Claude when no popup is open.
- **Ctrl+O** expands or collapses every tool card.
- **Clearer sync status** — one pill in the status bar, with the most serious problem shown.
- **Smoother buddy dragging.**
- **Fixed:** a crash that could empty the chat; the theme picker flickering after an install.

## [1.1.2] — 2026-04-21

**Claude Code CLI baseline:** v2.1.117

- **Theme Builder and the marketplace publisher come built in.**
- **Slash commands in the command drawer**, alongside skills.
- **Report a bug, contribute or see known issues** from Settings → Development.
- **Sync warnings come with a fix button**, and large uploads no longer time out.
- **Fixed:** the Windows app thinking it was Android (hiding theme backgrounds and limiting you
  to one session); Android remote pairing; helper instructions appearing in the chat as if you
  had typed them; several buddy and command-drawer glitches.

## [1.1.1] — 2026-04-20

**Claude Code CLI baseline:** v2.1.116

- **Desktop installers** — 1.1.0 shipped for Android only; this release adds Windows, Mac and
  Linux.
- **A new About popup**, and a restyled package picker on Android.

## [1.1.0] — 2026-04-20

**Claude Code CLI baseline:** v2.1.116

- **Buddy** — a mascot that floats above your desktop, shows when a session needs you, and opens
  a mini chat. Hidden from screen shares on Windows.
- **Helper work shows inside its card** — what a helper did appears as a timeline in the chat.
- **Sync warnings with fix buttons.**
- **Per-reply details** — model, token use and why a reply stopped, optional under each reply.
- **Each session keeps its own model.**
- **Faster with many sessions open.**
- **Fixed:** long pastes lost on Windows; messages sent twice in a row being dropped; rare lost
  messages; Android marketplace and theme installs.

## [1.0.1] — 2026-04-15

- **Fixed:** leftover old-name icons, and first-party plugins not recognised as such.

## [1.0.0] — 2026-04-15

First release under the YouCoded name.
