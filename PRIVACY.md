# YouCoded Privacy Policy

**Effective date:** November 5, 2026

YouCoded is made and published by **Destin's Adventures, LLC**, an Arizona limited liability company. It is not affiliated with Anthropic or any other commercial entity. This page explains, in plain words, what information the YouCoded app sends off your device, who gets it, how long it is kept, and what you can switch off.

If anything here does not match what the app actually does, the app is wrong and should be fixed. Please tell us at support@youcoded.ai.

---

## 1. The short version

- **YouCoded does not receive your conversations.** What you type to an AI goes straight from your device to the AI company you chose (Anthropic through Claude Code, or OpenRouter, OpenAI, Google, or another service you set up). YouCoded's servers never see it.
- **The AI companies have their own rules.** They may keep, review or log what you send under their own terms. We cannot see or delete it.
- **Local models stay on your device.** If a model runs entirely on your computer, nothing is sent to a cloud AI company.
- **Your passwords and keys stay on your device.** Your AI sign-ins and API keys are stored on your device. (One exception, explained in 3.2: when you sign in to a YouCoded account, GitHub briefly hands our server a sign-in code for your public profile. We keep only your name, avatar and ID, never the code or your password.)
- **Everything is optional except a few quiet background checks.** Without a YouCoded account, the only things YouCoded's own servers learn about you are a once-a-day "this version of the app is being used" count (you can turn it off), and ordinary requests to read the marketplace list.
- **If you create a YouCoded account (by signing in with GitHub), more is stored about you:** your name and profile picture, your reviews and likes, your friends, and, if you turn on cross-device sync, the names of your computers. Sections 3.2 to 3.6 list all of it.
- **Your own sync and backup go to your own accounts**, not ours. But "your own accounts" can hold your conversations and project files, so please read 3.7.

---

## 2. What YouCoded does NOT receive

YouCoded's servers do **not** receive:

- What you type to an AI, or what the AI answers.
- The contents of your files, projects, journal, encyclopedia or notes.
- Your Claude, ChatGPT or other AI sign-in tokens, your API keys, or your passwords.
- Your email address or real name. (We receive your GitHub username and the display name and avatar on your GitHub profile if you sign in. If your GitHub profile shows your real name, we receive that.)
- Which plugins you run or which themes you wear. (If you are signed in, we do learn which plugins you have **installed** and which themes you **liked**. See 3.3.)

If you find something in the app that contradicts this list, treat it as a privacy bug and report it.

---

## 3. What YouCoded does collect, when, and why

### 3.1 A once-a-day "app is being used" count (on by default, you can turn it off)

**What it is:** Once per day, while the app is open, the app tells us one thing: "a device running version X, on this kind of computer, is in use." We use it to count how many devices are active, which versions people run, and roughly where. It does not count messages, sessions, or what you do in the app.

**What is sent:**

- A scrambled code made from your device's built-in ID. The app reads a hardware ID (Windows MachineGuid, macOS IOPlatformUUID, Linux `/etc/machine-id`, or Android's `ANDROID_ID`), mixes it with a fixed value built into the app, and runs a one-way scramble (HMAC-SHA256). Only the 64-character result is sent. The real hardware ID never leaves your device, and the code cannot be turned back into it. The fixed value is **not a secret**: it is written in the app's public source code. The code stays the same every day, so it lets us recognize the same device from day to day. That makes it a pseudonym, not fully anonymous.
- The app version, whether it is the desktop or Android app, and on desktop the system family (Windows, macOS or Linux).
- On computers that YouCoded's own developers mark as a *team device*, a `team` flag, so their use is left out of the counts.

**Two one-time messages:**

- **Setup progress, on a new install only.** Once each, with the same code, version and platform: that the app was opened for the first time, that setup finished, that a first message was sent, and, if a setup step failed, that step's name (for example `node`). Never the error text, file paths or anything you typed. Installs from before this was added never send them.
- **Turning the count off.** When you switch it off, the app sends one last notice saying so, with the version and platform but **without** the device code, and then nothing more.

**What our server adds:** Your country and region (for example, US state), worked out by Cloudflare from your internet address.

**Your internet address (IP address):** It is not saved in our analytics. It is used briefly to work out country and region. Two short-lived exceptions: to stop abuse, Cloudflare's cache keeps a counter keyed to your address for up to one day, and Cloudflare keeps ordinary server logs for the YouCoded service for 3 days (see section 4, Cloudflare).

**Where it goes and for how long:** Cloudflare's Analytics Engine, kept for 90 days, then it ages out. We use totals only; we do not sell or share them.

**Your control:** Settings → About → Privacy turns it off. When it is off, no code is made and nothing is sent.

**What we cannot do:** Because we cannot tell which row is yours, we cannot delete your rows on request. The 90-day limit and the switch are the protection.

**Your YouCoded account is never linked to this count.** The two systems share no identifier.

### 3.2 Your YouCoded account (only if you sign in)

Signing in is optional. You need it for reviews, likes, friends, games leaderboards and cross-device sync. Browsing the marketplace does not need it.

**How sign-in works:** You sign in with GitHub in your browser. GitHub gives our server a one-time code, our server trades it for a short-lived GitHub token with permission to read only your public profile (the "read:user" permission), looks up your profile, and does not keep the token. We never see your GitHub password or private repositories.

**What we store about you:**

- Your GitHub numeric ID and username, your display name and avatar picture link, and the handle you pick for YouCoded.
- When the account was created, and one "last seen" time (see 3.4).
- A sign-in record for each device you are signed in on (a scrambled form of its sign-in key, when it was created and last used). A sign-in ends after 90 days without use, and in any case 365 days after it began, even if you use it daily. The next app update adds a button to sign out of every device at once.
- While you are in the middle of signing in (about 15 minutes), a scrambled, time-limited marker of your internet address, used only to limit sign-in attempts. It is deleted when the sign-in attempt expires.

**How long:** Until you delete your account. In the app: Settings → Account → Delete account. It removes your account and everything listed in 3.2 to 3.6 straight away. You can download a copy first with Settings → Account → Download my data.

### 3.3 The marketplace: browsing, installs, reviews, likes

**Without an account:** Browsing the marketplace and themes, reading reviews, and downloading plugins send ordinary web requests to YouCoded's server (api.youcoded.ai) and to GitHub. Servers always see your internet address, app type and the page you asked for (ordinary server logs; see Cloudflare in section 4).

**With an account, we store:**

- **Installs.** Which marketplace plugins you have installed, linked to your account. The app reports this as you install, and re-reports your full list when you sign in. Counts shown in the marketplace are totals built from these records. *(An earlier version of this policy said install counts were not tied to a user. That was wrong for signed-in users.)*
- **Reviews, comments and thumbs.** Your star ratings, written reviews, comments and thumbs up or down on plugins, with the time. Reviews and comments are public. They show your display name and handle.
- **Theme likes.** Which themes you liked.
- **Reports.** If you report someone else's review: who, which plugin, your reason, and the result.
- **Automatic safety check on reviews and comments.** The text of each review or comment is sent to Cloudflare's AI service (a safety model) to decide if it should be hidden pending review. Hidden items can be seen by you and by the project owner.

**How long:** Until you delete your account (reviews, likes, installs and so on are deleted with it). Reports you filed are deleted with your account too.

### 3.4 Friends and "online" status (only if you use it)

If you add friends, the YouCoded server stores:

- Your friend list, pending friend requests (automatically removed after 90 days), and the people you have blocked. Only you can see your block list.
- **One "last seen" time** on your account.

**Online status.** While you are signed in and the app is open, your app keeps a live connection to our server so that **your friends, and only your friends**, can see that you are online, whether you are idle or in a game, and how recently you were last online. Friends also see your display name, handle and avatar. It is on automatically for signed-in users. We keep no history of when you were online, only the single latest "last seen" time. A device that goes quiet is shown as offline after about 10 minutes.

**Incognito.** Turning on incognito (per device) makes that device invisible to your friends: it does not show you as online, does not update "last seen", and cannot send or receive game challenges. You can still see which of your friends are online. If the server cannot confirm incognito is supported, the app does not connect at all rather than show you as online.

**Challenges.** A game invite you send is relayed through the server to the friend you invite, live. It is not stored.

**How long:** Until you delete your account, unfriend, or block (unfriending and blocking remove the link). Friend requests expire at 90 days.

### 3.5 Games

**Playing a live game (Connect 4, chess).** Your in-game name (your YouCoded display name, or your GitHub username if you have not set one) and your moves and in-game chat are relayed through a game room hosted on PartyKit (which runs on Cloudflare) to the other player. The room is discarded when the game ends. We do not save moves or chat.

**What IS saved (only if signed in).**

- **Solo game best scores** (for example Flappy and 2048). We keep your single best score for each game, when you set it, and how many runs you submitted. Your friends can see your best score on a friends-only leaderboard. Nobody else can.
- **Win/loss records against friends.** When you finish a Connect 4 or chess match against a friend, the result (who won, or a draw) is saved for both of you so a friend row can show "7–2 at chess". It is not a record of the moves.

**How long:** Until you delete your account. Unfriending does not remove your head-to-head record.

### 3.6 Your devices and cross-device sync

Cross-device sync is optional and has to be switched on. It needs a YouCoded account and a GitHub connection. It keeps your conversations, notes and chosen project folders the same on all of your computers.

**What the YouCoded server receives for this (a "live signal" connection, only while sync is on and you are signed in):**

- **Your computer's name** (the name your operating system gives it, such as "Destin's Z13" or "Sam's MacBook"). *This often contains a person's real name.* It is shown on your other devices in "Your devices".
- **A device ID** (a random ID the app creates for that computer).
- **Which sessions are open and which computer is holding each** (session IDs, the holding computer's name and ID, and a five-minute timer). This prevents two computers from continuing the same conversation at once and corrupting it.
- **A "something changed here" signal.** It carries the name of the sync repository that changed. For a project folder, that name is built from the **project's folder name** (lowercased and tidied) plus a short code, so a project called "Tax Return 2026" shows as "tax-return-2026" plus a code. For your Personal sync, it is a fixed name.
- **The time** of each device's most recent signal, so your other devices can show "last synced".

**What the server does not receive:** the contents of your conversations, files or projects. Those travel through your own private GitHub repositories (see 3.7), not through YouCoded's server.

**Who can see it:** Only your own signed-in devices receive these signals, and the project owner, who is the only person with access to YouCoded's servers, could technically see them. They are not shown to friends or other users.

**How long:** The server keeps the last 32 signals (so a device that reconnects can catch up), the most recent sync time for each device, and session records until they are released or replaced. These live in the account's own storage on Cloudflare. We do not run a regular cleanup on these records, but deleting your account erases all of them. Turning sync off stops new ones.

**Your control:** Turn off sync in Settings → Sync. Sign out to stop sending the device name and ID.

### 3.7 Backups and sync that go to YOUR accounts (not ours)

When you turn on sync or backup, copies of your data go to places **you** own:

- **Private GitHub repositories in your GitHub account** hold your synced spaces: your Personal space (which includes your conversation history, notes and the "Your devices" list with computer names) and each synced project folder. The repository names include your project folder names. Files over 50 MB, hidden build folders, and files that look like secrets (`.env`, `*.key`, `*.pem` and similar) are not synced.
- **Google Drive or iCloud**, if you choose them, hold daily backup copies of the same spaces.

YouCoded's servers are not a destination. But please remember: your **conversations are part of the Personal space**, so once sync is on they sit in your private GitHub repository and become subject to GitHub's terms and your GitHub account's security. Keep your GitHub account protected. The sign-in the app stores to do this (a GitHub token with permission to read and write your repositories) stays on your device.

### 3.8 Bug reports and feedback (only when you send one)

"Report a bug" creates a **public issue** on the YouCoded repository on GitHub. It is posted under your GitHub account (your GitHub username will show). It includes what you write, the app version, your system type and version, a short environment check (whether git and Claude Code are installed and their versions), and the last part of the app's log file. The app removes your home folder path and common GitHub and Anthropic key patterns from the log. It does **not** remove other kinds of keys, email addresses or project names. **You see the full text and can edit it before sending. Anything you leave in becomes public and stays on GitHub's servers; we may not be able to remove copies.** Please read the preview.

Optionally, an "improve my wording" button sends your description and log excerpt to Anthropic (through Claude Code on your device, under your own Anthropic account) to tidy the text.

### 3.9 Background lookups that carry nothing about you

These fetch public files. They do not send anything about you beyond what any web request carries (your internet address, and the app or browser name). The servers (mainly GitHub and Cloudflare) can log those requests under their own policies.

- **Updates (desktop).** Soon after launch and from time to time, the app asks GitHub for the newest version. By default it downloads and installs updates in the background, checking each download against a signed file. You can turn automatic installing off in the update popup or in Settings. The Android app does not update itself.
- **Announcements and changelog.** An announcement file is fetched from GitHub at launch and hourly while the app runs, and the changelog when you open it.
- **Marketplace, themes, integrations, model lists, search settings.** Public lists and files from `raw.githubusercontent.com` and `api.youcoded.ai` (marketplace), plus public model lists from `models.dev` and OpenRouter.
- **Theme fonts.** If a theme uses a Google web font in the document editors, the app downloads the font from Google Fonts.
- **Setup downloads.** First-run setup downloads Claude Code (from claude.ai), Node.js (nodejs.org), the GitHub command line tool and Git for Windows (from GitHub), and on Android runtime packages (Termux mirrors). Voice input and local-AI models are downloaded from Hugging Face, npm and GitHub, only if you choose them.

### 3.10 Features you choose that talk to other companies

Whatever you connect sends data to that company, under that company's policy:

- **AI providers** you add (Anthropic, OpenAI/ChatGPT, Google, OpenRouter, other endpoints): they receive your prompts and what you attach.
- **Web search** (DuckDuckGo by default, Exa or Tavily if you add a key): your search words.
- **The built-in browser**: websites you visit see you as any browser would.
- **Plaid** (banking page), **Google Drive via rclone**, **MCP servers**, **Home Assistant**, and other integrations: each receives what it needs to do the job.
- **Buy Me a Coffee**: opens in your browser if you choose to donate.

### 3.11 Remote access (off by default)

If you turn on remote access, your device serves the app to a browser on your network or over Tailscale. That traffic goes directly between your devices, not through YouCoded's servers. The connection is not encrypted by YouCoded; we recommend Tailscale for anything sensitive.

### 3.12 Website analytics (youcoded.ai)

The top-level landing page at `https://youcoded.ai/` sends a visit and cumulative counts of instruction opens and final installer-link clicks to `api.youcoded.ai`. Opening iOS instructions counts as an instruction open, not a download. Installer variants are grouped into Windows, macOS, Linux, and Android. Clicks do not prove download completion or installation. There is no periodic website heartbeat.

Attribution uses an owner-registered source/campaign pair from the link and a referring hostname, never the full referring URL or other query parameters. Invalid or unregistered pairs are untagged. Website analytics do not send message content, app device hashes, account identifiers, inferred visitor platform, or geography. Hosting and security providers still process network requests and may keep operational logs under their own policies; this is not a promise of no server logs.

Each page creates a random identifier in JavaScript memory. It is transmitted for initial admission, but the server stores only a secret-keyed HMAC-derived page key, not the raw random identifier. An opaque server capability lets the same open page update its cumulative counts without double-counting retries. This correlates updates from that page, including across midnight, but does not identify returning visitors across reloads or tabs. Reloading the page in the same tab continues the same visit: the opaque capability and that visit's counts so far (never the random identifier) are kept in that tab's sessionStorage, which the browser deletes when the tab closes, so refreshing does not count as a new visit. A new tab or a later visit starts a new, unconnected visit. Restoring the same document from the browser's back/forward cache also retains the same visit. No website journey identifier is saved in cookies, localStorage, or a URL. One visit counts at most five installer-link clicks.

All website visitor analytics records in the active database — daily aggregates, per-page deduplication snapshots, and supporting daily records — share a rolling **90 UTC-date history including today**. Scheduled cleanup removes expired records; outages can delay physical deletion. Reports and updates independently enforce the retained window. Cloudflare backups/Time Travel and operational logs have separate retention. Cloudflare documents a Time Travel recovery window of 7 days on Workers Free and 30 days on Workers Paid; see [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/). The 90-day active-database window does not promise instantaneous deletion from backups or operational logs. Owner-created campaign configuration is retained separately so shared links continue to work; it is not visitor history.

Anyone can stop their own browser from being counted by opening `https://youcoded.ai/?me` once; this saves a single "do not count this browser" flag in that browser's localStorage and nothing else (`https://youcoded.ai/?me=off` removes it). The site owner uses it to keep their own visits out of the numbers. Blocking scripts or requests, connection failures, bots, and collection limits affect coverage. Counts describe accepted page snapshots, not every person who visits. The app's analytics opt-out remains separate and is described in 3.1.

---

## 4. Other companies that handle data for YouCoded

Each has its own policy for what it does with the data it receives:

- **Cloudflare** hosts YouCoded's server, database, the live connections (online status, sync signals), the daily count store, the safety check on reviews, and the game rooms (through PartyKit). It sees every request, including your internet address, and keeps request logs. Cloudflare keeps YouCoded's server logs for 3 days. [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **GitHub** hosts the app's source code and releases, the marketplace and theme lists, and the sign-in; and it holds your private sync repositories and any bug report you send. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- **Anthropic**, **OpenAI**, **Google**, **OpenRouter** (and the models behind it) and other AI providers you choose receive your prompts. [Anthropic](https://www.anthropic.com/privacy), [OpenAI](https://openai.com/consumer-privacy/), [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection).
- **Google (Drive, Fonts)**, **Apple (iCloud)** if you choose them.
- **PartyKit** runs the live game rooms.
- **Hugging Face, npm, Node.js, Termux**: download sources for optional components.
- **Exa, Tavily, DuckDuckGo, Plaid** and any MCP servers or integrations you connect.

YouCoded does not sell data, run ads, or have commercial data partners. Within YouCoded, only the project owner can read the server's data.

---

## 5. How long things are kept

| What | Kept for |
|---|---|
| Daily device count (3.1) | 90 days |
| Website visit counts (3.12) | 90 days |
| Account, reviews, likes, installs, friends, scores, records, sync records (3.2 to 3.6) | Until you delete your account |
| Friend requests not answered | 90 days |
| "Last seen" time | Until you delete your account (one time, overwritten each time) |
| Sign-in on a device | Ends after 90 days without use, and at most 365 days after it began |
| Sign-in attempt marker (3.2) | About 15 minutes, then removed in the daily cleanup |
| Sync signals and session records (3.6) | Last 32 signals; most recent sync time per device; session records until released or replaced. All erased when you delete your account |
| Your handle after you delete or change it | Blocked from others for 30 days |
| Bug reports (3.8) | Public on GitHub until a maintainer removes them |
| Server request logs at Cloudflare | 3 days |

---

## 6. Your choices and rights

- **Turn off the daily count:** Settings → About → Privacy.
- **Go incognito:** hides your online status and "last seen" from friends (3.4).
- **Don't sign in:** most of the app, including the marketplace for browsing, works without an account.
- **Turn off sync:** stops device-name and session signals and sync to your repositories.
- **See your data:** Settings → Account → Download my data gives you a file with your account, installs, reviews, comments, thumbs, likes, reports, friends, requests, the blocks you made, and your game scores and records.
- **Delete your data:** Settings → Account → Delete account removes everything in 3.2 to 3.6 immediately. Questions: support@youcoded.ai.
- **Stop using YouCoded:** uninstalling stops everything. Existing counts age out in 90 days.
- **Children:** YouCoded is not for children under 13 and we do not knowingly collect their data. If you think a child has used it, contact us.
- **International:** Our servers run on Cloudflare's worldwide network and our code is on GitHub, so your data may be handled outside your country.

If you live in the EU, UK, California or another place with a privacy law, we intend to honor the rights it gives you. We are a very small project, but we will answer in good faith. Note: the daily count is **on by default**; if you are in a place that requires you to say yes first, please turn it off in Settings and tell us.

---

## 7. Security

We try to handle data carefully: secrets are in Cloudflare's secret store, API keys on your device are encrypted with your operating system's keychain, and the server updates itself through GitHub. We are a very small team and not a security company. To report a problem, see [SECURITY.md](./SECURITY.md).

---

## 8. Changes to this policy

When we change this policy we will update the **Effective date**, publish it in the YouCoded repository, and for important changes post an in-app announcement. The latest version is at `https://github.com/itsdestin/youcoded/blob/master/PRIVACY.md` and `https://youcoded.ai/privacy.html`. We will not start collecting more from data we already hold without first updating this policy.

---

## 9. Contact

Destin's Adventures, LLC, Arizona, United States.

- **Email:** support@youcoded.ai (subject line `[YouCoded Privacy] <short description>`)
- **Source code:** https://github.com/itsdestin/youcoded
- **Issues (non-sensitive, public):** https://github.com/itsdestin/youcoded/issues
- Security issues: [SECURITY.md](./SECURITY.md)
