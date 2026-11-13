// @ts-nocheck
/* Estimation d'un prix d'aliment, à valider par l'utilisateur.
   Deux sources, dans l'ordre :
     1. famille reconnue dans le nom (prix moyen en grande surface, ordre de grandeur) ;
     2. modèle appris sur TES prix déjà saisis (le prix au kilo suit surtout les protéines
        et l'énergie : la viande et le fromage coûtent cher, les féculents presque rien).
   Fonctions pures, testables en Node. */

import { nameCore } from './budget.js';

/* Prix indicatifs en € par kg (ou par litre), supermarché français.
   Ce sont des ordres de grandeur destinés à être corrigés, pas des prix exacts. */
export const FAMILIES = [
  { key: 'eau', perKg: 0.4, words: ['eau', 'evian', 'volvic', 'cristaline'] },
  { key: 'soda', perKg: 1.2, words: ['soda', 'cola', 'limonade', 'ice', 'tea', 'vitamin'] },
  { key: 'jus', perKg: 1.8, words: ['jus', 'nectar', 'smoothie'] },
  { key: 'lait', perKg: 1.2, words: ['lait', 'ribot'] },
  { key: 'yaourt', perKg: 4, words: ['yaourt', 'skyr', 'fromage blanc', 'petit suisse', 'danone', 'activia', 'siggi'] },
  { key: 'fromage', perKg: 13, words: ['fromage', 'gouda', 'comte', 'emmental', 'camembert', 'mozzarella', 'chevre', 'ficello', 'babybel', 'raclette', 'parmesan', 'feta'] },
  { key: 'beurre', perKg: 11, words: ['beurre', 'margarine'] },
  { key: 'creme', perKg: 5, words: ['creme'] },
  { key: 'oeuf', perKg: 6, words: ['oeuf', 'omelette'] },
  { key: 'poulet', perKg: 10, words: ['poulet', 'dinde', 'escalope', 'volaille'] },
  { key: 'boeuf', perKg: 15, words: ['boeuf', 'steak', 'bavette', 'entrecote', 'hache'] },
  { key: 'porc', perKg: 10, words: ['porc', 'cote', 'filet mignon', 'lardon'] },
  { key: 'charcuterie', perKg: 16, words: ['jambon', 'saucisson', 'chorizo', 'bacon', 'saucisse', 'merguez', 'rillette', 'pate'] },
  { key: 'poisson', perKg: 16, words: ['poisson', 'cabillaud', 'colin', 'merlu', 'sardine', 'maquereau', 'crevette'] },
  { key: 'saumon', perKg: 24, words: ['saumon', 'truite'] },
  { key: 'thon', perKg: 11, words: ['thon'] },
  { key: 'pain', perKg: 4, words: ['pain', 'baguette', 'biscotte', 'tortilla', 'wrap', 'buns'] },
  { key: 'viennoiserie', perKg: 9, words: ['croissant', 'chocolatine', 'brioche', 'viennoiserie', 'chausson', 'donut'] },
  { key: 'biscuit', perKg: 9, words: ['biscuit', 'gateau', 'cookie', 'madeleine', 'barre', 'gaufre', 'cereales'] },
  { key: 'chocolat', perKg: 14, words: ['chocolat', 'chocofresh', 'nutella', 'praline'] },
  { key: 'bonbon', perKg: 10, words: ['bonbon', 'haribo', 'dragee'] },
  { key: 'pates', perKg: 2.2, words: ['pate', 'pates', 'spaghetti', 'penne', 'coquillette', 'riz', 'semoule', 'boulgour', 'quinoa', 'nouille'] },
  { key: 'pates_fraiches', perKg: 7, words: ['ravioli', 'tortellini', 'gnocchi', 'lasagne'] },
  { key: 'legumineuse', perKg: 3, words: ['lentille', 'pois', 'haricot', 'flageolet', 'houmous'] },
  { key: 'legume', perKg: 3, words: ['legume', 'carotte', 'courgette', 'tomate', 'salade', 'epinard', 'brocoli', 'poivron', 'oignon', 'champignon', 'concombre', 'chou', 'haricot vert', 'ratatouille'] },
  { key: 'pomme_de_terre', perKg: 2, words: ['pomme de terre', 'patate', 'frite', 'puree'] },
  { key: 'fruit', perKg: 3.5, words: ['fruit', 'pomme', 'poire', 'orange', 'fraise', 'raisin', 'kiwi', 'peche', 'abricot', 'ananas', 'mangue', 'clementine'] },
  { key: 'banane', perKg: 2.2, words: ['banane'] },
  { key: 'fruit_sec', perKg: 16, words: ['amande', 'noix', 'noisette', 'cajou', 'pistache', 'raisin sec', 'datte'] },
  { key: 'huile', perKg: 4.5, words: ['huile', 'olive'] },
  { key: 'sauce', perKg: 5, words: ['sauce', 'ketchup', 'mayonnaise', 'moutarde', 'vinaigrette', 'pesto'] },
  { key: 'plat_prepare', perKg: 8, words: ['plat', 'pastabox', 'box', 'lasagnes', 'couscous', 'paella', 'taboule', 'quiche', 'pizza', 'burger', 'sandwich', 'croque'] },
  { key: 'soupe', perKg: 2.5, words: ['soupe', 'veloute', 'bouillon'] },
  { key: 'glace', perKg: 7, words: ['glace', 'sorbet', 'magnum'] },
  { key: 'sucre', perKg: 1.5, words: ['sucre', 'farine', 'miel', 'confiture', 'sirop'] },
  { key: 'whey', perKg: 55, words: ['whey', 'proteine', 'protein', 'caseine'] },
  { key: 'cafe', perKg: 20, words: ['cafe', 'the', 'infusion', 'capsule'] },
];

export function familyFor(name) {
  const core = ' ' + nameCore(name) + ' ';
  const raw = ' ' + String(name ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + ' ';
  let best = null;
  for (const f of FAMILIES) {
    for (const w of f.words) {
      const hit = w.includes(' ') ? raw.includes(' ' + w + ' ') || raw.includes(' ' + w) : core.includes(' ' + w + ' ');
      if (!hit) continue;
      /* Le mot le plus proche du début nomme l'aliment (« Boîte de thon à l'huile » est
         du thon, pas de l'huile) ; à position égale, le plus long est le plus précis
         (« pomme de terre » l'emporte sur « pomme »). */
      const pos = raw.indexOf(w);
      if (!best || pos < best.pos || (pos === best.pos && w.length > best.w.length)) best = { f, w, pos };
    }
  }
  return best ? { key: best.f.key, perKg: best.f.perKg } : null;
}

/* Modèle appris : €/kg ≈ a + b × kcal/100g + c × protéines/100g, par moindres carrés.
   Il faut au moins 6 aliments chiffrés au kilo pour que ça ait un sens. */
export function fitPriceModel(priced) {
  const rows = (priced ?? [])
    .filter((f) => f.perKg > 0 && f.kcal > 0)
    .map((f) => [1, +f.kcal || 0, +f.prot || 0, +f.perKg]);
  if (rows.length < 6) return null;
  const n = 3;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const r of rows)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j];
      A[i][n] += r[i] * r[3];
    }
  // pivot de Gauss
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    if (Math.abs(A[p][i]) < 1e-9) return null;
    [A[i], A[p]] = [A[p], A[i]];
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = A[k][i] / A[i][i];
      for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j];
    }
  }
  const c = A.map((row, i) => row[n] / A[i][i]);
  return { a: c[0], b: c[1], c: c[2], n: rows.length };
}

export function modelPerKg(model, kcal, prot) {
  if (!model) return null;
  const v = model.a + model.b * (+kcal || 0) + model.c * (+prot || 0);
  return v > 0.2 && v < 200 ? v : null;
}

/* Proposition pour une ligne du budget.
   grams connus -> prix au kilo ; sinon prix d'une ligne, déduit de ses calories. */
export function estimatePrice(food, model) {
  const fam = familyFor(food.name);
  const kcal100 = +food.kcal100 || 0, prot100 = +food.prot100 || 0;
  const learned = modelPerKg(model, kcal100, prot100);
  const perKg = fam ? fam.perKg : learned;
  const source = fam ? `famille : ${fam.key.replace(/_/g, ' ')}` : (learned ? `appris sur tes ${model.n} prix` : null);
  if (!perKg) return null;
  if (food.grams > 0) return { value: +perKg.toFixed(2), unit: 'kg', source };
  // sans quantité lisible : on passe par les calories de la ligne et la densité de l'aliment
  const kcalLine = +food.kcalPerMeal || 0;
  if (!(kcal100 > 0) || !(kcalLine > 0)) return null;
  const grams = (kcalLine / kcal100) * 100;
  return { value: +((perKg / 1000) * grams).toFixed(2), unit: 'portion', source, grams: Math.round(grams) };
}
