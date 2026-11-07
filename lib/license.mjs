// The Escadrille Équipe licence key (docs/vente/licence.md), checked offline: an Ed25519 signature (node:crypto) against the
// public key shipped in the repository, a date, a local revocation list. No network, no licence server, no call to Stripe.
// Without a key every solo feature works as before; only the team sharing (lib/team.mjs) asks for one.
//
//   ESC1.<base64url(JSON payload)>.<base64url(signature of "ESC1.<payload>")>
//   payload: { v: 1, id, team, seats, kind: 'paid' | 'trial', issued: 'YYYY-MM-DD', expires: 'YYYY-MM-DD' }
//
//   issue(payload, privateKeyPem)            → the key string (scripts/license-issue.mjs; the private key never in the repo)
//   decode(key)                              → { payload, data, sig } | null   (no signature check)
//   verify(key, { publicKey, revoked, now }) → { state, … }   state: none | invalid | valid | expired | revoked
//   canRead(state) / canWrite(state)         valid reads and writes; expired and revoked read only; none and invalid nothing
//   current({ file, publicKeyFile, revokedFile, now }) → verify() of the key on disk, cached on the files' mtimes
//   save(key, file) / remove(file)           the key file, 0600 in a 0700 folder, outside every repository
//   publicView(result)                       what a route may say (never the key itself)
import { createPrivateKey, createPublicKey, sign, verify as edVerify, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { envVar, configDirIn } from './names.mjs';

export const PREFIX = 'ESC1';
const HERE = path.dirname(new URL(import.meta.url).pathname);
export const keyFileOf = (env = process.env) => envVar('LICENSE', env) || configDirIn(homedir(), 'license.key');
export const publicKeyFileOf = (env = process.env) => envVar('LICENSE_PUBKEY', env) || path.join(HERE, 'license-public.pem');
export const revokedFileOf = (env = process.env) => envVar('LICENSE_REVOKED', env) || path.join(HERE, 'license-revoked.json');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEAM = /^[\p{L}\p{N}][\p{L}\p{N} ._'&-]{0,79}$/u;
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const newId = () => 'lic-' + randomBytes(6).toString('hex');

// The fields of a key, checked the same way when issuing and when reading
export const checkPayload = (p) => {
  const errors = [];
  if (!p || typeof p !== 'object') return ['une charge JSON'];
  if (p.v !== 1) errors.push('v : 1');
  if (typeof p.id !== 'string' || !/^lic-[0-9a-f]{6,32}$/.test(p.id)) errors.push('id : lic-<hex>');
  if (typeof p.team !== 'string' || !TEAM.test(p.team)) errors.push('team : un nom de 1 à 80 caractères');
  if (!Number.isInteger(p.seats) || p.seats < 1 || p.seats > 10000) errors.push('seats : un entier de 1 à 10000');
  if (!['paid', 'trial'].includes(p.kind)) errors.push('kind : paid ou trial');
  if (typeof p.issued !== 'string' || !DATE.test(p.issued)) errors.push('issued : AAAA-MM-JJ');
  if (typeof p.expires !== 'string' || !DATE.test(p.expires) || Number.isNaN(Date.parse(p.expires))) errors.push('expires : AAAA-MM-JJ');
  else if (p.issued && p.expires < p.issued) errors.push('expires : après issued');
  return errors;
};

export const issue = (fields, privateKeyPem) => {
  const payload = { v: 1, id: fields.id || newId(), team: String(fields.team || '').trim(), seats: Number(fields.seats), kind: fields.kind || 'paid', issued: fields.issued || today(), expires: fields.expires };
  const errors = checkPayload(payload); if (errors.length) throw new Error(errors.join(' ; '));
  const key = createPrivateKey(privateKeyPem); if (key.asymmetricKeyType !== 'ed25519') throw new Error('la clé privée doit être Ed25519');
  const data = `${PREFIX}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(sign(null, Buffer.from(data), key))}`;
};

export const decode = (key) => {
  const parts = String(key || '').trim().split('.'); if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;
  let payload; try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  return { payload, data: `${parts[0]}.${parts[1]}`, sig: Buffer.from(parts[2], 'base64url') };
};

const readRevoked = (file) => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(j?.revoked) ? j.revoked.map((r) => (typeof r === 'string' ? r : r?.id)).filter(Boolean) : []; } catch { return []; } };

// The key, its signature, its date (valid through the whole expiry day, UTC), the revocation list
export const verify = (key, { publicKey = null, revoked = [], now = Date.now() } = {}) => {
  if (!key || !String(key).trim()) return { state: 'none' };
  const d = decode(key); if (!d) return { state: 'invalid', error: 'clé illisible' };
  if (!publicKey) return { state: 'invalid', error: 'pas de clé publique dans cette installation' };
  let ok = false; try { ok = edVerify(null, Buffer.from(d.data), typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey, d.sig); } catch { ok = false; }
  if (!ok) return { state: 'invalid', error: 'signature refusée' };
  const errors = checkPayload(d.payload); if (errors.length) return { state: 'invalid', error: errors.join(' ; ') };
  const p = d.payload; const info = { id: p.id, team: p.team, seats: p.seats, kind: p.kind, issued: p.issued, expires: p.expires };
  if (revoked.includes(p.id)) return { state: 'revoked', ...info };
  if (today(now) > p.expires) return { state: 'expired', ...info };
  return { state: 'valid', ...info };
};

export const canRead = (state) => ['valid', 'expired', 'revoked'].includes(state);
export const canWrite = (state) => state === 'valid';

// The key on disk, read again only when one of the three files changes (teamConfigOf asks often)
let cache = null;
const mtimeOf = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
export const current = ({ file = keyFileOf(), publicKeyFile = publicKeyFileOf(), revokedFile = revokedFileOf(), now = Date.now() } = {}) => {
  const sig = [file, mtimeOf(file), publicKeyFile, mtimeOf(publicKeyFile), revokedFile, mtimeOf(revokedFile), today(now)].join('|');
  if (cache && cache.sig === sig) return cache.result;
  const key = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const publicKey = existsSync(publicKeyFile) ? readFileSync(publicKeyFile, 'utf8') : null;
  const result = verify(key, { publicKey, revoked: readRevoked(revokedFile), now });
  cache = { sig, result }; return result;
};
export const forgetCache = () => { cache = null; };

export const save = (key, file = keyFileOf()) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp'; writeFileSync(tmp, String(key).trim() + '\n', { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, file); cache = null;
};
export const remove = (file = keyFileOf()) => { rmSync(file, { force: true }); cache = null; };

// One line for the screens; the key itself never leaves the file
export const lineOf = (r) => {
  switch (r?.state) {
    case 'valid': return `Licence ${r.kind === 'trial' ? 'd’essai' : 'Équipe'} · ${r.team} · ${r.seats} siège${r.seats > 1 ? 's' : ''} · jusqu’au ${r.expires}`;
    case 'expired': return `Licence échue le ${r.expires} : équipe en lecture seule`;
    case 'revoked': return 'Licence révoquée : équipe en lecture seule';
    case 'invalid': return `Clé Équipe refusée (${r.error})`;
    default: return 'Clé Équipe requise pour partager avec l’équipe';
  }
};
export const publicView = (r) => ({ state: r?.state || 'none', team: r?.team || null, seats: r?.seats || null, kind: r?.kind || null, expires: r?.expires || null, read: canRead(r?.state), write: canWrite(r?.state), line: lineOf(r) });
