// The device token and the Mac's address: SecureStore on the phone, localStorage on the web.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const web = Platform.OS === 'web';

export const getItem = async (key: string): Promise<string | null> => {
  if (web) return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  return SecureStore.getItemAsync(key);
};

export const setItem = async (key: string, value: string | null): Promise<void> => {
  if (web) {
    if (typeof localStorage === 'undefined') return;
    if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    return;
  }
  if (value == null) await SecureStore.deleteItemAsync(key); else await SecureStore.setItemAsync(key, value);
};

export const KEYS = { base: 'escadrille.base', token: 'escadrille.token', notify: 'escadrille.notify', project: 'escadrille.project' };
export const DEFAULT_BASE = 'http://192.168.1.x:3078';
