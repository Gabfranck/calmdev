// Small shared pieces: the mark (public/brand/symbol-512.png, copied), buttons, a one-line field, a pill. Flat, no shadow, 44px targets.
import React from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { Colors, size } from './theme';
import { useDictation } from './dictation';
import { t } from './i18n';

export const Mark = ({ c }: { c: Colors }) => (
  <Image source={require('../assets/mark.png')} style={styles.mark} accessibilityElementsHidden importantForAccessibility="no" />
);

type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger';
export const Button = ({ c, label, onPress, kind = 'secondary', disabled, style, accessibilityLabel }: {
  c: Colors; label: string; onPress: () => void; kind?: BtnKind; disabled?: boolean; style?: ViewStyle; accessibilityLabel?: string;
}) => {
  const bg = disabled ? c.raised : kind === 'primary' ? c.primary : kind === 'ghost' ? 'transparent' : c.surface;
  const ink = disabled ? c.faint : kind === 'primary' ? c.primaryInk : kind === 'danger' ? c.negative : c.text;
  const border = kind === 'secondary' && !disabled ? c.control : 'transparent';
  return (
    <Pressable role="button" accessibilityLabel={accessibilityLabel || label} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.btn, { backgroundColor: bg, borderColor: border, opacity: pressed ? 0.8 : 1, transform: [{ translateY: pressed ? 1 : 0 }] }, style]}>
      <Text style={[styles.btnText, { color: ink }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
};

export const Field = ({ c, style, ...rest }: TextInputProps & { c: Colors }) => {
  const [focus, setFocus] = React.useState(false);
  return (
    <TextInput placeholderTextColor={c.faint} {...rest}
      onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }} onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
      style={[styles.field, { color: c.text, backgroundColor: c.surface, borderColor: focus ? c.accent : c.control }, style]} />
  );
};

// Web only (and only where the browser has Web Speech): on iOS the keyboard's own dictation does the job.
export const DictateButton = ({ c, setText }: { c: Colors; setText: (f: (t: string) => string) => void }) => {
  const d = useDictation((w) => setText((t) => (t && !/\s$/.test(t) ? t + ' ' : t) + w));
  return d.supported ? <Button c={c} kind="ghost" label={d.listening ? t('common.listening') : t('common.dictate')} accessibilityLabel={t('common.dictate')} onPress={d.toggle} /> : null;
};

export const Pill = ({ label, bg, ink }: { label: string; bg: string; ink: string }) => (
  <View style={[styles.pill, { backgroundColor: bg }]}><Text style={[styles.pillText, { color: ink }]} numberOfLines={1}>{label}</Text></View>
);

export const time = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const styles = StyleSheet.create({
  mark: { width: 26, height: 26 },
  btn: { minHeight: size.touch, paddingHorizontal: 16, borderRadius: size.radiusControl, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: size.body, fontWeight: '600' },
  field: { minHeight: size.touch, borderWidth: 1, borderRadius: size.radiusControl, paddingHorizontal: 12, fontSize: size.body },
  pill: { height: 24, paddingHorizontal: 9, borderRadius: 999, justifyContent: 'center', flexShrink: 0 },
  pillText: { fontSize: size.small, fontWeight: '500' },
});
