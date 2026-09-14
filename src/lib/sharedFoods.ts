import { get } from 'svelte/store';
import { session, sharedFoods } from './store';
import { loadSharedFoods, shareFoods } from './supabase';
import { toSharedRow } from './foods';

/* Recharge le catalogue partagé.
   loadSharedFoods renvoie null si la table est indisponible (SQL pas encore exécuté,
   hors-ligne, jeton expiré). On ne remplace pas un catalogue déjà chargé par null :
   un échec réseau passager ne doit pas faire disparaître les aliments des autres. */
export async function refreshSharedFoods(token?: string) {
  const s = get(session);
  if (!s) return;
  const rows = await loadSharedFoods(token ?? s.access_token);
  if (rows !== null || get(sharedFoods) === null) sharedFoods.set(rows);
}

// Publie des aliments dans le catalogue partagé ; les doublons sont ignorés côté base.
export async function publishFoods(foods: any[], token?: string): Promise<boolean> {
  const s = get(session);
  if (!s) return false;
  const rows = foods.map(toSharedRow).filter((r: any) => r.name);
  if (!rows.length) return true;
  const ok = await shareFoods(token ?? s.access_token, rows);
  if (ok) await refreshSharedFoods(token);
  return ok;
}
