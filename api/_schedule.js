// Bibliothèque PARTAGÉE (préfixe `_` → non routée par Vercel).
// Stockage des SÉANCES DE COURS planifiées — le socle des plannings et des rappels.
//
// Utilisé par : api/admin.js (créer / lister / supprimer), api/reminders.js (cron),
//               api/my-sessions.js (planning élève & enseignant, absence + demande de report),
//               api/reschedule.js (validation en un clic par le prof / l'admin)
//
// Modèle d'une séance :
//   {
//     id:          'ses_a1b2c3d4',
//     courseId:    'python-boucles',        // clé partagée avec ZOOM_COURSE_MEETINGS
//     courseLabel: 'Python · Les boucles',  // libellé affiché dans l'e-mail
//     startsAt:    '2026-07-20T17:00:00.000Z',  // TOUJOURS en UTC (ISO 8601)
//     durationMin: 60,
//     students:    ['bilal', 'sara2', ...],     // USERNAMES (clés KV user:<username>)
//     teacherUsername:'awa' | '',               // enseignant assigné (clé KV teacher:<username>)
//     teacherName: 'Awa Diop' | '',             // dénormalisé pour l'e-mail de rappel
//     attendance:  { '<username>': { status, declaredAt, reason, requestId } },
//     origin:      null | { type:'makeup', fromSessionId, requestId },
//     seriesId:    null | 'ser_xxxx',           // regroupe les occurrences d'une récurrence
//     remindedAt:  null | '2026-07-20T16:00:12.000Z',  // garde-fou anti-doublon
//     createdAt:   '2026-07-19T10:00:00.000Z'
//   }
//
// `attendance[username].status` ∈ { 'expected', 'absent' }. Une séance n'est JAMAIS
// supprimée quand un élève se désiste : elle reste au planning, marquée « absent
// signalé ». Le prof garde ainsi la trace, et les autres élèves inscrits ne sont
// pas affectés.
//
// Clés KV :
//   session:<id>          → JSON de la séance
//   sessions:byTime       → ZSET { score: epoch_ms de startsAt, member: id }
//                           permet de balayer « les séances des 60 prochaines minutes »
//                           sans lire toute la base (contrairement à un SMEMBERS complet).
//   resched:<requestId>   → JSON de la demande de report (source de vérité)
//   reschedules:index     → SET des requestId (file de validation admin)

const crypto = require('crypto');
const A = require('./_auth');

const Z_KEY = 'sessions:byTime';
const RQ_INDEX = 'reschedules:index';

// ── Règles métier ───────────────────────────────────────────────────────────
// Un élève ne peut annuler / demander un report que jusqu'à 1 heure avant le
// début. Cette valeur est reprise TELLE QUELLE dans l'e-mail de rappel
// (api/reminders.js) et dans l'interface élève — un seul endroit à changer.
const CANCEL_LEAD_MS = 60 * 60 * 1000;
// Horizon maximal d'un créneau de rattrapage proposé par l'élève.
const MAKEUP_MAX_AHEAD_DAYS = 60;
// Fuseau de référence de l'école pour la planification (heure de Montréal).
const DEFAULT_TZ = process.env.SCHOOL_TIMEZONE || 'America/Toronto';

const newId = () => `ses_${crypto.randomBytes(4).toString('hex')}`;
const newSeriesId = () => `ser_${crypto.randomBytes(4).toString('hex')}`;
const newRequestId = () => `rq_${crypto.randomBytes(6).toString('hex')}`;

// Valide et normalise une date ISO → epoch ms. Renvoie null si invalide.
function parseWhen(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ── Fuseaux horaires, sans dépendance ───────────────────────────────────────
// Décalage du fuseau `tz` à l'instant `utcMs`, en millisecondes.
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day,
    +(p.hour === '24' ? '0' : p.hour), +p.minute, +p.second);
  return asUTC - utcMs;
}

// « 2026-09-01 11:00 à Montréal » → instant UTC exact.
// Deux passes : le décalage dépend de l'instant, et l'instant du décalage — une
// seule passe se trompe d'une heure aux deux bascules d'heure d'été.
function zonedToUtcMs({ y, mo, d, h, mi }, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = naive;
  for (let i = 0; i < 2; i++) utc = naive - tzOffsetMs(utc, tz);
  return utc;
}

// Décompose un instant UTC dans un fuseau (miroir de zonedToUtcMs).
function utcToZoned(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: +(p.hour === '24' ? '0' : p.hour), mi: +p.minute,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  };
}

// Occurrences hebdomadaires : « tous les mardis et mercredis à 11h00, 12 semaines ».
//
// `weekdays` : 0=dimanche … 6=samedi. `fromDate` : 'YYYY-MM-DD' dans le fuseau `tz`
// (jour à partir duquel on commence à balayer, inclus).
//
// L'arithmétique se fait sur la DATE CIVILE (flottante, sans fuseau), et la
// conversion en UTC n'intervient qu'à la fin, occurrence par occurrence. C'est ce
// qui garantit que « 11h00 heure de Montréal » reste 11h00 après le passage à
// l'heure d'hiver — alors qu'un simple « +7 jours en millisecondes » dériverait
// d'une heure deux fois par an.
function expandWeekly({ fromDate, weeks, weekdays, hour, minute, tz }) {
  const zone = tz || DEFAULT_TZ;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromDate || ''));
  if (!m) throw new Error('fromDate invalide (attendu : YYYY-MM-DD)');
  const days = (Array.isArray(weekdays) ? weekdays : [])
    .map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  if (!days.length) throw new Error('Aucun jour de la semaine sélectionné');
  const nbWeeks = Math.min(Math.max(parseInt(weeks, 10) || 0, 1), 52);
  const h = Math.min(Math.max(parseInt(hour, 10) || 0, 0), 23);
  const mi = Math.min(Math.max(parseInt(minute, 10) || 0, 0), 59);

  const out = [];
  // Date civile de départ, manipulée en « UTC flottant » : Date.UTC ne subit
  // aucun fuseau, donc +1 jour = exactement +1 jour civil, sans piège d'été.
  const cursor = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  for (let i = 0; i < nbWeeks * 7; i++) {
    if (days.includes(cursor.getUTCDay())) {
      out.push(zonedToUtcMs({
        y: cursor.getUTCFullYear(), mo: cursor.getUTCMonth() + 1, d: cursor.getUTCDate(),
        h, mi
      }, zone));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out.sort((a, b) => a - b);
}

// ── Séances ─────────────────────────────────────────────────────────────────

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

// Construit l'objet séance SANS l'écrire (utilisé par createSession et la
// création en lot d'une récurrence, pour qu'elles ne puissent pas diverger).
function buildSession({ courseId, courseLabel, startsAt, durationMin, students, teacherUsername, teacherName, seriesId, origin }) {
  const when = parseWhen(startsAt);
  if (when === null) throw new Error('startsAt invalide (attendu : ISO 8601)');
  const list = (Array.isArray(students) ? students : []).map(A.normUsername).filter(Boolean);
  const attendance = {};
  for (const u of list) attendance[u] = { status: 'expected', declaredAt: null, reason: '', requestId: null };
  return {
    id: newId(),
    courseId: String(courseId || '').slice(0, 60),
    courseLabel: String(courseLabel || '').slice(0, 120),
    startsAt: new Date(when).toISOString(),
    durationMin: Number(durationMin) > 0 ? Number(durationMin) : 60,
    students: list,
    teacherUsername: A.normUsername(teacherUsername) || '',
    teacherName: String(teacherName || '').slice(0, 120),
    attendance,
    seriesId: seriesId || null,
    origin: origin || null,
    remindedAt: null,
    createdAt: new Date().toISOString()
  };
}

async function createSession(spec) {
  return putSession(buildSession(spec));
}

// Crée toutes les occurrences d'une récurrence hebdomadaire en une passe.
// Renvoie { seriesId, created:[séances], skipped:n } — `skipped` compte les
// occurrences déjà passées (on ne planifie jamais dans le passé).
async function createWeeklySeries(spec) {
  const times = expandWeekly(spec);
  const seriesId = newSeriesId();
  const now = Date.now();
  const created = [];
  let skipped = 0;
  for (const t of times) {
    if (t <= now) { skipped++; continue; }
    const s = buildSession(Object.assign({}, spec, { startsAt: new Date(t).toISOString(), seriesId }));
    await putSession(s);
    created.push(s);
  }
  return { seriesId, created, skipped };
}

async function deleteSession(id) {
  await A.kv(['DEL', `session:${id}`]);
  await A.kv(['ZREM', Z_KEY, id]);
}

// Supprime toutes les occurrences À VENIR d'une série (les séances déjà passées
// sont conservées comme historique).
async function deleteSeriesUpcoming(seriesId) {
  if (!seriesId) return 0;
  const all = await sessionsBetween(Date.now(), Infinity);
  let n = 0;
  for (const s of all) {
    if (s.seriesId === seriesId) { await deleteSession(s.id); n++; }
  }
  return n;
}

// ── Édition d'une séance existante ──────────────────────────────────────────
// Champs modifiables : courseId, courseLabel, startsAt, durationMin, students,
// teacherUsername, teacherName. Une clé absente du patch reste inchangée — une
// édition partielle (ex: corriger l'heure) ne doit jamais effacer le reste.

// Réconcilie `attendance` avec la NOUVELLE liste d'élèves.
//
// Pourquoi : une séance dont on corrige l'heure ou le cours garde ses élèves
// pour la plupart. Si un élève a déjà signalé une absence (avec sa demande de
// rattrapage éventuelle), cette information doit SURVIVRE à l'édition — on ne
// réinitialise donc que les entrées des élèves qui ENTRENT ou SORTENT de la
// liste, jamais celles de ceux qui restent.
function reconcileAttendance(session, students) {
  const list = (Array.isArray(students) ? students : []).map(A.normUsername).filter(Boolean);
  const prev = session.attendance || {};
  const attendance = {};
  for (const u of list) {
    attendance[u] = prev[u] || { status: 'expected', declaredAt: null, reason: '', requestId: null };
  }
  session.students = list;
  session.attendance = attendance;
}

// Fixe le nouveau `startsAt` (déjà résolu en epoch ms) et réarme `remindedAt`
// si besoin.
//
// Pourquoi : `remindedAt` est un garde-fou anti-doublon posé À L'ANCIENNE HEURE.
// Si on la laisse telle quelle après un déplacement vers une heure encore à
// venir, le cron (api/reminders.js) croira le rappel déjà envoyé et ne
// préviendra jamais personne pour le nouveau créneau. On ne le réarme que si
// la nouvelle heure est future — un déplacement dans le passé (rattrapage d'une
// erreur de saisie sur une séance déjà tenue) n'a pas à redéclencher un rappel.
function applyStartsAt(session, newMs) {
  session.startsAt = new Date(newMs).toISOString();
  if (newMs > Date.now()) session.remindedAt = null;
}

// Applique les champs non liés à l'horaire — communs à updateSession et
// updateSeriesFrom, pour que les deux chemins ne puissent pas diverger.
function applyCommonFields(session, patch) {
  if (patch.courseId !== undefined) session.courseId = String(patch.courseId || '').slice(0, 60);
  if (patch.courseLabel !== undefined) session.courseLabel = String(patch.courseLabel || '').slice(0, 120);
  if (patch.durationMin !== undefined) {
    const n = Number(patch.durationMin);
    if (n > 0) session.durationMin = n;
  }
  if (patch.teacherUsername !== undefined) session.teacherUsername = A.normUsername(patch.teacherUsername) || '';
  if (patch.teacherName !== undefined) session.teacherName = String(patch.teacherName || '').slice(0, 120);
  if (patch.students !== undefined) reconcileAttendance(session, patch.students);
}

// Modifie UNE séance (portée « cette séance seulement ») et la persiste.
async function updateSession(id, patch) {
  const s = await getSession(id);
  if (!s) return null;
  applyCommonFields(s, patch);
  if (patch.startsAt !== undefined) {
    const ms = parseWhen(patch.startsAt);
    if (ms === null) throw new Error('startsAt invalide (attendu : ISO 8601)');
    applyStartsAt(s, ms);
  }
  await putSession(s);
  return s;
}

// Modifie une séance ET toutes les occurrences ULTÉRIEURES de la même série
// (startsAt ≥ celui de `sessionId`) — les occurrences plus anciennes ne sont
// jamais touchées, on ne réécrit pas l'historique d'une série.
//
// Si `patch.startsAt` est fourni, on n'en retient QUE l'heure (dans le fuseau
// de l'école) : la recopier telle quelle collapserait les 24 occurrences d'une
// récurrence sur une seule date. On extrait donc l'heure/minute voulue une
// seule fois, puis on la réapplique à la date PROPRE de chaque occurrence via
// utcToZoned / zonedToUtcMs (les mêmes fonctions qui servent à générer la série).
//
// Renvoie { updated:<nombre de séances modifiées>, session:<l'occurrence éditée> }.
async function updateSeriesFrom(sessionId, patch) {
  const origin = await getSession(sessionId);
  if (!origin) return { updated: 0, session: null };

  let timeOfDay = null;
  if (patch.startsAt !== undefined) {
    const ms = parseWhen(patch.startsAt);
    if (ms === null) throw new Error('startsAt invalide (attendu : ISO 8601)');
    const z = utcToZoned(ms, DEFAULT_TZ);
    timeOfDay = { h: z.h, mi: z.mi };
  }

  // Séance hors série : la « portée série » se réduit à une édition simple.
  if (!origin.seriesId) {
    applyCommonFields(origin, patch);
    if (timeOfDay) {
      const z = utcToZoned(Date.parse(origin.startsAt), DEFAULT_TZ);
      applyStartsAt(origin, zonedToUtcMs({ y: z.y, mo: z.mo, d: z.d, h: timeOfDay.h, mi: timeOfDay.mi }, DEFAULT_TZ));
    }
    await putSession(origin);
    return { updated: 1, session: origin };
  }

  const originMs = Date.parse(origin.startsAt);
  const candidates = await sessionsBetween(originMs, Infinity);
  let updated = 0;
  let editedSession = null;
  for (const s of candidates) {
    if (s.seriesId !== origin.seriesId) continue;
    applyCommonFields(s, patch);
    if (timeOfDay) {
      // Date CIVILE propre à CETTE occurrence, heure remplacée par la nouvelle
      // heure-du-jour voulue — jamais la date d'origine.
      const z = utcToZoned(Date.parse(s.startsAt), DEFAULT_TZ);
      applyStartsAt(s, zonedToUtcMs({ y: z.y, mo: z.mo, d: z.d, h: timeOfDay.h, mi: timeOfDay.mi }, DEFAULT_TZ));
    }
    await putSession(s);
    updated++;
    if (s.id === sessionId) editedSession = s;
  }
  return { updated, session: editedSession };
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

// Séances d'UN élève (par username) : celles à venir + celle éventuellement en cours.
// On remonte de LOOKBACK_MS pour ne pas masquer un cours déjà commencé mais
// pas terminé (sinon l'élève perdrait le bouton « Rejoindre » en plein cours).
const LOOKBACK_MS = 6 * 3600000;
async function sessionsForStudent(username, limit = 20) {
  const target = A.normUsername(username);
  if (!target) return [];
  const now = Date.now();
  const all = await sessionsBetween(now - LOOKBACK_MS, Infinity);
  return all
    .filter(s => (s.students || []).includes(target))
    .filter(s => now < Date.parse(s.startsAt) + (s.durationMin || 60) * 60000) // pas encore terminée
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, limit);
}

// Séances d'UN enseignant : à venir + celle éventuellement en cours (miroir de
// sessionsForStudent, filtré sur teacherUsername). Utilisé par l'espace enseignant.
async function sessionsForTeacher(username, limit = 20) {
  const target = A.normUsername(username);
  if (!target) return [];
  const now = Date.now();
  const all = await sessionsBetween(now - LOOKBACK_MS, Infinity);
  return all
    .filter(s => A.normUsername(s.teacherUsername) === target)
    .filter(s => now < Date.parse(s.startsAt) + (s.durationMin || 60) * 60000)
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

// ── Présence & absences ─────────────────────────────────────────────────────

// Lit (en le créant au besoin) l'état de présence d'un élève sur une séance.
// Le `??` sur `attendance` rend la lecture compatible avec les séances créées
// AVANT l'introduction du champ — aucune migration de données n'est nécessaire.
function attendanceOf(session, username) {
  const u = A.normUsername(username);
  const map = session.attendance || {};
  return map[u] || { status: 'expected', declaredAt: null, reason: '', requestId: null };
}

const isAbsent = (session, username) => attendanceOf(session, username).status === 'absent';

// Élèves encore attendus (ceux qui n'ont pas signalé d'absence) — utilisé par
// les rappels, pour ne pas écrire à un élève qui a annulé.
function expectedStudents(session) {
  return (session.students || []).filter(u => !isAbsent(session, u));
}

// Fenêtre d'annulation encore ouverte ? (> 1 h avant le début)
function canCancel(session, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Date.parse(session.startsAt) - now > CANCEL_LEAD_MS;
}

// ── Demandes de report (rattrapage) ─────────────────────────────────────────
//
// Enregistrement canonique, indépendant de la séance : c'est lui que consultent
// l'e-mail de validation et la file d'attente admin. La séance en garde une copie
// dénormalisée (attendance[username].requestId) pour l'affichage.
//
//   { requestId, sessionId, username, studentName, studentEmail,
//     courseId, courseLabel, originalStartsAt, durationMin,
//     requestedStartsAt, reason,
//     teacherUsername, teacherName,
//     state: 'pending' | 'approved' | 'refused',
//     createdAt, decidedAt, decidedBy, decidedNote, makeupSessionId }

async function getReschedule(requestId) {
  const raw = await A.kv(['GET', `resched:${String(requestId)}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function putReschedule(rq) {
  await A.kv(['SET', `resched:${rq.requestId}`, JSON.stringify(rq)]);
  await A.kv(['SADD', RQ_INDEX, rq.requestId]);
  return rq;
}

async function listReschedules() {
  const ids = (await A.kv(['SMEMBERS', RQ_INDEX])) || [];
  const out = [];
  for (const id of ids) { const r = await getReschedule(id); if (r) out.push(r); }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function deleteReschedule(requestId) {
  await A.kv(['DEL', `resched:${String(requestId)}`]);
  await A.kv(['SREM', RQ_INDEX, String(requestId)]);
}

// Valide le créneau de rattrapage proposé par l'élève.
// Renvoie { ok:true, ms } ou { ok:false, message }.
function validateMakeupSlot(iso) {
  const ms = parseWhen(iso);
  if (ms === null) return { ok: false, message: 'Créneau de rattrapage invalide.' };
  const now = Date.now();
  if (ms <= now + CANCEL_LEAD_MS) {
    return { ok: false, message: 'Le créneau de rattrapage doit être au moins 1 heure après maintenant.' };
  }
  if (ms > now + MAKEUP_MAX_AHEAD_DAYS * 86400000) {
    return { ok: false, message: `Le créneau de rattrapage doit se situer dans les ${MAKEUP_MAX_AHEAD_DAYS} prochains jours.` };
  }
  return { ok: true, ms };
}

// Enregistre l'absence d'un élève sur une séance, avec (facultatif) une demande
// de report. Ne supprime JAMAIS la séance : les autres inscrits la conservent.
//
// Renvoie { session, request } — `request` est null si aucun rattrapage demandé.
async function declareAbsence(session, { username, reason, makeupStartsAt, studentName, studentEmail }) {
  const u = A.normUsername(username);
  session.attendance = session.attendance || {};

  let request = null;
  if (makeupStartsAt) {
    request = {
      requestId: newRequestId(),
      sessionId: session.id,
      username: u,
      studentName: String(studentName || u).slice(0, 120),
      studentEmail: String(studentEmail || '').slice(0, 120),
      courseId: session.courseId,
      courseLabel: session.courseLabel || session.courseId,
      originalStartsAt: session.startsAt,
      durationMin: session.durationMin || 60,
      requestedStartsAt: new Date(parseWhen(makeupStartsAt)).toISOString(),
      reason: String(reason || '').slice(0, 400),
      teacherUsername: session.teacherUsername || '',
      teacherName: session.teacherName || '',
      state: 'pending',
      createdAt: new Date().toISOString(),
      decidedAt: null, decidedBy: '', decidedNote: '', makeupSessionId: null
    };
    await putReschedule(request);
  }

  session.attendance[u] = {
    status: 'absent',
    declaredAt: new Date().toISOString(),
    reason: String(reason || '').slice(0, 400),
    requestId: request ? request.requestId : null
  };
  await putSession(session);
  return { session, request };
}

// Applique la décision du prof / de l'admin sur une demande de report.
// `decision` ∈ { 'approve', 'refuse' }. Idempotent : une demande déjà tranchée
// est renvoyée telle quelle avec `alreadyDecided:true` (un prof qui reclique sur
// le lien de son e-mail ne doit pas créer une seconde séance de rattrapage).
async function decideReschedule(requestId, decision, by, note) {
  const rq = await getReschedule(requestId);
  if (!rq) return { ok: false, error: 'not_found' };
  if (rq.state !== 'pending') return { ok: true, alreadyDecided: true, request: rq };

  if (decision === 'approve') {
    const makeup = buildSession({
      courseId: rq.courseId,
      courseLabel: rq.courseLabel,
      startsAt: rq.requestedStartsAt,
      durationMin: rq.durationMin,
      students: [rq.username],
      teacherUsername: rq.teacherUsername,
      teacherName: rq.teacherName,
      origin: { type: 'makeup', fromSessionId: rq.sessionId, requestId: rq.requestId }
    });
    await putSession(makeup);
    rq.makeupSessionId = makeup.id;
    rq.state = 'approved';
  } else {
    rq.state = 'refused';
  }
  rq.decidedAt = new Date().toISOString();
  rq.decidedBy = String(by || '').slice(0, 60);
  rq.decidedNote = String(note || '').slice(0, 400);
  await putReschedule(rq);

  return { ok: true, request: rq };
}

module.exports = {
  // séances
  createSession, buildSession, createWeeklySeries, getSession, putSession, deleteSession, deleteSeriesUpcoming,
  updateSession, updateSeriesFrom,
  sessionsBetween, sessionsForStudent, sessionsForTeacher, upcomingSessions, purgeOlderThan, parseWhen,
  // fuseaux & récurrence
  tzOffsetMs, zonedToUtcMs, utcToZoned, expandWeekly, DEFAULT_TZ,
  // présence
  attendanceOf, isAbsent, expectedStudents, canCancel, CANCEL_LEAD_MS, MAKEUP_MAX_AHEAD_DAYS,
  // reports
  declareAbsence, decideReschedule, getReschedule, putReschedule, listReschedules, deleteReschedule,
  validateMakeupSlot
};
