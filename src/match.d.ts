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
  leave(): Promise<void>;
}
