// Types du module `kump-account`.
//
// Le module lui-même est écrit en JavaScript (aucune étape de build : les
// jeux comme le site l'importent tel quel). Ce fichier existe pour les
// projets TypeScript — kump.fr en premier — afin d'avoir l'autocomplétion et
// la vérification de types sans imposer une compilation au module.
//
// À tenir à jour avec `src/index.js` : une fonction exportée là-bas et
// absente ici ne sera pas typée, et TypeScript la refusera.

export interface KumpInitOptions {
  firebaseConfig: Record<string, string | undefined>;
  /** Identifiant du jeu. Absent pour un client de lecture seule (kump.fr). */
  gameId?: string;
  /** Base Firestore nommée, si le projet n'utilise pas "(default)". */
  databaseId?: string;
  /** URL du serveur de validation des parties (ex. "https://www.kump.fr"). */
  apiBaseUrl?: string;
}

export interface KumpRunResult {
  accepted: boolean;
  /**
   * La partie est en file d'attente locale et repartira plus tard. Deux cas :
   * le serveur était injoignable, ou il a répondu « trop tôt » (`retryable`,
   * réserve de temps réel épuisée) — ce dernier n'est PAS un refus, la partie
   * est valide, elle arrive juste trop vite.
   */
  queued?: boolean;
  /**
   * Le serveur a répondu non, définitivement (butin hors de portée, niveau
   * inconnu) : la partie est abandonnée, jamais réessayée.
   */
  refused?: boolean;
  reason?: string;
  coins?: number;
  percent?: number;
  newDiamonds?: number;
  trophies?: string[];
}

export interface KumpTimestamp {
  seconds?: number;
  nanoseconds?: number;
}

export interface KumpProfile {
  uid: string;
  displayName: string;
  isGuest: boolean;
  email: string | null;
  totalPlaytimeMs: number;
  createdAt: KumpTimestamp | null;
  isAdmin: boolean;
}

export interface KumpTrophy {
  id: string;
  unlockedAt: KumpTimestamp | null;
}

export interface KumpGameEntry {
  gameId: string;
  playtimeMs: number;
  lastPlayedAt: KumpTimestamp | null;
  trophies: KumpTrophy[];
  data: Record<string, unknown>;
}

export interface KumpFullProfile {
  uid: string;
  displayName: string;
  email: string | null;
  isGuest: boolean;
  isAdmin: boolean;
  createdAt: KumpTimestamp | null;
  totalPlaytimeMs: number;
  games: KumpGameEntry[];
}

export interface KumpResult {
  success: boolean;
  error?: string;
}

export interface KumpPurchaseResult extends KumpResult {
  alreadyOwned?: boolean;
  remaining?: number;
}

export interface KumpUser {
  uid: string;
  isAnonymous: boolean;
  email: string | null;
}

// --- Initialisation ---
export function initKump(options: KumpInitOptions): boolean;
export function isKumpReady(): boolean;
export function getKumpContext(): Record<string, unknown>;

// --- Identité ---
export function ensureSignedIn(): Promise<KumpUser | null>;
export function onUserChanged(callback: (user: KumpUser | null) => void): () => void;
export function getCurrentUser(): KumpUser | null;
/** Jeton à envoyer à un backend qui doit vérifier l'identité de l'appelant. */
export function getIdToken(): Promise<string | null>;
export function isGuest(): boolean;
export function linkWithEmail(email: string, password: string): Promise<KumpResult>;
export function signInWithEmail(email: string, password: string): Promise<KumpResult>;
export function sendPasswordReset(email: string): Promise<KumpResult>;
export function signOutKump(): Promise<void>;

// --- Fournisseurs externes ---
// `link*` rattache le compte anonyme courant (garde la progression) — pour un
// jeu. `signIn*` bascule vers le compte du fournisseur — pour un site.
export function signInWithGoogle(): Promise<KumpResult>;
export function signInWithApple(): Promise<KumpResult>;
export function linkWithGoogle(): Promise<KumpResult>;
export function linkWithApple(): Promise<KumpResult>;

// --- Profil ---
export function getProfile(): Promise<KumpProfile | null>;
export function getFullProfile(): Promise<KumpFullProfile | null>;
export function setDisplayName(displayName: string): Promise<KumpResult>;
export function addPlaytime(ms: number): Promise<boolean>;

// --- Données de jeu ---
export function loadGameData(): Promise<Record<string, unknown> | null>;
export function saveGameData(data: Record<string, unknown>): Promise<boolean>;
export function unlockTrophy(trophyId: string): Promise<boolean>;
export function getUnlockedTrophies(): Promise<KumpTrophy[]>;

// --- Achats ---
export function purchaseGameItem(options: {
  itemId: string;
  price: number;
  ownedField: string;
  equippedField?: string;
  coinsField?: string;
}): Promise<KumpPurchaseResult>;

// --- Parties validées par le serveur ---
export function submitRun(run: Record<string, unknown>): Promise<KumpRunResult>;
export function flushRunQueue(): Promise<{ sent: number; remaining: number }>;
export function pendingRunCount(): number;
export function purchaseFromServer(options: { kind: "skin" | "trail"; itemId: string }): Promise<
  KumpResult & { coins?: number; alreadyOwned?: boolean; price?: number }
>;

// --- Classements ---
export function submitScore(stats: Record<string, unknown>): Promise<KumpResult>;
export function fetchLeaderboard(options: {
  sortBy: string;
  thenBy?: string;
  max?: number;
}): Promise<Array<Record<string, unknown> & { uid: string }>>;
export function fetchRank(options: {
  sortBy: string;
  thenBy?: string;
  value: number;
  thenValue?: number;
}): Promise<number | null>;
