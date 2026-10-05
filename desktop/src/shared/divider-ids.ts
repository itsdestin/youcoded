// The id of a "Conversation cleared" divider, built in ONE place.
//
// WHY shared (sync-fix6): the divider's id is what makes it draw exactly once. A Claude Code clear is announced by the computer's record
// (`session:live`, main/session-live.ts) with the NEW conversation's id; a native clear is announced by the same record with the transcript
// event's uuid, and a history page read off disk draws the same clear from that same event. Two spellings of the id in two files would
// draw the same line twice the day one of them changed, so main, the translator and the tests all call this.
export const clearDividerId = (id: string): string => `clear-${id}`;
