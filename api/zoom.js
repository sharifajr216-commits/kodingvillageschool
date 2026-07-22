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
const A = require('./_auth');
const S = require('./_schedule');

const JOIN_WINDOW_BEFORE_MS = 10 * 60 * 1000; // ouverture 10 min avant le début
const DEFAULT_DURATION_MIN = 60;              // repli si Zoom ne renvoie pas de durée

// Lit le jeton signé : en-tête Authorization: Bearer …, avec repli sur body.token
// (identique à api/my-sessions.js — même convention partout).
function readToken(req, body) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const t = String(hdr).replace(/^Bearer\s+/i, '');
  return t || (body && body.token) || '';
}

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
//  🔒 FAILLE CORRIGÉE ICI : cette route ne demandait auparavant AUCUNE
//  authentification. Les courseId sont devinables (scratch, python-boucles,
//  dev-jeux-python…) : n'importe qui sur Internet pouvait obtenir le
//  join_url d'une classe d'enfants. La « défense » horaire qui existait
//  ([début − 10 min, fin]) était en plus totalement inopérante : les
//  réunions Zoom de l'école sont des récurrences SANS heure fixe, donc
//  `m.start_time` est toujours `null` côté API Zoom — les deux gardes-fous
//  qui en dépendaient ne se déclenchaient JAMAIS (vérifié en prod : un
//  join_url valide était renvoyé à 2h du matin).
//
//  Nouvelle chaîne d'autorisation :
//    1) Jeton signé obligatoire (élève ou enseignant — jamais admin).
//    2) Il doit avoir, MAINTENANT, une séance de CE cours dans NOTRE
//       planning (api/_schedule.js), dont la fenêtre est
//       [startsAt − 10 min, startsAt + durationMin]. C'est NOTRE séance,
//       pas Zoom, qui sert désormais de source de vérité pour l'horaire :
//       elle a un vrai startsAt/durationMin fixés par l'école, là où Zoom
//       n'a rien de fiable à offrir pour une récurrence sans heure.
//    3) Un élève ayant déclaré une absence sur cette séance est refusé.
//
//  Codes de repli (le front rebascule alors en salle de classe démo) :
//    404 → aucune réunion mappée pour ce cours
//    501 → intégration Zoom non configurée (clés absentes)
//  401 (jeton absent/invalide) et 403 (pas de séance ouverte / absence
//  déclarée) ne déclenchent PAS ce repli côté front — voir joinZoomMeeting
//  dans index.html.
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

  // 1) Authentification — jeton signé obligatoire, élève ou enseignant
  //    uniquement (un compte admin n'assiste à aucun cours).
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const auth = A.verifyToken(readToken(req, body));
  if (!auth || !auth.sub || (auth.role !== 'student' && auth.role !== 'teacher')) {
    res.status(401).json({ error: 'Connexion requise pour rejoindre cette classe.' });
    return;
  }
  const username = A.normUsername(auth.sub);

  // 2) Une séance de CE cours doit exister pour cet utilisateur ET être dans
  //    sa fenêtre horaire MAINTENANT — voir commentaire d'en-tête : c'est
  //    NOTRE planning qui fait foi, jamais Zoom.
  let mySessions;
  try {
    mySessions = auth.role === 'teacher'
      ? await S.sessionsForTeacher(username, 40)
      : await S.sessionsForStudent(username, 40);
  } catch (e) {
    res.status(500).json({ error: 'Planning indisponible pour le moment.' });
    return;
  }

  const now = Date.now();
  const seancesDuCours = mySessions
    .filter(s => s.courseId === courseId)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  const session = seancesDuCours.find(s => {
    const start = Date.parse(s.startsAt);
    const durationMin = Number(s.durationMin) > 0 ? Number(s.durationMin) : DEFAULT_DURATION_MIN;
    return now >= start - JOIN_WINDOW_BEFORE_MS && now <= start + durationMin * 60000;
  });

  if (!session) {
    const prochaine = seancesDuCours[0];
    if (prochaine) {
      const opensAt = new Date(Date.parse(prochaine.startsAt) - JOIN_WINDOW_BEFORE_MS).toISOString();
      res.status(403).json({
        error: `La classe n'est pas encore ouverte pour ce cours. Prochaine ouverture : ${opensAt}.`,
        opensAt
      });
      return;
    }
    res.status(403).json({ error: "Aucune séance de ce cours n'est prévue pour toi en ce moment." });
    return;
  }

  // 3) Élève ayant déclaré une absence sur CETTE séance : pas de lien.
  if (S.isAbsent(session, username)) {
    res.status(403).json({ error: 'Tu as signalé une absence pour cette séance — le lien de connexion n’est pas disponible.' });
    return;
  }

  const meetingId = meetingIdForCourse(courseId);
  if (!meetingId) {
    res.status(404).json({ error: `Aucune réunion Zoom associée au cours « ${courseId} ».` });
    return;
  }

  // 4) Authentification Server-to-Server OAuth
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

  // 5) Récupération de la réunion. Aucun contrôle horaire sur m.start_time
  //    ici (voir en-tête) : NOTRE séance (vérifiée au point 2) fixe déjà
  //    startTime/endTime ci-dessous, seule source fiable.
  try {
    const m = await getMeeting(meetingId, token);
    const durationMin = Number(session.durationMin) > 0 ? Number(session.durationMin) : DEFAULT_DURATION_MIN;
    const start = Date.parse(session.startsAt);
    const end = start + durationMin * 60000;

    res.status(200).json({
      join_url: m.join_url,
      meetingNumber: String(m.id),
      topic: m.topic || '',
      password: m.password || '',
      startTime: session.startsAt,
      endTime: new Date(end).toISOString(),
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
