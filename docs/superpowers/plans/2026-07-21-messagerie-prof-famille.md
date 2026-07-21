# Messagerie enseignant ↔ famille — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner aux familles et aux enseignants un fil de discussion dans le produit, supervisé par l'école, avec alerte e-mail groupée et accusé de lecture.

**Architecture :** Trois unités serverless — `api/_messages.js` (modèle KV et règles), `api/messages.js` (point d'entrée HTTP, authentification, routage), `api/_notify.js` (e-mail d'alerte, étendu). Le front ajoute un module `KVS_Messages` partagé par l'écran enseignant et l'écran élève, plus une vue admin en lecture seule. Aucun temps réel : sondage 120 s greffé sur celui des séances.

**Tech Stack :** Node 18+ (fonctions serverless Vercel), Upstash Redis via API REST, Resend pour l'e-mail, SPA statique en JavaScript sans framework, tests avec `node:test` intégré.

**Spec de référence :** `docs/superpowers/specs/2026-07-21-messagerie-prof-famille-design.md`

## Global Constraints

- **Aucune dépendance npm.** Pas de `package.json` de production, pas de lockfile, pas d'étape de build. Uniquement les modules intégrés (`crypto`, `node:test`, `node:assert`) et le `fetch` global.
- **L'identité vient toujours du jeton signé** (`payload.sub`, `payload.role`), jamais du corps de la requête.
- **Corps de message : 2000 caractères maximum.** Extrait stocké : 140 caractères.
- **Garde-fou de fréquence : 20 messages par 5 minutes** (300 s) et par auteur.
- **Pagination : 50 fils, 50 messages** par page.
- **L'admin est en lecture seule** : il ne peut ni écrire ni marquer un fil comme lu.
- **Le message est persisté avant toute tentative d'e-mail.** Un échec Resend ne fait jamais échouer la requête.
- **Séparateur d'identifiant de fil : `|`** — interdit par `normUsername` (`api/_auth.js:102`), donc non ambigu.
- **Langue de toute chaîne visible : français.**
- Pièces jointes **hors périmètre** (v1.1).

---

### Task 1: Harnais de test rejouable

Le dépôt n'a aujourd'hui aucun test. Cette tâche crée le socle dont dépendent toutes les suivantes : un Redis en mémoire et une interception de Resend, montés sur `node:test`.

**Files:**
- Create: `test/helpers/kv-mock.js`
- Create: `test/helpers/harness.js`
- Create: `test/harness.test.js`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `installHarness()` → `{ mails, reset, kv }` — pose les variables d'environnement, remplace `global.fetch`, renvoie le tableau des e-mails capturés.
  - `kvExec(store, cmd)` → résultat Redis pour un tableau de commande.
  - `createStore()` → `{ strings, sets, zsets, expiries }`.

- [ ] **Step 1: Écrire le Redis en mémoire**

Create `test/helpers/kv-mock.js`:

```js
// Sous-ensemble Redis réellement utilisé par le projet, en mémoire.
// Aucune dépendance : le vrai KV est appelé en REST, on intercepte donc au niveau
// de fetch plutôt que de simuler un client.

function createStore() {
  return { strings: new Map(), sets: new Map(), zsets: new Map(), expiries: new Map() };
}

// Applique l'expiration paresseusement : une clé expirée se comporte comme absente.
function alive(store, key) {
  const exp = store.expiries.get(key);
  if (exp !== undefined && exp <= Date.now()) {
    store.strings.delete(key); store.sets.delete(key); store.zsets.delete(key);
    store.expiries.delete(key);
    return false;
  }
  return true;
}

function kvExec(store, cmd) {
  const [rawOp, key, ...rest] = cmd;
  const op = String(rawOp).toUpperCase();
  if (key !== undefined) alive(store, key);

  switch (op) {
    case 'GET': return store.strings.has(key) ? store.strings.get(key) : null;
    case 'SET': store.strings.set(key, rest[0]); return 'OK';
    case 'DEL': {
      const had = store.strings.delete(key) || store.sets.delete(key) || store.zsets.delete(key);
      store.expiries.delete(key);
      return had ? 1 : 0;
    }
    case 'INCR': {
      const n = Number(store.strings.get(key) || 0) + 1;
      store.strings.set(key, String(n));
      return n;
    }
    case 'EXPIRE': store.expiries.set(key, Date.now() + Number(rest[0]) * 1000); return 1;
    case 'SADD': {
      const s = store.sets.get(key) || new Set();
      s.add(rest[0]); store.sets.set(key, s); return 1;
    }
    case 'SREM': { const s = store.sets.get(key); if (s) s.delete(rest[0]); return 1; }
    case 'SMEMBERS': return [...(store.sets.get(key) || [])];
    case 'ZADD': {
      const z = store.zsets.get(key) || new Map();
      z.set(rest[1], Number(rest[0])); store.zsets.set(key, z); return 1;
    }
    case 'ZREM': { const z = store.zsets.get(key); if (z) z.delete(rest[0]); return 1; }
    case 'ZCARD': return (store.zsets.get(key) || new Map()).size;
    case 'ZRANGEBYSCORE': {
      const z = store.zsets.get(key) || new Map();
      const lo = rest[0] === '-inf' ? -Infinity : Number(rest[0]);
      const hi = rest[1] === '+inf' ? Infinity : Number(rest[1]);
      let out = [...z.entries()].filter(([, sc]) => sc >= lo && sc <= hi)
        .sort((a, b) => a[1] - b[1]).map(([m]) => m);
      const li = rest.findIndex(r => String(r).toUpperCase() === 'LIMIT');
      if (li >= 0) {
        const off = Number(rest[li + 1]) || 0;
        out = out.slice(off, off + (Number(rest[li + 2]) || out.length));
      }
      return out;
    }
    case 'ZREVRANGE': {
      const z = store.zsets.get(key) || new Map();
      const all = [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
      const start = Number(rest[0]) || 0;
      const stop = Number(rest[1]);
      return all.slice(start, stop === -1 ? undefined : stop + 1);
    }
    default: throw new Error('commande KV non simulée : ' + op);
  }
}

module.exports = { createStore, kvExec };
```

- [ ] **Step 2: Écrire le harnais (env + interception fetch)**

Create `test/helpers/harness.js`:

```js
// Pose l'environnement attendu par api/_auth.js, puis remplace global.fetch pour
// router les appels KV vers le Redis en mémoire et capturer les e-mails Resend.
//
// À appeler AVANT tout require('../../api/...') : _auth.js lit les variables
// d'environnement au chargement du module.

const { createStore, kvExec } = require('./kv-mock');

const KV_URL = 'http://kv.test/mock';

function installHarness() {
  process.env.SESSION_SECRET = 'secret-de-test';
  process.env.ADMIN_EMAIL = 'admin@kvs.test';
  process.env.ADMIN_PASSWORD = 'mot-de-passe-admin';
  process.env.KV_REST_API_URL = KV_URL;
  process.env.KV_REST_API_TOKEN = 'jeton-kv';
  process.env.RESEND_API_KEY = 'resend-de-test';
  process.env.BOOKING_FROM_EMAIL = 'info@kodingvillageschool.com';
  process.env.PUBLIC_URL = 'http://localhost:3000';

  const store = createStore();
  const mails = [];

  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(KV_URL)) {
      try { return { ok: true, json: async () => ({ result: kvExec(store, JSON.parse(opts.body)) }) }; }
      catch (e) { return { ok: false, json: async () => ({ error: e.message }) }; }
    }
    if (u.startsWith('https://api.resend.com/emails')) {
      const payload = JSON.parse(opts.body);
      mails.push(payload);
      return { ok: true, json: async () => ({ id: 'mock_' + mails.length }) };
    }
    throw new Error('appel réseau inattendu : ' + u);
  };

  const reset = () => {
    store.strings.clear(); store.sets.clear(); store.zsets.clear(); store.expiries.clear();
    mails.length = 0;
  };

  return { store, mails, reset, kv: (cmd) => kvExec(store, cmd) };
}

module.exports = { installHarness };
```

- [ ] **Step 3: Écrire le test de bon fonctionnement du harnais**

Create `test/harness.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');

test('le harnais rend le KV opérationnel', async () => {
  H.reset();
  assert.equal(A.kvConfigured(), true);
  await A.kv(['SET', 'essai', 'valeur']);
  assert.equal(await A.kv(['GET', 'essai']), 'valeur');
});

test('le ZSET trie par score croissant et décroissant', async () => {
  H.reset();
  await A.kv(['ZADD', 'z', '20', 'b']);
  await A.kv(['ZADD', 'z', '10', 'a']);
  assert.deepEqual(await A.kv(['ZRANGEBYSCORE', 'z', '-inf', '+inf']), ['a', 'b']);
  assert.deepEqual(await A.kv(['ZREVRANGE', 'z', '0', '-1']), ['b', 'a']);
});

test('EXPIRE rend la clé absente une fois le délai écoulé', async () => {
  H.reset();
  await A.kv(['SET', 'court', '1']);
  await A.kv(['EXPIRE', 'court', '-1']);
  assert.equal(await A.kv(['GET', 'court']), null);
});

test('les e-mails sont capturés et non envoyés', async () => {
  H.reset();
  const M = require('../api/_mail');
  await M.send({ from: 'a@b.c', to: ['d@e.f'], subject: 'Essai', html: '<p>bonjour</p>' });
  assert.equal(H.mails.length, 1);
  assert.equal(H.mails[0].subject, 'Essai');
});
```

- [ ] **Step 4: Lancer les tests**

Run: `node --test test/`
Expected: `# pass 4` et `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "test: harnais rejouable (KV en memoire + Resend intercepte)"
```

---

### Task 2: Modèle des fils et des messages

**Files:**
- Create: `api/_messages.js`
- Create: `test/messages-model.test.js`

**Interfaces:**
- Consumes: `A.kv`, `A.normUsername`, `A.getUser`, `A.getTeacher` (`api/_auth.js`).
- Produces:
  - `threadId(teacherUsername, studentUsername)` → `string`
  - `parseThreadId(tid)` → `{ teacherUsername, studentUsername } | null`
  - `getThread(tid)` → `Promise<thread|null>`
  - `putThread(thread)` → `Promise<thread>`
  - `ensureThread({ teacherUsername, studentUsername })` → `Promise<thread>`
  - `appendMessage(thread, { fromRole, fromUsername, fromName, body })` → `Promise<{ thread, message }>`
  - `getMessages(tid, { limit, before })` → `Promise<message[]>` (ordre chronologique croissant).
    `before` est un **identifiant de message** (pas un horodatage) : on renvoie les `limit`
    messages qui le précèdent.
  - `listThreads(role, username, limit)` → `Promise<thread[]>` (plus récent d'abord ; `role === 'admin'` → tous)
  - `MAX_BODY`, `SNIPPET_LEN`

- [ ] **Step 1: Écrire les tests en échec**

Create `test/messages-model.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');
const M = require('../api/_messages');

async function comptes() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'parent@kvs.test' });
  await A.putUser({ username: 'bilal', firstName: 'Bilal', lastName: 'Keita', email: 'parent@kvs.test' });
}

test('l identifiant de fil est deterministe et non ambigu', () => {
  assert.equal(M.threadId('blaise', 'mohamedjr'), 'th_blaise|mohamedjr');
  assert.equal(M.threadId('BLAISE', 'MohamedJR'), 'th_blaise|mohamedjr');
  assert.deepEqual(M.parseThreadId('th_blaise|mohamedjr'),
    { teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  assert.equal(M.parseThreadId('nimportequoi'), null);
});

test('ensureThread cree une fois et renvoie le meme fil ensuite', async () => {
  H.reset(); await comptes();
  const t1 = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  const t2 = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  assert.equal(t1.id, t2.id);
  assert.equal(t1.createdAt, t2.createdAt);
  assert.equal(t1.teacherName, 'Blaise Mentor');
  assert.equal(t1.studentName, 'Mohamed Junior');
  assert.deepEqual(t1.unread, { teacher: 0, student: 0 });
});

test('appendMessage incremente les non-lus du destinataire seulement', async () => {
  H.reset(); await comptes();
  let th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  const r = await M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'Blaise Mentor', body: 'Bonjour !'
  });
  assert.equal(r.message.body, 'Bonjour !');
  assert.equal(r.thread.unread.student, 1);
  assert.equal(r.thread.unread.teacher, 0);
  assert.equal(r.thread.lastFrom, 'teacher');
  assert.equal(r.thread.lastSnippet, 'Bonjour !');
});

test('le corps est refuse au-dela de la limite', async () => {
  H.reset(); await comptes();
  const th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  await assert.rejects(() => M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: 'x'.repeat(M.MAX_BODY + 1)
  }), /trop long/);
  await assert.rejects(() => M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: '   '
  }), /vide/);
});

test('getMessages rend l ordre chronologique et pagine', async () => {
  H.reset(); await comptes();
  let th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  for (const mot of ['un', 'deux', 'trois']) {
    th = (await M.appendMessage(th, { fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: mot })).thread;
  }
  const tous = await M.getMessages(th.id, { limit: 50 });
  assert.deepEqual(tous.map(m => m.body), ['un', 'deux', 'trois']);
  const derniers = await M.getMessages(th.id, { limit: 2 });
  assert.deepEqual(derniers.map(m => m.body), ['deux', 'trois']);

  // Traversee de frontiere : la page suivante reprend juste avant le curseur,
  // sans sauter ni repeter de message.
  const precedents = await M.getMessages(th.id, { limit: 2, before: derniers[0].id });
  assert.deepEqual(precedents.map(m => m.body), ['un']);
});

test('le curseur ne saute aucun message a horodatage identique', async () => {
  H.reset(); await comptes();
  let th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  // Trois messages ecrits d affilee : leurs scores peuvent coincider a la ms.
  for (const mot of ['a', 'b', 'c']) {
    th = (await M.appendMessage(th, { fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: mot })).thread;
  }
  const tous = await M.getMessages(th.id, { limit: 50 });
  const page2 = await M.getMessages(th.id, { limit: 50, before: tous[2].id });
  assert.deepEqual(page2.map(m => m.body), ['a', 'b'],
    'paginer depuis le dernier message doit rendre TOUS les precedents');
});

test('listThreads cloisonne par role et par identifiant', async () => {
  H.reset(); await comptes();
  const a = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  const b = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'bilal' });
  await M.appendMessage(a, { fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: 'a' });
  await M.appendMessage(b, { fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: 'b' });

  const cotePro = await M.listThreads('teacher', 'blaise', 50);
  assert.equal(cotePro.length, 2);
  const coteMj = await M.listThreads('student', 'mohamedjr', 50);
  assert.deepEqual(coteMj.map(t => t.id), [a.id]);
  const coteAdmin = await M.listThreads('admin', '', 50);
  assert.equal(coteAdmin.length, 2);
  // Le plus recemment actif en tete
  assert.equal(coteAdmin[0].id, b.id);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `node --test test/messages-model.test.js`
Expected: FAIL — `Cannot find module '../api/_messages'`.

- [ ] **Step 3: Écrire le modèle**

Create `api/_messages.js`:

```js
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

module.exports = {
  threadId, parseThreadId, getThread, putThread, ensureThread,
  appendMessage, getMessages, listThreads,
  otherSide, MAX_BODY, SNIPPET_LEN, SIDES
};
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

Run: `node --test test/messages-model.test.js`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add api/_messages.js test/messages-model.test.js
git commit -m "feat(messages): modele des fils et des messages en KV"
```

---

### Task 3: Non-lus, accusé de lecture et groupement des alertes

**Files:**
- Modify: `api/_messages.js` (ajout en fin de fichier, avant `module.exports`)
- Create: `test/messages-read.test.js`

**Interfaces:**
- Consumes: `getThread`, `putThread`, `appendMessage`, `ensureThread` (Task 2).
- Produces:
  - `markRead(thread, side)` → `Promise<thread>` — met `unread[side] = 0` et `lastReadAt[side] = maintenant`
  - `shouldAlert(thread, side)` → `boolean` — fonction **pure**, aucune écriture
  - `noteAlerted(thread, side)` → `Promise<thread>` — horodate l'alerte envoyée

- [ ] **Step 1: Écrire les tests en échec**

Create `test/messages-read.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');
const M = require('../api/_messages');

async function filPret() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'parent@kvs.test' });
  return M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
}
const ecrire = (th, body) => M.appendMessage(th, {
  fromRole: 'teacher', fromUsername: 'blaise', fromName: 'Blaise Mentor', body
});

test('markRead remet les non-lus a zero pour ce cote seulement', async () => {
  H.reset();
  let th = await filPret();
  th = (await ecrire(th, 'un')).thread;
  th = (await ecrire(th, 'deux')).thread;
  assert.equal(th.unread.student, 2);
  th = await M.markRead(th, 'student');
  assert.equal(th.unread.student, 0);
  assert.equal(th.unread.teacher, 0);
  assert.ok(th.lastReadAt.student);
  assert.equal(th.lastReadAt.teacher, null);
});

test('la premiere alerte part, la seconde est retenue', async () => {
  H.reset();
  let th = await filPret();
  th = (await ecrire(th, 'un')).thread;
  assert.equal(M.shouldAlert(th, 'student'), true);
  th = await M.noteAlerted(th, 'student');
  th = (await ecrire(th, 'deux')).thread;
  assert.equal(M.shouldAlert(th, 'student'), false,
    'un deuxieme message ne doit pas declencher un deuxieme e-mail');
});

test('la lecture rearme l alerte', async () => {
  H.reset();
  let th = await filPret();
  th = (await ecrire(th, 'un')).thread;
  th = await M.noteAlerted(th, 'student');
  await new Promise(r => setTimeout(r, 5));
  th = await M.markRead(th, 'student');
  th = (await ecrire(th, 'deux')).thread;
  assert.equal(M.shouldAlert(th, 'student'), true,
    'apres lecture, le message suivant doit re-alerter');
});

test('shouldAlert n ecrit rien', async () => {
  H.reset();
  let th = await filPret();
  th = (await ecrire(th, 'un')).thread;
  const avant = JSON.stringify(await M.getThread(th.id));
  M.shouldAlert(th, 'student');
  assert.equal(JSON.stringify(await M.getThread(th.id)), avant);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `node --test test/messages-read.test.js`
Expected: FAIL — `M.markRead is not a function`.

- [ ] **Step 3: Implémenter**

Dans `api/_messages.js`, insérer avant `module.exports` :

```js
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
```

Et compléter l'export :

```js
module.exports = {
  threadId, parseThreadId, getThread, putThread, ensureThread,
  appendMessage, getMessages, listThreads,
  markRead, shouldAlert, noteAlerted,
  otherSide, MAX_BODY, SNIPPET_LEN, SIDES
};
```

- [ ] **Step 4: Lancer les tests**

Run: `node --test test/messages-read.test.js`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add api/_messages.js test/messages-read.test.js
git commit -m "feat(messages): non-lus, accuse de lecture, groupement des alertes"
```

---

### Task 4: Droits déduits des séances, contacts, garde-fou de fréquence

**Files:**
- Modify: `api/_messages.js`
- Create: `test/messages-acl.test.js`

**Interfaces:**
- Consumes: `S.sessionsBetween` (`api/_schedule.js`), `A.getUser`, `A.getTeacher`.
- Produces:
  - `sharesSession(teacherUsername, studentUsername)` → `Promise<boolean>`
  - `canOpen(teacherUsername, studentUsername)` → `Promise<boolean>` — vrai si le fil existe déjà **ou** si une séance est partagée
  - `contactsFor(role, username)` → `Promise<[{ username, name }]>`
  - `rateLimited(username)` → `Promise<boolean>` — incrémente et dit si la limite est franchie
  - `RATE_MAX`, `RATE_WINDOW_S`

- [ ] **Step 1: Écrire les tests en échec**

Create `test/messages-acl.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');
const S = require('../api/_schedule');
const M = require('../api/_messages');

async function ecole() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putTeacher({ username: 'awa', firstName: 'Awa', lastName: 'Diop', email: 'awa@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'p@kvs.test' });
  await A.putUser({ username: 'bilal', firstName: 'Bilal', lastName: 'Keita', email: 'p@kvs.test' });
  await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 90,
    startsAt: new Date(Date.now() + 864e5).toISOString(),
    students: ['mohamedjr'], teacherUsername: 'blaise', teacherName: 'Blaise Mentor'
  });
}

test('une seance commune ouvre le droit, son absence le refuse', async () => {
  H.reset(); await ecole();
  assert.equal(await M.sharesSession('blaise', 'mohamedjr'), true);
  assert.equal(await M.sharesSession('blaise', 'bilal'), false);
  assert.equal(await M.sharesSession('awa', 'mohamedjr'), false);
});

test('un fil deja ouvert le reste meme sans seance', async () => {
  H.reset(); await ecole();
  assert.equal(await M.canOpen('awa', 'bilal'), false);
  await M.ensureThread({ teacherUsername: 'awa', studentUsername: 'bilal' });
  assert.equal(await M.canOpen('awa', 'bilal'), true,
    'le canal ne doit pas se fermer pendant les vacances');
});

test('contactsFor liste les interlocuteurs autorises avec leur nom', async () => {
  H.reset(); await ecole();
  const cotePro = await M.contactsFor('teacher', 'blaise');
  assert.deepEqual(cotePro, [{ username: 'mohamedjr', name: 'Mohamed Junior' }]);
  const coteEleve = await M.contactsFor('student', 'mohamedjr');
  assert.deepEqual(coteEleve, [{ username: 'blaise', name: 'Blaise Mentor' }]);
  assert.deepEqual(await M.contactsFor('student', 'bilal'), []);
});

test('le garde-fou bloque au-dela de la limite puis se relache', async () => {
  H.reset();
  for (let i = 0; i < M.RATE_MAX; i++) {
    assert.equal(await M.rateLimited('bavard'), false, `message ${i + 1} doit passer`);
  }
  assert.equal(await M.rateLimited('bavard'), true, 'le 21e doit etre bloque');
  assert.equal(await M.rateLimited('quelqu-un-dautre'), false, 'la limite est par auteur');
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `node --test test/messages-acl.test.js`
Expected: FAIL — `M.sharesSession is not a function`.

- [ ] **Step 3: Implémenter**

En tête de `api/_messages.js`, ajouter l'import :

```js
const S = require('./_schedule');
```

Puis insérer avant `module.exports` :

```js
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
  const n = await A.kv(['INCR', key]);
  if (Number(n) === 1) await A.kv(['EXPIRE', key, String(RATE_WINDOW_S)]);
  return Number(n) > RATE_MAX;
}
```

Compléter l'export :

```js
module.exports = {
  threadId, parseThreadId, getThread, putThread, ensureThread,
  appendMessage, getMessages, listThreads,
  markRead, shouldAlert, noteAlerted,
  sharesSession, canOpen, contactsFor, rateLimited,
  otherSide, MAX_BODY, SNIPPET_LEN, SIDES, RATE_MAX, RATE_WINDOW_S
};
```

- [ ] **Step 4: Lancer les tests**

Run: `node --test test/messages-acl.test.js`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add api/_messages.js test/messages-acl.test.js
git commit -m "feat(messages): droits deduits des seances, contacts, garde-fou de frequence"
```

---

### Task 5: E-mail d'alerte nommant l'enfant

**Files:**
- Modify: `api/_notify.js` (ajouter la fonction et l'export)
- Create: `test/messages-mail.test.js`

**Interfaces:**
- Consumes: `A.getUser`, `A.getTeacher`, `B.esc`, `B.emailFooter`, `M.sendSafe` (`api/_mail.js`).
- Produces: `notifyNewMessage(thread, message, side)` → `Promise<{ sent:boolean }>`
  où `side` est le **destinataire** (`'teacher'` ou `'student'`).

- [ ] **Step 1: Écrire les tests en échec**

Create `test/messages-mail.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');
const M = require('../api/_messages');
const N = require('../api/_notify');

async function fil() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'parent@kvs.test' });
  return M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
}

test('l alerte famille nomme l enfant concerne', async () => {
  H.reset();
  let th = await fil();
  const r = await M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'Blaise Mentor', body: 'Bonjour !'
  });
  const res = await N.notifyNewMessage(r.thread, r.message, 'student');
  assert.equal(res.sent, true);
  assert.equal(H.mails.length, 1);
  const mail = H.mails[0];
  assert.deepEqual(mail.to, ['parent@kvs.test']);
  assert.match(mail.subject, /Mohamed Junior/,
    'un parent de deux eleves doit savoir lequel est concerne');
  assert.match(mail.subject, /Blaise Mentor/);
});

test('l alerte enseignant part sur son adresse', async () => {
  H.reset();
  let th = await fil();
  const r = await M.appendMessage(th, {
    fromRole: 'student', fromUsername: 'mohamedjr', fromName: 'Mohamed Junior', body: 'Une question'
  });
  await N.notifyNewMessage(r.thread, r.message, 'teacher');
  assert.deepEqual(H.mails[0].to, ['blaise@kvs.test']);
});

test('l e-mail ne recopie pas le message en entier', async () => {
  H.reset();
  let th = await fil();
  const secret = 'information-confidentielle-de-la-famille';
  const r = await M.appendMessage(th, {
    fromRole: 'student', fromUsername: 'mohamedjr', fromName: 'Mohamed Junior', body: secret
  });
  await N.notifyNewMessage(r.thread, r.message, 'teacher');
  assert.equal(H.mails[0].html.includes(secret), false,
    'le contenu reste dans le produit ; l e-mail ne fait qu inviter a s y connecter');
});

test('un destinataire sans e-mail valide ne fait pas echouer', async () => {
  H.reset();
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'sansmail', firstName: 'Sans', lastName: 'Mail', email: '' });
  const th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'sansmail' });
  const r = await M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'Blaise Mentor', body: 'Coucou'
  });
  const res = await N.notifyNewMessage(r.thread, r.message, 'student');
  assert.equal(res.sent, false);
  assert.equal(H.mails.length, 0);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `node --test test/messages-mail.test.js`
Expected: FAIL — `N.notifyNewMessage is not a function`.

- [ ] **Step 3: Implémenter**

⚠️ **Attention à la convention de nommage locale.** Dans `api/_notify.js`, `M` désigne
`require('./_mail')` — et **non** `_messages`, contrairement au reste de ce plan. Le code
ci-dessous respecte la convention déjà en place dans ce fichier : `M.configured()` et
`M.sendSafe()` sont les fonctions d'envoi d'e-mail. Ne pas y ajouter d'import de
`_messages` : cette fonction reçoit le fil et le message en paramètres, elle n'a aucune
raison de lire le modèle.

Dans `api/_notify.js`, insérer avant `module.exports` :

```js
// ── 3) Alerte « nouveau message » ───────────────────────────────────────────
//
// L'e-mail NE RECOPIE PAS le message : il invite à ouvrir l'espace. Le contenu
// d'un échange sur un enfant n'a pas à traîner dans des boîtes mail, et c'est
// aussi ce qui rend l'accusé de lecture honnête (lire l'e-mail ≠ lire le fil).
//
// `side` est le DESTINATAIRE ('teacher' ou 'student').
async function notifyNewMessage(thread, message, side) {
  if (!M.configured()) {
    console.warn('[notify] RESEND_API_KEY absente — aucune alerte de message envoyée');
    return { sent: false };
  }
  const versFamille = side === 'student';
  const compte = versFamille
    ? await A.getUser(thread.studentUsername)
    : await A.getTeacher(thread.teacherUsername);
  const dest = compte && compte.email;
  if (!dest || dest.indexOf('@') < 0) {
    console.warn(`[notify] destinataire sans e-mail valide pour le fil ${thread.id}`);
    return { sent: false };
  }

  // L'e-mail de contact est partageable par une fratrie : sans le prénom de
  // l'enfant dans l'objet, un parent de deux élèves ne sait pas lequel est concerné.
  const sujet = versFamille
    ? `Message de ${message.fromName} au sujet de ${thread.studentName}`
    : `Message de ${message.fromName} (${thread.studentName})`;

  const bonjour = versFamille ? 'Bonjour,' : `Bonjour ${B.esc(thread.teacherName)},`;

  return M.sendSafe({
    from: `${B.BRAND} <${B.FROM_EMAIL}>`,
    to: [dest],
    reply_to: B.CONTACT_EMAIL,
    subject: sujet,
    html: `
      <p style="font-family:Arial,sans-serif;font-size:15px">${bonjour}</p>
      <p style="font-family:Arial,sans-serif;font-size:15px">
        <b>${B.esc(message.fromName)}</b> t'a envoyé un message
        ${versFamille ? `au sujet de <b>${B.esc(thread.studentName)}</b>` : ''} sur ton espace
        ${B.esc(B.BRAND)}.
      </p>
      <p style="font-family:Arial,sans-serif;font-size:15px">
        <a href="${B.esc(B.PUBLIC_URL)}" style="color:#4F46E5">Ouvrir la conversation</a>
      </p>
      <p style="font-family:Arial,sans-serif;font-size:13px;color:#666">
        Tu ne recevras pas de nouvel e-mail pour cette conversation tant que tu ne l'auras pas ouverte.
      </p>
      ${B.emailFooter()}`
  }, `alerte message ${message.id}`);
}
```

Compléter l'export :

```js
module.exports = { notifyDecisionMakers, notifyStudentOfDecision, notifyNewMessage, decisionUrl, ACTOR_LABEL };
```

Mettre à jour le commentaire d'en-tête du fichier : ajouter `api/messages.js` à la liste des points d'entrée servis.

- [ ] **Step 4: Lancer les tests**

Run: `node --test test/messages-mail.test.js`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add api/_notify.js test/messages-mail.test.js
git commit -m "feat(messages): e-mail d alerte nommant l enfant concerne"
```

---

### Task 6: Point d'entrée HTTP `api/messages.js`

**Files:**
- Create: `api/messages.js`
- Create: `test/helpers/http.js`
- Create: `test/messages-endpoint.test.js`

**Interfaces:**
- Consumes: tout `api/_messages.js`, `A.verifyToken`, `A.signToken`, `N.notifyNewMessage`.
- Produces: le point d'entrée. Actions : `threads.list`, `thread.open`, `message.send`, `contacts.list`.

- [ ] **Step 1: Écrire l'utilitaire d'appel HTTP**

Ce couple `req`/`res` factice sert aux tâches 6 **et** 8 : il vit donc dans un fichier
partagé plutôt que recopié dans chaque suite.

Create `test/helpers/http.js`:

```js
// Faux couple req/res compatible avec la signature des fonctions Vercel
// (res.status().json()), pour appeler un point d'entrée sans serveur HTTP.

function faireRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

// Appelle un handler Vercel en POST, avec jeton facultatif.
function appeler(handler) {
  return async function appel(body, token) {
    const req = {
      method: 'POST',
      headers: token ? { authorization: 'Bearer ' + token } : {},
      body, query: {}
    };
    const res = faireRes();
    await handler(req, res);
    return res;
  };
}

module.exports = { faireRes, appeler };
```

- [ ] **Step 2: Écrire les tests en échec**

Create `test/messages-endpoint.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');
const { appeler } = require('./helpers/http');

const H = installHarness();
const A = require('../api/_auth');
const S = require('../api/_schedule');
const M = require('../api/_messages');
const appel = appeler(require('../api/messages'));

const jeton = (sub, role) => A.signToken({ sub, role, email: '' }, 3600);

async function ecole() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'p@kvs.test' });
  await A.putUser({ username: 'bilal', firstName: 'Bilal', lastName: 'Keita', email: 'p@kvs.test' });
  await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 90,
    startsAt: new Date(Date.now() + 864e5).toISOString(),
    students: ['mohamedjr'], teacherUsername: 'blaise', teacherName: 'Blaise Mentor'
  });
}

test('sans jeton, tout est refuse', async () => {
  H.reset(); await ecole();
  const r = await appel({ action: 'threads.list' });
  assert.equal(r.statusCode, 401);
});

test('la famille peut ecrire la premiere', async () => {
  H.reset(); await ecole();
  const r = await appel({ action: 'message.send', to: 'blaise', body: 'Bonjour, une question' },
    jeton('mohamedjr', 'student'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.notified, true);
  assert.equal(H.mails.length, 1);
});

test('ecrire a un enseignant sans seance commune est refuse', async () => {
  H.reset(); await ecole();
  const r = await appel({ action: 'message.send', to: 'blaise', body: 'Coucou' },
    jeton('bilal', 'student'));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'not_allowed');
});

test('un eleve ne peut pas ouvrir le fil d un autre', async () => {
  H.reset(); await ecole();
  await appel({ action: 'message.send', to: 'blaise', body: 'a' }, jeton('mohamedjr', 'student'));
  const tid = M.threadId('blaise', 'mohamedjr');
  const r = await appel({ action: 'thread.open', threadId: tid }, jeton('bilal', 'student'));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'not_a_participant');
});

test('thread.open marque lu pour l appelant', async () => {
  H.reset(); await ecole();
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'Bonjour' }, jeton('blaise', 'teacher'));
  const tid = M.threadId('blaise', 'mohamedjr');
  assert.equal((await M.getThread(tid)).unread.student, 1);
  const r = await appel({ action: 'thread.open', threadId: tid }, jeton('mohamedjr', 'student'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.messages.length, 1);
  assert.equal((await M.getThread(tid)).unread.student, 0);
});

test('l admin lit tout mais ne marque rien et ne peut pas ecrire', async () => {
  H.reset(); await ecole();
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'Bonjour' }, jeton('blaise', 'teacher'));
  const tid = M.threadId('blaise', 'mohamedjr');
  const adm = jeton('admin@kvs.test', 'admin');

  const liste = await appel({ action: 'threads.list' }, adm);
  assert.equal(liste.body.threads.length, 1);

  const ouvre = await appel({ action: 'thread.open', threadId: tid }, adm);
  assert.equal(ouvre.statusCode, 200);
  assert.equal((await M.getThread(tid)).unread.student, 1,
    'la lecture admin ne doit pas faire croire que la famille a ouvert');

  const ecrit = await appel({ action: 'message.send', threadId: tid, body: 'non' }, adm);
  assert.equal(ecrit.statusCode, 403);
  assert.equal(ecrit.body.error, 'read_only');
});

test('la deuxieme alerte est retenue puis rearmee apres lecture', async () => {
  H.reset(); await ecole();
  const pro = jeton('blaise', 'teacher');
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'un' }, pro);
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'deux' }, pro);
  assert.equal(H.mails.length, 1, 'deux messages, un seul e-mail');

  await appel({ action: 'thread.open', threadId: M.threadId('blaise', 'mohamedjr') },
    jeton('mohamedjr', 'student'));
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'trois' }, pro);
  assert.equal(H.mails.length, 2, 'apres lecture, l alerte se rearme');
});

test('corps vide ou trop long refuse', async () => {
  H.reset(); await ecole();
  const t = jeton('blaise', 'teacher');
  assert.equal((await appel({ action: 'message.send', to: 'mohamedjr', body: '  ' }, t)).statusCode, 400);
  assert.equal((await appel({ action: 'message.send', to: 'mohamedjr', body: 'x'.repeat(2001) }, t)).statusCode, 400);
});

test('le garde-fou renvoie 429', async () => {
  H.reset(); await ecole();
  const t = jeton('blaise', 'teacher');
  for (let i = 0; i < M.RATE_MAX; i++) {
    await appel({ action: 'message.send', to: 'mohamedjr', body: 'm' + i }, t);
  }
  const r = await appel({ action: 'message.send', to: 'mohamedjr', body: 'de trop' }, t);
  assert.equal(r.statusCode, 429);
});

test('contacts.list ne propose que les interlocuteurs autorises', async () => {
  H.reset(); await ecole();
  const r = await appel({ action: 'contacts.list' }, jeton('mohamedjr', 'student'));
  assert.deepEqual(r.body.contacts, [{ username: 'blaise', name: 'Blaise Mentor' }]);
  const vide = await appel({ action: 'contacts.list' }, jeton('bilal', 'student'));
  assert.deepEqual(vide.body.contacts, []);
});
```

- [ ] **Step 3: Lancer les tests pour les voir échouer**

Run: `node --test test/messages-endpoint.test.js`
Expected: FAIL — `Cannot find module '../api/messages'`.

- [ ] **Step 4: Implémenter**

Create `api/messages.js`:

```js
// Fonction serverless Vercel — MESSAGERIE ENSEIGNANT ↔ FAMILLE.
//
// 🔒 CLOISONNEMENT : l'identité vient du JETON SIGNÉ (payload.sub / payload.role),
//    jamais du corps de la requête. Un élève ne peut donc lire que SES fils.
//
// En-tête : Authorization: Bearer <token>   (ou body.token en repli)
//
// POST { action:'threads.list' }                          → { ok, role, threads:[…] }
// POST { action:'thread.open', threadId, before? }        → { ok, thread, messages:[…] }
//        `before` = identifiant de message (curseur d'historique), pas un horodatage.
// POST { action:'message.send', threadId|to, body }       → { ok, message, notified }
// POST { action:'contacts.list' }                         → { ok, contacts:[…] }
//
// Codes : 400 invalid_body · 401 unauthorized · 403 not_allowed / not_a_participant /
//         read_only · 429 too_many · 500 not_configured / server_error
//
// L'ADMIN est en LECTURE SEULE : il lit tous les fils (supervision annoncée aux
// participants) mais ne peut ni écrire ni marquer un fil comme lu — sa lecture ne
// doit pas faire croire à l'enseignant que la famille a ouvert le message.

const A = require('./_auth');
const M = require('./_messages');
const N = require('./_notify');

function readToken(req, body) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const t = String(hdr).replace(/^Bearer\s+/i, '');
  return t || (body && body.token) || '';
}

// Vue transmise au navigateur : on ne renvoie jamais l'objet fil brut, pour ne pas
// divulguer l'état de lecture de l'autre partie au-delà de ce qui est nécessaire.
function threadView(t, side) {
  const moi = side === 'admin' ? null : side;
  const autre = moi === 'teacher' ? 'student' : 'teacher';
  return {
    id: t.id,
    teacherName: t.teacherName, studentName: t.studentName,
    teacherUsername: t.teacherUsername, studentUsername: t.studentUsername,
    withName: moi === 'teacher' ? t.studentName : t.teacherName,
    lastSnippet: t.lastSnippet, lastMessageAt: t.lastMessageAt, lastFrom: t.lastFrom,
    unread: moi ? (t.unread || {})[moi] || 0 : 0,
    // Horodatage de lecture de l'AUTRE : c'est ce qui affiche « Lu » à l'expéditeur.
    otherReadAt: moi ? (t.lastReadAt || {})[autre] : null,
    readOnly: side === 'admin'
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  if (!A.configured() || !A.kvConfigured()) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  const payload = A.verifyToken(readToken(req, body));
  const role = payload && payload.role;
  if (!payload || !payload.sub || !['teacher', 'student', 'admin'].includes(role)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  const me = A.normUsername(payload.sub);
  const isAdmin = role === 'admin';

  // L'appelant participe-t-il à ce fil ?
  const participe = (t) => isAdmin
    || (role === 'teacher' && t.teacherUsername === me)
    || (role === 'student' && t.studentUsername === me);

  try {
    if (body.action === 'threads.list') {
      const fils = await M.listThreads(isAdmin ? 'admin' : role, me, 50);
      res.status(200).json({ ok: true, role, threads: fils.map(t => threadView(t, isAdmin ? 'admin' : role)) });
      return;
    }

    if (body.action === 'contacts.list') {
      if (isAdmin) { res.status(200).json({ ok: true, contacts: [] }); return; }
      res.status(200).json({ ok: true, contacts: await M.contactsFor(role, me) });
      return;
    }

    if (body.action === 'thread.open') {
      const t = await M.getThread(String(body.threadId || '').slice(0, 100));
      if (!t) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      if (!participe(t)) { res.status(403).json({ ok: false, error: 'not_a_participant' }); return; }

      const messages = await M.getMessages(t.id, { limit: 50, before: body.before || null });
      // La lecture admin ne marque rien : voir l'avertissement en tête de fichier.
      const apres = isAdmin ? t : await M.markRead(t, role);
      res.status(200).json({
        ok: true,
        thread: threadView(apres, isAdmin ? 'admin' : role),
        messages
      });
      return;
    }

    if (body.action === 'message.send') {
      if (isAdmin) { res.status(403).json({ ok: false, error: 'read_only', message: 'La supervision est en lecture seule.' }); return; }

      const texte = String(body.body == null ? '' : body.body).trim();
      if (!texte || texte.length > M.MAX_BODY) {
        res.status(400).json({ ok: false, error: 'invalid_body', message: `Le message doit contenir entre 1 et ${M.MAX_BODY} caractères.` });
        return;
      }

      // Garde-fou AVANT toute écriture : placé après la résolution du fil, une
      // rafale bloquée aurait quand même créé les fils au passage.
      if (await M.rateLimited(me)) {
        res.status(429).json({ ok: false, error: 'too_many', message: 'Trop de messages envoyés. Réessaie dans quelques minutes.' });
        return;
      }

      // Résolution du fil : soit il existe, soit on le crée après contrôle du droit.
      let thread;
      if (body.threadId) {
        thread = await M.getThread(String(body.threadId).slice(0, 100));
        if (!thread) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
        if (!participe(thread)) { res.status(403).json({ ok: false, error: 'not_a_participant' }); return; }
      } else {
        // Le rôle du destinataire se DÉDUIT de celui de l'appelant : jamais lu du corps.
        const autre = A.normUsername(body.to);
        if (!autre) { res.status(400).json({ ok: false, error: 'invalid_body', message: 'Destinataire manquant.' }); return; }
        const teacherUsername = role === 'teacher' ? me : autre;
        const studentUsername = role === 'teacher' ? autre : me;
        if (!(await M.canOpen(teacherUsername, studentUsername))) {
          res.status(403).json({ ok: false, error: 'not_allowed', message: 'Aucun cours ne vous relie à cet interlocuteur.' });
          return;
        }
        thread = await M.ensureThread({ teacherUsername, studentUsername });
      }

      const acct = role === 'teacher' ? await A.getTeacher(me) : await A.getUser(me);
      const fromName = acct ? (`${acct.firstName || ''} ${acct.lastName || ''}`.trim() || me) : me;

      // Le message est persisté ICI, avant toute tentative d'e-mail.
      const r = await M.appendMessage(thread, { fromRole: role, fromUsername: me, fromName, body: texte });

      // Alerte best-effort, et seulement si le destinataire n'en a pas déjà une en attente.
      const dest = M.otherSide(role);
      let notified = false;
      if (M.shouldAlert(r.thread, dest)) {
        const envoi = await N.notifyNewMessage(r.thread, r.message, dest);
        if (envoi && envoi.sent) { await M.noteAlerted(r.thread, dest); notified = true; }
      }

      res.status(200).json({ ok: true, message: r.message, notified });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[messages]', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
```

- [ ] **Step 5: Lancer toute la suite**

Run: `node --test test/`
Expected: `# fail 0`, au moins 32 tests passants.

- [ ] **Step 6: Commit**

```bash
git add api/messages.js test/helpers/http.js test/messages-endpoint.test.js
git commit -m "feat(messages): point d entree HTTP avec cloisonnement et supervision"
```

---

### Task 7: Interface enseignant et élève (module partagé)

Un seul module de rendu sert les deux rôles : la boîte de réception est identique, seul le vocabulaire change. Écrire deux fois le même écran serait la garantie qu'ils divergent.

**Files:**
- Modify: `index.html` — nouveau module `KVS_Messages` après `KVS_ZoomManager` ; onglet « Messages » dans `renderTeacher` ; entrée « Messages » dans la barre latérale du tableau de bord élève ; exports `APP`
- Modify: `style.css` — réutiliser les 12 règles `.tch-msg*` orphelines, compléter

**Interfaces:**
- Consumes: `POST /api/messages` (Task 6), `sessionStorage.kvs_token`, helpers existants `$`, `toast`, `modal`, `_admEsc`, `icon`, `refreshIcons`.
- Produces:
  - `APP.msgOpenInbox(hostId, role)` — dessine la boîte dans le conteneur donné
  - `APP.msgOpenThread(threadId)`, `APP.msgSend(event)`, `APP.msgNew()`, `APP.msgBack()`
  - `APP.msgUnreadCount()` → `number` — pour la pastille

- [ ] **Step 1: Écrire le module de messagerie**

Dans `index.html`, insérer avant `// === BUY CREDITS ===` :

```js
  // === MESSAGERIE ENSEIGNANT ↔ FAMILLE ========================================
  // Un seul module pour les deux rôles : le serveur filtre déjà par le jeton, donc
  // l'écran est le même — seul le vocabulaire diffère. Deux implémentations
  // parallèles finiraient inévitablement par diverger.
  const KVS_Messages = {
    role: 'student', hostId: null, threads: [], current: null, messages: [], contacts: [],

    async api(payload) {
      let token = null;
      try { token = sessionStorage.getItem('kvs_token'); } catch (_) {}
      if (!token) return { ok: false, error: 'unauthorized' };
      try {
        const res = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        return Object.assign({ status: res.status }, data);
      } catch (_) { return { ok: false, error: 'network' }; }
    },

    unreadTotal() { return this.threads.reduce((n, t) => n + (t.unread || 0), 0); },

    async openInbox(hostId, role) {
      this.hostId = hostId; this.role = role || 'student';
      this.current = null;
      const d = await this.api({ action: 'threads.list' });
      this.threads = d.ok ? d.threads : [];
      const c = await this.api({ action: 'contacts.list' });
      this.contacts = c.ok ? c.contacts : [];
      this.renderInbox(d.ok ? null : (d.status === 401 ? 'expired' : 'error'));
    },

    renderInbox(state) {
      const host = $(this.hostId); if (!host) return;
      const vide = state === 'expired' ? 'Ta session a expiré — reconnecte-toi.'
        : state === 'error' ? 'Messagerie indisponible pour le moment.'
          : this.role === 'teacher'
            ? 'Aucune conversation. Écris à une famille depuis « Nouveau message ».'
            : 'Aucune conversation. Tu peux écrire à ton enseignant.';

      host.innerHTML = `
        <div class="msg-head">
          <h3>Messages ${this.unreadTotal() ? `<span class="tch-count is-alert">${this.unreadTotal()}</span>` : ''}</h3>
          ${this.contacts.length ? `<button class="msg-new" onclick="APP.msgNew()">${icon('pen-line', { size: 'sm' })} Nouveau message</button>` : ''}
        </div>
        ${!this.threads.length
          ? `<div class="tch-none">${icon('mail', { size: 'lg', tone: 'muted' })}<p>${vide}</p></div>`
          : `<div class="msg-list">${this.threads.map(t => `
              <button class="msg-item${t.unread ? ' is-unread' : ''}" onclick="APP.msgOpenThread('${_admEsc(t.id)}')">
                <span class="msg-item-w">${_admEsc(t.withName || '—')}</span>
                <span class="msg-item-s">${_admEsc(t.lastSnippet || 'Conversation ouverte')}</span>
                <span class="msg-item-d">${_admEsc(_fmtDateTime(new Date(Date.parse(t.lastMessageAt))))}</span>
                ${t.unread ? `<span class="msg-badge">${t.unread}</span>` : ''}
              </button>`).join('')}</div>`}
        <p class="msg-supervise">${icon('eye', { size: 'sm', tone: 'muted' })} L’équipe pédagogique peut consulter ces conversations.</p>`;
      refreshIcons();
    },

    async openThread(threadId) {
      const d = await this.api({ action: 'thread.open', threadId });
      if (!d.ok) { toast('Conversation inaccessible.', 'err', '⚠️'); return; }
      this.current = d.thread; this.messages = d.messages || [];
      // Le compteur local suit le serveur : le fil vient d'être marqué lu.
      const t = this.threads.find(x => x.id === threadId);
      if (t) t.unread = 0;
      this.renderThread();
    },

    renderThread() {
      const host = $(this.hostId); if (!host || !this.current) return;
      const th = this.current;
      const lu = th.otherReadAt ? Date.parse(th.otherReadAt) : 0;
      host.innerHTML = `
        <div class="msg-head">
          <button class="msg-back" onclick="APP.msgBack()">${icon('arrow-left', { size: 'sm' })} Retour</button>
          <h3>${_admEsc(th.withName || '')}</h3>
        </div>
        <div class="msg-thread" id="msgThread">
          ${this.messages.map(m => {
            const moi = m.fromRole === this.role;
            const vu = moi && lu >= Date.parse(m.sentAt);
            return `<div class="msg-b${moi ? ' is-me' : ''}">
              <div class="msg-b-h">${_admEsc(m.fromName)} · ${_admEsc(_fmtDateTime(new Date(Date.parse(m.sentAt))))}</div>
              <div class="msg-b-t">${_admEsc(m.body)}</div>
              ${moi ? `<div class="msg-b-r">${vu ? 'Lu' : 'Envoyé'}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
        ${th.readOnly ? '<p class="msg-supervise">Consultation en lecture seule.</p>' : `
        <form class="msg-form" onsubmit="return APP.msgSend(event)">
          <textarea id="msgBody" rows="3" maxlength="2000" placeholder="Écris ton message…" required></textarea>
          <button type="submit" class="btn-submit" id="msgSend">Envoyer</button>
        </form>`}`;
      refreshIcons();
      const z = $('msgThread'); if (z) z.scrollTop = z.scrollHeight;
    },

    async send(e) {
      if (e) e.preventDefault();
      const zone = $('msgBody'); const btn = $('msgSend');
      const texte = zone ? zone.value.trim() : '';
      if (!texte) return false;
      if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
      const d = await this.api({ action: 'message.send', threadId: this.current.id, body: texte });
      if (btn) { btn.disabled = false; btn.textContent = 'Envoyer'; }
      if (!d.ok) {
        toast(d.status === 429 ? 'Trop de messages envoyés — patiente quelques minutes.'
          : (d.message || 'Envoi impossible.'), 'err', '⚠️');
        return false;
      }
      if (zone) zone.value = '';
      this.messages.push(d.message);
      this.renderThread();
      return false;
    },

    newMessage() {
      if (!this.contacts.length) { toast('Aucun interlocuteur disponible.', 'info', '📭'); return; }
      modal('Nouveau message', `
        <form onsubmit="return APP.msgStart(event)">
          <div class="form-g">
            <label for="msgTo">Destinataire</label>
            <select id="msgTo">${this.contacts.map(c => `<option value="${_admEsc(c.username)}">${_admEsc(c.name)}</option>`).join('')}</select>
          </div>
          <div class="form-g">
            <label for="msgFirst">Message</label>
            <textarea id="msgFirst" rows="4" maxlength="2000" required placeholder="Écris ton message…"></textarea>
          </div>
          <button type="submit" class="btn-submit">Envoyer</button>
        </form>`);
    },

    async start(e) {
      if (e) e.preventDefault();
      const to = $('msgTo').value, texte = $('msgFirst').value.trim();
      if (!texte) return false;
      const d = await this.api({ action: 'message.send', to, body: texte });
      if (!d.ok) { toast(d.message || 'Envoi impossible.', 'err', '⚠️'); return false; }
      closeModal();
      toast('Message envoyé 📩', 'ok', '📩');
      this.openInbox(this.hostId, this.role);
      return false;
    }
  };
```

- [ ] **Step 2: Exporter les fonctions dans `APP`**

Dans l'objet retourné en fin d'IIFE, après la ligne `mcView, mcShiftMonth, …`, ajouter :

```js
    msgOpenInbox: (h, r) => KVS_Messages.openInbox(h, r),
    msgOpenThread: (id) => KVS_Messages.openThread(id),
    msgSend: (e) => KVS_Messages.send(e),
    msgStart: (e) => KVS_Messages.start(e),
    msgNew: () => KVS_Messages.newMessage(),
    msgBack: () => KVS_Messages.renderInbox(),
    msgUnreadCount: () => KVS_Messages.unreadTotal(),
```

- [ ] **Step 3: Ajouter l'onglet « Messages » côté enseignant**

Dans `renderTeacher()`, remplacer le bloc `<div class="tch-tabs">` par :

```js
      <div class="tch-tabs">
        <button class="tch-tab${teacherTabState === 'overview' ? ' active' : ''}" data-tab="overview" onclick="APP.teacherTab('overview')">Vue d’ensemble</button>
        <button class="tch-tab${teacherTabState === 'students' ? ' active' : ''}" data-tab="students" onclick="APP.teacherTab('students')">Mes élèves</button>
        <button class="tch-tab${teacherTabState === 'planning' ? ' active' : ''}" data-tab="planning" onclick="APP.teacherTab('planning')">Planning</button>
        <button class="tch-tab${teacherTabState === 'messages' ? ' active' : ''}" data-tab="messages" onclick="APP.teacherTab('messages')">Messages</button>
      </div>
```

Dans `renderTeacherTab()`, ajouter en première branche :

```js
    if (teacherTabState === 'messages') {
      c.innerHTML = '<section class="card tch-card" id="tchMsgHost"></section>';
      KVS_Messages.openInbox('tchMsgHost', 'teacher');
      return;
    }
```

- [ ] **Step 4: Ajouter l'entrée « Messages » côté élève**

Dans la barre latérale de `viewDashboard` (`<nav class="sb-nav">`), après le bouton `PARRAINAGE`, insérer :

```html
      <button class="sb-link" onclick="APP.goMessages()" title="Messages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H5.5L4 17.5z"/></svg>MESSAGES</button>
```

Ajouter la vue après `viewDashboard` :

```html
<div class="view" id="viewMessages" style="display:none">
  <main class="dash-main">
    <header class="dash-id"><div class="dash-id-main"><h1>Messages</h1></div></header>
    <section class="card" style="padding:26px" id="stuMsgHost"></section>
  </main>
</div>
```

Ajouter la fonction de navigation près de `goDashboard` :

```js
  function goMessages() { switchView('viewMessages'); KVS_Messages.openInbox('stuMsgHost', 'student'); }
```

Déclarer la vue aux trois endroits qui l'exigent.

Dans `switchView`, ajouter `'viewMessages'` au tableau des vues masquées :

```js
    ['viewLanding','viewDashboard','viewSandbox','viewResources','viewCommunity','viewParents','viewReferral','viewProfile','viewLoop','viewTeacher','viewBooking','viewAdmin','viewMessages'].forEach(v => hide(v));
```

Dans le même `switchView`, ajouter le titre de page — insérer cette ligne dans la
cascade de ternaires, juste avant la ligne `target === 'viewTeacher' ? …` :

```js
                     target === 'viewMessages' ? 'Messages — Kodingvillageschool' :
```

Dans `NAV_VIEWS`, ajouter la vue pour que la barre de navigation mobile reste visible :

```js
  const NAV_VIEWS = new Set(['viewDashboard','viewSandbox','viewResources','viewCommunity','viewParents','viewReferral','viewProfile','viewLoop','viewMessages']);
```

Enfin, exporter `goMessages` dans l'objet `APP` retourné en fin d'IIFE, sur la ligne
qui contient déjà `goResources` :

```js
    goMessages,
```

- [ ] **Step 5: Ajouter les styles**

Ajouter à la fin de `style.css` :

```css
/* === MESSAGERIE ============================================================ */
.msg-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.msg-head h3{flex:1}
.msg-new,.msg-back{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--t2);font:inherit;font-size:.78rem;font-weight:600;cursor:pointer}
.msg-new:hover,.msg-back:hover{border-color:var(--indigo);color:var(--indigo)}
.msg-list{display:flex;flex-direction:column}
.msg-item{display:grid;grid-template-columns:1.1fr 2fr auto auto;gap:12px;align-items:center;padding:13px 8px;border:0;border-bottom:1px solid var(--border-light);background:transparent;font:inherit;text-align:left;cursor:pointer}
.msg-item:hover{background:var(--surface-hover)}
.msg-item-w{font-weight:700;font-size:.88rem}
.msg-item-s{color:var(--t3);font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msg-item-d{color:var(--t3);font-size:.74rem;white-space:nowrap}
.msg-item.is-unread .msg-item-w,.msg-item.is-unread .msg-item-s{color:var(--t1);font-weight:700}
.msg-badge{display:inline-flex;min-width:20px;height:20px;align-items:center;justify-content:center;padding:0 6px;border-radius:var(--r-full);background:var(--indigo);color:#fff;font-size:.7rem;font-weight:700}
.msg-thread{display:flex;flex-direction:column;gap:12px;max-height:420px;overflow-y:auto;padding:4px 2px 12px}
.msg-b{max-width:78%;padding:11px 14px;border-radius:var(--r-md);background:var(--bg);border:1px solid var(--border-light)}
.msg-b.is-me{align-self:flex-end;background:var(--indigo-l);border-color:transparent}
.msg-b-h{font-size:.72rem;color:var(--t3);margin-bottom:4px}
.msg-b-t{font-size:.88rem;white-space:pre-wrap;overflow-wrap:anywhere}
.msg-b-r{margin-top:5px;font-size:.68rem;color:var(--t3);text-align:right}
.msg-form{display:flex;flex-direction:column;gap:10px;margin-top:14px}
.msg-form textarea{padding:11px 13px;border:1.5px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--t1);font:inherit;font-size:.88rem;resize:vertical}
.msg-form textarea:focus{outline:none;border-color:var(--indigo);background:var(--surface)}
.msg-form .btn-submit{width:auto;align-self:flex-end;padding:10px 24px;margin:0}
.msg-supervise{display:flex;align-items:center;gap:7px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border-light);font-size:.74rem;color:var(--t3)}
@media(max-width:640px){
  .msg-item{grid-template-columns:1fr auto;gap:5px}
  .msg-item-s,.msg-item-d{grid-column:1/-1}
  .msg-b{max-width:92%}
}
```

- [ ] **Step 6: Vérifier la syntaxe**

Run:
```bash
node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('index.html','utf8');const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;let m,bad=0;while((m=re.exec(h))){try{new vm.Script(m[1])}catch(e){bad++;console.log(e.message)}}console.log(bad?'KO':'OK')"
```
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add index.html style.css
git commit -m "feat(messages): boite de reception partagee enseignant et famille"
```

---

### Task 8: Supervision admin et vérification bout en bout

**Files:**
- Modify: `index.html` — carte « Conversations » dans `viewAdmin`, fonction `adminMessagesRefresh`, appel dans `goAdmin`, export
- Create: `test/messages-e2e.test.js`

**Interfaces:**
- Consumes: `POST /api/messages` avec un jeton admin ; `_adminApi` n'est **pas** utilisé (autre point d'entrée).
- Produces: `APP.adminMessagesRefresh()`.

- [ ] **Step 1: Écrire le test de bout en bout**

Create `test/messages-e2e.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const { appeler } = require('./helpers/http');

const H = installHarness();
const A = require('../api/_auth');
const S = require('../api/_schedule');
const M = require('../api/_messages');
const appel = appeler(require('../api/messages'));

const jeton = (sub, role) => A.signToken({ sub, role, email: '' }, 3600);

test('parcours complet : la famille ecrit, le prof repond, l admin supervise', async () => {
  H.reset();
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'parent@kvs.test' });
  await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 90,
    startsAt: new Date(Date.now() + 864e5).toISOString(),
    students: ['mohamedjr'], teacherUsername: 'blaise', teacherName: 'Blaise Mentor'
  });

  const famille = jeton('mohamedjr', 'student');
  const pro = jeton('blaise', 'teacher');
  const adm = jeton('admin@kvs.test', 'admin');

  // 1. La famille ecrit la premiere
  const envoi = await appel({ action: 'message.send', to: 'blaise', body: 'Bonjour, Mohamed sera absent mardi.' }, famille);
  assert.equal(envoi.statusCode, 200);
  assert.equal(H.mails.length, 1);
  assert.match(H.mails[0].subject, /Mohamed Junior/);

  // 2. Le prof voit le fil non lu
  const boite = await appel({ action: 'threads.list' }, pro);
  assert.equal(boite.body.threads.length, 1);
  assert.equal(boite.body.threads[0].unread, 1);
  assert.equal(boite.body.threads[0].withName, 'Mohamed Junior');

  // 3. Il ouvre : le fil passe lu
  const tid = boite.body.threads[0].id;
  const ouvert = await appel({ action: 'thread.open', threadId: tid }, pro);
  assert.equal(ouvert.body.messages.length, 1);
  assert.equal((await appel({ action: 'threads.list' }, pro)).body.threads[0].unread, 0);

  // 4. Il repond -> la famille est alertee (elle n a pas d alerte en attente)
  await appel({ action: 'message.send', threadId: tid, body: 'Bien noté, merci !' }, pro);
  assert.equal(H.mails.length, 2);
  assert.deepEqual(H.mails[1].to, ['parent@kvs.test']);

  // 5. La famille voit « Lu » sur son premier message
  const vueFamille = await appel({ action: 'thread.open', threadId: tid }, famille);
  assert.ok(vueFamille.body.thread.otherReadAt, 'le prof a lu, la famille doit le voir');

  // 6. L admin supervise sans rien perturber
  const avant = JSON.stringify(await M.getThread(tid));
  const vueAdmin = await appel({ action: 'thread.open', threadId: tid }, adm);
  assert.equal(vueAdmin.body.messages.length, 2);
  assert.equal(vueAdmin.body.thread.readOnly, true);
  assert.equal(JSON.stringify(await M.getThread(tid)), avant, 'la supervision ne modifie rien');
});
```

- [ ] **Step 2: Lancer le test**

Run: `node --test test/messages-e2e.test.js`
Expected: `# pass 1`, `# fail 0`.

- [ ] **Step 3: Ajouter la carte admin**

Dans `index.html`, après la carte « Demandes de report » de `viewAdmin`, insérer :

```html
    <!-- Supervision des conversations — lecture seule, annoncée aux participants -->
    <div class="booking-card adm-card">
      <div class="booking-head">
        <div class="booking-step-pill">Supervision</div>
        <h1>Conversations</h1>
        <p>Tous les échanges enseignant ↔ famille, en lecture seule. Les participants en sont informés dans le fil.</p>
      </div>
      <div class="adm-table-head">
        <h2>Fils (<span id="admMsgCount">0</span>)</h2>
        <button class="btn-ghost" onclick="APP.adminMessagesRefresh()"><span class="ui-icon-container is-sm"><i data-lucide="refresh-cw"></i></span> Rafraîchir</button>
      </div>
      <div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr><th>Enseignant</th><th>Élève</th><th>Dernier message</th><th>Extrait</th></tr></thead>
          <tbody id="admMsgTbody"></tbody>
        </table>
      </div>
    </div>
```

- [ ] **Step 4: Implémenter le rafraîchissement admin**

Après `adminReschedDecide`, ajouter :

```js
  // Supervision : passe par /api/messages avec le jeton admin, pas par _adminApi
  // (ce sont deux points d'entrée distincts).
  async function adminMessagesRefresh() {
    let token = adminToken;
    if (!token) return;
    let data = {};
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ action: 'threads.list' })
      });
      data = await res.json().catch(() => ({}));
    } catch (_) { data = {}; }
    const rows = (data && data.threads) || [];
    $('admMsgCount').textContent = rows.length;
    $('admMsgTbody').innerHTML = rows.map(t => `<tr>
      <td>${_admEsc(t.teacherName || t.teacherUsername)}</td>
      <td>${_admEsc(t.studentName || t.studentUsername)}</td>
      <td>${_admEsc(_admSesFmt(t.lastMessageAt))}</td>
      <td>${_admEsc(t.lastSnippet || '—')}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="adm-empty">Aucune conversation.</td></tr>';
  }
```

Dans `goAdmin()`, ajouter `adminMessagesRefresh();` à la fin de la liste d'appels, et exporter `adminMessagesRefresh` dans `APP`.

- [ ] **Step 5: Lancer toute la suite et vérifier la syntaxe du front**

Run: `node --test test/`
Expected: `# fail 0`.

Run:
```bash
node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('index.html','utf8');const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;let m,bad=0;while((m=re.exec(h))){try{new vm.Script(m[1])}catch(e){bad++;console.log(e.message)}}console.log(bad?'KO':'OK')"
```
Expected: `OK`

- [ ] **Step 6: Vérification navigateur**

Démarrer le serveur local de développement, se connecter successivement comme élève, enseignant puis admin, et vérifier de visu :

1. l'élève écrit à Blaise depuis « Nouveau message » ;
2. l'enseignant voit la pastille de non-lus sur l'onglet « Messages », ouvre, répond ;
3. l'élève voit « Lu » sous son message ;
4. l'admin voit le fil dans « Conversations » sans pouvoir écrire ;
5. la mention de supervision est visible dans les deux espaces.

- [ ] **Step 7: Commit**

```bash
git add index.html test/messages-e2e.test.js
git commit -m "feat(messages): supervision admin en lecture seule + parcours de bout en bout"
```

---

## Vérification finale

- [ ] `node --test test/` — toute la suite au vert
- [ ] La mention « L'équipe pédagogique peut consulter ces conversations » apparaît côté enseignant **et** côté élève
- [ ] Aucun `package.json` n'a été créé — l'invariant zéro dépendance tient
- [ ] Les 12 règles `.tch-msg*` orphelines de `style.css` sont soit réutilisées, soit supprimées
