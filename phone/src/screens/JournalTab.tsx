// Journal: every change of state, the most recent first: time, session, status, the `claude` line.
import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { size } from '../theme';
import { healthLabel, statusLabel } from '../words';
import { t } from '../i18n';
import { time } from '../ui';
import type { Shared } from './Main';

export default function JournalTab({ c, view }: Shared) {
  const rows = [...view.log].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return (
    <FlatList data={rows} keyExtractor={(r, i) => `${r.at}-${r.session}-${i}`} contentContainerStyle={styles.wrap}
      ListHeaderComponent={<Text role="heading" aria-level={2} style={[styles.h2, { color: c.text }]}>{t('journal.title')}</Text>}
      ListEmptyComponent={<Text style={{ color: c.muted, fontSize: size.body }}>{t('journal.empty')}</Text>}
      renderItem={({ item: r }) => {
        const dot = r.health === 'error' ? c.negative : r.health === 'drift' ? c.warning : r.status === 'running' ? c.accent : r.status === 'waiting' ? c.waitInk : r.status === 'done' ? c.positive : c.control;
        return (
          <View style={[styles.row, { borderColor: c.rule }]}>
            <View style={styles.line1}>
              <Text style={[styles.t, { color: c.muted }]}>{time(r.at)}</Text>
              <Text style={[styles.s, { color: c.text }]}>{r.session}</Text>
              <View style={[styles.dot, { backgroundColor: dot }]} />
              <Text style={[styles.st, { color: c.muted }]} numberOfLines={1}>{statusLabel(r.status)}{r.health && r.health !== 'ok' ? ` · ${healthLabel(r.health)}` : ''}</Text>
            </View>
            {r.claude ? <Text style={[styles.claude, { color: c.text }]}>{r.claude}</Text> : null}
            {r.why || (r.stops && r.stops.length) ? <Text style={[styles.m, { color: c.muted }]}>{[r.why, r.stops && r.stops.length ? t(r.stops.length > 1 ? 'journal.stops' : 'journal.stop', { list: r.stops.map((i) => i + 1).join(', ') }) : ''].filter(Boolean).join(' · ')}</Text> : null}
          </View>
        );
      }} />
  );
}

const styles = StyleSheet.create({
  wrap: { padding: size.pad, paddingBottom: 32 },
  h2: { fontSize: size.section, fontWeight: '600', lineHeight: 24, marginBottom: 6 },
  row: { paddingVertical: 12, borderBottomWidth: 1, gap: 4 },
  line1: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  t: { fontSize: 14, fontVariant: ['tabular-nums'], width: 44 },
  s: { fontSize: 14, fontWeight: '600', minWidth: 14 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  st: { fontSize: 14, flex: 1 },
  claude: { fontSize: 15, lineHeight: 21, paddingLeft: 54 },
  m: { fontSize: size.small, lineHeight: 18, paddingLeft: 54 },
});
