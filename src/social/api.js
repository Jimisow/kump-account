// AMIS KUMP : code ami, demandes, liste d'amis, présence (en ligne + jeu en cours), invitations entre jeux, chat.
//
// Point d'entrée `kump-account/social` (avec les écrans de ui.js). Comme `kump-account/match`, il tire `firebase/database`
// et n'est donc PAS importé par `index.js` : un jeu qui ne propose pas d'amis ne le télécharge jamais.
//
// POURQUOI LA REALTIME DATABASE (et pas Firestore) — décision du 2026-10-14 :
//  - présence = « connecté tant que l'onglet est ouvert » : seule la RTDB sait marquer un joueur hors ligne quand sa connexion
//    tombe (`onDisconnect`, exécuté PAR LE SERVEUR), sans serveur à nous ;
//  - chat et invitations doivent arriver en direct (écoute), et la RTDB est facturée à la bande passante, pas à l'écriture ;
//  - les règles Firestore du profil sont verrouillées (seul le pseudo est écrivable par le client) : les rouvrir pour des
//    données sociales aurait mélangé deux niveaux de confiance. Ici, tout est dans `database.rules.json`, sous `social/`.
//
// Schéma (règles : database.rules.json, section `social`, déployées D'ICI : `firebase deploy --only database --project kump-812dd`) :
//   social/profiles/{uid}            { name, code, [avatar: {game, id}], at }   carte publique (lisible par tout compte connecté)
//   social/codes/{CODE}              uid                                       code ami (6 caractères) → joueur
//   social/requests/{to}/{from}      { name, at }                              demande d'ami en attente
//   social/friends/{uid}/{ami}       true                                      amitié (écrite des DEUX côtés à l'acceptation)
//   social/presence/{uid}            { state, game, gameName, status, at }     lisible par ses seuls AMIS
//   social/invites/{to}/{id}         { from, name, game, gameName, url, [code], at }   invitation à rejoindre un jeu
//   social/replies/{from}/{id}       { answer, by, at }                        réponse à une invitation (pour l'inviteur)
//   social/chats/{uidA_uidB}/{id}    { from, text, at }                        conversation (paire triée), entre amis seulement
//   social/unread/{uid}/{ami}        n                                         messages non lus, par ami
//
// ⚠️ Compte RÉEL obligatoire pour écrire (email ou Google), comme le multijoueur : un compte anonyme n'a pas de pseudo choisi
// et disparaît avec l'appareil — ses amis le perdraient. Les règles le refusent ; `socialAccount()` le dit avant toute tentative.

import {
  ref,
  get,
  set,
  update,
  remove,
  push,
  query,
  limitToLast,
  onValue,
  runTransaction,
  serverTimestamp,
  onDisconnect,
} from 'firebase/database';
import { getGameId, getKumpContext } from '../core.js';
import { rtdb as db, realAccount } from '../rtdb.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1 : se dicte sans ambiguïté (même alphabet que match)
const CODE_LENGTH = 6;
const INVITE_TTL_MS = 2 * 60 * 1000; // une invitation plus vieille n'est plus proposée (l'inviteur a sûrement abandonné)
const CHAT_LIMIT = 60;
const TEXT_MAX = 300;

/**
 * Clé `localStorage` posée tant qu'un compte réel utilise les amis sur cet appareil. Un jeu à chargement paresseux (Tower)
 * la lit SANS charger le module pour décider s'il démarre la présence au lancement — sans elle, il faudrait télécharger
 * Firebase à chaque ouverture juste pour savoir si le joueur a des amis.
 */
export const SOCIAL_MEMBER_KEY = 'kump.socialMember';

/**
 * Domaines vers lesquels une invitation peut emmener le joueur. Vérifié À LA FOIS par les règles (même liste) et ici avant de
 * naviguer : un « ami » ne doit pas pouvoir envoyer quelqu'un sur un site de hameçonnage en le déguisant en partie.
 * ⚠️ Ajouter un nouveau jeu = l'ajouter ICI et dans database.rules.json (`social/invites/.../url`), puis déployer les règles.
 */
export const INVITE_HOSTS = Object.freeze([
  'ltw.kump.fr', // Line Tower War, domaine officiel depuis le 2026-10-17
  'linetower.vercel.app',
  'androgame.vercel.app',
  'assassins.kump.fr',
  'dtrack.kump.fr',
  'www.kump.fr',
]);

const pairId = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
const sref = (path) => ref(db(), `social/${path}`);
const now = () => Date.now() + serverOffset;
let serverOffset = 0;
let offsetWatch = null;

function watchServerOffset() {
  offsetWatch ??= onValue(ref(db(), '.info/serverTimeOffset'), (snap) => {
    serverOffset = Number(snap.val()) || 0;
  });
}

function rememberMember(on) {
  try {
    if (on) localStorage.setItem(SOCIAL_MEMBER_KEY, '1');
    else localStorage.removeItem(SOCIAL_MEMBER_KEY);
  } catch {
    /* stockage indisponible : la présence démarrera simplement à l'ouverture du panneau */
  }
}

/**
 * Le joueur peut-il utiliser les amis ? (compte réel + base configurée). Pose ou retire le repère `SOCIAL_MEMBER_KEY`.
 * @returns {Promise<{ok: true, uid: string, name: string} | {ok: false, reason: 'not-ready'|'no-database'|'signed-out'|'guest'}>}
 */
export async function socialAccount({ fresh = false } = {}) {
  // Mis en cache pour l'utilisateur courant : `realAccount` relit le profil Firestore (pseudo), ce qu'il ne faut pas payer à
  // chaque message envoyé. `fresh` (publication du profil) force la relecture, pour qu'un pseudo changé se propage.
  const uid = getKumpContext().auth?.currentUser?.uid ?? null;
  if (!fresh && accountCache?.ok && accountCache.uid === uid) return accountCache;
  const acc = await realAccount('socialAccount');
  accountCache = acc;
  rememberMember(acc.ok);
  if (acc.ok) watchServerOffset();
  return acc;
}
let accountCache = null;

/** Une URL d'invitation est-elle sûre (domaine KUMP connu, ou le même site que la page en cours de développement) ? */
export function isSafeInviteUrl(url) {
  try {
    const u = new URL(url);
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (local) return typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname); // dev → dev seulement
    return u.protocol === 'https:' && INVITE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- profil public et code ami

/**
 * Publie la carte publique du joueur (pseudo, code ami, avatar) et garantit son code ami. À appeler au démarrage des amis,
 * puis à chaque changement d'avatar. `avatar` : `{ game, id }` — l'image est retrouvée par chaque jeu via `registerAvatarSet()`.
 * @returns {Promise<{code: string, name: string} | null>}
 */
export async function publishProfile({ avatar } = {}) {
  const acc = await socialAccount({ fresh: true });
  if (!acc.ok) return null;
  const mine = (await get(sref(`profiles/${acc.uid}`))).val();
  let code = mine?.code;
  if (!code || (await get(sref(`codes/${code}`))).val() !== acc.uid) code = await claimCode(acc.uid);
  const card = { name: acc.name, code, at: serverTimestamp() };
  const av = avatar === undefined ? mine?.avatar : avatar;
  if (av?.game && av?.id) card.avatar = { game: String(av.game), id: String(av.id) };
  await set(sref(`profiles/${acc.uid}`), card);
  return { code, name: acc.name };
}

async function claimCode(uid) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode(CODE_LENGTH);
    const tx = await runTransaction(sref(`codes/${code}`), (cur) => (cur === null ? uid : undefined)).catch(() => ({ committed: false }));
    if (tx.committed && tx.snapshot.val() === uid) return code;
  }
  throw socialError('code-unavailable');
}

/** Carte publique d'un joueur (ou `null`). */
export async function getPublicProfile(uid) {
  const v = (await get(sref(`profiles/${uid}`))).val();
  return v ? { uid, name: v.name, code: v.code, avatar: v.avatar ?? null } : null;
}

// ---------------------------------------------------------------- demandes d'ami

/**
 * Envoie une demande d'ami à partir d'un code. Si l'autre nous avait déjà demandé, on ACCEPTE directement.
 * @returns {Promise<{ok: true, accepted?: true, name: string} | {ok: false, reason: 'code-not-found'|'own-code'|'already-friends'|'already-sent'|'guest'|'signed-out'|'not-ready'|'no-database'}>}
 */
export async function sendFriendRequest(rawCode) {
  const acc = await socialAccount();
  if (!acc.ok) return { ok: false, reason: acc.reason };
  const code = String(rawCode ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH) return { ok: false, reason: 'code-not-found' };
  const uid = (await get(sref(`codes/${code}`))).val();
  if (!uid) return { ok: false, reason: 'code-not-found' };
  if (uid === acc.uid) return { ok: false, reason: 'own-code' };
  const target = await getPublicProfile(uid);
  const name = target?.name ?? 'Joueur';
  if ((await get(sref(`friends/${acc.uid}/${uid}`))).exists()) return { ok: false, reason: 'already-friends' };
  if ((await get(sref(`requests/${acc.uid}/${uid}`))).exists()) {
    await acceptFriendRequest(uid);
    return { ok: true, accepted: true, name };
  }
  if ((await get(sref(`requests/${uid}/${acc.uid}`))).exists()) return { ok: false, reason: 'already-sent' };
  await set(sref(`requests/${uid}/${acc.uid}`), { name: acc.name, at: serverTimestamp() });
  return { ok: true, name };
}

/** Demandes REÇUES : `cb([{uid, name, avatar, at}])`. Renvoie la fonction de désabonnement. */
export function watchRequests(cb) {
  const uid = getKumpContext().auth?.currentUser?.uid;
  if (!uid) {
    cb([]);
    return () => {};
  }
  const profiles = new Map();
  let list = [];
  const emit = () => cb(list.map((r) => ({ ...r, avatar: profiles.get(r.uid)?.avatar ?? null })));
  return onValue(sref(`requests/${uid}`), async (snap) => {
    list = [];
    snap.forEach((c) => {
      list.push({ uid: c.key, name: c.val()?.name ?? 'Joueur', at: c.val()?.at ?? 0 });
    });
    list.sort((a, b) => b.at - a.at);
    emit();
    await Promise.all(list.filter((r) => !profiles.has(r.uid)).map(async (r) => profiles.set(r.uid, await getPublicProfile(r.uid).catch(() => null))));
    emit();
  }, () => cb([]));
}

/** Accepte une demande : l'amitié est écrite des deux côtés, la demande effacée, en UNE écriture (règles : demande existante). */
export async function acceptFriendRequest(uid) {
  const me = getKumpContext().auth.currentUser.uid;
  await update(ref(db(), 'social'), {
    [`friends/${me}/${uid}`]: true,
    [`friends/${uid}/${me}`]: true,
    [`requests/${me}/${uid}`]: null,
  });
}

export async function declineFriendRequest(uid) {
  const me = getKumpContext().auth.currentUser.uid;
  await remove(sref(`requests/${me}/${uid}`));
}

/** Retire un ami (des deux côtés). La conversation reste lisible par les deux, mais plus personne ne peut y écrire. */
export async function removeFriend(uid) {
  const me = getKumpContext().auth.currentUser.uid;
  await update(ref(db(), 'social'), {
    [`friends/${me}/${uid}`]: null,
    [`friends/${uid}/${me}`]: null,
    [`unread/${me}/${uid}`]: null,
  });
}

// ---------------------------------------------------------------- amis, présence, non-lus

/**
 * Liste d'amis EN DIRECT : `cb([{uid, name, code, avatar, online, game, gameName, status, lastSeen, unread}])`, triée (en ligne
 * d'abord, puis par nom). Chaque ami a son écoute de profil et de présence ; une amitié retirée coupe les siennes.
 * @returns {() => void} désabonnement
 */
export function watchFriends(cb) {
  const me = getKumpContext().auth?.currentUser?.uid;
  if (!me) {
    cb([]);
    return () => {};
  }
  const subs = new Map(); // uid → [désabonnements]
  const data = new Map(); // uid → { profile, presence }
  let unread = {};
  let pending = false;
  const emit = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      const list = [...data.entries()].map(([uid, d]) => {
        const p = d.presence;
        const online = p?.state === 'online';
        return {
          uid,
          name: d.profile?.name ?? '…',
          code: d.profile?.code ?? null,
          avatar: d.profile?.avatar ?? null,
          online,
          game: p?.game ?? null,
          gameName: p?.gameName ?? null,
          status: online ? (p?.status ?? 'menu') : 'offline',
          lastSeen: p?.at ?? 0,
          unread: Number(unread[uid]) || 0,
        };
      });
      list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'fr'));
      cb(list);
    });
  };
  const offUnread = onValue(sref(`unread/${me}`), (snap) => {
    unread = snap.val() ?? {};
    emit();
  }, () => {});
  const offFriends = onValue(sref(`friends/${me}`), (snap) => {
    const ids = new Set(Object.keys(snap.val() ?? {}));
    for (const [uid, offs] of subs) {
      if (ids.has(uid)) continue;
      offs.forEach((off) => off());
      subs.delete(uid);
      data.delete(uid);
    }
    for (const uid of ids) {
      if (subs.has(uid)) continue;
      data.set(uid, { profile: null, presence: null });
      subs.set(uid, [
        onValue(sref(`profiles/${uid}`), (s) => {
          if (data.has(uid)) data.get(uid).profile = s.val();
          emit();
        }, () => {}),
        // présence : lisible tant que l'amitié existe ; retirée, l'écoute est refusée — sans conséquence
        onValue(sref(`presence/${uid}`), (s) => {
          if (data.has(uid)) data.get(uid).presence = s.val();
          emit();
        }, () => {}),
      ]);
    }
    emit();
  }, () => cb([]));
  return () => {
    offFriends();
    offUnread();
    subs.forEach((offs) => offs.forEach((off) => off()));
    subs.clear();
  };
}

/** Total des messages non lus (badge du bouton « Amis ») : `cb(n, parAmi)`. */
export function watchUnread(cb) {
  const me = getKumpContext().auth?.currentUser?.uid;
  if (!me) {
    cb(0, {});
    return () => {};
  }
  return onValue(sref(`unread/${me}`), (snap) => {
    const by = snap.val() ?? {};
    cb(Object.values(by).reduce((s, n) => s + (Number(n) || 0), 0), by);
  }, () => cb(0, {}));
}

/**
 * PRÉSENCE : « en ligne, sur tel jeu » tant que la page est ouverte. Le passage HORS LIGNE est posé par le SERVEUR à la
 * déconnexion (`onDisconnect`) et réarmé à chaque reconnexion (`.info/connected`) : une coupure réseau ne fige pas un
 * joueur « en ligne » pour toujours.
 * ⚠️ Plusieurs onglets / jeux ouverts à la fois : le dernier qui écrit gagne, et le premier fermé passe le joueur hors ligne
 * jusqu'à la prochaine reconnexion d'un autre — limite assumée (une présence par connexion coûterait une écoute de plus par ami).
 * @param {{gameName: string, status?: 'menu'|'playing'}} opts
 * @returns {Promise<{setStatus: (s: 'menu'|'playing') => Promise<void>, stop: () => Promise<void>} | null>}
 */
export async function startPresence({ gameName, status = 'menu' }) {
  const acc = await socialAccount();
  if (!acc.ok) return null;
  const me = sref(`presence/${acc.uid}`);
  const game = getGameId() ?? 'kump';
  const name = String(gameName ?? game).slice(0, 40);
  let current = status;
  let stopped = false;
  const online = () => ({ state: 'online', game, gameName: name, status: current, at: serverTimestamp() });
  const offline = () => ({ state: 'offline', game, gameName: name, at: serverTimestamp() });
  const arm = async () => {
    await onDisconnect(me).set(offline());
    await set(me, online());
  };
  await arm();
  const offConnected = onValue(ref(db(), '.info/connected'), (snap) => {
    if (snap.val() === true && !stopped) arm().catch(() => {});
  });
  return {
    async setStatus(s) {
      current = s === 'playing' ? 'playing' : 'menu';
      if (!stopped) await set(me, online()).catch(() => {});
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      offConnected();
      await onDisconnect(me).cancel().catch(() => {});
      await set(me, offline()).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- invitations

/**
 * Invite un ami à rejoindre SON jeu. `url` : adresse complète à ouvrir chez l'ami (domaine KUMP, cf. `INVITE_HOSTS`) ;
 * `code` (facultatif) : code de partie `kump-account/match` que le jeu de l'ami saura rejoindre.
 * @param {string} uid
 * @param {{url: string, gameName: string, code?: string}} opts
 * @returns {Promise<{id: string, onReply: (cb: (answer: 'accepted'|'declined') => void) => () => void, cancel: () => Promise<void>}>}
 */
export async function sendInvite(uid, { url, gameName, code }) {
  const acc = await socialAccount();
  if (!acc.ok) throw socialError(acc.reason);
  if (!isSafeInviteUrl(url)) throw socialError('bad-url');
  const inviteRef = push(sref(`invites/${uid}`));
  const invite = {
    from: acc.uid,
    name: acc.name,
    game: getGameId() ?? 'kump',
    gameName: String(gameName ?? getGameId()).slice(0, 40),
    url: String(url).slice(0, 300),
    at: serverTimestamp(),
  };
  if (code) invite.code = String(code);
  await set(inviteRef, invite);
  await onDisconnect(inviteRef).remove(); // l'inviteur ferme son jeu : l'invitation disparaît chez l'ami
  const replyRef = sref(`replies/${acc.uid}/${inviteRef.key}`);
  return {
    id: inviteRef.key,
    onReply(cb) {
      return onValue(replyRef, (snap) => {
        const v = snap.val();
        if (v?.answer) cb(v.answer);
      }, () => {});
    },
    async cancel() {
      await onDisconnect(inviteRef).cancel().catch(() => {});
      await remove(inviteRef).catch(() => {});
      await remove(replyRef).catch(() => {});
    },
  };
}

/** Invitations REÇUES et encore fraîches : `cb([{id, from, name, game, gameName, url, code, at}])`. */
export function watchInvites(cb) {
  const me = getKumpContext().auth?.currentUser?.uid;
  if (!me) {
    cb([]);
    return () => {};
  }
  watchServerOffset();
  return onValue(sref(`invites/${me}`), (snap) => {
    const list = [];
    snap.forEach((c) => {
      const v = c.val();
      if (v && typeof v.at === 'number' && now() - v.at < INVITE_TTL_MS) list.push({ id: c.key, ...v });
    });
    list.sort((a, b) => b.at - a.at);
    cb(list);
  }, () => cb([]));
}

/** Répond à une invitation (l'inviteur est prévenu) et la retire. */
export async function respondInvite(invite, answer) {
  const me = getKumpContext().auth.currentUser.uid;
  await set(sref(`replies/${invite.from}/${invite.id}`), { answer: answer === 'accepted' ? 'accepted' : 'declined', by: me, at: serverTimestamp() }).catch(() => {});
  await remove(sref(`invites/${me}/${invite.id}`)).catch(() => {});
}

// ---------------------------------------------------------------- chat

/** Conversation avec un ami, en direct (les `CHAT_LIMIT` derniers messages) : `cb([{id, from, mine, text, at}])`. */
export function watchChat(uid, cb) {
  const me = getKumpContext().auth?.currentUser?.uid;
  if (!me) {
    cb([]);
    return () => {};
  }
  return onValue(query(sref(`chats/${pairId(me, uid)}`), limitToLast(CHAT_LIMIT)), (snap) => {
    const list = [];
    snap.forEach((c) => {
      const v = c.val() ?? {};
      list.push({ id: c.key, from: v.from, mine: v.from === me, text: String(v.text ?? ''), at: Number(v.at) || 0 });
    });
    cb(list);
  }, () => cb([]));
}

/**
 * Envoie un message (1 à 300 caractères) à un ami, puis incrémente son compteur de non-lus.
 * @returns {Promise<{ok: true} | {ok: false, reason: 'empty'|'not-friends'|'guest'|'signed-out'|'not-ready'|'no-database'}>}
 */
export async function sendMessage(uid, rawText) {
  const acc = await socialAccount();
  if (!acc.ok) return { ok: false, reason: acc.reason };
  const text = String(rawText ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  if (!text) return { ok: false, reason: 'empty' };
  try {
    await set(push(sref(`chats/${pairId(acc.uid, uid)}`)), { from: acc.uid, text, at: serverTimestamp() });
  } catch {
    return { ok: false, reason: 'not-friends' }; // règles : plus amis (retiré entre-temps)
  }
  // Non-lus : +1 chez l'ami (plafonné à 999 par les règles ; au-delà, l'incrément est refusé, sans gravité).
  await runTransaction(sref(`unread/${uid}/${acc.uid}`), (n) => (Number(n) || 0) + 1).catch(() => {});
  return { ok: true };
}

/** Conversation lue : remet le compteur de cet ami à zéro. */
export async function markRead(uid) {
  const me = getKumpContext().auth?.currentUser?.uid;
  if (me) await remove(sref(`unread/${me}/${uid}`)).catch(() => {});
}

// ---------------------------------------------------------------- utilitaires

function randomCode(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Erreur avec un `code` court et stable (messages : ui.js, ou l'appelant). */
export function socialError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

