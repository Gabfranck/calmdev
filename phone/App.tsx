// Escadrille on the phone: pairing, then the plan, the sessions and the journal, in one column.
import React from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { DEFAULT_BASE, getItem, KEYS, setItem } from './src/store';
import { useColors } from './src/theme';
import Pair from './src/screens/Pair';
import Main, { Target } from './src/screens/Main';
import { onOpened } from './src/notify';

// On the web only (the tests and the captures): ?base=…&token=… pairs the page, ?tab=… and ?session=… open a tab, ?plan=…&project=… plays a touched notification, ?filter=<path> picks the project.
const webParams = () => (Platform.OS === 'web' && typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null);

type Auth = { phase: 'loading' } | { phase: 'pair'; base: string } | { phase: 'in'; base: string; token: string };

export default function App() {
  const c = useColors();
  const [auth, setAuth] = React.useState<Auth>({ phase: 'loading' });
  const [target, setTarget] = React.useState<Target>(() => {
    const q = webParams(); return q && (q.get('tab') || q.get('session') || q.get('plan')) ? { plan: q.get('plan') || undefined, project: q.get('project') || undefined, session: q.get('session') || undefined, tab: q.get('tab') || undefined } : null;
  });

  React.useEffect(() => onOpened((t) => setTarget({ ...t })), []);

  React.useEffect(() => {
    (async () => {
      const q = webParams();
      if (q?.get('base')) await setItem(KEYS.base, q.get('base'));
      if (q?.get('token')) await setItem(KEYS.token, q.get('token'));
      if (q?.has('filter')) await setItem(KEYS.project, q.get('filter') || null); // a capture opens on one project
      const base = (await getItem(KEYS.base)) || DEFAULT_BASE;
      const token = await getItem(KEYS.token);
      setAuth(token ? { phase: 'in', base, token } : { phase: 'pair', base });
    })();
  }, []);

  const onPaired = async (base: string, token: string) => {
    await setItem(KEYS.base, base);
    await setItem(KEYS.token, token);
    setAuth({ phase: 'in', base, token });
  };
  // A 401 anywhere, or « Forget this phone »: the token goes, the address stays.
  const signOut = React.useCallback(async () => {
    await setItem(KEYS.token, null);
    setAuth((a) => ({ phase: 'pair', base: a.phase === 'loading' ? DEFAULT_BASE : a.base }));
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.ground }]}>
      <StatusBar style={c.ground === '#0f1216' ? 'light' : 'dark'} />
      {auth.phase === 'loading' ? <View style={styles.center}><ActivityIndicator color={c.muted} /></View>
        : auth.phase === 'pair' ? <Pair c={c} initialBase={auth.base} onPaired={onPaired} />
        : <Main c={c} base={auth.base} token={auth.token} onSignOut={signOut} target={target} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: Platform.OS === 'web' ? 0 : 44 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
