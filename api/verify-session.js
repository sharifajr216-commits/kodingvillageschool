// Fonction serverless Vercel — vérifie côté serveur qu'une session Checkout a bien été
// payée AVANT que le front crédite le compte. Empêche qu'un visiteur ajoute des crédits
// en falsifiant simplement l'URL de retour (?payment=success&plan=50).

module.exports = async (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(500).json({ error: 'Stripe non configuré.' });
    return;
  }

  const id = (req.query && req.query.session_id) || '';
  if (!id) {
    res.status(400).json({ error: 'session_id manquant.' });
    return;
  }

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(id), {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    const d = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: (d.error && d.error.message) || 'Erreur Stripe.' });
      return;
    }
    res.status(200).json({
      paid: d.payment_status === 'paid',
      plan: (d.metadata && d.metadata.plan) || null,
      sessions: d.metadata && d.metadata.sessions ? Number(d.metadata.sessions) : null
    });
  } catch (e) {
    res.status(500).json({ error: 'Impossible de contacter Stripe.' });
  }
};
