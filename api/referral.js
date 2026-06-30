// Fonction serverless Vercel — registre de parrainage CROSS-UTILISATEURS.
//
// Stockage : Vercel KV (Upstash Redis) via API REST — aucune dépendance npm.
// Variables d'environnement (créées automatiquement par l'intégration Vercel KV) :
//   KV_REST_API_URL / KV_REST_API_TOKEN   (ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
//
// Modèle de données (par code de parrainage R) :
//   ref:R:points   → nombre de parrainages réussis (= points/crédits gagnés)
//   ref:R:claimed  → points déjà réclamés (crédités) par le parrain
//   ref:R:events   → liste JSON des filleuls inscrits
//   ref:R:emails   → ensemble des e-mails déjà comptés (anti-abus / dédup)
//
// Flux :
//   POST {action:'register', ref, name, email}  → côté FILLEUL à l'inscription via lien
//   GET  ?ref=R[&claim=1]                        → côté PARRAIN : stats + réclamation des récompenses

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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

function _today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

const safeRef = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Stockage parrainage non configuré (KV_REST_API_URL/KV_REST_API_TOKEN manquants).' });
    return;
  }

  try {
    // ---- Côté FILLEUL : enregistrer un parrainage ----
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      const ref = safeRef(body && body.ref);
      if (!ref) { res.status(400).json({ error: 'Code de parrainage manquant.' }); return; }
      const name = String((body && body.name) || 'Filleul').slice(0, 60);
      const email = String((body && body.email) || '').toLowerCase().slice(0, 120);

      // Dédup : 1 e-mail ne peut créditer un même code qu'une seule fois
      const dedupKey = email || ('anon:' + Math.random().toString(36).slice(2));
      const added = await kv(['SADD', `ref:${ref}:emails`, dedupKey]);
      let counted = false;
      if (added === 1) {
        await kv(['RPUSH', `ref:${ref}:events`, JSON.stringify({ date: _today(), name, email })]);
        await kv(['INCRBY', `ref:${ref}:points`, 1]);
        counted = true;
      }
      res.status(200).json({ ok: true, counted });
      return;
    }

    // ---- Côté PARRAIN : lire les stats + réclamer les récompenses ----
    if (req.method === 'GET') {
      const ref = safeRef(req.query && req.query.ref);
      if (!ref) { res.status(400).json({ error: 'Code de parrainage manquant.' }); return; }
      const claim = !!(req.query && (req.query.claim === '1' || req.query.claim === 'true'));

      const points = parseInt((await kv(['GET', `ref:${ref}:points`])) || '0', 10);
      const claimed = parseInt((await kv(['GET', `ref:${ref}:claimed`])) || '0', 10);
      const newlyClaimed = Math.max(0, points - claimed);
      if (claim && newlyClaimed > 0) {
        await kv(['SET', `ref:${ref}:claimed`, String(points)]);
      }
      const rawEvents = (await kv(['LRANGE', `ref:${ref}:events`, '0', '-1'])) || [];
      const events = rawEvents.map(e => { try { return JSON.parse(e); } catch (_) { return null; } }).filter(Boolean).reverse();

      res.status(200).json({
        ok: true,
        total: events.length,
        successful: events.length,
        points,
        pending: newlyClaimed,
        newlyClaimed: claim ? newlyClaimed : 0,
        events
      });
      return;
    }

    res.status(405).json({ error: 'Méthode non autorisée.' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur du registre de parrainage.' });
  }
};
