// Dictation, one module for every field where the developer writes to Claude (Web Speech, fr-FR).
//   attachDictation(field, button, { lang, interim, status, fallback }) -> { supported, listening(), stop() }
//   field    a <textarea> or <input>; final words land at the cursor
//   button   the mic button; aria-pressed says it listens, title says what a click does
//   lang     'fr-FR' by default
//   interim  optional element for the words not yet final
//   status   optional element for the one-line message (refused mic...); else a <p class="dict-msg"> follows the field
//   fallback 'disable' (default: disabled button + title saying why) or 'hide' (no button at all)
// Stops on a second click or on Escape in the field. Nothing is thrown when SpeechRecognition is missing.
(function (root) {
  const T = (k, v) => (root.T ? root.T(k, v) : k);
  const MESSAGES = { 'not-allowed': 'speech.refused', 'service-not-allowed': 'speech.refused', 'audio-capture': 'speech.noMic', 'no-speech': '' };

  const label = (button, text) => { const el = button.querySelector && (button.querySelector('.mic-label') || button.querySelector('#micLabel')); if (el) el.textContent = text; };

  const insertAtCursor = (field, text) => {
    const start = field.selectionStart ?? field.value.length;
    const before = field.value.slice(0, start);
    const after = field.value.slice(field.selectionEnd ?? start);
    const ins = (before && !/\s$/.test(before) ? ' ' : '') + text.trim();
    field.value = before + ins + after;
    field.selectionStart = field.selectionEnd = (before + ins).length;
    const Ev = root.Event || globalThis.Event;
    if (field.dispatchEvent && Ev) field.dispatchEvent(new Ev('input', { bubbles: true }));
  };

  root.attachDictation = function attachDictation(field, button, opts = {}) {
    const none = { supported: false, listening: () => false, stop() {} };
    if (!field || !button) return none;
    const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (!SR) {
      if (opts.fallback === 'hide') button.hidden = true;
      else { button.disabled = true; button.title = T('speech.missing'); label(button, T('speech.unavailable')); }
      return none;
    }
    if (button.disabled) return none;
    const doc = field.ownerDocument || root.document;
    let status = opts.status || null;
    const say = (text) => {
      if (!status && text && doc && doc.createElement && field.insertAdjacentElement) {
        status = doc.createElement('p'); status.className = 'dict-msg'; status.setAttribute('role', 'status'); field.insertAdjacentElement('afterend', status);
      }
      if (status) status.textContent = text;
    };
    let rec = null; let on = false;
    const idle = () => { on = false; button.setAttribute('aria-pressed', 'false'); button.title = T('speech.dictate'); label(button, T('speech.dictate')); if (opts.interim) opts.interim.textContent = ''; };
    const stop = () => { if (rec) rec.stop(); };
    idle();
    button.addEventListener('click', () => {
      if (on) { stop(); return; }
      say('');
      rec = new SR(); rec.lang = opts.lang || (root.T && root.T.locale) || 'en-US'; rec.continuous = true; rec.interimResults = true;
      rec.onstart = () => { on = true; button.setAttribute('aria-pressed', 'true'); button.title = T('speech.stop'); label(button, T('speech.listening')); };
      rec.onresult = (ev) => {
        let fin = ''; let tmp = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) { const t = ev.results[i][0].transcript; if (ev.results[i].isFinal) fin += t; else tmp += t; }
        if (fin) insertAtCursor(field, fin);
        if (opts.interim) opts.interim.textContent = tmp;
      };
      rec.onerror = (ev) => { say(ev.error in MESSAGES ? (MESSAGES[ev.error] && T(MESSAGES[ev.error])) : T('speech.error', { e: ev.error })); };
      rec.onend = idle;
      rec.start();
    });
    field.addEventListener('keydown', (e) => { if (e.key === 'Escape' && on) stop(); });
    return { supported: true, listening: () => on, stop };
  };
})(typeof window !== 'undefined' ? window : globalThis);
