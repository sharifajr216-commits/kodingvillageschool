// Fonction serverless Vercel — ACTIONS DE L'ÉLÈVE SUR SES PROPRES SÉANCES.
//
// 🔒 CLOISONNEMENT : l'identité vient du JETON SIGNÉ (payload.sub), jamais du corps
//    de la requête. Un élève ne peut donc annuler que SES séances — il faudrait
//    forger une signature HMAC pour toucher à celles d'un autre.
//
// En-tête : Authorization: Bearer <token>   (ou body.token en repli)
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  if (!A.configured() || !A.kvConfigured()) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

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
    console.error('[session-action]', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
