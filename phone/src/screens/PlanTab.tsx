// Home: « À faire » first (what waits for the developer), then the flow (waves, one card per session).
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Pending, PlanSession, SessionState } from '../api';
import { Colors, size, statusTone } from '../theme';
import { Button, DictateButton, Field, Pill } from '../ui';
import { t } from '../i18n';
import { alertText, askLine, healthLabel, inFlight, launched, netOf, reasonOf, stateFor, statusLabel, wavesOf } from '../words';
import Settings from './Settings';
import type { Shared } from './Main';

type Item = { s: PlanSession; x: SessionState; p: Pending };

export default function PlanTab(props: Shared) {
  const { c, view } = props;
  const items: Item[] = view.plan.sessions.flatMap((s) => { const x = stateFor(view.state, s); return (x.pending || []).map((p) => ({ s, x, p })); });
  // what blocks a session first, then what is only to read
  const rank = (p: Pending) => (p.kind === 'permission' ? 0 : p.kind === 'reply' ? 1 : 2);
  items.sort((a, b) => rank(a.p) - rank(b.p));
  const n = inFlight(view.state);
  const asks = items.filter((i) => rank(i.p) < 2).length;
  const reads = items.length - asks;
  const count = [asks && t('plan.waiting', { n: asks }), reads && t('plan.toRead', { n: reads }), n && t('plan.inFlight', { n })].filter(Boolean).join(', ');

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <View style={styles.section}>
        {items.length ? (
          <>
            <View style={styles.secHead}>
              <Text role="heading" aria-level={2} style={[styles.h2, { color: c.text }]}>{t('plan.todo')}</Text>
              <Text style={[styles.meta, { color: c.muted }]}>{count}</Text>
            </View>
            {items.map((it) => <TodoItem key={it.s.id + ':' + it.p.id} {...props} item={it} />)}
          </>
        ) : (
          <View style={[styles.calm, { backgroundColor: c.raised }]}>
            <Text role="heading" aria-level={2} style={[styles.h2, { color: c.text }]}>{n ? t('plan.nothingInFlight', { inFlight: t('plan.inFlight', { n }) }) : t('plan.nothing')}</Text>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Text role="heading" aria-level={2} style={[styles.h2, { color: c.text }]}>{t('plan.flow')}</Text>
        {wavesOf(view.plan).map((w) => (
          <View key={w.n} style={styles.wave}>
            <Text style={[styles.waveTitle, { color: c.muted }]}>{t('plan.waveTitle', { n: w.n, title: w.title })}</Text>
            {w.items.map((s) => <SessionCard key={s.id} c={c} s={s} x={stateFor(view.state, s)} onPress={() => props.openSession(s.id)} />)}
          </View>
        ))}
      </View>

      <Settings {...props} />
    </ScrollView>
  );
}

function SessionCard({ c, s, x, onPress }: { c: Colors; s: PlanSession; x: SessionState; onPress: () => void }) {
  const tone = statusTone(c, x.health === 'error' ? 'error' : x.status);
  const total = (s.stops || []).length;
  const on = launched(x);
  const waits = (x.pending || []).length;
  return (
    <Pressable role="button" accessibilityLabel={`${s.id}, ${s.name}, ${statusLabel(x.status)}`} onPress={onPress}
      style={({ pressed }) => [styles.card, { borderColor: c.border, backgroundColor: pressed ? c.raised : c.surface }]}>
      <View style={styles.cardTop}>
        <View style={[styles.badge, { backgroundColor: x.status === 'running' ? c.accentTint : c.raised }]}>
          <Text style={[styles.badgeText, { color: x.status === 'running' ? c.accent : c.text }]}>{s.id}</Text>
        </View>
        <Text numberOfLines={2} style={[styles.cardName, { color: on ? c.text : c.muted }]}>{s.name}</Text>
      </View>
      <View style={styles.cardState}>
        <Pill label={statusLabel(x.status)} bg={tone.bg} ink={tone.ink} />
        {x.health && x.health !== 'ok' ? <Pill label={healthLabel(x.health)} bg={c.negBg} ink={c.negInk} /> : null}
        {total ? (
          <View style={styles.track} accessibilityLabel={t('plan.stopsReached', { n: x.stops.length, total })}>
            {s.stops!.map((_, i) => <View key={i} style={[styles.tick, { backgroundColor: x.stops.includes(i) ? c.positive : c.control }]} />)}
            <Text style={[styles.meta, { color: c.muted }]}>{on ? `${x.stops.length} / ${total}` : t('plan.stopsTotal', { total })}</Text>
          </View>
        ) : null}
        {waits ? <Text style={[styles.meta, { color: c.waitInk }]}>{t('plan.toDo', { n: waits })}</Text> : null}
      </View>
      {x.claude ? <Text numberOfLines={2} style={[styles.claude, { color: c.text }]}>{x.claude}</Text>
        : !on ? <Text style={[styles.claude, { color: c.faint }]}>{x.status === 'later' ? t('plan.afterWave') : t('plan.fromMac')}</Text> : null}
    </Pressable>
  );
}

function TodoItem({ c, api, planId, refresh, openSession, item }: Shared & { item: Item }) {
  const { s, x, p } = item;
  const [busy, setBusy] = React.useState(false);
  const [denying, setDenying] = React.useState(false);
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState('');
  const [full, setFull] = React.useState(false);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await f(); refresh(); } catch (e) { setError((e as Error).message || t('plan.sendFailed')); setBusy(false); }
  };
  const errorLine = error ? <Text style={[styles.err, { color: c.negative }]} numberOfLines={1}>{error}</Text> : null;
  const who = (bg: string, ink: string) => <View style={[styles.badge, { backgroundColor: bg }]}><Text style={[styles.badgeText, { color: ink }]}>{s.id}</Text></View>;

  if (p.kind === 'permission') {
    const net = netOf(p); const why = reasonOf(p);
    return (
      <View style={[styles.item, { borderColor: c.border }]}>
        <View style={styles.itemHead}>{who(c.waitBg, c.waitInk)}<Text style={[styles.what, { color: c.text }]} numberOfLines={2}>{askLine(s.id, p.tool)} <Text style={{ color: c.muted, fontWeight: '400' }}>· {p.tool}</Text></Text></View>
        <Text selectable style={[styles.cmd, { backgroundColor: c.raised, color: c.text }]} numberOfLines={4}>{p.text}</Text>
        {net || why ? <View style={styles.why}>{net ? <Pill label={t('plan.net', { net })} bg={c.warnBg} ink={c.warnInk} /> : null}{why ? <Text style={[styles.meta, { color: c.muted, flexShrink: 1 }]}>{why}</Text> : null}</View> : null}
        {denying ? (
          <View style={styles.form}>
            <Field c={c} value={text} onChangeText={setText} placeholder={t('plan.denyHint')} accessibilityLabel={t('plan.denyLabel')} autoFocus
              onSubmitEditing={() => run(() => api.answer(planId, s.id, { id: p.id, allow: false, message: text.trim() }))} returnKeyType="send" />
            <View style={styles.row}>
              <Button c={c} kind="primary" label={t('plan.deny')} disabled={busy} style={styles.grow} onPress={() => run(() => api.answer(planId, s.id, { id: p.id, allow: false, message: text.trim() }))} />
              <DictateButton c={c} setText={setText} />
              <Button c={c} kind="ghost" label={t('common.cancel')} onPress={() => { setDenying(false); setText(''); }} />
            </View>
          </View>
        ) : (
          <View style={styles.row}>
            <Button c={c} kind="primary" label={t('plan.allow')} disabled={busy} style={styles.grow} onPress={() => run(() => api.answer(planId, s.id, { id: p.id, allow: true }))} />
            <Button c={c} label={t('plan.deny')} disabled={busy} style={styles.grow} onPress={() => setDenying(true)} />
          </View>
        )}
        {errorLine}
      </View>
    );
  }

  if (p.kind === 'reply') {
    const stop = Number.isInteger(p.stop) && s.stops ? s.stops[p.stop as number] : null;
    const look = p.text || x.claude; const sum = p.summary || x.summary;
    const send = () => text.trim() && run(() => api.message(planId, s.id, text.trim()));
    return (
      <View style={[styles.item, { borderColor: c.border }]}>
        <View style={styles.itemHead}>{who(c.waitBg, c.waitInk)}<Text style={[styles.what, { color: c.text }]} numberOfLines={1}>{t('plan.awaits', { sid: s.id })}</Text></View>
        {stop ? <Text style={[styles.meta, { color: c.muted }]} numberOfLines={2}>{t('plan.stopReached', { stop: stop as string })}</Text> : null}
        {look ? <Text style={[styles.look, { color: c.text }]}>{look}</Text> : null}
        {sum ? <Pressable role="button" accessibilityLabel={full ? t('plan.summaryFold') : t('plan.summaryFull')} onPress={() => setFull((v) => !v)}>
          <Text style={[styles.summary, { color: c.muted }]} numberOfLines={full ? undefined : 2}>{sum}</Text>
        </Pressable> : null}
        <Field c={c} value={text} onChangeText={setText} placeholder={t('plan.replyHint', { sid: s.id })} accessibilityLabel={t('plan.replyLabel', { sid: s.id })} onSubmitEditing={send} returnKeyType="send" />
        <View style={styles.row}>
          <Button c={c} kind="primary" label={t('common.send')} disabled={busy || !text.trim()} style={styles.grow} onPress={send} />
          <DictateButton c={c} setText={setText} />
        </View>
        <Pressable role="link" onPress={() => openSession(s.id)} style={styles.linkRow}><Text style={[styles.link, { color: c.accent }]}>{t('plan.openThread', { sid: s.id })}</Text></Pressable>
        {errorLine}
      </View>
    );
  }

  const line = p.kind === 'alert' ? alertText(s.id, x, p) : p.text;
  return (
    <View style={[styles.item, styles.calmItem, { borderColor: c.border }]}>
      <View style={[styles.itemHead, { flex: 1 }]}>
        {p.kind === 'alert' ? who(c.warnBg, c.warnInk) : who(c.accentTint, c.accent)}
        <Text style={[styles.calmText, { color: c.text }]} numberOfLines={3}>{line}</Text>
      </View>
      <Button c={c} kind="ghost" label={t('plan.seen')} accessibilityLabel={t('plan.seenLabel')} disabled={busy} onPress={() => run(() => api.dismiss(planId, s.id, p.id))} />
      {errorLine}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: size.pad, paddingBottom: 32, gap: 28 },
  section: { gap: 10 },
  secHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  h2: { fontSize: size.section, fontWeight: '600', lineHeight: 24 },
  meta: { fontSize: size.small, lineHeight: 18 },
  calm: { borderRadius: size.radiusCard, paddingHorizontal: 14, paddingVertical: 12 },
  item: { borderWidth: 1, borderRadius: size.radiusCard, padding: 12, gap: 10 },
  calmItem: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingVertical: 4, paddingRight: 4 },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { minWidth: 28, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontSize: 14, fontWeight: '600' },
  what: { flex: 1, fontSize: size.body, fontWeight: '600', lineHeight: 22 },
  cmd: { fontFamily: 'Menlo', fontSize: 13, lineHeight: 18, padding: 10, borderRadius: size.radiusControl },
  why: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  form: { gap: 8 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  grow: { flex: 1 },
  look: { fontSize: size.body, lineHeight: size.line },
  summary: { fontSize: 15, lineHeight: 21 },
  linkRow: { minHeight: size.touch, justifyContent: 'center', marginVertical: -8 },
  link: { fontSize: 15, fontWeight: '500' },
  calmText: { flex: 1, fontSize: size.body, lineHeight: size.line, paddingVertical: 8 },
  err: { fontSize: 14, width: '100%' },
  wave: { gap: 8, marginTop: 6 },
  waveTitle: { fontSize: 14, fontWeight: '500' },
  card: { borderWidth: 1, borderRadius: size.radiusCard, padding: 12, gap: 10, minHeight: size.touch },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardName: { flex: 1, fontSize: size.body, lineHeight: 22, fontWeight: '500' },
  cardState: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  track: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  tick: { width: 14, height: 4, borderRadius: 2 },
  claude: { fontSize: 15, lineHeight: 21 },
});
