// Déploiement des règles de la Realtime Database KUMP par l'API REST officielle (procédure de kump-account/EXPLOITATION.md) :
// jeton OAuth du compte de service de kump.fr, SAUVEGARDE des règles en service, comparaison avec la version précédente
// du dépôt (HEAD) — une différence = quelqu'un a changé la production à la main → ARRÊT —, puis PUT, puis relecture.
// Usage (depuis kump-account) : node tools/deployer-regles-rtdb.mjs [--envoyer]   (sans --envoyer : vérification seulement).
// Aucun secret n'est affiché. Sauvegardes des règles en service : dossier temporaire du système (chemin affiché).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ENVOYER = process.argv.includes('--envoyer');
const KA = path.resolve(import.meta.dirname, '..');
const DOSSIER = fs.mkdtempSync(path.join(os.tmpdir(), 'regles-kump-'));
// compte de service de kump.fr (jamais dans ce dépôt)
const env = fs.readFileSync(process.env.KUMP_ENV ?? path.resolve(KA, '../Kump.fr/.env.local'), 'utf8');
const ligne = env.split(/\r?\n/).find((l) => l.startsWith('KUMP_SERVICE_ACCOUNT='));
let brut = ligne.slice('KUMP_SERVICE_ACCOUNT='.length).trim();
if ((brut.startsWith("'") && brut.endsWith("'")) || (brut.startsWith('"') && brut.endsWith('"'))) brut = brut.slice(1, -1);
let compte;
try { compte = JSON.parse(brut); } catch { compte = JSON.parse(Buffer.from(brut, 'base64').toString('utf8')); }
const cle = compte.private_key.replace(/\\n/g, '\n');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const maintenant = Math.floor(Date.now() / 1000);
const corps = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
  iss: compte.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  aud: 'https://oauth2.googleapis.com/token', iat: maintenant, exp: maintenant + 3600,
})}`;
const signature = crypto.createSign('RSA-SHA256').update(corps).sign(cle).toString('base64url');
const rep = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${corps}.${signature}` }),
});
const jeton = (await rep.json()).access_token;
if (!jeton) throw new Error(`jeton OAuth refusé (HTTP ${rep.status})`);
const URL_REGLES = 'https://kump-812dd-default-rtdb.firebaseio.com/.settings/rules.json';
const lire = async () => {
  const r = await fetch(URL_REGLES, { headers: { Authorization: `Bearer ${jeton}` } });
  if (!r.ok) throw new Error(`lecture des règles : HTTP ${r.status}`);
  return r.text();
};
// les règles RTDB acceptent des commentaires : on compare après normalisation JSON (sans commentaires)
const norme = (t) => JSON.stringify(JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')));
const enService = await lire();
fs.writeFileSync(`${DOSSIER}/regles-en-service-${Date.now()}.json`, enService);
// la version PRÉCÉDENTE des règles dans le dépôt : celle d'avant le dernier commit qui les a changées (si le fichier est
// commité tel quel), sinon celle de HEAD (fichier modifié, pas encore commité)
const git = (c) => execSync(c, { cwd: KA, encoding: 'utf8' });
const commite = git('git status --porcelain -- database.rules.json').trim() === '';
const ref = commite ? git('git log --format=%H -n 2 -- database.rules.json').trim().split(/\s+/)[1] : 'HEAD';
const avant = git(`git show ${ref}:database.rules.json`);
const nouvelles = fs.readFileSync(`${KA}/database.rules.json`, 'utf8');
const identiques = norme(enService) === norme(avant);
console.log(`règles en service sauvegardées (${DOSSIER}) ; identiques à la version précédente du dépôt : ${identiques ? 'OUI' : 'NON'}`);
if (!identiques) { console.log('ARRÊT : la production diffère du dépôt (changée à la main ?) — rien envoyé.'); process.exit(2); }
if (norme(nouvelles) === norme(enService)) { console.log('rien à changer'); process.exit(0); }
if (!ENVOYER) { console.log('vérification seulement : les nouvelles règles seraient envoyées (relancer avec --envoyer).'); process.exit(0); }
const put = await fetch(URL_REGLES, { method: 'PUT', headers: { Authorization: `Bearer ${jeton}`, 'content-type': 'application/json' }, body: nouvelles });
console.log(`envoi : HTTP ${put.status} ${(await put.text()).slice(0, 120)}`);
const apres = await lire();
console.log(`relecture : les règles en service sont les nouvelles : ${norme(apres) === norme(nouvelles) ? 'OUI' : 'NON'}`);
