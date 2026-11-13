<script lang="ts">
  import { onMount } from 'svelte';
  import { appData, session, sharedFoods } from './store';
  import { saveAppState, deleteSharedFood, updateSharedFood } from './supabase';
  import { refreshSharedFoods, publishFoods } from './sharedFoods';
  import { buildCatalog, unsharedPersonal, foodKey, backfillFiber, renameFoodInDays } from './foods';
  import { priceIndex, resolveKey, restateMeals } from './budget';
  import { get } from 'svelte/store';

  let filter = $state('');

  const trackFiber = $derived(!!($appData as any)?.profile?.trackFiber);
  let busy = $state(false);
  let shareMsg = $state('');
  const norm = (s: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  onMount(() => { refreshSharedFoods(); });

  const myId = $derived($session?.user?.id ?? '');
  const hidden = $derived(Array.isArray(($appData as any)?.hiddenFoods) ? ($appData as any).hiddenFoods : []);
  const archived = $derived(Array.isArray(($appData as any)?.archivedFoods) ? ($appData as any).archivedFoods : []);
  const catalog = $derived(buildCatalog({ shared: $sharedFoods, personal: ($appData as any)?.favorites, hidden, archived, myId }));
  const toShare = $derived(unsharedPersonal({ shared: $sharedFoods, personal: ($appData as any)?.favorites, hidden, archived }));
  const sharingOn = $derived($sharedFoods !== null);

  /* Prix affiché : le sien, sinon celui hérité du pilote de son groupe (Budget).
     Au kilo, le prix est le même pour toutes les quantités ; par ligne, il suit
     le rapport des calories entre l'aliment et son pilote. */
  const aliases = $derived(($appData as any)?.foodAliases ?? {});
  const pIdx = $derived(priceIndex(catalog));
  const eur2 = (v: number) => v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  function priceLabel(fav: any): string {
    const unit = (f: any) => ((f?.prixUnit ?? f?.prix_unit) === 'kg' ? 'kg' : 'ligne');
    if (fav.prix != null && fav.prix !== '') return `${eur2(+fav.prix)}/${unit(fav)}`;
    const target = resolveKey(fav.key, aliases);
    if (target === fav.key) return '';
    const pilot = catalog.find((f: any) => f.key === target);
    if (!pilot || pilot.prix == null || pilot.prix === '') return '';
    if (unit(pilot) === 'kg') return `${eur2(+pilot.prix)}/kg · hérité`;
    const k = +(fav.kcal ?? 0), kp = +(pilot.kcal ?? 0);
    const v = kp > 0 && k > 0 ? +pilot.prix * (k / kp) : +pilot.prix;
    return `≈ ${eur2(v)}/ligne · hérité`;
  }

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

  // ── Modifier un aliment (macros + fibres) ──
  // Mon aliment partagé -> corrigé pour tous ; aliment d'un autre -> correction pour moi seulement (ov) ;
  // favori perso -> corrigé. Les fibres sont reportées sur les repas passés contenant l'aliment.
  let editing = $state<any>(null);
  let editBusy = $state(false);
  let editMsg = $state('');
  const numOrNull = (v: any) => (v == null || v === '' || !isFinite(+v) ? null : Math.max(0, +v));
  const r1 = (v: any) => +(numOrNull(v) ?? 0).toFixed(1);

  function openEdit(item: any) {
    editMsg = '';
    editing = { item, restate: true, name: item.name, prix: item.prix == null || item.prix === '' ? null : +item.prix,
      prixUnit: ((item.prixUnit ?? item.prix_unit) === 'kg' ? 'kg' : 'portion'), kcal: Math.round(item.kcal ?? 0), p: +(item.p ?? 0), g: +(item.g ?? 0), l: +(item.l ?? 0),
      fi: item.fi == null || item.fi === '' ? null : +item.fi };
  }
  function closeEdit() { if (!editBusy) editing = null; }

  async function saveEdit() {
    const s = get(session); const data = get(appData) as any;
    if (!s || !data || !editing) return;
    const it = editing.item;
    const newName = String(editing.name ?? '').trim().slice(0, 200);
    if (!newName) { editMsg = 'Le nom ne peut pas être vide.'; return; }
    const renamed = foodKey(newName, it.per) !== it.key;
    // nom déjà pris par un autre aliment de même base : on refuse plutôt que de créer un doublon
    if (renamed && catalog.some((f: any) => f.key === foodKey(newName, it.per))) {
      editMsg = `« ${newName} » existe déjà dans la liste.`; return;
    }
    const fiVal = numOrNull(editing.fi);
    const prixVal = numOrNull(editing.prix);
    const unit = prixVal == null ? null : editing.prixUnit;
    /* La base ne connaît que prix_unit (colonne SQL) ; prixUnit est la forme locale.
       Envoyer prixUnit à PostgREST faisait échouer tout l'enregistrement (400). */
    const vals = { kcal: Math.round(numOrNull(editing.kcal) ?? 0), p: r1(editing.p), g: r1(editing.g), l: r1(editing.l),
      fi: fiVal == null ? null : +fiVal.toFixed(1), prix: prixVal == null ? null : +prixVal.toFixed(3),
      prix_unit: unit };
    const localVals = { ...vals, prixUnit: unit };
    editBusy = true; editMsg = '';
    const favorites: any[] = Array.isArray(data.favorites) ? [...data.favorites] : [];
    const idx = favorites.findIndex((f: any) => foodKey(f.name, f.per) === it.key);
    let scope = 'pour toi';
    let hiddenFoods: string[] = Array.isArray(data.hiddenFoods) ? [...data.hiddenFoods] : [];
    if (it.shared && it.mine && it.id) {
      const r = await updateSharedFood(s.access_token, it.id, { ...vals, name: newName });
      if (!r.ok) {
        editBusy = false;
        editMsg = r.conflict ? `« ${newName} » existe déjà dans le catalogue partagé.` : 'Enregistrement impossible (réseau ?). Réessaie.';
        return;
      }
      if (idx >= 0) favorites[idx] = { ...favorites[idx], ...localVals, name: newName }; // ma copie perso reste alignée
      scope = 'pour tous les utilisateurs';
    } else if (it.shared) {
      // aliment d'un autre : ma version perso. Renommé, l'original est masqué chez moi pour éviter le doublon.
      const ov = { name: newName, per: it.per === 'unit' ? 'unit' : '100', ...localVals, sel: it.sel ?? null, img: '', ov: !renamed };
      if (idx >= 0) favorites[idx] = { ...favorites[idx], ...ov }; else favorites.unshift(ov);
      if (renamed && !hiddenFoods.includes(it.key)) hiddenFoods.push(it.key);
    } else if (idx >= 0) {
      favorites[idx] = { ...favorites[idx], ...localVals, name: newName };
    }
    let days = data.days ?? {}; let n = 0; let nr = 0; let rs: any = null;
    if (renamed) ({ days, n: nr } = renameFoodInDays(days, it.name, newName));
    if (vals.fi != null) ({ days, n } = backfillFiber(days, newName, vals.fi));
    /* Macros répercutées sur les repas déjà enregistrés : les calories, le déficit du
       jour, les bilans mensuels et la base mesurée changent donc aussi. D'où le
       récapitulatif chiffré avant d'appliquer. */
    if (editing.restate) {
      const food = { name: newName, per: it.per, kcal: vals.kcal, p: vals.p, g: vals.g, l: vals.l, fi: vals.fi };
      const sim = restateMeals(days, food, priceIndex([...catalog, food]));
      if (sim.n) {
        const dk = sim.deltaK > 0 ? `+${sim.deltaK.toLocaleString('fr')}` : sim.deltaK.toLocaleString('fr');
        if (confirm(`Mettre à jour ${sim.n} repas déjà enregistré${sim.n > 1 ? 's' : ''} sur ${sim.dayCount} jour${sim.dayCount > 1 ? 's' : ''} ?\n\nTotal des calories de ces repas : ${dk} kcal.\nTes déficits passés, les bilans mensuels et ta base mesurée seront recalculés.`)) {
          days = sim.days; rs = sim;
        }
      }
    }
    const newData = { ...data, favorites, days, hiddenFoods };
    appData.set(newData);
    await saveAppState(s.access_token, s.user.id, newData);
    if (it.shared && it.mine) await refreshSharedFoods();
    editBusy = false; editing = null;
    shareMsg = `✓ « ${renamed ? it.name + ' » renommé « ' + newName : it.name} » modifié ${scope}`
      + (nr ? ` · ${nr} repas passé${nr > 1 ? 's' : ''} renommé${nr > 1 ? 's' : ''}` : '')
      + (nr ? '' : '')
      + (rs ? ` · ${rs.n} repas passé${rs.n > 1 ? 's' : ''} recalculé${rs.n > 1 ? 's' : ''}` : '')
      + (n && !rs ? ` · fibres reportées sur ${n} repas passé${n > 1 ? 's' : ''}` : '');
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
          <button class="fav-info" onclick={() => openEdit(fav)} title="Modifier">
            <span class="fav-name">{fav.name}{#if fav.archived}<span class="tag">archivé</span>{:else if fav.override}<span class="tag">modifié</span>{:else if sharingOn && !fav.shared}<span class="tag">perso</span>{/if}</span>
            <span class="fav-macros">
              {Math.round(fav.kcal ?? 0)} kcal · P {+(fav.p ?? 0).toFixed(1)}g · G {+(fav.g ?? 0).toFixed(1)}g · L {+(fav.l ?? 0).toFixed(1)}g{trackFiber ? ' · F ' + (fav.fi != null && fav.fi !== '' ? +(+fav.fi).toFixed(1) + 'g' : '–') : ''}
              <span class="muted">{fav.per === 'unit' ? '/portion' : '/100g'}</span>
              {#if priceLabel(fav)}<span class="price">· {priceLabel(fav)}</span>{/if}
            </span>
          </button>
          {#if fav.mine}
            <button class="del-btn" onclick={() => removeFood(fav)} aria-label={fav.override ? 'Annuler ma modification' : 'Supprimer'} title={fav.override ? 'Annuler ma modification' : 'Supprimer'}>
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

{#if editing}
  <button class="sheet-bg" aria-label="Fermer" onclick={closeEdit}></button>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Modifier l'aliment">
    <div class="sheet-head">
      <div class="sheet-t">
        <div class="sheet-title">{editing.item.name}</div>
        <div class="caption">Valeurs {editing.item.per === 'unit' ? 'par portion' : 'pour 100 g'}</div>
      </div>
      <button class="del-btn" onclick={closeEdit} aria-label="Fermer">✕</button>
    </div>
    <label class="fld"><span>Nom</span><input type="text" bind:value={editing.name} maxlength="200" autocomplete="off" spellcheck="false" /></label>
    <div class="grid">
      <label class="fld"><span>Kcal</span><input type="number" inputmode="decimal" min="0" step="1" bind:value={editing.kcal} /></label>
      <label class="fld"><span>Protéines (g)</span><input type="number" inputmode="decimal" min="0" step="0.1" bind:value={editing.p} /></label>
      <label class="fld"><span>Glucides (g)</span><input type="number" inputmode="decimal" min="0" step="0.1" bind:value={editing.g} /></label>
      <label class="fld"><span>Lipides (g)</span><input type="number" inputmode="decimal" min="0" step="0.1" bind:value={editing.l} /></label>
      <label class="fld"><span>Fibres (g)</span><input type="number" inputmode="decimal" min="0" step="0.1" placeholder="inconnu" bind:value={editing.fi} /></label>
      <label class="fld"><span>Prix (€)</span><input type="number" inputmode="decimal" min="0" step="0.01" placeholder="inconnu" bind:value={editing.prix} /></label>
      <div class="fld"><span>Prix exprimé</span>
        <div class="seg2">
          <button class:on={editing.prixUnit === 'kg'} onclick={() => (editing.prixUnit = 'kg')}>au kilo</button>
          <button class:on={editing.prixUnit !== 'kg'} onclick={() => (editing.prixUnit = 'portion')}>par ligne</button>
        </div>
      </div>
    </div>
    <label class="chk">
      <input type="checkbox" bind:checked={editing.restate} />
      <span>Appliquer les macros aux repas déjà enregistrés (calories et déficits recalculés)</span>
    </label>
    <p class="caption note">
      {#if editing.item.shared && editing.item.mine}Tu as ajouté cet aliment : la modification s'applique à tous les utilisateurs.
      {:else if editing.item.shared}Aliment ajouté par un autre utilisateur : ta modification ne s'applique qu'à toi.
      {:else}Aliment personnel.{/if}
      {#if editing.item.shared && !editing.item.mine}Le renommer crée ta version et masque l'originale chez toi.{/if}
      Renommer met aussi à jour le nom dans tes repas passés.
    </p>
    {#if editMsg}<div class="share-msg">{editMsg}</div>{/if}
    <button class="share-btn save" onclick={saveEdit} disabled={editBusy}>{editBusy ? 'Enregistrement…' : 'Enregistrer'}</button>
  </div>
{/if}

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
.fav-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; border:0; background:none; padding:0; margin:0; text-align:left; font:inherit; color:inherit; cursor:pointer; }
.sheet-bg { position:fixed; inset:0; z-index:300; border:0; padding:0; background:rgba(0,0,0,.45); cursor:default; }
.sheet { position:fixed; left:0; right:0; bottom:0; z-index:301; max-height:88dvh; overflow-y:auto; background:var(--c-bg); border-radius:18px 18px 0 0; padding:16px 16px calc(18px + env(safe-area-inset-bottom, 0px)); display:flex; flex-direction:column; gap:12px; max-width:620px; margin:0 auto; }
.sheet-head { display:flex; align-items:flex-start; gap:10px; }
.sheet-t { flex:1; min-width:0; }
.sheet-title { font-size:16px; font-weight:600; color:var(--c-text); overflow-wrap:anywhere; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.fld { display:flex; flex-direction:column; gap:4px; min-width:0; }
.fld span { font-size:11px; font-weight:500; color:var(--c-text3); text-transform:uppercase; letter-spacing:.05em; }
.fld input { width:100%; padding:10px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:16px; font-family:var(--font); }
.fld input:focus { outline:none; border-color:var(--c-accent); }
.note { margin:0; line-height:1.45; }
.chk { display:flex; align-items:flex-start; gap:9px; font-size:12.5px; color:var(--c-text2); line-height:1.4; }
.chk input { width:18px; height:18px; flex-shrink:0; margin:0; accent-color:var(--c-accent); }
.seg2 { display:flex; background:var(--c-surface2); border-radius:9px; padding:2px; gap:2px; }
.seg2 button { flex:1; border:0; background:transparent; color:var(--c-text2); font-size:12.5px; font-weight:500; padding:8px 6px; border-radius:7px; cursor:pointer; font-family:var(--font); }
.seg2 button.on { background:var(--c-accent); color:var(--c-accent-fg); }
.save { align-self:stretch; padding:12px; font-size:14px; }
.fav-name { font-size:13px; font-weight:500; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fav-macros { font-size:11px; color:var(--c-text2); }
.muted { color:var(--c-text3); }
.price { color:var(--c-text2); font-weight:500; }
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
