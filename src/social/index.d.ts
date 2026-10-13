// Types du point d'entrée `kump-account/social` (amis KUMP). À tenir à jour avec index.js / api.js / ui.js.

export type SocialReason = 'not-ready' | 'no-database' | 'signed-out' | 'guest';
export type SocialAccount = { ok: true; uid: string; name: string } | { ok: false; reason: SocialReason };

/** Avatar publié par un jeu : l'image est retrouvée via `registerAvatarSet(game, …)`. */
export interface SocialAvatar {
  game: string;
  id: string;
}

export interface Friend {
  uid: string;
  name: string;
  code: string | null;
  avatar: SocialAvatar | null;
  online: boolean;
  /** `gameId` du jeu où l'ami est connecté. */
  game: string | null;
  gameName: string | null;
  status: 'menu' | 'playing' | 'offline';
  lastSeen: number;
  unread: number;
}

export interface FriendRequest {
  uid: string;
  name: string;
  avatar: SocialAvatar | null;
  at: number;
}

export interface Invite {
  id: string;
  from: string;
  name: string;
  game: string;
  gameName: string;
  url: string;
  code?: string;
  at: number;
}

export interface ChatMessage {
  id: string;
  from: string;
  mine: boolean;
  text: string;
  at: number;
}

export const SOCIAL_MEMBER_KEY: string;
export const INVITE_HOSTS: readonly string[];

export function socialAccount(opts?: { fresh?: boolean }): Promise<SocialAccount>;
export function isSafeInviteUrl(url: string): boolean;
export function publishProfile(opts?: { avatar?: SocialAvatar | null }): Promise<{ code: string; name: string } | null>;
export function getPublicProfile(uid: string): Promise<{ uid: string; name: string; code: string; avatar: SocialAvatar | null } | null>;

export function sendFriendRequest(code: string): Promise<
  | { ok: true; accepted?: true; name: string }
  | { ok: false; reason: 'code-not-found' | 'own-code' | 'already-friends' | 'already-sent' | SocialReason }
>;
export function watchRequests(cb: (list: FriendRequest[]) => void): () => void;
export function acceptFriendRequest(uid: string): Promise<void>;
export function declineFriendRequest(uid: string): Promise<void>;
export function removeFriend(uid: string): Promise<void>;
export function watchFriends(cb: (list: Friend[]) => void): () => void;
export function watchUnread(cb: (total: number, byFriend: Record<string, number>) => void): () => void;

export interface Presence {
  setStatus(status: 'menu' | 'playing'): Promise<void>;
  stop(): Promise<void>;
}
export function startPresence(opts: { gameName: string; status?: 'menu' | 'playing' }): Promise<Presence | null>;

export interface SentInvite {
  id: string;
  onReply(cb: (answer: 'accepted' | 'declined') => void): () => void;
  cancel(): Promise<void>;
}
export function sendInvite(uid: string, opts: { url: string; gameName: string; code?: string }): Promise<SentInvite>;
export function watchInvites(cb: (list: Invite[]) => void): () => void;
export function respondInvite(invite: Invite, answer: 'accepted' | 'declined'): Promise<void>;

export function watchChat(uid: string, cb: (list: ChatMessage[]) => void): () => void;
export function sendMessage(uid: string, text: string): Promise<{ ok: true } | { ok: false; reason: 'empty' | 'not-friends' | SocialReason }>;
export function markRead(uid: string): Promise<void>;

export const SOCIAL_TEXT: Readonly<Record<string, string>>;
export function registerAvatarSet(game: string, set: { src: string; cols: number; rows: number }): void;

export interface FriendsOptions {
  onInvite?: (friend: Friend) => void | Promise<unknown>;
  gameName?: string;
  inviteUrl?: string;
  onAccount?: () => unknown;
  chatWith?: string;
  messages?: Record<string, string>;
  onClose?: () => void;
}
export function openKumpFriends(options?: FriendsOptions): { close(): void; chat(uid: string): void };

export interface SocialController {
  setStatus(status: 'menu' | 'playing'): Promise<void>;
  setAvatar(avatar: SocialAvatar | null): Promise<unknown>;
  stop(): Promise<void>;
}
export function startKumpSocial(opts: {
  gameName: string;
  avatar?: SocialAvatar;
  status?: 'menu' | 'playing';
  onBadge?: (n: number) => void;
  /** Invitation acceptée pour CE jeu : renvoyer `true` si le jeu la gère sans recharger la page. */
  onJoin?: (invite: Invite) => boolean | void;
  friendsOptions?: () => FriendsOptions;
  messages?: Record<string, string>;
}): Promise<SocialController | null>;
