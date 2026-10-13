// Accès PARTAGÉ à la Realtime Database du projet KUMP, pour les points d'entrée qui en ont besoin (`kump-account/match`,
// `kump-account/social`). `index.js` ne l'importe pas : un jeu sans multijoueur ni amis ne télécharge pas `firebase/database`.
//
// Pourquoi un fichier commun plutôt qu'un `getDatabase()` dans chaque module : `connectDatabaseEmulator()` LÈVE s'il est appelé
// une seconde fois sur la même instance (ou après la première requête). Deux modules qui se brancheraient chacun sur
// l'émulateur feraient planter le second. Une seule instance, un seul branchement.

import { getDatabase, connectDatabaseEmulator } from 'firebase/database';
import { getKumpContext, requireReady } from './core.js';
import { getProfile } from './profile.js';

let database = null;

/** Instance unique de la base (URL : `databaseURL` de la config passée à initKump). */
export function rtdb() {
  const { app, emulators } = getKumpContext();
  if (!database) {
    database = getDatabase(app);
    if (emulators?.database) {
      const [host, port] = emulators.database.split(':');
      connectDatabaseEmulator(database, host, Number(port)); // développement : émulateur local
    }
  }
  return database;
}

/**
 * Le joueur a-t-il un compte RÉEL (email ou Google) utilisable avec la base temps réel ?
 * Partagé par le multijoueur et les amis : les deux exigent un pseudo choisi et un compte qui ne disparaît pas avec l'appareil.
 * @returns {Promise<{ok: true, uid: string, name: string} | {ok: false, reason: 'not-ready'|'no-database'|'signed-out'|'guest'}>}
 */
export async function realAccount(fnName = 'realAccount') {
  if (!requireReady(fnName)) return { ok: false, reason: 'not-ready' };
  const { app, auth } = getKumpContext();
  if (!app.options.databaseURL) return { ok: false, reason: 'no-database' };
  await auth.authStateReady?.(); // au chargement, la session persistée n'est pas encore restaurée : currentUser vaudrait null
  const user = auth.currentUser;
  if (!user) return { ok: false, reason: 'signed-out' };
  if (user.isAnonymous) return { ok: false, reason: 'guest' };
  const profile = await getProfile();
  return { ok: true, uid: user.uid, name: String(profile?.displayName ?? 'Joueur').slice(0, 24) };
}
