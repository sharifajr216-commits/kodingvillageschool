// Fonction serverless Vercel — authentification (connexion + vérification de jeton).
// Comptes élèves stockés en Vercel KV ; l'admin est authentifié via variables d'env.
// Toute la logique (hachage, jetons, KV) est dans api/_auth.js.
//
// POST { action:'login',  email, password } → 200 { ok, token, role, firstName, lastName }
//                                             401 { ok:false, error:'invalid_credentials' }
// POST { action:'verify', token }           → 200 { ok, email, role } | 401 invalid_token
// POST { action:'diag' }                     → 200 { ok, env:{...booléens présence env, sans secret} }
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

    // Diagnostic de configuration : booléens de présence des variables d'env, AUCUN secret.
    // Permet de vérifier que la fonction déployée « voit » bien tes variables Vercel.
    if (body.action === 'diag') {
      res.status(200).json({ ok: true, env: A.envDiag() });
      return;
    }

    if (body.action === 'login') {
      const email = A.normEmail(body.email);
      const password = String(body.password || '');
      if (!email || !password) { res.status(400).json({ ok: false, error: 'missing_credentials' }); return; }

      // 1) Admin (identifiants via env, sans KV)
      const admin = A.adminAuthDiagnose(email, password);
      if (admin.ok) {
        const token = A.signToken({ email, role: 'admin' });
        res.status(200).json({ ok: true, token, role: 'admin', firstName: 'Admin', lastName: '' });
        return;
      }
      // L'e-mail correspond à l'admin mais la connexion est refusée → log clair côté serveur
      // (visible dans les logs Vercel) avec la RAISON, sans jamais logguer de secret.
      if (email === A.ADMIN_EMAIL) {
        console.warn(`[auth] Connexion admin refusée pour ${email} — raison: ${admin.reason}`);
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
