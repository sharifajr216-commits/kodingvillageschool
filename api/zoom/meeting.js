// ============================================================
//  GET /api/zoom/meeting?courseId=dev-jeux-python
//
//  Renvoie l'URL de la VRAIE réunion Zoom associée au cours, prête
//  pour l'OPTION A (redirection vers l'application native Zoom).
//
//  Sécurité horaire (défense en profondeur) : le join_url n'est
//  renvoyé QUE dans la fenêtre [début − 10 min, fin programmée].
//  En dehors → 403. Le front applique la même règle sur le bouton,
//  mais le serveur reste la source de vérité (impossible à contourner).
//
//  Codes de repli (le front rebascule alors en salle de classe démo) :
//    404 → aucune réunion mappée pour ce cours
//    501 → intégration Zoom non configurée (clés absentes)
// ============================================================

const { getAccessToken, meetingIdForCourse, getMeeting } = require('./_lib');

const JOIN_WINDOW_BEFORE_MS = 10 * 60 * 1000; // ouverture 10 min avant le début
const DEFAULT_DURATION_MIN = 60;              // repli si Zoom ne renvoie pas de durée

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const courseId = String((req.query && req.query.courseId) || '').trim();
  if (!courseId) {
    res.status(400).json({ error: 'Paramètre courseId manquant.' });
    return;
  }

  const meetingId = meetingIdForCourse(courseId);
  if (!meetingId) {
    res.status(404).json({ error: `Aucune réunion Zoom associée au cours « ${courseId} ».` });
    return;
  }

  // 1) Authentification Server-to-Server OAuth
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') {
      res.status(501).json({ error: e.message });
      return;
    }
    res.status(502).json({ error: 'Authentification Zoom impossible.' });
    return;
  }

  // 2) Récupération de la réunion + contrôle horaire serveur
  try {
    const m = await getMeeting(meetingId, token);

    const start = m.start_time ? new Date(m.start_time).getTime() : null;
    const durationMin = Number(m.duration) || DEFAULT_DURATION_MIN;
    const end = start ? start + durationMin * 60 * 1000 : null;
    const now = Date.now();

    if (start && now < start - JOIN_WINDOW_BEFORE_MS) {
      res.status(403).json({
        error: "La classe n'est pas encore ouverte.",
        opensAt: new Date(start - JOIN_WINDOW_BEFORE_MS).toISOString()
      });
      return;
    }
    if (end && now > end) {
      res.status(403).json({ error: 'Ce cours est terminé.' });
      return;
    }

    res.status(200).json({
      join_url: m.join_url,
      meetingNumber: String(m.id),
      topic: m.topic || '',
      password: m.password || '',
      startTime: m.start_time || null,
      endTime: end ? new Date(end).toISOString() : null,
      status: m.status || 'waiting'
    });
  } catch (e) {
    res.status(502).json({ error: 'Impossible de récupérer la réunion Zoom.' });
  }
};
