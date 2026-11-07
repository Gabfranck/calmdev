// A throwaway Escadrille Équipe licence for the tests and the local trials (lib/license.mjs): a key pair made here, the public key,
// the key file and the revocation list in a temp folder, and the env a server reads them from. Never Dev's real keys.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as license from '../lib/license.mjs';

export const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

export const makeLicense = ({ team = 'Équipe test', seats = 5, expires = day(30), kind = 'paid', revoked = [], write = true } = {}) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'escadrille-lic-')));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }); const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const files = { key: path.join(dir, 'license.key'), pub: path.join(dir, 'public.pem'), revoked: path.join(dir, 'revoked.json') };
  writeFileSync(files.pub, pub);
  const key = license.issue({ team, seats, expires, kind, issued: expires < day(0) ? expires : day(0) }, priv);
  if (write) writeFileSync(files.key, key + '\n');
  const id = license.decode(key).payload.id;
  writeFileSync(files.revoked, JSON.stringify({ revoked: revoked === true ? [id] : revoked }));
  return { dir, pub, priv, key, id, files, env: { ESCADRILLE_LICENSE: files.key, ESCADRILLE_LICENSE_PUBKEY: files.pub, ESCADRILLE_LICENSE_REVOKED: files.revoked } };
};
