// Bibliothèque PARTAGÉE (préfixe `_` → non routée par Vercel, comme api/zoom/_lib.js).
// Logique d'authentification KodingvillageSchool, utilisée par :
//   - api/auth.js   (connexion + vérification de jeton)
//   - api/admin.js  (création / envoi des comptes élèves — Phase 2)
//
// Stockage : Vercel KV (Upstash Redis) via API REST — aucune dépendance npm.
// Aucun secret n'est jamais renvoyé au navigateur : mots de passe hachés, jetons signés.
//
// Variables d'environnement :
//   SESSION_SECRET                        secret de signature des jetons (obligatoire)
//   ADMIN_EMAIL                           e-mail admin (obligatoire pour le login admin)
//   ADMIN_PASSWORD_HASH                   mot de passe admin haché "salt:hash" (recommandé), OU
//   ADMIN_PASSWORD                        mot de passe admin EN CLAIR (repli plus simple)
//   KV_REST_API_URL / KV_REST_API_TOKEN   (ou UPSTASH_REDIS_REST_*) — déjà présents (parrainage)

const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ADMIN_EMAIL_RAW = process.env.ADMIN_EMAIL || '';
// Deux façons de fournir le mot de passe admin (au choix) :
//   - ADMIN_PASSWORD_HASH : hash PBKDF2 au format "salt:hash" (recommandé en prod).
//   - ADMIN_PASSWORD      : mot de passe EN CLAIR (repli simple, plus facile à configurer).
// On nettoie les artefacts de copier-coller (espaces / retours à la ligne parasites de Vercel).
const ADMIN_PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').replace(/[\r\n]+$/, '');

const nowSec = () => Math.floor(Date.now() / 1000);
const normEmail = (e) => String(e == null ? '' : e).trim().toLowerCase().slice(0, 120);
const ADMIN_EMAIL = normEmail(ADMIN_EMAIL_RAW);

const kvConfigured = () => !!(KV_URL && KV_TOKEN);
const configured = () => !!SESSION_SECRET; // minimum pour signer un jeton (login admin possible sans KV)

// ---- Vercel KV (Upstash REST) : commande sous forme de tableau ['SET', key, val] ----
async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const d = await r.json();
  if (!r.ok || (d && d.error)) throw new Error((d && d.error) || 'KV error');
  return d.result;
}

// ---- Mots de passe : PBKDF2-SHA256, format "salt:hash" (hex) ----
const PBKDF2 = { iter: 120000, len: 32, digest: 'sha256' };
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, PBKDF2.iter, PBKDF2.len, PBKDF2.digest).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || String(stored).indexOf(':') < 0) return false;
  const [salt, hash] = String(stored).split(':');
  const test = crypto.pbkdf2Sync(String(password), salt, PBKDF2.iter, PBKDF2.len, PBKDF2.digest).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Jetons de session : HMAC-SHA256 signés, sans état (payload.signature) ----
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const _sign = (data) => b64url(crypto.createHmac('sha256', SESSION_SECRET).update(data).digest());

function signToken(payload, ttlSeconds) {
  const body = Object.assign({}, payload, { exp: nowSec() + (ttlSeconds || 7 * 24 * 3600) });
  const p = b64url(JSON.stringify(body));
  return `${p}.${_sign(p)}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [p, sig] = token.split('.');
  const expected = _sign(p);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(unb64url(p).toString('utf8')); } catch (_) { return null; }
  if (!body || typeof body.exp !== 'number' || body.exp < nowSec()) return null;
  return body; // { email, role, exp }
}

// ---- Comptes élèves en KV ----
async function getUser(email) {
  const raw = await kv(['GET', `user:${normEmail(email)}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
async function putUser(user) {
  const email = normEmail(user.email);
  await kv(['SET', `user:${email}`, JSON.stringify(user)]);
  await kv(['SADD', 'users:index', email]);
}
async function listUsers() {
  const emails = (await kv(['SMEMBERS', 'users:index'])) || [];
  const out = [];
  for (const e of emails) { const u = await getUser(e); if (u) out.push(u); }
  return out;
}
async function deleteUser(email) {
  email = normEmail(email);
  await kv(['DEL', `user:${email}`]);
  await kv(['SREM', 'users:index', email]);
}

// ---- Prospects d'essai (leads) en KV ----
// Un lead = une réservation d'essai reçue via api/booking. Il est STOCKÉ ici pour
// que l'admin puisse le voir et, quand il le décide, générer + envoyer les
// identifiants (conversion en compte élève). Aucun envoi automatique.
// Schéma : `lead:<id>` → JSON ; `leads:index` → SET des ids.
function genLeadId() {
  return `${nowSec()}-${crypto.randomBytes(4).toString('hex')}`;
}
async function putLead(lead) {
  const id = String(lead.id || genLeadId());
  const rec = Object.assign({}, lead, { id });
  await kv(['SET', `lead:${id}`, JSON.stringify(rec)]);
  await kv(['SADD', 'leads:index', id]);
  return rec;
}
async function getLead(id) {
  const raw = await kv(['GET', `lead:${String(id)}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
async function listLeads() {
  const ids = (await kv(['SMEMBERS', 'leads:index'])) || [];
  const out = [];
  for (const id of ids) { const l = await getLead(id); if (l) out.push(l); }
  return out;
}
async function deleteLead(id) {
  id = String(id);
  await kv(['DEL', `lead:${id}`]);
  await kv(['SREM', 'leads:index', id]);
}

// ---- Admin (identifiants via env, jamais en KV) ----

// Comparaison de chaînes à temps constant (mot de passe en clair).
function timingEqStr(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const hasAdminHash = () => !!ADMIN_PASSWORD_HASH && ADMIN_PASSWORD_HASH.indexOf(':') > 0;
const hasAdminPlain = () => !!ADMIN_PASSWORD;

// Vérifie le mot de passe admin : hash PBKDF2 en priorité, sinon mot de passe en clair.
// Renvoie { ok, method } — `method` sert au diagnostic (jamais renvoyé au navigateur).
function checkAdminPassword(password) {
  if (hasAdminHash()) return { ok: verifyPassword(password, ADMIN_PASSWORD_HASH), method: 'hash' };
  if (hasAdminPlain()) return { ok: timingEqStr(password, ADMIN_PASSWORD), method: 'plain' };
  return { ok: false, method: 'none' };
}

// Diagnostic complet de la tentative de connexion admin, avec une RAISON explicite
// (utilisée pour les logs serveur uniquement — aucune valeur secrète n'y figure).
function adminAuthDiagnose(email, password) {
  if (!ADMIN_EMAIL) return { ok: false, reason: 'ADMIN_EMAIL_absent' };
  if (normEmail(email) !== ADMIN_EMAIL) return { ok: false, reason: 'email_ne_correspond_pas' };
  const pw = checkAdminPassword(password);
  if (pw.method === 'none') return { ok: false, reason: 'aucun_mot_de_passe_configure' };
  if (pw.method === 'hash' && !ADMIN_PASSWORD_HASH.split(':')[1]) {
    return { ok: false, reason: 'ADMIN_PASSWORD_HASH_format_invalide (attendu "salt:hash")' };
  }
  if (!pw.ok) return { ok: false, reason: `mot_de_passe_incorrect (methode=${pw.method})` };
  return { ok: true, method: pw.method };
}

const isAdminCredentials = (email, password) => adminAuthDiagnose(email, password).ok;

// État de configuration (booléens uniquement, JAMAIS de secret) — pour l'endpoint de diagnostic.
function envDiag() {
  return {
    sessionSecret: !!SESSION_SECRET,
    adminEmail: !!ADMIN_EMAIL,
    adminPasswordHash: hasAdminHash(),
    adminPasswordHashFormatOk: hasAdminHash() && !!ADMIN_PASSWORD_HASH.split(':')[1],
    adminPasswordPlain: hasAdminPlain(),
    kv: kvConfigured()
  };
}

module.exports = {
  kv, kvConfigured, configured,
  hashPassword, verifyPassword, signToken, verifyToken,
  getUser, putUser, listUsers, deleteUser,
  putLead, getLead, listLeads, deleteLead,
  normEmail, nowSec, ADMIN_EMAIL, isAdminCredentials, adminAuthDiagnose, envDiag
};
