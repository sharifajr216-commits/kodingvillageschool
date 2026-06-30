# Intégration Stripe — Guide de configuration

Paiement réel des crédits de cours via **Stripe Checkout** (page de paiement hébergée par
Stripe, 100 % conforme PCI : cartes, Apple Pay, Google Pay, 3D Secure). Le backend est
constitué de **deux fonctions serverless Vercel** dans le dossier `api/`.

> Tant que les clés Stripe ne sont pas configurées, le bouton « Acheter » bascule
> automatiquement sur le **panneau de démonstration** (aucun paiement réel). Une fois les
> clés en place et le projet redéployé, le vrai paiement Stripe s'active sans autre changement.

## Architecture

| Élément | Rôle |
|---|---|
| `api/create-checkout-session.js` | Crée la session de paiement Stripe et renvoie l'URL de redirection. Les **montants des forfaits sont définis côté serveur** (anti-fraude). |
| `api/verify-session.js` | Vérifie côté serveur qu'une session a bien été **payée** avant de créditer le compte. |
| Front (`index.html`) | `buyCredits()` appelle l'API et redirige vers Stripe ; au retour, `_handleStripeReturn()` vérifie puis crédite et affiche l'écran de succès + confettis. |

## Étapes de configuration (≈ 5 min)

### 1. Créer un compte Stripe
- Inscris-toi sur https://stripe.com et accède au **Dashboard**.

### 2. Récupérer la clé secrète
- Dashboard → **Développeurs → Clés API**.
- Commence en **mode Test** : copie la clé secrète `sk_test_...`.

### 3. Ajouter la clé dans Vercel
- Vercel → ton projet → **Settings → Environment Variables**.
- Ajoute :
  - **Name** : `STRIPE_SECRET_KEY`
  - **Value** : `sk_test_...` (puis `sk_live_...` quand tu passes en production)
  - **Environments** : Production (et Preview/Development si besoin).
- **Redéploie** le projet (les variables ne sont prises en compte qu'au déploiement).

### 4. Tester
- Ouvre le site déployé → Espace Parent → **Facturation & Crédits → Recharger des cours**.
- Choisis un forfait → **Acheter** → tu es redirigé vers Stripe Checkout.
- Carte de test Stripe : `4242 4242 4242 4242`, date future (ex. `12/30`), CVC `123`.
- Après paiement, retour automatique sur le site → vérification → crédits ajoutés + confettis.

### 5. Passer en production (paiements réels)
- Active ton compte Stripe (informations légales/bancaires).
- Remplace `STRIPE_SECRET_KEY` par la clé **live** `sk_live_...` dans Vercel, puis redéploie.

## Forfaits (modifiables dans `api/create-checkout-session.js`)

| Plan | Crédits | Montant |
|---|---|---|
| `10` | 10 sessions | 89,00 € |
| `20` | 20 sessions | 159,00 € |
| `50` | 50 sessions | 349,00 € |

Pour changer un prix : modifie `amount` (en **centimes**) dans l'objet `PLANS` de
`api/create-checkout-session.js`, et le texte du forfait côté front (`CREDIT_PLANS` dans `index.html`).

## Limites connues / pistes d'amélioration

- **Fulfillment** : les crédits sont stockés dans le `localStorage` du navigateur (modèle
  actuel de l'app). Le crédit se fait donc **au retour** de Stripe, après vérification
  serveur de la session (`payment_status === 'paid'`). Pour un système multi-appareils
  fiable, il faudrait une **vraie base de données utilisateur** + un **webhook Stripe**
  (`checkout.session.completed`) qui crédite le compte côté serveur.
- **Webhook recommandé en production** : crée un endpoint `api/stripe-webhook.js`, configure-le
  dans Dashboard → Développeurs → Webhooks, et vérifie la signature avec `STRIPE_WEBHOOK_SECRET`.
  (Non inclus ici car il nécessite la base de données utilisateur évoquée ci-dessus.)
- **Runtime** : les fonctions utilisent `fetch` natif (Node 18+, runtime Vercel par défaut) —
  aucune dépendance npm à installer.
