// @ts-nocheck
/* Coût des repas : relie chaque ligne de l'historique à un aliment du catalogue
   et à son prix. Fonctions pures, sans dépendance au navigateur (testables en Node).

   Formats de nom produits par l'app :
     « Pain complet »          -> 1 × le prix de base
     « Pain complet ×2 »       -> 2 ×            (ajout depuis la liste, ×0,5 possible)
     « Pain complet (150g) »   -> 1,5 ×          (recherche / scan, base 100 g)
   Le prix est saisi dans la base de l'aliment : pour 100 g, ou par portion. */

import { foodKey } from './foods.js';

const MULT_RE = /^(.*?)\s*×\s*(\d+(?:[.,]\d+)?)$/;
const GRAM_RE = /^(.*?)\s*\((\d+(?:[.,]\d+)?)\s*g\)$/i;

export function parseEntry(entryName) {
  const nm = String(entryName ?? '').trim();
  if (!nm) return null;
  let m = nm.match(GRAM_RE);
  if (m) return { name: m[1].trim(), mult: (parseFloat(m[2].replace(',', '.')) || 0) / 100, grams: true };
  m = nm.match(MULT_RE);
  if (m) return { name: m[1].trim(), mult: parseFloat(m[2].replace(',', '.')) || 0, grams: false };
  return { name: nm, mult: 1, grams: false };
}

const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(x) && x >= 0 ? x : null; };

/* Index des prix par clé d'aliment. Une entrée en grammes (« (150g) ») ne peut
   correspondre qu'à un aliment en base 100 g ; sinon on cherche les deux bases. */
export function priceIndex(catalog) {
  const idx = new Map();
  for (const f of Array.isArray(catalog) ? catalog : []) {
    const k = foodKey(f?.name, f?.per);
    if (!idx.has(k)) idx.set(k, { prix: num(f?.prix), per: f?.per === 'unit' ? 'unit' : '100', name: f?.name });
  }
  return idx;
}

// Coût d'une ligne de repas : { cost, key, name, mult, priced }
export function entryCost(entryName, idx) {
  const p = parseEntry(entryName);
  if (!p || !(p.mult > 0)) return null;
  const k100 = foodKey(p.name, '100');
  const kUnit = foodKey(p.name, 'unit');
  const hit = p.grams ? idx.get(k100) : (idx.get(k100) ?? idx.get(kUnit));
  const key = p.grams ? k100 : (idx.has(k100) ? k100 : (idx.has(kUnit) ? kUnit : k100));
  const prix = hit ? hit.prix : null;
  return { key, name: p.name, mult: p.mult, priced: prix != null, cost: prix != null ? prix * p.mult : 0 };
}

const dsToT = (ds) => { const p = String(ds).split('/').map(Number); return p.length === 3 ? new Date(p[2], p[1] - 1, p[0]).getTime() : NaN; };
const pad = (n) => String(n).padStart(2, '0');

/* Coût par jour sur la période [fromT, toT].
   kcalPriced / kcalTotal donnent le taux de couverture : un budget calculé sur
   la moitié des repas seulement doit être lisible comme tel. */
export function dailyCosts(days, idx, { fromT = -Infinity, toT = Infinity } = {}) {
  const out = [];
  for (const [ds, d] of Object.entries(days ?? {})) {
    const t = dsToT(ds);
    if (!isFinite(t) || t < fromT || t > toT) continue;
    const foods = Array.isArray(d?.foods) ? d.foods : [];
    if (!foods.length) continue;
    let cost = 0, kcalTotal = 0, kcalPriced = 0, nUnpriced = 0;
    for (const f of foods) {
      const k = num(f?.k) ?? 0;
      kcalTotal += k;
      const c = entryCost(f?.n, idx);
      if (c && c.priced) { cost += c.cost; kcalPriced += k; } else nUnpriced++;
    }
    out.push({ ds, t, cost: +cost.toFixed(2), kcalTotal, kcalPriced, nUnpriced, nFoods: foods.length });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Lundi de la semaine d'un timestamp
export function weekStart(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/* Regroupement par semaine (lundi) ou par mois civil.
   complete = la période est entièrement derrière nous (sinon le total est partiel). */
export function groupCosts(daily, mode, todayT = Date.now()) {
  const map = new Map();
  for (const d of daily) {
    const s = mode === 'month' ? new Date(new Date(d.t).getFullYear(), new Date(d.t).getMonth(), 1) : weekStart(d.t);
    const key = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
    if (!map.has(key)) map.set(key, { key, start: s.getTime(), cost: 0, days: 0, kcalTotal: 0, kcalPriced: 0 });
    const g = map.get(key);
    g.cost += d.cost; g.days++; g.kcalTotal += d.kcalTotal; g.kcalPriced += d.kcalPriced;
  }
  const end = (g) => {
    const s = new Date(g.start);
    if (mode === 'month') return new Date(s.getFullYear(), s.getMonth() + 1, 0, 23, 59, 59).getTime();
    return g.start + 6 * 86400000 + 86399000;
  };
  return [...map.values()].sort((a, b) => a.start - b.start).map((g) => ({
    ...g, cost: +g.cost.toFixed(2), perDay: g.days ? +(g.cost / g.days).toFixed(2) : 0,
    complete: end(g) <= todayT, coverage: g.kcalTotal ? g.kcalPriced / g.kcalTotal : 0,
  }));
}

/* Aliments vus dans l'historique : total dépensé, nombre de repas, et macros
   reconstituées pour 1 unité de base (utile pour recréer un aliment supprimé). */
export function historyFoods(days, idx, { fromT = -Infinity, toT = Infinity } = {}) {
  const map = new Map();
  for (const [ds, d] of Object.entries(days ?? {})) {
    const t = dsToT(ds);
    if (!isFinite(t) || t < fromT || t > toT) continue;
    for (const f of Array.isArray(d?.foods) ? d.foods : []) {
      const c = entryCost(f?.n, idx);
      if (!c) continue;
      if (!map.has(c.key)) map.set(c.key, {
        key: c.key, name: c.name, per: c.key.endsWith('|unit') ? 'unit' : '100',
        count: 0, mult: 0, kcal: 0, cost: 0, priced: c.priced, inCatalog: idx.has(c.key),
        unit: null, lastT: 0,
      });
      const e = map.get(c.key);
      e.count++; e.mult += c.mult; e.kcal += num(f?.k) ?? 0; e.cost += c.cost;
      if (t >= e.lastT && c.mult > 0) {
        e.lastT = t;
        e.unit = { kcal: (num(f?.k) ?? 0) / c.mult, p: (num(f?.p) ?? 0) / c.mult, g: (num(f?.g) ?? 0) / c.mult, l: (num(f?.l) ?? 0) / c.mult,
                   fi: f?.fi != null ? (num(f?.fi) ?? 0) / c.mult : null };
      }
    }
  }
  return [...map.values()].map((e) => ({ ...e, cost: +e.cost.toFixed(2), mult: +e.mult.toFixed(2) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
}

/* Aliments présents dans l'historique mais absents du catalogue (supprimés depuis) :
   à recréer en « archivé » pour pouvoir leur donner un prix. */
export function missingFromCatalog(days, idx, opts) {
  return historyFoods(days, idx, opts).filter((e) => !e.inCatalog && e.unit).map((e) => ({
    name: e.name, per: e.per, count: e.count,
    kcal: Math.round(e.unit.kcal), p: +e.unit.p.toFixed(1), g: +e.unit.g.toFixed(1), l: +e.unit.l.toFixed(1),
    fi: e.unit.fi != null ? +e.unit.fi.toFixed(1) : null,
  }));
}
