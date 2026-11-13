// @ts-nocheck
/* Catalogue d'aliments = aliments partagés (table Supabase shared_foods)
   ∪ favoris personnels, moins ceux que l'utilisateur a masqués.
   Fonctions pures, sans dépendance au navigateur (testables en Node). */

// Bornes alignées sur les contraintes CHECK de la table (une valeur hors bornes
// ferait échouer tout un lot d'insertion).
export const MAX_KCAL = 19999, MAX_MACRO = 1999, MAX_SEL = 199, MAX_PRIX = 9999;

// Même aliment = même nom (casse et espaces ignorés) + même base (100 g ou portion)
export function foodKey(name, per) {
  return String(name ?? '').trim().toLowerCase() + '|' + (per === 'unit' ? 'unit' : '100');
}

function num(v, max) {
  const x = parseFloat(String(v ?? '').replace(',', '.'));
  if (!isFinite(x) || x < 0) return 0;
  return Math.min(x, max);
}

const hasName = (f) => String(f?.name ?? '').trim() !== '';

/* shared : tableau, ou null si le catalogue partagé est indisponible (SQL pas
   encore exécuté, hors-ligne) — on retombe alors sur les seuls favoris perso.
   mine = l'utilisateur peut supprimer (auteur, ou favori purement personnel). */
export function buildCatalog({ shared, personal, hidden, myId, archived = [] }) {
  const hid = new Set(Array.isArray(hidden) ? hidden : []);
  const arc = new Set(Array.isArray(archived) ? archived : []);
  const byKey = new Map();
  // Mes corrections d'un aliment partagé par quelqu'un d'autre (ov) passent avant la version partagée
  for (const f of Array.isArray(personal) ? personal : []) {
    if (!f?.ov || !hasName(f)) continue;
    const key = foodKey(f.name, f.per);
    if (hid.has(key) || byKey.has(key)) continue;
    byKey.set(key, { ...f, key, shared: false, mine: true, override: true, archived: arc.has(key) });
  }
  for (const f of Array.isArray(shared) ? shared : []) {
    if (!hasName(f)) continue;
    const key = foodKey(f.name, f.per);
    if (hid.has(key) || byKey.has(key)) continue;
    byKey.set(key, { ...f, key, shared: true, mine: !!myId && f.created_by === myId, archived: arc.has(key) });
  }
  for (const f of Array.isArray(personal) ? personal : []) {
    if (!hasName(f)) continue;
    const key = foodKey(f.name, f.per);
    if (hid.has(key)) continue;
    if (byKey.has(key)) {
      // même aliment déjà pris côté partagé : on récupère au moins le prix saisi en perso
      const cur = byKey.get(key);
      if ((cur.prix == null || cur.prix === '') && f.prix != null && f.prix !== '') {
        cur.prix = f.prix;
        cur.prixUnit = f.prixUnit ?? f.prix_unit ?? cur.prixUnit;
      }
      continue;
    }
    byKey.set(key, { ...f, key, shared: false, mine: true, archived: arc.has(key) });
  }
  // départage par clé : même nom avec deux bases -> ordre stable
  return [...byKey.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), 'fr') || a.key.localeCompare(b.key));
}

// Favoris personnels absents du catalogue partagé : proposés au partage (opt-in).
export function unsharedPersonal({ shared, personal, hidden, archived = [] }) {
  if (!Array.isArray(shared)) return [];
  const known = new Set(shared.map((f) => foodKey(f.name, f.per)));
  const hid = new Set([...(Array.isArray(hidden) ? hidden : []), ...(Array.isArray(archived) ? archived : [])]);
  const out = [];
  for (const f of Array.isArray(personal) ? personal : []) {
    if (!hasName(f)) continue;
    const key = foodKey(f.name, f.per);
    if (known.has(key) || hid.has(key)) continue;
    known.add(key);
    out.push(f);
  }
  return out;
}

// Ligne prête à insérer. Toutes les lignes d'un lot ont les mêmes clés (exigé par PostgREST).
export function toSharedRow(f) {
  const opt = (v, max, dec) => (v == null || v === '' ? null : +num(v, max).toFixed(dec));
  return {
    name: String(f?.name ?? '').trim().slice(0, 200),
    per: f?.per === 'unit' ? 'unit' : '100',
    kcal: Math.round(num(f?.kcal, MAX_KCAL)),
    p: +num(f?.p, MAX_MACRO).toFixed(1),
    g: +num(f?.g, MAX_MACRO).toFixed(1),
    l: +num(f?.l, MAX_MACRO).toFixed(1),
    fi: opt(f?.fi, MAX_MACRO, 1),
    sel: opt(f?.sel, MAX_SEL, 2),
    prix: opt(f?.prix, MAX_PRIX, 3),
    prix_unit: f?.prixUnit === 'kg' || f?.prixUnit === 'portion' ? f.prixUnit : null,
  };
}

/* Reporte les fibres d'un aliment sur les repas passés qui le citent :
   « Nom » (×1) ou « Nom ×2 », « Nom ×0,5 » (format de l'ajout depuis la liste d'aliments).
   Seules les fibres sont touchées : kcal et macros des jours passés restent inchangés. */
const MULT_RE = /^(.*?)\s*×\s*(\d+(?:[.,]\d+)?)$/;

/* Un repas cite-t-il cet aliment ? Renvoie la quantité (1, 2, 0,5…) ou 0 si non.
   Formats produits par l'ajout depuis la liste d'aliments : « Nom » et « Nom ×n ». */
export function entryMult(entryName, name) {
  const base = String(name ?? '').trim().toLowerCase();
  const nm = String(entryName ?? '').trim();
  if (!base) return 0;
  if (nm.toLowerCase() === base) return 1;
  const m = nm.match(MULT_RE);
  if (m && m[1].trim().toLowerCase() === base) return parseFloat(m[2].replace(',', '.')) || 0;
  return 0;
}

/* Renomme un aliment dans tous les repas passés, en gardant la quantité (« Nom ×2 »).
   Sans ça, l'historique serait coupé de l'aliment (plus de report des fibres). */
export function renameFoodInDays(days, oldName, newName) {
  const nn = String(newName ?? '').trim();
  const out = {};
  let n = 0;
  for (const [ds, d] of Object.entries(days ?? {})) {
    const foods = Array.isArray(d?.foods) ? d.foods : null;
    if (!foods || !nn) { out[ds] = d; continue; }
    let changed = false;
    const next = foods.map((f) => {
      const mult = entryMult(f?.n, oldName);
      if (!mult) return f;
      const label = mult === 1 ? nn : `${nn} ×${String(mult).replace('.', ',')}`;
      if (f.n === label) return f;
      changed = true; n++;
      return { ...f, n: label };
    });
    out[ds] = changed ? { ...d, foods: next } : d;
  }
  return { days: out, n };
}

export function backfillFiber(days, name, fiPerUnit) {
  const base = String(name ?? '').trim().toLowerCase();
  const out = {};
  let n = 0;
  for (const [ds, d] of Object.entries(days ?? {})) {
    const foods = Array.isArray(d?.foods) ? d.foods : null;
    if (!foods || !base) { out[ds] = d; continue; }
    let changed = false;
    const next = foods.map((f) => {
      const mult = entryMult(f?.n, base);
      if (!(mult > 0)) return f;
      const fi = +(fiPerUnit * mult).toFixed(1);
      if (f.fi === fi) return f;
      changed = true; n++;
      return { ...f, fi };
    });
    out[ds] = changed ? { ...d, foods: next } : d;
  }
  return { days: out, n };
}
