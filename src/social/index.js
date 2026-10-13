// Point d'entrée `kump-account/social` : les AMIS KUMP (API + écrans prêts à l'emploi).
//
// Séparé de `index.js` et de `ui/` : il tire `firebase/database` (comme `kump-account/match`), qu'un jeu sans amis n'a pas
// à télécharger. Voir api.js (schéma, règles, décisions) et ui.js (écrans).

export {
  SOCIAL_MEMBER_KEY,
  INVITE_HOSTS,
  socialAccount,
  isSafeInviteUrl,
  publishProfile,
  getPublicProfile,
  sendFriendRequest,
  watchRequests,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  watchFriends,
  watchUnread,
  startPresence,
  sendInvite,
  watchInvites,
  respondInvite,
  watchChat,
  sendMessage,
  markRead,
} from './api.js';

export { SOCIAL_TEXT, registerAvatarSet, openKumpFriends, startKumpSocial } from './ui.js';
