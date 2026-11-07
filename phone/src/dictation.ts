// Dictation on the phone: iOS keyboard dictation is native and needs nothing. In the web build (stub, localhost:8081)
// a mic button appears when the browser has Web Speech, same principle as public/speech.js (no import from there).
import React from 'react';
import { Platform } from 'react-native';
import { speechLocale } from './i18n';

export function useDictation(append: (words: string) => void) {
  const SR = Platform.OS === 'web' && typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
  const rec = React.useRef<any>(null);
  const [listening, setListening] = React.useState(false);
  React.useEffect(() => () => rec.current?.stop(), []);
  const toggle = () => {
    if (rec.current && listening) { rec.current.stop(); return; }
    const r = new SR(); r.lang = speechLocale; r.continuous = true; r.interimResults = false;
    r.onstart = () => setListening(true);
    r.onresult = (ev: any) => { let fin = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) fin += ev.results[i][0].transcript; if (fin.trim()) append(fin.trim()); };
    r.onend = () => { setListening(false); rec.current = null; };
    r.onerror = () => {};
    rec.current = r; r.start();
  };
  return { supported: !!SR, listening, toggle };
}
