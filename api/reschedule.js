// Fonction serverless Vercel — VALIDATION D'UNE DEMANDE DE RATTRAPAGE.
//
// Point d'atterrissage des boutons « Valider / Refuser » de l'e-mail envoyé par
// api/my-sessions.js. Renvoie une PAGE HTML autonome (aucun login requis) :
// le professeur ou l'admin décide depuis son téléphone, en deux tapes.
//
//   GET  /api/reschedule?t=<jeton>&d=approve|refuse  → page de confirmation
//   POST /api/reschedule  (formulaire : t, d)        → applique la décision
//
// 🔒 AUTORISATION : le jeton est un HMAC signé par le serveur (A.signToken), qui
//    porte { purpose:'resched', rid, actor } et expire au bout de 30 jours. Il
//    n'ouvre l'accès qu'à CETTE demande précise — il ne donne aucun autre droit.
//
// ⚠️ POURQUOI UNE CONFIRMATION EN DEUX TEMPS ?
//    Les antivirus, passerelles de sécurité et aperçus de liens des clients mail
//    VISITENT les URL contenues dans un message. Si le GET appliquait directement
//    la décision, un simple scan automatique validerait des rattrapages à la place
//    du professeur. Le GET ne fait donc que MONTRER ; seul le POST (déclenché par
//    un vrai clic humain sur le bouton) écrit en base.

const A = require('./_auth');
const S = require('./_schedule');
const B = require('./_brand');
const M = require('./_mail');
const N = require('./_notify');

const ACTOR_LABEL = N.ACTOR_LABEL;

// ── Gabarit de page (autonome : ni CSS externe, ni JS) ──────────────────────
function page(title, bodyHtml, accent) {
  const color = accent || '#4F46E5';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${B.esc(title)} — ${B.esc(B.BRAND)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:28px 16px;background:#F5F6FA;color:#1F2937;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;line-height:1.6}
  .card{max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:30px 26px;
        box-shadow:0 8px 30px rgba(17,24,39,.08)}
  .brand{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:${color};font-weight:700;margin:0 0 14px}
  h1{font-size:1.35rem;margin:0 0 6px;line-height:1.3}
  p{margin:0 0 12px;font-size:15px}
  .muted{color:#6B7280;font-size:13.5px}
  table{width:100%;border-collapse:collapse;margin:18px 0;font-size:14.5px}
  td{padding:8px 10px;border-bottom:1px solid #F1F2F6;vertical-align:top}
  td.k{width:132px;color:#6B7280;font-weight:600}
  .old{color:#991B1B;text-decoration:line-through}
  .new{color:#065F46;font-weight:700}
  .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
  button{flex:1 1 190px;padding:14px 18px;border:0;border-radius:10px;font-size:15px;font-weight:700;
         cursor:pointer;font-family:inherit;color:#fff}
  .ok{background:#059669}.no{background:#DC2626}
  form{margin:0;display:contents}
  .banner{padding:14px 16px;border-radius:10px;font-weight:600;margin:0 0 18px}
  .b-ok{background:#ECFDF5;color:#065F46}.b-no{background:#FEF2F2;color:#991B1B}.b-i{background:#EEF2FF;color:#3730A3}
  .foot{margin-top:24px;padding-top:16px;border-top:1px solid #F1F2F6;font-size:13px;color:#6B7280}
  a{color:${color}}
</style>
</head>
<body><div class="card">
  <p class="brand">${B.esc(B.BRAND)}</p>
  ${bodyHtml}
  <div class="foot">Besoin d'aide ? <a href="mailto:${B.esc(B.CONTACT_EMAIL)}">${B.esc(B.CONTACT_EMAIL)}</a></div>
</div></body></html>`;
}

function html(res, code, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Page nominative liée à un jeton : ne doit jamais être mise en cache par un proxy.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(code).send(body);
}

const errorPage = (res, code, titre, msg) => html(res, code, page(titre, `
  <div class="banner b-no">${B.esc(titre)}</div>
  <p>${B.esc(msg)}</p>`, '#DC2626'));

// Récapitulatif partagé par la page de confirmation et la page de résultat.
function recapTable(rq) {
  return `<table>
    <tr><td class="k">Élève</td><td>${B.esc(rq.studentName)}</td></tr>
    <tr><td class="k">Cours</td><td>${B.esc(rq.courseLabel)}</td></tr>
    <tr><td class="k">Séance annulée</td><td class="old">${B.esc(M.longDateTime(rq.originalStartsAt))}</td></tr>
    <tr><td class="k">Rattrapage&nbsp;demandé</td><td class="new">${B.esc(M.longDateTime(rq.requestedStartsAt))}</td></tr>
    <tr><td class="k">Durée</td><td>${B.esc(String(rq.durationMin))} minutes</td></tr>
    ${rq.reason ? `<tr><td class="k">Motif</td><td>${B.esc(rq.reason)}</td></tr>` : ''}
  </table>`;
}

// Page déjà tranchée — affichée aussi bien sur un GET tardif que sur un POST
// rejoué (double clic, lien rouvert plus tard).
function alreadyPage(rq) {
  const approuve = rq.state === 'approved';
  return page('Demande déjà traitée', `
    <div class="banner b-i">Cette demande a déjà été traitée.</div>
    <h1>Rattrapage ${approuve ? 'validé' : 'refusé'}</h1>
    <p class="muted">Décision enregistrée le ${B.esc(M.longDateTime(rq.decidedAt))}
      ${rq.decidedBy ? `par ${B.esc(ACTOR_LABEL[rq.decidedBy] || rq.decidedBy)}` : ''}.</p>
    ${recapTable(rq)}
    <p class="muted">Aucune action supplémentaire n'est nécessaire — cliquer à nouveau
      sur le lien ne crée pas de séance en double.</p>`, approuve ? '#059669' : '#DC2626');
}

// Vérifie le jeton et charge la demande. Renvoie { rq, actor } ou null.
async function resolve(token) {
  const p = A.verifyToken(String(token || ''));
  if (!p || p.purpose !== 'resched' || !p.rid) return null;
  const rq = await S.getReschedule(p.rid);
  if (!rq) return null;
  return { rq, actor: p.actor === 'admin' ? 'admin' : 'teacher' };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!A.configured() || !A.kvConfigured()) {
    return errorPage(res, 500, 'Service indisponible',
      "La configuration du serveur est incomplète. Préviens l'administration.");
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch (_) { body = Object.fromEntries(new URLSearchParams(body)); }
  }
  body = body || {};
  const q = req.query || {};
  const token = body.t || q.t || '';
  const decision = String(body.d || q.d || '') === 'refuse' ? 'refuse' : 'approve';

  try {
    const found = await resolve(token);
    if (!found) {
      return errorPage(res, 401, 'Lien invalide ou expiré',
        "Ce lien de validation n'est plus valable (il expire au bout de 30 jours). "
        + "Connecte-toi à l'espace d'administration pour traiter la demande.");
    }
    const { rq, actor } = found;

    if (rq.state !== 'pending') return html(res, 200, alreadyPage(rq));

    // ── GET : on montre, on n'écrit pas (cf. avertissement en tête de fichier) ──
    if (req.method === 'GET') {
      const veutValider = decision === 'approve';
      return html(res, 200, page('Confirmer la décision', `
        <h1>Demande de rattrapage</h1>
        <p class="muted">Adressée à ${B.esc(ACTOR_LABEL[actor])} · en attente de décision</p>
        ${recapTable(rq)}
        <p><b>${veutValider
          ? 'Confirmes-tu la validation de ce créneau ?'
          : 'Confirmes-tu le refus de ce créneau ?'}</b></p>
        <div class="actions">
          <form method="POST" action="/api/reschedule">
            <input type="hidden" name="t" value="${B.esc(token)}">
            <input type="hidden" name="d" value="approve">
            <button class="ok" type="submit">✓ Valider le rattrapage</button>
          </form>
          <form method="POST" action="/api/reschedule">
            <input type="hidden" name="t" value="${B.esc(token)}">
            <input type="hidden" name="d" value="refuse">
            <button class="no" type="submit">✕ Refuser</button>
          </form>
        </div>
        <p class="muted" style="margin-top:18px">En validant, la séance de rattrapage est créée
          automatiquement dans le planning de l'élève et dans le tien, et l'élève en est averti par e-mail.</p>`,
        veutValider ? '#059669' : '#DC2626'));
    }

    // ── POST : décision effective ────────────────────────────────────────────
    const r = await S.decideReschedule(rq.requestId, decision, actor, body.note);
    if (!r.ok) return errorPage(res, 404, 'Demande introuvable', 'Cette demande de rattrapage n\'existe plus.');
    if (r.alreadyDecided) return html(res, 200, alreadyPage(r.request));

    await N.notifyStudentOfDecision(r.request);

    const approuve = r.request.state === 'approved';
    return html(res, 200, page(approuve ? 'Rattrapage validé' : 'Rattrapage refusé', `
      <div class="banner ${approuve ? 'b-ok' : 'b-no'}">
        ${approuve ? '✓ Rattrapage validé — la séance est créée.' : '✕ Rattrapage refusé.'}
      </div>
      <h1>${approuve ? 'C\'est noté, merci !' : 'Décision enregistrée'}</h1>
      ${recapTable(r.request)}
      <p>${approuve
        ? "La séance de rattrapage apparaît dès à présent dans ton planning et dans celui de l'élève. Le rappel automatique partira 1 heure avant."
        : "L'élève vient d'être informé que ce créneau n'a pas été retenu et qu'il doit contacter l'école."}</p>
      <p class="muted">Un e-mail de confirmation vient d'être envoyé à ${B.esc(rq.studentName)}.</p>`,
      approuve ? '#059669' : '#DC2626'));
  } catch (e) {
    console.error('[reschedule]', e.message);
    return errorPage(res, 500, 'Erreur technique',
      "La décision n'a pas pu être enregistrée. Réessaie dans un instant ou passe par l'espace d'administration.");
  }
};
