// Pose l'environnement attendu par api/_auth.js, puis remplace global.fetch pour
// router les appels KV vers le Redis en mémoire et capturer les e-mails Resend.
//
// À appeler AVANT tout require('../../api/...') : _auth.js lit les variables
// d'environnement au chargement du module.

const { createStore, kvExec } = require('./kv-mock');

const KV_URL = 'http://kv.test/mock';

function installHarness() {
  process.env.SESSION_SECRET = 'secret-de-test';
  process.env.ADMIN_EMAIL = 'admin@kvs.test';
  process.env.ADMIN_PASSWORD = 'mot-de-passe-admin';
  process.env.KV_REST_API_URL = KV_URL;
  process.env.KV_REST_API_TOKEN = 'jeton-kv';
  process.env.RESEND_API_KEY = 'resend-de-test';
  process.env.BOOKING_FROM_EMAIL = 'info@kodingvillageschool.com';
  process.env.PUBLIC_URL = 'http://localhost:3000';

  const store = createStore();
  const mails = [];

  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(KV_URL)) {
      try { return { ok: true, json: async () => ({ result: kvExec(store, JSON.parse(opts.body)) }) }; }
      catch (e) { return { ok: false, json: async () => ({ error: e.message }) }; }
    }
    if (u.startsWith('https://api.resend.com/emails')) {
      const payload = JSON.parse(opts.body);
      mails.push(payload);
      return { ok: true, json: async () => ({ id: 'mock_' + mails.length }) };
    }
    throw new Error('appel réseau inattendu : ' + u);
  };

  const reset = () => {
    store.strings.clear(); store.sets.clear(); store.zsets.clear(); store.expiries.clear();
    mails.length = 0;
  };

  return { store, mails, reset, kv: (cmd) => kvExec(store, cmd) };
}

module.exports = { installHarness };
