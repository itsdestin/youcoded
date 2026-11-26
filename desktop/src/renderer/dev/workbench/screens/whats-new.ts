// What is new in each screen state marked `newIn: 'after'`, in plain words, for the release comparison's
// "New since …" view (the work board's Screens tab).
//
// WHY (Destin, 2026-11-08: "entirely unclear why 'chat full screen' would be a 'new' page? clicking into it
// doesnt provide much clarity either"): a new situation's picture often shows an ordinary-looking screen with the
// new part small in one corner, and its short name ("Background expired Claude Code") says nothing to the owner.
// One sentence per state says what to look for. tests/shoot-screens.test.ts keeps this list and the `newIn`
// marks in step: every new state has a sentence, and every sentence belongs to a new state. Remove both after
// the next release ships (types.ts `newIn`).
export const WHATS_NEW: Readonly<Record<string, string>> = {
  // The chat
  'chat#background-expired-cc': 'A background "watcher" that reached its time limit now reads as finished, instead of "Watching" forever (in the activity line under the last reply).',
  'chat/background#cc-expired': 'In the Background commands list, a watcher that reached its time limit now shows as Finished.',
  'chat#browser-form': 'The assistant\'s browser filling in a form on a website.',
  'chat#web-visit': 'The question the built-in assistant asks the first time it wants to visit a website (top left of the chat).',
  'chat#grant-curl-download': '"Always allow" on a download command: the card explains what will be remembered (top left of the chat).',
  'chat#grant-curl-upload': '"Always allow" on a command that sends a file out: only that exact command is remembered, and the card says why.',
  'chat#grant-npm-install': '"Always allow" on installing a package: only that exact install is remembered, and the card says why.',
  'chat#grant-curl-redirect': '"Always allow" on a download that follows links to other sites: the choices it offers.',
  'chat#grant-curl-redirect-site': 'The same download, with "only from this one website" picked, and its small print.',
  'chat#grant-chain': '"Always allow" on a joined-up command (two commands in one): remember it word for word, or each part on its own.',
  'chat#grant-chain-risky': 'The same choice when one part of the joined-up command is risky: that part is only remembered word for word.',
  'chat#edit-ask': 'The ask before the assistant edits a file now has "Allow for this chat" (top left of the chat).',
  'chat#edit-choices': '"Always allow" on file edits: allow this one file or its whole folder.',
  'chat#outside-comments': 'The ask when the assistant wants to leave comments on a file outside the project.',
  'chat#outside-comments-cc': 'The same ask, in a Claude Code chat.',
  'chat#outside-comments-today-cc': 'The same ask in a Claude Code chat, after it was already allowed earlier today.',
  'chat#outside-comments-phone': 'The same ask, on a phone.',
  'chat/browser#protection-off': 'The browser panel\'s notice that its extra protection is off on this computer.',
  'chat/browser#protection-off-open': 'The same notice with its Details opened.',
  'chat/files#chip-missing': 'Clicking a file named in the chat that cannot be found: the files panel says where it looked.',
  'chat/files#chip-two-folders': 'Clicking a file name that two folders share: the files panel lists both.',
  'chat/update#older': 'An update refused because it is older than a version this computer already ran: its own sentence.',
  // Settings
  'settings/account#sign-out-everywhere': 'The new "Sign out everywhere" button\'s confirmation, in Edit account\'s Danger zone.',
  'settings/assistant/browser#form-sites': 'A new list, "Sites where it can send forms", near the bottom of the Browser settings.',
  'settings/assistant/permissions#never-ask-open': 'The "Commands that never ask" list, opened: the commands in plain words.',
  'settings/sync#repo-public': 'Backup paused because its GitHub repository is public: the sentence behind "Show details".',
  'settings/sync#repo-unconfirmed': 'Backup paused because the app could not confirm the GitHub repository is private.',
  'settings/sync#folder-untrusted': 'Backup paused because the folder came with hidden sync data the app did not make.',
  // The floating buddy
  'dev/buddy#chat-large': 'The buddy\'s chat window at its new, larger size.',
  'dev/buddy#chat-question-large': 'The buddy\'s chat window at its larger size, with a question waiting for an answer.',
  'dev/buddy#moods': 'The buddy\'s mood poses (happy, thinking, worried and others).',
  // Voice input
  'dev/overlay#voice-silent': 'Voice input that hears no sound: the amber "No sound detected" strip.',
  'dev/overlay#voice-no-sound': 'After recording with no sound: the card with the three likely reasons.',
  'dev/overlay#voice-too-quiet': 'After recording too quietly: the same card, saying it was too quiet.',
  'dev/overlay#voice-no-words': 'After recording with sound but no words: the same card, saying no words were heard.',
  // Using the app from a browser or phone
  'dev/gate#login-too-many': 'The browser sign-in after too many wrong passwords: its own message.',
  'dev/gate#login-expired': 'The browser sign-in when a saved sign-in timed out after 90 days unused.',
  'dev/gate#tailscale': 'The phone app refusing a computer that is not on Tailscale: its own message.',
  'dev/toast#lost': 'The notice when a message you sent did not reach the assistant.',
  // WHY these five: master's (card #213/#216) new pictures merged in; each needs its plain sentence (a test keeps newIn and this list in step).
  'dev/toast#turned-off': 'The heads-up shown after a plugin is switched off, with a Show button.',
  'dev/toast#turned-off-phone': 'The same plugin-switched-off heads-up on a phone.',
  'dev/toast#signed-out': 'The notice that you were signed out of your YouCoded account, with a button to sign in again.',
  'dev/toast#none': 'The same chat with no notice raised: how it looked before the signed-out notice existed.',
  'settings/sync#phone-additional-open': 'On a phone, the Additional backups row opened into its own list.',
  // Brought in by master after this list was written (merge of 2026-11-25).
  'chat#phone-browser-final': "On a phone, the ask before the assistant's browser takes a final step (buying, sending, posting): Yes and No.",
  'chat#phone-browser-handoff': "On a phone, the card that hands the assistant's browser over to you for a step it should not do itself.",
  'chat#phone-browser-site': "On a phone, the ask before the assistant's browser uses a website, with Always allow.",
  'chat#phone-pasted-picture': "On a phone, a picture pasted into the message box shows as a chip above it.",
  'chat#phone-slow': "On a phone, the strip shown when the computer is slow to answer.",
  'chat#phone-unreachable': "The same phone after about 20 seconds of silence: it says the computer may be asleep or off.",
  'chat#queue-waiting-long': "A long message waiting to be sent: its words are cut short in the waiting row.",
  'chat#queue-waiting-long-phone': "The same long waiting message on a phone.",
  'chat#queue-waiting-phone': "On a phone, a message waiting to be sent while the assistant is busy.",
  'chat#signin-back-cc': "A Claude Code chat whose sign-in ran out, a few seconds after pressing Sign in: the card once the browser step is over.",
  'chat#signin-offline-cc': "The same expired sign-in with no internet: pressing Sign in says why nothing opened.",
  'chat#signin-waiting-cc': "The same expired sign-in right after pressing Sign in: the card while it waits for the browser.",
  'chat/session-context#claude-code-global': "The context popup's Global tab in a Claude Code chat: what Claude Code does not share.",
  'chat/session-context#global': "The context popup's new Global tab: what the assistant reads before every chat, in every project.",
  'chat/session-context#global-engine': "The lower half of the Global tab: the engine's own instructions, tools and add-ons.",
  'chat/session-context#project': "The context popup's new Project tab: what the assistant reads before every chat in this project.",
  'dev/toast#action-failed': "The notice when a button's action fails (here, Copy path): one plain sentence.",
  'dev/toast#settings-repaired': "The one-time notice that a damaged Claude Code settings file was replaced, with a Show file button.",
  'dev/toast#settings-repaired-terminal': "The same settings-file notice shown over the terminal view.",
  'first-run#authenticate-offline': "First-time sign-in with no internet: pressing a sign-in button says why the browser stayed closed.",
  'marketplace/refresh-failed': "The marketplace when a refresh fails while the first list is still showing.",
  'projects#list-failed': "Projects when the project list itself could not be loaded: a notice with Try again.",
  'settings/about#stats-read-failed': "About, when the usage-stats setting could not be read: the row says so, with Try again.",
  'settings/assistant/cloud#claude-offline': "Cloud providers with Claude's sign-in expired and no internet: pressing Sign in says why.",
  'settings/assistant/local/gemma-terms': "The popup before downloading a Gemma model: its terms, with Cancel and Download.",
  'settings/remote#save-failed': "Remote access when turning the server on fails to save: a box under the switch says so, with Try again.",
};
