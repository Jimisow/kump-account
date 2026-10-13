// Écrans des AMIS KUMP, prêts à l'emploi : panneau d'amis (code, ajout, demandes, liste en direct, chat) et carte d'invitation.
//
// Même contrat que kump-account/ui (compte, boutique) : classes préfixées `kump-`, habillage par les variables `--kump-*`,
// CSS injecté par JavaScript (aucun fichier à copier, utilisable sans bundler). Un jeu ne réécrit rien : il appelle
// `startKumpSocial()` au lancement et `openKumpFriends()` sur son bouton « Amis ».
//
// ⚠️ TOUT texte venant d'un autre joueur (pseudo, message, nom de jeu) passe par `textContent` (fonction `el`) — jamais par
// innerHTML. Un pseudo « <img onerror=…> » ne doit rien exécuter chez ses amis.

import { el, openDialog } from '../ui/dom.js';
import { applyKumpTheme } from '../ui/theme.js';
import { getGameId } from '../core.js';
import {
  socialAccount,
  publishProfile,
  sendFriendRequest,
  watchRequests,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  watchFriends,
  watchUnread,
  getPublicProfile,
  startPresence,
  sendInvite,
  watchInvites,
  respondInvite,
  watchChat,
  sendMessage,
  markRead,
  isSafeInviteUrl,
} from './api.js';

/** Textes affichés (remplaçables par l'option `messages`, comme kump-account/ui). */
export const SOCIAL_TEXT = Object.freeze({
  title: 'Amis',
  myCode: 'Ton code ami',
  copy: 'Copier',
  copied: 'Copié !',
  share: 'Partager',
  addLabel: 'Ajouter un ami avec son code',
  addPlaceholder: 'CODE AMI',
  add: 'Ajouter',
  requests: 'Demandes reçues',
  friends: 'Mes amis',
  accept: 'Accepter',
  decline: 'Refuser',
  invite: 'Inviter',
  chat: 'Discuter',
  remove: 'Retirer de mes amis',
  removeConfirm: 'Retirer {name} de tes amis ?',
  empty: 'Pas encore d’amis : donne ton code, ou ajoute celui d’un ami.',
  online: 'En ligne',
  playing: 'En partie',
  offline: 'Hors ligne',
  sameGame: 'ici',
  seen: 'vu {ago}',
  back: 'Retour',
  send: 'Envoyer',
  chatPlaceholder: 'Écris un message…',
  chatEmpty: 'Aucun message pour l’instant. Dis bonjour !',
  sent: 'Demande envoyée à {name}.',
  autoAccepted: '{name} t’avait déjà demandé : vous êtes amis !',
  invited: 'Invitation envoyée à {name}.',
  inviteFrom: '{name} t’invite à jouer',
  inviteOtherGame: 'Tu vas quitter {game} pour rejoindre {target}.',
  inviteLeaveMatch: 'Ta partie en cours sera abandonnée.',
  join: 'Rejoindre',
  newMessage: 'Nouveau message de {name}',
  'code-not-found': 'Aucun joueur avec ce code.',
  'own-code': 'C’est ton propre code : donne-le à un ami.',
  'already-friends': 'Vous êtes déjà amis.',
  'already-sent': 'Demande déjà envoyée : elle attend sa réponse.',
  'not-friends': 'Message non envoyé : vous n’êtes plus amis.',
  guest: 'Les amis demandent un compte KUMP (email ou Google) : tes amis te retrouvent ainsi sur tous les jeux KUMP.',
  'signed-out': 'Connecte-toi à ton compte KUMP pour retrouver tes amis.',
  'not-ready': 'Compte KUMP injoignable (hors ligne ?).',
  'no-database': 'Les amis ne sont pas disponibles sur ce jeu.',
  'bad-url': 'Ce jeu ne peut pas encore envoyer d’invitation.',
  account: 'Mon compte KUMP',
  error: 'Une erreur est survenue, réessaie.',
});

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// ---------------------------------------------------------------- avatars des différents jeux

/**
 * Où trouver l'image d'un avatar `{ game, id }` publié par un autre jeu. Atlas en grille ; l'identifiant `avNN` désigne la case
 * NN − 1 (lecture ligne par ligne). Un jeu peut (re)déclarer son atlas, par exemple pour pointer sur sa copie locale en développement.
 */
const AVATAR_SETS = new Map([
  ['line-tower', { src: 'https://linetower.vercel.app/assets/ui/avatars-face.webp', cols: 7, rows: 7 }],
]);

/** @param {string} game  @param {{src: string, cols: number, rows: number}} set */
export function registerAvatarSet(game, set) {
  AVATAR_SETS.set(game, set);
}

/** Pastille d'avatar : l'image du jeu d'origine si on la connaît, sinon l'initiale du pseudo. Point de présence en option. */
function avatarBadge(avatar, name, presence) {
  const node = el('span', { class: 'kump-favatar', 'aria-hidden': 'true' });
  const set = avatar?.game ? AVATAR_SETS.get(avatar.game) : null;
  const n = Number(String(avatar?.id ?? '').replace(/\D/g, '')) - 1;
  if (set && n >= 0 && n < set.cols * set.rows) {
    node.classList.add('kump-favatar-img');
    node.style.backgroundImage = `url("${set.src}")`;
    node.style.backgroundSize = `${set.cols * 100}% ${set.rows * 100}%`;
    node.style.backgroundPosition = `${((n % set.cols) / Math.max(1, set.cols - 1)) * 100}% ${(Math.floor(n / set.cols) / Math.max(1, set.rows - 1)) * 100}%`;
  } else {
    node.textContent = String(name ?? '?').trim().charAt(0).toUpperCase() || '?';
  }
  if (presence) node.append(el('i', { class: `kump-dot kump-dot-${presence}` }));
  return node;
}

function ago(at) {
  if (!at) return '';
  const min = Math.max(1, Math.round((Date.now() - at) / 60000));
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

// ---------------------------------------------------------------- panneau d'amis

let openPanel = null; // un seul panneau à la fois (le bouton du jeu et une notification peuvent l'ouvrir)

/**
 * Ouvre le panneau d'amis.
 * @param {object} [options]
 * @param {(friend: object) => (void|Promise<unknown>)} [options.onInvite]  bouton « Inviter » (ami en ligne). Par défaut : invitation
 *   simple vers le jeu en cours (`inviteUrl`), sans partie à rejoindre — suffisant pour un jeu sans multijoueur.
 * @param {string} [options.gameName]  nom du jeu pour les invitations par défaut
 * @param {string} [options.inviteUrl] adresse à ouvrir chez l'ami (défaut : la page en cours, sans paramètres)
 * @param {() => unknown} [options.onAccount]  bouton « Mon compte KUMP » (joueur invité ou déconnecté)
 * @param {string} [options.chatWith]  ouvre directement la conversation avec cet ami
 * @param {Record<string, string>} [options.messages]
 * @param {() => void} [options.onClose]
 * @returns {{ close: () => void }}
 */
export function openKumpFriends(options = {}) {
  applySocialStyles();
  if (openPanel) {
    if (options.chatWith) openPanel.chat(options.chatWith);
    return openPanel;
  }
  const t = (k, vars) => fill(options.messages?.[k] ?? SOCIAL_TEXT[k] ?? k, vars);
  const offs = [];
  const dialog = openDialog({
    title: t('title'),
    onClose: () => {
      view.off?.();
      offs.forEach((off) => off());
      openPanel = null;
      options.onClose?.();
    },
  });
  dialog.card.classList.add('kump-friends-card');
  const { body } = dialog;
  const say = (box, text, tone = '') => {
    box.textContent = text ?? '';
    box.className = `kump-fmsg ${tone}`;
    box.hidden = !text;
  };
  let friends = [];
  let requestsList = [];
  let lastCode = '······';
  let view = { name: 'list' };

  const panel = {
    close: dialog.close,
    chat: (uid) => showChat(uid),
  };
  openPanel = panel;

  body.replaceChildren(el('p', { class: 'kump-loading' }, '…'));

  (async () => {
    const acc = await socialAccount();
    if (!acc.ok) return showGate(acc.reason);
    const pub = await publishProfile().catch(() => null);
    lastCode = pub?.code ?? lastCode;
    showList(lastCode);
    offs.push(watchFriends((list) => {
      friends = list;
      if (view.name === 'list') view.renderFriends?.();
      if (view.name === 'chat') view.renderHeader?.();
    }));
    offs.push(watchRequests((list) => {
      requestsList = list;
      view.renderRequests?.(list);
    }));
    if (options.chatWith) showChat(options.chatWith);
  })().catch((err) => {
    console.warn('[kump] amis indisponibles', err);
    showGate('not-ready');
  });

  function showGate(reason) {
    view = { name: 'gate' };
    // ⚠️ `replaceChildren(null)` insère le TEXTE « null » : les éléments facultatifs sont filtrés avant.
    body.replaceChildren(...[
      el('p', { class: 'kump-intro' }, t(reason in SOCIAL_TEXT ? reason : 'error')),
      options.onAccount && (reason === 'guest' || reason === 'signed-out')
        ? el('button', { class: 'kump-btn kump-btn-primary kump-btn-block', onclick: () => { dialog.close(); options.onAccount(); } }, t('account'))
        : null,
    ].filter(Boolean));
  }

  function showList(code) {
    const msg = el('p', { class: 'kump-fmsg', hidden: true, role: 'status' });
    const input = el('input', {
      class: 'kump-input kump-fcode-input',
      maxlength: '8',
      placeholder: t('addPlaceholder'),
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      'aria-label': t('addLabel'),
    });
    const addBtn = el('button', { class: 'kump-btn kump-btn-primary', type: 'submit' }, t('add'));
    const form = el('form', {
      class: 'kump-row kump-fadd',
      onsubmit: async (e) => {
        e.preventDefault();
        if (addBtn.disabled) return;
        addBtn.disabled = true;
        try {
          const r = await sendFriendRequest(input.value);
          if (r.ok) {
            input.value = '';
            say(msg, t(r.accepted ? 'autoAccepted' : 'sent', { name: r.name }), 'kump-ok');
          } else say(msg, t(r.reason), 'kump-warn');
        } catch (err) {
          console.warn('[kump] demande d’ami', err);
          say(msg, t('error'), 'kump-warn');
        } finally {
          addBtn.disabled = false;
        }
      },
    }, input, addBtn);

    const copyBtn = el('button', {
      class: 'kump-btn kump-fcopy',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(code);
          copyBtn.textContent = t('copied');
          setTimeout(() => (copyBtn.textContent = t('copy')), 1400);
        } catch {
          say(msg, code, '');
        }
      },
    }, t('copy'));
    const shareBtn = typeof navigator.share === 'function'
      ? el('button', {
          class: 'kump-btn kump-fcopy',
          type: 'button',
          onclick: () => navigator.share({ text: `${t('myCode')} : ${code}` }).catch(() => {}),
        }, t('share'))
      : null;
    const codeBox = el('div', { class: 'kump-fcode' },
      el('span', { class: 'kump-label' }, t('myCode')),
      el('strong', { class: 'kump-fcode-value' }, code),
      el('div', { class: 'kump-row' }, copyBtn, shareBtn));

    const reqBox = el('div', { class: 'kump-freqs', hidden: true });
    const listBox = el('div', { class: 'kump-flist', role: 'list' });
    const count = el('span', { class: 'kump-fcount' });

    body.replaceChildren(
      codeBox,
      form,
      msg,
      reqBox,
      el('h3', { class: 'kump-subtitle' }, t('friends'), ' ', count),
      listBox,
    );

    view = {
      name: 'list',
      renderRequests(list) {
        reqBox.hidden = list.length === 0;
        reqBox.replaceChildren(
          el('h3', { class: 'kump-subtitle' }, t('requests')),
          ...list.map((r) => el('div', { class: 'kump-frow' },
            avatarBadge(r.avatar, r.name),
            el('div', { class: 'kump-fmain' }, el('strong', {}, r.name)),
            el('button', { class: 'kump-btn kump-btn-primary kump-fsmall', onclick: (e) => act(e.currentTarget, () => acceptFriendRequest(r.uid)) }, t('accept')),
            el('button', { class: 'kump-btn kump-fsmall', onclick: (e) => act(e.currentTarget, () => declineFriendRequest(r.uid)) }, t('decline')))),
        );
      },
      renderFriends() {
        count.textContent = friends.length ? `(${friends.length})` : '';
        if (!friends.length) {
          listBox.replaceChildren(el('p', { class: 'kump-note' }, t('empty')));
          return;
        }
        listBox.replaceChildren(...friends.map((f) => friendRow(f)));
      },
    };
    view.renderFriends();
    view.renderRequests(requestsList);

    async function act(btn, fn) {
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        console.warn('[kump] amis', err);
        say(msg, t('error'), 'kump-warn');
        btn.disabled = false;
      }
    }

    function friendRow(f) {
      const here = f.online && f.game === getGameId();
      const status = f.online
        ? `${t(f.status === 'playing' ? 'playing' : 'online')} · ${here ? t('sameGame') : f.gameName ?? ''}`
        : `${t('offline')}${f.lastSeen ? ` · ${t('seen', { ago: ago(f.lastSeen) })}` : ''}`;
      const inviteBtn = f.online
        ? el('button', {
            class: 'kump-btn kump-btn-primary kump-fsmall',
            disabled: f.status === 'playing',
            title: f.status === 'playing' ? t('playing') : null,
            onclick: (e) => {
              e.stopPropagation();
              invite(e.currentTarget, f);
            },
          }, t('invite'))
        : null;
      const unread = f.unread ? el('span', { class: 'kump-fbadge', 'aria-label': `${f.unread} non lus` }, String(f.unread > 99 ? '99+' : f.unread)) : null;
      const row = el('div', {
        class: `kump-frow kump-fclick${f.online ? ' kump-fon' : ''}`,
        role: 'listitem',
        tabindex: '0',
        onclick: () => showChat(f.uid),
        onkeydown: (e) => (e.key === 'Enter' ? showChat(f.uid) : null),
      },
      avatarBadge(f.avatar, f.name, f.online ? (f.status === 'playing' ? 'busy' : 'on') : 'off'),
      el('div', { class: 'kump-fmain' }, el('strong', {}, f.name), el('span', { class: 'kump-fstatus' }, status)),
      unread,
      inviteBtn,
      el('button', {
        class: 'kump-btn kump-fsmall kump-fchat',
        'aria-label': `${t('chat')} — ${f.name}`,
        onclick: (e) => {
          e.stopPropagation();
          showChat(f.uid);
        },
      }, '💬'));
      return row;
    }

    async function invite(btn, f) {
      btn.disabled = true;
      try {
        if (options.onInvite) {
          await options.onInvite(f);
        } else {
          await sendInvite(f.uid, {
            url: options.inviteUrl ?? `${location.origin}${location.pathname}`,
            gameName: options.gameName ?? getGameId(),
          });
          say(msg, t('invited', { name: f.name }), 'kump-ok');
        }
      } catch (err) {
        console.warn('[kump] invitation', err);
        say(msg, t(err?.code in SOCIAL_TEXT ? err.code : 'error'), 'kump-warn');
      } finally {
        btn.disabled = false;
      }
    }
  }

  function showChat(uid) {
    if (view.name === 'chat' && view.uid === uid) return;
    view.off?.();
    const friend = () => friends.find((f) => f.uid === uid) ?? { uid, name: '…', online: false };
    const header = el('div', { class: 'kump-fchat-head' });
    const log = el('div', { class: 'kump-fchat-log', role: 'log', 'aria-live': 'polite' });
    const msg = el('p', { class: 'kump-fmsg', hidden: true, role: 'status' });
    const input = el('input', { class: 'kump-input', maxlength: '300', placeholder: t('chatPlaceholder'), autocomplete: 'off', 'aria-label': t('chatPlaceholder') });
    const sendBtn = el('button', { class: 'kump-btn kump-btn-primary kump-fsend', type: 'submit', 'aria-label': t('send') }, '➤');
    const form = el('form', {
      class: 'kump-row kump-fchat-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value;
        if (!text.trim() || sendBtn.disabled) return;
        sendBtn.disabled = true;
        const r = await sendMessage(uid, text).catch(() => ({ ok: false, reason: 'error' }));
        sendBtn.disabled = false;
        if (r.ok) {
          input.value = '';
          say(msg, '');
        } else say(msg, t(r.reason in SOCIAL_TEXT ? r.reason : 'error'), 'kump-warn');
        input.focus();
      },
    }, input, sendBtn);

    body.replaceChildren(header, log, msg, form);
    const offChat = watchChat(uid, (list) => {
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.replaceChildren(...(list.length
        ? list.map((m) => el('div', { class: `kump-fmsgline ${m.mine ? 'kump-mine' : ''}` },
            el('span', { class: 'kump-fbubble' }, m.text),
            el('time', {}, m.at ? new Date(m.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '')))
        : [el('p', { class: 'kump-note' }, t('chatEmpty'))]));
      if (atBottom || list.at(-1)?.mine) log.scrollTop = log.scrollHeight;
      markRead(uid);
    });
    view = {
      name: 'chat',
      uid,
      off: offChat,
      renderHeader() {
        const f = friend();
        header.replaceChildren(
          el('button', { class: 'kump-btn kump-fsmall kump-fback', onclick: () => backToList() }, `‹ ${t('back')}`),
          avatarBadge(f.avatar, f.name, f.online ? (f.status === 'playing' ? 'busy' : 'on') : 'off'),
          el('div', { class: 'kump-fmain' },
            el('strong', {}, f.name),
            el('span', { class: 'kump-fstatus' }, f.online ? `${t(f.status === 'playing' ? 'playing' : 'online')} · ${f.gameName ?? ''}` : t('offline'))),
          el('button', {
            class: 'kump-btn kump-btn-danger kump-fsmall',
            title: t('remove'),
            'aria-label': t('remove'),
            onclick: async () => {
              if (!window.confirm(t('removeConfirm', { name: f.name }))) return;
              await removeFriend(uid).catch(() => {});
              backToList();
            },
          }, '✕'),
        );
      },
    };
    view.renderHeader();
    input.focus();
  }

  function backToList() {
    view.off?.();
    showList(lastCode);
  }

  return panel;
}

// ---------------------------------------------------------------- démarrage par un jeu : présence, invitations, badge

/**
 * Démarre les amis pour ce jeu : présence (« en ligne sur <jeu> »), carte publique (avatar), réception des invitations
 * (carte avec « Rejoindre » — qui emmène sur l'autre jeu s'il le faut) et compteur pour le bouton « Amis ».
 * Ne fait RIEN (renvoie `null`) sans compte réel : un invité n'a pas d'amis.
 *
 * @param {object} opts
 * @param {string} opts.gameName                  nom affiché du jeu (« Line Tower War »)
 * @param {{game: string, id: string}} [opts.avatar]  avatar à publier (facultatif)
 * @param {(n: number) => void} [opts.onBadge]    messages non lus + demandes reçues, à afficher sur le bouton « Amis »
 * @param {(invite: object) => boolean|void} [opts.onJoin]  invitation acceptée POUR CE JEU : le jeu la gère lui-même s'il renvoie
 *   `true` (ex. rejoindre la partie sans recharger) ; sinon le module ouvre `invite.url`.
 * @param {() => object} [opts.friendsOptions]   options passées à `openKumpFriends()` quand une notification ouvre le panneau
 * @param {Record<string, string>} [opts.messages]
 * @returns {Promise<{setStatus: (s: 'menu'|'playing') => Promise<void>, setAvatar: (a: object) => Promise<unknown>, stop: () => Promise<void>} | null>}
 */
export async function startKumpSocial(opts = {}) {
  applySocialStyles();
  const acc = await socialAccount();
  if (!acc.ok) return null;
  const t = (k, vars) => fill(opts.messages?.[k] ?? SOCIAL_TEXT[k] ?? k, vars);
  await publishProfile({ avatar: opts.avatar }).catch((err) => console.warn('[kump] profil public', err));
  const presence = await startPresence({ gameName: opts.gameName, status: opts.status });
  let status = opts.status ?? 'menu';
  let requests = 0;
  let unread = 0;
  let lastByFriend = {};
  const badge = () => opts.onBadge?.(requests + unread);
  const offs = [];

  offs.push(watchRequests((list) => {
    requests = list.length;
    badge();
  }));
  offs.push(watchUnread((n, by) => {
    // Notification discrète pour un message arrivé alors que le panneau n'est pas sur cette conversation.
    for (const [uid, count] of Object.entries(by)) {
      if (count > (lastByFriend[uid] ?? 0) && !openPanel) {
        getPublicProfile(uid)
          .then((p) => toast(t('newMessage', { name: p?.name ?? '…' }), () => openKumpFriends({ ...(opts.friendsOptions?.() ?? {}), chatWith: uid })))
          .catch(() => {});
      }
    }
    lastByFriend = by;
    unread = n;
    badge();
  }));

  const shown = new Set();
  offs.push(watchInvites((list) => {
    for (const inv of list) {
      if (shown.has(inv.id)) continue;
      shown.add(inv.id);
      showInviteCard(inv);
    }
  }));

  function showInviteCard(inv) {
    const sameGame = inv.game === getGameId();
    const notes = [];
    if (!sameGame) notes.push(t('inviteOtherGame', { game: opts.gameName ?? getGameId(), target: inv.gameName }));
    if (status === 'playing') notes.push(t('inviteLeaveMatch'));
    const card = el('div', { class: 'kump-invite', role: 'alertdialog', 'aria-label': t('inviteFrom', { name: inv.name }) },
      el('div', { class: 'kump-invite-top' },
        el('span', { class: 'kump-favatar kump-invite-ic', 'aria-hidden': 'true' }, '⚔'),
        el('div', { class: 'kump-fmain' },
          el('strong', {}, t('inviteFrom', { name: inv.name })),
          el('span', { class: 'kump-fstatus' }, inv.gameName))),
      notes.length ? el('p', { class: 'kump-invite-note' }, notes.join(' ')) : null,
      el('div', { class: 'kump-row' },
        el('button', { class: 'kump-btn kump-btn-primary', onclick: () => answer('accepted') }, t('join')),
        el('button', { class: 'kump-btn', onclick: () => answer('declined') }, t('decline'))));
    const timer = setTimeout(() => card.remove(), Math.max(5000, 120000 - (Date.now() - inv.at)));
    document.body.append(card);

    async function answer(a) {
      clearTimeout(timer);
      card.remove();
      await respondInvite(inv, a);
      if (a !== 'accepted') return;
      if (sameGame && opts.onJoin?.(inv) === true) return;
      if (!isSafeInviteUrl(inv.url)) return console.warn('[kump] invitation vers une adresse non autorisée ignorée', inv.url);
      await presence?.stop();
      location.assign(inv.url);
    }
  }

  return {
    async setStatus(s) {
      status = s === 'playing' ? 'playing' : 'menu';
      await presence?.setStatus(status);
    },
    setAvatar(avatar) {
      return publishProfile({ avatar }).catch(() => null);
    },
    async stop() {
      offs.forEach((off) => off());
      await presence?.stop();
    },
  };
}

/** Petite notification cliquable (nouveau message). */
function toast(text, onClick) {
  const node = el('button', { class: 'kump-ftoast', type: 'button', onclick: () => { node.remove(); onClick?.(); } }, '💬 ', text);
  document.body.append(node);
  setTimeout(() => node.remove(), 6000);
}

// ---------------------------------------------------------------- styles (injectés une fois, variables --kump-*)

const STYLE_ID = 'kump-social-styles';
const CSS = `
.kump-friends-card { width: min(420px, 100%); }
.kump-fcode { display: grid; justify-items: center; gap: 6px; margin-bottom: 10px; padding: 12px; border: 1px solid var(--kump-border); border-radius: var(--kump-radius-sm); background: var(--kump-surface-2); }
.kump-fcode .kump-label { margin: 0; }
.kump-fcode-value { font-size: 1.7rem; letter-spacing: .22em; color: var(--kump-accent); font-variant-numeric: tabular-nums; }
.kump-fcopy { padding: 6px 12px; font-size: .85rem; }
.kump-fadd { margin: 4px 0 6px; }
.kump-fcode-input { text-transform: uppercase; letter-spacing: .18em; }
.kump-fmsg { margin: 4px 0 8px; font-size: .85rem; color: var(--kump-text-dim); }
.kump-fmsg[hidden] { display: none; }
.kump-fmsg.kump-ok { color: var(--kump-accent); }
.kump-fmsg.kump-warn { color: var(--kump-danger); }
.kump-fcount { color: var(--kump-text-dim); font-weight: 400; }
.kump-freqs[hidden] { display: none; }
.kump-flist { display: grid; gap: 6px; }
.kump-frow { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--kump-border); border-radius: var(--kump-radius-sm); background: var(--kump-surface-2); }
.kump-fclick { cursor: pointer; }
.kump-fclick:hover, .kump-fclick:focus-visible { border-color: var(--kump-accent); outline: none; }
.kump-fmain { flex: 1; min-width: 0; display: grid; }
.kump-fmain strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kump-fstatus { font-size: .75rem; color: var(--kump-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kump-fon .kump-fstatus { color: var(--kump-accent); }
.kump-fsmall { padding: 6px 10px; font-size: .8rem; }
.kump-fbadge { flex: none; min-width: 20px; height: 20px; padding: 0 6px; display: grid; place-items: center; border-radius: 999px; background: var(--kump-danger); color: #fff; font-size: .72rem; font-weight: 800; }
.kump-favatar { position: relative; flex: none; width: 42px; height: 42px; display: grid; place-items: center; border-radius: 50%; background: var(--kump-surface); border: 2px solid var(--kump-border); color: var(--kump-accent); font-weight: 800; font-size: 1.1rem; }
.kump-favatar-img { background-repeat: no-repeat; }
.kump-dot { position: absolute; right: -2px; bottom: -2px; width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--kump-surface); }
.kump-dot-on { background: #3ddc5b; }
.kump-dot-busy { background: #ffb02e; }
.kump-dot-off { background: #7a7f8c; }
.kump-fchat-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.kump-fback { flex: none; }
.kump-fchat-log { height: min(46vh, 360px); overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--kump-border); border-radius: var(--kump-radius-sm); background: rgba(0, 0, 0, .25); }
.kump-fmsgline { display: flex; flex-direction: column; align-items: flex-start; max-width: 85%; }
.kump-fmsgline.kump-mine { align-self: flex-end; align-items: flex-end; }
.kump-fbubble { padding: 7px 11px; border-radius: 14px 14px 14px 4px; background: var(--kump-surface-2); border: 1px solid var(--kump-border); overflow-wrap: anywhere; }
.kump-mine .kump-fbubble { border-radius: 14px 14px 4px 14px; background: color-mix(in srgb, var(--kump-accent) 30%, var(--kump-surface-2)); }
.kump-fmsgline time { font-size: .65rem; color: var(--kump-text-dim); margin-top: 2px; }
.kump-fchat-form { margin-top: 8px; }
.kump-fsend { flex: none; }
.kump-invite { position: fixed; z-index: 9100; left: 50%; top: max(12px, env(safe-area-inset-top)); transform: translateX(-50%); width: min(360px, calc(100% - 24px)); padding: 12px; border-radius: var(--kump-radius); background: var(--kump-surface); border: 1px solid var(--kump-accent); color: var(--kump-text); font-family: var(--kump-font); box-shadow: 0 12px 34px rgba(0, 0, 0, .55); animation: kump-drop .35s ease-out; box-sizing: border-box; }
.kump-invite * { box-sizing: border-box; }
.kump-invite-top { display: flex; align-items: center; gap: 10px; }
.kump-invite-note { margin: 8px 0 0; font-size: .8rem; color: var(--kump-text-dim); }
.kump-invite .kump-row { margin-top: 10px; }
.kump-invite .kump-btn { flex: 1; }
.kump-ftoast { position: fixed; z-index: 9050; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); transform: translateX(-50%); max-width: calc(100% - 24px); padding: 10px 16px; border-radius: 999px; border: 1px solid var(--kump-border); background: var(--kump-surface); color: var(--kump-text); font: inherit; font-family: var(--kump-font); cursor: pointer; box-shadow: 0 8px 24px rgba(0, 0, 0, .5); animation: kump-rise .3s ease-out; }
@keyframes kump-drop { from { opacity: 0; transform: translate(-50%, -16px); } }
@keyframes kump-rise { from { opacity: 0; transform: translate(-50%, 16px); } }
@media (prefers-reduced-motion: reduce) { .kump-invite, .kump-ftoast { animation: none; } }
`;

function applySocialStyles() {
  if (typeof document === 'undefined') return;
  applyKumpTheme(); // variables + styles communs (dialogue, boutons, champs)
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}
