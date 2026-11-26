// notice-words.ts — the shared sentences for "that can't be done", "didn't go through" and "can't tell if it did".
//
// WHY one file (Destin, waiting-notice deck R-words): notices that mean the same thing must say it in the SAME sentence,
// and a second sentence appears only when it changes what the person does (for example "you're offline, reconnect first").
// Before this, five different lines said "Stop didn't work" and three said "your message may not have been sent". Every
// sentence here is the wording approved on the deck's three lists (L-sort-failed, L-sort-cant, R-unsure); technical text
// from the computer is never shown, it goes to the console at the place that received it.

/** "Can't tell if <subject>. <advice>" — the one shape for every "it may or may not have gone through". */
const cantTell = (subject: string, advice: string): string => `Can't tell if ${subject}. ${advice}`;

/** "<What> didn't go through. <advice>" — it is known not to have happened. */
const didntGoThrough = (what: string, advice: string): string => `${what} didn't go through. ${advice}`;

// ---- Sending a message ----
const CHECK_BEFORE_RESEND = 'Check the chat before sending it again.';
/** One sentence for every unsent-or-maybe-sent message: send-unconfirmed, queue-maybe-not-sent, queue-outcome-unknown, queue-availability-changed. */
export const MESSAGE_UNSURE = cantTell('your message was sent', CHECK_BEFORE_RESEND);
/** The same, when the words have also been put back in the message box. */
export const MESSAGE_UNSURE_BACK_IN_BOX = `${cantTell('your message was sent', "It's back in the box.")} ${CHECK_BEFORE_RESEND}`;
/** Known not sent; the words are still in the box (send-failed-generic). */
export const MESSAGE_NOT_SENT = "Your message wasn't sent. It's still in the box.";
/** Known not sent; the words came back into the box (lost-send-restored). */
export const MESSAGE_NOT_SENT_BACK_IN_BOX = "Your message wasn't sent. It's back in the box.";

// ---- /compact, /clear, /model ----
/** One sentence for every unconfirmed command, naming it ("/compact"). */
export const commandUnsure = (command: string): string => cantTell(`${command} went through`, 'Check the chat before trying again.');
/** The command was refused outright (the computer said no): nothing happened, so say so and offer the retry. */
export const commandRefused = (command: string): string => didntGoThrough(command, 'Try again.');

/** A queued message's Cancel / Send now / checkout that the computer did not confirm (its own text goes to the console). */
export const QUEUE_ACTION_UNSURE = cantTell('that change to your queued message went through', 'Check the chat before trying again.');

// ---- Stop ----
const STOP_AGAIN = 'If Claude is still working, press Stop again.';
/** One sentence for every unconfirmed Stop (five used to differ). */
export const STOP_UNSURE = cantTell('Stop went through', STOP_AGAIN);
export const STOP_REFUSED = didntGoThrough('Stop', 'Press it again.');
/** The offline detail stays because it changes what you do: reconnect first. */
export const STOP_OFFLINE = "Stop wasn't sent: you're offline. Press it again once you reconnect.";

// ---- Phone: permission mode, closing a chat, switching model ----
export const MODE_UNCHANGED = "The permission mode didn't change. Try again.";
export const closeUnconfirmed = (label: string): string => `Couldn't close ${label} on your computer, so it's back in the list.`;
export const modelSwitchFailed = (model: string): string => `Couldn't switch to ${model}.`;
export const modelSwitchFailedAgain = (model: string): string => `Couldn't switch to ${model} again.`;

// ---- Can't be done here or now ----
export const commandNotInNativeChat = (command: string): string => `${command} isn't available in YouCoded-runtime sessions yet.`;
export const SKILL_CANT_START_NATIVE = "That skill can't be started from here in a YouCoded-runtime session yet.";
const WAIT_OR_STOP = 'Stop the current turn (or wait for it to finish) and try again.';
/** "Can't compact while your assistant is still working. …" — `doing` is "compact", "clear" or "start a skill". */
export const busyWith = (doing: string): string => `Can't ${doing} while your assistant is still working. ${WAIT_OR_STOP}`;
/** "This session isn't running, so there's nothing to compact." */
export const notRunning = (nothingTo: string): string => `This session isn't running, so there's nothing to ${nothingTo}.`;
export const NOTHING_TO_COMPACT = 'Nothing to compact yet — there needs to be at least a couple of exchanges before there’s anything to summarize.';
export const NOT_AN_INSTALLED_SKILL = "That isn't an installed skill, and it isn't a command YouCoded-runtime sessions support yet. Browse the marketplace to install skills.";

// ---- /compact or /clear failed after it ran (the card in the chat) ----
/** The words on the in-chat card. A reason we recognise gets its own sentence; otherwise the plain line, and the computer's reason (if any) sits under Details. */
const COMPACT_SUMMARY_FAILED = 'The model couldn’t write a usable summary, so the conversation was left intact. Try again later.';
const COMPACT_INTERRUPTED = 'Compaction stopped. The conversation was left as it was.';
export const controlFailureWords = (op: 'compact' | 'clear', why?: 'summary-failed' | 'interrupted'): string =>
  why === 'summary-failed' ? COMPACT_SUMMARY_FAILED : why === 'interrupted' ? COMPACT_INTERRUPTED : `Couldn't ${op} this conversation.`;

// ---- A skill that could not run ----
export const SKILL_UNREADABLE = "That skill is installed, but its instructions couldn't be read. Reinstalling it from the marketplace usually fixes this.";
export const skillFailed = (skill: string): string => `Couldn't run /${skill}.`;
/** Two skills with one name: the one detail that tells you what to do, so it is kept. */
export const skillAmbiguous = (skill: string, detail: string): string => `Couldn't run /${skill}: ${detail}`;

// ---- The command drawer and skills list: what can't start in this chat (waiting-notice T5) ----
/** The reason line on a greyed skill: it is a plain prompt, and a YouCoded-runtime chat can only start skills by name. */
export const SKILL_NOT_HERE_NATIVE = 'Not available in YouCoded-runtime sessions yet.';
/** The mark on a skill whose instructions can't be opened. */
export const SKILL_UNREADABLE_MARK = "Its instructions can't be read. Reinstall it from the marketplace.";
/** The question when two installed skills share a name. */
export const skillWhichOne = (skill: string): string => `Two skills are called /${skill}. Which one did you mean?`;

// ---- Sentences that used to sit beside the code that raised them (moved here with NO wording change, review consolidation) ----
/** A send the app knows was refused for a stated reason: held back, the words stay. The keys ARE the reasons that count as "held back" (native-send-copy). */
export const SEND_HELD_BACK = {
  compacting: 'Conversation is compacting. Wait for it to finish, then send your message.',
  'queue-full': 'Send queue is full (10 messages waiting). Wait for the current turn to finish.',
  changed: 'This conversation changed while your message was being prepared. Your message is still here.',
  initializing: 'This conversation is not ready to send yet. Your message is still here.',
  starting: 'Starting up — the model is still loading, and ten messages are already waiting.',
  'not-live': 'This session is no longer running. Start or resume it to send messages.',
} as const;
/** Claude Code's queue is not ready yet (retryable): nothing was sent. */
export const CHAT_NOT_ANSWERING = "Claude Code isn't answering in this chat yet. Your message wasn't sent.";
/** The chat refused the message outright: nothing was sent. */
export const CHAT_COULDNT_TAKE_MESSAGE = "This chat couldn't take your message. Your message wasn't sent.";
/** Resuming/handing off a chat when this device cannot do a live handoff. */
export const LIVE_HANDOFF_UNAVAILABLE = 'Live handoff is available from a computer or a remote connection to one.';
export const HANDOFF_TAKEOVER_FAILED = "Couldn't take over from your other computer. Close the conversation there, then try again.";
/** R-fyi (approved row W-asked/fyi): a command ran but its attachments were not part of it. Short floating notice. */
export const attachmentsLeftOut = (command: string): string => `Attachments were left out of ${command}.`;
/** R-fyi: /copy with nothing to copy yet. Short floating notice. */
export const NO_REPLY_TO_COPY = "There's no reply to copy yet.";
