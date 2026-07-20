// Fonction serverless Vercel — ACCÈS AUX SUPPORTS DE COURS.
//
// 🔒 Deux verrous : jeton valide, puis inscription effective au cours
//    (l'élève doit avoir une séance rattachée au module). L'e-mail vient du
//    jeton signé, jamais du corps de la requête.
//
// En-tête : Authorization: Bearer <token élève>
//
// POST { action:'chapters', moduleId }      → 200 { ok, module, chapters:[{n,title,available,size}] }
// POST { action:'open',     moduleId, n }   → 200 { ok, url, title }   URL du PDF
//
// Codes : 401 non authentifié · 403 non inscrit · 404 module/chapitre inconnu
//         409 fichier pas encore téléversé · 500 Blob non configuré

const A = require('./_auth');
const C = require('./_content');

function readToken(req, body) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const t = String(hdr).replace(/^Bearer\s+/i, '');
  return t || (body && body.token) || '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  if (!A.configured() || !A.kvConfigured()) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  const payload = A.verifyToken(readToken(req, body));
  if (!payload || !payload.email) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const moduleId = String(body.moduleId || '');
  const mod = C.getModule(moduleId);
  if (!mod) { res.status(404).json({ ok: false, error: 'unknown_module' }); return; }

  try {
    // L'admin consulte tout ; l'élève doit être inscrit à un cours du module.
    const admin = payload.role === 'admin';
    if (!admin && !(await C.hasAccess(payload.email, moduleId))) {
      res.status(403).json({ ok: false, error: 'not_enrolled',
        message: 'Ce module sera accessible dès ta première séance sur ce cours.' });
      return;
    }

    if (body.action === 'chapters') {
      res.status(200).json({
        ok: true,
        module: { id: moduleId, label: mod.label },
        blobConfigured: C.blobConfigured(),
        chapters: await C.moduleChapters(moduleId)
      });
      return;
    }

    if (body.action === 'open') {
      const n = parseInt(body.n, 10);
      const chap = mod.chapters.find(c => c.n === n);
      if (!chap) { res.status(404).json({ ok: false, error: 'unknown_chapter' }); return; }
      if (!C.blobConfigured()) { res.status(500).json({ ok: false, error: 'blob_not_configured' }); return; }

      const blob = await C.resolveChapter(moduleId, n);
      if (!blob) {
        res.status(409).json({ ok: false, error: 'not_uploaded',
          message: `Le chapitre ${n} n'a pas encore été téléversé (${C.blobPath(moduleId, n)}).` });
        return;
      }
      res.status(200).json({ ok: true, url: blob.url, size: blob.size, title: chap.title, n });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[content]', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
