// Sessions: one tab per launched session, its thread (the last message at the bottom, the state
// blocks in one line), a one-line composer.
import React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Message, Unauthorized } from '../api';
import { Colors, size, statusTone } from '../theme';
import { Button, DictateButton, Field, Pill, time } from '../ui';
import { money, t } from '../i18n';
import { launched, stateFor, STATE_RE, stateLine, statusLabel } from '../words';
import type { Shared } from './Main';

const POLL_MS = 3000;

export default function SessionsTab(props: Shared & { session: string | null; setSession: (s: string) => void }) {
  const { c, view, api, planId, session, setSession } = props;
  const sessions = view.plan.sessions.filter((s) => launched(stateFor(view.state, s)));
  const current = sessions.find((s) => s.id === session) || sessions.find((s) => (stateFor(view.state, s).pending || []).length) || sessions[0];
  const [messages, setMessages] = React.useState<Message[] | null>(null);
  const [error, setError] = React.useState('');
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const scroll = React.useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null);
  const sid = current?.id;

  const load = React.useCallback(async () => {
    if (!sid) return;
    try { const r = await api.messages(planId, sid); setMessages(r.messages); setError(''); }
    catch (e) { if (!(e instanceof Unauthorized)) setError(t('sessions.threadFailed')); }
  }, [api, planId, sid]);

  React.useEffect(() => { setMessages(null); load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);

  const send = async () => {
    if (!sid || !text.trim()) return;
    setBusy(true);
    try { await api.message(planId, sid, text.trim()); setText(''); load(); props.refresh(); }
    catch (e) { setError((e as Error).message || t('sessions.sendFailed')); }
    setBusy(false);
  };

  if (!current) return <View style={styles.pad}><Text style={{ color: c.muted, fontSize: size.body }}>{t('sessions.none')}</Text></View>;
  const x = stateFor(view.state, current);
  const tone = statusTone(c, x.health === 'error' ? 'error' : x.status);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} role="tablist" style={[styles.tabsBar, { borderColor: c.border }]} contentContainerStyle={styles.tabs}>
        {sessions.map((s) => {
          const on = s.id === current.id; const sx = stateFor(view.state, s); const w = (sx.pending || []).length;
          const dot = sx.health === 'error' ? c.negative : sx.status === 'running' ? c.accent : sx.status === 'waiting' ? c.waitInk : sx.status === 'done' ? c.positive : c.control;
          return (
            <Pressable key={s.id} role="tab" aria-selected={on} accessibilityLabel={w ? t('sessions.tabWaiting', { sid: s.id, name: s.name, n: w }) : `${s.id}, ${s.name}`} onPress={() => setSession(s.id)}
              style={[styles.tab, { backgroundColor: on ? c.active : 'transparent' }]}>
              <View style={[styles.dot, { backgroundColor: dot }]} />
              <Text style={[styles.tabText, { color: on ? c.text : c.muted, fontWeight: on ? '600' : '500' }]}>{s.id}</Text>
              {w ? <View style={[styles.ping, { backgroundColor: c.waitBg }]}><Text style={[styles.pingText, { color: c.waitInk }]}>{w}</Text></View> : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={[styles.head, { borderColor: c.rule }]}>
          <Text role="heading" aria-level={2} numberOfLines={1} style={[styles.h2, { color: c.text }]}>{current.id} · {current.name}</Text>
          <View style={styles.headState}>
            <Pill label={statusLabel(x.status)} bg={tone.bg} ink={tone.ink} />
            {(current.stops || []).length ? <Text style={[styles.meta, { color: c.muted }]}>{t('sessions.stopsOf', { n: x.stops.length, total: current.stops!.length })}</Text> : null}
            {x.usage && Number.isFinite(x.usage.cost) ? <Text style={[styles.meta, { color: c.muted }]}>{money(x.usage.cost as number)}</Text> : null}
          </View>
        </View>
      <ScrollView ref={scroll as never} style={{ flex: 1 }} contentContainerStyle={styles.thread} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        {messages === null ? <Text style={[styles.meta, { color: c.muted }]}>{error || t('sessions.loading')}</Text>
          : messages.length ? messages.map((m) => <Bubble key={m.seq} c={c} m={m} sid={current.id} />)
          : <Text style={{ color: c.muted, fontSize: size.body }}>{t('sessions.empty')}</Text>}
      </ScrollView>

      <View style={[styles.composer, { borderColor: c.border, backgroundColor: c.surface }]}>
        {error && messages ? <Text style={[styles.meta, { color: c.negative }]} numberOfLines={1}>{error}</Text> : null}
        <Field c={c} value={text} onChangeText={setText} placeholder={t('sessions.writeTo', { sid: current.id })} accessibilityLabel={t('sessions.messageTo', { sid: current.id })} onSubmitEditing={send} returnKeyType="send" />
        <View style={styles.row}>
          <Button c={c} kind="primary" label={t('common.send')} disabled={busy || !text.trim()} style={{ flex: 1 }} onPress={send} />
          <DictateButton c={c} setText={setText} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// Strips the little markdown a session writes (bold, inline code markers), keeps the words.
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/^#+\s*/gm, '').trim();

function Bubble({ c, m, sid }: { c: Colors; m: Message; sid: string }) {
  if (m.role === 'system') return <Text style={[styles.sys, { color: c.faint }]}>{m.text} · {time(m.at)}</Text>;
  if (m.role === 'activity') return (
    <View style={styles.activity}><View style={[styles.actDot, { backgroundColor: c.control }]} /><Text style={[styles.meta, { color: c.muted, flex: 1 }]} numberOfLines={2}>{m.text}</Text></View>
  );
  const states: string[] = [];
  const body = plain(m.text.replace(STATE_RE, (_, json) => { states.push(stateLine(json)); return ''; }));
  const who = m.role === 'dev' ? t('sessions.you') : m.role === 'ask' ? t('sessions.asks', { sid }) : 'Claude';
  const tint = m.role === 'dev' ? c.raised : m.role === 'ask' ? c.waitBg : 'transparent';
  return (
    <View style={[styles.msg, { backgroundColor: tint }, m.role === 'claude' && styles.msgFlat]}>
      <Text style={[styles.meta, { color: m.role === 'ask' ? c.waitInk : c.faint }]}>{who} · {time(m.at)}</Text>
      {body ? <Text selectable style={[styles.text, { color: c.text }]}>{body}</Text> : null}
      {states.map((s, i) => (
        <View key={i} style={[styles.state, { backgroundColor: c.accentTint }]}><Text style={[styles.stateText, { color: c.text }]} numberOfLines={2}>{s}</Text></View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: size.pad },
  tabsBar: { flexGrow: 0, borderBottomWidth: 1 },
  tabs: { paddingHorizontal: 12, paddingVertical: 6, gap: 6 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: size.touch, minWidth: 64, paddingHorizontal: 14, borderRadius: size.radiusControl },
  tabText: { fontSize: size.body },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ping: { minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  pingText: { fontSize: 12, fontWeight: '600' },
  thread: { padding: size.pad, gap: 14, paddingBottom: 24 },
  head: { gap: 6, paddingHorizontal: size.pad, paddingVertical: 10, borderBottomWidth: 1 },
  h2: { fontSize: size.section, fontWeight: '600', lineHeight: 24 },
  headState: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  meta: { fontSize: size.small, lineHeight: 18 },
  sys: { fontSize: size.small, lineHeight: 18 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actDot: { width: 6, height: 6, borderRadius: 3 },
  msg: { gap: 4, borderRadius: size.radiusCard, padding: 10 },
  msgFlat: { paddingHorizontal: 0 },
  text: { fontSize: size.body, lineHeight: size.line },
  state: { borderRadius: size.radiusControl, paddingHorizontal: 10, paddingVertical: 6, marginTop: 4 },
  stateText: { fontSize: 14, lineHeight: 20 },
  composer: { borderTopWidth: 1, padding: 12, gap: 6 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
});
