// Envoi des parties au serveur de validation, et file d'attente hors ligne.
//
// C'est le point de bascule de l'anti-triche (voir Androgame/AUDIT.md §3) : un
// jeu ne DÉCLARE plus ce qu'il a gagné, il le DEMANDE. Le serveur juge la
// plausibilité du run contre les données réelles du niveau, puis écrit
// lui-même — le client n'ayant plus le droit d'écrire pièces, progression ni
// diamants.
//
// Conséquence assumée : le jeu dépend du réseau pour enregistrer une partie.
// D'où la file d'attente ci-dessous — sans elle, un joueur dans le métro
// perdrait sa progression, ce qui serait bien pire que la triche qu'on cherche
// à empêcher.

import { getKumpContext, requireReady, requireGameId, getGameId } from './core.js';
import { ensureSignedIn, getIdToken } from './auth.js';

const QUEUE_KEY = 'kump.pendingRuns';
/** Au-delà, on jette les plus anciens : une file sans limite finirait par
 *  saturer le stockage du navigateur, et un run vieux de trois semaines
 *  n'intéresse plus personne. */
const QUEUE_MAX = 50;

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(runs) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(runs.slice(-QUEUE_MAX)));
  } catch {
    /* stockage plein ou indisponible : tant pis, on ne bloque pas le jeu */
  }
}

/** Nombre de parties en attente d'envoi — pour l'afficher au joueur si besoin. */
export function pendingRunCount() {
  return readQueue().length;
}

async function post(path, body) {
  const { apiBaseUrl } = getKumpContext();
  if (!apiBaseUrl) {
    console.warn('[kump] initKump: `apiBaseUrl` absente — impossible de valider les parties.');
    return { networkError: true };
  }

  const user = await ensureSignedIn();
  if (!user) return { networkError: true };
  const token = await getIdToken();
  if (!token) return { networkError: true };

  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    // On distingue soigneusement DEUX échecs très différents : le serveur a
    // répondu « non » (le run est refusé, inutile de réessayer), ou il n'a pas
    // répondu du tout (à remettre en file). Confondre les deux ferait
    // réessayer indéfiniment un run que le serveur rejettera toujours.
    return { status: response.status, data, networkError: false };
  } catch {
    return { networkError: true };
  }
}

/**
 * Envoie une fin de partie au serveur.
 *
 * @param {object} run  `{ levelId, coins, percent, diamondIds, durationMs }` —
 *   la forme exacte est propre au jeu, le serveur la valide.
 * @returns {Promise<{accepted: boolean, queued?: boolean, refused?: boolean,
 *   reason?: string, coins?: number, trophies?: string[]}>}
 */
export async function submitRun(run) {
  if (!requireReady('submitRun') || !requireGameId('submitRun')) {
    return { accepted: false };
  }

  const payload = { ...run, gameId: getGameId() };
  const result = await post('/api/game/run', payload);

  if (result.networkError) {
    // Hors ligne : on garde le run pour le prochain lancement. Un tricheur
    // peut fabriquer de faux runs en attente, mais le serveur les validera
    // comme les autres — la file ne crée donc aucune faille.
    writeQueue([...readQueue(), { ...payload, queuedAt: Date.now() }]);
    return { accepted: false, queued: true };
  }

  if (result.status === 200 && result.data?.ok) {
    return {
      accepted: true,
      coins: result.data.coins,
      percent: result.data.percent,
      newDiamonds: result.data.newDiamonds,
      trophies: result.data.trophies ?? [],
    };
  }

  // 429 = trop rapproché du run précédent (anti-rejeu). Ce n'est pas un refus
  // définitif, mais réessayer plus tard n'a pas de sens non plus : la partie
  // suivante repartira de l'état correct.
  return { accepted: false, refused: true, reason: result.data?.reason ?? 'unknown' };
}

/**
 * Renvoie les parties restées en attente. À appeler au démarrage du jeu.
 *
 * Les runs sont envoyés un par un et dans l'ordre : le serveur impose un délai
 * minimum entre deux parties (anti-rejeu), donc un envoi en parallèle en
 * verrait la plupart rejetés.
 *
 * @returns {Promise<{sent: number, remaining: number}>}
 */
export async function flushRunQueue() {
  if (!requireReady('flushRunQueue')) return { sent: 0, remaining: 0 };

  const queue = readQueue();
  if (queue.length === 0) return { sent: 0, remaining: 0 };

  const restants = [];
  let sent = 0;

  for (const run of queue) {
    const result = await post('/api/game/run', run);
    if (result.networkError) {
      // Toujours hors ligne : on garde celui-ci ET tous les suivants, sans
      // insister — inutile de marteler un réseau absent.
      restants.push(run, ...queue.slice(queue.indexOf(run) + 1));
      break;
    }
    if (result.status === 200 && result.data?.ok) sent += 1;
    // Un run refusé par le serveur (trop de pièces, niveau inconnu, délai) est
    // ABANDONNÉ : le renvoyer donnerait le même refus à chaque lancement.
  }

  writeQueue(restants);
  return { sent, remaining: restants.length };
}

/**
 * Achat d'un objet — le serveur détient le catalogue, donc les prix. Le jeu
 * n'envoie plus que l'objet voulu.
 *
 * Pas de file d'attente ici, volontairement : un achat hors ligne ne peut pas
 * être validé plus tard sans mentir au joueur sur son solde entre-temps.
 * Mieux vaut lui dire tout de suite que ça n'a pas marché.
 */
export async function purchaseFromServer({ kind, itemId }) {
  if (!requireReady('purchaseFromServer') || !requireGameId('purchaseFromServer')) {
    return { success: false, error: 'not-ready' };
  }

  const result = await post('/api/game/purchase', { kind, itemId, gameId: getGameId() });
  if (result.networkError) return { success: false, error: 'offline' };
  if (result.status === 200 && result.data?.ok) {
    return {
      success: true,
      coins: result.data.coins,
      alreadyOwned: result.data.alreadyOwned === true,
      price: result.data.price,
    };
  }
  return { success: false, error: result.data?.reason ?? 'unknown' };
}
