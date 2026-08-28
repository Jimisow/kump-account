# kump-account

## À LIRE AVANT DE COMMENCER

Bibliothèque du **compte joueur KUMP**, installée comme dépendance par tous les
jeux et par le site. Trois dépôts évoluent ensemble :

| Dépôt | Rôle |
|---|---|
| **kump-account** (ici) | le compte partagé — identité, sauvegarde, trophées, classements |
| **Androgame** (`E:\Projet\Androgame`) | le premier jeu branché dessus |
| **kump.fr** (`E:\Projet\Kump.fr`) | profil joueur et panel admin |

⚠️ **Les deux consommateurs installent la branche `main`, sans version
épinglée.** Un changement d'API cassant doit être répercuté dans les deux
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


## Ce que ce module est, et n'est pas

C'est une **bibliothèque technique** : pas d'interface, pas de build, installée
comme dépendance. À ne pas confondre avec les « modules » du KUMP Lab (gestion
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
4. **Pousser sur GitHub**, puis `npm install github:Jimisow/kump-account` dans
   chaque projet consommateur — ils épinglent la branche, pas une version.
5. ⚠️ **Vider le cache de Vite** (`rm -rf node_modules/.vite`) dans un jeu
   après réinstallation : Vite sert une version pré-bundlée du module et ne
   détecte pas toujours qu'une dépendance GitHub a changé. Symptôme :
   « does not provide an export named ... » sur une fonction qui existe
   pourtant.

## Consommateurs actuels

- **Androgame** (`E:\\Projet\\Androgame`) — jeu Phaser. Voir sa section
  « Compte KUMP » dans son `CLAUDE.md`.
- **kump.fr** (`E:\\Projet\\Kump.fr`) — site Next.js : page `/profil` et panel
  admin (`/admin`, dont les routes serveur utilisent le SDK admin, pas ce
  module).

Un changement d'API **cassant** doit être répercuté dans les deux avant d'être
poussé : ils installent la branche `main`, il n'y a pas de version épinglée
pour les protéger.
