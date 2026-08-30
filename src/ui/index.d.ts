// Types de la couche visible (`kump-account/ui`).

export interface KumpStatTile {
  label: string;
  /** Lit une valeur dans les données de jeu du joueur. Le module ne peut pas
   *  les deviner : les inventer donnerait des chiffres faux. */
  value: (data: Record<string, unknown>) => string | number | null;
}

export interface KumpScreenOptions {
  /** Remplacements de messages joueur — seulement ceux qu'on veut changer. */
  messages?: Record<string, string>;
  /** Appelé quand l'identité, le solde ou l'équipement changent. */
  onChange?: () => void;
}

export interface KumpAccountOptions extends KumpScreenOptions {
  stats?: KumpStatTile[];
  profileUrl?: string;
}

export interface KumpScreen {
  close: () => void;
}

/** Écran de compte : connexion, création, profil. `null` si `initKump()` n'a
 *  pas été appelée (le jeu doit rester jouable sans compte). */
export function openKumpAccount(options?: KumpAccountOptions): KumpScreen | null;

/** Écran de boutique : catalogue, achat, équipement. */
export function openKumpShop(options?: KumpScreenOptions): KumpScreen | null;

/** Injecte la feuille de style du module et applique des variables. */
export function applyKumpTheme(overrides?: Record<string, string>): void;
export const KUMP_THEME_DEFAULTS: Record<string, string>;

export function el(tag: string, attrs?: Record<string, unknown>, ...children: unknown[]): HTMLElement;
export function openDialog(options: { title?: string; label?: string; onClose?: () => void }): {
  body: HTMLElement;
  card: HTMLElement;
  close: () => void;
};
export function formatDuration(ms: number): string;
