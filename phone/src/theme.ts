// Colour tokens, radii and sizes taken from public/app.css (light and dark), set for a phone:
// body at 16px, every touch target 44px at least, the system font.
import { useColorScheme } from 'react-native';

const light = {
  ground: '#eef2f6', surface: '#ffffff', raised: '#f3f5f8', active: '#e3e8ee',
  border: '#e4e8ed', rule: '#eef1f4', control: '#c9d0d8',
  text: '#15191e', muted: '#596069', faint: '#68707a',
  accent: '#1f56c4', accentInk: '#ffffff', accentTint: '#e6edfb',
  primary: '#15191e', primaryInk: '#ffffff',
  positive: '#1e7b4f', negative: '#c4242a', warning: '#92400e',
  posBg: '#dcfae5', posInk: '#04250e', negBg: '#ffedea', negInk: '#831c1e',
  warnBg: '#fffbeb', warnInk: '#92400e', waitBg: '#ffedd5', waitInk: '#9a3412',
  neutralBg: '#e9edf2', neutralInk: '#353a40',
};
export type Colors = typeof light;
const dark: Colors = {
  ground: '#0f1216', surface: '#171b20', raised: '#1f242a', active: '#262c33',
  border: '#262c33', rule: '#20262c', control: '#3b434c',
  text: '#f4f6f8', muted: '#b6bcc4', faint: '#969ea7',
  accent: '#6b9cff', accentInk: '#0b1a3a', accentTint: '#1b2a47',
  primary: '#f4f6f8', primaryInk: '#0f1216',
  positive: '#3fc07a', negative: '#e5566f', warning: '#e5a93b',
  posBg: '#172a1d', posInk: '#3fc07a', negBg: '#2c1a20', negInk: '#e5566f',
  warnBg: '#2b2414', warnInk: '#e5a93b', waitBg: '#33200f', waitInk: '#fb923c',
  neutralBg: '#262c33', neutralInk: '#e6e9ed',
};

export const size = {
  title: 22, section: 17, body: 16, small: 13, line: 22,
  pad: 16, gap: 12, touch: 44,
  radiusCard: 8, radiusControl: 6,
};

// A web capture can force the scheme with ?theme=dark or ?theme=light.
const forced = (): 'light' | 'dark' | null => {
  if (typeof window === 'undefined' || !window.location) return null;
  const t = new URLSearchParams(window.location.search).get('theme');
  return t === 'dark' || t === 'light' ? t : null;
};

export const useColors = (): Colors => {
  const scheme = useColorScheme();
  return (forced() || scheme) === 'dark' ? dark : light;
};

// The pill colours of a session status, as plan.html shows them.
export const statusTone = (c: Colors, status: string) => {
  if (status === 'running') return { bg: c.accentTint, ink: c.accent };
  if (status === 'waiting') return { bg: c.waitBg, ink: c.waitInk };
  if (status === 'done') return { bg: c.posBg, ink: c.posInk };
  if (status === 'error' || status === 'blocked') return { bg: c.negBg, ink: c.negInk };
  return { bg: c.neutralBg, ink: c.neutralInk };
};
