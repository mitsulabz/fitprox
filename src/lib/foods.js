// @ts-nocheck
/* Catalogue d'aliments = aliments partagés (table Supabase shared_foods)
   ∪ favoris personnels, moins ceux que l'utilisateur a masqués.
   Fonctions pures, sans dépendance au navigateur (testables en Node). */

// Bornes alignées sur les contraintes CHECK de la table (une valeur hors bornes
// ferait échouer tout un lot d'insertion).
export const MAX_KCAL = 19999, MAX_MACRO = 1999, MAX_SEL = 199;

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
export function buildCatalog({ shared, personal, hidden, myId }) {
  const hid = new Set(Array.isArray(hidden) ? hidden : []);
  const byKey = new Map();
  for (const f of Array.isArray(shared) ? shared : []) {
    if (!hasName(f)) continue;
    const key = foodKey(f.name, f.per);
    if (hid.has(key) || byKey.has(key)) continue;
    byKey.set(key, { ...f, key, shared: true, mine: !!myId && f.created_by === myId });
  }
  for (const f of Array.isArray(personal) ? personal : []) {
    if (!hasName(f)) continue;
    const key = foodKey(f.name, f.per);
    if (hid.has(key) || byKey.has(key)) continue;
    byKey.set(key, { ...f, key, shared: false, mine: true });
  }
  // départage par clé : même nom avec deux bases -> ordre stable
  return [...byKey.values()].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), 'fr') || a.key.localeCompare(b.key));
}

// Favoris personnels absents du catalogue partagé : proposés au partage (opt-in).
export function unsharedPersonal({ shared, personal, hidden }) {
  if (!Array.isArray(shared)) return [];
  const known = new Set(shared.map((f) => foodKey(f.name, f.per)));
  const hid = new Set(Array.isArray(hidden) ? hidden : []);
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
  };
}
