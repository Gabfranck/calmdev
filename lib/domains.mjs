// One list of domains per project (6 November): the project's setting `network` is the only thing that opens the network.
// Each line says who reaches the host: { host, scope } with scope 'plan' (the planning run), 'sessions' (the sessions that
// code) or 'both'. A plan's own `network` opens nothing any more: it announces what the plan will use (docs/access.md).
//
// toEntries(list, check)        → { entries: [{ host, scope }], errors } ; a bare string takes its default scope
// defaultScope(host)            → 'sessions' for a package registry, 'both' for the rest
// hostsFor(entries, role)       → the hosts a 'session' or a 'plan' run may reach
// mergeNetwork(setting, lists)  → the migration: the setting ∪ the plans' domains, no duplicate, idempotent
// missingFrom(entries, announced) → the announced hosts absent from the project's list
export const SCOPES = ['plan', 'sessions', 'both'];

// The package registries: a session installs from them, a planning run has no use for them
const REGISTRY = [/^registry\.npmjs\.org$/, /^(\*\.)?npmjs\.org$/, /^([\w*-]+\.)*crates\.io$/, /^pypi\.org$/, /^files\.pythonhosted\.org$/, /^rubygems\.org$/, /^proxy\.golang\.org$/];
export const isRegistry = (host) => REGISTRY.some((r) => r.test(String(host || '').toLowerCase()));
export const defaultScope = (host) => (isRegistry(host) ? 'sessions' : 'both');

// check(hosts) → { domains, errors }: the host rules of the caller (validateDomains, or the server's validateNetwork with
// IPv4 and ports); without one, the hosts are only trimmed and lowered
const trimCheck = (list) => ({ domains: list.map((h) => String(h).trim().toLowerCase()).filter(Boolean), errors: null });
export const toEntries = (list, check = trimCheck) => {
  if (!Array.isArray(list)) return { entries: [], errors: ['network : une liste de domaines ({ host, scope } ou un nom d’hôte)'] };
  const entries = []; const errors = [];
  for (const item of list) {
    const raw = item && typeof item === 'object' ? item.host : item;
    const scope = item && typeof item === 'object' && item.scope != null ? String(item.scope) : null;
    if (scope !== null && !SCOPES.includes(scope)) { errors.push(`${raw} : accès ${scope} inconnu (plan, sessions ou both)`); continue; }
    const { domains, errors: e } = check([raw]);
    if (e) { errors.push(...e); continue; }
    const host = domains[0]; if (!host) continue;
    const at = entries.findIndex((x) => x.host === host);
    const line = { host, scope: scope || defaultScope(host) };
    if (at < 0) entries.push(line); else if (scope) entries[at] = line; // a later line with a scope wins over a bare repeat
  }
  return { entries, errors: errors.length ? errors : null };
};
// The stored list read leniently (an old string list included): never throws, the bad lines dropped
export const entriesOf = (list, check) => toEntries(Array.isArray(list) ? list : [], check).entries;

export const hostsFor = (list, role) => {
  const want = role === 'plan' ? 'plan' : 'sessions';
  return entriesOf(list).filter((e) => e.scope === want || e.scope === 'both').map((e) => e.host);
};

// The migration: the setting (strings or lines) ∪ the domains of the project's plans, each new host with its default scope.
// The setting's own lines keep their scope; running it twice gives the same list.
export const mergeNetwork = (setting, planLists = [], check) => {
  const entries = entriesOf(setting, check);
  for (const list of planLists) for (const e of entriesOf(Array.isArray(list) ? list.map((h) => (h && typeof h === 'object' ? h.host : h)) : [], check)) {
    if (!entries.some((x) => x.host === e.host)) entries.push({ host: e.host, scope: defaultScope(e.host) });
  }
  return entries;
};

// Once per project: settings already scoped stay as they are (a plan's announcement never reopens anything afterwards)
export const migrateSettings = (st = {}, planLists = [], check) => (st.networkScoped
  ? { st, migrated: false }
  : { st: { ...st, network: mergeNetwork(st.network, planLists, check), networkScoped: true }, migrated: true });

// A host matches a line exactly or under its wildcard (*.npmjs.org covers registry.npmjs.org)
const covers = (line, host) => (line.startsWith('*.') ? host.endsWith(line.slice(1)) : line === host);
// The announced hosts absent from the project's list, whatever their scope there (a line already listed is the developer's choice)
export const missingFrom = (list, announced = []) => {
  const open = entriesOf(list).map((e) => e.host);
  return [...new Set((Array.isArray(announced) ? announced : []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))].filter((h) => !open.some((o) => covers(o, h) || o === h));
};
