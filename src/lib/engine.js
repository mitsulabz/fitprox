// @ts-nocheck
/* FitProX v11 — moteur de dépense dynamique.
   Modèle mesuré (remplace BMR×facteur) : base datée + ajustement poids + thermogénèse adaptative,
   + modèle glycogène/eau pour le "poids ajusté". Tout est causal (le passé ne se réécrit pas
   quand on change un réglage aujourd'hui : chaque jour utilise les réglages EN VIGUEUR ce jour-là). */

export const K_POIDS = 12;        // kcal/j perdus par kg perdu (tissu + coût déplacement)
export const ADAPT_DEFAULT = 0.12;
export const ADAPT_MAX = 0.15;
export const GLYCO_ABSORB = 0.8;
export const GLYCO_STOCK_MAX = 500;
export const GLYCO_STOCK_INIT = 250;
export const KCAL_PER_KG = 7300;  // énergie par kg de poids perdu (tissu mixte), pour l'estimation de base
export const APPORT_FLOOR = 1700;

export function nf(v) { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; }

// "DD/MM/YYYY" -> ms (minuit local)
export function dsToMs(ds) {
  const p = String(ds).split('/').map(Number);
  if (p.length !== 3) return NaN;
  return new Date(p[2], p[1] - 1, p[0], 0, 0, 0, 0).getTime();
}
export function msToDs(ms) {
  const d = new Date(ms);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

// réglage en vigueur à une date (le plus récent dont from <= jour)
export function settingsFor(settingsLog, t) {
  let best = null;
  for (const s of settingsLog || []) {
    const ft = typeof s.fromT === 'number' ? s.fromT : dsToMs(s.from);
    if (ft <= t && (!best || ft >= best._ft)) best = { ...s, _ft: ft };
  }
  return best || { baseRef: 2020, poidsRef: 97.92, adaptCoef: ADAPT_DEFAULT, _ft: -Infinity };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

/* dateList : [{ds, t}] trié ascendant (un jour par entree, J1 -> fin).
   info(ds) -> { weight, bf, eaten, gluc, prot, extraKcal, sportKcal, logged }
   Renvoie { list:[record], byKey:{ds:record} }. Chaque record est CAUSAL. */
export function buildTimeline({ dateList, settingsLog, todayTime, dayFrac, info }) {
  // pesées réelles (par valeur), pour la moyenne glissante 7 pesées
  const weighIns = [];
  for (const { ds, t } of dateList) {
    const w = nf(info(ds).weight);
    if (w > 0) weighIns.push({ t, w });
  }
  weighIns.sort((a, b) => a.t - b.t);
  const pm7At = (t) => {
    const upto = weighIns.filter(x => x.t <= t);
    if (!upto.length) return null;
    const last7 = upto.slice(-7);
    return mean(last7.map(x => x.w));
  };

  const recentDef = [];   // déficits réels des 14 derniers jours loggés
  const recentGluc = [];  // glucides des 14 derniers jours loggés
  let stock = GLYCO_STOCK_INIT;
  const list = [];
  const byKey = {};

  for (const { ds, t } of dateList) {
    const di = info(ds);
    const st = settingsFor(settingsLog, t);
    const pm7 = pm7At(t);
    const pm7v = pm7 != null ? pm7 : st.poidsRef;

    // thermogénèse adaptative : sur le déficit moyen des 14 j PRÉCÉDENTS (causal).
    // adaptCoef 0 = aucune (base mesurée, qui contient déjà le ralentissement) ; seul un réglage absent vaut le défaut.
    const defAvg14 = mean(recentDef);
    const rawAC = st.adaptCoef;
    const adaptCoef = clamp(rawAC == null || rawAC === '' ? ADAPT_DEFAULT : nf(rawAC), 0, ADAPT_MAX);
    const adaptation = Math.round(adaptCoef * Math.max(0, defAvg14));

    const base = st.baseRef - K_POIDS * (st.poidsRef - pm7v) - adaptation;
    const isToday = t === todayTime;
    const isFuture = t > todayTime;
    const frac = isToday ? dayFrac : 1;
    const sportK = nf(di.sportKcal) + nf(di.extraKcal);
    const exp = Math.round(base * frac) + sportK;            // dépense (base prorata aujourd'hui, sport plein)
    const eaten = nf(di.eaten);
    const logged = !!di.logged && !isFuture;
    const deficit = logged ? (exp - eaten) : null;

    // glycogène / eau (seulement sur jours loggés ; sinon on reporte le stock)
    if (logged) {
      const glucoEq = recentGluc.length ? mean(recentGluc) : nf(di.gluc);
      stock = clamp(stock + (nf(di.gluc) - glucoEq) * GLYCO_ABSORB, 0, GLYCO_STOCK_MAX);
    }
    const eauGlyco = Math.round(3 * (stock - GLYCO_STOCK_INIT)); // g
    const poidsAjuste = pm7 != null ? +(pm7 - eauGlyco / 1000).toFixed(2) : null;

    const rec = {
      ds, t, weight: nf(di.weight) || null, bf: nf(di.bf) || null,
      libre: !!di.libre,
      pm7: pm7 != null ? +pm7.toFixed(2) : null,
      base: Math.round(base), adaptation, exp, sportK,
      eaten, gluc: nf(di.gluc), prot: nf(di.prot),
      deficit, logged, isToday, isFuture,
      stock: Math.round(stock), eauGlyco, poidsAjuste,
    };
    list.push(rec); byKey[ds] = rec;

    // alimente les fenêtres glissantes APRÈS calcul (causalité), seulement jours passés loggés complets
    if (logged && !isToday) {
      recentDef.push(deficit); if (recentDef.length > 14) recentDef.shift();
      recentGluc.push(nf(di.gluc)); if (recentGluc.length > 14) recentGluc.shift();
    }
  }
  return { list, byKey };
}

/* Estimation de la base hors sport, disponible TÔT.
   Deux sources pondérées par leur précision (inverse de la variance) :
   - a priori : base par formule (ou réglage actuel), avec son incertitude — dès le 1er jour ;
   - mesure : bilan énergétique des jours récents, base = apport − sport + perte/jour × 7300,
     pente du poids par régression linéaire (robuste aux pesées isolées).
   opts.startT = début du régime : la 1re semaine est exclue, car la chute rapide du poids y est
   surtout de l'eau (glycogène) et ferait nettement surestimer la dépense (constaté sur données réelles).
   Renvoie { ok, base, sigma, confidence, poidsRef, ... } ou { ok:false, reason }. */
export const EST_MIN_DAYS = 7;
export const EST_MIN_WEIGHINS = 4;
export const EST_WINDOW = 28;
export const EST_NOISE_FLOOR = 0.3;      // kg : bruit minimal d'une pesée (eau, digestion)
export const EST_SLOPE_INFLATION = 1.5;  // pesées autocorrélées : moins d'information que n points indépendants
export const EST_LOG_ERR = 0.05;         // erreur systématique de saisie des repas (~5 % de l'apport)
export const EST_WATER_SKIP_DAYS = 7;    // 1re semaine de régime ignorée (perte d'eau)
export const EST_WATER_KG = 0.5;         // variations d'eau résiduelles possibles sur la fenêtre (kg)

export function estimateBase(timeline, prior, opts = {}) {
  const hasStart = opts.startT != null && isFinite(opts.startT);
  const skipUntil = hasStart ? opts.startT + EST_WATER_SKIP_DAYS * 86400000 : -Infinity;
  const win = timeline.list
    .filter(r => r.logged && !r.isToday && !r.isFuture && r.t >= skipUntil)
    .slice(-(opts.window ?? EST_WINDOW)); // window: Infinity = tout l'historique
  const nDays = win.length;
  const t0 = nDays ? win[0].t : 0, tEnd = nDays ? win[nDays - 1].t : 0;
  const pts = timeline.list
    .filter(r => r.weight > 0 && !r.isFuture && r.t >= t0 && r.t <= tEnd)
    .map(r => ({ x: (r.t - t0) / 86400000, y: r.weight }));
  const nW = pts.length;
  const span = nW ? pts[nW - 1].x - pts[0].x : 0;
  if (nDays < EST_MIN_DAYS || nW < EST_MIN_WEIGHINS || span < 5) {
    return { ok: false, days: nDays, weighIns: nW,
      reason: `${nDays}/${EST_MIN_DAYS} jours loggés${hasStart ? ' après la 1re semaine' : ''} · ${nW}/${EST_MIN_WEIGHINS} pesées` };
  }
  // régression linéaire du poids (kg/jour)
  const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y));
  const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx;
  const sse = pts.reduce((s, p) => s + (p.y - (my + slope * (p.x - mx))) ** 2, 0);
  const sd = Math.max(EST_NOISE_FLOOR, Math.sqrt(sse / Math.max(1, nW - 2)));
  const seSlope = EST_SLOPE_INFLATION * sd / Math.sqrt(sxx);
  // bilan énergétique
  const meanEaten = mean(win.map(r => r.eaten));
  const meanSport = mean(win.map(r => r.sportK));
  const measured = meanEaten - meanSport - slope * KCAL_PER_KG;
  // incertitudes indépendantes : pente, saisie des repas, eau résiduelle (pèse moins sur une fenêtre longue)
  let measSigma = Math.hypot(KCAL_PER_KG * seSlope, EST_LOG_ERR * meanEaten, EST_WATER_KG * KCAL_PER_KG / Math.max(span, 1));
  // glucides nettement modifiés : l'eau du glycogène fausse la pente -> mesure moins fiable
  const k = Math.min(7, Math.floor(nDays / 2));
  const carbShift = Math.abs(mean(win.slice(0, k).map(r => r.gluc)) - mean(win.slice(-k).map(r => r.gluc))) >= 25;
  if (carbShift) measSigma *= 1.5;
  const poidsRef = +my.toFixed(2); // la base mesurée vaut au poids moyen de la fenêtre
  let est = measured, sigma = measSigma, weightMeasured = 1;
  if (prior && prior.base > 0) {
    const pSigma = Math.max(50, prior.sigma || 600);
    const pBase = prior.poids > 0 ? prior.base - K_POIDS * (prior.poids - poidsRef) : prior.base;
    const wp = 1 / pSigma ** 2, wm = 1 / measSigma ** 2;
    est = (pBase * wp + measured * wm) / (wp + wm);
    sigma = Math.sqrt(1 / (wp + wm));
    weightMeasured = wm / (wp + wm);
  }
  return {
    ok: true, days: nDays, weighIns: nW, t0, tEnd,
    base: Math.round(est), sigma: Math.round(sigma),
    confidence: sigma < 170 ? 'bonne' : sigma < 300 ? 'moyenne' : 'faible',
    measured: Math.round(measured), measuredSigma: Math.round(measSigma),
    weightMeasured: +weightMeasured.toFixed(2),
    poidsRef, lossPerWeek: +(-slope * 7).toFixed(2), carbShift,
  };
}

/* Règle des dimanches. Renvoie { show, kg7, delta, msg } pour le dernier dimanche <= today. */
export function sundayRule(timeline, todayTime) {
  const rec = timeline.list;
  const at = (t) => { const r = rec.find(x => x.t === t); return r && r.pm7 != null ? r.pm7 : null; };
  // dimanches (getDay()===0) <= today avec pm7 dispo
  const sundays = rec.filter(r => new Date(r.t).getDay() === 0 && r.t <= todayTime && r.pm7 != null);
  if (!sundays.length) return { show: false };
  const evalSunday = (r) => {
    const p0 = at(r.t), p3 = at(r.t - 21 * 86400000);
    if (p0 == null || p3 == null) return null;
    const v = (p3 - p0) / 3; // taux de PERTE kg/sem sur 3 semaines (positif = on perd)
    return v;
  };
  const lastS = sundays[sundays.length - 1];
  const v = evalSunday(lastS);
  if (v == null) return { show: false };
  const kg7 = +v.toFixed(2); const kg7s = String(kg7).replace(".", ",");
  if (v > 0.7) return { show: true, kg7, delta: +100, msg: `Perte rapide (${kg7s} kg/sem) — tu peux ajouter +100 kcal.` };
  if (v >= 0.35) return { show: true, kg7, delta: 0, msg: `Rythme idéal (${kg7s} kg/sem) — ne change rien.` };
  // v < 0.35 : suggérer -100 seulement si 2 dimanches consécutifs sous 0.35
  const prevS = sundays.length >= 2 ? sundays[sundays.length - 2] : null;
  const vPrev = prevS ? evalSunday(prevS) : null;
  if (vPrev != null && vPrev < 0.35) return { show: true, kg7, delta: -100, msg: `Perte lente 2 dim. de suite (${kg7s} kg/sem) — envisage −100 kcal (plancher ${APPORT_FLOOR}).` };
  return { show: true, kg7, delta: 0, msg: `Perte lente (${kg7s} kg/sem) — on attend un 2ᵉ dimanche avant d'ajuster.` };
}
