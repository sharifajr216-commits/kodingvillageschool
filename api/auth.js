// Fonction serverless Vercel — authentification (connexion + vérification de jeton).
// Comptes élèves stockés en Vercel KV ; l'admin est authentifié via variables d'env.
// Toute la logique (hachage, jetons, KV) est dans api/_auth.js.
//
// POST { action:'login',  email, password } → 200 { ok, token, role, firstName, lastName }
//                                             401 { ok:false, error:'invalid_credentials' }
// POST { action:'verify', token }           → 200 { ok, email, role } | 401 invalid_token
//
// Codes : 400 requête invalide · 405 mauvaise méthode · 500 not_configured/server_error

const A = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  if (!A.configured()) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  try {
    if (body.action === 'verify') {
      const payload = A.verifyToken(body.token);
      if (!payload) { res.status(401).json({ ok: false, error: 'invalid_token' }); return; }
      res.status(200).json({ ok: true, email: payload.email, role: payload.role });
      return;
    }

    if (body.action === 'login') {
      const email = A.normEmail(body.email);
      const password = String(body.password || '');
      if (!email || !password) { res.status(400).json({ ok: false, error: 'missing_credentials' }); return; }

      // 1) Admin (identifiants via env, sans KV)
      if (A.isAdminCredentials(email, password)) {
        const token = A.signToken({ email, role: 'admin' });
        res.status(200).json({ ok: true, token, role: 'admin', firstName: 'Admin', lastName: '' });
        return;
      }

      // 2) Élève (compte provisionné par l'admin, en KV)
      if (A.kvConfigured()) {
        const user = await A.getUser(email);
        if (user && A.verifyPassword(password, user.passHash)) {
          const token = A.signToken({ email, role: 'student' });
          res.status(200).json({ ok: true, token, role: 'student', firstName: user.firstName || '', lastName: user.lastName || '' });
          return;
        }
      }

      res.status(401).json({ ok: false, error: 'invalid_credentials' });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
