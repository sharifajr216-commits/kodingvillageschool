# Parrainage cross-utilisateurs — Configuration backend (Vercel KV)

Le parrainage fonctionne désormais **entre utilisateurs et appareils différents** : quand un
filleul s'inscrit via le lien d'un parent (sur n'importe quel appareil), le registre du parent
est crédité **côté serveur**. Le parent récupère ses récompenses depuis son tableau de bord.

> Sans backend configuré, l'application bascule automatiquement sur la **simulation locale**
> (récompense dans le même navigateur) — rien n'est cassé avant la configuration.

## Architecture

| Élément | Rôle |
|---|---|
| `api/referral.js` | Registre serveur. `POST` (filleul) enregistre + crédite le code parrain ; `GET ?ref=…&claim=1` (parrain) renvoie les stats et réclame les récompenses en attente. |
| Front (`index.html`) | À l'inscription via lien → `POST /api/referral`. À l'ouverture de la page Parrainage → `GET /api/referral` (réclame et crédite). |
| Stockage | **Vercel KV (Upstash Redis)** via API REST — aucune dépendance npm. |

Anti-abus inclus : un même e-mail ne peut créditer un code qu'**une seule fois** (déduplication).

## Étapes (≈ 3 min)

### 1. Créer une base Vercel KV
- Vercel → ton projet → onglet **Storage** → **Create Database** → **KV** (Upstash Redis).
- Connecte-la au projet : Vercel injecte automatiquement les variables d'environnement
  `KV_REST_API_URL` et `KV_REST_API_TOKEN`.

### 2. Redéployer
- Redéploie le projet pour que les fonctions `api/` voient les variables.

### 3. Tester le flux cross-utilisateurs
1. Connecte-toi en tant que **parent A**, va dans **Parrainage**, copie ton lien (`…/signup?ref=Pxxxx`).
2. Ouvre ce lien dans **un autre navigateur / appareil / fenêtre privée** (= filleul B).
3. Le filleul crée un compte gratuit → le serveur crédite le code de A.
4. Reviens sur l'appareil du **parent A** → ouvre la page **Parrainage** → tes récompenses en
   attente sont automatiquement **créditées** (+1 crédit par filleul) et la liste se met à jour.

## Notes / limites

- **Identité du parrain** : le code est déterministe à partir de l'e-mail du compte
  (`P` + hash) → stable d'un appareil à l'autre **pour un même compte**. Comme les comptes sont
  aujourd'hui stockés en `localStorage` (par navigateur), pour profiter pleinement du
  cross-device il faudrait aussi migrer l'**authentification** côté serveur (non inclus ici).
- **Récompense** : 1 crédit de cours par parrainage réussi. Modifiable dans `api/referral.js`
  (montant des points) et `_refSyncFromBackend` (`index.html`).
- **Variables d'environnement** : `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` sont aussi
  acceptées (si tu utilises Upstash directement plutôt que l'intégration Vercel KV).
