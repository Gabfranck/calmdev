// Settings, folded in one line: the Mac's address, the project, notifications, forgetting the phone.
import React from 'react';
import { Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { getItem, KEYS, setItem } from '../store';
import { size } from '../theme';
import { Button } from '../ui';
import { enable, unavailable } from '../notify';
import { t } from '../i18n';
import type { Shared } from './Main';
import type { Game } from '../api';

// Web captures only: ?screen=settings opens the section, ?screen=project opens the project list too.
const webScreen = () => (Platform.OS === 'web' && typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('screen') : null);

export default function Settings({ c, api, base, onSignOut, project, projects, setProject, loadAll }: Shared) {
  const [open, setOpen] = React.useState(() => ['settings', 'project'].includes(webScreen() || ''));
  const [notify, setNotify] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [confirm, setConfirm] = React.useState(false);
  const [choosing, setChoosing] = React.useState(() => webScreen() === 'project');
  const off = unavailable();

  const [game, setGame] = React.useState<Game | null>(null);
  React.useEffect(() => { api.game(project).then(setGame).catch(() => setGame(null)); }, [api, project]);
  React.useEffect(() => { getItem(KEYS.notify).then((v) => setNotify(v === '1')); }, []);

  const toggle = async (on: boolean) => {
    setNote('');
    if (!on) { setNotify(false); await setItem(KEYS.notify, null); return; }
    try {
      const token = await enable();
      await api.pushToken(token);
      setNotify(true); await setItem(KEYS.notify, '1');
      setNote(t('settings.notifyOn'));
    } catch (e) { setNote((e as Error).message); }
  };

  const forget = async () => {
    try { await api.forget(); } catch { /* the token goes anyway */ }
    onSignOut();
  };

  return (
    <View style={styles.wrap}>
      <Pressable role="button" aria-expanded={open} onPress={() => { if (!open) loadAll(); setOpen((v) => !v); }} style={styles.head}>
        <Text style={[styles.chev, { color: c.muted }]}>{open ? '▾' : '▸'}</Text>
        <Text style={[styles.headText, { color: c.muted }]}>{t('settings.title')}</Text>
      </Pressable>
      {open ? (
        <View style={[styles.body, { borderColor: c.border }]}>
          <View style={styles.line}>
            <Text style={[styles.label, { color: c.text }]}>{t('settings.base')}</Text>
            <Text style={[styles.value, { color: c.muted }]} numberOfLines={1} selectable>{base}</Text>
          </View>
          {game && !game.off ? (
            <View style={styles.line} nativeID="game-line">
              <Text style={[styles.label, { color: c.text }]}>{t('settings.progress')}</Text>
              <Text style={[styles.value, { color: c.muted, fontVariant: ['tabular-nums'] }]} numberOfLines={1}>{t('settings.progressLine', { rank: game.rank, xp: game.next ? `${game.xp}/${game.next.xp}` : game.xp, done: game.week.quests.filter((q) => q.done >= q.of).length, of: game.week.quests.length })}</Text>
            </View>
          ) : null}
          {projects.length ? (
            <View style={styles.line}>
              <Pressable role="button" aria-expanded={choosing} accessibilityLabel={t('settings.project')} onPress={() => setChoosing((v) => !v)} style={styles.projectLine}>
                <Text style={[styles.label, { color: c.text }]}>{t('settings.project')}</Text>
                <Text style={[styles.value, { color: c.accent }]} numberOfLines={1}>{projects.find((p) => p.path === project)?.name || t('settings.allProjects')} {choosing ? '▾' : '▸'}</Text>
              </Pressable>
              {choosing ? (
                <View>
                  {[{ path: null as string | null, name: t('settings.allProjects'), count: projects.reduce((n, p) => n + p.count, 0) }, ...projects].map((p) => {
                    const on = p.path === project;
                    return (
                      <Pressable key={p.path || 'all'} role="button" aria-pressed={on} onPress={() => { setProject(p.path); setChoosing(false); }}
                        style={({ pressed }) => [styles.option, { backgroundColor: pressed || on ? c.active : 'transparent' }]}>
                        <Text style={{ color: c.text, fontSize: 16, fontWeight: on ? '600' : '400', flex: 1 }} numberOfLines={1}>{p.name}</Text>
                        <Text style={{ color: c.muted, fontSize: 13, fontVariant: ['tabular-nums'] }}>{p.count}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ) : null}
          <View style={[styles.line, styles.switchLine]}>
            <View style={{ flex: 1 }}>
              <Text nativeID="notify-label" style={[styles.label, { color: c.text }]}>{t('settings.notify')}</Text>
              <Text style={[styles.value, { color: note && !notify ? c.negative : c.muted }]}>{note || off || t('settings.notifyHint')}</Text>
            </View>
            <Switch aria-labelledby="notify-label" value={notify} disabled={!!off} onValueChange={toggle}
              trackColor={{ true: c.accent, false: c.control }} thumbColor={c.surface} />
          </View>
          {confirm ? (
            <View style={styles.confirm}>
              <Text style={[styles.value, { color: c.text }]}>{t('settings.forgetWarn')}</Text>
              <View style={styles.row}>
                <Button c={c} kind="danger" label={t('settings.forgetConfirm')} onPress={forget} style={{ flex: 1 }} />
                <Button c={c} kind="ghost" label={t('common.cancel')} onPress={() => setConfirm(false)} />
              </View>
            </View>
          ) : (
            <Button c={c} kind="ghost" label={t('settings.forget')} onPress={() => setConfirm(true)} style={styles.forget} />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: size.touch },
  chev: { fontSize: 13, width: 12 },
  headText: { fontSize: 15, fontWeight: '500' },
  body: { borderWidth: 1, borderRadius: size.radiusCard, paddingHorizontal: 12, paddingVertical: 4 },
  line: { paddingVertical: 10, gap: 2 },
  projectLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: size.touch, marginVertical: -10 },
  option: { minHeight: size.touch, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderRadius: size.radiusControl },
  switchLine: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 },
  label: { fontSize: size.body, fontWeight: '500' },
  value: { fontSize: 14, lineHeight: 20 },
  confirm: { gap: 8, paddingVertical: 10 },
  row: { flexDirection: 'row', gap: 8 },
  forget: { alignSelf: 'flex-start', paddingHorizontal: 0, marginVertical: 2 },
});
