// The paired app: one header (the plan, its picker), one tab at a time (Plan, Sessions, Journal),
// a tab bar at the bottom. The app polls GET /api/phone and GET /api/plan/:id every 3 s while it is
// in the foreground, and nothing in the background.
import React from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Api, makeApi, PhoneInfo, PlanView, Unauthorized } from '../api';
import { Colors, size } from '../theme';
import { Mark, time } from '../ui';
import { t } from '../i18n';
import { getItem, KEYS, setItem } from '../store';
import { filterPlans, groupPlans, pickPlan, projectOfPlan, projectsOf, shortName, validProject } from '../../lib/projects';
import PlanTab from './PlanTab';
import SessionsTab from './SessionsTab';
import JournalTab from './JournalTab';

export type Tab = 'plan' | 'sessions' | 'journal';
export type Shared = {
  c: Colors; api: Api; base: string; view: PlanView; planId: string; refresh: () => void;
  openSession: (sid: string) => void; onSignOut: () => void;
  // the project setting: null is « Tous les projets »; `projects` come from the plans of GET /api/phone
  project: string | null; projects: { path: string; name: string; count: number }[]; setProject: (p: string | null) => void; loadAll: () => void;
};
const POLL_MS = 3000;

// Set from outside (a touched notification): the plan and the session to open, and the plan's project when the push says it.
export type Target = { plan?: string; session?: string; tab?: string; project?: string } | null;

export default function Main({ c, base, token, onSignOut, target }: { c: Colors; base: string; token: string; onSignOut: () => void; target?: Target }) {
  const api = React.useMemo(() => makeApi(base, token, onSignOut), [base, token, onSignOut]);
  const [phone, setPhone] = React.useState<PhoneInfo | null>(null);
  const [all, setAll] = React.useState<PhoneInfo['plans'] | null>(null); // every plan, whatever the project: the list of projects
  const [project, setProjectState] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const [planId, setPlanId] = React.useState<string | null>(null);
  const [view, setView] = React.useState<PlanView | null>(null);
  const [error, setError] = React.useState('');
  const [lastOk, setLastOk] = React.useState<string>('');
  const [tab, setTab] = React.useState<Tab>('plan');
  const [session, setSession] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState(false);
  const planRef = React.useRef<string | null>(null);
  planRef.current = planId;
  const pendingTarget = React.useRef<NonNullable<Target> | null>(null);

  // The chosen project lives next to the token (App.tsx stores it first when a web capture passes ?filter=).
  React.useEffect(() => {
    getItem(KEYS.project).then((v) => { setProjectState(v || null); setReady(true); });
  }, []);

  const applyProject = React.useCallback((p: string | null, plan: string | null = null) => {
    setProjectState(p); setPlanId(plan); setView(null); setSession(null); setPicking(false);
    setItem(KEYS.project, p);
  }, []);

  const loadAll = React.useCallback(async () => {
    try { setAll((await api.phone()).plans); } catch { /* the next poll tells */ }
  }, [api]);

  const refresh = React.useCallback(async () => {
    try {
      const p = await api.phone(project);
      const plans = filterPlans(p.plans, project); // the server filters too; this keeps an older server honest
      setPhone({ ...p, plans });
      if (!project) setAll(p.plans);
      // the most recent plan by default, and again when the one shown is gone
      const id = pickPlan(plans, planRef.current);
      if (id !== planRef.current) setPlanId(id);
      if (id) setView(await api.plan(id)); else setView(null);
      setError(''); setLastOk(new Date().toISOString());
    } catch (e) {
      if (!(e instanceof Unauthorized)) setError(t('main.noAnswer'));
    }
  }, [api, project]);

  React.useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) { refresh(); timer = setInterval(refresh, POLL_MS); } };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    start();
    const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
    return () => { stop(); sub.remove(); };
  }, [refresh, ready]);

  React.useEffect(() => { if (ready && planId) refresh(); }, [planId]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (ready && project) loadAll(); }, [ready, project, loadAll]);

  // a project that no plan has any more: back to « Tous »
  React.useEffect(() => { if (all && project && validProject(all, project) === null) applyProject(null); }, [all, project, applyProject]);

  React.useEffect(() => {
    if (!target) return;
    if (target.plan) { setPlanId(target.plan); pendingTarget.current = target; }
    if (target.session) { setSession(target.session); setTab('sessions'); } else setTab(target.tab === 'journal' || target.tab === 'sessions' ? target.tab : 'plan');
  }, [target]);

  // A touched notification puts the app on the project of its plan: the push's `project`, else the one the plans say.
  // While a project is chosen and the plan is in another, the choice follows; with « Tous » nothing needs to change.
  React.useEffect(() => {
    const t = pendingTarget.current;
    if (!t?.plan || !ready || !all) return;
    pendingTarget.current = null;
    const wanted = t.project || projectOfPlan(all, t.plan);
    if (project && wanted !== project) applyProject(wanted, t.plan);
  }, [all, ready, project, target, applyProject]);

  const openSession = (sid: string) => { setSession(sid); setTab('sessions'); };
  const plans = phone?.plans || [];
  const title = view?.plan.title || (phone && !plans.length ? t('main.noPlan') : '');
  const asks = (view?.state || []).reduce((n, x) => n + (x.pending || []).filter((p) => p.kind === 'permission' || p.kind === 'reply').length, 0);
  const projects = React.useMemo(() => projectsOf(all || []), [all]);
  const projectName = shortName(projectOfPlan(plans, planId));

  const shared: Shared | null = view && planId
    ? { c, api, base, view, planId, refresh, openSession, onSignOut, project, projects, setProject: (p) => applyProject(p), loadAll }
    : null;
  const choose = (id: string) => { setPlanId(id); setView(null); setSession(null); setPicking(false); };

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, { backgroundColor: c.ground }]}>
        <View style={styles.headRow}>
          <Mark c={c} />
          <View style={{ flex: 1 }}>
            <View style={styles.topLine}>
              <Text style={[styles.project, { color: c.faint }]} numberOfLines={1}>{projectName}</Text>
              <Text style={[styles.stamp, { color: error ? c.negative : c.faint }]} numberOfLines={1}>
                {error ? `${error}${lastOk ? ` · ${t('main.updated', { time: time(lastOk) }).toLowerCase()}` : ''}` : lastOk ? t('main.updated', { time: time(lastOk) }) : t('main.loading')}
              </Text>
            </View>
            <Text role="heading" aria-level={1} numberOfLines={2} style={[styles.h1, { color: c.text }]}>{title || ' '}</Text>
          </View>
        </View>
        {plans.length > 1 ? (
          <Pressable role="button" accessibilityLabel={t('main.switchPlan')} onPress={() => setPicking((v) => !v)} style={styles.picker}>
            <Text style={[styles.pickerText, { color: c.accent }]}>{picking ? t('main.close') : t('main.otherPlans', { n: plans.length - 1 })}</Text>
          </Pressable>
        ) : null}
        {picking ? <PlanPicker c={c} plans={plans} planId={planId} grouped={!project} onPick={choose} /> : null}
      </View>

      <View style={[styles.body, { backgroundColor: c.surface, borderColor: c.border }]}>
        {!shared ? (
          <View style={styles.empty}><Text style={{ color: c.muted, fontSize: size.body }}>
            {phone && !plans.length ? t('main.noPlanHelp') : error ? t('main.noAnswerHelp') : t('main.loadingPlan')}
          </Text></View>
        ) : tab === 'plan' ? <PlanTab {...shared} />
          : tab === 'sessions' ? <SessionsTab {...shared} session={session} setSession={setSession} />
          : <JournalTab {...shared} />}
      </View>

      <View role="tablist" style={[styles.tabbar, { backgroundColor: c.ground, borderColor: c.border }]}>
        {([['plan', t('main.tabPlan')], ['sessions', t('main.tabSessions')], ['journal', t('main.tabJournal')]] as [Tab, string][]).map(([k, label]) => {
          const on = tab === k;
          return (
            <Pressable key={k} role="tab" aria-selected={on} accessibilityLabel={k === 'plan' && asks ? t('main.tabWaiting', { label, n: asks }) : label}
              onPress={() => setTab(k)} style={styles.tab}>
              <View style={[styles.tabInner, on && { backgroundColor: c.active }]}>
                <Text style={[styles.tabText, { color: on ? c.text : c.muted, fontWeight: on ? '600' : '500' }]}>{label}</Text>
                {k === 'plan' && asks ? <View style={[styles.count, { backgroundColor: c.waitBg }]}><Text style={[styles.countText, { color: c.waitInk }]}>{asks}</Text></View> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// The plans to pick from. With « Tous les projets » they are grouped: one folded line per project, opened on a tap.
function PlanPicker({ c, plans, planId, grouped, onPick }: { c: Colors; plans: PhoneInfo['plans']; planId: string | null; grouped: boolean; onPick: (id: string) => void }) {
  const groups = groupPlans(plans);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const row = (p: PhoneInfo['plans'][number]) => (
    <Pressable key={p.id} role="button" onPress={() => onPick(p.id)}
      style={({ pressed }) => [styles.pickItem, { backgroundColor: pressed || p.id === planId ? c.active : 'transparent' }]}>
      <Text numberOfLines={2} style={{ color: c.text, fontSize: size.body, fontWeight: p.id === planId ? '600' : '400' }}>{p.title}</Text>
    </Pressable>
  );
  return (
    <View style={[styles.pickList, { backgroundColor: c.surface, borderColor: c.border }]}>
      {grouped && groups.length > 1 ? groups.map((g) => {
        const key = g.project || '';
        const on = open.has(key);
        return (
          <View key={key}>
            <Pressable role="button" aria-expanded={on} onPress={() => setOpen((o) => { const n = new Set(o); if (on) n.delete(key); else n.add(key); return n; })}
              style={({ pressed }) => [styles.pickGroup, { backgroundColor: pressed ? c.active : 'transparent' }]}>
              <Text style={[styles.chev, { color: c.muted }]}>{on ? '▾' : '▸'}</Text>
              <Text style={{ color: c.text, fontSize: size.body, fontWeight: '500', flex: 1 }} numberOfLines={1}>{g.name || t('main.noProject')}</Text>
              <Text style={{ color: c.muted, fontSize: size.small, fontVariant: ['tabular-nums'] }}>{g.plans.length}</Text>
            </Pressable>
            {on ? g.plans.map(row) : null}
          </View>
        );
      }) : groups.flatMap((g) => g.plans).map(row)}
    </View>
  );
}

const styles = StyleSheet.create({
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: -1 },
  project: { fontSize: size.small, lineHeight: 16, flexShrink: 1 },
  pickGroup: { minHeight: size.touch, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: size.radiusControl },
  chev: { fontSize: 13, width: 12 },
  header: { paddingHorizontal: size.pad, paddingTop: 14, paddingBottom: 8, gap: 4 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  h1: { flex: 1, fontSize: 19, lineHeight: 24, fontWeight: '600', marginTop: -2 },
  picker: { minHeight: size.touch, justifyContent: 'center', marginVertical: -6, paddingLeft: 30, alignSelf: 'flex-start' },
  pickerText: { fontSize: 15, fontWeight: '500' },
  stamp: { fontSize: size.small, flexShrink: 1, fontVariant: ['tabular-nums'] },
  pickList: { borderWidth: 1, borderRadius: size.radiusCard, padding: 4, marginTop: 4 },
  pickItem: { minHeight: size.touch, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: size.radiusControl },
  body: { flex: 1, borderTopWidth: 1, borderBottomWidth: 1 },
  empty: { padding: size.pad },
  tabbar: { flexDirection: 'row', paddingHorizontal: 8, paddingTop: 6, paddingBottom: 10 },
  tab: { flex: 1, minHeight: 48, justifyContent: 'center' },
  tabInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, borderRadius: size.radiusControl, marginHorizontal: 4 },
  tabText: { fontSize: 15 },
  count: { minWidth: 22, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  countText: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
