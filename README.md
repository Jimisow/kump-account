# kump-account

Compte joueur **KUMP** partagé entre tous les jeux et applications KUMP :
une seule identité, une progression par jeu, des trophées, un temps de jeu et
des classements — et un profil complet consultable sur kump.fr.

> ⚠️ À ne pas confondre avec les « modules » du KUMP Lab (gestion de stock,
> etc.), qui sont des **démos produit** présentées aux clients. Ceci est une
> **bibliothèque technique** : elle n'a pas d'interface, elle est installée
> comme dépendance par les jeux.

## Le principe

Chaque jeu installe cette bibliothèque et n'écrit **plus une seule ligne de
code Firebase**. C'est ce qui garantit qu'un correctif de sécurité fait ici
profite à tous les jeux d'un coup, sans repasser dans chacun.

```
                    ┌──────────────────┐
   Androgame ────►  │                  │
   Futur jeu 2 ──►  │  kump-account    │ ────►  Firebase KUMP
   Futur jeu 3 ──►  │                  │        (Auth + Firestore)
                    └──────────────────┘              ▲
                                                      │
                              kump.fr /profil ────────┘
```

## Parcours de connexion

Le joueur **n'a jamais à créer de compte pour jouer** :

1. il lance le jeu, joue immédiatement — un compte anonyme est créé
   silencieusement, sa progression est déjà sauvegardée dans le cloud ;
2. le jour où il veut apparaître au classement ou retrouver sa partie sur un
   autre téléphone, le jeu lui propose de rattacher un email
   (`linkWithEmail()`) ;
3. **rien n'est perdu au passage** : le compte garde le même identifiant
   interne, donc toute la progression accumulée en anonyme reste la sienne.

C'est ce qui évite de perdre la moitié des joueurs sur un écran d'inscription
au premier lancement, tout en offrant un vrai compte à ceux qui s'investissent.

## Installation dans un jeu

```bash
npm install github:Jimisow/kump-account
```

```js
import { initKump, ensureSignedIn, loadGameData, saveGameData } from 'kump-account';

initKump({
  firebaseConfig: {
    apiKey: import.meta.env.VITE_KUMP_API_KEY,
    authDomain: import.meta.env.VITE_KUMP_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_KUMP_PROJECT_ID,
    storageBucket: import.meta.env.VITE_KUMP_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_KUMP_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_KUMP_APP_ID,
  },
  gameId: 'androgame',
});
```

`gameId` sert de nom de dossier pour les données du joueur
(`users/{uid}/games/{gameId}`). **Une fois choisi, il ne doit jamais changer** :
ce serait perdre la progression de tous les joueurs de ce jeu.

## L'API

| Fonction | À quoi ça sert |
|---|---|
| `initKump({ firebaseConfig, gameId })` | À appeler une fois au démarrage. |
| `ensureSignedIn()` | Garantit qu'un joueur est connecté (anonyme si besoin). Appelée automatiquement par les autres fonctions. |
| `onUserChanged(cb)` | Prévient à chaque connexion / rattachement / déconnexion. |
| `isGuest()` | `true` tant qu'aucun email n'est rattaché. |
| `linkWithEmail(email, mdp)` | Transforme le compte anonyme en compte permanent, sans rien perdre. |
| `signInWithEmail(email, mdp)` | Connexion à un compte existant (⚠️ abandonne la progression anonyme en cours). |
| `linkWithGoogle()` / `linkWithApple()` | Rattache le compte anonyme à Google/Apple — la progression est conservée. **À utiliser dans un JEU.** |
| `signInWithGoogle()` / `signInWithApple()` | Bascule vers le compte Google/Apple. **À utiliser sur un SITE**, où il n'y a pas de progression anonyme à préserver. |
| `sendPasswordReset(email)` | Email de réinitialisation. |
| `getProfile()` | Pseudo, email, temps de jeu total, date d'inscription, `isAdmin`. |
| `setDisplayName(nom)` | Change le pseudo (3 à 16 caractères). |
| `addPlaytime(ms)` | ⚠️ **Ne fonctionne plus depuis la phase 3** : les règles refusent au client d'écrire `totalPlaytimeMs` et `playtimeMs`. Le temps de jeu est désormais crédité par le serveur, à partir de la durée d'un `submitRun()` ou d'un `submitSession()` qu'il a jugée plausible. Conservée pour un futur jeu sans serveur de validation. |
| `loadGameData()` / `saveGameData(obj)` | Progression du joueur pour CE jeu, forme libre. |
| `unlockTrophy(id)` | ⚠️ **Ne fonctionne plus depuis la phase 3** : les règles refusent au client d'écrire un trophée, c'est le serveur qui les attribue en validant un run. Conservée pour un futur jeu sans serveur de validation. |
| `getUnlockedTrophies()` | Liste des trophées obtenus sur ce jeu. |
| `submitRun(run)` | Envoie une fin de partie au serveur, qui la valide et crédite. Mise en file d'attente locale si le réseau manque. |
| `submitSession({ kind, durationMs, payload })` | Même principe pour un jeu **sans économie** (ni niveau, ni pièce, ni diamant) : Assassins, D-Track. Forme libre, interprétée par un registre propre à chaque jeu côté serveur. Même file d'attente. |
| `flushSessionQueue()` | Renvoie les sessions en attente. À appeler au démarrage du jeu. |
| `pendingSessionCount()` | Nombre de sessions en attente. |
| `flushRunQueue()` | Renvoie les parties en attente. À appeler au démarrage du jeu. |
| `pendingRunCount()` | Nombre de parties en attente. |
| `purchaseFromServer({ kind, itemId })` | Achat validé par le serveur, qui détient les prix. **À préférer à `purchaseGameItem`.** |
| `purchaseGameItem({ itemId, price, ownedField, equippedField })` | ⚠️ **Ne fonctionne plus depuis la phase 3** (le client ne peut plus écrire `coins`), et le PRIX y venait du jeu, donc du client. Conservée pour un futur jeu sans serveur de validation. |
| `submitScore(stats)` | ⚠️ **Ne fonctionne plus depuis la phase 3** : `leaderboards/*` est en écriture fermée, le classement est publié par le serveur en validant un run. Conservée pour un futur jeu sans serveur de validation. |
| `fetchLeaderboard({ sortBy, thenBy, max })` | Top N. |
| `fetchRank({ sortBy, value, ... })` | Rang exact du joueur, par comptage serveur. |

## Validation serveur des parties

Un jeu ne DÉCLARE plus ce qu'il a gagné : il le DEMANDE via `submitRun()`, et
un serveur juge la plausibilité du run contre les données réelles du niveau
avant d'écrire. C'est ce qui rend pièces, progression et diamants
infalsifiables — le client n'ayant plus le droit d'écrire ces champs.

Nécessite `apiBaseUrl` dans `initKump()` (l'URL du serveur de validation).
Sans elle, les parties restent en file d'attente locale sans jamais partir.

**File d'attente** : si le serveur est injoignable, le run est gardé sur
l'appareil et renvoyé au prochain `flushRunQueue()`. Un joueur dans le métro ne
perd donc rien. Un tricheur peut fabriquer de faux runs en attente, mais le
serveur les validera comme les autres — la file n'ouvre aucune faille.

Un run **refusé** par le serveur (trop de pièces, butin hors de portée, niveau
inconnu) est abandonné, jamais réessayé : le renvoyer donnerait le même refus
indéfiniment.

**« Trop tôt » n'est PAS un refus.** Le serveur limite le rythme auquel une
progression peut être créditée (réserve de temps réel côté serveur) et répond
alors `retryable: true`. Un run dans ce cas **retourne en file**, comme si le
réseau avait manqué — dans `submitRun()` comme dans `flushRunQueue()`, qui
s'arrête là et garde la suite. Confondre les deux perdait la progression de
joueurs honnêtes : celui qui meurt deux fois en quelques secondes, ou qui rentre
du métro avec plusieurs parties en attente (voir Androgame > AUDIT.md, SEC-13).
Ne jamais retransformer un refus `retryable` en abandon.

`purchaseFromServer()` suit le même principe pour les achats, sans file : un
achat hors ligne ne peut pas être validé plus tard sans mentir au joueur sur
son solde entre-temps.

## Sessions de jeu — les jeux sans économie

Tous les jeux KUMP ne ressemblent pas à Androgame. Un jeu de dés ou un jeu
social n'a ni niveau, ni pièce, ni diamant : `submitRun()` l'obligerait à
inventer un vocabulaire qui n'est pas le sien. `submitSession()` est la même
idée — le jeu DEMANDE, le serveur décide — avec une charge utile de forme
libre, interprétée par un **registre propre à chaque jeu** côté kump.fr
(`src/lib/game/games/`).

```js
import { submitSession, flushSessionQueue } from 'kump-account';

// au démarrage du jeu
await flushSessionQueue();

// à la fin d'une partie
const result = await submitSession({
  kind: 'solo',
  durationMs: 245_000,
  payload: { grid, rolls, initialSymbol },  // ce que le serveur sait vérifier
});
```

⚠️ **Le niveau de garantie dépend du jeu, et il faut être honnête là-dessus.**
Ce n'est pas parce qu'une donnée passe par le serveur qu'elle est prouvée :

- **D-Track** : la partie est **rejouée** par le serveur. La grille et la
  séquence de dés sont déclarées, mais le score est recalculé et la légalité
  de chaque placement vérifiée. Un score annoncé n'est jamais cru.
- **Assassins** : le résultat d'une nuit est calculé par le navigateur de
  l'Hôte, le serveur ne peut pas le rejouer. Les statistiques y sont
  **déclarées**, bornées seulement par plausibilité. Jamais de récompense
  réelle adossée à ces valeurs.

Comme pour `submitRun()`, un refus `retryable` (réserve de temps réel épuisée)
n'est **pas** un refus : la session retourne en file. Voir `transport.js`, où
cette distinction vit désormais pour les deux portes à la fois.

## Boutique et monnaie

La monnaie est **par jeu** (`coins` dans les donnees du jeu). Elle est creditee
par le SERVEUR a chaque partie validee — un jeu ne s'en attribue jamais.

| Fonction | A quoi ca sert |
|---|---|
| `getShopCatalog()` | Categories, objets, prix, nom de la monnaie. Vient du serveur : le jeu n'ecrit aucun prix. `null` = boutique indisponible (a distinguer d'une boutique vide). |
| `getShopState()` | Solde, objets possedes et objets equipes, deja recoupes avec le catalogue. |
| `buyItem({ kind, itemId })` | Achat. Le serveur applique le prix qu'il detient. |
| `equipItem({ kind, itemId })` | Equipe un objet possede. **Meme appel** que l'achat, sans debit. |

⚠️ **Equiper passe par le serveur.** Les regles Firestore n'autorisent le
client a ecrire que `equippedSkin` et `equippedTrail` (noms herites
d'Androgame) : un jeu neuf ne peut pas ecrire son propre champ d'equipement.

⚠️ **Le solde affiche vient TOUJOURS de la reponse du serveur**, jamais d'un
calcul local (`solde - prix`) : c'est exactement la faille SEC-05.

## Ecrans prets a l'emploi (`kump-account/ui`)

Pour ne plus reecrire un ecran de compte a chaque jeu.

```js
import { openKumpAccount, openKumpShop, applyKumpTheme } from 'kump-account/ui';

applyKumpTheme({ '--kump-accent': '#6c5ce7', '--kump-radius': '16px' });
openKumpAccount({ onChange: () => rafraichirMonBouton() });
openKumpShop({ onChange: () => rechargerApparence() });
```

Tout l'habillage passe par des variables CSS (`--kump-surface`, `--kump-text`,
`--kump-accent`...), posees avec une specificite NULLE : un jeu les redefinit
dans son propre `:root`, sans `!important`.

Ces ecrans gerent deja la creation de compte, la connexion, Google (y compris
le cas « ce compte est deja pris »), le profil, les trophees, le catalogue,
l'achat et l'equipement. Un jeu n'a plus qu'a leur donner ses couleurs.

**kump.fr ne les utilise pas** : c'est un site React avec sa propre charte.
Cette couche vise les jeux.

## Google et Apple

Les deux demandent une activation dans **Firebase → Authentication → Sign-in
method** :

- **Google** : gratuit, deux clics, rien d'autre à faire ;
- **Apple** : nécessite un **compte développeur Apple payant** (99 $/an) et la
  configuration d'un Service ID côté Apple. Tant que ce n'est pas fait, les
  fonctions renvoient `error: 'provider-disabled'` — à l'appelant d'afficher
  « bientôt disponible » plutôt qu'une erreur.

Les deux passent par une fenêtre popup (`signInWithPopup`). C'est fiable sur
le web ; dans une WebView (application Capacitor), une popup peut être
bloquée — il faudra alors basculer sur `signInWithRedirect`, non implémenté
ici tant qu'aucun jeu n'est distribué en application native.

Ne jamais utiliser `signIn*` dans un jeu : ça abandonnerait la progression
accumulée en anonyme. C'est `link*` qu'il faut, et les deux existent
séparément précisément pour rendre cette erreur impossible par distraction.

### Le cas « ce compte Google est déjà pris » — à traiter, pas à subir

`link*` échoue quand l'identité visée appartient déjà à un autre compte KUMP.
C'est le cas le plus fréquent en pratique : le joueur a déjà un profil créé
depuis un autre jeu. **Ce n'est pas une impasse**, et un écran qui se contente
d'afficher « déjà rattaché » laisse le joueur sans issue.

Trois codes distincts, trois sorties différentes :

| Code | Ce qui se passe | Ce que l'écran doit proposer |
|---|---|---|
| `credential-in-use` | Ce compte Google/Apple appartient à un AUTRE profil KUMP | `signInWithGoogle()` — en prévenant que la session anonyme en cours sera abandonnée |
| `email-in-use-other-provider` | Un compte existe avec cette adresse, mais par email + mot de passe | se connecter par email |
| `already-linked` | Le compte COURANT a déjà ce fournisseur | rien — il n'y a rien à faire, ni rien d'alarmant à afficher |
| `cancelled` | Le joueur a fermé la fenêtre | **rien du tout** — ce n'est pas une erreur |

⚠️ `cancelled` doit être traité explicitement : sans ça, fermer la popup
affiche « une erreur est survenue », ce qui est faux et inquiétant.

Le module ne fusionne JAMAIS deux comptes automatiquement : il faudrait
choisir quelle progression garder, ce qu'aucun code ne peut décider à la place
du joueur.

## Schéma Firestore

```
users/{uid}                                  profil global : pseudo, temps de jeu total
users/{uid}/games/{gameId}                   progression pour CE jeu (forme libre)
users/{uid}/games/{gameId}/trophies/{id}     un document par trophée obtenu
leaderboards/{gameId}/entries/{uid}          une entrée par joueur et par jeu
games/{gameId}                               catalogue public (nom, icône, trophées)
```

Ajouter un jeu = choisir un `gameId`. Aucune modification de ce module ni des
règles Firestore n'est nécessaire.

## Dégradation

Si `firebaseConfig` est absente ou incomplète, `initKump()` renvoie `false`,
affiche un avertissement et **le module reste inactif** : chaque fonction
renvoie une valeur neutre sans lever d'erreur. Un jeu doit donc toujours
pouvoir tourner sur ses données locales — le compte KUMP est un plus, jamais
une condition pour jouer.

## Limites connues (à lire avant de faire confiance aux données)

Les données envoyées par un jeu (pièces, progression, temps de jeu, trophées)
sont **déclarées par le client**. Les règles Firestore garantissent que
personne ne peut écrire chez quelqu'un d'autre, mais **pas** que ce qu'un
joueur écrit chez lui est mérité : quelqu'un qui modifie le jeu dans son
navigateur peut s'attribuer des pièces ou un trophée.

`purchaseGameItem()` ferme un cas précis et important — la désynchronisation
entre le débit et le déblocage, qui permettait d'obtenir des objets gratuits
(SEC-05) — mais le PRIX vient toujours du jeu, donc du client.

Rendre ces données infalsifiables demande des **Cloud Functions** qui
recalculent côté serveur ce que le joueur avait le droit de gagner (voir
`Androgame/AUDIT.md` §3, phase 3). Tant que ce n'est pas fait :

- ne jamais rattacher de récompense réelle (argent, lot) à ces valeurs ;
- considérer le classement comme indicatif, pas comme une compétition arbitrée.

## Index Firestore

Un classement trié sur deux champs demande un index composite : Firestore
refuse la requête sinon (« The query requires an index »), et le classement
s'affiche vide au lieu de planter.

Deux façons de les créer :

- **`firestore.indexes.json`** (à la racine de ce module) :
  `firebase deploy --only firestore:indexes --project <projet-kump>` ;
- **à la main** dans la console (Firestore → Index → Composite) : ID de
  collection `entries`, portée **Collection**, et les champs listés dans ce
  même fichier. À préférer si les liens pré-remplis renvoyés par Firestore
  dans ses messages d'erreur échouent — ils sont longs et se font parfois
  tronquer au copier-coller.

Un jeu qui trie son classement sur d'autres champs que ceux d'Androgame devra
ajouter son propre couple d'index.
