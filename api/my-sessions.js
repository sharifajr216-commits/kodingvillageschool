// Fonction serverless Vercel — LES SÉANCES DE L'UTILISATEUR CONNECTÉ.
// Élève  → ses séances inscrites ; Enseignant → les séances qu'il anime.
//
// 🔒 CLOISONNEMENT : l'identité filtrante est lue dans le JETON SIGNÉ, jamais dans le
//    corps de la requête. Un utilisateur ne peut donc pas demander les séances d'un
//    autre en changeant un paramètre — il faudrait forger une signature HMAC.
//
// En-tête : Authorization: Bearer <token>   (ou body.token en repli)
//
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

const A = require('./_auth');
const S = require('./_schedule');

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
