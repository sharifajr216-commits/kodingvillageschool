# Messagerie enseignant ↔ famille — conception

**Date :** 2026-07-21
**État :** validé, prêt pour le plan d'implémentation
**Branche de la spec :** `spec/messagerie-prof-famille`

## Contexte

L'espace enseignant affichait un panneau « Messages récents » entièrement simulé :
trois messages de parents fictifs et un bouton « Nouveau message » qui ne produisait
qu'une notification « bientôt disponible ». Ce panneau a été **supprimé** le 2026-07-21
avec le reste des données simulées de l'écran prof, et remplacé par « Rattrapages à
valider ».

Il n'existe donc aujourd'hui **aucune messagerie** dans le produit. Ce document conçoit
la première, à partir de zéro.

Le besoin est établi : les familles n'ont aucun canal pour joindre l'enseignant depuis
la plateforme. Leur seul recours est WhatsApp, hors du produit et hors de toute
supervision de l'école.

## Décisions

Quatre décisions ont été arrêtées avec le porteur du projet avant conception.

| Question | Décision | Écartée |
|---|---|---|
| Qui échange ? | Enseignant ↔ famille d'un élève | Prof↔admin ; annonces sens unique ; tous↔tous |
| Où lit la famille ? | Compte élève existant + alerte e-mail | Tout par e-mail ; comptes parents dédiés |
| Supervision | L'admin lit tout, et c'est annoncé aux participants | Strictement privé ; déverrouillage sur incident |
| Périmètre v1 | Famille qui initie, alerte groupée, accusé de lecture | — |

**Pièces jointes : reportées en v1.1.** Retenues au départ, puis sorties du périmètre
après mise en évidence de leur coût réel — c'est le seul élément qui impose un service
de stockage externe (inexistant dans le projet), une facture, et une surface de
protection de l'enfance nouvelle (téléversement par des mineurs, fichiers servis depuis
des URL publiques quoique imprévisibles). Elles méritent leur propre décision, pas
d'être noyées dans un lot.

**Contrainte d'architecture à préserver :** le projet n'a **aucune dépendance npm** —
pas de `package.json`, pas de lockfile, pas d'étape de build. Les fonctions serverless
n'utilisent que `crypto` et le `fetch` global. Aucune partie de cette conception n'y
déroge.

## Architecture

Trois unités, une responsabilité chacune.

| Fichier | Rôle | Dépend de |
|---|---|---|
| `api/_messages.js` | Modèle KV : fils, messages, non-lus, règle de groupement | `_auth` (KV, identifiants), `_schedule` (droit d'ouverture) |
| `api/messages.js` | Point d'entrée HTTP : authentification, routage des actions | `_auth`, `_messages`, `_notify` |
| `api/_notify.js` | Ajout de `notifyNewMessage()`, aux côtés des e-mails de rattrapage | `_auth`, `_brand`, `_mail` |

Le front reprend les 12 règles CSS `.tch-msg*` restées orphelines dans `style.css`
après la suppression de l'ancien panneau.

## Modèle de données

### Clés KV

```
thread:<tid>                 JSON du fil
thread:<tid>:msgs            ZSET { score: epoch_ms, member: messageId }
msg:<mid>                    JSON du message
threads:teacher:<username>   ZSET { score: lastMessageAt } → boîte de l'enseignant
threads:student:<username>   ZSET { score: lastMessageAt } → boîte de la famille
threads:all                  ZSET { score: lastMessageAt } → supervision admin
```

### Identifiant de fil

Déterministe : `th_<teacherUsername>|<studentUsername>`, par exemple
`th_blaise|mohamedjr`.

Deux bénéfices : impossible de créer deux fils pour le même binôme, et le fil se
retrouve sans consulter le moindre index.

Le séparateur est `|` parce que `normUsername` (dans `api/_auth.js`) n'autorise que
`a-z0-9._-`. Un séparateur `__` serait ambigu : un identifiant contenant lui-même un
souligné rendrait le découpage indécidable.

### Fil

```js
{
  id: 'th_blaise|mohamedjr',
  teacherUsername: 'blaise',  teacherName: 'Blaise Mentor',
  studentUsername: 'mohamedjr', studentName: 'Mohamed Junior',
  createdAt:     '2026-07-21T18:00:00.000Z',
  lastMessageAt: '2026-07-21T18:04:00.000Z',
  lastFrom:      'teacher' | 'student',
  lastSnippet:   'Bonjour, à propos du cours de…',   // 140 caractères max
  unread:     { teacher: 0, student: 2 },
  lastReadAt: { teacher: '2026-07-21T18:04:00.000Z', student: null },
  alerted:    { teacher: null, student: '2026-07-21T18:04:03.000Z' }
}
```

Ces trois derniers champs suffisent à couvrir **l'accusé de lecture et le groupement
des alertes** sans structure supplémentaire.

Les noms sont dénormalisés (`teacherName`, `studentName`) pour afficher une liste de
fils sans relire chaque compte — même choix que `teacherName` sur les séances.

### Message

```js
{
  id: 'msg_a1b2c3d4',
  threadId: 'th_blaise|mohamedjr',
  fromRole: 'teacher' | 'student',
  fromUsername: 'blaise',
  fromName: 'Blaise Mentor',
  body: '…',                        // 2000 caractères max
  sentAt: '2026-07-21T18:04:00.000Z'
}
```

## Droits d'accès

Le droit d'échanger se **déduit des séances**, sans table de permissions à maintenir :
une famille peut ouvrir un fil avec un enseignant qui figure sur au moins une de ses
séances, et réciproquement.

**Une fois le fil ouvert, il le reste.** Seule la *création* exige une séance commune.
Sans cette nuance, le canal se fermerait pendant les vacances ou à l'échéance d'un
cycle de 12 semaines — précisément le moment où une famille écrit pour organiser la
suite.

L'identité vient toujours du **jeton signé** (`payload.sub`, `payload.role`), jamais du
corps de la requête, comme sur `my-sessions` et `session-action`.

| Rôle | Lister | Lire un fil | Écrire | Marquer lu |
|---|---|---|---|---|
| Enseignant | ses fils | les siens | oui | oui |
| Élève | ses fils | les siens | oui | oui |
| Admin | tous | tous | **non** | **non** |

L'admin est en lecture seule par construction : sa consultation ne doit pas faire
croire à l'enseignant que la famille a ouvert le message.

Chaque fil affiche en permanence, aux deux participants, une mention du type
« L'équipe pédagogique peut consulter cette conversation ». Une supervision non
annoncée serait déloyale envers la famille comme envers l'enseignant.

## Points d'entrée HTTP

Un seul fichier routé, `api/messages.js`, sur le modèle de `api/admin.js`.

```
POST { action:'threads.list' }
  → { ok, threads:[ { id, interlocuteur, lastSnippet, lastMessageAt, unread } ] }

POST { action:'thread.open', threadId, before? }
  → { ok, thread, messages:[…] }
  Marque le fil lu pour l'appelant — sauf si l'appelant est admin.
  L'état « Lu » se déduit de `thread.lastReadAt[autre]` : aucun champ dédié.

POST { action:'message.send', threadId | to, body }
  → { ok, message, notified }
  `to` = identifiant de l'interlocuteur, pour un premier message (crée le fil).
  Son rôle est déduit de celui de l'appelant : un enseignant qui écrit désigne un
  élève, un élève désigne un enseignant. Aucun rôle n'est accepté depuis le corps.

POST { action:'contacts.list' }
  → { ok, contacts:[…] }
  Interlocuteurs autorisés, déduits des séances — alimente le sélecteur
  « Nouveau message ».
```

Pagination : 50 fils, 50 messages par page, `before` remontant l'historique.

## Flux

### Envoi

1. Jeton signé → rôle et identifiant.
2. Résolution du fil ; création si absent, après contrôle de séance commune.
3. Écriture de `msg:<mid>`, ajout au ZSET du fil.
4. Mise à jour du fil : `lastMessageAt`, `lastSnippet`, `lastFrom`, `unread[destinataire]++`.
5. Ajout aux trois index ZSET avec le nouveau score.
6. Alerte e-mail — best-effort.
7. Réponse `{ ok, message, notified }`.

**L'ordre est normatif : le message est persisté avant toute tentative d'envoi
d'e-mail**, et un échec Resend ne fait jamais échouer la requête. Un message de parent
perdu parce qu'un service tiers a hoqueté est une réclamation garantie. Même principe
que le flux de rattrapage.

### Alerte groupée

Condition d'envoi :

```
alerted[dest] est vide  OU  alerted[dest] <= lastReadAt[dest]
```

Une alerte part, puis plus rien tant que le destinataire n'a pas ouvert le fil. Dès
qu'il lit, le mécanisme se réarme. Trois messages d'affilée d'un enseignant pressé
produisent **un** e-mail.

Quand le destinataire est une famille, l'e-mail **nomme l'enfant explicitement**
(« Message de Blaise Mentor au sujet de Mohamed Junior ») : l'e-mail de contact est
partageable par une fratrie, et un parent de deux élèves doit savoir lequel est
concerné.

### Accusé de lecture

`thread.open` met `unread[appelant] = 0` et `lastReadAt[appelant] = maintenant`.
L'expéditeur voit « Lu » sur un message dès que `lastReadAt[autre]` dépasse son
`sentAt`.

### Rafraîchissement

Pas de temps réel : ni websockets ni SSE ne sont possibles sur une SPA statique servie
par des fonctions serverless. La messagerie se greffe sur le sondage de 120 s déjà en
place pour les séances (`_tchPollTimer`, `_sessionsPollTimer`), avec une pastille de
non-lus. C'est la granularité juste pour une messagerie scolaire.

## Gestion des erreurs

| Cas | Réponse |
|---|---|
| Corps vide, ou > 2000 caractères | `400 invalid_body` |
| Fil inexistant et aucune séance commune | `403 not_allowed` |
| Fil existant dont l'appelant n'est pas participant | `403 not_a_participant` |
| Admin tentant d'écrire ou de marquer lu | `403 read_only` |
| Plus de 20 messages en 5 minutes pour un même auteur | `429 too_many` |
| Resend indisponible | `200` avec `notified:false`, message conservé |
| Jeton absent ou invalide | `401 unauthorized` |

Le garde-fou de fréquence s'appuie sur un compteur KV à durée de vie courte
(`rate:msg:<username>`, expiration 300 s). Sans lui, un enfant qui découvre le bouton
peut écrire trois cents messages en deux minutes : le groupement d'alertes plafonne
les e-mails, pas les écritures en base.

## Interface

**Enseignant** — un onglet « Messages » à côté de « Vue d'ensemble », « Mes élèves » et
« Planning », avec pastille de non-lus. Liste des fils à gauche, conversation à droite.
Bouton « Nouveau message » alimenté par `contacts.list`.

**Élève / famille** — une entrée « Messages » dans la barre latérale du tableau de bord,
même structure. Les fils sont ceux de l'élève connecté.

**Admin** — une carte « Conversations » dans le panneau d'administration, en lecture
seule, listant tous les fils par activité décroissante.

## Tests

Même harnais que le chantier planning : vrais handlers montés sur un KV en mémoire,
Resend intercepté, puis pilotage navigateur.

Cas qui doivent passer :

- un élève ne peut ni lister ni ouvrir le fil d'un autre élève ;
- un enseignant ne peut ouvrir que les fils de ses propres élèves ;
- le deuxième message consécutif n'envoie pas de second e-mail ; après lecture, le
  troisième réarme l'alerte ;
- l'admin lit un fil sans modifier `unread` ni `lastReadAt` ;
- création de fil refusée sans séance commune ; fil déjà ouvert accessible même sans
  séance à venir ;
- l'e-mail destiné à une famille nomme bien l'enfant concerné ;
- une panne Resend laisse le message en base et renvoie `notified:false` ;
- le garde-fou de fréquence renvoie `429` au 21ᵉ message.

## Hors périmètre

- **Pièces jointes** — v1.1, décision séparée (stockage, facture, protection de l'enfance).
- **Comptes parents dédiés** — écartés : la famille passe par le compte élève.
- **Notifications WhatsApp** — Meta impose un modèle pré-approuvé hors fenêtre de 24 h
  (voir `api/_whatsapp.js`), ce qui convient à un rappel de cours mais pas à un message
  libre.
- **Temps réel** — impossible sans serveur persistant ; sondage assumé.
- **Modération automatique du contenu** — l'admin lit tout, c'est le mécanisme retenu.
