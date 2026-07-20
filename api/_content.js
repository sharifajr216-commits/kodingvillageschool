// Bibliothèque PARTAGÉE (préfixe `_` → non routée par Vercel).
// Catalogue des supports de cours + résolution des fichiers sur Vercel Blob.
//
// Utilisé par : api/content.js
//
// ── POURQUOI VERCEL BLOB ────────────────────────────────────────────────────
// Les supports pèsent ~134 Mo. Les mettre dans le dépôt alourdirait l'historique
// git définitivement. Ils vivent donc sur Vercel Blob, hors du dépôt.
//
// ── CE QUE PROTÈGE (ET NE PROTÈGE PAS) CE MODULE ────────────────────────────
// /api/content vérifie le jeton ET l'inscription au cours avant de livrer
// l'URL. Mais une fois l'URL obtenue, elle reste lisible sans authentification
// (les blobs « public » de Vercel ont une URL aléatoire, donc non devinable,
// mais sans expiration). Un élève déterminé peut donc la partager.
// Le proxy serveur — qui masquerait totalement l'URL — est IMPOSSIBLE ici :
// les fonctions Vercel plafonnent leur réponse à 4,5 Mo, or un chapitre en
// pèse 16. Pour un verrouillage strict, il faudrait passer aux blobs privés.
//
// ── TÉLÉVERSER LES FICHIERS (une seule fois) ────────────────────────────────
//   1. Dédoublonner : « Chapter N-LC (1).pdf » est identique à « Chapter N-LC.pdf »
//   2. Vercel → Storage → Blob → créer un store, copier BLOB_READ_WRITE_TOKEN
//   3. Téléverser en respectant EXACTEMENT ces chemins :
//        cours/python-niveau-1/chapitre-1.pdf   ← Chapter 1-LC.pdf
//        cours/python-niveau-1/chapitre-2.pdf   ← Chapter 2-LC.pdf
//        … jusqu'à chapitre-8.pdf
//      (glisser-déposer dans l'interface Blob, ou via `npx vercel blob put`)

const A = require('./_auth');
const S = require('./_schedule');

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const BLOB_API = 'https://blob.vercel-storage.com';

const blobConfigured = () => !!BLOB_TOKEN;

// ── Catalogue ───────────────────────────────────────────────────────────────
// `courseIds` fait le lien avec les séances planifiées (api/_schedule.js) :
// c'est ce qui détermine si un élève a accès au module.
const MODULES = {
  'python-niveau-1': {
    label: 'Python Niveau 1',
    courseIds: ['python-boucles', 'python-fonctions', 'python-poo', 'dev-jeux-python'],
    chapters: [
      { n: 1, title: 'Introduction à la programmation' },
      { n: 2, title: 'Variables et types de données' },
      { n: 3, title: 'Conditions et logique' },
      { n: 4, title: 'Les boucles' },
      { n: 5, title: 'Les fonctions' },
      { n: 6, title: 'Listes et dictionnaires' },
      { n: 7, title: 'Gestion des erreurs' },
      { n: 8, title: 'Projet final' }
    ]
  }
};

const getModule = (id) => MODULES[id] || null;
const listModules = () => Object.keys(MODULES).map(id => ({
  id, label: MODULES[id].label, chapterCount: MODULES[id].chapters.length
}));

const blobPath = (moduleId, n) => `cours/${moduleId}/chapitre-${n}.pdf`;

// ── Résolution des URL Blob ─────────────────────────────────────────────────
// Les URL publiques Blob comportent un suffixe aléatoire : impossible de les
// reconstruire, il faut interroger l'API. Résultat mis en cache le temps de vie
// de l'instance (les fichiers de cours changent rarement).
let _cache = null, _cacheAt = 0;
const CACHE_MS = 5 * 60 * 1000;

async function listBlobs(prefix) {
  if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  const r = await fetch(`${BLOB_API}?prefix=${encodeURIComponent(prefix)}&limit=1000`, {
    headers: { 'Authorization': `Bearer ${BLOB_TOKEN}` }
  });
  if (!r.ok) throw new Error(`Blob HTTP ${r.status}`);
  const d = await r.json();
  _cache = {};
  for (const b of (d.blobs || [])) _cache[b.pathname] = { url: b.url, size: b.size };
  _cacheAt = Date.now();
  return _cache;
}

// Renvoie { url, size } ou null si le fichier n'a pas encore été téléversé.
async function resolveChapter(moduleId, n) {
  if (!blobConfigured()) return null;
  const blobs = await listBlobs('cours/');
  return blobs[blobPath(moduleId, n)] || null;
}

// État de chaque chapitre d'un module : disponible ou en attente de téléversement.
async function moduleChapters(moduleId) {
  const mod = getModule(moduleId);
  if (!mod) return [];
  let blobs = {};
  if (blobConfigured()) { try { blobs = await listBlobs('cours/'); } catch (_) { blobs = {}; } }
  return mod.chapters.map(c => {
    const b = blobs[blobPath(moduleId, c.n)];
    return { n: c.n, title: c.title, available: !!b, size: b ? b.size : null };
  });
}

// ── Contrôle d'accès ────────────────────────────────────────────────────────
// Un élève accède au module s'il a AU MOINS UNE séance (passée ou à venir) sur
// l'un des cours rattachés. Fenêtre large : un support reste consultable après
// le cours pour réviser.
const AN_MS = 365 * 24 * 3600000;
async function hasAccess(email, moduleId) {
  const mod = getModule(moduleId);
  if (!mod) return false;
  const target = A.normEmail(email);
  if (!target) return false;
  const now = Date.now();
  const sessions = await S.sessionsBetween(now - AN_MS, now + AN_MS);
  return sessions.some(s =>
    (s.students || []).includes(target) && mod.courseIds.includes(s.courseId)
  );
}

module.exports = {
  MODULES, getModule, listModules, moduleChapters,
  resolveChapter, hasAccess, blobConfigured, blobPath
};
