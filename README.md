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
| `sendPasswordReset(email)` | Email de réinitialisation. |
| `getProfile()` | Pseudo, email, temps de jeu total, date d'inscription. |
| `setDisplayName(nom)` | Change le pseudo (3 à 16 caractères). |
| `addPlaytime(ms)` | Ajoute du temps de jeu (total + jeu courant). |
| `loadGameData()` / `saveGameData(obj)` | Progression du joueur pour CE jeu, forme libre. |
| `unlockTrophy(id)` | Débloque un trophée. Renvoie `true` seulement la première fois. |
| `getUnlockedTrophies()` | Liste des trophées obtenus sur ce jeu. |
| `purchaseGameItem({ itemId, price, ownedField, equippedField })` | Achat en UNE transaction : relit le solde côté serveur, débite et débloque ensemble. À utiliser pour tout achat en monnaie de jeu. |
| `submitScore(stats)` | Publie l'entrée de classement (refusé pour un compte anonyme). |
| `fetchLeaderboard({ sortBy, thenBy, max })` | Top N. |
| `fetchRank({ sortBy, value, ... })` | Rang exact du joueur, par comptage serveur. |

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

Un classement trié sur deux champs demande un index composite. Firestore
renvoie un lien direct de création dans le message d'erreur au premier appel —
il faut le suivre une fois par couple de champs trié.
