#!/usr/bin/env node
// Phase 14 RAF, the measure (docs/frugal.md « Les rafales »): the real conversations of 1 and 2 November replayed on paper.
//   node scripts/measure-rafale.mjs [--db sessions.sqlite] [--projects ~/.claude/projects] [--days 2026-11-01,2026-11-02]
// Read only: the database opens readOnly, the transcripts are streamed. Prints one JSON.
//   A. Dev's Claude Code conversations in the Escadrille folder (entrypoint cli): the messages written while a turn ran,
//      one turn each against one turn per group, and the context one turn reads again (its first call)
//   B. the plan sessions (sessions.session_id): the developer's messages of session_messages against the turns of their transcript
//   C. the pilot's wakes on 2 November: the log's events (lib/pilot.mjs eventsOf, the phase-13 filter « travaille encore »),
//      urgent when a message of Dev, debounce 1.5 s against the window of 2 min 30
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { humanText } from '../lib/mainchat.mjs';
import { eventsOf } from '../lib/pilot.mjs';
import { priceOf } from '../lib/usage.mjs';
import { replayMessages, replayWakes, EVENT_WINDOW_MS } from '../lib/coalesce.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = path.dirname(new URL(import.meta.url).pathname);
const DB = arg('db', path.join(HERE, '..', 'sessions.sqlite'));
const ROOT = arg('projects', path.join(homedir(), '.claude', 'projects'));
const DAYS = arg('days', '2026-11-01,2026-11-02').split(',');
// A day in Paris (CET, UTC+1 after 25 October)
const span = (d) => [Date.parse(d + 'T00:00:00+01:00'), Date.parse(d + 'T24:00:00+01:00')];
const inDays = (t) => DAYS.some((d) => { const [a, b] = span(d); const x = Date.parse(t); return x >= a && x < b; });
const dayOf = (t) => DAYS.find((d) => { const [a, b] = span(d); const x = Date.parse(t); return x >= a && x < b; });
const ENDS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

// The turns of a transcript and its human messages. A turn starts at a human prompt while idle and ends at the answer
// whose stop_reason closes it; a human line during a turn (a queued command, a prompt typed while busy) is a message
// written during the turn. first: the context the turn's first call read (input + cache creation + cache read).
const readTranscript = async (file) => {
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const turns = []; const human = []; let cur = null; let entrypoint = null; let model = null; const seenIds = new Set(); const last = new Map();
  const addHuman = (text, at) => { const p = last.get(text); if (p !== undefined && Math.abs(Date.parse(at) - p) < 120000) return; last.set(text, Date.parse(at)); human.push({ at, text: text.slice(0, 60) }); return true; };
  for await (const line of rl) {
    if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    entrypoint ||= o.entrypoint || null; if (o.isSidechain || !o.timestamp) continue;
    if (o.type === 'user' && !o.isMeta && !o.isCompactSummary) {
      const t = humanText(o.message?.content); if (!t) continue;
      if (!addHuman(t, o.timestamp)) continue;
      if (!cur) cur = { start: o.timestamp, end: null, first: null, model: null };
    } else if (o.type === 'attachment' && o.attachment?.type === 'queued_command' && (!o.attachment.origin || o.attachment.origin.kind === 'human')) {
      const p = o.attachment.prompt; const t = humanText(typeof p === 'string' ? p : Array.isArray(p) ? p.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n') : '');
      if (t) addHuman(t, o.timestamp);
    } else if (o.type === 'assistant' && cur) {
      const u = o.message?.usage; const id = o.message?.id;
      if (u && id && !seenIds.has(id)) { seenIds.add(id); if (cur.first === null) { cur.first = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); cur.model = o.message.model; model = o.message.model; } }
      cur.end = o.timestamp;
      if (ENDS.has(o.message?.stop_reason)) { turns.push(cur); cur = null; }
    }
  }
  if (cur && cur.end) turns.push(cur);
  return { turns, human, entrypoint, model };
};

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);

// ---------------------------------------------------------------- A. the conversations
const conversations = async () => {
  const dir = path.join(ROOT, '-Users-gab-Dev-escadrille'); const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const p = path.join(dir, name); const st = statSync(p); if (st.mtimeMs < span(DAYS[0])[0]) continue;
    const r = await readTranscript(p); if (r.entrypoint !== 'cli') continue;
    const human = r.human.filter((m) => inDays(m.at)); if (human.length < 2) continue;
    const turns = r.turns.filter((t) => inDays(t.start));
    const rep = replayMessages(human, turns);
    const firsts = turns.map((t) => t.first).filter((x) => x > 0); const ctx = median(firsts);
    const pr = priceOf(r.model); const usdPerRead = pr ? (ctx / 1e6) * pr.cacheRead : null;
    out.push({ file: name, day: dayOf(human[0].at), model: r.model, messages: rep.messages, queued: rep.queued, groups: rep.groups, turnsBefore: rep.turnsBefore, turnsAfter: rep.turnsAfter, saved: rep.saved, medianContext: ctx, tokensSaved: rep.saved * ctx, usdSaved: usdPerRead === null ? null : Math.round(rep.saved * usdPerRead * 100) / 100 });
  }
  return out;
};

// ---------------------------------------------------------------- B. the plan sessions
const findTranscript = (sid) => { for (const d of readdirSync(ROOT)) { const p = path.join(ROOT, d, sid + '.jsonl'); if (existsSync(p)) return p; } return null; };
const planSessions = async (db) => {
  const rows = db.prepare('select plan, id, session_id from sessions where session_id is not null').all(); const out = [];
  for (const r of rows) {
    const dev = db.prepare("select at from session_messages where plan = ? and session = ? and role = 'dev' order by seq").all(r.plan, r.id).filter((m) => inDays(m.at));
    if (dev.length < 2) continue;
    const file = findTranscript(r.session_id); if (!file) { out.push({ plan: r.plan, session: r.id, messages: dev.length, transcript: null }); continue; }
    const t = await readTranscript(file);
    const rep = replayMessages(dev, t.turns); const ctx = median(t.turns.map((x) => x.first).filter((x) => x > 0));
    out.push({ plan: r.plan, session: r.id, model: t.model, messages: rep.messages, queued: rep.queued, groups: rep.groups, saved: rep.saved, medianContext: ctx, tokensSaved: rep.saved * ctx });
  }
  return out;
};

// ---------------------------------------------------------------- C. the wakes of 2 November
const wakes = (db, day) => {
  const [a, b] = span(day); const iso = (x) => new Date(x).toISOString();
  const plans = db.prepare('select id, project from plans').all(); const projectOf = new Map(plans.map((p) => [p.id, p.project || null]));
  const all = db.prepare('select * from log where at < ? order by seq').all(iso(b)).map((r) => ({ ...r, stops: (() => { try { return JSON.parse(r.stops) || []; } catch { return []; } })() }));
  const prev = new Map(); const before = all.filter((r) => Date.parse(r.at) < a); eventsOf(before, prev);
  const today = all.filter((r) => Date.parse(r.at) >= a);
  const evs = eventsOf(today, prev); const bySeq = new Map(today.map((r) => [r.seq, r]));
  const per = new Map(); const add = (project, e) => { const k = project || '?'; if (!per.has(k)) per.set(k, []); per.get(k).push(e); };
  let dropped = 0;
  for (const e of evs) {
    const r = bySeq.get(e.seq); const still = r.status === 'running' && r.health !== 'error' && !/finie|erreur/.test(e.what);
    if (still) { dropped++; continue; } // phase 13's filter: a stop crossed while the session keeps working wakes no one
    add(projectOf.get(e.plan), { at: r.at, urgent: false });
  }
  let msgs = 0;
  try { for (const m of db.prepare("select project, at from main_messages where role = 'dev' and at >= ? and at < ?").all(iso(a), iso(b))) { add(m.project, { at: m.at, urgent: true }); msgs++; } } catch {}
  const projects = [...per.entries()].map(([project, list]) => ({ project, ...replayWakes(list) }));
  const tot = projects.reduce((s, p) => ({ events: s.events + p.events, before: s.before + p.before, after: s.after + p.after }), { events: 0, before: 0, after: 0 });
  const waits = projects.flatMap((p) => p.waits);
  return { day, events: evs.length, droppedByFilter: dropped, messages: msgs, ...tot, avoided: tot.before - tot.after, windowMs: EVENT_WINDOW_MS, medianWaitS: Math.round(median(waits) / 1000), maxWaitS: Math.round(Math.max(0, ...waits) / 1000), projects: projects.map(({ waits: w, ...p }) => p) };
};

const db = new DatabaseSync(DB, { readOnly: true });
const A = await conversations(); const B = await planSessions(db); const C = wakes(db, DAYS[DAYS.length - 1]);
const tot = (L) => ({ messages: sum(L, 'messages'), queued: sum(L, 'queued'), saved: sum(L, 'saved'), tokensSaved: sum(L, 'tokensSaved') });
console.log(JSON.stringify({ days: DAYS, conversations: { total: tot(A), list: A }, planSessions: { total: tot(B.filter((x) => x.saved !== undefined)), list: B }, wakes: C }, null, 1));
