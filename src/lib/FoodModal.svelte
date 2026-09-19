<script lang="ts">
  import { onMount } from 'svelte';
  import { appData, session, persistSession, sharedFoods } from './store';
  import { saveAppState, refreshToken } from './supabase';
  import { refreshSharedFoods, publishFoods } from './sharedFoods';
  import { buildCatalog, foodKey } from './foods';
  import { get } from 'svelte/store';


  async function getFreshToken(): Promise<string | null> {
    const s = get(session);
    if (!s) return null;
    try {
      const fresh = await refreshToken(s.refresh_token);
      persistSession(fresh);
      return fresh.access_token;
    } catch {
      return s.access_token;
    }
  }
  const SUPABASE_URL = 'https://arydsxswhbgpfayjgtak.supabase.co';

  type Food = { n: string; k: number; p: number; g: number; l: number; fi?: number | null };
  type OFFProd = { n: string; k100: number; p100: number; g100: number; l100: number; fi100: number | null };

  // Fibres : toujours enregistrées quand on les connaît ; affichées si l'option du profil est active
  const trackFiber = $derived(!!($appData as any)?.profile?.trackFiber);
  const fiOk = (v: any) => v != null && v !== '' && isFinite(+v);
  const fiTxt = (v: any) => (fiOk(v) ? ` · F ${+(+v).toFixed(1)}g` : '');

  let { dayKey, onclose }: { dayKey: string; onclose: () => void } = $props();

  let tab = $state<'search' | 'scan' | 'favorites' | 'manual' | 'ai'>('favorites');

  // Recherche OFF
  let query = $state('');
  let searching = $state(false);
  let offResults = $state<OFFProd[]>([]);
  let quantities = $state<Record<number, number>>({});
  let favQty = $state<Record<string, number>>({});
  let favFilter = $state('');
  const favNorm = (s: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Manuel
  let manName = $state('');
  let manKcal = $state('');
  let manP = $state('');
  let manG = $state('');
  let manL = $state('');
  let manFi = $state('');

  // IA
  let aiText = $state('');
  let aiLoading = $state(false);
  let aiResults = $state<Food[]>([]);
  let aiError = $state('');

  // Scan
  let scanCode = $state('');
  let scanLoading = $state(false);
  let scanResult = $state<OFFProd | null>(null);
  let scanQty = $state(100);
  let scanError = $state('');

  // Catalogue = aliments partagés par tous ∪ mes favoris, moins ceux que j'ai masqués
  const favorites = $derived(buildCatalog({
    shared: $sharedFoods,
    personal: ($appData as any)?.favorites,
    hidden: ($appData as any)?.hiddenFoods,
    myId: $session?.user?.id ?? '',
  }));

  onMount(() => { refreshSharedFoods(); });

  async function commitFood(food: Food, closeAfter = true, skipFav = false) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;

    const days = data.days ?? {};
    const day = days[dayKey] ?? {};
    const foods = Array.isArray(day.foods) ? [...day.foods] : [];
    const fi = fiOk(food.fi) ? { fi: +(+food.fi!).toFixed(1) } : {};
    foods.push({ n: food.n, k: Math.round(food.k), p: +food.p.toFixed(1), g: +food.g.toFixed(1), l: +food.l.toFixed(1), ...fi });

    // Auto-ajout aux favoris (sauf si l'aliment vient déjà de la liste)
    const favs: any[] = Array.isArray(data.favorites) ? [...data.favorites] : [];
    let newFav: any = null;
    if (!skipFav) {
      const key = foodKey(food.n, '100');
      if (!favs.some((f: any) => foodKey(f.name, f.per) === key)) {
        newFav = { name: food.n, per: '100', kcal: Math.round(food.k), p: +food.p.toFixed(1), g: +food.g.toFixed(1), l: +food.l.toFixed(1), ...fi, img: '' };
        favs.unshift(newFav);
      }
    }

    const newData = { ...data, favorites: favs, days: { ...days, [dayKey]: { ...day, foods } } };
    appData.set(newData); // affichage immediat
    // Rafraichit le jeton UNIQUEMENT pour la sauvegarde (pas de persistSession -> pas de rechargement cloud qui ecraserait l'ajout)
    let token = s.access_token;
    try { const fresh = await refreshToken(s.refresh_token); token = fresh.access_token; } catch {}
    await saveAppState(token, s.user.id, newData);
    appData.set(newData); // re-affirme l'etat local au cas ou
    // Nouvel aliment -> catalogue partagé, sans bloquer (ignoré si doublon ; si la table
    // est indisponible, il reste en favori perso et sera proposé au partage plus tard)
    if (newFav && get(sharedFoods) !== null) publishFoods([newFav], token);
    if (closeAfter) onclose();
  }

  // Quantité : flèches ▼ ▲ ; sous 1 -> 0,5 (demi-portion) ; 99 maximum
  const fmtQty = (q: number) => String(q).replace('.', ',');
  function stepQty(key: string, dir: number) {
    const q = favQty[key] ?? 1;
    const n = dir < 0 ? (q <= 1 ? 0.5 : q - 1) : (q < 1 ? 1 : Math.min(99, q + 1));
    favQty = { ...favQty, [key]: n };
  }

  function addFromFav(fav: any, qty: number = 1) {
    const n = qty === 0.5 ? 0.5 : Math.max(1, Math.min(99, Math.round(qty || 1)));
    commitFood({
      n: n !== 1 ? `${fav.name} ×${fmtQty(n)}` : fav.name,
      k: (fav.kcal ?? 0) * n, p: (fav.p ?? 0) * n, g: (fav.g ?? 0) * n, l: (fav.l ?? 0) * n,
      fi: fiOk(fav.fi) ? +fav.fi * n : null,
    }, true, true);
  }

  function addOFF(prod: OFFProd, idx: number, qty: number) {
    const r = qty / 100;
    commitFood({ n: `${prod.n} (${qty}g)`, k: prod.k100 * r, p: prod.p100 * r, g: prod.g100 * r, l: prod.l100 * r, fi: prod.fi100 == null ? null : prod.fi100 * r });
  }

  async function searchOFF() {
    if (!query.trim()) return;
    searching = true; offResults = []; quantities = {};
    try {
      const r = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&json=1&page_size=20&fields=product_name,nutriments&lc=fr`);
      const d = await r.json();
      offResults = (d.products ?? [])
        .filter((p: any) => p.product_name?.trim() && p.nutriments?.['energy-kcal_100g'] != null)
        .slice(0, 12)
        .map((p: any) => ({
          n: p.product_name.trim(),
          k100: Math.round(p.nutriments['energy-kcal_100g'] ?? 0),
          p100: Math.round((p.nutriments.proteins_100g ?? 0) * 10) / 10,
          g100: Math.round((p.nutriments.carbohydrates_100g ?? 0) * 10) / 10,
          l100: Math.round((p.nutriments.fat_100g ?? 0) * 10) / 10,
          fi100: p.nutriments.fiber_100g == null ? null : Math.round(p.nutriments.fiber_100g * 10) / 10,
        }));
    } catch {}
    searching = false;
  }

  async function searchBarcode(code: string) {
    if (!code.trim()) return;
    scanLoading = true; scanResult = null; scanError = '';
    try {
      const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code.trim())}.json`);
      const d = await r.json();
      if (d.status !== 1 || !d.product) { scanError = 'Produit introuvable'; scanLoading = false; return; }
      const p = d.product;
      const nut = p.nutriments ?? {};
      if (nut['energy-kcal_100g'] == null) { scanError = 'Pas de données nutritionnelles'; scanLoading = false; return; }
      scanResult = {
        n: p.product_name?.trim() ?? code,
        k100: Math.round(nut['energy-kcal_100g'] ?? 0),
        p100: Math.round((nut.proteins_100g ?? 0) * 10) / 10,
        g100: Math.round((nut.carbohydrates_100g ?? 0) * 10) / 10,
        l100: Math.round((nut.fat_100g ?? 0) * 10) / 10,
        fi100: nut.fiber_100g == null ? null : Math.round(nut.fiber_100g * 10) / 10,
      };
    } catch { scanError = 'Erreur réseau'; }
    scanLoading = false;
  }

  function addManual() {
    if (!manName.trim() || !manKcal) return;
    commitFood({ n: manName.trim(), k: +manKcal, p: +(manP || 0), g: +(manG || 0), l: +(manL || 0), fi: manFi === '' || manFi == null ? null : +manFi });
  }

  async function estimateAI() {
    if (!aiText.trim()) return;
    aiLoading = true; aiResults = []; aiError = '';
    try {
      const token = await getFreshToken();
      const r = await fetch(`${SUPABASE_URL}/functions/v1/coach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'estimate-food', text: aiText }),
      });
      const d = await r.json();
      if (d.foods) aiResults = d.foods.map((f: any) => ({ n: f.name, k: f.kcal ?? 0, p: f.p ?? 0, g: f.g ?? 0, l: f.l ?? 0, fi: fiOk(f.fi) ? +f.fi : null }));
      else aiError = d.error ?? d.message ?? JSON.stringify(d);
    } catch { aiError = 'Erreur réseau'; }
    aiLoading = false;
  }
</script>

<div class="overlay" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title">Ajouter un aliment</span>
      <button class="close-btn" onclick={onclose}>✕</button>
    </div>

    <div class="tabs">
      <button class:active={tab === 'search'}    onclick={() => tab = 'search'}>Recherche</button>
      <button class:active={tab === 'scan'}      onclick={() => tab = 'scan'}>Scan</button>
      <button class:active={tab === 'favorites'} onclick={() => tab = 'favorites'}>Aliments</button>
      <button class:active={tab === 'manual'}    onclick={() => tab = 'manual'}>Manuel</button>
      <button class:active={tab === 'ai'}        onclick={() => tab = 'ai'}>IA</button>
    </div>

    <div class="modal-body">
      {#if $sharedFoods !== null && tab !== 'favorites'}
        <p class="hint" style="font-size:12px;color:var(--c-text3)">🌍 Les nouveaux aliments que tu ajoutes sont partagés avec tous les utilisateurs de FitProX.</p>
      {/if}

      {#if tab === 'search'}
        <form class="search-bar" onsubmit={(e) => { e.preventDefault(); searchOFF(); }}>
          <input type="search" placeholder="Nom d'aliment, marque…" bind:value={query} autocomplete="off" />
          <button type="submit" class="btn-accent" disabled={searching}>{searching ? '…' : '🔍'}</button>
        </form>
        {#if offResults.length === 0 && !searching && query}
          <div class="empty">Aucun résultat pour "{query}"</div>
        {:else}
          {#each offResults as prod, i}
            <div class="food-row">
              <div class="food-info">
                <span class="food-name">{prod.n}</span>
                <span class="food-macros">{prod.k100} kcal · P {prod.p100}g · G {prod.g100}g · L {prod.l100}g{trackFiber ? fiTxt(prod.fi100) : ''} <span class="muted">/100g</span></span>
              </div>
              <div class="qty-row">
                <input type="number" min="1" max="2000" step="10"
                  value={quantities[i] ?? 100}
                  oninput={(e) => { quantities = { ...quantities, [i]: +(e.target as HTMLInputElement).value }; }}
                />
                <span class="muted">g</span>
                <button class="btn-add" onclick={() => addOFF(prod, i, quantities[i] ?? 100)}>+</button>
              </div>
            </div>
          {/each}
        {/if}

      {:else if tab === 'scan'}
        <p class="hint">Saisis le code-barres manuellement ou utilise la caméra.</p>
        <form class="search-bar" onsubmit={(e) => { e.preventDefault(); searchBarcode(scanCode); }}>
          <input type="text" placeholder="Code-barres (ex: 3017620429484)" bind:value={scanCode} inputmode="numeric" />
          <button type="submit" class="btn-accent" disabled={scanLoading}>{scanLoading ? '…' : '→'}</button>
        </form>
        <label class="scan-camera-label" for="scan-file-input">
          <input type="file" accept="image/*" capture="environment" id="scan-file-input" class="scan-file"
            onchange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f) return;
              // BarcodeDetector API (Chrome/Android)
              if ('BarcodeDetector' in window) {
                try {
                  const bd = new (window as any).BarcodeDetector({ formats: ['ean_13','ean_8','upc_a','upc_e'] });
                  const img = await createImageBitmap(f);
                  const codes = await bd.detect(img);
                  if (codes.length > 0) { scanCode = codes[0].rawValue; searchBarcode(scanCode); }
                  else { scanError = 'Aucun code-barres détecté'; }
                } catch { scanError = 'Erreur de lecture'; }
              } else {
                scanError = 'Détection auto non supportée — saisis le code manuellement';
              }
            }}
          />
          📷 Prendre une photo
        </label>
        {#if scanError}<div class="error">{scanError}</div>{/if}
        {#if scanResult}
          <div class="food-row">
            <div class="food-info">
              <span class="food-name">{scanResult.n}</span>
              <span class="food-macros">{scanResult.k100} kcal · P {scanResult.p100}g · G {scanResult.g100}g · L {scanResult.l100}g{trackFiber ? fiTxt(scanResult.fi100) : ''} <span class="muted">/100g</span></span>
            </div>
            <div class="qty-row">
              <input type="number" min="1" max="2000" step="10" bind:value={scanQty} />
              <span class="muted">g</span>
              <button class="btn-add" onclick={() => addOFF(scanResult!, 0, scanQty)}>+</button>
            </div>
          </div>
        {/if}

      {:else if tab === 'favorites'}
        {#if favorites.length === 0}
          <div class="empty">Aucun aliment. Ajoute-en via Recherche, Scan, Manuel ou IA.</div>
        {:else}
          {@const filtered = favorites.filter((f: any) => favNorm(f.name).includes(favNorm(favFilter)))}
          <input class="fav-filter" type="text" placeholder="Filtrer les aliments…"
            bind:value={favFilter} autocomplete="off" autocorrect="off" spellcheck="false" />
          {#if filtered.length === 0}
            <div class="empty">Aucun aliment ne correspond à « {favFilter} ».</div>
          {/if}
          {#each filtered as fav (fav.key)}
            {@const q = favQty[fav.key] ?? 1}
            <div class="food-row">
              <div class="food-info">
                <span class="food-name">{fav.name}</span>
                <span class="food-macros">{Math.round(fav.kcal ?? 0)} kcal · P {+(fav.p??0).toFixed(1)}g · G {+(fav.g??0).toFixed(1)}g · L {+(fav.l??0).toFixed(1)}g{trackFiber ? fiTxt(fav.fi) : ''} <span class="muted">{fav.per === 'unit' ? '/portion' : '/100g'}</span></span>
              </div>
              <div class="qty-row">
                <button type="button" class="step" onclick={() => stepQty(fav.key, -1)} disabled={q <= 0.5} aria-label="Diminuer la quantité">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <span class="qty-val" aria-live="polite">{fmtQty(q)}</span>
                <button type="button" class="step" onclick={() => stepQty(fav.key, 1)} disabled={q >= 99} aria-label="Augmenter la quantité">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg>
                </button>
                <button class="btn-add" onclick={() => addFromFav(fav, q)} aria-label="Ajouter">+</button>
              </div>
            </div>
          {/each}
        {/if}

      {:else if tab === 'manual'}
        <form class="manual-form" onsubmit={(e) => { e.preventDefault(); addManual(); }}>
          <div class="field">
            <label>Nom</label>
            <input type="text" placeholder="Ex : Yaourt nature" bind:value={manName} required />
          </div>
          <div class="field-row">
            <div class="field">
              <label>Kcal</label>
              <input type="number" min="0" step="1" placeholder="0" bind:value={manKcal} required />
            </div>
            <div class="field">
              <label>Protéines (g)</label>
              <input type="number" min="0" step="0.1" placeholder="0" bind:value={manP} />
            </div>
            <div class="field">
              <label>Glucides (g)</label>
              <input type="number" min="0" step="0.1" placeholder="0" bind:value={manG} />
            </div>
            <div class="field">
              <label>Lipides (g)</label>
              <input type="number" min="0" step="0.1" placeholder="0" bind:value={manL} />
            </div>
            {#if trackFiber}
            <div class="field">
              <label>Fibres (g)</label>
              <input type="number" min="0" step="0.1" placeholder="0" bind:value={manFi} />
            </div>
            {/if}
          </div>
          <button type="submit" class="btn-accent full" disabled={!manName.trim() || !manKcal}>
            Ajouter au journal
          </button>
        </form>

      {:else}
        <p class="hint">Décris ce que tu as mangé en texte libre, l'IA estime les macros.</p>
        <form onsubmit={(e) => { e.preventDefault(); estimateAI(); }}>
          <textarea placeholder="Ex : 2 œufs brouillés, une tranche de pain complet avec du beurre, un café au lait…" bind:value={aiText} rows="3"></textarea>
          <button type="submit" class="btn-accent full" disabled={aiLoading || !aiText.trim()}>
            {aiLoading ? 'Analyse…' : '✨ Estimer'}
          </button>
        </form>
        {#if aiError}<div class="error">{aiError}</div>{/if}
        {#each aiResults as food}
          <button class="food-row fav-btn" onclick={() => { commitFood(food, false); aiResults = aiResults.filter((f) => f !== food); }}>
            <div class="food-info">
              <span class="food-name">{food.n}</span>
              <span class="food-macros">{Math.round(food.k)} kcal · P {+food.p.toFixed(1)}g · G {+food.g.toFixed(1)}g · L {+food.l.toFixed(1)}g{trackFiber ? fiTxt(food.fi) : ''}</span>
            </div>
            <span class="add-icon">+</span>
          </button>
        {/each}
      {/if}

    </div>
  </div>
</div>

<style>
.overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:200; display:flex; align-items:flex-end; }
.modal { width:100%; max-height:85dvh; background:var(--c-bg); border-radius:20px 20px 0 0; display:flex; flex-direction:column; overflow:hidden; }
.modal-header { display:flex; align-items:center; justify-content:space-between; padding:16px 18px 0; flex-shrink:0; }
.modal-title { font-size:16px; font-weight:600; color:var(--c-text); }
.close-btn { border:none; background:none; color:var(--c-text3); font-size:18px; cursor:pointer; padding:4px; }
.tabs { display:flex; border-bottom:1px solid var(--c-border); margin-top:10px; flex-shrink:0; overflow-x:auto; }
.tabs button { flex:1; min-width:60px; padding:10px 6px; border:none; background:none; font-size:12px; font-weight:500; color:var(--c-text2); cursor:pointer; border-bottom:2px solid transparent; font-family:var(--font); white-space:nowrap; }
.tabs button.active { color:var(--c-accent); border-bottom-color:var(--c-accent); }
.modal-body { overflow-y:auto; padding:12px 16px 24px; display:flex; flex-direction:column; gap:8px; }

.food-row { display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); }
.fav-btn { width:100%; text-align:left; cursor:pointer; font-family:var(--font); }
.fav-btn:hover { border-color:var(--c-accent); }
.food-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.food-name { font-size:13px; font-weight:500; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.food-macros { font-size:11px; color:var(--c-text2); }
.muted { color:var(--c-text3); }
.add-icon { font-size:22px; font-weight:300; color:var(--c-accent); flex-shrink:0; line-height:1; }
.fav-filter { width:100%; padding:10px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-bg); color:var(--c-text); font-size:14px; font-family:var(--font); margin-bottom:8px; }
.fav-filter:focus { outline:none; border-color:var(--c-accent); }
.qty-row { display:flex; align-items:center; gap:4px; flex-shrink:0; }
.qty-row input { width:52px; padding:5px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:13px; text-align:center; font-family:var(--font); }
.step { width:34px; height:34px; border:1px solid var(--c-border); border-radius:10px; background:var(--c-bg); color:var(--c-text); display:flex; align-items:center; justify-content:center; padding:0; cursor:pointer; flex-shrink:0; -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
.step:active { background:var(--c-surface2); }
.step:disabled { opacity:.35; cursor:default; }
.qty-val { min-width:26px; text-align:center; font-size:14px; font-weight:600; color:var(--c-text); font-variant-numeric:tabular-nums; }
.btn-add { margin-left:4px; width:30px; height:30px; border:none; border-radius:50%; background:var(--c-accent); color:var(--c-accent-fg); font-size:20px; font-weight:300; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.search-bar { display:flex; gap:8px; }
.search-bar input, /* unused */ .scan-bar-unused { flex:1; padding:9px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); }
.search-bar input:focus { outline:none; border-color:var(--c-accent); }
.btn-accent { padding:9px 14px; border:none; border-radius:var(--r-md); background:var(--c-accent); color:var(--c-accent-fg); font-size:14px; font-weight:600; cursor:pointer; font-family:var(--font); }
.btn-accent:disabled { opacity:.5; cursor:not-allowed; }
.btn-accent.full { width:100%; padding:12px; margin-top:4px; }
.hint { font-size:13px; color:var(--c-text2); margin:0; }
form { display:flex; flex-direction:column; gap:8px; }
textarea { padding:10px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); resize:none; }
textarea:focus { outline:none; border-color:var(--c-accent); }
.empty { text-align:center; color:var(--c-text3); font-size:13px; padding:30px 0; }
.error { font-size:13px; color:#e05; padding:8px 12px; background:rgba(220,50,50,.08); border-radius:8px; }
.scan-camera-label { display:flex; align-items:center; justify-content:center; gap:8px; padding:12px; border:1px dashed var(--c-border); border-radius:var(--r-md); color:var(--c-text2); font-size:13px; cursor:pointer; }
.scan-camera-label:hover { border-color:var(--c-accent); color:var(--c-accent); }
.scan-file { display:none; }
.manual-form { display:flex; flex-direction:column; gap:12px; }
.field { display:flex; flex-direction:column; gap:4px; }
.field label { font-size:11px; font-weight:500; color:var(--c-text3); text-transform:uppercase; letter-spacing:.05em; }
.field input { padding:9px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); }
.field input:focus { outline:none; border-color:var(--c-accent); }
.field-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
</style>
