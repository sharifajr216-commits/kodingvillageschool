// Constantes de marque + pied de page partagé pour TOUS les e-mails sortants.
// Un seul endroit à modifier quand un contact change (e-mail, téléphone, WhatsApp).
//
// Utilisé par : api/booking.js, api/admin.js, api/reminders.js

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'info@kodingvillageschool.com';
// Numéro au format international SANS + ni espaces (requis par wa.me)
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '16044992735';
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_NUMBER}`;
// Affichage lisible du même numéro
const PHONE_DISPLAY = process.env.PHONE_DISPLAY || '+1 604 499 2735';
const BRAND = 'KodingvillageSchool';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://kodingvillageschool.com';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Pied de page HTML commun à tous les e-mails.
function emailFooter() {
  return `
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
    <p style="font-family:Arial,sans-serif;font-size:13px;color:#666;line-height:1.6;margin:0">
      — L'équipe ${BRAND}<br>
      <a href="mailto:${esc(CONTACT_EMAIL)}" style="color:#4F46E5">${esc(CONTACT_EMAIL)}</a>
      &nbsp;·&nbsp;
      <a href="${esc(WHATSAPP_LINK)}" style="color:#25D366">WhatsApp ${esc(PHONE_DISPLAY)}</a>
    </p>`;
}

module.exports = {
  CONTACT_EMAIL, WHATSAPP_NUMBER, WHATSAPP_LINK, PHONE_DISPLAY,
  BRAND, PUBLIC_URL, esc, emailFooter
};
