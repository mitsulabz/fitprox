/* Écriture d'un prix d'aliment, partagée par l'onglet Budget et la fiche Aliments.
   Mon aliment du catalogue -> prix enregistré pour tous ; aliment de quelqu'un d'autre
   ou favori perso -> prix enregistré chez moi. La colonne « prix » doit exister dans
   shared_foods (voir supabase_shared_foods.sql) ; sinon on retombe sur le perso. */
import { get } from 'svelte/store';
import { session, appData } from './store';
import { saveAppState, updateSharedFood } from './supabase';
import { refreshSharedFoods } from './sharedFoods';
import { foodKey } from './foods';

export type PriceResult = { ok: boolean; scope: 'tous' | 'perso'; msg: string };

export async function setFoodPrice(item: any, prix: number | null, unit: 'kg' | 'portion' = 'portion'): Promise<PriceResult> {
  const s = get(session); const data = get(appData) as any;
  if (!s || !data) return { ok: false, scope: 'perso', msg: 'Non connecté' };
  const value = prix == null || !isFinite(prix) || prix < 0 ? null : +(+prix).toFixed(3);
  const key = item.key ?? foodKey(item.name, item.per);
  let scope: 'tous' | 'perso' = 'perso';

  if (item.shared && item.mine && item.id) {
    const r = await updateSharedFood(s.access_token, item.id, { prix: value, prix_unit: value == null ? null : unit });
    if (r.ok) scope = 'tous';
    else if (!r.conflict) return { ok: false, scope: 'perso', msg: "Prix non enregistré (réseau, ou colonne « prix » absente : relance le SQL)" };
  }

  const favorites: any[] = Array.isArray(data.favorites) ? [...data.favorites] : [];
  const i = favorites.findIndex((f: any) => foodKey(f.name, f.per) === key);
  if (i >= 0) favorites[i] = { ...favorites[i], prix: value, prixUnit: value == null ? null : unit };
  else if (scope === 'perso') favorites.unshift({
    name: item.name, per: item.per === 'unit' ? 'unit' : '100',
    kcal: item.kcal ?? 0, p: item.p ?? 0, g: item.g ?? 0, l: item.l ?? 0,
    fi: item.fi ?? null, sel: item.sel ?? null, img: '', prix: value, prixUnit: value == null ? null : unit, ov: !!item.shared,
  });

  const newData = { ...data, favorites };
  appData.set(newData);
  try { await saveAppState(s.access_token, s.user.id, newData); } catch { return { ok: false, scope, msg: 'Erreur de sauvegarde' }; }
  if (scope === 'tous') await refreshSharedFoods();
  return { ok: true, scope, msg: scope === 'tous' ? 'Prix enregistré pour tous' : 'Prix enregistré' };
}
