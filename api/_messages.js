// Bibliothèque PARTAGÉE (préfixe `_` → non routée par Vercel).
// MESSAGERIE ENSEIGNANT ↔ FAMILLE : fils, messages, non-lus.
//
// Utilisé par : api/messages.js (point d'entrée HTTP)
//
// Un fil est UNIQUE par binôme (enseignant, élève) et son identifiant est
// DÉTERMINISTE : `th_<enseignant>|<eleve>`. Deux conséquences — on ne peut pas
// créer deux fils pour le même binôme, et on retrouve le fil sans index.
// Le séparateur `|` est interdit par normUsername (api/_auth.js) : contrairement
// à `__`, il ne peut pas rendre le découpage ambigu.
//
// Clés KV :
//   thread:<tid>                JSON du fil
//   thread:<tid>:seq            compteur monotone du fil (INCR)
//   thread:<tid>:msgs           ZSET { score: numéro de séquence, member: messageId }
//   msg:<mid>                   JSON du message
//   threads:rank                compteur monotone global (INCR)
//   threads:teacher:<username>  ZSET trié par rang → boîte enseignant
//   threads:student:<username>  ZSET trié par rang → boîte famille
//   threads:all                 ZSET trié par rang → supervision admin

const crypto = require('crypto');
const A = require('./_auth');
const S = require('./_schedule');

const MAX_BODY = 2000;
const SNIPPET_LEN = 140;

const SIDES = ['teacher', 'student'];
const otherSide = (side) => (side === 'teacher' ? 'student' : 'teacher');

const threadId = (teacher, student) =>
  `th_${A.normUsername(teacher)}|${A.normUsername(student)}`;

function parseThreadId(tid) {
  const m = /^th_([^|]+)\|(.+)$/.exec(String(tid || ''));
  if (!m) return null;
  const teacherUsername = A.normUsername(m[1]);
  const studentUsername = A.normUsername(m[2]);
  if (!teacherUsername || !studentUsername) return null;
  return { teacherUsername, studentUsername };
}

const newMessageId = () => `msg_${crypto.randomBytes(4).toString('hex')}`;
const fullName = (a, fallback) =>
  a ? (`${a.firstName || ''} ${a.lastName || ''}`.trim() || fallback) : fallback;

async function getThread(tid) {
  const raw = await A.kv(['GET', `thread:${tid}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Écrit le fil ET réaligne les trois index de boîte de réception.
//
// Le score est `t.rank`, un rang monotone attribué UNIQUEMENT à l'ajout d'un
// message (voir appendMessage) — pas l'horodatage. Deux raisons :
//   - deux fils dont le dernier message tombe dans la même milliseconde
//     seraient départagés au hasard par Redis (ordre lexicographique du membre) ;
//   - putThread est aussi appelé par markRead / noteAlerted, et une simple
//     LECTURE ne doit pas faire remonter le fil en tête de la boîte.
// Un fil sans message n'a pas encore de rang : il vaut 0 et se range donc EN BAS
// de la boîte, ce qui est exact — il n'a aucune activité. Surtout, ne pas replier
// sur l'horodatage : un epoch en millisecondes (~1,8e12) écraserait des rangs
// valant 1, 2, 3…, et le fil vide resterait épinglé en tête à jamais.
async function putThread(t) {
  const score = String(t.rank || 0);
  await A.kv(['SET', `thread:${t.id}`, JSON.stringify(t)]);
  await A.kv(['ZADD', `threads:teacher:${t.teacherUsername}`, score, t.id]);
  await A.kv(['ZADD', `threads:student:${t.studentUsername}`, score, t.id]);
  await A.kv(['ZADD', 'threads:all', score, t.id]);
  return t;
}

async function ensureThread({ teacherUsername, studentUsername }) {
  const teacher = A.normUsername(teacherUsername);
  const student = A.normUsername(studentUsername);
  const tid = threadId(teacher, student);
  const existing = await getThread(tid);
  if (existing) return existing;

  const [tAcct, sAcct] = [await A.getTeacher(teacher), await A.getUser(student)];
  const now = new Date().toISOString();
  return putThread({
    id: tid,
    teacherUsername: teacher, teacherName: fullName(tAcct, teacher),
    studentUsername: student, studentName: fullName(sAcct, student),
    createdAt: now, lastMessageAt: now,
    lastFrom: '', lastSnippet: '',
    unread: { teacher: 0, student: 0 },
    lastReadAt: { teacher: null, student: null },
    alerted: { teacher: null, student: null }
  });
}

async function appendMessage(thread, { fromRole, fromUsername, fromName, body }) {
  const texte = String(body == null ? '' : body).trim();
  if (!texte) throw new Error('Le message est vide.');
  if (texte.length > MAX_BODY) throw new Error(`Message trop long (${MAX_BODY} caractères maximum).`);
  if (!SIDES.includes(fromRole)) throw new Error('Rôle d\'expéditeur invalide.');

  const sentAt = new Date().toISOString();
  const message = {
    id: newMessageId(), threadId: thread.id,
    fromRole, fromUsername: A.normUsername(fromUsername),
    fromName: String(fromName || '').slice(0, 120),
    body: texte, sentAt
  };
  // Score = numéro de SÉQUENCE du fil, pas l'horodatage. Deux messages envoyés
  // dans la même milliseconde partageraient le même score, et Redis départage
  // alors par ordre lexicographique du membre — c'est-à-dire au hasard, nos
  // identifiants étant aléatoires. La séquence garantit l'ordre d'insertion.
  // `sentAt` reste dans le message : c'est lui qu'on affiche.
  const seq = await A.kv(['INCR', `thread:${thread.id}:seq`]);
  await A.kv(['SET', `msg:${message.id}`, JSON.stringify(message)]);
  await A.kv(['ZADD', `thread:${thread.id}:msgs`, String(seq), message.id]);

  // Rang GLOBAL, pour l'ordre des boîtes de réception. Même raisonnement que
  // ci-dessus, appliqué entre fils plutôt qu'à l'intérieur d'un fil.
  thread.rank = Number(await A.kv(['INCR', 'threads:rank']));

  const dest = otherSide(fromRole);
  thread.lastMessageAt = sentAt;
  thread.lastFrom = fromRole;
  thread.lastSnippet = texte.slice(0, SNIPPET_LEN);
  thread.unread = thread.unread || { teacher: 0, student: 0 };
  thread.unread[dest] = (thread.unread[dest] || 0) + 1;
  await putThread(thread);

  return { thread, message };
}

// Messages du fil, du plus ancien au plus récent. `limit` s'applique à la FIN
// (les plus récents), `before` remonte l'historique.
//
// Le curseur est un IDENTIFIANT de message, pas un horodatage : deux messages
// envoyés dans la même milliseconde ont le même score, et un curseur temporel
// en sauterait un définitivement — sur aucune page. Chercher la position de
// l'identifiant dans la liste est exact par construction.
async function getMessages(tid, { limit = 50, before = null } = {}) {
  const ids = (await A.kv(['ZRANGEBYSCORE', `thread:${tid}:msgs`, '-inf', '+inf'])) || [];
  // Curseur inconnu (message supprimé, identifiant fabriqué) → on repart de la fin.
  const pos = before ? ids.indexOf(before) : -1;
  const fin = pos >= 0 ? pos : ids.length;
  const retenus = ids.slice(Math.max(0, fin - limit), fin);
  const out = [];
  for (const id of retenus) {
    const raw = await A.kv(['GET', `msg:${id}`]);
    if (!raw) continue;
    try { out.push(JSON.parse(raw)); } catch (_) { /* message illisible : ignoré */ }
  }
  return out;
}

// Fils d'un utilisateur, plus récemment actifs d'abord.
// `role === 'admin'` lit l'index global : c'est la supervision de l'école.
async function listThreads(role, username, limit = 50) {
  const key = role === 'admin'
    ? 'threads:all'
    : `threads:${role}:${A.normUsername(username)}`;
  const ids = (await A.kv(['ZREVRANGE', key, '0', String(limit - 1)])) || [];
  const out = [];
  for (const id of ids) { const t = await getThread(id); if (t) out.push(t); }
  return out;
}

// ── Lecture et alertes ──────────────────────────────────────────────────────

// Marque le fil lu pour un côté. L'accusé de lecture affiché à l'expéditeur se
// déduit ensuite de lastReadAt[autre] : aucun champ par message à maintenir.
async function markRead(thread, side) {
  if (!SIDES.includes(side)) throw new Error('Côté invalide.');
  thread.unread = thread.unread || { teacher: 0, student: 0 };
  thread.lastReadAt = thread.lastReadAt || { teacher: null, student: null };
  thread.unread[side] = 0;
  thread.lastReadAt[side] = new Date().toISOString();
  await putThread(thread);
  return thread;
}

// Faut-il envoyer une alerte e-mail à `side` ?
//
// Règle : on alerte si aucune alerte n'a encore été envoyée, OU si le
// destinataire a lu depuis la dernière. Autrement dit une seule alerte tant
// qu'il n'a pas ouvert le fil — trois messages d'affilée ne font qu'un e-mail.
// Fonction PURE : elle n'écrit rien, c'est noteAlerted qui horodate.
function shouldAlert(thread, side) {
  const alerted = (thread.alerted || {})[side];
  if (!alerted) return true;
  const lu = (thread.lastReadAt || {})[side];
  if (!lu) return false;
  return Date.parse(lu) >= Date.parse(alerted);
}

async function noteAlerted(thread, side) {
  thread.alerted = thread.alerted || { teacher: null, student: null };
  thread.alerted[side] = new Date().toISOString();
  await putThread(thread);
  return thread;
}

// ── Droits d'accès, déduits des séances ─────────────────────────────────────
//
// Aucune table de permissions à maintenir : le droit d'échanger découle du fait
// d'avoir cours ensemble. On balaie tout le ZSET des séances (passé conservé +
// futur), le volume d'une école privée le permet.

const RATE_MAX = 20;
const RATE_WINDOW_S = 300;

async function sharesSession(teacherUsername, studentUsername) {
  const t = A.normUsername(teacherUsername);
  const s = A.normUsername(studentUsername);
  if (!t || !s) return false;
  const toutes = await S.sessionsBetween(0, Infinity);
  return toutes.some(x =>
    A.normUsername(x.teacherUsername) === t && (x.students || []).includes(s));
}

// Seule la CRÉATION d'un fil exige une séance commune. Un fil déjà ouvert le
// reste : sinon le canal se fermerait pendant les vacances ou à l'échéance d'un
// cycle, précisément quand une famille écrit pour organiser la suite.
async function canOpen(teacherUsername, studentUsername) {
  if (await getThread(threadId(teacherUsername, studentUsername))) return true;
  return sharesSession(teacherUsername, studentUsername);
}

async function contactsFor(role, username) {
  const u = A.normUsername(username);
  if (!u || !SIDES.includes(role)) return [];
  const toutes = await S.sessionsBetween(0, Infinity);
  const vus = new Set();
  for (const s of toutes) {
    if (role === 'teacher') {
      if (A.normUsername(s.teacherUsername) !== u) continue;
      for (const e of s.students || []) vus.add(e);
    } else {
      if (!(s.students || []).includes(u)) continue;
      const t = A.normUsername(s.teacherUsername);
      if (t) vus.add(t);
    }
  }
  const out = [];
  for (const nom of [...vus].sort()) {
    const acct = role === 'teacher' ? await A.getUser(nom) : await A.getTeacher(nom);
    out.push({ username: nom, name: fullName(acct, nom) });
  }
  return out;
}

// Compteur à fenêtre glissante grossière : sans lui, un enfant qui découvre le
// bouton peut écrire trois cents messages en deux minutes. Le groupement des
// alertes plafonne les e-mails, pas les écritures en base.
async function rateLimited(username) {
  const key = `rate:msg:${A.normUsername(username)}`;
  // La clé et son expiration naissent ensemble (SET … EX … NX). Avec un INCR
  // suivi d'un EXPIRE conditionnel, un processus qui meurt entre les deux
  // laisserait une clé SANS expiration : le compteur ne repasserait jamais par 1,
  // EXPIRE ne serait plus jamais appelé, et l'utilisateur resterait bloqué À VIE.
  const cree = await A.kv(['SET', key, '1', 'EX', String(RATE_WINDOW_S), 'NX']);
  const n = cree ? 1 : Number(await A.kv(['INCR', key]));
  return n > RATE_MAX;
}

module.exports = {
  threadId, parseThreadId, getThread, putThread, ensureThread,
  appendMessage, getMessages, listThreads,
  markRead, shouldAlert, noteAlerted,
  sharesSession, canOpen, contactsFor, rateLimited,
  otherSide, MAX_BODY, SNIPPET_LEN, SIDES, RATE_MAX, RATE_WINDOW_S
};
