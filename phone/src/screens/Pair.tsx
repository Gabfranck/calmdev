// Pairing: the Mac's address, the 6-digit code shown on the Mac, one button.
import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Device from 'expo-device';
import { pair } from '../api';
import { Colors, size } from '../theme';
import { Button, Field, Mark } from '../ui';
import { t } from '../i18n';

export default function Pair({ c, initialBase, onPaired }: { c: Colors; initialBase: string; onPaired: (base: string, token: string) => void }) {
  const [base, setBase] = React.useState(initialBase);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const ready = /^\d{6}$/.test(code) && /^https?:\/\/.+/.test(base.trim()) && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      const name = (Platform.OS !== 'web' && Device.deviceName) || 'iPhone';
      const { token } = await pair(base.trim(), code, name);
      onPaired(base.trim(), token);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}><Mark c={c} /><Text style={[styles.brandText, { color: c.text }]}>Escadrille</Text></View>
        <Text role="heading" aria-level={1} style={[styles.h1, { color: c.text }]}>{t('pair.title')}</Text>
        <Text style={[styles.sub, { color: c.muted }]}>{t('pair.sub')}</Text>

        <View style={styles.form}>
          <View style={styles.group}>
            <Text nativeID="code-label" style={[styles.label, { color: c.text }]}>{t('pair.code')}</Text>
            <Field c={c} aria-labelledby="code-label" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad" inputMode="numeric" maxLength={6} placeholder="000000" autoFocus
              textContentType="oneTimeCode" autoComplete="one-time-code" onSubmitEditing={submit} returnKeyType="go"
              style={styles.code} />
          </View>
          <View style={styles.group}>
            <Text nativeID="base-label" style={[styles.label, { color: c.text }]}>{t('pair.base')}</Text>
            <Field c={c} aria-labelledby="base-label" value={base} onChangeText={setBase} autoCapitalize="none" autoCorrect={false}
              keyboardType="url" inputMode="url" placeholder="http://192.168.1.x:3078" />
          </View>
          {error ? <Text role="alert" style={[styles.error, { color: c.negative }]} numberOfLines={2}>{error}</Text> : null}
          <Button c={c} kind="primary" label={busy ? t('pair.busy') : t('pair.submit')} onPress={submit} disabled={!ready} style={styles.submit} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 20, paddingTop: 64, gap: 8, maxWidth: 480, width: '100%', alignSelf: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 32 },
  brandText: { fontSize: 17, fontWeight: '600' },
  h1: { fontSize: size.title + 2, lineHeight: 30, fontWeight: '600', letterSpacing: -0.2 },
  sub: { fontSize: size.body, lineHeight: size.line },
  form: { marginTop: 28, gap: 20 },
  group: { gap: 8 },
  label: { fontSize: 15, fontWeight: '500' },
  code: { fontSize: 28, letterSpacing: 8, minHeight: 56, fontVariant: ['tabular-nums'] },
  error: { fontSize: 15, lineHeight: 20 },
  submit: { minHeight: 52, marginTop: 4 },
});
