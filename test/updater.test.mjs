// The downloadable Mac app that updates itself (docs/desktop.md « Publier une version », docs/ci.md): the universal
// build, the update artifacts of the draft release, the endpoint and the public key, the placeholder that keeps the
// check off, and the only two crates added. No network, no Rust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
const release = read('.github/workflows/release.yml');
const conf = JSON.parse(read('desktop/src-tauri/tauri.conf.json'));
const main = read('desktop/src-tauri/src/main.rs');

const SECRETS = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'];

test('release.yml builds the universal app (aarch64 + x86_64), .app and .dmg', () => {
  assert.match(release, /rustup target add aarch64-apple-darwin x86_64-apple-darwin/);
  const builds = release.match(/tauri build [^\n]*/g);
  assert.equal(builds.length, 2, 'signed and unsigned build');
  for (const b of builds) assert.match(b, /--target universal-apple-darwin --bundles app,dmg/);
  assert.match(release, /target\/universal-apple-darwin\/release\/bundle/);
});

test('release.yml expects the eight secrets, lists the missing ones in the summary, stops without the update key', () => {
  const first = release.indexOf('- name: Secrets present?');
  assert.ok(first > 0 && first < release.indexOf('actions/checkout@'), 'the listing step comes first');
  for (const s of SECRETS) assert.match(release, new RegExp(`${s}: \\$\\{\\{ secrets\\.${s} \\}\\}`), s);
  assert.match(release, /GITHUB_STEP_SUMMARY/);
  assert.match(release, /\*TAURI_SIGNING_PRIVATE_KEY\*\)[\s\S]{0,300}::error::[\s\S]{0,300}exit 1/);
  // the Apple secrets alone never stop the job: unsigned build with a warning
  assert.doesNotMatch(release, /\*APPLE_[A-Z_]*\*\)/);
  assert.doesNotMatch(release, /echo[^\n]*\$(\{)?(APPLE_|TAURI_SIGNING)/, 'no secret value is echoed');
});

test('release.yml attaches the .dmg, the .app.tar.gz, its .sig and a latest.json to a DRAFT release', () => {
  assert.match(release, /gh release create [^\n]*--draft/);
  assert.doesNotMatch(release, /--draft=false|gh release edit/);
  assert.match(release, /set -- "\$dmg" "\$update" "\$update\.sig" latest\.json/);
  assert.match(release, /\.app\.tar\.gz/);
  assert.match(release, /"darwin-aarch64": entry, "darwin-x86_64": entry/);
  assert.match(release, /releases\/download\/\$\{tag\}\//);
  assert.match(release, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/);
});

test('the latest.json written by release.yml has the shape the updater reads', () => {
  const script = release.match(/node -e '\n([\s\S]*?)\n\s*'\n/)[1];
  const dir = mkdtempSync(path.join(tmpdir(), 'calmdev-latest-'));
  try {
    writeFileSync(path.join(dir, 'calmdev.app.tar.gz'), 'x');
    writeFileSync(path.join(dir, 'calmdev.app.tar.gz.sig'), 'SIGNATURE-TEXT\n');
    execFileSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, TAG: 'v1.2.3', UPDATE_FILE: path.join(dir, 'calmdev.app.tar.gz') } });
    const latest = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    assert.equal(latest.version, '1.2.3');
    assert.ok(!Number.isNaN(Date.parse(latest.pub_date)));
    for (const p of ['darwin-aarch64', 'darwin-x86_64']) {
      assert.equal(latest.platforms[p].signature, 'SIGNATURE-TEXT');
      assert.equal(latest.platforms[p].url, 'https://github.com/Gabfranck/calmdev/releases/download/v1.2.3/calmdev.app.tar.gz');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tauri.conf.json: the update endpoint, createUpdaterArtifacts, a public key slot', () => {
  assert.equal(conf.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(conf.plugins.updater.endpoints, ['https://github.com/Gabfranck/calmdev/releases/latest/download/latest.json']);
  assert.equal(typeof conf.plugins.updater.pubkey, 'string');
  assert.ok(conf.plugins.updater.pubkey.length > 0);
  assert.ok(!/PRIVATE/.test(conf.plugins.updater.pubkey), 'only the PUBLIC key is ever in the repository');
});

test('main.rs: the placeholder public key turns the check off; the check runs after the page opens, in the background', () => {
  const placeholder = main.match(/const UPDATER_PLACEHOLDER: &str = "([^"]+)"/)[1];
  assert.match(placeholder, /PLACEHOLDER/);
  // since 7 Nov the conf carries Dev's real PUBLIC key (~/.calmdev-prod/updater.key.pub): a minisign public key, base64
  const pub = Buffer.from(conf.plugins.updater.pubkey, 'base64').toString('utf8');
  assert.match(pub, /^untrusted comment: minisign public key: [0-9A-F]+\nRW[A-Za-z0-9+/=]+\n?$/, 'a minisign PUBLIC key');
  assert.ok(!conf.plugins.updater.pubkey.startsWith(placeholder), 'the update check is on');
  assert.match(main, /fn updater_enabled[\s\S]*?!k\.starts_with\(UPDATER_PLACEHOLDER\)/);
  assert.match(main, /fn check_for_update[\s\S]*?if !updater_enabled\(app\) \{\s*return;/);
  // the plugins are not even loaded without a real key
  assert.match(main, /if updater_enabled\(app\.handle\(\)\) \{[\s\S]*?plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/);
  // after navigate, never before; spawned, never blocking boot
  assert.match(main, /window\.navigate\(url\) \{\s*Ok\(\(\)\) => check_for_update\(&app\)/);
  assert.match(main, /tauri::async_runtime::spawn\(async move/);
  // the native box and the install-then-relaunch
  assert.match(main, /"Mettre à jour"\.into\(\), "Plus tard"\.into\(\)/);
  assert.match(main, /download_and_install[\s\S]*?app\.restart\(\)/);
});

test('desktop/ adds only tauri-plugin-updater (and tauri-plugin-dialog, justified in docs/desktop.md)', () => {
  const cargo = read('desktop/src-tauri/Cargo.toml');
  const deps = cargo.split('[dependencies]')[1].split('\n').filter((l) => /^[a-z_-]+ *=/.test(l)).map((l) => l.split(/ *=/)[0]);
  assert.deepEqual(deps, ['tauri', 'serde_json', 'tauri-plugin-updater', 'tauri-plugin-dialog']);
  const pkg = JSON.parse(read('desktop/package.json'));
  assert.deepEqual(Object.keys(pkg.devDependencies), ['@tauri-apps/cli']);
  assert.equal(pkg.dependencies, undefined);
  assert.match(read('docs/desktop.md'), /tauri-plugin-dialog[^\n]*(boîte|bo[iî]te)/);
});

test('a local build never needs the update key', () => {
  assert.match(JSON.parse(read('desktop/package.json')).scripts['build:debug'], /createUpdaterArtifacts":false/);
  assert.match(read('desktop/scripts/install-app.sh'), /createUpdaterArtifacts":false/);
});

test('release-secrets.sh sets the eight secrets, files by redirection, passwords at the prompt, never a value in argv', () => {
  const s = read('desktop/scripts/release-secrets.sh');
  for (const name of SECRETS) assert.match(s, new RegExp(`(set_file|set_typed) ${name}\\b`), name);
  assert.doesNotMatch(s, /--body|-b /, 'no value on a command line');
  assert.match(s, /base64 -i "\$P12" \| set_file APPLE_CERTIFICATE/);
  assert.match(s, /set_file TAURI_SIGNING_PRIVATE_KEY < "\$KEY"/);
  assert.match(s, /\[ -t 0 \]/, 'refuses to run without a terminal');
  // exported to the public repository: no personal identity in the script nor in docs/desktop.md (they live in docs/release.md, private)
  for (const f of ['desktop/scripts/release-secrets.sh', 'docs/desktop.md']) assert.doesNotMatch(read(f), /Developer ID Application: [A-Z][a-z]+ [A-Z]+ \(|\([A-Z0-9]{10}\)/, f);
  let manifest = null; try { manifest = JSON.parse(read('public-manifest.json')); } catch {} // absent from the public tree
  if (manifest) assert.ok(!manifest.include.some((p) => p === 'docs/release.md' || p === 'docs/**'), 'docs/release.md stays private');
  assert.match(s, /gh repo view "\$REPO"/, 'stops when the public repository does not exist yet');
  const sh = execFileSync('/bin/zsh', ['-n', path.join(root, 'desktop/scripts/release-secrets.sh')], { encoding: 'utf8' });
  assert.equal(sh, '');
});

test('docs/desktop.md « Publier une version » walks through every step; docs/ci.md names the new secrets', () => {
  const d = read('docs/desktop.md');
  const section = d.slice(d.indexOf('## Publier une version'));
  assert.ok(section.length > 100, 'the section exists');
  for (const word of ['Developer ID Application', '.p12', 'base64', 'mot de passe d’app', 'Team ID', 'npx tauri signer generate -w ~/.calmdev-prod/updater.key', '~/.calmdev-prod', 'gh secret set','git tag', 'brouillon'])
    assert.ok(section.includes(word), word);
  for (const s of SECRETS) assert.ok(section.includes(s), s);
  const ci = read('docs/ci.md');
  for (const s of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'latest.json', 'universal-apple-darwin']) assert.ok(ci.includes(s), s);
});
