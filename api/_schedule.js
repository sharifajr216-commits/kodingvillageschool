// Bibliothèque PARTAGÉE (préfixe `_` → non routée par Vercel).
// Stockage des SÉANCES DE COURS planifiées — le socle qui manquait pour les rappels.
//
// Utilisé par : api/admin.js (créer / lister / supprimer), api/reminders.js (cron)
//
// Modèle d'une séance :
//   {
//     id:          'ses_a1b2c3d4',
//     courseId:    'python-boucles',        // clé partagée avec ZOOM_COURSE_MEETINGS
//     courseLabel: 'Python · Les boucles',  // libellé affiché dans l'e-mail
//     startsAt:    '2026-07-20T17:00:00.000Z',  // TOUJOURS en UTC (ISO 8601)
//     durationMin: 60,
//     students:    ['eleve@example.com', ...],  // e-mails normalisés (clés KV user:<email>)
//     remindedAt:  null | '2026-07-20T16:00:12.000Z',  // garde-fou anti-doublon
//     createdAt:   '2026-07-19T10:00:00.000Z'
//   }
//
// Clés KV :
//   session:<id>       → JSON de la séance
//   sessions:byTime    → ZSET { score: epoch_ms de startsAt, member: id }
//                        permet de balayer « les séances des 60 prochaines minutes »
//                        sans lire toute la base (contrairement à un SMEMBERS complet).

const crypto = require('crypto');
const A = require('./_auth');

const Z_KEY = 'sessions:byTime';

const newId = () => `ses_${crypto.randomBytes(4).toString('hex')}`;

// Valide et normalise une date ISO → epoch ms. Renvoie null si invalide.
function parseWhen(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

async function getSession(id) {
  const raw = await A.kv(['GET', `session:${id}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function putSession(s) {
  await A.kv(['SET', `session:${s.id}`, JSON.stringify(s)]);
  await A.kv(['ZADD', Z_KEY, String(parseWhen(s.startsAt)), s.id]);
  return s;
}

async function createSession({ courseId, courseLabel, startsAt, durationMin, students }) {
  const when = parseWhen(startsAt);
  if (when === null) throw new Error('startsAt invalide (attendu : ISO 8601)');
  const s = {
    id: newId(),
    courseId: String(courseId || '').slice(0, 60),
    courseLabel: String(courseLabel || '').slice(0, 120),
    startsAt: new Date(when).toISOString(),
    durationMin: Number(durationMin) > 0 ? Number(durationMin) : 60,
    students: (Array.isArray(students) ? students : []).map(A.normEmail).filter(Boolean),
    remindedAt: null,
    createdAt: new Date().toISOString()
  };
  return putSession(s);
}

async function deleteSession(id) {
  await A.kv(['DEL', `session:${id}`]);
  await A.kv(['ZREM', Z_KEY, id]);
}

// Séances dont le début tombe dans [fromMs, toMs]. Utilisé par le cron.
// toMs accepte Infinity → borne haute ouverte ('+inf' côté Redis).
async function sessionsBetween(fromMs, toMs) {
  const max = Number.isFinite(toMs) ? String(toMs) : '+inf';
  const ids = (await A.kv(['ZRANGEBYSCORE', Z_KEY, String(fromMs), max])) || [];
  const out = [];
  for (const id of ids) { const s = await getSession(id); if (s) out.push(s); }
  return out;
}

// Séances d'UN élève : celles à venir + celle éventuellement en cours.
// On remonte de LOOKBACK_MS pour ne pas masquer un cours déjà commencé mais
// pas terminé (sinon l'élève perdrait le bouton « Rejoindre » en plein cours).
const LOOKBACK_MS = 6 * 3600000;
async function sessionsForStudent(email, limit = 20) {
  const target = A.normEmail(email);
  if (!target) return [];
  const now = Date.now();
  const all = await sessionsBetween(now - LOOKBACK_MS, Infinity);
  return all
    .filter(s => (s.students || []).includes(target))
    .filter(s => now < Date.parse(s.startsAt) + (s.durationMin || 60) * 60000) // pas encore terminée
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, limit);
}

// Les `limit` prochaines séances à partir de maintenant (affichage admin).
async function upcomingSessions(limit = 50) {
  const now = Date.now();
  const ids = (await A.kv(['ZRANGEBYSCORE', Z_KEY, String(now), '+inf', 'LIMIT', '0', String(limit)])) || [];
  const out = [];
  for (const id of ids) { const s = await getSession(id); if (s) out.push(s); }
  return out;
}

// Purge les séances terminées depuis plus de `days` jours (évite que le ZSET enfle).
async function purgeOlderThan(days = 30) {
  const cutoff = Date.now() - days * 86400000;
  const ids = (await A.kv(['ZRANGEBYSCORE', Z_KEY, '-inf', String(cutoff)])) || [];
  for (const id of ids) await deleteSession(id);
  return ids.length;
}

module.exports = {
  createSession, getSession, putSession, deleteSession,
  sessionsBetween, sessionsForStudent, upcomingSessions, purgeOlderThan, parseWhen
};
