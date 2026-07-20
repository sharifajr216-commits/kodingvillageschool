// Fonction serverless Vercel — proxy SÉCURISÉ pour la réservation du cours d'essai.
//
// Envoi d'e-mail via Resend (https://resend.com) — autorisé côté serveur en plan gratuit,
// contrairement à Web3Forms qui exige le plan Pro pour les appels serveur.
// La clé API reste 100 % CÔTÉ SERVEUR : jamais exposée au navigateur.
//
// Variables d'environnement (Vercel → Settings → Environment Variables, + .env en local) :
//   RESEND_API_KEY      (obligatoire)  clé « re_… » créée sur https://resend.com/api-keys
//   BOOKING_TO_EMAIL    (optionnel)    boîte qui reçoit les leads. Défaut : info@kodingvillageschool.com
//   BOOKING_FROM_EMAIL  (optionnel)    expéditeur. DOIT être sur un domaine vérifié dans Resend.
//                                      Défaut : onboarding@resend.dev (test — n'envoie qu'à ta propre adresse Resend).
//
// Flux : index.html (APP.submitBooking) → POST /api/booking → api.resend.com
//
// Réponses :
//   200 { ok:true,  success:true }                 → e-mail(s) envoyé(s)
//   400 { ok:false, error:'invalid', message }     → validation échouée
//   405 { ok:false, error:'method_not_allowed' }   → autre chose qu'un POST
//   500 { ok:false, error:'not_configured' }       → RESEND_API_KEY absente côté serveur
//   502 { ok:false, error:'send_failed', message } → Resend a refusé / réseau

const B = require('./_brand');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.BOOKING_TO_EMAIL || B.CONTACT_EMAIL;
const FROM_EMAIL = process.env.BOOKING_FROM_EMAIL || 'onboarding@resend.dev';

const clean = (s, max = 200) => String(s == null ? '' : s).trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
// Échappe le HTML pour éviter toute injection dans le corps des e-mails.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function sendEmail(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.id) {
    throw new Error((data && data.message) || `Resend HTTP ${r.status}`);
  }
  return data.id;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!RESEND_API_KEY) {
    res.status(500).json({ ok: false, error: 'not_configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  // Honeypot anti-spam : champ invisible jamais rempli par un humain.
  // Faux succès renvoyé pour ne pas informer le bot du filtrage.
  if (body.botcheck) { res.status(200).json({ ok: true, success: true }); return; }

  const f = {
    parentFirst: clean(body.parentFirst, 60), parentLast: clean(body.parentLast, 60),
    childFirst: clean(body.childFirst, 60),   childLast: clean(body.childLast, 60),
    pronoun: clean(body.pronoun, 40),         email: clean(body.email, 120),
    phone: clean(body.phone, 40),             course: clean(body.course, 80),
    slot: clean(body.slot, 80)
  };

  const required = ['parentFirst', 'parentLast', 'childFirst', 'childLast', 'pronoun', 'email', 'phone'];
  if (required.some(k => !f[k]) || !isEmail(f.email)) {
    res.status(400).json({ ok: false, error: 'invalid', message: 'Champs obligatoires manquants ou e-mail invalide.' });
    return;
  }

  // 1) E-mail principal : le lead envoyé à l'école (obligatoire — son échec = échec global).
  const leadHtml = `
    <h2 style="margin:0 0 12px">Nouvelle réservation d'essai</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
      <tr><td><b>Parent</b></td><td>${esc(f.parentFirst)} ${esc(f.parentLast)}</td></tr>
      <tr><td><b>Enfant</b></td><td>${esc(f.childFirst)} ${esc(f.childLast)}</td></tr>
      <tr><td><b>Pronom de l'enfant</b></td><td>${esc(f.pronoun)}</td></tr>
      <tr><td><b>E-mail</b></td><td>${esc(f.email)}</td></tr>
      <tr><td><b>Téléphone</b></td><td>${esc(f.phone)}</td></tr>
      <tr><td><b>Cours</b></td><td>${esc(f.course)}</td></tr>
      <tr><td><b>Date &amp; heure</b></td><td>${esc(f.slot)}</td></tr>
    </table>`;

  try {
    await sendEmail({
      from: `KodingvillageSchool · Réservation <${FROM_EMAIL}>`,
      to: [TO_EMAIL],
      reply_to: f.email,
      subject: `Nouvelle inscription essai — ${f.course} (${f.childFirst} ${f.childLast})`,
      html: leadHtml
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'send_failed', message: String(e.message || 'Resend error') });
    return;
  }

  // 2) Accusé de réception au parent (best-effort : n'échoue PAS la requête si Resend refuse,
  //    par ex. tant que le domaine d'envoi n'est pas vérifié → destinataire externe interdit).
  try {
    await sendEmail({
      from: `KodingvillageSchool <${FROM_EMAIL}>`,
      to: [f.email],
      reply_to: TO_EMAIL,
      subject: `Ta réservation d'essai est confirmée 🎉`,
      html: `
        <p style="font-family:Arial,sans-serif;font-size:15px">Bonjour ${esc(f.parentFirst)},</p>
        <p style="font-family:Arial,sans-serif;font-size:15px">
          Le cours d'essai <b>GRATUIT</b> de <b>${esc(f.course)}</b> pour <b>${esc(f.childFirst)}</b>
          est bien réservé pour <b>${esc(f.slot)}</b>. Un mentor KodingvillageSchool te contactera très vite. 📩
        </p>
        ${B.emailFooter()}`
    });
  } catch (e) {
    // On journalise mais on ne bloque pas : le lead principal est déjà parti.
    console.warn('[booking] accusé de réception au parent non envoyé:', e.message);
  }

  res.status(200).json({ ok: true, success: true });
};
