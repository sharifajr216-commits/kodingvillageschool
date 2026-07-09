// ============================================================
//  Helpers partagés pour l'intégration Zoom.
//  Le préfixe « _ » exclut ce fichier du routage Vercel : il n'est
//  JAMAIS exposé comme endpoint, seulement importé par les routes.
//
//  Sécurité : les secrets Zoom (CLIENT_SECRET, SDK_SECRET) ne vivent
//  QUE côté serveur (variables d'environnement Vercel). Aucun secret
//  ne transite par le navigateur.
// ============================================================

const ZOOM_OAUTH = 'https://zoom.us/oauth/token';
const ZOOM_API = 'https://api.zoom.us/v2';

// --- Server-to-Server OAuth : échange les identifiants du compte
//     contre un access_token de courte durée (~1 h). ---
async function getAccessToken() {
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  const accountId = process.env.ZOOM_ACCOUNT_ID;

  if (!clientId || !clientSecret || !accountId) {
    const err = new Error('Zoom non configuré (ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET / ZOOM_ACCOUNT_ID manquants).');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const url = `${ZOOM_OAUTH}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) {
    throw new Error(d.reason || d.error || 'Authentification Zoom (OAuth) échouée.');
  }
  return d.access_token;
}

// --- Résout un courseId (ex: "dev-jeux-python") en Meeting ID Zoom,
//     via la table JSON ZOOM_COURSE_MEETINGS. Renvoie null si absent. ---
function meetingIdForCourse(courseId) {
  let map = {};
  try { map = JSON.parse(process.env.ZOOM_COURSE_MEETINGS || '{}'); } catch (_) { map = {}; }
  return (courseId && map[courseId]) || null;
}

// --- Récupère les détails d'une réunion Zoom planifiée
//     (join_url, start_time, duration, password, status...). ---
async function getMeeting(meetingId, token) {
  const r = await fetch(`${ZOOM_API}/meetings/${encodeURIComponent(meetingId)}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const d = await r.json();
  if (!r.ok) {
    throw new Error(d.message || `Réunion Zoom ${meetingId} introuvable.`);
  }
  return d;
}

module.exports = { getAccessToken, meetingIdForCourse, getMeeting, ZOOM_API };
