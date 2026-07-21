// Fonction serverless Vercel — LES SÉANCES DE L'UTILISATEUR CONNECTÉ.
// Élève  → ses séances inscrites ; Enseignant → les séances qu'il anime.
//
// 🔒 CLOISONNEMENT : l'e-mail filtrant est lu dans le JETON SIGNÉ, jamais dans le
//    corps de la requête. Un utilisateur ne peut donc pas demander les séances d'un
//    autre en changeant un paramètre — il faudrait forger une signature HMAC.
//
// En-tête : Authorization: Bearer <token>   (ou body.token en repli)
//
// POST/GET → 200 { ok:true, now, sessions:[{ id, courseId, courseLabel,
//                                            startsAt, endsAt, durationMin }] }
//            401 { ok:false, error:'unauthorized' }
//            500 { ok:false, error:'not_configured' }
//
// `now` (horloge serveur) permet au front de corriger une horloge locale décalée :
// sans ça, un poste en avance de 10 min activerait le bouton « Rejoindre » trop tôt.

const A = require('./_auth');
const S = require('./_schedule');

function readToken(req, body) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const t = String(hdr).replace(/^Bearer\s+/i, '');
  return t || (body && body.token) || '';
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
    const isTeacher = payload.role === 'teacher';
    const list = isTeacher
      ? await S.sessionsForTeacher(payload.sub, 20)
      : await S.sessionsForStudent(payload.sub, 20);
    const sessions = list.map(s => ({
      id: s.id,
      courseId: s.courseId,
      courseLabel: s.courseLabel || s.courseId,
      startsAt: s.startsAt,
      durationMin: s.durationMin || 60,
      endsAt: new Date(Date.parse(s.startsAt) + (s.durationMin || 60) * 60000).toISOString(),
      // L'enseignant a besoin de savoir QUI il reçoit ; l'élève, non (cloisonnement).
      ...(isTeacher ? { studentCount: (s.students || []).length } : {})
      // Pour un élève, `students` n'est délibérément PAS exposé.
    }));
    res.status(200).json({ ok: true, role: payload.role, now: new Date().toISOString(), sessions });
  } catch (e) {
    console.error('[my-sessions]', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
