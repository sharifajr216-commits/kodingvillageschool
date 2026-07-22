// Fonction serverless Vercel — GESTION ADMIN des comptes élèves (école privée).
// Protégé : chaque requête exige un JETON ADMIN (obtenu via /api/auth → login).
// Logique partagée : api/_auth.js. Envoi des identifiants : Resend (serveur).
//
// En-tête : Authorization: Bearer <token admin>   (ou body.token en repli)
//
// Identité = USERNAME unique (l'e-mail est un contact partageable par une fratrie).
// POST { action:'username.suggest', firstName }              → { ok, username }         (suggestion libre)
// POST { action:'create', firstName, lastName, email, phone, slot, username? } → { ok, username, email, tempPassword }
// POST { action:'list' }                                     → { ok, students:[...] }   (sans secrets)
// POST { action:'send',   username }                         → { ok, sentAt }           (envoie l'e-mail)
// POST { action:'reset',  username }                         → { ok, tempPassword }
// POST { action:'delete', username }                         → { ok }
//
// Enseignants (comptes provisionnés par l'admin, rôle 'teacher' au login) :
// POST { action:'teacher.create', firstName, lastName, email, phone, username? } → { ok, username, email, tempPassword }
// POST { action:'teacher.list' }                             → { ok, teachers:[...] }  (sans secrets)
// POST { action:'teacher.send',   username }                 → { ok, sentAt }
// POST { action:'teacher.reset',  username }                 → { ok, tempPassword }
// POST { action:'teacher.delete', username }                 → { ok }
//
// Prospects d'essai (leads, reçus via api/booking) :
// POST { action:'leads.list' }                               → { ok, leads:[...] }
// POST { action:'leads.convert', id }                        → { ok, email, tempPassword, sentAt }  (crée le compte + envoie les accès)
// POST { action:'leads.delete',  id }                        → { ok }
//
// Séances de cours (socle des rappels automatiques — voir api/reminders.js) :
// POST { action:'session.create', courseId, courseLabel, startsAt, durationMin,
//        students:[username], teacherUsername? }             → { ok, session }
// POST { action:'session.createRecurring', courseId, courseLabel, fromDate,
//        weekdays:[2,3], time:'11:00', weeks, durationMin,
//        students:[username], teacherUsername?, tz? }        → { ok, seriesId, created, skipped, sessions }
// POST { action:'session.list' }                             → { ok, sessions:[...] }   (à venir)
// POST { action:'session.update', id, scope:'one'|'series',
//        courseId?, courseLabel?, startsAt?, durationMin?,
//        students?, teacherUsername? }                       → { ok, updated, session }
// POST { action:'session.delete', id }                       → { ok }
// POST { action:'session.deleteSeries', seriesId }           → { ok, deleted }          (occurrences à venir)
//
// Demandes de rattrapage (élève absent ayant proposé un nouveau créneau) :
// POST { action:'resched.list' }                             → { ok, requests:[...] }
// POST { action:'resched.decide', requestId, decision:'approve'|'refuse', note? }
//                                                            → { ok, request }
//
// Codes : 401 non-admin · 400 invalide · 404 introuvable · 409 existe déjà · 502 envoi échoué

const crypto = require('crypto');
const A = require('./_auth');
const B = require('./_brand');
const S = require('./_schedule');
const N = require('./_notify');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = B.FROM_EMAIL;   // source unique : api/_brand.js
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

// Résout le username d'un NOUVEAU compte : celui fourni par l'admin (validé unique),
// sinon une suggestion à partir du prénom (prenom, prenom2, prenom3…).
// Renvoie { username } ou { error:'username_taken' }.
async function resolveNewUsername(rawUsername, firstName) {
  const wanted = A.normUsername(rawUsername);
  if (wanted) {
    if (await A.accountExists(wanted)) return { error: 'username_taken' };
    return { username: wanted };
  }
  return { username: await A.suggestUsername(firstName) };
}

// Valide les participants d'une séance (élèves + enseignant) une seule fois pour
// `session.create` ET `session.createRecurring` : une récurrence qui accepterait
// un élève inconnu produirait 24 séances fantômes, sans rappel possible.
// Renvoie { students, teacherUsername, teacherName } ou { error: <corps 400> }.
async function resolveParticipants(body) {
  const students = Array.isArray(body.students) ? body.students.map(A.normUsername).filter(Boolean) : [];
  if (!students.length) {
    return { error: { ok: false, error: 'invalid', message: 'Au moins un élève inscrit est requis.' } };
  }
  // Refuse les élèves inconnus : sans compte, le rappel n'aurait ni nom ni e-mail.
  for (const u of students) {
    if (!(await A.getUser(u))) {
      return { error: { ok: false, error: 'unknown_student', message: `Aucun compte élève pour « ${u} ».` } };
    }
  }
  // Enseignant facultatif (par username). S'il est fourni, il doit exister.
  const teacherUsername = A.normUsername(body.teacherUsername);
  let teacherName = '';
  if (teacherUsername) {
    const teacher = await A.getTeacher(teacherUsername);
    if (!teacher) {
      return { error: { ok: false, error: 'unknown_teacher', message: `Aucun compte enseignant pour « ${teacherUsername} ».` } };
    }
    teacherName = `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim();
  }
  return { students, teacherUsername, teacherName };
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

// Envoie l'e-mail d'accès (identifiant + mot de passe temporaire) à un élève OU
// un enseignant. `kind` adapte le vocabulaire ('student' par défaut, ou 'teacher').
// Partagé par les actions `send` / `teacher.send` et la conversion (`leads.convert`).
async function sendCredsEmail(user, kind) {
  const isTeacher = kind === 'teacher';
  const espace = isTeacher ? 'ton espace enseignant' : 'ton espace élève';
  const subject = isTeacher
    ? 'Tes accès à ton espace enseignant KodingvillageSchool 👨‍🏫'
    : 'Tes accès à ton espace KodingvillageSchool 🎓';
  return resendSend({
    from: `KodingvillageSchool <${FROM_EMAIL}>`,
    to: [user.email],
    reply_to: A.ADMIN_EMAIL || undefined,
    subject,
    html: `
      <p style="font-family:Arial,sans-serif;font-size:15px">Bonjour ${esc(user.firstName)},</p>
      <p style="font-family:Arial,sans-serif;font-size:15px">Voici tes accès personnels à ${espace}${!isTeacher && user.slot ? ` (session du <b>${esc(user.slot)}</b>)` : ''} :</p>
      <table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">
        <tr><td><b>Adresse</b></td><td><a href="${esc(PUBLIC_URL)}">${esc(PUBLIC_URL)}</a></td></tr>
        <tr><td><b>Identifiant</b></td><td><code>${esc(user.username)}</code></td></tr>
        <tr><td><b>Mot de passe</b></td><td><code>${esc(user.tempPassword)}</code></td></tr>
      </table>
      <p style="font-family:Arial,sans-serif;font-size:13px;color:#666">Tu peux te connecter avec ton identifiant <b>ou</b> ton e-mail. Change ton mot de passe après la première connexion, depuis ton espace.</p>
      ${B.emailFooter()}`
  });
}

// Message d'erreur explicite quand l'expéditeur est encore l'adresse de test Resend.
function sendFailedMessage(e) {
  return B.usingTestSender()
    ? "Envoi refusé : l'expéditeur est encore l'adresse de test Resend (onboarding@resend.dev), "
      + "qui ne peut écrire qu'au propriétaire du compte Resend. Vérifie ton domaine dans Resend, "
      + "puis définis BOOKING_FROM_EMAIL. — Détail : " + String(e.message || 'Resend error')
    : String(e.message || 'Resend error');
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
    // Suggestion de username en direct pour le formulaire admin (depuis le prénom).
    if (body.action === 'username.suggest') {
      const username = await A.suggestUsername(clean(body.firstName, 60));
      res.status(200).json({ ok: true, username });
      return;
    }

    if (body.action === 'list') {
      const users = await A.listUsers();
      const students = users.map(u => ({
        username: u.username, firstName: u.firstName || '', lastName: u.lastName || '', email: u.email,
        phone: u.phone || '', slot: u.slot || '', createdAt: u.createdAt || null,
        credsSentAt: u.credsSentAt || null, hasCreds: !!u.tempPassword
      }));
      students.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.status(200).json({ ok: true, students });
      return;
    }

    if (body.action === 'create') {
      const firstName = clean(body.firstName, 60), lastName = clean(body.lastName, 60);
      const email = A.normEmail(body.email), slot = clean(body.slot, 80);
      // Téléphone facultatif — requis uniquement pour les rappels WhatsApp.
      const phone = clean(body.phone, 40);
      if (!firstName || !lastName || !isEmail(email)) { res.status(400).json({ ok: false, error: 'invalid' }); return; }
      // L'e-mail n'a plus à être unique (fratrie). L'unicité porte sur le USERNAME.
      const r = await resolveNewUsername(body.username, firstName);
      if (r.error) { res.status(409).json({ ok: false, error: 'username_taken', message: 'Cet identifiant est déjà pris.' }); return; }
      const tempPassword = genTempPassword();
      await A.putUser({
        username: r.username, firstName, lastName, email, phone, slot,
        passHash: A.hashPassword(tempPassword), tempPassword, mustChangePassword: true,
        createdAt: new Date().toISOString(), credsSentAt: null
      });
      // username + tempPassword renvoyés UNE fois à l'admin (aucun e-mail encore envoyé)
      res.status(200).json({ ok: true, username: r.username, email, tempPassword });
      return;
    }

    if (body.action === 'reset') {
      const user = await A.getUser(body.username);
      if (!user) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      const tempPassword = genTempPassword();
      user.passHash = A.hashPassword(tempPassword);
      user.tempPassword = tempPassword;
      user.mustChangePassword = true;
      user.credsSentAt = null;
      await A.putUser(user);
      res.status(200).json({ ok: true, username: user.username, email: user.email, tempPassword });
      return;
    }

    if (body.action === 'delete') {
      await A.deleteUser(body.username);
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'send') {
      const user = await A.getUser(body.username);
      if (!user) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      if (!user.tempPassword) { res.status(400).json({ ok: false, error: 'no_temp_password', message: 'Réinitialise le mot de passe avant de (r)envoyer.' }); return; }
      if (!isEmail(user.email)) { res.status(400).json({ ok: false, error: 'no_email', message: 'Ce compte n\'a pas d\'e-mail de contact valide.' }); return; }
      if (!RESEND_API_KEY) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }
      try {
        await sendCredsEmail(user);
      } catch (e) {
        // Cause n°1 des échecs : l'expéditeur est encore l'adresse de test Resend,
        // qui ne délivre qu'au propriétaire du compte. Le message brut de Resend
        // ne le dit pas clairement — on l'explicite pour éviter de chercher ailleurs.
        res.status(502).json({ ok: false, error: 'send_failed', message: sendFailedMessage(e) });
        return;
      }
      user.credsSentAt = new Date().toISOString();
      await A.putUser(user);
      res.status(200).json({ ok: true, sentAt: user.credsSentAt });
      return;
    }

    // ---- Enseignants (comptes provisionnés par l'admin, en KV) ----

    if (body.action === 'teacher.list') {
      const teachers = await A.listTeachers();
      const rows = teachers.map(t => ({
        username: t.username, firstName: t.firstName || '', lastName: t.lastName || '', email: t.email,
        phone: t.phone || '', createdAt: t.createdAt || null,
        credsSentAt: t.credsSentAt || null, hasCreds: !!t.tempPassword
      }));
      // Plus récents en premier.
      rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.status(200).json({ ok: true, teachers: rows });
      return;
    }

    if (body.action === 'teacher.create') {
      const firstName = clean(body.firstName, 60), lastName = clean(body.lastName, 60);
      const email = A.normEmail(body.email), phone = clean(body.phone, 40);
      if (!firstName || !lastName || !isEmail(email)) { res.status(400).json({ ok: false, error: 'invalid' }); return; }
      // Unicité sur le USERNAME (globale élèves + enseignants), plus sur l'e-mail.
      const r = await resolveNewUsername(body.username, firstName);
      if (r.error) { res.status(409).json({ ok: false, error: 'username_taken', message: 'Cet identifiant est déjà pris.' }); return; }
      const tempPassword = genTempPassword();
      await A.putTeacher({
        username: r.username, firstName, lastName, email, phone,
        passHash: A.hashPassword(tempPassword), tempPassword, mustChangePassword: true,
        createdAt: new Date().toISOString(), credsSentAt: null
      });
      res.status(200).json({ ok: true, username: r.username, email, tempPassword });
      return;
    }

    if (body.action === 'teacher.reset') {
      const teacher = await A.getTeacher(body.username);
      if (!teacher) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      const tempPassword = genTempPassword();
      teacher.passHash = A.hashPassword(tempPassword);
      teacher.tempPassword = tempPassword;
      teacher.mustChangePassword = true;
      teacher.credsSentAt = null;
      await A.putTeacher(teacher);
      res.status(200).json({ ok: true, username: teacher.username, email: teacher.email, tempPassword });
      return;
    }

    if (body.action === 'teacher.send') {
      const teacher = await A.getTeacher(body.username);
      if (!teacher) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      if (!teacher.tempPassword) { res.status(400).json({ ok: false, error: 'no_temp_password', message: 'Réinitialise le mot de passe avant de (r)envoyer.' }); return; }
      if (!isEmail(teacher.email)) { res.status(400).json({ ok: false, error: 'no_email', message: 'Ce compte n\'a pas d\'e-mail de contact valide.' }); return; }
      if (!RESEND_API_KEY) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }
      try {
        await sendCredsEmail(teacher, 'teacher');
      } catch (e) {
        res.status(502).json({ ok: false, error: 'send_failed', message: sendFailedMessage(e) });
        return;
      }
      teacher.credsSentAt = new Date().toISOString();
      await A.putTeacher(teacher);
      res.status(200).json({ ok: true, sentAt: teacher.credsSentAt });
      return;
    }

    if (body.action === 'teacher.delete') {
      await A.deleteTeacher(body.username);
      res.status(200).json({ ok: true });
      return;
    }

    // ---- Prospects d'essai (leads) : reçus via api/booking, convertis à la main ----

    if (body.action === 'leads.list') {
      const leads = await A.listLeads();
      // Plus récents en premier.
      leads.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      res.status(200).json({ ok: true, leads });
      return;
    }

    if (body.action === 'leads.delete') {
      await A.deleteLead(clean(body.id, 60));
      res.status(200).json({ ok: true });
      return;
    }

    // Conversion : crée le compte élève à partir du prospect, PUIS envoie les accès.
    // Un seul geste admin = « générer et envoyer les identifiants ».
    if (body.action === 'leads.convert') {
      const lead = await A.getLead(clean(body.id, 60));
      if (!lead) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      const email = A.normEmail(lead.email);
      if (!isEmail(email)) { res.status(400).json({ ok: false, error: 'invalid', message: 'E-mail du prospect invalide.' }); return; }
      if (!RESEND_API_KEY) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }

      // Plusieurs enfants d'une même famille peuvent partager l'e-mail parent :
      // on ne bloque plus sur l'e-mail, l'unicité porte sur le username auto-généré.
      const firstName = clean(lead.childFirst, 60) || clean(lead.parentFirst, 60);
      const tempPassword = genTempPassword();
      const user = {
        username: await A.suggestUsername(firstName),
        firstName,
        lastName: clean(lead.childLast, 60) || clean(lead.parentLast, 60),
        email, phone: clean(lead.phone, 40), slot: clean(lead.slot, 80),
        passHash: A.hashPassword(tempPassword), tempPassword, mustChangePassword: true,
        createdAt: new Date().toISOString(), credsSentAt: null
      };
      await A.putUser(user);

      // Envoi des accès. Si Resend refuse, le compte reste créé et le mot de passe
      // temporaire est renvoyé à l'admin pour transmission manuelle → on ne perd rien.
      try {
        await sendCredsEmail(user);
      } catch (e) {
        res.status(502).json({ ok: false, error: 'send_failed', username: user.username, email, tempPassword, message: sendFailedMessage(e) });
        return;
      }
      user.credsSentAt = new Date().toISOString();
      await A.putUser(user);

      // Le prospect est marqué converti (conservé pour l'historique).
      lead.status = 'converted';
      lead.convertedAt = user.credsSentAt;
      lead.studentEmail = email;
      lead.studentUsername = user.username;
      await A.putLead(lead);

      res.status(200).json({ ok: true, username: user.username, email, tempPassword, sentAt: user.credsSentAt });
      return;
    }

    // ---- Séances de cours (alimentent les rappels de api/reminders.js) ----

    if (body.action === 'session.create') {
      const startsAt = clean(body.startsAt, 40);
      if (S.parseWhen(startsAt) === null) {
        res.status(400).json({ ok: false, error: 'invalid', message: 'startsAt doit être une date ISO 8601 (ex: 2026-07-20T17:00:00Z).' });
        return;
      }
      const p = await resolveParticipants(body);
      if (p.error) { res.status(400).json(p.error); return; }
      const session = await S.createSession({
        courseId: clean(body.courseId, 60),
        courseLabel: clean(body.courseLabel, 120),
        startsAt, durationMin: body.durationMin,
        students: p.students, teacherUsername: p.teacherUsername, teacherName: p.teacherName
      });
      res.status(200).json({ ok: true, session });
      return;
    }

    // Récurrence hebdomadaire — « tous les mardis et mercredis à 11h00, 12 semaines ».
    // Chaque occurrence devient une VRAIE séance : elle peut être annulée seule,
    // déclenche son propre rappel, et accepte une absence sans toucher aux autres.
    if (body.action === 'session.createRecurring') {
      const p = await resolveParticipants(body);
      if (p.error) { res.status(400).json(p.error); return; }

      const t = /^(\d{1,2}):(\d{2})$/.exec(clean(body.time, 5));
      if (!t) { res.status(400).json({ ok: false, error: 'invalid', message: 'Heure invalide (attendu : HH:MM).' }); return; }
      const weekdays = Array.isArray(body.weekdays) ? body.weekdays : [];
      if (!weekdays.length) { res.status(400).json({ ok: false, error: 'invalid', message: 'Sélectionne au moins un jour de la semaine.' }); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(body.fromDate, 10))) {
        res.status(400).json({ ok: false, error: 'invalid', message: 'Date de début invalide (attendu : AAAA-MM-JJ).' });
        return;
      }

      let r;
      try {
        r = await S.createWeeklySeries({
          courseId: clean(body.courseId, 60),
          courseLabel: clean(body.courseLabel, 120),
          durationMin: body.durationMin,
          students: p.students, teacherUsername: p.teacherUsername, teacherName: p.teacherName,
          // L'heure est interprétée dans le fuseau de l'ÉCOLE, pas dans celui du
          // navigateur de l'admin : « 11h00 » doit signifier 11h00 à Montréal,
          // que l'admin se connecte depuis Vancouver, Paris ou Conakry.
          tz: clean(body.tz, 40) || S.DEFAULT_TZ,
          fromDate: clean(body.fromDate, 10),
          weekdays, hour: +t[1], minute: +t[2],
          weeks: body.weeks
        });
      } catch (e) {
        res.status(400).json({ ok: false, error: 'invalid', message: String(e.message || 'Récurrence invalide.') });
        return;
      }

      res.status(200).json({
        ok: true, seriesId: r.seriesId, created: r.created.length, skipped: r.skipped,
        sessions: r.created.map(s => ({ id: s.id, startsAt: s.startsAt }))
      });
      return;
    }

    if (body.action === 'session.list') {
      res.status(200).json({ ok: true, sessions: await S.upcomingSessions(200) });
      return;
    }

    // Correction d'une séance (mauvaise heure, mauvais cours, mauvais prof ou
    // mauvais élève) : avant cette action, la seule option était de supprimer
    // et recréer — 24 fois pour une récurrence entière mal saisie.
    // `scope:'one'` ne touche qu'à cette occurrence ; `scope:'series'` la
    // reporte aussi sur toutes les occurrences ULTÉRIEURES de la même série
    // (les passées sont préservées comme historique).
    if (body.action === 'session.update') {
      const id = clean(body.id, 40);
      const existing = await S.getSession(id);
      if (!existing) { res.status(404).json({ ok: false, error: 'not_found' }); return; }

      const patch = {};
      if (body.courseId !== undefined) patch.courseId = clean(body.courseId, 60);
      if (body.courseLabel !== undefined) patch.courseLabel = clean(body.courseLabel, 120);
      if (body.durationMin !== undefined) patch.durationMin = body.durationMin;
      if (body.startsAt !== undefined) {
        const startsAt = clean(body.startsAt, 40);
        if (S.parseWhen(startsAt) === null) {
          res.status(400).json({ ok: false, error: 'invalid', message: 'startsAt doit être une date ISO 8601 (ex: 2026-07-20T17:00:00Z).' });
          return;
        }
        patch.startsAt = startsAt;
      }
      // Élèves / enseignant validés EXACTEMENT comme à la création (même
      // helper) : un élève ou un enseignant inconnu produirait une séance sans
      // rappel possible. On retombe sur les valeurs actuelles pour la partie
      // non modifiée, pour que resolveParticipants voie toujours un jeu complet.
      if (body.students !== undefined || body.teacherUsername !== undefined) {
        const p = await resolveParticipants({
          students: body.students !== undefined ? body.students : existing.students,
          teacherUsername: body.teacherUsername !== undefined ? body.teacherUsername : existing.teacherUsername
        });
        if (p.error) { res.status(400).json(p.error); return; }
        if (body.students !== undefined) patch.students = p.students;
        if (body.teacherUsername !== undefined) { patch.teacherUsername = p.teacherUsername; patch.teacherName = p.teacherName; }
      }

      const scope = body.scope === 'series' ? 'series' : 'one';
      let result;
      try {
        result = scope === 'series'
          ? await S.updateSeriesFrom(id, patch)
          : { updated: 1, session: await S.updateSession(id, patch) };
      } catch (e) {
        res.status(400).json({ ok: false, error: 'invalid', message: String(e.message || 'Modification invalide.') });
        return;
      }
      if (!result.session) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      res.status(200).json({ ok: true, updated: result.updated, session: result.session });
      return;
    }

    if (body.action === 'session.delete') {
      await S.deleteSession(clean(body.id, 40));
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'session.deleteSeries') {
      const deleted = await S.deleteSeriesUpcoming(clean(body.seriesId, 40));
      res.status(200).json({ ok: true, deleted });
      return;
    }

    // ---- Demandes de rattrapage (file de validation, miroir des liens e-mail) ----

    if (body.action === 'resched.list') {
      res.status(200).json({ ok: true, requests: await S.listReschedules() });
      return;
    }

    if (body.action === 'resched.decide') {
      const decision = body.decision === 'refuse' ? 'refuse' : 'approve';
      const r = await S.decideReschedule(clean(body.requestId, 40), decision, 'admin', clean(body.note, 400));
      if (!r.ok) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      // Même e-mail de retour que la décision prise depuis le lien du message :
      // l'élève reçoit exactement la même information, quelle que soit la porte
      // d'entrée utilisée par l'école.
      if (!r.alreadyDecided) await N.notifyStudentOfDecision(r.request);
      res.status(200).json({ ok: true, alreadyDecided: !!r.alreadyDecided, request: r.request });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
