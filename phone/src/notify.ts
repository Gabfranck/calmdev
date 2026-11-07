// Notifications pushed by the server through Expo. Nothing of it runs on the web: expo-notifications
// is only loaded on a phone. The Expo push token needs the EAS projectId (app.json extra.eas.projectId,
// written by `npx eas init`, see phone/README.md).
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { t } from './i18n';

type N = typeof import('expo-notifications');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Notifications: N | null = Platform.OS === 'web' ? null : require('expo-notifications');

export const projectId = (): string | null =>
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId || Constants.easConfig?.projectId || null;

// Why the switch cannot work here, or null when it can.
export const unavailable = (): string | null => {
  if (!Notifications || !Device.isDevice) return t('notify.phoneOnly');
  if (!projectId()) return t('notify.phoneOnlyEas');
  return null;
};

if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

// Asks for the permission and returns the Expo push token; throws with a sentence when it cannot.
export const enable = async (): Promise<string> => {
  const why = unavailable(); if (why) throw new Error(why);
  const N = Notifications as N;
  let { status } = await N.getPermissionsAsync();
  if (status !== 'granted') status = (await N.requestPermissionsAsync()).status;
  if (status !== 'granted') throw new Error(t('notify.denied'));
  const { data } = await N.getExpoPushTokenAsync({ projectId: projectId() as string });
  return data;
};

export type Opened = { plan?: string; session?: string; project?: string };
// A touched notification opens the app on the plan and the session of its data (and the one that
// launched the app, read once at start).
export const onOpened = (cb: (t: Opened) => void): (() => void) => {
  if (!Notifications) return () => {};
  const read = (r: { notification: { request: { content: { data?: Record<string, unknown> } } } } | null) => {
    const d = r?.notification.request.content.data || {};
    if (d.plan || d.session) cb({ plan: d.plan ? String(d.plan) : undefined, session: d.session ? String(d.session) : undefined, project: d.project ? String(d.project) : undefined });
  };
  Notifications.getLastNotificationResponseAsync().then(read).catch(() => {});
  const sub = Notifications.addNotificationResponseReceivedListener(read);
  return () => sub.remove();
};
