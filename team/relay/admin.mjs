#!/usr/bin/env node
// Administration of the team relay, run on the instance by its owner (never over the network).
//   node admin.mjs team-add <team>               create a team
//   node admin.mjs member-add <team> <name>      add a member; prints its token ONCE (only its salted hash is kept)
//   node admin.mjs revoke <member-id>            revoke a member's token (its presence disappears at once)
//   node admin.mjs list                          teams and members, without any secret
//   node admin.mjs backup <file>                 consistent copy of the base (VACUUM INTO), safe while the relay runs
// The base is RELAY_DB (default ./relay.db), the same as the relay's.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb, newToken } from './relay.mjs';

export function run(args, { db, out = console.log, now = () => new Date().toISOString() }) {
  const [cmd, a, b] = args;
  const team = (name) => db.prepare('select id, name from teams where name = ?').get(name);
  const fail = (msg) => { const e = new Error(msg); e.usage = true; throw e; };
  const name = (v, what) => {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > 60 || /[\0-\x1f]/.test(v)) fail(`${what}: 1 to 60 printable characters`);
    return v.trim();
  };

  if (cmd === 'team-add') {
    const n = name(a, 'team');
    if (team(n)) fail(`team "${n}" exists`);
    const id = 't-' + randomBytes(4).toString('hex');
    db.prepare('insert into teams (id, name, created) values (?, ?, ?)').run(id, n, now());
    out(`team ${n} (${id}) created`);
    return { id };
  }
  if (cmd === 'member-add') {
    const t = team(name(a, 'team')) || fail(`no team "${a}"`);
    const n = name(b, 'member');
    if (db.prepare('select 1 from members where team_id = ? and name = ? and revoked is null').get(t.id, n)) fail(`member "${n}" already active in ${t.name}`);
    const k = newToken();
    db.prepare('insert into members (id, team_id, name, salt, token_hash, created) values (?, ?, ?, ?, ?, ?)').run(k.id, t.id, n, k.salt, k.hash, now());
    out(`member ${n} (${k.id}) added to ${t.name}`);
    out(`token, shown once, give it to ${n} by a private channel:`);
    out(k.token);
    return { id: k.id, token: k.token };
  }
  if (cmd === 'revoke') {
    const m = db.prepare('select id, team_id, name, revoked from members where id = ?').get(a || '') || fail(`no member "${a}"`);
    if (m.revoked) { out(`${m.name} (${m.id}) already revoked`); return { id: m.id }; }
    db.prepare('update members set revoked = ? where id = ?').run(now(), m.id);
    if (!db.prepare('select 1 from members where team_id = ? and name = ? and revoked is null').get(m.team_id, m.name)) {
      db.prepare('delete from presence where team_id = ? and member = ?').run(m.team_id, m.name);
    }
    out(`${m.name} (${m.id}) revoked`);
    return { id: m.id };
  }
  if (cmd === 'list') {
    for (const t of db.prepare('select id, name from teams order by name').all()) {
      out(`${t.name} (${t.id})`);
      for (const m of db.prepare('select id, name, created, revoked from members where team_id = ? order by name').all(t.id)) {
        out(`  ${m.id}  ${m.name}  ${m.revoked ? 'revoked ' + m.revoked : 'active since ' + m.created}`);
      }
    }
    return {};
  }
  if (cmd === 'backup') {
    if (!a) fail('backup <file>');
    if (existsSync(a)) fail(`${a} exists`);
    db.prepare('vacuum into ?').run(a);
    out(`backup written to ${a}`);
    return {};
  }
  fail('usage: team-add <team> | member-add <team> <name> | revoke <member-id> | list | backup <file>');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const db = openDb(process.env.RELAY_DB || './relay.db');
  try {
    run(process.argv.slice(2), { db });
  } catch (e) {
    console.error(e.usage ? e.message : `error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
