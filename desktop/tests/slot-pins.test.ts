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

  it('the engine confirming the slot count it was assumed to have keeps every chat on its slot', () => {
    const p = new SlotPins();
    const a = p.slotFor('m', 'a');
    p.setSlotCount('m', 4);
    expect(p.slotFor('m', 'b')).not.toBe(a);
    expect(p.slotFor('m', 'a')).toBe(a);
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

// WHY (2026-11-12, review deck Q-8): a helper agent has its own session id and
// used to count as a chat, so one chat that started two helpers pushed the
// user's other chats off their slots.
describe('SlotPins — helper agents never take a chat\'s slot', () => {
  it('a helper uses a free slot when there is one', () => {
    const p = new SlotPins();
    p.setSlotCount('m', 4);
    p.slotFor('m', 'chat-a');
    expect(p.slotFor('m', 'helper-1', true)).toBe(1);
  });

  it('with every slot held by chats, a helper gets the shared spare and no chat moves', () => {
    const p = new SlotPins();
    p.setSlotCount('m', 4);
    const chats = ['a', 'b', 'c'].map((k) => p.slotFor('m', k));
    expect(p.slotFor('m', 'helper-1', true)).toBe(3);
    expect(['a', 'b', 'c'].map((k) => p.slotFor('m', k))).toEqual(chats);
  });

  it('a second helper takes the first helper\'s slot, not a chat\'s', () => {
    const p = new SlotPins();
    p.setSlotCount('m', 4);
    const a = p.slotFor('m', 'a');
    const b = p.slotFor('m', 'b');
    const h1 = p.slotFor('m', 'helper-1', true);
    expect(p.slotFor('m', 'helper-2', true)).toBe(h1);
    expect(p.slotFor('m', 'a')).toBe(a);
    expect(p.slotFor('m', 'b')).toBe(b);
  });

  it('a new chat takes a helper\'s slot before the oldest chat\'s', () => {
    const p = new SlotPins();
    p.setSlotCount('m', 4);
    const a = p.slotFor('m', 'a');   // the oldest chat
    p.slotFor('m', 'b');
    const h = p.slotFor('m', 'helper-1', true);
    expect(p.slotFor('m', 'c')).toBe(h);
    expect(p.slotFor('m', 'a')).toBe(a);
  });
});
