// Bibliothèque PARTAGÉE (préfixe `_` → non routée par Vercel).
// Envoi d'e-mails via Resend + mise en forme des dates dans le fuseau de l'école.
//
// Utilisé par : api/my-sessions.js (notification d'absence / demande de report),
//               api/reschedule.js    (confirmation de la décision)
//
// Variables d'environnement :
//   RESEND_API_KEY      (obligatoire) envoi des e-mails
//   BOOKING_FROM_EMAIL  (optionnel)   expéditeur — voir api/_brand.js
//   REMINDER_TIMEZONE   (optionnel)   fuseau d'affichage. Défaut : America/Toronto
//   REMINDER_TZ_LABEL   (optionnel)   libellé après l'heure. Défaut : HNE

const B = require('./_brand');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Même fuseau que les rappels : les deux familles d'e-mails doivent afficher la
// MÊME heure pour un même cours, sinon parents et profs se contredisent.
const TZ = process.env.REMINDER_TIMEZONE || 'America/Toronto';
const TZ_LABEL = process.env.REMINDER_TZ_LABEL || 'HNE';

const configured = () => !!RESEND_API_KEY;

async function send(payload) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY absente');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error((d && d.message) || `Resend HTTP ${r.status}`);
  return d.id;
}

// Envoi « best-effort » : ne fait jamais échouer l'action métier appelante.
// Une absence enregistrée ne doit pas être perdue parce que Resend a hoqueté.
async function sendSafe(payload, label) {
  try {
    await send(payload);
    return { sent: true };
  } catch (e) {
    console.error(`[mail] échec ${label || ''}:`, e.message);
    return { sent: false, error: String(e.message || 'erreur') };
  }
}

// « mardi 21 juillet 2026, 11 h 00 HNE »
function longDateTime(iso) {
  try {
    const s = new Intl.DateTimeFormat('fr-CA', {
      timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));
    return `${s} ${TZ_LABEL}`;
  } catch (_) {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

// « 11 h 00 HNE »
function clockTime(iso) {
  try {
    const s = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
    return `${s} ${TZ_LABEL}`;
  } catch (_) {
    return new Date(iso).toISOString().slice(11, 16) + ' UTC';
  }
}

// Bouton HTML compatible e-mail (pas de flex, pas de classe CSS : les clients
// mail les ignorent ou les réécrivent — seul le style inline sur <a> est fiable).
function button(href, label, color) {
  return `<a href="${B.esc(href)}" style="display:inline-block;padding:13px 26px;margin:6px 8px 6px 0;`
    + `background:${color};color:#fff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;`
    + `text-decoration:none;border-radius:8px">${B.esc(label)}</a>`;
}

module.exports = { send, sendSafe, configured, longDateTime, clockTime, button, TZ, TZ_LABEL };
