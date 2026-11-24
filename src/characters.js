// PERSONNAGES d'un compte, pour CE jeu (0.10.0, 2026-11-26) — premier consommateur : Les Éclats d'Astria
// (`gameId` « astria », jusqu'à 5 héros créés par le joueur).
//
// POURQUOI ÇA PASSE PAR LE SERVEUR : les règles Firestore n'autorisent le client à écrire que `equippedSkin` /
// `equippedTrail` dans son document de jeu — `saveGameData({ characters })` échouerait EN SILENCE (false). L'écriture
// passe donc par `POST /api/game/characters` de kump.fr, qui valide la forme contre un SCHÉMA propre au jeu
// (`Kump.fr/src/lib/game/characters/<jeu>.ts`), borne le nombre de héros, vérifie l'unicité du nom et pose lui-même le
// niveau et la date de création. Un `gameId` sans schéma côté serveur est refusé (`game-unknown`).
//
// La LECTURE, elle, se fait directement (le joueur lit son propre document de jeu : permis par les règles).
//
// Forme d'un personnage : LIBRE pour ce module (c'est le schéma du jeu, côté serveur, qui décide) ; seul `id` est
// commun à tous. ⚠️ Ce que garantit le serveur dépend du jeu : pour Astria, la FORME est garantie mais l'inventaire est
// DÉCLARÉ (une sauvegarde, pas une économie KUMP — voir le schéma).
//
// Résultats : jamais d'exception ; `{ ok: true, characters }` ou `{ ok: false, error }`, `error` étant un code court
// (`offline`, `not-ready`, `invalid`, `too-many`, `name-taken`, `too-big`, `unknown-character`, `game-unknown`, `login`…)
// que `kumpMessage()` traduit pour le joueur.

import { requireReady, requireGameId, getGameId } from './core.js';
import { post } from './transport.js';
import { loadGameData } from './gameData.js';

const PATH = '/api/game/characters';

const trier = (map) =>
  Object.values(map && typeof map === 'object' ? map : {}).sort((a, b) => (Number(a?.creeLe) || 0) - (Number(b?.creeLe) || 0));

/**
 * Les personnages du joueur connecté pour le jeu courant (rangés par date de création).
 * ⚠️ Crée une session anonyme s'il n'y en a pas (comme toutes les lectures de données de jeu) : un SITE doit vérifier
 * qu'un joueur est connecté avant d'appeler.
 *
 * @returns {Promise<{ ok: true, characters: object[] } | { ok: false, error: string }>}
 */
export async function getCharacters() {
  if (!requireReady('getCharacters') || !requireGameId('getCharacters')) return { ok: false, error: 'not-ready' };
  const data = await loadGameData();
  // `null` = module inactif ou lecture impossible (hors ligne) : le jeu garde ce qu'il a en local
  if (data === null) return { ok: false, error: 'offline' };
  return { ok: true, characters: trier(data.characters) };
}

async function envoyer(fnName, body) {
  if (!requireReady(fnName) || !requireGameId(fnName)) return { ok: false, error: 'not-ready' };
  const result = await post(PATH, { gameId: getGameId(), ...body });
  // Pas de file d'attente : créer / supprimer un héros hors ligne ne peut pas être « validé plus tard » sans mentir au
  // joueur sur sa liste entre-temps (même raisonnement que `purchaseFromServer`). Le jeu garde sa copie locale.
  if (result.networkError) return { ok: false, error: 'offline' };
  if (result.status === 200 && result.data?.ok) return { ok: true, characters: result.data.characters ?? [] };
  return { ok: false, error: result.data?.reason ?? 'unknown', field: result.data?.field };
}

/**
 * Crée ou met à jour un personnage (`character.id` le désigne). Le serveur renvoie la liste À JOUR.
 * @param {{ id: string } & object} character
 * @returns {Promise<{ ok: true, characters: object[] } | { ok: false, error: string, field?: string }>}
 */
export function saveCharacter(character) {
  return envoyer('saveCharacter', { action: 'save', character });
}

/**
 * Supprime un personnage, définitivement.
 * @param {string} id
 * @returns {Promise<{ ok: true, characters: object[] } | { ok: false, error: string }>}
 */
export function deleteCharacter(id) {
  return envoyer('deleteCharacter', { action: 'delete', id });
}
