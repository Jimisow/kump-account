# kump-account

## À LIRE AVANT DE COMMENCER

Bibliothèque du **compte joueur KUMP**, installée comme dépendance par tous les
jeux et par le site. Cinq dépôts évoluent ensemble :

| Dépôt | Rôle |
|---|---|
| **kump-account** (ici) | le compte partagé — identité, sauvegarde, trophées, classements |
| **Androgame** (`E:\Projet\Androgame`) | le premier jeu branché dessus |
| **Assassins** (`E:\Projet\Assassins`) | jeu social — branché via `submitSession()` |
| **D-Track** (`E:\Projet\D-Track`) | jeu de dés — branché via `submitSession()` |
| **kump.fr** (`E:\Projet\Kump.fr`) | profil joueur et panel admin |

⚠️ **Tous les consommateurs installent la branche `main`, sans version
épinglée.** Un changement d'API cassant doit être répercuté dans TOUS
AVANT d'être poussé — sinon le jeu et le site cassent dès leur prochaine
installation. Il n'y a aucun filet de version pour les protéger.

La documentation d'usage (API, installation, schéma Firestore) vit dans
[README.md](README.md) : c'est elle que lisent les projets consommateurs, la
tenir à jour au même titre que ce fichier.

### Les règles de travail sur ce projet

1. **Tenir ce fichier à jour, systématiquement.** C'est la mémoire du projet :
   chaque session part de ce qui est écrit ici. Une décision structurante, un
   piège rencontré, un changement d'architecture ou de convention se
   documentent **dans le même passage** que le code — pas « plus tard ». Un
   `CLAUDE.md` périmé est pire que pas de documentation : il fait partir la
   session suivante sur des informations fausses. Quand une section décrit un
   système qui n'existe plus, la marquer **HISTORIQUE** plutôt que la
   supprimer : le raisonnement d'origine reste utile.
2. **Documenter le POURQUOI, pas le QUOI.** Le code dit déjà ce qu'il fait. Ce
   qui se perd, c'est la raison d'un choix, l'option écartée et pourquoi, le
   piège déjà payé une fois. C'est ce qui empêche quelqu'un de « simplifier »
   un correctif six mois plus tard.
3. **Vérifier en conditions réelles, jamais « ça compile ».** Lancer le vrai
   parcours, regarder le résultat, prendre une capture. Beaucoup de bugs de ce
   projet ne se voyaient qu'à l'écran ou qu'en production.
4. **Ne pas deviner quand un symptôme n'existe qu'en production.** Demander les
   logs d'abord. Deux hypothèses plausibles mais non vérifiées ont déjà coûté
   deux cycles de déploiement inutiles.
5. **Actions sensibles : demander avant.** Déploiement, suppression de données,
   écriture dans une base de production, création de dépôt. Préparer le
   changement et laisser la décision à l'utilisateur.
6. **Rapporter fidèlement.** Si un test échoue, le dire avec sa sortie. Si une
   partie du travail est laissée de côté, le dire explicitement. Ne jamais
   présenter comme vérifié ce qui ne l'a pas été.


## L'objectif : installer, et n'avoir plus qu'à habiller

C'est la promesse de ce module, et le critère qui tranche les débats de
conception : **un nouveau jeu KUMP doit pouvoir installer `kump-account` et
obtenir immédiatement un compte joueur, une progression sauvegardée, des
trophées, une monnaie et une boutique QUI FONCTIONNENT — sans écrire un écran,
sans écrire une requête, sans connaître Firebase.** Le seul travail qui reste
est le design.

Ce qui a mené là : l'écran de compte a été écrit **trois fois** (Androgame,
D-Track, Assassins), avec à chaque fois les mêmes pièges à repayer, et les
messages destinés au joueur étaient recopiés dans **quatre** projets. Ce
n'était pas soutenable.

### Les trois couches, et ce qui va dans chacune

| Couche | Contenu | Qui l'utilise |
|---|---|---|
| **`kump-account`** | identité, données de jeu, trophées, sessions, boutique — aucune interface | tout le monde |
| **`kump-account/ui`** | écrans prêts à l'emploi (compte, boutique), habillés par variables CSS | les JEUX |
| le projet | son design, ses écrans particuliers | chacun |

**Règle de rangement.** Ce qui est identique partout monte dans le module. Ce
qui relève de la direction artistique reste dans le projet. Les MESSAGES
destinés au joueur sont du texte, pas du design : ils vivent dans le module
(`messages.js`), avec un mécanisme de remplacement pour ajuster une phrase sans
recopier les vingt autres.

⚠️ **kump.fr n'utilise PAS `kump-account/ui`** : c'est un site React avec sa
propre charte, il garde ses écrans. La couche `ui` vise les jeux.

## Brancher un nouveau jeu — la marche à suivre

Sept étapes. Aucune ne demande de toucher aux règles Firestore.

### 1. Choisir un `gameId` — DÉFINITIF

Il sert de nom de dossier aux données du joueur (`users/{uid}/games/{gameId}`).
Le changer plus tard, c'est perdre la progression de tous les joueurs de ce
jeu. Le choisir court, en minuscules, sans accent : `androgame`, `d-track`,
`assassins`.

### 2. Installer et initialiser

```bash
npm install github:Jimisow/kump-account
```

```js
initKump({ firebaseConfig, gameId: 'mon-jeu', apiBaseUrl: 'https://kump.fr' });
```

`apiBaseUrl` est l'URL du serveur de validation. **Sans elle, aucune partie ne
part** : elles restent en file d'attente locale, silencieusement.

⚠️ **Charger le module PARESSEUSEMENT** (`await import()`), sauf si le jeu
charge déjà Firebase de toute façon. Le SDK pèse ~470 Ko : un `import` statique
le fait retomber dans le chunk de démarrage. Le patron éprouvé est un petit
fichier de configuration qui ne lit que des variables d'environnement (donc
importable partout sans coût) à côté d'un adaptateur chargé à la demande — voir
`D-Track/src/net/kumpConfig.js` et `kumpBridge.js`.

### 3. Décrire le jeu au serveur de validation (dans kump.fr)

Un fichier dans `Kump.fr/src/lib/game/games/`, inscrit au registre. Il répond à
une seule question : « cette partie est-elle plausible ? », et renvoie ce qu'il
faut compter (`increments`), garder au meilleur (`records`), écraser (`values`)
et créditer (`coins`).

**Le serveur n'accepte JAMAIS un total envoyé par le client** : il ajoute à ce
qu'il connaît. Remplacer une addition par une valeur reçue rouvrirait toute la
triche d'un coup.

### 4. Envoyer les parties

```js
await flushSessionQueue();            // au démarrage, ou avant d'envoyer
await submitSession({ kind, durationMs, payload });
```

⚠️ **Ne jamais écrire dans Firestore depuis le jeu.** Les règles refusent au
client d'écrire temps de jeu, statistiques, monnaie et trophées — **et le refus
est SILENCIEUX** : `saveGameData()`, `addPlaytime()` et `unlockTrophy()`
renvoient `false` sans rien dire. Un jeu qui les appelle croit enregistrer et
n'enregistre rien.

### 5. Saisir le catalogue des trophées

Dans le document Firestore `games/{gameId}`, via
`Kump.fr/scripts/seed-game-catalog.mjs --write`. Les libellés y vivent **une
seule fois**, lus par le jeu ET par kump.fr.

⚠️ Les **identifiants** de trophée sont définitifs (un trophée obtenu y est
rattaché) ; les **libellés** se réécrivent sans déployer quoi que ce soit.

### 6. Ouvrir les écrans

```js
import { openKumpAccount, openKumpShop, applyKumpTheme } from 'kump-account/ui';

applyKumpTheme({ '--kump-accent': '#6c5ce7', '--kump-radius': '16px' });
openKumpAccount({ onChange: rafraichirMonBouton });
openKumpShop({ onChange: rechargerApparence });
```

C'est tout. Ces écrans gèrent déjà la création de compte, la connexion, Google,
le profil, les trophées, le changement de pseudo, le catalogue, l'achat et
l'équipement — **et les quatre pièges listés en tête de `ui/account.js`**.

### 7. Décrire la boutique (dans kump.fr)

Un fichier dans `Kump.fr/src/lib/game/shops/`, inscrit au registre. Le serveur
détient les prix ; le jeu n'en écrit aucun.

## L'économie : ce qui est décidé, et pourquoi

**La monnaie est PAR JEU** (`users/{uid}/games/{gameId}.coins`), pas commune à
tous les jeux KUMP. Décision du 2026-08-30. Un porte-monnaie partagé ferait du
jeu le moins vérifiable la source de la monnaie de tous les autres : Assassins,
dont les statistiques sont déclarées, deviendrait l'atelier de fausse monnaie
d'Androgame — dont l'anti-triche a coûté cher. Ne pas revenir dessus sans avoir
mesuré ça.

**On paie ce que le serveur peut PROUVER.** C'est la règle qui décide d'un
barème :

- **D-Track** : le serveur rejoue la partie et recalcule le score. Payer au
  score est solide.
- **Assassins** : le serveur ne peut pas savoir qui a gagné. On paie donc la
  **partie jouée**, la victoire n'étant qu'un petit bonus — sinon un joueur qui
  s'annonce vainqueur à chaque fois gagne le double d'un joueur honnête.

Dans les deux cas, la **réserve de temps réel** borne le rythme : une session
coûte du temps qui ne se remplit qu'en s'écoulant. On ne peut donc pas frapper
monnaie plus vite qu'en jouant.

⚠️ **Ne jamais adosser une récompense RÉELLE** (argent, lot) à ces valeurs.

### Acheter et équiper passent tous deux par le serveur

`buyItem()` et `equipItem()` sont **le même appel**. Le serveur, voyant que
l'objet est déjà possédé, se contente de l'équiper sans débiter.

Ce n'est pas un détour : les règles Firestore n'autorisent le client à écrire
que `equippedSkin` et `equippedTrail` (noms hérités d'Androgame). Un jeu neuf,
dont le champ d'équipement s'appelle autrement, **ne peut pas l'écrire
lui-même**. Ne jamais supprimer la branche « déjà possédé » de la route d'achat
en la prenant pour une simple protection contre le double-clic.

⚠️ **Le solde affiché vient TOUJOURS de la réponse du serveur**, jamais d'un
calcul local (`solde - prix`). Recalculer côté client, c'est exactement la
faille SEC-05 d'Androgame : l'affichage finit par diverger du solde réel.

## L'habillage : le contrat de la couche `ui`

Tout passe par des variables CSS, posées avec une spécificité **nulle**
(`:where(:root)`). Un jeu redéfinit ce qu'il veut dans son propre `:root`, sans
`!important` et quel que soit l'ordre de chargement.

`--kump-bg`, `--kump-surface`, `--kump-surface-2`, `--kump-border`,
`--kump-text`, `--kump-text-dim`, `--kump-accent`, `--kump-accent-text`,
`--kump-danger`, `--kump-radius`, `--kump-radius-sm`, `--kump-font`.

Le plus élégant est de les brancher sur les tokens que le jeu a déjà, **lus à
l'exécution** — le thème clair/sombre du jeu s'applique alors aussi aux écrans
du module, sans une ligne de plus. Voir `D-Track/src/ui/accountButton.js`,
fonction `themeKump()`.

⚠️ **Toutes les classes sont préfixées `kump-`.** Ces écrans s'insèrent dans des
pages qui ont déjà leur CSS : une classe `.card` ou `.modal` entrerait en
collision avec celle du jeu, et le gagnant dépendrait de l'ordre de
chargement — un bug invisible et impossible à diagnostiquer.

⚠️ **Le CSS est injecté par JavaScript**, pas livré en fichier `.css` :
Assassins n'a aucun bundler et ne peut pas faire `import './theme.css'`.

### Ce que les écrans font, et ne font pas

- **Ouvrir l'écran de COMPTE ne crée aucun compte.** On observe l'identité sans
  jamais forcer `ensureSignedIn()` tant que le joueur n'agit pas.
- **Ouvrir la BOUTIQUE, si.** Elle affiche ce que le joueur possède, ce qui
  demande une identité. C'est assumé — ouvrir une boutique est un geste
  d'engagement, pas un coup d'œil. À savoir avant de poser un bouton
  « Boutique » sur un écran de chargement.

## Ce que ce module est, et n'est pas

C'est une **bibliothèque technique**, installée comme dépendance et sans étape
de build. Son cœur (`src/*.js`) n'a toujours **aucune interface** — c'est ce
qui lui permet de servir aussi bien un jeu Phaser qu'un site React. Depuis le
2026-08-30, une couche SÉPARÉE (`kump-account/ui`) fournit en plus des écrans
prêts à l'emploi aux jeux qui n'en veulent pas écrire ; personne n'est obligé
de l'importer. À ne pas confondre avec les « modules » du KUMP Lab (gestion
de stock, etc.), qui sont des **démos produit** présentées aux clients.

Écrit en **JavaScript pur, sans étape de build** : les jeux (Vite) comme le
site (Next.js) l'importent tel quel. Un `src/index.d.ts` fournit les types aux
projets TypeScript — **à tenir à jour avec `src/index.js`**, une fonction
exportée là-bas et absente ici sera refusée par TypeScript.

## Règle d'or

**Aucun projet consommateur ne doit importer `firebase/*` directement.** C'est
ce qui garantit qu'un correctif de sécurité fait ici profite à tous les jeux et
au site d'un coup, sans repasser dans chacun. Si un besoin n'est pas couvert
par l'API, l'ajouter **ici** plutôt que de contourner le module côté projet.

## Les pièges déjà rencontrés (ne pas les défaire)

- **`ensureSignedIn()` attend la restauration de session avant de créer un
  compte anonyme.** Firebase relit l'utilisateur déjà connecté de façon
  ASYNCHRONE : un `signInAnonymously()` lancé trop tôt créerait un NOUVEAU
  compte à chaque lancement, et le joueur perdrait sa progression à chaque
  fois. Le `onAuthStateChanged` d'attente n'est pas décoratif.
- **`link*` ≠ `signIn*`.** `link*` rattache le compte anonyme en cours (même
  identifiant, progression conservée) — c'est ce qu'un JEU doit appeler.
  `signIn*` bascule vers un autre compte et abandonne la session — c'est ce
  qu'un SITE doit appeler. Deux familles de fonctions distinctes plutôt qu'un
  drapeau, précisément pour rendre l'erreur impossible par distraction.
- **`purchaseGameItem()` est une transaction, et doit le rester.** Le code
  d'origine d'Androgame débitait puis débloquait en deux écritures
  indépendantes, avec un solde vérifié depuis le stockage LOCAL : en gonflant
  ce solde depuis la console, le débit était rejeté par les règles pendant que
  le déblocage passait — objets gratuits à volonté (faille SEC-05 de
  `Androgame/AUDIT.md`). Le solde doit être relu DANS la transaction.
- **`addPlaytime()` est MORTE contre les règles en service.** Elle écrit
  `totalPlaytimeMs` et `playtimeMs` ; depuis la phase 3, les deux sont refusés
  au client. Elle n'a pourtant jamais été marquée comme telle dans le README,
  contrairement à `unlockTrophy` / `submitScore` / `purchaseGameItem` —
  corrigé le 2026-08-29. **Le symptôme est silencieux** : la fonction avale son
  `permission-denied` dans un `catch` et renvoie `false`. Un jeu qui l'appelle
  croit enregistrer du temps de jeu et n'en enregistre aucun. Le temps de jeu
  passe désormais par la durée d'un `submitRun()` ou d'un `submitSession()`,
  créditée par le serveur.
- **Les libellés (trophées, niveaux) vivent en BASE, pas dans les projets.**
  `getGameCatalog()` lit `games/{gameId}`, en lecture publique. Ils étaient
  écrits en dur dans kump.fr tant qu'il n'y avait qu'un seul jeu — dette
  assumée et documentée à l'époque, qui ne l'était plus à trois : un trophée
  ajouté obligeait à modifier le JEU et le SITE, et les deux pouvaient
  diverger sans que rien ne le signale. Le catalogue s'écrit depuis
  `Kump.fr/scripts/seed-game-catalog.cjs`. Un catalogue absent renvoie `null`
  — l'appelant doit retomber sur les identifiants bruts, jamais afficher un
  écran vide.
- **« Ce compte Google est déjà pris » n'est pas une impasse.** `link*` échoue
  avec `credential-in-use` quand l'identité visée appartient à un autre compte
  KUMP — cas le PLUS FRÉQUENT dès qu'un joueur a déjà un profil créé depuis un
  autre jeu. Un écran qui se contente d'afficher le message laisse le joueur
  bloqué sans issue ; il doit proposer `signInWithGoogle()`. Les trois cas
  (`credential-in-use`, `email-in-use-other-provider`, `already-linked`) ont
  longtemps partagé un seul code, ce qui rendait la bonne sortie impossible à
  choisir — séparés le 2026-08-29.
- **`cancelled` n'est PAS une erreur.** Le joueur a fermé la popup. Un écran
  qui ne le traite pas explicitement affiche « une erreur est survenue », ce
  qui est faux et inquiétant.
- **`onAuthStateChanged` ne se déclenche PAS lors d'un `link*`.** Rattacher un
  email à un compte anonyme n'en change pas l'`uid` : pour Firebase, c'est le
  même utilisateur connecté, seuls ses fournisseurs ont changé. Un écran qui
  attend `onUserChanged` pour basculer sur le profil après une création de
  compte ne bascule donc JAMAIS. Chaque projet consommateur doit forcer
  l'affichage après un `link*` réussi (voir D-Track > `ui/account.js`,
  `allerAuProfil`). Ce n'est pas un bug du module : c'est le comportement de
  Firebase, à connaître.
- **La distinction refus / `retryable` / réseau absent ne vit qu'à UN endroit**
  (`transport.js`), partagée par `runs.js` et `session.js`. Elle a été extraite
  le jour où la deuxième porte est apparue, précisément pour ne pas la
  recopier : c'est la logique la plus coûteuse du module (SEC-13 — des joueurs
  honnêtes perdaient leurs parties), et deux copies auraient fini par diverger
  sans que rien ne le signale. Ne pas la réintégrer dans l'un des deux fichiers
  « pour simplifier ».
- **`isAdmin` n'apparaît dans aucune règle d'écriture.** Il est posé à la main
  dans la console Firebase, jamais par du code. C'est la seule protection
  nécessaire, et l'ajouter à un `hasOnly()` la ferait sauter.
- **Toute fonction publique dégrade au lieu de planter.** Config absente ou
  `initKump()` jamais appelée : on avertit et on renvoie une valeur neutre. Un
  jeu doit rester jouable sur ses données locales — le compte est un plus,
  jamais une condition pour jouer.
- **Ne jamais avaler une erreur en silence.** Chaque fonction d'écriture rend
  un résultat exploitable. C'est un `catch` muet qui avait masqué deux failles
  pendant des semaines dans Androgame.

## Version de Firebase exigée

`peerDependencies` : **`firebase >= 10.12`**, et pas « >= 11 » comme au
départ. Le module n'utilise rien qui soit apparu après la 9.11
(`getCountFromServer` est la plus récente de ses dépendances) — la borne
haute d'origine était une précaution, pas un besoin.

Elle a été abaissée pour **Assassins**, qui charge Firebase 10.12.2 depuis le
CDN gstatic et n'a pas de bundler. Le faire monter de version aurait été
toucher au moteur d'un jeu déjà en production, avec de vrais joueurs, sans
aucun bénéfice. Deux versions du SDK chargées en parallèle auraient coûté
~150 Ko de plus et deux instances d'Auth : à éviter.

⚠️ Avant d'utiliser une API Firebase plus récente ici, vérifier qu'elle existe
en 10.12 — ou remonter la borne ET faire monter Assassins en même temps.

## Sécurité : ce qui est garanti, ce qui ne l'est pas

`firestore.rules` garantit que **personne ne peut lire ni écrire le compte d'un
autre joueur**, ni publier un score sous une autre identité. C'est vérifié :
une lecture croisée renvoie `permission-denied`.

En revanche, **la valeur de ce qu'un joueur écrit chez lui n'est pas garantie**
— pièces, progression, temps de jeu, trophées sont déclarés par le client.
Fermer ça demande une validation serveur (Cloud Functions, ou des routes
serveur Next.js côté kump.fr). Tant que ce n'est pas fait : jamais de
récompense réelle adossée à ces valeurs.

Les bornes existantes (plafond de temps de jeu à 6 h, taille des documents,
monotonicité du temps de jeu) sont des **filets contre les cas grossiers**, pas
une preuve d'honnêteté.

## Après toute modification

1. `node --check` sur chaque fichier touché (pas de build, donc pas de filet
   de compilation).
2. Mettre à jour `src/index.d.ts` si l'API publique change.
3. Mettre à jour `README.md` (c'est la doc que lisent les projets).
4. **Incrémenter `version` dans `package.json`** dès que l'API publique
   change. Les consommateurs installent la branche `main`, donc la version ne
   protège personne en production — mais npm met en cache un paquet local par
   version : sans incrément, `npm install file:../kump-account --install-links`
   réinstalle l'ANCIENNE copie, et la nouvelle fonction reste introuvable
   (« does not provide an export named … ») alors que le fichier existe bel et
   bien ici. Une demi-heure perdue une fois, à ne pas repayer.
5. **Pousser sur GitHub**, puis `npm install github:Jimisow/kump-account` dans
   chaque projet consommateur — ils épinglent la branche, pas une version.
6. ⚠️ **Vider le cache de Vite** (`rm -rf node_modules/.vite`) dans un jeu
   après réinstallation : Vite sert une version pré-bundlée du module et ne
   détecte pas toujours qu'une dépendance GitHub a changé. Symptôme :
   « does not provide an export named ... » sur une fonction qui existe
   pourtant.

## Consommateurs actuels

- **Androgame** (`E:\\Projet\\Androgame`) — jeu Phaser. Voir sa section
  « Compte KUMP » dans son `CLAUDE.md`.
- **Assassins** (`E:\\Projet\\Assassins`) — jeu social, `gameId` « assassins ».
  **Aucun bundler** : le module y est vendorisé dans `public/js/vendor/` et
  résolu par une import map, pas par npm. Voir son `CLAUDE.md`.
- **D-Track** (`E:\\Projet\\D-Track`) — jeu de dés (Vite), `gameId` « d-track ».
- **kump.fr** (`E:\\Projet\\Kump.fr`) — site Next.js : page `/profil` et panel
  admin (`/admin`, dont les routes serveur utilisent le SDK admin, pas ce
  module).

Un changement d'API **cassant** doit être répercuté dans TOUS avant d'être
poussé : ils installent la branche `main`, il n'y a pas de version épinglée
pour les protéger.
