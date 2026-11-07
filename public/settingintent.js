// A sentence of the Conversation that only names a setting (« passe en autonome », « mode guidé », « éteins la
// rafale ») is not an idea to plan: the home offers the setting in one line instead of starting a planning
// (docs/backlog.md, defect of 2026-11-06 18:30). No model: the whole sentence must match one of the short forms
// below, anything else (a doubt included) keeps the usual path. Loaded by index.html before mainchat.js; the tests
// require it.
(function (root) {
  const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ').replace(/[.!?,;:…«»"]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:ok|bon|allez|alors)\s+/, '').replace(/\s+(?:stp|svp|s il te plait|s il vous plait|merci)$/, '');
  const VERB = '(?:passe|passer|repasse|repasser|mets|mettre|met|remets|bascule|basculer|active|activer|change|changer)'; // i18n-ok: words matched, never shown
  const MODE = new RegExp(`^(?:${VERB}(?:\\s+(?:le\\s+projet|tout|calmdev))?\\s+(?:en|au)\\s+)?(?:mode\\s+)?(autonome|auto|guide|surveille)$`); // i18n-ok: words matched
  const BURST = /^(eteins|eteindre|eteint|coupe|couper|desactive|desactiver|allume|allumer|rallume|active|activer)\s+(?:la\s+)?rafale(?:\s+auto(?:matique)?)?$/;
  const OFF = /^(?:etein|coupe|desactiv)/;

  // → { key: 'autonomy', mode, body } | { key: 'autoBurst', on, body } | null; body is what POST /api/project/settings takes
  // (with the project added); current: the stored settings, so the burst keeps its thresholds
  const detect = (text, current) => {
    const t = norm(text); if (!t || t.length > 60) return null;
    let m = MODE.exec(t);
    if (m) { const mode = m[1] === 'auto' ? 'autonome' : m[1]; /* i18n-ok: a mode id */ return { key: 'autonomy', mode, body: { autonomy: { mode } } }; }
    m = BURST.exec(t);
    if (m) { const on = !OFF.test(m[1]); const was = (current && current.autoBurst) || {}; return { key: 'autoBurst', on, body: { autoBurst: { ...was, on } } }; }
    return null;
  };

  const api = { detect, norm };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.escadrilleSettingIntent = api;
})(typeof window !== 'undefined' ? window : globalThis);
