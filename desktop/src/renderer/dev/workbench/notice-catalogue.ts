// Every floating notice the app can raise, with its real words, for the waiting-notice review deck (2026-11-23).
// WHY a list here: most of these fire only after a failure deep in the code, so no click reaches them; ToastPractice raises each
// through the app's own announce() so the real notice draws it. Photo-only build only (index.tsx). Never ships.
// Words copied from the code on 2026-11-23 (catalogue in docs/active/design/2026-11-22-waiting-notice/notices.json).
// strip: where the notice now lives (the chat's own strip, raised through showChatNotice) with its tone, when it leaves and its buttons;
// null/absent: still a floating notice (untilClosed: stays until closed).
export interface PracticeNotice {
  id: string; text: string; button: string | null;
  strip?: { tone: 'warn' | 'error'; leave: 'resolved' | 'next-action'; buttons: string[] } | null;
  untilClosed?: boolean;
}
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
  "text": "Can't tell if your message was sent. Check the chat before sending it again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "resolved",
   "buttons": []
  }
 },
 {
  "id": "send-failed-generic",
  "text": "Your message wasn't sent. It's still in the box.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "resolved",
   "buttons": []
  }
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
  "text": "Can't tell if your message was sent. Check the chat before sending it again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "resolved",
   "buttons": []
  }
 },
 {
  "id": "queue-maybe-not-sent",
  "text": "Can't tell if your message was sent. Check the chat before sending it again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "resolved",
   "buttons": []
  }
 },
 {
  "id": "queue-outcome-unknown",
  "text": "Can't tell if your message was sent. Check the chat before sending it again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "resolved",
   "buttons": []
  }
 },
 {
  "id": "lost-send-restored",
  "text": "Your message wasn't sent. It's back in the box.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "resolved",
   "buttons": []
  }
 },
 {
  "id": "maybe-lost-send-restored",
  "text": "Can't tell if your message was sent. It's back in the box. Check the chat before sending it again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "resolved",
   "buttons": []
  }
 },
 {
  "id": "not-in-native-runtime",
  "text": "/doctor isn't available in YouCoded-runtime sessions yet.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "not-in-terminal-session",
  "text": "/compact isn't available in a terminal session — it's a Claude Code command.",
  "button": null,
  "strip": null
 },
 {
  "id": "skill-cant-start-native",
  "text": "That skill can't be started from here in a YouCoded-runtime session yet.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "open-conversation-first",
  "text": "Open a conversation first, then try again.",
  "button": null
 },
 {
  "id": "attachments-ignored",
  "text": "Attachments were left out of /compact.",
  "button": null,
  "strip": null
 },
 {
  "id": "no-response-to-copy",
  "text": "There's no reply to copy yet.",
  "button": null,
  "strip": null
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
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": [
    "Stop"
   ]
  }
 },
 {
  "id": "compact-nothing",
  "text": "Nothing to compact yet — there needs to be at least a couple of exchanges before there’s anything to summarize.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "compact-summary-failed",
  "text": "The model couldn’t write a usable summary, so the conversation was left intact. Try again later.",
  "button": null
 },
 {
  "id": "compact-not-live",
  "text": "This session isn't running, so there's nothing to compact.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
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
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": [
    "Stop"
   ]
  }
 },
 {
  "id": "clear-not-live",
  "text": "This session isn't running, so there's nothing to clear.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
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
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": [
    "Browse skills"
   ]
  }
 },
 {
  "id": "skill-unreadable",
  "text": "That skill is installed, but its instructions couldn't be read. Reinstalling it from the marketplace usually fixes this.",
  "button": null,
  "strip": {
   "tone": "error",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "skill-busy",
  "text": "Can't start a skill while your assistant is still working. Stop the current turn (or wait for it to finish) and try again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": [
    "Stop"
   ]
  }
 },
 {
  "id": "skill-not-live",
  "text": "This session isn't running, so there's nothing to run the skill in.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "skill-error-detail",
  "text": "Couldn't run /review: two skills match (a:review, b:review)",
  "button": null,
  "strip": {
   "tone": "error",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "skill-failed",
  "text": "Couldn't run /review.",
  "button": null,
  "strip": {
   "tone": "error",
   "leave": "next-action",
   "buttons": [
    "Try again"
   ]
  }
 },
 {
  "id": "terminal-waiting-for-answer",
  "text": "Claude’s terminal is waiting for an answer. Check it before sending this command.",
  "button": null
 },
 {
  "id": "claude-did-not-confirm",
  "text": "Can't tell if /compact went through. Check the chat before trying again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "control-unconfirmed",
  "text": "Can't tell if /compact went through. Check the chat before trying again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "clear-not-confirmed",
  "text": "Can't tell if /clear went through. Check the chat before trying again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "clear-outcome-unknown",
  "text": "Can't tell if /clear went through. Check the chat before trying again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "stop-not-confirmed",
  "text": "Can't tell if Stop went through. If Claude is still working, press Stop again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "stop-outcome-unknown",
  "text": "Can't tell if Stop went through. If Claude is still working, press Stop again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "stop-task-failed",
  "text": "Couldn't stop this task.",
  "button": null,
  "strip": null,
  "untilClosed": false
 },
 {
  "id": "model-switch-failed",
  "text": "Couldn't switch to Opus.",
  "button": "Try again",
  "strip": null,
  "untilClosed": true
 },
 {
  "id": "model-switch-failed-again",
  "text": "Couldn't switch to Opus again.",
  "button": "Report bug",
  "strip": null,
  "untilClosed": true
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
  "button": null,
  "strip": null,
  "untilClosed": false
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
  "button": null,
  "untilClosed": true
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
  "button": null,
  "strip": null,
  "untilClosed": false
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
  "id": "office-save-failed",
  "text": "An Office document couldn't be saved.",
  "button": "Open Office",
  "untilClosed": true
 },
 {
  "id": "remote-unsupported",
  "text": "Theme browsing only works on the computer running YouCoded for now.",
  "button": null,
  "untilClosed": false
 },
 {
  "id": "plugin-turned-off",
  "text": "We turned off a plugin that was found to be unsafe.",
  "button": "Show",
  "untilClosed": true
 },
 {
  "id": "settings-repaired",
  "text": "Your Claude Code settings couldn't be read, so YouCoded reset them. Your old settings are saved in a file.",
  "button": "Show file",
  "untilClosed": true
 },
 {
  "id": "tailscale-only",
  "text": "YouCoded only connects to your computer over Tailscale, and this address isn’t one. Turn on Tailscale on both devices and add the computer again using its Tailscale address.",
  "button": null,
  "untilClosed": true
 },
 {
  "id": "saved-password-rejected",
  "text": "Work PC didn't accept the saved password. Update it in Settings → Connect to Desktop.",
  "button": null,
  "untilClosed": true
 },
 {
  "id": "saved-password-none-set",
  "text": "Work PC has no remote access password set yet. Set one on that computer, in Settings → Remote access.",
  "button": null
 },
 {
  "id": "saved-password-expired",
  "text": "Work PC signed this phone out after 90 days without use. Enter the password again in Settings → Connect to Desktop.",
  "button": null,
  "untilClosed": true
 },
 {
  "id": "saved-password-refused-other",
  "text": "Work PC refused this sign-in.",
  "button": null,
  "untilClosed": true
 },
 {
  "id": "stop-not-sent-offline",
  "text": "Stop wasn't sent: you're offline. Press it again once you reconnect.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "stop-refused",
  "text": "Stop didn't go through. Press it again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "stop-unconfirmed-phone",
  "text": "Can't tell if Stop went through. If Claude is still working, press Stop again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": []
  }
 },
 {
  "id": "close-refused-detail",
  "text": "Couldn't close \"Bug hunt\": session is busy",
  "button": null,
  "strip": null,
  "untilClosed": false
 },
 {
  "id": "close-refused",
  "text": "Couldn't close \"Bug hunt\". Your computer didn't accept the request.",
  "button": null,
  "strip": null,
  "untilClosed": false
 },
 {
  "id": "close-unconfirmed",
  "text": "Couldn't close \"Bug hunt\" on your computer, so it's back in the list.",
  "button": null,
  "strip": null,
  "untilClosed": false
 },
 {
  "id": "mode-unconfirmed",
  "text": "The permission mode didn't change. Try again.",
  "button": null,
  "strip": {
   "tone": "warn",
   "leave": "next-action",
   "buttons": [
    "Try again"
   ]
  }
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
  "button": null,
  "strip": null,
  "untilClosed": false
 },
 {
  "id": "save-note",
  "text": "Couldn't save the note.",
  "button": null,
  "strip": null,
  "untilClosed": false
 },
 {
  "id": "save-change",
  "text": "Couldn't save this change.",
  "button": null,
  "strip": null,
  "untilClosed": false
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
