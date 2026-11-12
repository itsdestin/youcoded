// Which engine slot each local chat uses.
//
// WHY (2026-11-07): llama.cpp keeps what each of its slots last read, and a
// chat's next message reuses its slot's reading — the difference between a
// reply in seconds and a 20k-token re-read that takes minutes on a laptop
// chip. Left to choose, the engine sends a request to whichever slot's
// reading looks most like it, and every chat's opening shares the same
// instructions — so chats took each other's slots. Measured on the Z13 with
// three chats open: the model-loading "hi" landed on chat 2's warmed slot,
// chat 2's next message then took chat 3's, and re-read 22,225 tokens (193 s)
// instead of ~11. The app now names the slot itself (`id_slot`):
//   - each chat or helper (its session id) keeps one slot, most recently used
//     kept longest, so up to (slots − 1) chats keep their reading;
//   - everything that is not a chat — the model-loading request, the model
//     check, conversation titles — shares the LAST slot, so it never lands on
//     a chat's reading.
// Verified on b10665: `id_slot` is honoured ("selected slot by id"), and a
// number past the last slot is ignored rather than refused, so a wrong guess
// at the slot count costs only the pinning, never the request.

/** Before the engine has told us (it answers only once the model is loaded):
 *  what b10665's automatic `--parallel` gives. */
const DEFAULT_SLOTS = 4;

export class SlotPins {
  private counts = new Map<string, number>();
  /** model → (chat key → slot), in least- to most-recently-used order. */
  private pins = new Map<string, Map<string, number>>();

  /** The engine's real slot count for a model (from its /props). */
  setSlotCount(modelId: string, n: number): void {
    // Compared with the count IN USE (the default before the engine answered):
    // the engine confirming the default must not drop every chat's slot.
    if ((this.counts.get(modelId) ?? DEFAULT_SLOTS) === n) { this.counts.set(modelId, n); return; }
    this.counts.set(modelId, n);
    this.pins.delete(modelId); // slot numbers from the old count may not exist
  }

  /** Keys that belong to helper agents (specialist children), not to a chat
   *  the user opened. */
  private helpers = new Set<string>();

  /** The slot a request should use, or undefined to let the engine choose
   *  (a single-slot engine has nothing to protect). No key = not a chat.
   *
   *  WHY `helper` (2026-11-12, review deck Q-8): a helper agent has its own
   *  session id, so it used to count as a chat — one chat that started two
   *  helpers pushed the user's other two chats off their slots, and going back
   *  to either re-read everything for no reason the user could see. A helper
   *  may use a FREE slot or take another helper's, but never a chat's: with
   *  every slot held by chats it uses the shared spare instead (unpinned, so
   *  it re-reads more — the helper is slower, the user's chats are not). A
   *  chat that needs a slot takes a helper's before another chat's. */
  slotFor(modelId: string, key?: string, helper = false): number | undefined {
    const n = this.counts.get(modelId) ?? DEFAULT_SLOTS;
    if (n < 2) return undefined;
    const spare = n - 1;
    if (!key) return spare;
    let m = this.pins.get(modelId);
    if (!m) this.pins.set(modelId, (m = new Map()));
    const had = m.get(key);
    if (had !== undefined) {
      m.delete(key); // re-insert last: most recently used
      m.set(key, had);
      return had;
    }
    const used = new Set(m.values());
    let slot = -1;
    for (let s = 0; s < spare; s++) if (!used.has(s)) { slot = s; break; }
    if (slot < 0) {
      // Every chat slot taken. A helper's slot goes first (oldest helper);
      // only a CHAT may then take the chat used longest ago.
      let victim: string | undefined;
      for (const k of m.keys()) if (this.helpers.has(k)) { victim = k; break; }
      if (victim === undefined) {
        if (helper) return spare;
        victim = m.keys().next().value!;
      }
      slot = m.get(victim)!;
      m.delete(victim);
      this.helpers.delete(victim);
    }
    m.set(key, slot);
    if (helper) this.helpers.add(key); else this.helpers.delete(key);
    return slot;
  }
}

/** The request-body field naming a slot (llama.cpp `id_slot`), or nothing. */
export function slotField(slot: number | undefined): { id_slot?: number } {
  return slot === undefined ? {} : { id_slot: slot };
}
