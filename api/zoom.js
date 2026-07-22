// ============================================================
//  /api/zoom — point d'entrée unique pour l'intégration Zoom.
//
//  Fusion de api/zoom/meeting.js et api/zoom/signature.js : le plan
//  Vercel Hobby refuse tout déploiement au-delà de 12 fonctions
//  serverless routées (les fichiers préfixés « _ » ne comptent pas).
//  Ces deux routes partageaient déjà api/zoom/_lib.js, même domaine,
//  même dossier — elles fusionnent ici sans perte de comportement.
//  Dispatch sur le paramètre de requête `action` :
//
//    GET  /api/zoom?action=meeting&courseId=dev-jeux-python
//    POST /api/zoom?action=signature   { meetingNumber, role }
//
//  Chaque action garde exactement son comportement d'origine
//  (méthode HTTP, codes de statut, forme de la réponse) — les
//  commentaires ci-dessous sont repris tels quels des fichiers
//  d'origine.
// ============================================================

const crypto = require('crypto');
const { getAccessToken, meetingIdForCourse, getMeeting } = require('./zoom/_lib');

const JOIN_WINDOW_BEFORE_MS = 10 * 60 * 1000; // ouverture 10 min avant le début
const DEFAULT_DURATION_MIN = 60;              // repli si Zoom ne renvoie pas de durée

// Encodage base64url (sans '=', '+', '/')
function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// ------------------------------------------------------------
//  action=meeting — GET ?courseId=dev-jeux-python
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
// ------------------------------------------------------------
async function handleMeeting(req, res) {
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
}

// ------------------------------------------------------------
//  action=signature — POST { meetingNumber, role }
//
//  OPTION B — préparation de l'incrustation vidéo (@zoomus/websdk).
//  Génère la signature JWT (HS256) exigée par le Meeting SDK Zoom,
//  signée côté serveur avec ZOOM_SDK_SECRET (jamais exposé au client).
//
//  role : 0 = participant (élève), 1 = animateur (mentor).
//  Renvoie 501 tant que le Meeting SDK n'est pas configuré → le front
//  conserve alors l'OPTION A (redirection) sans incrustation.
// ------------------------------------------------------------
async function handleSignature(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const sdkKey = process.env.ZOOM_SDK_KEY;
  const sdkSecret = process.env.ZOOM_SDK_SECRET;
  if (!sdkKey || !sdkSecret) {
    res.status(501).json({ error: 'Meeting SDK non configuré (ZOOM_SDK_KEY / ZOOM_SDK_SECRET).' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const meetingNumber = String((body && body.meetingNumber) || '').trim();
  const role = Number((body && body.role) || 0);
  if (!meetingNumber) {
    res.status(400).json({ error: 'meetingNumber manquant.' });
    return;
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // petite marge d'horloge
  const exp = iat + 60 * 60 * 2;                   // valable 2 h

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    appKey: sdkKey,
    sdkKey: sdkKey,
    mn: meetingNumber,
    role: role,
    iat: iat,
    exp: exp,
    tokenExp: exp
  };

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createHmac('sha256', sdkSecret)
    .update(unsigned)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  res.status(200).json({ signature: `${unsigned}.${signature}`, sdkKey });
}

// ------------------------------------------------------------
//  Dispatch — le paramètre `action` vient toujours de la query
//  string (Vercel la parse quelle que soit la méthode HTTP), donc
//  GET ?action=meeting comme POST ?action=signature fonctionnent.
// ------------------------------------------------------------
module.exports = async (req, res) => {
  const action = String((req.query && req.query.action) || '').trim();

  if (action === 'meeting') {
    await handleMeeting(req, res);
    return;
  }
  if (action === 'signature') {
    await handleSignature(req, res);
    return;
  }

  res.status(400).json({ error: "Paramètre action manquant ou invalide (attendu : « meeting » ou « signature »)." });
};
