// Fonction serverless Vercel — crée une session Stripe Checkout (paiement hébergé).
// Sécurité : la clé secrète Stripe ne vit QUE côté serveur (variable d'environnement
// STRIPE_SECRET_KEY sur Vercel). Aucune donnée bancaire ne transite par notre code.
//
// Les montants/forfaits sont définis ICI (côté serveur) — jamais envoyés par le client —
// pour empêcher toute manipulation du prix depuis le navigateur.

// Devise Stripe (code ISO minuscule). Facturation en DOLLARS AMÉRICAINS.
// Surchargeable par la variable d'environnement STRIPE_CURRENCY ; c'est le SEUL
// endroit à changer côté serveur.
const CURRENCY = process.env.STRIPE_CURRENCY || 'usd';

// ⚠️ Montants en CENTIMES (USD). Doivent rester alignés avec CREDIT_PLANS dans
// index.html — mais c'est CE fichier qui fait foi sur ce qui est débité.
const PLANS = {
  '1':  { sessions: 1,  amount: 2200,  label: 'Session à l’unité' },       //  22 $ → 22,00 $/session
  '10': { sessions: 10, amount: 21500, label: 'Forfait 10 sessions' },     // 215 $ → 21,50 $/session
  '20': { sessions: 20, amount: 42000, label: 'Forfait 20 sessions' },     // 420 $ → 21,00 $/session
  '40': { sessions: 40, amount: 80000, label: 'Forfait 40 sessions' }      // 800 $ → 20,00 $/session
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(500).json({ error: 'Stripe non configuré (STRIPE_SECRET_KEY manquante).' });
    return;
  }

  // Corps de requête (Vercel le parse en objet, mais on gère aussi le cas string)
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const planId = String((body && body.plan) || '');
  const plan = PLANS[planId];
  if (!plan) {
    res.status(400).json({ error: 'Forfait invalide.' });
    return;
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('locale', 'fr');
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', CURRENCY);
  params.append('line_items[0][price_data][unit_amount]', String(plan.amount));
  params.append('line_items[0][price_data][product_data][name]', `${plan.label} — KodingvillageSchool`);
  params.append('line_items[0][price_data][product_data][description]', `${plan.sessions} session${plan.sessions > 1 ? 's' : ''} de 1h30 en cours particulier 1:1`);
  params.append('metadata[plan]', planId);
  params.append('metadata[sessions]', String(plan.sessions));
  params.append('success_url', `${origin}/?payment=success&plan=${planId}&session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${origin}/?payment=cancel`);

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: (data.error && data.error.message) || 'Erreur Stripe.' });
      return;
    }
    res.status(200).json({ url: data.url, id: data.id });
  } catch (e) {
    res.status(500).json({ error: 'Impossible de contacter Stripe.' });
  }
};
