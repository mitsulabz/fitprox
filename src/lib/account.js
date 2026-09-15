// @ts-nocheck
/* Comptes : ce qui est propre au compte du propriétaire (J1, objectif du 1er novembre,
   compétitions) et ce qui s'applique à tout autre utilisateur (J1 = son premier jour,
   base de départ par formule). Fonctions pures, sans import (testables en Node). */

export const OWNER_UID = 'a1507f04-192c-4464-94b6-922c7a16ee27';
export const OWNER_J1 = '22/06/2026';
export const OWNER_END = '01/11/2026';
export const HORIZON_DAYS = 90; // horizon de suivi des autres utilisateurs

export const isOwner = (uid) => !!uid && uid === OWNER_UID;

// Activité au quotidien HORS sport : le sport est saisi chaque jour dans « Sport cal ».
export const ACTIVITY_LEVELS = [
  { key: '1.2', label: 'Sédentaire', hint: 'bureau, peu de marche' },
  { key: '1.35', label: 'Légère', hint: 'souvent debout, marche régulière' },
  { key: '1.5', label: 'Active', hint: 'métier physique, beaucoup de pas' },
  { key: '1.7', label: 'Très active', hint: 'travail manuel intense toute la journée' },
];

function num(v) {
  const x = parseFloat(String(v ?? '').replace(',', '.'));
  return isFinite(x) ? x : 0;
}
const pad = (n) => String(n).padStart(2, '0');
const toDs = (d) => pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
function parseDs(s) {
  const p = String(s ?? '').split('/').map(Number);
  if (p.length !== 3 || p.some((x) => !isFinite(x))) return null;
  const d = new Date(p[2], p[1] - 1, p[0]);
  return isNaN(d.getTime()) ? null : d;
}
const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// Métabolisme de base : Katch-McArdle si la masse grasse est connue, sinon Mifflin-St-Jeor.
export function bmrFrom({ sex, age, height, weight, bf }) {
  const w = num(weight), h = num(height), a = num(age), b = num(bf);
  if (!(w > 0)) return null;
  if (b > 0 && b < 70) return { bmr: Math.round(370 + 21.6 * w * (1 - b / 100)), method: 'Katch-McArdle' };
  if (!(h > 0) || !(a > 0)) return null;
  return { bmr: Math.round(10 * w + 6.25 * h - 5 * a + (sex === 'f' ? -161 : 5)), method: 'Mifflin-St-Jeor' };
}

/* Base de départ = métabolisme × activité hors sport, arrondie à 10 kcal.
   sigma = incertitude d'une formule (~12 %, 150 kcal minimum). */
export function startingBase(profile) {
  const r = bmrFrom(profile ?? {});
  if (!r) return null;
  const factor = Math.min(1.9, Math.max(1.1, num(profile.act) || 1.2));
  const base = Math.round((r.bmr * factor) / 10) * 10;
  return { base, bmr: r.bmr, factor, method: r.method, sigma: Math.max(150, Math.round(base * 0.12)) };
}

// J1 : propriétaire = 22/06/2026 ; autres = date de départ enregistrée,
// sinon premier jour avec repas ou pesée, sinon aujourd'hui.
export function userJ1(uid, data, today = new Date()) {
  if (isOwner(uid)) return OWNER_J1;
  if (parseDs(data?.startDs)) return data.startDs;
  const t0 = midnight(today);
  let min = null;
  for (const k of Object.keys(data?.days ?? {})) {
    const dd = data.days[k];
    if (!dd?.foods?.length && !(num(dd?.weight) > 0)) continue;
    const d = parseDs(k);
    if (d && (!min || d < min)) min = d;
  }
  return toDs(min && min < t0 ? min : t0);
}

// Fin de l'horizon : propriétaire = objectif du 1er novembre ; autres = aujourd'hui + 90 jours.
export function userEnd(uid, today = new Date()) {
  if (isOwner(uid)) return OWNER_END;
  const d = midnight(today);
  d.setDate(d.getDate() + HORIZON_DAYS);
  return toDs(d);
}

// Réglage de base utilisé tant qu'aucun n'est enregistré.
export function defaultSettings(uid, data) {
  if (isOwner(uid)) return { baseRef: 2020, poidsRef: 97.92, adaptCoef: 0.12, source: 'legacy' };
  const sb = startingBase(data?.profile);
  if (sb) return { baseRef: sb.base, poidsRef: num(data.profile.weight), adaptCoef: 0.12, source: 'formule' };
  let w = 0, lastT = -1;
  for (const k of Object.keys(data?.days ?? {})) {
    const d = parseDs(k), v = num(data.days[k]?.weight);
    if (d && v > 0 && d.getTime() > lastT) { lastT = d.getTime(); w = v; }
  }
  return { baseRef: 2000, poidsRef: w || 75, adaptCoef: 0.12, source: 'defaut' };
}

export function effectiveSettingsLog(uid, data) {
  const log = data?.programme?.settingsLog;
  if (Array.isArray(log) && log.length) return log;
  return [{ from: userJ1(uid, data), ...defaultSettings(uid, data) }];
}

/* A priori de l'estimateur : la formule du profil (information indépendante des mesures),
   sinon la base en vigueur avec une incertitude large (les mesures dominent vite). */
export function basePrior(uid, data, current) {
  const sb = isOwner(uid) ? null : startingBase(data?.profile);
  if (sb) return { base: sb.base, sigma: sb.sigma, poids: num(data.profile.weight), source: 'formule' };
  return { base: current?.baseRef ?? 2000, sigma: 600, poids: current?.poidsRef ?? 0, source: 'reglage' };
}

// Une base « solide » (mesurée) fige le passé ; une estimation peut encore réécrire l'historique.
export const isEstimateSource = (s) => s === 'formule' || s === 'estimation' || s === 'defaut';

// Accueil : compte autre que le propriétaire, sans base enregistrée, ni fait ni reporté.
export function needsBaseSetup(uid, data) {
  if (!uid || !data || isOwner(uid)) return false;
  if (data.baseSetupDone || data.baseSetupSkipped) return false;
  const log = data?.programme?.settingsLog;
  return !(Array.isArray(log) && log.length);
}
