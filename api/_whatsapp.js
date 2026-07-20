// Bibliothèque PARTAGÉE — envoi WhatsApp via l'API Meta Cloud (WhatsApp Business).
//
// ⚠️ INACTIF PAR DÉFAUT. Sans les variables d'environnement ci-dessous, `sendTemplate()`
//    renvoie { skipped:true } sans rien envoyer. Aucun faux succès, aucun envoi simulé.
//
// POURQUOI UN « TEMPLATE » ET PAS UN TEXTE LIBRE :
//   Meta n'autorise un message à l'initiative de l'entreprise que via un MODÈLE
//   pré-approuvé, sauf dans les 24 h qui suivent un message du client. Un rappel de
//   cours tombe presque toujours hors de cette fenêtre → template obligatoire.
//
// MISE EN SERVICE (une seule fois) :
//   1. Créer un compte WhatsApp Business + une app sur https://developers.facebook.com
//   2. Vérifier le numéro d'envoi → relever le « Phone Number ID »
//   3. Créer un modèle (catégorie UTILITY) et le faire approuver par Meta.
//      Exemple de corps, avec 3 variables :
//        « Rappel : le cours {{1}} de {{2}} commence dans 1 heure ({{3}}). À tout de suite ! »
//   4. Générer un token d'accès permanent (System User token)
//   5. Renseigner les variables d'environnement :
//        WHATSAPP_PHONE_NUMBER_ID   ex: 123456789012345
//        WHATSAPP_ACCESS_TOKEN      token permanent
//        WHATSAPP_TEMPLATE_NAME     ex: rappel_cours_1h   (défaut ci-dessous)
//        WHATSAPP_TEMPLATE_LANG     ex: fr               (défaut ci-dessous)

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'rappel_cours_1h';
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'fr';
const GRAPH_VERSION = 'v21.0';

const configured = () => !!(PHONE_NUMBER_ID && ACCESS_TOKEN);

// Meta attend un numéro en format international SANS +, espaces ni tirets.
function normalizeNumber(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// Envoie un message basé sur un modèle approuvé.
//   to        : numéro du destinataire (tout format, normalisé ici)
//   variables : valeurs des {{1}}, {{2}}… dans l'ordre
// Retour : { sent:true, id } | { skipped:true, reason } | lève une erreur si Meta refuse
async function sendTemplate(to, variables = []) {
  if (!configured()) return { skipped: true, reason: 'not_configured' };

  const num = normalizeNumber(to);
  if (!num) return { skipped: true, reason: 'invalid_number' };

  const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: num,
      type: 'template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: TEMPLATE_LANG },
        components: variables.length
          ? [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v) })) }]
          : []
      }
    })
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d && d.error && d.error.message) || `WhatsApp HTTP ${r.status}`;
    throw new Error(msg);
  }
  return { sent: true, id: (d.messages && d.messages[0] && d.messages[0].id) || null };
}

module.exports = { configured, sendTemplate, normalizeNumber, TEMPLATE_NAME };
