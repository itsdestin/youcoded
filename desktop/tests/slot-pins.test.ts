// Which engine slot each local chat keeps (engine/slot-pins.ts).
//
// WHY: measured with three local chats open, the engine's own choice put the
// model-loading request on one chat's warmed slot and that chat's next message
// on another's, re-reading 22,225 tokens (193 s) instead of ~11.
import { describe, it, expect } from 'vitest';
import { SlotPins, slotField } from '../src/main/engine/slot-pins';

describe('SlotPins', () => {
  it('a chat keeps the same slot from message to message', () => {
    const p = new SlotPins();
    const a = p.slotFor('m', 'chat-a');
    p.slotFor('m', 'chat-b');
    expect(p.slotFor('m', 'chat-a')).toBe(a);
  });

  it('requests that are not a chat share the last slot, which no chat is given', () => {
    const p = new SlotPins();
    p.setSlotCount('m', 4);
    expect(p.slotFor('m')).toBe(3);
    const chats = ['a', 'b', 'c', 'd', 'e'].map((k) => p.slotFor('m', k));
    expect(chats).not.toContain(3);
  });

  it('with every chat slot taken, the chat used longest ago gives its slot up', () => {
    const p = new SlotPins();
    p.setSlotCount('m', 3); // two chat slots
    const a = p.slotFor('m', 'a');
    const b = p.slotFor('m', 'b');
    p.slotFor('m', 'a'); // a used again, so b is now the oldest
    expect(p.slotFor('m', 'c')).toBe(b);
    expect(p.slotFor('m', 'a')).toBe(a);
  });

  it('models keep separate slots, and a one-slot engine is left to choose', () => {
    const p = new SlotPins();
    p.setSlotCount('solo', 1);
    expect(p.slotFor('solo', 'a')).toBeUndefined();
    expect(p.slotFor('solo')).toBeUndefined();
    expect(p.slotFor('m', 'a')).toBe(0);
  });

  it('only a known slot becomes a request field', () => {
    expect(slotField(undefined)).toEqual({});
    expect(slotField(2)).toEqual({ id_slot: 2 });
  });
});
