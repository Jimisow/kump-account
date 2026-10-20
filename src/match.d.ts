// Types du point d'entrée `kump-account/match` (parties en ligne à deux). Voir src/match.js et README > Parties en ligne.

export type MatchErrorCode =
  | 'not-ready' | 'no-database' | 'signed-out' | 'guest'
  | 'cancelled' | 'code-unavailable' | 'code-not-found' | 'code-taken' | 'own-code' | 'version-mismatch' | 'room-unavailable';

export function matchAccount(): Promise<
  { ok: true; uid: string; name: string } | { ok: false; reason: 'not-ready' | 'no-database' | 'signed-out' | 'guest' }
>;

export function quickMatch(opts: { version: string; onStatus?: (status: string) => void }): {
  promise: Promise<MatchRoom>;
  cancel: () => Promise<void>;
};

export function hostFriendMatch(opts: { version: string }): Promise<{
  code: string;
  promise: Promise<MatchRoom>;
  cancel: () => Promise<void>;
}>;

export function joinFriendMatch(code: string, opts: { version: string }): Promise<MatchRoom>;

export class MatchRoom {
  readonly roomId: string;
  /** 0 = le joueur qui attendait / l'hôte, 1 = celui qui a rejoint. */
  readonly seat: 0 | 1;
  readonly seed: number;
  readonly version: string;
  readonly names: [string, string];
  readonly uids: [string, string];
  readonly opponentSeat: 0 | 1;
  connectPresence(): Promise<void>;
  setReady(): Promise<void>;
  onBothReady(cb: () => void): void;
  sendTurn(index: number, payload: string): Promise<void>;
  onTurn(cb: (index: number, payload: string) => void): void;
  sendHash(index: number, hash: string): Promise<void>;
  onHash(cb: (index: number, hash: string) => void): void;
  onOpponentPresence(cb: (online: boolean) => void): void;
  /** 0.8.0 — ma propre connexion au serveur. */
  onConnected(cb: (connected: boolean) => void): void;
  /** 0.8.0 — tous les messages déjà écrits (les miens et ceux de l'adversaire), pour rejouer une partie reprise. */
  readTurns(): Promise<{ own: Map<number, string>; opp: Map<number, string> }>;
  leave(): Promise<void>;
}

/** 0.8.0 — rouvre la salle d'une partie en cours où l'on a été déconnecté. `room-unavailable` : la salle n'existe plus (partie terminée). */
export function resumeMatch(opts: { roomId: string; seat: 0 | 1 }): Promise<MatchRoom>;

// ---------------------------------------------------------------- SALONS (3-5 places, 0.7.0) — voir README > Salons en ligne

export type SalonErrorCode = MatchErrorCode | 'salon-closed' | 'not-host';

export interface SalonMember {
  uid: string;
  name: string;
  avatar?: string;
}

export interface SalonStart {
  seed: number;
  n: number;
  /** Un uid par place, `null` pour une place d'IA. */
  seats: (string | null)[];
  /** La composition du jeu, telle que l'hôte l'a donnée à `start`. */
  cfg: string;
  /** Ma place (`-1` : je n'en ai pas). */
  seat: number;
}

export function hostSalon(opts: { version: string; avatar?: string }): Promise<SalonRoom>;
/** Reprise d'une partie de salon interrompue (0.9.0) : la salle où j'ai une place, déjà « partie ». */
export function resumeSalon(opts: { roomId: string }): Promise<SalonRoom>;
export function joinSalon(code: string, opts: { version: string; avatar?: string }): Promise<SalonRoom>;

export class SalonRoom {
  readonly roomId: string;
  readonly uid: string;
  readonly name: string;
  readonly code: string;
  readonly hostUid: string;
  readonly isHost: boolean;
  readonly version: string;
  /** Renseignés au départ (`onStart`). */
  readonly seat: number | null;
  readonly seats: (string | null)[] | null;
  readonly seed: number | null;
  readonly cfg: string | null;
  readonly started: boolean;
  readonly humanSeats: number[];
  connectPresence(): Promise<void>;
  // le salon, avant le départ
  onMembers(cb: (members: SalonMember[]) => void): void;
  onLobby(cb: (text: string | null) => void): void;
  publishLobby(text: string): Promise<void>;
  setProfile(profile: { name?: string; avatar?: string }): Promise<void>;
  kick(uid: string): Promise<void>;
  onClosed(cb: () => void): void;
  onKicked(cb: () => void): void;
  start(opts: { seed: number; seats: (string | null)[]; cfg: string }): Promise<void>;
  onStart(cb: (start: SalonStart) => void): void;
  // la partie
  setReady(): Promise<void>;
  onAllReady(cb: () => void): void;
  sendTurn(index: number, payload: string): Promise<void>;
  onTurn(cb: (seat: number, index: number, payload: string) => void): void;
  sendHash(index: number, hash: string): Promise<void>;
  onHash(cb: (seat: number, index: number, hash: string) => void): void;
  onPeerPresence(cb: (seat: number, online: boolean) => void): void;
  /** Tous les messages déjà écrits (reprise) : place → (n° → chaîne). */
  readTurns(): Promise<Map<number, Map<number, string>>>;
  onConnected(cb: (online: boolean) => void): void;
  restoreStart(start: { seed: number; n: number; cfg: string; seats: Record<string, string> }): void;
  announceDrop(seat: number, turn: number): Promise<void>;
  onDrop(cb: (seat: number, turn: number) => void): void;
  leave(): Promise<void>;
}
