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

/**
 * REPRISE d'une partie en cours (0.8.0) : rouvre la salle `roomId` où le joueur a été déconnecté (batterie, réseau, application fermée).
 * Le jeu garde `roomId` et `seat` lui-même (stockage local) ; ici on vérifie seulement que la salle existe encore ET que ce compte y occupe
 * bien ce siège (les règles le garantissent déjà : lecture réservée aux deux joueurs). La salle disparaît dès que les deux joueurs l'ont
 * quittée ou à la fin de la partie : `room-unavailable` = la partie est terminée, le jeu demande alors le résultat au serveur.
 * @param {{roomId: string, seat: 0|1}} opts
 * @returns {Promise<MatchRoom>}
 */
export async function resumeMatch({ roomId, seat }) {
  const acc = await matchAccount();
  if (!acc.ok) throw matchError(acc.reason);
  if (typeof roomId !== 'string' || !/^[-\w]{6,40}$/.test(roomId) || (seat !== 0 && seat !== 1)) throw matchError('room-unavailable');
  const game = getGameId();
  const base = `rooms/${game}/${roomId}`;
  let meta = null;
  try {
    meta = (await get(ref(db(), `${base}/meta`))).val();
  } catch {
    meta = null; // salle supprimée : les règles refusent la lecture
  }
  if (!meta || meta[`p${seat}`] !== acc.uid) throw matchError('room-unavailable');
  const room = new MatchRoom(base, roomId, seat, meta);
  await room.connectPresence();
  return room;
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

  /**
   * TOUS les messages déjà écrits, des deux sièges (reprise d'une partie : le jeu rejoue la partie depuis le début). `{ own, opp }` = Map(n° → chaîne).
   * Les messages qui arriveront ensuite viennent par `onTurn` comme d'habitude (à brancher AVANT, pour ne rien perdre entre les deux).
   */
  async readTurns() {
    const read = async (seat) => {
      const out = new Map();
      const val = (await get(this.#ref(`t/${seat}`))).val() ?? {};
      // Realtime Database rend un tableau si les clés sont des entiers contigus depuis 0
      for (const [k, v] of Object.entries(val)) if (typeof v === 'string' && /^[0-9]+$/.test(k)) out.set(Number(k), v);
      return out;
    };
    const [own, opp] = await Promise.all([read(this.seat), read(this.opponentSeat)]);
    return { own, opp };
  }

  /** Empreinte d'état à un instant donné (détection de désynchronisation). */
  sendHash(index, hash) {
    return set(this.#ref(`hash/${this.seat}/${index}`), String(hash));
  }

  /** Empreintes de l'adversaire : `cb(index, hash)`. */
  onHash(cb) {
    this.#subs.push(onChildAdded(this.#ref(`hash/${this.opponentSeat}`), (snap) => cb(Number(snap.key), snap.val())));
  }

  /** Ma propre connexion au serveur : `cb(true|false)` à chaque changement (le jeu s'en sert pour ne pas accuser l'adversaire d'une coupure qui est la sienne). */
  onConnected(cb) {
    this.#subs.push(onValue(ref(db(), '.info/connected'), (snap) => cb(snap.val() === true)));
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

// ====================================================================================================================
// SALONS : parties EN LIGNE à 3-5 joueurs (humains + IA du jeu). Ajouté en 0.7.0 — le 1 contre 1 ci-dessus n'a pas bougé.
//
// Un salon est une salle `salons/{jeu}/{salle}` qui sert aux DEUX temps de la partie :
//  1. LE SALON (avant le départ) : l'hôte crée la salle et un CODE de 4 caractères (`mm/{jeu}/salons/{CODE}`, joint à la main ou par une
//     invitation d'ami) ; chaque invité s'y inscrit (`members/{uid}`) ; l'hôte publie la composition (`lobby`, une chaîne que le module ne
//     lit pas : le jeu y met ses places, ses IA, ses réglages) ; il peut retirer un membre ;
//  2. LA PARTIE : l'hôte écrit `start` (graine, nombre de places, uid de chaque place humaine, copie de la composition) ; chaque place
//     humaine échange alors des messages numérotés (`t/{place}/{i}`) comme dans une salle à deux — mais avec N places.
//
//   salons/{jeu}/{salle}/meta       { host, name, v, at, code }      écrite une fois par l'hôte
//   salons/{jeu}/{salle}/members/{uid}   { name, avatar?, at }       l'inscription de chacun (lui seul, ou l'hôte pour retirer)
//   salons/{jeu}/{salle}/lobby      chaîne ≤ 3000                    composition, écrite par l'hôte
//   salons/{jeu}/{salle}/start      { seed, n, at, cfg, seats:{s0..s4: uid} }   le départ (une fois) ; les places IA n'ont pas de uid
//   salons/{jeu}/{salle}/t|hash/{place}/{i}, ready/{place}, presence/{uid}, drops/{place}
//
// ⚠️ L'ABSENCE d'un joueur en pleine partie est l'affaire du JEU (lockstep) : `announceDrop` / `onDrop` lui donnent le moyen de décider,
// avec l'hôte comme arbitre, qu'une place n'est plus attendue à partir d'un tour donné.
// ====================================================================================================================

export const SALON_MAX_SEATS = 5;

// Quand la salle disparaît, les écoutes encore actives perdent leur droit de lecture : Firebase les annule et journalise une erreur si rien ne la reçoit. Sans conséquence ici.
const quiet = () => {};

const memberValue = (name, avatar) => ({
  name: String(name ?? 'Joueur').slice(0, 24),
  ...(typeof avatar === 'string' && avatar ? { avatar: avatar.slice(0, 24) } : {}),
  at: serverTimestamp(),
});

/**
 * HÔTE : crée le salon et son code. Le salon se ferme (et disparaît) si l'hôte se déconnecte avant le départ.
 * @param {{version: string, avatar?: string}} opts  `avatar` : identifiant d'avatar du jeu, montré aux autres membres
 * @returns {Promise<SalonRoom>}
 */
export async function hostSalon({ version, avatar = '' }) {
  const acc = await matchAccount();
  if (!acc.ok) throw matchError(acc.reason);
  const game = getGameId();
  const database = db();
  const roomId = push(ref(database, `salons/${game}`)).key;
  let code = '';
  let codeRef = null;
  for (let attempt = 0; attempt < 8 && !codeRef; attempt++) {
    code = randomCode();
    const r = ref(database, `mm/${game}/salons/${code}`);
    const tx = await runTransaction(r, (cur) => (cur ? undefined : { host: acc.uid, name: acc.name, room: roomId, at: Date.now(), v: version }));
    if (tx.committed) codeRef = r;
  }
  if (!codeRef) throw matchError('code-unavailable');
  await onDisconnect(codeRef).remove();
  const base = `salons/${game}/${roomId}`;
  try {
    await set(ref(database, `${base}/meta`), { host: acc.uid, name: acc.name, v: version, at: Date.now(), code });
    await set(ref(database, `${base}/members/${acc.uid}`), memberValue(acc.name, avatar));
    await onDisconnect(ref(database, base)).remove(); // l'hôte part avant le départ : le salon se ferme pour tous et ne laisse rien derrière lui
  } catch (err) {
    await remove(codeRef).catch(() => {});
    throw err;
  }
  const room = new SalonRoom({ database, base, roomId, uid: acc.uid, name: acc.name, code, hostUid: acc.uid, version, codeRef });
  await room.connectPresence();
  return room;
}

/**
 * INVITÉ : rejoint le salon d'un code. Échoue avec `code-not-found`, `own-code`, `version-mismatch` ou `salon-closed` (déjà lancé, ou fermé).
 * @param {string} rawCode
 * @param {{version: string, avatar?: string}} opts
 * @returns {Promise<SalonRoom>}
 */
export async function joinSalon(rawCode, { version, avatar = '' }) {
  const acc = await matchAccount();
  if (!acc.ok) throw matchError(acc.reason);
  const game = getGameId();
  const database = db();
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) throw matchError('code-not-found');
  const cur = (await get(ref(database, `mm/${game}/salons/${code}`))).val();
  if (!cur) throw matchError('code-not-found');
  if (cur.host === acc.uid) throw matchError('own-code');
  if (cur.v !== version) throw matchError('version-mismatch');
  const base = `salons/${game}/${cur.room}`;
  try {
    await set(ref(database, `${base}/members/${acc.uid}`), memberValue(acc.name, avatar));
  } catch {
    throw matchError('salon-closed'); // refusé par les règles : la partie est déjà lancée, ou le salon a disparu
  }
  let meta = null;
  for (let i = 0; i < 40 && !meta; i++) {
    meta = (await get(ref(database, `${base}/meta`)).catch(() => null))?.val() ?? null;
    if (!meta) await new Promise((r) => setTimeout(r, META_RETRY_MS));
  }
  if (!meta) throw matchError('salon-closed');
  const room = new SalonRoom({ database, base, roomId: cur.room, uid: acc.uid, name: acc.name, code, hostUid: meta.host, version });
  await room.connectPresence();
  return room;
}

/**
 * REPRISE d'une partie de SALON interrompue (0.9.0, 2026-10-20) : un joueur déconnecté (batterie, réseau, application fermée) revient dans la salle où il a une PLACE.
 * Aucune règle nouvelle : il est toujours membre (les règles lui laissent la lecture) et sa place lui laisse écrire SES messages (`t/{place}/{i}`, jamais réécrits).
 * Renvoie une salle déjà « partie » (`started`, `seat`, `seats`, `seed`, `cfg` renseignés) ; le jeu relit l'historique (`readTurns`) et rejoue la partie.
 * `room-unavailable` : la salle n'existe plus (partie terminée) ou je n'y ai pas de place.
 * @param {{roomId: string}} opts
 * @returns {Promise<SalonRoom>}
 */
export async function resumeSalon({ roomId }) {
  const acc = await matchAccount();
  if (!acc.ok) throw matchError(acc.reason);
  if (typeof roomId !== 'string' || !/^[-\w]{6,40}$/.test(roomId)) throw matchError('room-unavailable');
  const game = getGameId();
  const database = db();
  const base = `salons/${game}/${roomId}`;
  let meta = null;
  let start = null;
  try {
    [meta, start] = await Promise.all([get(ref(database, `${base}/meta`)), get(ref(database, `${base}/start`))]).then(([m, s]) => [m.val(), s.val()]);
  } catch {
    meta = null; // salle supprimée (ou plus membre) : les règles refusent la lecture
  }
  if (!meta || !start) throw matchError('room-unavailable');
  const room = new SalonRoom({ database, base, roomId, uid: acc.uid, name: acc.name, code: meta.code, hostUid: meta.host, version: meta.v });
  room.restoreStart(start);
  if (room.seat < 0) throw matchError('room-unavailable');
  await room.connectPresence();
  return room;
}

/** Un salon (avant le départ) puis une salle de N places (pendant la partie). Le jeu y échange des chaînes ; le module ne les interprète pas. */
export class SalonRoom {
  #db;
  #base;
  #subs = [];
  #left = false;
  #codeRef;

  constructor({ database, base, roomId, uid, name, code, hostUid, version, codeRef = null }) {
    this.#db = database;
    this.#base = base;
    this.#codeRef = codeRef;
    this.roomId = roomId;
    /** Mon identifiant de compte, mon pseudo, le code du salon. */
    this.uid = uid;
    this.name = name;
    this.code = code;
    this.hostUid = hostUid;
    this.isHost = uid === hostUid;
    this.version = version;
    /** Renseignés au DÉPART (`onStart`) : ma place (−1 = je n'en ai pas), les uid par place (null = IA), la graine, la composition. */
    this.seat = null;
    this.seats = null;
    this.seed = null;
    this.cfg = null;
    this.started = false;
  }

  #ref(path) {
    return ref(this.#db, `${this.#base}/${path}`);
  }

  /** Présence (par compte) : `true` tant que connecté, `false` posé par le SERVEUR à la déconnexion ; rétablie à chaque reconnexion. */
  async connectPresence() {
    const me = this.#ref(`presence/${this.uid}`);
    await set(me, true);
    await onDisconnect(me).set(false);
    this.#subs.push(onValue(ref(this.#db, '.info/connected'), (snap) => {
      if (snap.val() !== true || this.#left) return;
      onDisconnect(me).set(false).then(() => set(me, true)).catch(() => {});
    }));
  }

  // ------------------------------------------------------------------ LE SALON (avant le départ)

  /** Membres du salon, l'hôte d'abord puis par ordre d'arrivée : `cb([{uid, name, avatar?}])` à chaque changement. */
  onMembers(cb) {
    this.#subs.push(onValue(this.#ref('members'), (snap) => {
      const list = [];
      snap.forEach((c) => {
        list.push({ uid: c.key, ...c.val() });
      });
      list.sort((a, b) => (a.uid === this.hostUid ? -1 : b.uid === this.hostUid ? 1 : (a.at ?? 0) - (b.at ?? 0) || (a.uid < b.uid ? -1 : 1)));
      cb(list);
    }, quiet));
  }

  /** Composition publiée par l'hôte : `cb(chaîne | null)`. */
  onLobby(cb) {
    this.#subs.push(onValue(this.#ref('lobby'), (snap) => cb(snap.val()), quiet));
  }

  /** HÔTE : publie la composition (chaîne ≤ 3000 caractères). */
  publishLobby(text) {
    return set(this.#ref('lobby'), String(text));
  }

  /** Met à jour mon inscription (pseudo, avatar). */
  setProfile({ name, avatar }) {
    const patch = {};
    if (typeof name === 'string' && name) patch.name = name.slice(0, 24);
    if (typeof avatar === 'string' && avatar) patch.avatar = avatar.slice(0, 24);
    return Object.keys(patch).length ? update(this.#ref(`members/${this.uid}`), patch) : Promise.resolve();
  }

  /** HÔTE : retire un membre du salon. */
  kick(uid) {
    return remove(this.#ref(`members/${uid}`));
  }

  /** Le salon n'existe plus (l'hôte l'a fermé ou s'est déconnecté) : `cb()` une fois, sauf si on est parti ou si la partie est lancée. */
  onClosed(cb) {
    // ⚠️ quand l'hôte supprime le salon, ses membres PERDENT le droit de lecture (règles) : Firebase annule alors l'écoute au lieu de livrer « vide » — l'annulation est l'événement
    let fired = false;
    const gone = () => {
      if (fired || this.#left || this.started) return;
      fired = true;
      cb();
    };
    this.#subs.push(onValue(this.#ref('meta'), (snap) => {
      if (!snap.exists()) gone();
    }, gone));
  }

  /** Mon inscription a disparu (l'hôte m'a retiré) : `cb()` une fois. */
  onKicked(cb) {
    let fired = false;
    const gone = () => { // retiré = plus de droit de lecture : l'écoute est annulée (cf. onClosed)
      if (fired || this.#left || this.started) return;
      fired = true;
      cb();
    };
    this.#subs.push(onValue(this.#ref(`members/${this.uid}`), (snap) => {
      if (!snap.exists()) gone();
    }, gone));
  }

  /**
   * HÔTE : lance la partie. `seats` = un uid par place (dans l'ordre des îles), `null` pour une place d'IA ; `cfg` = la composition (chaîne).
   * Le code est retiré : plus personne ne peut rejoindre.
   */
  async start({ seed, seats, cfg }) {
    if (!this.isHost) throw matchError('not-host');
    const placed = {};
    seats.forEach((u, i) => {
      if (u) placed[`s${i}`] = u;
    });
    await set(this.#ref('start'), { seed, n: seats.length, at: Date.now(), cfg: String(cfg), seats: placed });
    await onDisconnect(ref(this.#db, this.#base)).cancel(); // la salle survit à l'hôte : les autres joueurs continuent (ou terminent) sans lui
    if (this.#codeRef) {
      await onDisconnect(this.#codeRef).cancel();
      await remove(this.#codeRef).catch(() => {});
    }
  }

  /** Le départ a été donné : `cb({seed, n, seats, cfg, seat})` UNE fois (`seat` = −1 : pas de place pour moi). */
  onStart(cb) {
    this.#subs.push(onValue(this.#ref('start'), (snap) => {
      const v = snap.val();
      if (!v || this.started) return;
      this.restoreStart(v);
      cb({ seed: v.seed, n: v.n, seats: this.seats, cfg: v.cfg, seat: this.seat });
    }, quiet));
  }

  /** (interne, et reprise) Renseigne la salle à partir du départ `start` écrit par l'hôte. */
  restoreStart(v) {
    this.started = true;
    this.n = v.n;
    this.seats = Array.from({ length: v.n }, (_, i) => v.seats?.[`s${i}`] ?? null);
    this.seat = this.seats.indexOf(this.uid);
    this.seed = v.seed;
    this.cfg = v.cfg;
  }

  // ------------------------------------------------------------------ LA PARTIE (après le départ)

  #others() {
    return this.seats.map((u, s) => (u && s !== this.seat ? s : -1)).filter((s) => s >= 0);
  }

  /** Les places HUMAINES (indices). */
  get humanSeats() {
    return this.seats.map((u, s) => (u ? s : -1)).filter((s) => s >= 0);
  }

  /** Je suis prêt (écran de jeu chargé). */
  setReady() {
    return set(this.#ref(`ready/${this.seat}`), true);
  }

  /** `cb()` une fois quand TOUTES les places humaines sont prêtes. */
  onAllReady(cb) {
    let fired = false;
    this.#subs.push(onValue(this.#ref('ready'), (snap) => {
      const v = snap.val() ?? {};
      if (!fired && this.humanSeats.every((s) => v[s] === true)) {
        fired = true;
        cb();
      }
    }, quiet));
  }

  /** Mon message n° `index` (chaîne, jamais réécrite). */
  sendTurn(index, payload) {
    return set(this.#ref(`t/${this.seat}/${index}`), String(payload));
  }

  /** Les messages des AUTRES places humaines : `cb(place, index, chaîne)`. */
  onTurn(cb) {
    for (const s of this.#others()) this.#subs.push(onChildAdded(this.#ref(`t/${s}`), (snap) => cb(s, Number(snap.key), snap.val()), quiet));
  }

  /**
   * TOUS les messages déjà écrits, de TOUTES les places humaines (moi compris) : `Map(place → Map(n° → chaîne))`. Sert à la REPRISE (le jeu rejoue la partie depuis le
   * début). Les messages des autres arrivent aussi par `onTurn` (qui livre l'existant) : le jeu doit ignorer les doublons.
   */
  async readTurns() {
    const out = new Map();
    const val = (await get(this.#ref('t'))).val() ?? {};
    for (const [seat, msgs] of Object.entries(val)) {
      if (!/^[0-4]$/.test(seat) || !msgs) continue;
      const m = new Map();
      // Realtime Database rend un tableau si les clés sont des entiers contigus depuis 0
      for (const [k, v] of Object.entries(msgs)) if (typeof v === 'string' && /^[0-9]+$/.test(k)) m.set(Number(k), v);
      out.set(Number(seat), m);
    }
    return out;
  }

  /** Ma propre connexion au serveur : `cb(true|false)` à chaque changement (pour ne pas accuser les autres d'une coupure qui est la mienne). */
  onConnected(cb) {
    this.#subs.push(onValue(ref(this.#db, '.info/connected'), (snap) => cb(snap.val() === true)));
  }

  /** Empreinte d'état (détection de désynchronisation). */
  sendHash(index, hash) {
    return set(this.#ref(`hash/${this.seat}/${index}`), String(hash));
  }

  /** Empreintes des autres places humaines : `cb(place, index, empreinte)`. */
  onHash(cb) {
    for (const s of this.#others()) this.#subs.push(onChildAdded(this.#ref(`hash/${s}`), (snap) => cb(s, Number(snap.key), snap.val()), quiet));
  }

  /** Présence des autres places humaines : `cb(place, enLigne)` à chaque changement. */
  onPeerPresence(cb) {
    for (const s of this.#others()) this.#subs.push(onValue(this.#ref(`presence/${this.seats[s]}`), (snap) => cb(s, snap.val() === true), quiet));
  }

  /** HÔTE : « la place `seat` n'est plus attendue à partir du tour `turn` » (écrit une seule fois par place). */
  announceDrop(seat, turn) {
    return set(this.#ref(`drops/${seat}`), turn);
  }

  /** Les décisions de l'hôte sur les places qui ont quitté : `cb(place, tour)`. */
  onDrop(cb) {
    this.#subs.push(onChildAdded(this.#ref('drops'), (snap) => cb(Number(snap.key), snap.val()), quiet));
  }

  /**
   * Quitte. Avant le départ : un invité s'efface du salon, l'hôte le ferme. Pendant la partie : se déclare absent ; le dernier sorti supprime la salle.
   */
  async leave() {
    if (this.#left) return;
    this.#left = true;
    this.#subs.forEach((off) => off());
    this.#subs = [];
    try {
      const me = this.#ref(`presence/${this.uid}`);
      await onDisconnect(me).cancel().catch(quiet);
      if (!this.started) {
        if (this.isHost) {
          await onDisconnect(ref(this.#db, this.#base)).cancel();
          if (this.#codeRef) {
            await onDisconnect(this.#codeRef).cancel();
            await remove(this.#codeRef).catch(() => {});
          }
          await remove(ref(this.#db, this.#base));
        } else { // un invité que l'hôte a déjà retiré (ou dont le salon est fermé) n'a plus rien à effacer : refus sans importance
          await remove(this.#ref(`members/${this.uid}`)).catch(quiet);
          await set(me, false).catch(quiet);
        }
        return;
      }
      await set(me, false);
      const all = (await get(this.#ref('presence'))).val() ?? {};
      if (!Object.values(all).some((v) => v === true)) await remove(ref(this.#db, this.#base)); // le dernier sorti fait le ménage
    } catch (err) {
      console.warn('[kump] sortie de salon incomplète', err);
    }
  }
}
