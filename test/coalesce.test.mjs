import test from 'node:test';
import assert from 'node:assert/strict';
import { joinMessages, createInbox, replayMessages, replayWakes } from '../lib/coalesce.mjs';
import { createWaker } from '../lib/pilot.mjs';

const sleep = (n) => new Promise((r) => setTimeout(r, n));

test('one message stays as it is; several become one turn that names each', () => {
  assert.equal(joinMessages(['  Salut ']), 'Salut');
  assert.equal(joinMessages([]), '');
  const j = joinMessages(['un', '', 'deux', 'trois']);
  assert.match(j, /^3 messages arrivés pendant ton tour/);
  assert.match(j, /### Message 1\nun\n\n### Message 2\ndeux\n\n### Message 3\ntrois$/);
});

test('the inbox holds what is written during a turn and sends it in one turn after', () => {
  const sent = []; let busy = false;
  const box = createInbox({ send: (t) => { sent.push(t); busy = true; }, busy: () => busy });
  assert.deepEqual(box.send('a'), { held: 0 }); assert.deepEqual(sent, ['a']);
  box.send('b'); box.send('c'); box.send('d');
  assert.equal(sent.length, 1, 'nothing leaves during the turn'); assert.deepEqual(box.held(), ['b', 'c', 'd']);
  busy = false; assert.equal(box.turnEnded(), 3);
  assert.equal(sent.length, 2); assert.match(sent[1], /^3 messages/);
  busy = false; assert.equal(box.turnEnded(), 0, 'an empty inbox sends nothing');
});

test('« Envoyer maintenant » cuts the turn once; the batch leaves when the cut turn ends', () => {
  const sent = []; let busy = true; let cuts = 0;
  const box = createInbox({ send: (t) => sent.push(t), busy: () => busy, interrupt: () => cuts++ });
  box.send('x'); const r = box.sendNow('y'); box.sendNow();
  assert.equal(cuts, 1, 'one interrupt'); assert.equal(r.cut, true); assert.equal(sent.length, 0);
  busy = false; box.turnEnded(); assert.equal(sent.length, 1); assert.match(sent[0], /^2 messages/);
  assert.deepEqual(box.sendNow('z'), { sent: 1, cut: false }, 'idle: it simply leaves');
});

test('the paper replay counts a turn saved per extra message written during the same turn', () => {
  const turns = [{ start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:05:00Z' }, { start: '2026-11-02T10:06:00Z', end: '2026-11-02T10:07:00Z' }];
  const msgs = ['10:00:00', '10:01:00', '10:02:00', '10:03:00', '10:05:30', '10:06:30'].map((h) => ({ at: `2026-11-02T${h}Z` }));
  const r = replayMessages(msgs, turns);
  assert.equal(r.queued, 4); assert.deepEqual(r.groups, [3]); assert.equal(r.saved, 2); assert.equal(r.turnsAfter, 4);
});

test('the paper replay of the wakes: events under 2 min 30 apart make one wake, a message of Dev wakes at once', () => {
  const at = (m) => new Date(Date.UTC(2026, 10, 2, 10, 0) + m * 60000).toISOString();
  const ev = [0, 1, 2, 10, 10.01, 30].map((m) => ({ at: at(m) }));
  const r = replayWakes(ev);
  assert.equal(r.before, 5, '10:10 and 10:10:00.6 share the debounce'); assert.equal(r.after, 3); assert.equal(r.avoided, 2);
  const u = replayWakes([{ at: at(0) }, { at: at(1), urgent: true }, { at: at(2) }]);
  assert.equal(u.after, 2, 'the message carries the first event; the next waits its window');
  const long = replayWakes(Array.from({ length: 12 }, (_, i) => ({ at: at(i * 2) })));
  assert.equal(long.after, 2, 'a stream never holds a wake more than 10 min'); assert.ok(long.waits.every((w) => w <= 600000));
});

test('the waker groups events in a window but a message of Dev wakes at once and carries them', async () => {
  const sent = []; let t = 0;
  const w = createWaker({ debounceMs: 5, eventWindowMs: 60, eventMaxMs: 150, start: () => ({ send: (p) => sent.push(p) }), collect: () => ({ prompt: 'p', cursor: 0 }), onCursor: () => {} });
  w.wake('/a', { urgent: false }); await sleep(30); w.wake('/a', { urgent: false }); await sleep(30);
  assert.equal(sent.length, 0, 'the window moves with each event'); await sleep(80);
  assert.equal(sent.length, 1, 'one wake for both'); w.turnEnded('/a');
  w.wake('/a', { urgent: false }); await sleep(10); w.wake('/a'); await sleep(20);
  assert.equal(sent.length, 2, 'the message did not wait the window'); w.turnEnded('/a'); await sleep(100);
  assert.equal(sent.length, 2, 'the event rode that wake');
  w.wake('/a', { urgent: false }); w.now('/a'); await sleep(10);
  assert.equal(sent.length, 3, '« Envoyer maintenant » does not wait the window'); w.turnEnded('/a');
  void t;
});

test('a stream of events wakes after eventMaxMs at most', async () => {
  const sent = [];
  const w = createWaker({ debounceMs: 5, eventWindowMs: 40, eventMaxMs: 100, start: () => ({ send: (p) => sent.push(p) }), collect: () => ({ prompt: 'p', cursor: 0 }), onCursor: () => {} });
  for (let i = 0; i < 6; i++) { w.wake('/b', { urgent: false }); await sleep(25); }
  assert.equal(sent.length, 1, 'woken once the 100 ms were up, while events still came'); w.reset('/b');
});
