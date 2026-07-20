// Fonction serverless Vercel — GESTION ADMIN des comptes élèves (école privée).
// Protégé : chaque requête exige un JETON ADMIN (obtenu via /api/auth → login).
// Logique partagée : api/_auth.js. Envoi des identifiants : Resend (serveur).
//
// En-tête : Authorization: Bearer <token admin>   (ou body.token en repli)
//
// POST { action:'create', firstName, lastName, email, phone, slot } → { ok, email, tempPassword }
// POST { action:'list' }                                     → { ok, students:[...] }   (sans secrets)
// POST { action:'send',   email }                            → { ok, sentAt }           (envoie l'e-mail)
// POST { action:'reset',  email }                            → { ok, tempPassword }
// POST { action:'delete', email }                            → { ok }
//
// Séances de cours (socle des rappels automatiques — voir api/reminders.js) :
// POST { action:'session.create', courseId, courseLabel, startsAt, durationMin, students:[email] }
//                                                            → { ok, session }
// POST { action:'session.list' }                             → { ok, sessions:[...] }   (à venir)
// POST { action:'session.delete', id }                       → { ok }
//
// Codes : 401 non-admin · 400 invalide · 404 introuvable · 409 existe déjà · 502 envoi échoué

const crypto = require('crypto');
const A = require('./_auth');
const B = require('./_brand');
const S = require('./_schedule');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.BOOKING_FROM_EMAIL || 'onboarding@resend.dev';
const PUBLIC_URL = B.PUBLIC_URL;

const clean = (s, max = 120) => String(s == null ? '' : s).trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Mot de passe temporaire lisible (sans caractères ambigus 0/O/1/l/I)
function genTempPassword() {
  const UP = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lo = 'abcdefghijkmnpqrstuvwxyz', num = '23456789';
  const pick = (set, k) => Array.from(crypto.randomBytes(k)).map(b => set[b % set.length]).join('');
  return `Kvs-${pick(UP, 1)}${pick(lo, 3)}-${pick(num, 4)}`;
}

async function resendSend(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error((d && d.message) || `Resend HTTP ${r.status}`);
  return d.id;
}

// Exige un jeton admin valide (en-tête Authorization ou body.token)
function requireAdmin(req, body) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  let token = String(hdr).replace(/^Bearer\s+/i, '');
  if (!token && body && body.token) token = body.token;
  const payload = A.verifyToken(token);
  return payload && payload.role === 'admin' ? payload : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  if (!A.configured() || !A.kvConfigured()) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  if (!requireAdmin(req, body)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  try {
    if (body.action === 'list') {
      const users = await A.listUsers();
      const students = users.map(u => ({
        firstName: u.firstName || '', lastName: u.lastName || '', email: u.email,
        phone: u.phone || '', slot: u.slot || '', createdAt: u.createdAt || null,
        credsSentAt: u.credsSentAt || null, hasCreds: !!u.tempPassword
      }));
      res.status(200).json({ ok: true, students });
      return;
    }

    if (body.action === 'create') {
      const firstName = clean(body.firstName, 60), lastName = clean(body.lastName, 60);
      const email = A.normEmail(body.email), slot = clean(body.slot, 80);
      // Téléphone facultatif — requis uniquement pour les rappels WhatsApp.
      const phone = clean(body.phone, 40);
      if (!firstName || !lastName || !isEmail(email)) { res.status(400).json({ ok: false, error: 'invalid' }); return; }
      if (await A.getUser(email)) { res.status(409).json({ ok: false, error: 'exists' }); return; }
      const tempPassword = genTempPassword();
      await A.putUser({
        firstName, lastName, email, phone, slot,
        passHash: A.hashPassword(tempPassword), tempPassword,
        createdAt: new Date().toISOString(), credsSentAt: null
      });
      // tempPassword renvoyé UNE fois à l'admin pour affichage/copie (aucun e-mail encore envoyé)
      res.status(200).json({ ok: true, email, tempPassword });
      return;
    }

    if (body.action === 'reset') {
      const email = A.normEmail(body.email);
      const user = await A.getUser(email);
      if (!user) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      const tempPassword = genTempPassword();
      user.passHash = A.hashPassword(tempPassword);
      user.tempPassword = tempPassword;
      user.credsSentAt = null;
      await A.putUser(user);
      res.status(200).json({ ok: true, email, tempPassword });
      return;
    }

    if (body.action === 'delete') {
      await A.deleteUser(A.normEmail(body.email));
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'send') {
      const email = A.normEmail(body.email);
      const user = await A.getUser(email);
      if (!user) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      if (!user.tempPassword) { res.status(400).json({ ok: false, error: 'no_temp_password', message: 'Réinitialise le mot de passe avant de (r)envoyer.' }); return; }
      if (!RESEND_API_KEY) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }
      try {
        await resendSend({
          from: `KodingvillageSchool <${FROM_EMAIL}>`,
          to: [email],
          reply_to: A.ADMIN_EMAIL || undefined,
          subject: 'Tes accès à ton espace KodingvillageSchool 🎓',
          html: `
            <p style="font-family:Arial,sans-serif;font-size:15px">Bonjour ${esc(user.firstName)},</p>
            <p style="font-family:Arial,sans-serif;font-size:15px">Voici tes accès personnels à ton espace élève${user.slot ? ` (session du <b>${esc(user.slot)}</b>)` : ''} :</p>
            <table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">
              <tr><td><b>Adresse</b></td><td><a href="${esc(PUBLIC_URL)}">${esc(PUBLIC_URL)}</a></td></tr>
              <tr><td><b>Identifiant</b></td><td>${esc(email)}</td></tr>
              <tr><td><b>Mot de passe</b></td><td><code>${esc(user.tempPassword)}</code></td></tr>
            </table>
            <p style="font-family:Arial,sans-serif;font-size:13px;color:#666">Connecte-toi et garde ces identifiants confidentiels.</p>
            ${B.emailFooter()}`
        });
      } catch (e) {
        res.status(502).json({ ok: false, error: 'send_failed', message: String(e.message || 'Resend error') });
        return;
      }
      user.credsSentAt = new Date().toISOString();
      await A.putUser(user);
      res.status(200).json({ ok: true, sentAt: user.credsSentAt });
      return;
    }

    // ---- Séances de cours (alimentent les rappels de api/reminders.js) ----

    if (body.action === 'session.create') {
      const startsAt = clean(body.startsAt, 40);
      if (S.parseWhen(startsAt) === null) {
        res.status(400).json({ ok: false, error: 'invalid', message: 'startsAt doit être une date ISO 8601 (ex: 2026-07-20T17:00:00Z).' });
        return;
      }
      const students = Array.isArray(body.students) ? body.students.map(A.normEmail).filter(isEmail) : [];
      if (!students.length) {
        res.status(400).json({ ok: false, error: 'invalid', message: 'Au moins un élève inscrit est requis.' });
        return;
      }
      // Refuse les élèves inconnus : sans compte, le rappel n'aurait ni nom ni téléphone.
      for (const e of students) {
        if (!(await A.getUser(e))) {
          res.status(400).json({ ok: false, error: 'unknown_student', message: `Aucun compte pour ${e}.` });
          return;
        }
      }
      const session = await S.createSession({
        courseId: clean(body.courseId, 60),
        courseLabel: clean(body.courseLabel, 120),
        startsAt, durationMin: body.durationMin, students
      });
      res.status(200).json({ ok: true, session });
      return;
    }

    if (body.action === 'session.list') {
      res.status(200).json({ ok: true, sessions: await S.upcomingSessions(100) });
      return;
    }

    if (body.action === 'session.delete') {
      await S.deleteSession(clean(body.id, 40));
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
