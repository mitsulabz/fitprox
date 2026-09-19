<script lang="ts">
  import { onMount } from 'svelte';
  import { appData, session, sharedFoods } from './store';
  import { saveAppState, deleteSharedFood } from './supabase';
  import { refreshSharedFoods, publishFoods } from './sharedFoods';
  import { buildCatalog, unsharedPersonal, foodKey } from './foods';
  import { get } from 'svelte/store';

  let filter = $state('');

  const trackFiber = $derived(!!($appData as any)?.profile?.trackFiber);
  let busy = $state(false);
  let shareMsg = $state('');
  const norm = (s: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  onMount(() => { refreshSharedFoods(); });

  const myId = $derived($session?.user?.id ?? '');
  const hidden = $derived(Array.isArray(($appData as any)?.hiddenFoods) ? ($appData as any).hiddenFoods : []);
  const catalog = $derived(buildCatalog({ shared: $sharedFoods, personal: ($appData as any)?.favorites, hidden, myId }));
  const toShare = $derived(unsharedPersonal({ shared: $sharedFoods, personal: ($appData as any)?.favorites, hidden }));
  const sharingOn = $derived($sharedFoods !== null);

  // Retire un aliment de mes favoris personnels (et le masque si demandé), puis sauvegarde.
  function saveFavs(removeKey: string, hide: boolean) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const favorites = (data.favorites ?? []).filter((f: any) => foodKey(f.name, f.per) !== removeKey);
    const hiddenFoods = Array.isArray(data.hiddenFoods) ? [...data.hiddenFoods] : [];
    if (hide && !hiddenFoods.includes(removeKey)) hiddenFoods.push(removeKey);
    const newData = { ...data, favorites, hiddenFoods };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  // Supprimer : mes propres aliments partagés, ou mes favoris purement personnels.
  async function removeFood(item: any) {
    const s = get(session);
    if (!s) return;
    shareMsg = '';
    if (item.shared && item.mine && item.id) {
      if (!confirm(`Supprimer « ${item.name} » du catalogue partagé ?\n\nIl disparaîtra pour tous les utilisateurs.`)) return;
      const ok = await deleteSharedFood(s.access_token, item.id);
      if (!ok) { shareMsg = 'Suppression impossible (réseau ?). Réessaie.'; return; }
      await refreshSharedFoods();
    }
    saveFavs(item.key, false);
  }

  // Masquer : un aliment ajouté par quelqu'un d'autre disparaît de MA liste uniquement.
  function hideFood(item: any) { shareMsg = ''; saveFavs(item.key, true); }

  function unhideAll() {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const newData = { ...data, hiddenFoods: [] };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  // Opt-in : chacun décide de publier ou non sa liste existante.
  async function shareExisting() {
    busy = true; shareMsg = '';
    const n = toShare.length;
    const ok = await publishFoods(toShare);
    busy = false;
    shareMsg = ok ? `✓ ${n} aliment${n > 1 ? 's' : ''} partagé${n > 1 ? 's' : ''}` : 'Partage impossible (réseau ?). Réessaie.';
  }
</script>

<div class="scroll-area">
  <div class="header">
    <div class="title">Aliments</div>
    <div class="caption">
      {catalog.length} aliment{catalog.length !== 1 ? 's' : ''}{#if sharingOn} · catalogue partagé entre tous les utilisateurs{/if}
    </div>
  </div>

  {#if sharingOn && toShare.length > 0}
    {@const n = toShare.length}
    <div class="share-banner">
      <div>Tu as <b>{n}</b> aliment{n > 1 ? 's' : ''} personnel{n > 1 ? 's' : ''} pas encore partagé{n > 1 ? 's' : ''} avec les autres utilisateurs.</div>
      <button class="share-btn" onclick={shareExisting} disabled={busy}>{busy ? 'Partage…' : 'Les partager avec tous'}</button>
    </div>
  {/if}
  {#if shareMsg}<div class="share-msg">{shareMsg}</div>{/if}

  {#if catalog.length === 0}
    <div class="empty">
      <div class="empty-icon">🥗</div>
      <div>Aucun aliment pour l'instant.</div>
      <div class="caption">Les aliments que tu ajoutes à une journée apparaissent ici automatiquement.</div>
    </div>
  {:else}
    {@const filtered = catalog.filter((f: any) => norm(f.name).includes(norm(filter)))}
    <input class="fav-filter" type="text" placeholder="Filtrer les aliments…"
      bind:value={filter} autocomplete="off" autocorrect="off" spellcheck="false" />
    {#if filtered.length === 0}
      <div class="caption" style="padding:12px 2px">Aucun aliment ne correspond à « {filter} ».</div>
    {/if}
    <div class="list">
      {#each filtered as fav (fav.key)}
        <div class="fav-row">
          <div class="fav-info">
            <span class="fav-name">{fav.name}{#if sharingOn && !fav.shared}<span class="tag">perso</span>{/if}</span>
            <span class="fav-macros">
              {Math.round(fav.kcal ?? 0)} kcal · P {+(fav.p ?? 0).toFixed(1)}g · G {+(fav.g ?? 0).toFixed(1)}g · L {+(fav.l ?? 0).toFixed(1)}g{#if trackFiber && fav.fi != null && fav.fi !== ''} · F {+(+fav.fi).toFixed(1)}g{/if}
              <span class="muted">{fav.per === 'unit' ? '/portion' : '/100g'}</span>
            </span>
          </div>
          {#if fav.mine}
            <button class="del-btn" onclick={() => removeFood(fav)} aria-label="Supprimer" title="Supprimer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          {:else}
            <button class="del-btn hide-btn" onclick={() => hideFood(fav)} aria-label="Masquer pour moi" title="Masquer pour moi">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if hidden.length > 0}
    <button class="unhide" onclick={unhideAll}>Réafficher les {hidden.length} aliment{hidden.length > 1 ? 's' : ''} masqué{hidden.length > 1 ? 's' : ''}</button>
  {/if}
</div>

<style>
.header { padding:20px 0 14px; }
.title { font-size:20px; font-weight:500; color:var(--c-text); }
.caption { font-size:12px; color:var(--c-text3); margin-top:2px; }
.empty { display:flex; flex-direction:column; align-items:center; gap:8px; padding:60px 20px; text-align:center; color:var(--c-text2); font-size:14px; }
.empty-icon { font-size:40px; }
.fav-filter { width:100%; padding:10px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); margin-bottom:8px; }
.fav-filter:focus { outline:none; border-color:var(--c-accent); }
.list { display:flex; flex-direction:column; gap:6px; }
.fav-row { display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); }
.fav-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.fav-name { font-size:13px; font-weight:500; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fav-macros { font-size:11px; color:var(--c-text2); }
.muted { color:var(--c-text3); }
.tag { margin-left:6px; font-size:10px; font-weight:500; color:var(--c-text3); border:0.5px solid var(--c-border); border-radius:6px; padding:0 5px; vertical-align:1px; }
.del-btn { width:28px; height:28px; border:none; border-radius:50%; background:var(--c-surface2); color:var(--c-text3); cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.del-btn:hover { background:rgba(220,50,50,.12); color:var(--c-red, #e05); }
.hide-btn:hover { background:var(--c-surface2); color:var(--c-text); }
.share-banner { display:flex; flex-direction:column; gap:8px; padding:12px 14px; margin-bottom:10px; background:var(--c-surface); border:1px solid var(--c-accent); border-radius:var(--r-md); font-size:13px; color:var(--c-text); }
.share-btn { align-self:flex-start; border:none; border-radius:var(--r-md); background:var(--c-accent); color:var(--c-accent-fg); font-size:13px; font-weight:600; padding:8px 12px; cursor:pointer; font-family:var(--font); }
.share-btn:disabled { opacity:.6; cursor:not-allowed; }
.share-msg { font-size:12px; color:var(--c-text2); padding:0 2px 10px; }
.unhide { display:block; margin:14px auto 0; border:none; background:none; color:var(--c-text3); font-size:12px; text-decoration:underline; cursor:pointer; font-family:var(--font); }
</style>
