// Parties EN LIGNE à deux : mise en relation (file d'attente, code ami) et SALLE (relais des messages des deux joueurs).
//
// Point d'entrée SÉPARÉ (`kump-account/match`) : il tire le SDK Realtime Database (`firebase/database`), qu'un jeu sans
// multijoueur n'a pas à télécharger. `index.js` ne l'importe donc PAS.
//
// Pourquoi la Realtime Database du projet KUMP (décision du 2026-10-12, première utilisation : Tower Lines) :
//  - l'identité est le COMPTE KUMP lui-même (les règles lisent `auth.uid`), sans second projet ni second compte ;
//  - un jeu en lockstep échange ~10 petits messages par seconde et par joueur : facturés à la bande passante ici, ils
//    coûteraient ~12 000 écritures par partie dans Firestore (quota gratuit de 20 000 / jour) ;
//  - la latence (onChildAdded) convient au lockstep ; un serveur WebSocket dédié aurait été un service de plus à héberger.
//
// Ce module ne connaît RIEN des règles d'un jeu : il met deux joueurs dans une salle et relaie des chaînes de caractères
// numérotées (`sendTurn` / `onTurn`), des empreintes d'état (`sendHash` / `onHash`) et la présence de chacun. Le jeu en fait
// ce qu'il veut (Tower : lockstep déterministe).
//
// Schéma (règles : database.rules.json, déployées D'ICI : `firebase deploy --only database --project kump-812dd`) :
//   mm/{gameId}/queue/{uid}         { name, at, v, [busy], [room, by] }   file « partie rapide »
//   mm/{gameId}/codes/{CODE}        { host, name, at, v, [guest, gname, room] }   défi entre amis (code de 4 caractères)
//   rooms/{gameId}/{roomId}/meta    { p0, p1, n0, n1, seed, v, at, [code] }   écrite UNE fois par le joueur qui « réclame »
//   rooms/{gameId}/{roomId}/t/{seat}/{i}      message n° i du siège (chaîne, ≤ 4000 caractères, jamais réécrit)
//   rooms/{gameId}/{roomId}/ready|presence|hash/{seat}…   synchronisation du départ, présence, empreintes
//
// ⚠️ Compte RÉEL obligatoire (email ou Google) : un compte anonyme n'a pas de pseudo choisi et peut être recréé à volonté —
// les règles le refusent (`sign_in_provider != 'anonymous'`), et `matchAccount()` le dit au jeu avant toute tentative.

import {
  ref,
  child,
  get,
  set,
  update,
  remove,
  push,
  query,
  orderByChild,
  limitToFirst,
  onValue,
  onChildAdded,
  runTransaction,
  serverTimestamp,
  onDisconnect,
} from 'firebase/database';
import { getGameId } from './core.js';
import { rtdb as db, realAccount } from './rtdb.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1 : se dicte sans ambiguïté
const SCAN_EVERY_MS = 2000; // fréquence à laquelle un joueur en file cherche un adversaire plus ancien que lui
const META_RETRY_MS = 250; // la salle est écrite juste après la réclamation : on la relit quelques fois

/**
 * Le joueur peut-il jouer en ligne ?
 * @returns {Promise<{ok: true, uid: string, name: string} | {ok: false, reason: 'not-ready'|'no-database'|'signed-out'|'guest'}>}
 */
export function matchAccount() {
  return realAccount('matchAccount'); // même exigence que les amis : compte réel (rtdb.js)
}

/**
 * PARTIE RAPIDE : s'inscrit dans la file du jeu et attend un adversaire. Le joueur le plus RÉCENT réclame le plus ancien
 * (une seule réclamation réussit, garantie par une transaction ; chacun verrouille d'abord sa propre entrée pour ne pas être
 * réclamé pendant qu'il réclame quelqu'un d'autre).
 *
 * @param {{version: string, onStatus?: (s: string) => void}} opts  `version` : seuls des joueurs de même version se rencontrent
 * @returns {{promise: Promise<MatchRoom>, cancel: () => Promise<void>}}
 */
export function quickMatch({ version, onStatus = () => {} }) {
  let cancelled = false;
  let cleanup = async () => {};
  const promise = (async () => {
    const acc = await matchAccount();
    if (!acc.ok) throw matchError(acc.reason);
    const game = getGameId();
    const queueRef = ref(db(), `mm/${game}/queue`);
    const myRef = child(queueRef, acc.uid);
    await set(myRef, { name: acc.name, at: serverTimestamp(), v: version });
    await onDisconnect(myRef).remove();
    onStatus('searching');

    return new Promise((resolve, reject) => {
      let done = false;
      let timer = 0;
      let unsub = () => {};
      const finish = async (fn) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        unsub();
        try {
          await onDisconnect(myRef).cancel();
          await remove(myRef);
          fn(null);
        } catch (err) {
          fn(err);
        }
      };
      cleanup = () => finish(() => reject(matchError('cancelled')));

      // Réclamé par un autre : il écrit la salle (siège 0 pour nous, le plus ancien). ⚠️ Notre entrée de file n'est retirée
      // qu'APRÈS avoir lu la salle : les règles autorisent l'écriture de `meta` en vérifiant cette entrée.
      unsub = onValue(myRef, (snap) => {
        const v = snap.val();
        if (!done && v?.room && v.by && v.by !== acc.uid) {
          done = true;
          clearInterval(timer);
          unsub();
          openRoom(game, v.room, 0, acc.uid)
            .then(async (room) => {
              await onDisconnect(myRef).cancel();
              await remove(myRef);
              resolve(room);
            })
            .catch(reject);
        }
      });

      const scan = async () => {
        if (done || cancelled) return;
        try {
          const snap = await get(query(queueRef, orderByChild('at'), limitToFirst(25)));
          const entries = [];
          snap.forEach((c) => {
            entries.push({ uid: c.key, ...c.val() });
          });
          const mine = entries.find((e) => e.uid === acc.uid);
          if (!mine || typeof mine.at !== 'number') return; // notre entrée n'est pas encore horodatée par le serveur
          const older = entries.filter((e) => e.uid !== acc.uid && e.v === version && !e.room && !e.busy && typeof e.at === 'number'
            && (e.at < mine.at || (e.at === mine.at && e.uid < acc.uid)));
          for (const cand of older) {
            if (done) return;
            // 1. verrouille sa propre entrée : personne ne doit nous réclamer pendant qu'on réclame
            const lock = await runTransaction(myRef, (cur) => {
              if (cur === null) return null;
              return !cur.room && !cur.busy ? { ...cur, busy: true } : undefined;
            }).catch(() => ({ committed: false }));
            if (!lock.committed || !lock.snapshot.val()?.busy) return; // déjà réclamé : `onValue` va prendre le relais
            // 2. réclame le candidat
            const roomId = push(ref(db(), `rooms/${game}`)).key;
            const claim = await runTransaction(child(queueRef, cand.uid), (cur) => {
              if (cur === null) return null; // valeur pas encore connue en local : le serveur rejouera avec la vraie (piège n° 1 des transactions RTDB)
              return !cur.room && !cur.busy ? { ...cur, room: roomId, by: acc.uid } : undefined;
            }).catch(() => ({ committed: false })); // entrée disparue entre-temps : refus des règles, on passe au suivant
            if (claim.committed && claim.snapshot.val()?.by === acc.uid) {
              const seed = randomSeed();
              await set(ref(db(), `rooms/${game}/${roomId}/meta`), {
                p0: cand.uid, p1: acc.uid, n0: String(cand.name ?? 'Joueur').slice(0, 24), n1: acc.name, seed, v: version, at: serverTimestamp(),
              });
              finish(async (err) => (err ? reject(err) : resolve(await openRoom(game, roomId, 1, acc.uid).catch(reject))));
              return;
            }
            await update(myRef, { busy: null }); // raté (pris par un autre) : on se déverrouille et on essaie le suivant
          }
        } catch (err) {
          console.warn('[kump] partie rapide : recherche interrompue', err);
        }
      };
      timer = setInterval(scan, SCAN_EVERY_MS);
      scan();
    });
  })();
  return {
    promise,
    cancel: async () => {
      cancelled = true;
      await cleanup();
    },
  };
}

/**
 * DÉFI ENTRE AMIS (hôte) : crée un code de 4 caractères à transmettre, puis attend que l'ami le saisisse.
 * @param {{version: string}} opts
 * @returns {Promise<{code: string, promise: Promise<MatchRoom>, cancel: () => Promise<void>}>}
 */
export async function hostFriendMatch({ version }) {
  const acc = await matchAccount();
  if (!acc.ok) throw matchError(acc.reason);
  const game = getGameId();
  let code = '';
  let codeRef = null;
  for (let attempt = 0; attempt < 8 && !codeRef; attempt++) {
    code = randomCode();
    const r = ref(db(), `mm/${game}/codes/${code}`);
    const tx = await runTransaction(r, (cur) => (cur ? undefined : { host: acc.uid, name: acc.name, at: Date.now(), v: version }));
    if (tx.committed) codeRef = r;
  }
  if (!codeRef) throw matchError('code-unavailable');
  await onDisconnect(codeRef).remove();

  let unsub = () => {};
  let rejectFn = () => {};
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    unsub = onValue(codeRef, async (snap) => {
      const v = snap.val();
      if (v?.room && v.guest) {
        unsub();
        try {
          const room = await openRoom(game, v.room, 0, acc.uid); // le code n'est retiré qu'après : les règles de `meta` le lisent
          await onDisconnect(codeRef).cancel();
          await remove(codeRef);
          resolve(room);
        } catch (err) {
          reject(err);
        }
      }
    });
  });
  return {
    code,
    promise,
    cancel: async () => {
      unsub();
      await onDisconnect(codeRef).cancel();
      await remove(codeRef);
      rejectFn(matchError('cancelled'));
    },
  };
}

/**
 * DÉFI ENTRE AMIS (invité) : rejoint la partie d'un code. Échoue avec `code-not-found`, `code-taken` (déjà rejoint),
 * `own-code` ou `version-mismatch`.
 * @param {string} rawCode
 * @param {{version: string}} opts
 * @returns {Promise<MatchRoom>}
 */
export async function joinFriendMatch(rawCode, { version }) {
  const acc = await matchAccount();
  if (!acc.ok) throw matchError(acc.reason);
  const game = getGameId();
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) throw matchError('code-not-found');
  const codeRef = ref(db(), `mm/${game}/codes/${code}`);
  const snap = await get(codeRef);
  const cur = snap.val();
  if (!cur) throw matchError('code-not-found');
  if (cur.host === acc.uid) throw matchError('own-code');
  if (cur.v !== version) throw matchError('version-mismatch');
  if (cur.guest) throw matchError('code-taken');
  const roomId = push(ref(db(), `rooms/${game}`)).key;
  const tx = await runTransaction(codeRef, (c) => {
    if (c === null) return null; // valeur pas encore connue en local : le serveur rejouera avec la vraie
    return !c.guest && c.host !== acc.uid ? { ...c, guest: acc.uid, gname: acc.name, room: roomId } : undefined;
  }).catch(() => ({ committed: false })); // code supprimé entre-temps : refus des règles
  if (!tx.committed || tx.snapshot.val()?.guest !== acc.uid) throw matchError('code-taken');
  await set(ref(db(), `rooms/${game}/${roomId}/meta`), {
    p0: cur.host, p1: acc.uid, n0: String(cur.name ?? 'Joueur').slice(0, 24), n1: acc.name, seed: randomSeed(), v: version, at: serverTimestamp(), code,
  });
  return openRoom(game, roomId, 1, acc.uid);
}

/** Ouvre la salle : relit `meta` (écrite par l'autre joueur juste avant) et branche la présence. */
async function openRoom(game, roomId, seat, uid) {
  const base = `rooms/${game}/${roomId}`;
  let meta = null;
  for (let i = 0; i < 40 && !meta; i++) {
    try {
      meta = (await get(ref(db(), `${base}/meta`))).val();
    } catch {
      meta = null; // pas encore lisible : la salle n'existe pas encore pour les règles
    }
    if (!meta) await new Promise((r) => setTimeout(r, META_RETRY_MS));
  }
  if (!meta || meta[`p${seat}`] !== uid) throw matchError('room-unavailable');
  const room = new MatchRoom(base, roomId, seat, meta);
  await room.connectPresence();
  return room;
}

/**
 * Une salle de deux joueurs. Le jeu y échange des messages numérotés ; le module ne les interprète pas.
 */
export class MatchRoom {
  #base;
  #subs = [];
  #left = false;

  constructor(base, roomId, seat, meta) {
    this.#base = base;
    this.roomId = roomId;
    /** 0 ou 1 : siège du joueur local (0 = celui qui attendait / l'hôte). */
    this.seat = seat;
    /** Graine partagée, tirée par le joueur qui a créé la salle. */
    this.seed = meta.seed;
    this.version = meta.v;
    /** Noms des deux sièges, dans l'ordre. */
    this.names = [meta.n0, meta.n1];
    this.uids = [meta.p0, meta.p1];
  }

  get opponentSeat() {
    return 1 - this.seat;
  }

  #ref(path) {
    return ref(db(), `${this.#base}/${path}`);
  }

  /**
   * Présence : `true` tant que l'onglet est connecté, `false` posé par le SERVEUR à la déconnexion. Rétablie à chaque
   * reconnexion (`.info/connected`) : une coupure réseau de quelques secondes ne passe pas pour un abandon.
   */
  async connectPresence() {
    const me = this.#ref(`presence/${this.seat}`);
    await set(me, true);
    await onDisconnect(me).set(false);
    this.#subs.push(onValue(ref(db(), '.info/connected'), (snap) => {
      if (snap.val() !== true || this.#left) return;
      onDisconnect(me).set(false).then(() => set(me, true)).catch(() => {});
    }));
  }

  /** Signale que le joueur local est prêt (écran de jeu chargé). */
  setReady() {
    return set(this.#ref(`ready/${this.seat}`), true);
  }

  /** Appelle `cb()` une fois quand les DEUX joueurs sont prêts. */
  onBothReady(cb) {
    let fired = false;
    this.#subs.push(onValue(this.#ref('ready'), (snap) => {
      const v = snap.val() ?? {};
      if (!fired && v[0] && v[1]) {
        fired = true;
        cb();
      }
    }));
  }

  /** Envoie le message n° `index` du joueur local (chaîne, jamais réécrite). */
  sendTurn(index, payload) {
    return set(this.#ref(`t/${this.seat}/${index}`), String(payload));
  }

  /** Messages de l'ADVERSAIRE, dans l'ordre d'arrivée : `cb(index, payload)`. */
  onTurn(cb) {
    this.#subs.push(onChildAdded(this.#ref(`t/${this.opponentSeat}`), (snap) => cb(Number(snap.key), snap.val())));
  }

  /** Empreinte d'état à un instant donné (détection de désynchronisation). */
  sendHash(index, hash) {
    return set(this.#ref(`hash/${this.seat}/${index}`), String(hash));
  }

  /** Empreintes de l'adversaire : `cb(index, hash)`. */
  onHash(cb) {
    this.#subs.push(onChildAdded(this.#ref(`hash/${this.opponentSeat}`), (snap) => cb(Number(snap.key), snap.val())));
  }

  /** Présence de l'adversaire : `cb(true|false)` à chaque changement. */
  onOpponentPresence(cb) {
    this.#subs.push(onValue(this.#ref(`presence/${this.opponentSeat}`), (snap) => cb(snap.val() === true)));
  }

  /** Quitte la salle : coupe les écoutes, se déclare absent ; la supprime si l'adversaire est déjà parti. */
  async leave() {
    if (this.#left) return;
    this.#left = true;
    this.#subs.forEach((off) => off());
    this.#subs = [];
    try {
      const me = this.#ref(`presence/${this.seat}`);
      await onDisconnect(me).cancel();
      await set(me, false);
      const other = (await get(this.#ref(`presence/${this.opponentSeat}`))).val();
      if (other !== true) await remove(ref(db(), this.#base)); // le dernier sorti fait le ménage
    } catch (err) {
      console.warn('[kump] sortie de salle incomplète', err);
    }
  }
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function randomSeed() {
  return (crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1;
}

/** Erreur avec un `code` court et stable (messages : à l'appelant). */
function matchError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}
