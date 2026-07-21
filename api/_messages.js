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
//   thread:<tid>:msgs           ZSET { score: epoch_ms, member: messageId }
//   msg:<mid>                   JSON du message
//   threads:teacher:<username>  ZSET trié par dernier message → boîte enseignant
//   threads:student:<username>  ZSET trié par dernier message → boîte famille
//   threads:all                 ZSET trié par dernier message → supervision admin

const crypto = require('crypto');
const A = require('./_auth');

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

// Écrit le fil ET réaligne les trois index sur `lastMessageAt` : un fil dont
// l'index n'est pas mis à jour disparaît du haut de la boîte de réception.
async function putThread(t) {
  const score = String(Date.parse(t.lastMessageAt || t.createdAt));
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
  await A.kv(['SET', `msg:${message.id}`, JSON.stringify(message)]);
  await A.kv(['ZADD', `thread:${thread.id}:msgs`, String(Date.parse(sentAt)), message.id]);

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
// (les plus récents), `before` remonte l'historique depuis un horodatage.
async function getMessages(tid, { limit = 50, before = null } = {}) {
  const max = before ? String(Date.parse(before) - 1) : '+inf';
  const ids = (await A.kv(['ZRANGEBYSCORE', `thread:${tid}:msgs`, '-inf', max])) || [];
  const retenus = ids.slice(Math.max(0, ids.length - limit));
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

module.exports = {
  threadId, parseThreadId, getThread, putThread, ensureThread,
  appendMessage, getMessages, listThreads,
  otherSide, MAX_BODY, SNIPPET_LEN, SIDES
};
