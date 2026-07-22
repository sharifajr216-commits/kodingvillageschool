// Fonction serverless Vercel — LES SÉANCES DE L'UTILISATEUR CONNECTÉ, ET LES
// ACTIONS QU'IL PEUT Y FAIRE.
// Élève  → ses séances inscrites ; Enseignant → les séances qu'il anime.
//
// 🔒 CLOISONNEMENT : l'identité filtrante est lue dans le JETON SIGNÉ, jamais dans le
//    corps de la requête. Un utilisateur ne peut donc pas demander les séances d'un
//    autre (ni agir dessus) en changeant un paramètre — il faudrait forger une
//    signature HMAC.
//
// En-tête : Authorization: Bearer <token>   (ou body.token en repli)
//
// ── Comportement PAR DÉFAUT (pas de `action`, ou `action` absent) ──────────────
// POST/GET → 200 { ok:true, role, now, cancelLeadMin, sessions:[…] }
//            401 { ok:false, error:'unauthorized' }
//            500 { ok:false, error:'not_configured' }
//
// Séance vue par un ÉLÈVE :
//   { id, courseId, courseLabel, startsAt, endsAt, durationMin, teacherName,
//     status:'expected'|'absent', reason, isMakeup,
//     canCancel, cancelDeadline,          ← calculés par le SERVEUR (horloge fiable)
//     reschedule: null | { requestId, requestedStartsAt, state } }
//
// Séance vue par un ENSEIGNANT (il a besoin de savoir QUI il reçoit) :
//   { …, studentCount, presentCount, students:[{ username, name, status }] }
//
// `now` (horloge serveur) permet au front de corriger une horloge locale décalée :
// sans ça, un poste en avance de 10 min activerait le bouton « Rejoindre » trop tôt.
// `canCancel` suit la même logique : jamais recalculé côté navigateur, où l'heure
// est falsifiable.
//
// ── ACTIONS (pliées ici depuis l'ancien api/session-action.js — le plan Hobby de
//    Vercel plafonne à 12 fonctions serverless, et ces deux endpoints partagent déjà
//    la même authentification par jeton et la même règle d'identité : payload.sub /
//    payload.role, jamais le corps de la requête) ───────────────────────────────
//
// ÉLÈVE — POST { action:'cancel', sessionId, reason?, makeupStartsAt? }
//   → 200 { ok:true, sessionId, attendance, request }
//   → 400 { ok:false, error:'too_late' }        annulation à moins d'1 h du début
//   → 400 { ok:false, error:'already_absent' }  absence déjà signalée
//   → 400 { ok:false, error:'invalid_slot', message } créneau de rattrapage refusé
//   → 403 { ok:false, error:'not_enrolled' }    l'élève n'est pas inscrit à cette séance
//   → 404 { ok:false, error:'not_found' }
//   → 401 { ok:false, error:'unauthorized' }
//
// ENSEIGNANT — POST { action:'resched.decide', requestId, decision:'approve'|'refuse', note? }
//   → 200 { ok:true, alreadyDecided, request }
//   → 403 { ok:false, error:'not_your_request' }   la demande concerne un autre prof
//   Même décision que les liens de l'e-mail, mais depuis le tableau de bord : le
//   prof qui a déjà l'application ouverte n'a pas à retrouver le message.
//
// RÈGLE MÉTIER : annulation possible jusqu'à 1 heure avant le début (S.CANCEL_LEAD_MS).
// La séance N'EST PAS supprimée : elle reste au planning marquée « absent signalé »,
// pour que le professeur garde la trace et que les autres inscrits ne soient pas affectés.
//
// Si l'élève propose un créneau de rattrapage, un e-mail part vers le PROFESSEUR
// assigné et vers l'ADMIN, avec deux liens de décision en un clic (voir api/reschedule.js).

const A = require('./_auth');
const S = require('./_schedule');
const N = require('./_notify');

function readToken(req, body) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const t = String(hdr).replace(/^Bearer\s+/i, '');
  return t || (body && body.token) || '';
}

// Vue élève d'une séance : son propre statut de présence, et rien sur les autres.
async function studentView(s, username, now) {
  const att = S.attendanceOf(s, username);
  let reschedule = null;
  if (att.requestId) {
    const rq = await S.getReschedule(att.requestId);
    if (rq) {
      reschedule = {
        requestId: rq.requestId,
        requestedStartsAt: rq.requestedStartsAt,
        state: rq.state,
        decidedNote: rq.decidedNote || ''
      };
    }
  }
  return {
    id: s.id,
    courseId: s.courseId,
    courseLabel: s.courseLabel || s.courseId,
    startsAt: s.startsAt,
    durationMin: s.durationMin || 60,
    endsAt: new Date(Date.parse(s.startsAt) + (s.durationMin || 60) * 60000).toISOString(),
    teacherName: s.teacherName || '',
    status: att.status,
    reason: att.reason || '',
    isMakeup: !!(s.origin && s.origin.type === 'makeup'),
    canCancel: att.status !== 'absent' && S.canCancel(s, now),
    cancelDeadline: new Date(Date.parse(s.startsAt) - S.CANCEL_LEAD_MS).toISOString(),
    reschedule
    // Pour un élève, la liste des autres inscrits n'est délibérément PAS exposée.
  };
}

// Vue enseignant : la composition de SA classe, avec les absences signalées et
// l'état des demandes de rattrapage — c'est ce qu'il doit trancher.
async function teacherView(s) {
  const students = [];
  for (const u of (s.students || [])) {
    const acct = await A.getUser(u);
    const att = S.attendanceOf(s, u);
    let reschedule = null;
    if (att.requestId) {
      const rq = await S.getReschedule(att.requestId);
      if (rq) reschedule = { requestId: rq.requestId, requestedStartsAt: rq.requestedStartsAt, state: rq.state };
    }
    students.push({
      username: u,
      name: acct ? (`${acct.firstName || ''} ${acct.lastName || ''}`.trim() || u) : u,
      status: att.status,
      reason: att.reason || '',
      reschedule
    });
  }
  return {
    id: s.id,
    courseId: s.courseId,
    courseLabel: s.courseLabel || s.courseId,
    startsAt: s.startsAt,
    durationMin: s.durationMin || 60,
    endsAt: new Date(Date.parse(s.startsAt) + (s.durationMin || 60) * 60000).toISOString(),
    isMakeup: !!(s.origin && s.origin.type === 'makeup'),
    studentCount: students.length,
    presentCount: students.filter(x => x.status !== 'absent').length,
    students
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!A.configured() || !A.kvConfigured()) {
    res.status(500).json({ ok: false, error: 'not_configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  // ── ACTIONS : annulation par l'élève / décision de rattrapage par le prof ──
  // Repris à l'identique depuis api/session-action.js (voir en-tête de fichier).
  if (body.action) {
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

    const payload = A.verifyToken(readToken(req, body));
    if (!payload || !payload.sub || (payload.role !== 'student' && payload.role !== 'teacher')) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    const username = A.normUsername(payload.sub);

    try {
      // ── Décision d'un ENSEIGNANT sur une demande de rattrapage ───────────────
      if (body.action === 'resched.decide') {
        if (payload.role !== 'teacher') { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
        const rq = await S.getReschedule(String(body.requestId || '').slice(0, 40));
        if (!rq) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
        // 🔒 Un prof ne tranche que les demandes de SES séances.
        if (A.normUsername(rq.teacherUsername) !== username) {
          res.status(403).json({ ok: false, error: 'not_your_request' });
          return;
        }
        const decision = body.decision === 'refuse' ? 'refuse' : 'approve';
        const r = await S.decideReschedule(rq.requestId, decision, 'teacher', body.note);
        if (!r.ok) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
        if (!r.alreadyDecided) await N.notifyStudentOfDecision(r.request);
        res.status(200).json({ ok: true, alreadyDecided: !!r.alreadyDecided, request: r.request });
        return;
      }

      if (payload.role !== 'student') { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      if (body.action !== 'cancel') { res.status(400).json({ ok: false, error: 'unknown_action' }); return; }

      const session = await S.getSession(String(body.sessionId || '').slice(0, 40));
      if (!session) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      if (!(session.students || []).includes(username)) {
        res.status(403).json({ ok: false, error: 'not_enrolled' });
        return;
      }
      if (S.isAbsent(session, username)) {
        res.status(400).json({ ok: false, error: 'already_absent', message: 'Ton absence est déjà enregistrée pour cette séance.' });
        return;
      }
      // ⏰ La règle des 1 h est vérifiée ICI, côté serveur : l'horloge du navigateur
      // est falsifiable, celle du serveur non.
      if (!S.canCancel(session)) {
        res.status(400).json({
          ok: false, error: 'too_late',
          message: 'Trop tard : une séance ne peut être annulée que jusqu\'à 1 heure avant son début. Contacte l\'école.'
        });
        return;
      }

      // Créneau de rattrapage facultatif — validé avant toute écriture, pour ne pas
      // enregistrer une absence assortie d'une demande inexploitable.
      let makeupIso = null;
      if (body.makeupStartsAt) {
        const v = S.validateMakeupSlot(body.makeupStartsAt);
        if (!v.ok) { res.status(400).json({ ok: false, error: 'invalid_slot', message: v.message }); return; }
        makeupIso = new Date(v.ms).toISOString();
      }

      const user = await A.getUser(username);
      const studentName = user
        ? (`${user.firstName || ''} ${user.lastName || ''}`.trim() || username)
        : username;

      const { request } = await S.declareAbsence(session, {
        username,
        reason: body.reason,
        makeupStartsAt: makeupIso,
        studentName,
        studentEmail: user ? user.email : ''
      });

      // Notification best-effort — l'absence est déjà persistée à ce stade.
      const mail = request ? await N.notifyDecisionMakers(request) : null;

      res.status(200).json({
        ok: true,
        sessionId: session.id,
        attendance: S.attendanceOf(session, username),
        request: request ? {
          requestId: request.requestId,
          requestedStartsAt: request.requestedStartsAt,
          state: request.state
        } : null,
        notified: !!(mail && ((mail.teacher && mail.teacher.sent) || (mail.admin && mail.admin.sent)))
      });
    } catch (e) {
      console.error('[my-sessions:action]', e.message);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
    return;
  }

  // ── Comportement PAR DÉFAUT (inchangé) : liste des séances de l'utilisateur ──
  const payload = A.verifyToken(readToken(req, body));
  if (!payload || !payload.sub) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const now = Date.now();
    const isTeacher = payload.role === 'teacher';
    const list = isTeacher
      ? await S.sessionsForTeacher(payload.sub, 40)
      : await S.sessionsForStudent(payload.sub, 40);

    const sessions = [];
    for (const s of list) {
      sessions.push(isTeacher ? await teacherView(s) : await studentView(s, payload.sub, now));
    }

    res.status(200).json({
      ok: true,
      role: payload.role,
      now: new Date(now).toISOString(),
      cancelLeadMin: Math.round(S.CANCEL_LEAD_MS / 60000),
      makeupMaxAheadDays: S.MAKEUP_MAX_AHEAD_DAYS,
      sessions
    });
  } catch (e) {
    console.error('[my-sessions]', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
