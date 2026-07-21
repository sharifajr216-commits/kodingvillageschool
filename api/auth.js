// Fonction serverless Vercel — authentification (connexion + jeton + mot de passe).
// Comptes élèves et enseignants stockés en Vercel KV, indexés par IDENTIFIANT UNIQUE
// (username). L'admin est authentifié via variables d'env. Logique : api/_auth.js.
//
// L'identifiant de connexion accepte le USERNAME **ou** l'E-MAIL (un même e-mail peut
// être partagé par une fratrie : le mot de passe départage les comptes candidats).
//
// POST { action:'login', identifier, password }  → 200 { ok, token, role, username, firstName, lastName, mustChangePassword }
//        (identifier = username OU e-mail ; `email` accepté en repli)   role ∈ { admin, teacher, student }
//        401 { ok:false, error:'invalid_credentials' }
// POST { action:'verify', token }                → 200 { ok, username, email, role } | 401 invalid_token
// POST { action:'change_password', token, oldPassword, newPassword }
//        → 200 { ok:true } | 401 unauthorized/wrong_password | 400 weak_password
// POST { action:'diag' }                          → 200 { ok, env:{...booléens présence env, sans secret} }
//
// Codes : 400 requête invalide · 405 mauvaise méthode · 500 not_configured/server_error

const A = require('./_auth');

const MIN_PASSWORD_LEN = 8;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  if (!A.configured()) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  // Réponse de connexion réussie pour un compte KV (élève / enseignant).
  const loginOk = (account, role) => {
    const token = A.signToken({ sub: account.username, role, email: account.email || '' });
    res.status(200).json({
      ok: true, token, role,
      username: account.username, email: account.email || '',
      firstName: account.firstName || '', lastName: account.lastName || '',
      mustChangePassword: !!account.mustChangePassword
    });
  };

  try {
    if (body.action === 'verify') {
      const payload = A.verifyToken(body.token);
      if (!payload) { res.status(401).json({ ok: false, error: 'invalid_token' }); return; }
      res.status(200).json({ ok: true, username: payload.sub || '', email: payload.email || '', role: payload.role });
      return;
    }

    // Diagnostic de configuration : booléens de présence des variables d'env, AUCUN secret.
    if (body.action === 'diag') {
      res.status(200).json({ ok: true, env: A.envDiag() });
      return;
    }

    // Changement de mot de passe par l'utilisateur connecté (élève / enseignant).
    // L'identité vient du JETON SIGNÉ, jamais du corps → on ne peut changer que le sien.
    if (body.action === 'change_password') {
      const payload = A.verifyToken(body.token);
      if (!payload || !payload.sub || (payload.role !== 'student' && payload.role !== 'teacher')) {
        res.status(401).json({ ok: false, error: 'unauthorized' }); return;
      }
      if (!A.kvConfigured()) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < MIN_PASSWORD_LEN) {
        res.status(400).json({ ok: false, error: 'weak_password', message: `Le nouveau mot de passe doit faire au moins ${MIN_PASSWORD_LEN} caractères.` });
        return;
      }
      const isTeacher = payload.role === 'teacher';
      const account = isTeacher ? await A.getTeacher(payload.sub) : await A.getUser(payload.sub);
      if (!account) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      if (!A.verifyPassword(oldPassword, account.passHash)) {
        res.status(401).json({ ok: false, error: 'wrong_password', message: 'Ancien mot de passe incorrect.' });
        return;
      }
      account.passHash = A.hashPassword(newPassword);
      account.tempPassword = null;          // le mot de passe temporaire n'a plus cours
      account.mustChangePassword = false;
      if (isTeacher) await A.putTeacher(account); else await A.putUser(account);
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'login') {
      // Identifiant : username OU e-mail. `email` accepté en repli (anciens appels).
      const identifierRaw = String(body.identifier != null ? body.identifier : (body.email || '')).trim();
      const password = String(body.password || '');
      if (!identifierRaw || !password) { res.status(400).json({ ok: false, error: 'missing_credentials' }); return; }

      const asEmail = A.normEmail(identifierRaw);
      const asUsername = A.normUsername(identifierRaw);

      // 1) Admin (identifiants via env, par e-mail — sans KV)
      const admin = A.adminAuthDiagnose(asEmail, password);
      if (admin.ok) {
        const token = A.signToken({ sub: asEmail, role: 'admin', email: asEmail });
        res.status(200).json({ ok: true, token, role: 'admin', username: asEmail, firstName: 'Admin', lastName: '', mustChangePassword: false });
        return;
      }
      if (asEmail && asEmail === A.ADMIN_EMAIL) {
        console.warn(`[auth] Connexion admin refusée pour ${asEmail} — raison: ${admin.reason}`);
      }

      if (A.kvConfigured()) {
        // 2) Connexion par USERNAME (identité directe, non ambiguë).
        if (asUsername) {
          const found = await A.findAccountByUsername(asUsername);
          if (found && A.verifyPassword(password, found.account.passHash)) {
            loginOk(found.account, found.role); return;
          }
        }

        // 3) Connexion par E-MAIL : plusieurs comptes possibles (fratrie).
        //    Le mot de passe départage — le premier compte qui correspond gagne.
        if (asEmail) {
          const candidates = await A.findAccountsByEmail(asEmail);
          for (const c of candidates) {
            if (A.verifyPassword(password, c.account.passHash)) { loginOk(c.account, c.role); return; }
          }
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
