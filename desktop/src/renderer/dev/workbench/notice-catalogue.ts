// Every floating notice the app can raise, with its real words, for the waiting-notice review deck (2026-11-23).
// WHY a list here: most of these fire only after a failure deep in the code, so no click reaches them; ToastPractice raises each
// through the app's own announce() so the real notice draws it. Photo-only build only (index.tsx). Never ships.
// Words copied from the code on 2026-11-23 (catalogue in docs/active/design/2026-11-22-waiting-notice/notices.json).
export interface PracticeNotice { id: string; text: string; button: string | null }
export const NOTICE_CATALOGUE: PracticeNotice[] = [
 {
  "id": "escape-didnt-close",
  "text": "Claude Code didn't close it — switch to terminal view to answer it. Your message is still here.",
  "button": null
 },
 {
  "id": "not-ready-to-send",
  "text": "This conversation is not ready to send yet. Your message is still here.",
  "button": null
 },
 {
  "id": "not-connected-message-kept",
  "text": "Not connected — your message is still here. Send it again when you reconnect.",
  "button": null
 },
 {
  "id": "not-connected-original-kept",
  "text": "Not connected — the original message is still here.",
  "button": null
 },
 {
  "id": "send-compacting",
  "text": "Conversation is compacting. Wait for it to finish, then send your message.",
  "button": null
 },
 {
  "id": "send-queue-full",
  "text": "Send queue is full (10 messages waiting). Wait for the current turn to finish.",
  "button": null
 },
 {
  "id": "send-changed",
  "text": "This conversation changed while your message was being prepared. Your message is still here.",
  "button": null
 },
 {
  "id": "send-starting-full",
  "text": "Starting up — the model is still loading, and ten messages are already waiting.",
  "button": null
 },
 {
  "id": "send-not-live",
  "text": "This session is no longer running. Start or resume it to send messages.",
  "button": null
 },
 {
  "id": "send-unconfirmed",
  "text": "YouCoded couldn't confirm your message was sent — check the conversation before sending it again.",
  "button": null
 },
 {
  "id": "send-failed-generic",
  "text": "The message could not be sent.",
  "button": null
 },
 {
  "id": "queue-not-answering",
  "text": "Claude Code isn't answering in this chat yet. Your message wasn't sent.",
  "button": null
 },
 {
  "id": "queue-refused",
  "text": "This chat couldn't take your message. Your message wasn't sent.",
  "button": null
 },
 {
  "id": "queue-availability-changed",
  "text": "Queue availability changed. Check the conversation before sending again.",
  "button": null
 },
 {
  "id": "queue-maybe-not-sent",
  "text": "Your message may not have been sent. Check the chat before sending it again.",
  "button": null
 },
 {
  "id": "queue-outcome-unknown",
  "text": "Message outcome is unknown. Check the queue and conversation before trying again.",
  "button": null
 },
 {
  "id": "lost-send-restored",
  "text": "An earlier message didn't reach your computer. It's back in the message box.",
  "button": null
 },
 {
  "id": "maybe-lost-send-restored",
  "text": "An earlier message may not have reached your computer. It's back in the message box — check the conversation before sending it again.",
  "button": null
 },
 {
  "id": "not-in-native-runtime",
  "text": "/doctor isn't available in YouCoded-runtime sessions yet.",
  "button": null
 },
 {
  "id": "not-in-terminal-session",
  "text": "/compact isn't available in a terminal session — it's a Claude Code command.",
  "button": null
 },
 {
  "id": "skill-cant-start-native",
  "text": "That skill can't be started from here in a YouCoded-runtime session yet.",
  "button": null
 },
 {
  "id": "open-conversation-first",
  "text": "Open a conversation first, then try again.",
  "button": null
 },
 {
  "id": "attachments-ignored",
  "text": "Attachments ignored with /compact",
  "button": null
 },
 {
  "id": "no-response-to-copy",
  "text": "No response to copy",
  "button": null
 },
 {
  "id": "copied-to-clipboard",
  "text": "Copied to clipboard",
  "button": null
 },
 {
  "id": "copy-failed-retry",
  "text": "Couldn't copy — please try again.",
  "button": null
 },
 {
  "id": "compact-busy",
  "text": "Can't compact while your assistant is still working. Stop the current turn (or wait for it to finish) and try again.",
  "button": null
 },
 {
  "id": "compact-nothing",
  "text": "Nothing to compact yet — there needs to be at least a couple of exchanges before there’s anything to summarize.",
  "button": null
 },
 {
  "id": "compact-summary-failed",
  "text": "The model couldn’t write a usable summary, so the conversation was left intact. Try again later.",
  "button": null
 },
 {
  "id": "compact-not-live",
  "text": "This session isn't running, so there's nothing to compact.",
  "button": null
 },
 {
  "id": "compact-interrupted",
  "text": "Compaction stopped. The conversation was left as it was.",
  "button": null
 },
 {
  "id": "compact-error-detail",
  "text": "Couldn't compact: model unavailable",
  "button": null
 },
 {
  "id": "compact-failed",
  "text": "Couldn't compact this conversation.",
  "button": null
 },
 {
  "id": "clear-busy",
  "text": "Can't clear while your assistant is still working. Stop the current turn (or wait for it to finish) and try again.",
  "button": null
 },
 {
  "id": "clear-not-live",
  "text": "This session isn't running, so there's nothing to clear.",
  "button": null
 },
 {
  "id": "clear-error-detail",
  "text": "Couldn't clear: write failed",
  "button": null
 },
 {
  "id": "clear-failed",
  "text": "Couldn't clear this conversation.",
  "button": null
 },
 {
  "id": "skill-not-a-skill",
  "text": "That isn't an installed skill, and it isn't a command YouCoded-runtime sessions support yet. Browse the marketplace to install skills.",
  "button": null
 },
 {
  "id": "skill-unreadable",
  "text": "That skill is installed, but its instructions couldn't be read. Reinstalling it from the marketplace usually fixes this.",
  "button": null
 },
 {
  "id": "skill-busy",
  "text": "Can't start a skill while your assistant is still working. Stop the current turn (or wait for it to finish) and try again.",
  "button": null
 },
 {
  "id": "skill-not-live",
  "text": "This session isn't running, so there's nothing to run the skill in.",
  "button": null
 },
 {
  "id": "skill-error-detail",
  "text": "Couldn't run /review: two skills match (a:review, b:review)",
  "button": null
 },
 {
  "id": "skill-failed",
  "text": "Couldn't run /review.",
  "button": null
 },
 {
  "id": "terminal-waiting-for-answer",
  "text": "Claude’s terminal is waiting for an answer. Check it before sending this command.",
  "button": null
 },
 {
  "id": "claude-did-not-confirm",
  "text": "Claude did not confirm this action. Check the conversation before trying again.",
  "button": null
 },
 {
  "id": "control-unconfirmed",
  "text": "This action could not be confirmed. Check the conversation before trying again.",
  "button": null
 },
 {
  "id": "clear-not-confirmed",
  "text": "Clear was not confirmed; queued messages remain paused.",
  "button": null
 },
 {
  "id": "clear-outcome-unknown",
  "text": "Clear outcome is unknown. Do not repeat it without checking the conversation.",
  "button": null
 },
 {
  "id": "stop-not-confirmed",
  "text": "Stop was not confirmed.",
  "button": null
 },
 {
  "id": "stop-outcome-unknown",
  "text": "Stop outcome is unknown. Check the conversation.",
  "button": null
 },
 {
  "id": "stop-task-failed",
  "text": "Couldn't stop this task.",
  "button": null
 },
 {
  "id": "model-switch-failed",
  "text": "Couldn't switch to Opus",
  "button": null
 },
 {
  "id": "model-switch-failed-again",
  "text": "Model switch failed again. Ask Claude to diagnose with /model, or report a bug.",
  "button": null
 },
 {
  "id": "save-fast-mode",
  "text": "Couldn't save Fast mode.",
  "button": null
 },
 {
  "id": "save-effort",
  "text": "Couldn't save the effort level.",
  "button": null
 },
 {
  "id": "reload-model",
  "text": "Couldn't reload the model.",
  "button": null
 },
 {
  "id": "plan-tier",
  "text": "Couldn't change the plan tier.",
  "button": null
 },
 {
  "id": "session-lost",
  "text": "You were signed out of your YouCoded account. Friends see you as offline until you sign in again.",
  "button": "Sign in again"
 },
 {
  "id": "live-handoff-unavailable",
  "text": "Live handoff is available from a computer or a remote connection to one.",
  "button": null
 },
 {
  "id": "finish-current-transfer",
  "text": "Finish the current conversation transfer, then try reopening this one again.",
  "button": null
 },
 {
  "id": "handoff-unconfirmed",
  "text": "Couldn't confirm the handoff from Work laptop.",
  "button": null
 },
 {
  "id": "resume-failed",
  "text": "Couldn't resume this conversation.",
  "button": null
 },
 {
  "id": "takeover-failed",
  "text": "Couldn't take over from your other computer. Close the conversation there, then try again.",
  "button": null
 },
 {
  "id": "download-unavailable",
  "text": "Download isn’t available here.",
  "button": null
 },
 {
  "id": "download-saving",
  "text": "Saving report.pdf to this device…",
  "button": null
 },
 {
  "id": "download-refused",
  "text": "Couldn’t download .env: it’s in a private location (like keys, passwords or .env files) that remote access never sends.",
  "button": null
 },
 {
  "id": "download-failed",
  "text": "Couldn’t download report.pdf.",
  "button": null
 },
 {
  "id": "picture-copy-failed",
  "text": "Couldn't copy that picture.",
  "button": null
 },
 {
  "id": "picture-save-failed",
  "text": "Couldn't save that picture.",
  "button": null
 },
 {
  "id": "copy-path",
  "text": "Couldn't copy the path.",
  "button": null
 },
 {
  "id": "open-file",
  "text": "Couldn't open the file.",
  "button": null
 },
 {
  "id": "remove-from-list",
  "text": "Couldn't remove this from the list.",
  "button": null
 },
 {
  "id": "load-whole-file",
  "text": "Couldn't load the whole file.",
  "button": null
 },
 {
  "id": "attach-pasted-image",
  "text": "Couldn't attach the pasted image.",
  "button": null
 },
 {
  "id": "open-file-picker",
  "text": "Couldn't open the file picker.",
  "button": null
 },
 {
  "id": "open-folder",
  "text": "Couldn't open the folder.",
  "button": null
 },
 {
  "id": "upload-too-large",
  "text": "That file is over 25 MB, the most a phone can send to the computer. Attach a smaller one.",
  "button": null
 },
 {
  "id": "upload-folder-full",
  "text": "The computer’s space for attachments is full right now. Try again in a little while, or attach fewer files.",
  "button": null
 },
 {
  "id": "upload-failed",
  "text": "Upload failed",
  "button": null
 },
 {
  "id": "plugin-turned-off",
  "text": "We turned off a plugin that was found to be unsafe.",
  "button": "Show"
 },
 {
  "id": "settings-repaired",
  "text": "Your Claude Code settings couldn't be read, so YouCoded reset them. Your old settings are saved in a file.",
  "button": "Show file"
 },
 {
  "id": "tailscale-only",
  "text": "YouCoded only connects to your computer over Tailscale, and this address isn’t one. Turn on Tailscale on both devices and add the computer again using its Tailscale address.",
  "button": null
 },
 {
  "id": "saved-password-rejected",
  "text": "Work PC didn't accept the saved password. Update it in Settings → Connect to Desktop.",
  "button": null
 },
 {
  "id": "saved-password-none-set",
  "text": "Work PC has no remote access password set yet. Set one on that computer, in Settings → Remote access.",
  "button": null
 },
 {
  "id": "saved-password-expired",
  "text": "Work PC signed this phone out after 90 days without use. Enter the password again in Settings → Connect to Desktop.",
  "button": null
 },
 {
  "id": "saved-password-refused-other",
  "text": "Work PC refused this sign-in.",
  "button": null
 },
 {
  "id": "stop-not-sent-offline",
  "text": "Not connected — Stop wasn't sent. Press it again once you're back online.",
  "button": null
 },
 {
  "id": "stop-refused",
  "text": "Stop didn't go through. Press it again.",
  "button": null
 },
 {
  "id": "stop-unconfirmed-phone",
  "text": "Your computer hasn't confirmed the stop. If the assistant is still working, press Stop again.",
  "button": null
 },
 {
  "id": "close-refused-detail",
  "text": "Couldn't close \"Bug hunt\": session is busy",
  "button": null
 },
 {
  "id": "close-refused",
  "text": "Couldn't close \"Bug hunt\". Your computer didn't accept the request.",
  "button": null
 },
 {
  "id": "close-unconfirmed",
  "text": "Couldn't confirm \"Bug hunt\" closed on your computer, so it is back.",
  "button": null
 },
 {
  "id": "mode-unconfirmed",
  "text": "The permission mode didn't change. Your computer didn't confirm it.",
  "button": null
 },
 {
  "id": "voice-ready",
  "text": "Voice is ready — tap the mic to talk.",
  "button": null
 },
 {
  "id": "copy-failed",
  "text": "Couldn't copy.",
  "button": null
 },
 {
  "id": "change-favorites",
  "text": "Couldn't change your favorites.",
  "button": null
 },
 {
  "id": "save-setting",
  "text": "Couldn't save this setting.",
  "button": null
 },
 {
  "id": "save-output-style",
  "text": "Couldn't save your output style.",
  "button": null
 },
 {
  "id": "save-system-prompt",
  "text": "Couldn't save your system prompt.",
  "button": null
 },
 {
  "id": "create-tag",
  "text": "Couldn't create the tag.",
  "button": null
 },
 {
  "id": "save-tag",
  "text": "Couldn't save the tag.",
  "button": null
 },
 {
  "id": "delete-tag",
  "text": "Couldn't delete the tag.",
  "button": null
 },
 {
  "id": "save-tag-change",
  "text": "Couldn't save this tag change.",
  "button": null
 },
 {
  "id": "save-note",
  "text": "Couldn't save the note.",
  "button": null
 },
 {
  "id": "save-change",
  "text": "Couldn't save this change.",
  "button": null
 },
 {
  "id": "open-link",
  "text": "Couldn't open the link.",
  "button": null
 },
 {
  "id": "open-browser",
  "text": "Couldn't open the browser.",
  "button": null
 },
 {
  "id": "open-page",
  "text": "Couldn't open the page.",
  "button": null
 },
 {
  "id": "open-setup-session",
  "text": "Couldn't open a setup session.",
  "button": null
 },
 {
  "id": "install-integration",
  "text": "Couldn't install Google Drive.",
  "button": null
 },
 {
  "id": "connect-integration",
  "text": "Couldn't connect Google Drive.",
  "button": null
 },
 {
  "id": "uninstall-integration",
  "text": "Couldn't uninstall Google Drive.",
  "button": null
 },
 {
  "id": "refresh-integrations",
  "text": "Couldn't refresh the integrations list.",
  "button": null
 },
 {
  "id": "refresh-project-list",
  "text": "Couldn't refresh the project list.",
  "button": null
 },
 {
  "id": "rename-project",
  "text": "Couldn't rename this project.",
  "button": null
 },
 {
  "id": "save-description",
  "text": "Couldn't save the description.",
  "button": null
 },
 {
  "id": "stop-syncing",
  "text": "Couldn't stop syncing this project.",
  "button": null
 }
];
