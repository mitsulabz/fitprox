<script lang="ts">
  import { onMount } from 'svelte';
  import { appData, session, sharedFoods, t } from './store';
  import { saveAppState } from './supabase';
  import { refreshSharedFoods } from './sharedFoods';
  import { buildCatalog, foodKey } from './foods';
  import { priceIndex, dailyCosts, groupCosts, historyFoods, missingFromCatalog, suggestGroups, kcalRefs } from './budget';
  import { setFoodPrice } from './prices';
  import { fitPriceModel, estimatePrice } from './estimate';
  import { userJ1 } from './account';
  import { get } from 'svelte/store';

  const uid = $derived($session?.user?.id ?? '');
  const days = $derived(($appData as any)?.days ?? {});
  const catalog = $derived(buildCatalog({
    shared: $sharedFoods, personal: ($appData as any)?.favorites,
    hidden: ($appData as any)?.hiddenFoods, archived: ($appData as any)?.archivedFoods, myId: uid,
  }));
  const idx = $derived(priceIndex(catalog));
  const j1T = $derived.by(() => {
    const [d, m, y] = userJ1(uid, $appData).split('/').map(Number);
    return new Date(y, m - 1, d).getTime();
  });

  const todayT = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  // alias : variantes d'un même aliment partageant un prix (confirmées une à une)
  const aliases = $derived(($appData as any)?.foodAliases ?? {});
  // calories de référence : une variante d'un groupe coûte au prorata de ses calories
  const refs = $derived(kcalRefs(days, idx, { fromT: j1T, aliases }));
  const daily = $derived(dailyCosts(days, idx, { fromT: j1T, aliases, refs }));
  let mode = $state<'week' | 'month'>('week');
  const groups = $derived(groupCosts(daily, mode, todayT));
  const hist = $derived(historyFoods(days, idx, { fromT: j1T, aliases, refs }));
  const missing = $derived(missingFromCatalog(days, idx, { fromT: j1T }));
  /* Candidats au regroupement : les aliments mangés, plus ceux de la liste jamais
     mangés (sinon une écriture jamais loggée ne rejoindrait aucun groupe et
     n'hériterait jamais d'un prix). */
  const groupCandidates = $derived.by(() => {
    const seen = new Set(hist.map((h: any) => h.key));
    const extras = catalog
      .filter((f: any) => !seen.has(f.key))
      .map((f: any) => ({ key: f.key, name: f.name, per: f.per === 'unit' ? 'unit' : '100',
                          count: 0, kcal: 0, priced: f.prix != null && f.prix !== '', inCatalog: true }));
    return [...hist, ...extras];
  });
  /* Propositions écartées : signature = pilote + membres. Si une nouvelle écriture
     apparaît plus tard, la signature change et le groupe est reproposé. */
  const dismissed = $derived.by(() => new Set(Array.isArray(($appData as any)?.dismissedGroups) ? ($appData as any).dismissedGroups : []));
  const sign = (g: any) => [g.key, ...g.members.map((m: any) => m.key)].sort().join('§');
  const dupes = $derived(suggestGroups(groupCandidates, aliases).filter((g: any) => !dismissed.has(sign(g))));
  const aliasCount = $derived(Object.keys(aliases).length);
  const unpriced = $derived(hist.filter((h: any) => !h.priced));
  // liste des prix à renseigner : alphabétique par défaut, recherche sans accents,
  // tri par fréquence disponible (les plus fréquents pèsent le plus sur le budget)
  let search = $state('');
  let sortBy = $state<'az' | 'freq'>('az');
  const norm = (s: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const unpricedView = $derived.by(() => {
    const q = norm(search);
    const list = unpriced.filter((h: any) => !q || norm(h.name).includes(q));
    return sortBy === 'az'
      ? [...list].sort((a: any, b: any) => a.name.localeCompare(b.name, 'fr'))
      : list;
  });

  const totals = $derived.by(() => {
    const cost = daily.reduce((s: number, d: any) => s + d.cost, 0);
    const kT = daily.reduce((s: number, d: any) => s + d.kcalTotal, 0);
    const kP = daily.reduce((s: number, d: any) => s + d.kcalPriced, 0);
    const n = daily.length;
    return { cost, n, perDay: n ? cost / n : 0, coverage: kT ? kP / kT : 0,
             perMonth: n ? (cost / n) * 30.4 : 0 };
  });

  onMount(() => { refreshSharedFoods(); });

  const eur = (v: number, dec = 2) => v.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' €';
  const MO = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  const gLabel = (g: any) => {
    const d = new Date(g.start);
    return mode === 'month' ? `${MO[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` : `${d.getDate()} ${MO[d.getMonth()]}`;
  };

  // histogramme : barres + axe, dessiné à la largeur du cadre (viewBox 320)
  const chart = $derived.by(() => {
    const G = groups.slice(-(mode === 'week' ? 14 : 12));
    if (!G.length) return null;
    const W = 320, PL = 30, PR = 8, PT = 16, PH = 92, PB = 22;
    const hi = Math.max(...G.map((g: any) => g.cost)) || 1;
    const top = Math.ceil(hi / 10) * 10 || 10;
    const bw = (W - PL - PR) / G.length;
    const Y = (v: number) => PT + PH - (v / top) * PH;
    const grid = [0, 0.5, 1].map((f) => ({ y: +Y(top * f).toFixed(1), label: Math.round(top * f) }));
    const bars = G.map((g: any, i: number) => ({
      x: +(PL + i * bw + bw * 0.16).toFixed(1), w: +(bw * 0.68).toFixed(1),
      y: +Y(g.cost).toFixed(1), h: +Math.max(1, PT + PH - Y(g.cost)).toFixed(1),
      cx: +(PL + i * bw + bw / 2).toFixed(1), label: gLabel(g), cost: g.cost,
      partial: !g.complete, show: G.length <= 8 || i % 2 === 0,
    }));
    return { vb: `0 0 ${W} ${PT + PH + PB}`, W, PL, PR, PT, yb: PT + PH, grid, bars };
  });

  /* ---- Estimation (à valider) ----
     Le modèle apprend sur tes aliments déjà chiffrés au kilo : le prix suit surtout
     les protéines et l'énergie. Les familles connues (lait, fromage, pâtes…) priment. */
  const priceModel = $derived.by(() => fitPriceModel(
    catalog
      .filter((f: any) => f.prix != null && f.prix !== '' && (f.prixUnit ?? f.prix_unit) === 'kg')
      .map((f: any) => ({ kcal: +f.kcal || 0, prot: +f.p || 0, perKg: +f.prix }))
  ));
  function foodInfo(h: any) {
    const f = catalog.find((x: any) => x.key === h.key);
    return { name: h.name, grams: h.grams ?? 0,
             kcal100: +(f?.kcal ?? 0) || (h.count ? h.kcal / h.count : 0),
             prot100: +(f?.p ?? 0) || 0, kcalPerMeal: h.count ? h.kcal / h.count : 0 };
  }
  let estimated = $state<Record<string, string>>({});
  function estimateOne(h: any) {
    const e = estimatePrice(foodInfo(h), priceModel);
    if (!e) { msg = `Pas d'estimation possible pour « ${h.name} »`; setTimeout(() => (msg = ''), 3000); return false; }
    draft = { ...draft, [h.key]: String(e.value).replace('.', ',') };
    unitDraft = { ...unitDraft, [h.key]: e.unit };
    estimated = { ...estimated, [h.key]: e.source ?? 'estimé' };
    return true;
  }
  function estimateAll() {
    let n = 0;
    for (const h of unpricedView) if (!draft[h.key] && estimateOne(h)) n++;
    msg = n ? `${n} prix estimés — vérifie et valide ceux qui te vont` : "Aucune estimation possible";
    setTimeout(() => (msg = ''), 5000);
  }

  // ---- saisie des prix ----
  let draft = $state<Record<string, string>>({});
  // unité de saisie : au kilo quand la quantité est lisible dans le nom, sinon par ligne
  let unitDraft = $state<Record<string, 'kg' | 'portion'>>({});
  const unitOf = (h: any): 'kg' | 'portion' => unitDraft[h.key] ?? (h.gramsKnown ? 'kg' : 'portion');
  const qty = (g: number) => (g >= 1000 ? (g / 1000).toLocaleString('fr-FR') + ' kg' : Math.round(g) + ' g');
  const preview = (h: any) => {
    const v = parseFloat(String(draft[h.key] ?? '').replace(',', '.'));
    if (!isFinite(v) || v <= 0) return '';
    if (unitOf(h) === 'kg' && h.grams > 0) return `→ ${eur((v / 1000) * h.grams)} pour ${qty(h.grams)}`;
    return `→ ${eur(v)} par ligne`;
  };
  let busyKey = $state('');
  let msg = $state('');

  async function savePrice(h: any) {
    const raw = draft[h.key];
    const v = parseFloat(String(raw ?? '').replace(',', '.'));
    if (!isFinite(v) || v < 0) { msg = 'Prix invalide'; return; }
    const item = catalog.find((f: any) => f.key === h.key) ?? { name: h.name, per: h.per, key: h.key };
    busyKey = h.key; msg = '';
    const r = await setFoodPrice(item, v, unitOf(h));
    busyKey = '';
    msg = r.ok ? `✓ ${h.name} · ${r.msg}` : r.msg;
    if (r.ok) { draft = { ...draft, [h.key]: '' }; estimated = { ...estimated, [h.key]: '' }; }
    setTimeout(() => (msg = ''), 3000);
  }

  /* Fusion d'un groupe : les variantes pointent vers le pilote et disparaissent de la liste.
     Rien n'est renommé ni supprimé dans l'historique ; annulable d'un bouton. */
  async function saveAliases(next: Record<string, string>, okMsg: string) {
    const s = get(session); const data = get(appData) as any;
    if (!s || !data) return;
    const newData = { ...data, foodAliases: next };
    appData.set(newData);
    try { await saveAppState(s.access_token, s.user.id, newData); msg = okMsg; }
    catch { msg = 'Erreur de sauvegarde'; }
    setTimeout(() => (msg = ''), 4000);
  }
  function mergeGroup(g: any) {
    const next = { ...aliases };
    for (const m of g.members) next[m.key] = g.key;
    saveAliases(next, `✓ ${g.members.length + 1} écritures regroupées sous « ${g.name} »`);
  }
  function dismissGroups(list: any[], okMsg: string) {
    const s = get(session); const data = get(appData) as any;
    if (!s || !data) return;
    const next = [...dismissed, ...list.map(sign)];
    const newData = { ...data, dismissedGroups: [...new Set(next)] };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData).then(() => { msg = okMsg; setTimeout(() => (msg = ''), 3500); });
  }
  function restoreDismissed() {
    const s = get(session); const data = get(appData) as any;
    if (!s || !data) return;
    const newData = { ...data, dismissedGroups: [] };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  /* Rattachement manuel : relier un aliment à un autre quand l'app ne le propose pas
     (« Pain au chocolat moyen (60g) » -> « pain au chocolat »). Même effet qu'un groupe :
     le prix du pilote s'applique, au kilo ou au prorata des calories. */
  let linking = $state<any>(null);
  let linkSearch = $state('');
  const linkTargets = $derived.by(() => {
    if (!linking) return [];
    const q = norm(linkSearch);
    return groupCandidates
      .filter((f: any) => f.key !== linking.key && !aliases[f.key] && (!q || norm(f.name).includes(q)))
      .sort((a: any, b: any) => (b.priced ? 1 : 0) - (a.priced ? 1 : 0) || b.count - a.count || a.name.localeCompare(b.name, 'fr'))
      .slice(0, 60);
  });
  function attachTo(target: any) {
    const next = { ...aliases, [linking.key]: target.key };
    const name = linking.name;
    linking = null; linkSearch = '';
    saveAliases(next, `✓ « ${name} » rattaché à « ${target.name} »`);
  }
  function detach(h: any) {
    const next = { ...aliases };
    let n = 0;
    for (const [k, v] of Object.entries(next)) if (k === h.key || v === h.key) { delete next[k]; n++; }
    if (n) saveAliases(next, `✓ ${n} rattachement${n > 1 ? 's' : ''} défait${n > 1 ? 's' : ''}`);
  }

  function undoAliases() {
    if (!confirm('Annuler tous les regroupements ?')) return;
    saveAliases({}, '✓ Regroupements annulés');
  }

  /* Aliments présents dans l'historique mais supprimés de la liste : on les recrée
     en « archivé » (visibles ici et dans Aliments, exclus de la fenêtre d'ajout)
     pour pouvoir leur donner un prix sans polluer la saisie des repas. */
  let restoring = $state(false);
  async function restoreMissing() {
    const s = get(session); const data = get(appData) as any;
    if (!s || !data || !missing.length) return;
    restoring = true;
    const favorites: any[] = Array.isArray(data.favorites) ? [...data.favorites] : [];
    const archivedFoods: string[] = Array.isArray(data.archivedFoods) ? [...data.archivedFoods] : [];
    for (const m of missing) {
      const key = foodKey(m.name, m.per);
      if (!favorites.some((f: any) => foodKey(f.name, f.per) === key))
        favorites.push({ name: m.name, per: m.per, kcal: m.kcal, p: m.p, g: m.g, l: m.l, fi: m.fi, sel: null, img: '', prix: null });
      if (!archivedFoods.includes(key)) archivedFoods.push(key);
    }
    const newData = { ...data, favorites, archivedFoods };
    appData.set(newData);
    try { await saveAppState(s.access_token, s.user.id, newData); msg = `✓ ${missing.length} aliment(s) de l'historique restauré(s) en archivé`; }
    catch { msg = 'Erreur de sauvegarde'; }
    restoring = false;
    setTimeout(() => (msg = ''), 4000);
  }
</script>

<div class="scroll-area">
  <div class="header">
    <div class="title">Budget nourriture</div>
    <div class="caption">
      {#if daily.length}{daily.length} jours chiffrés depuis le {userJ1(uid, $appData)}{:else}Aucune journée chiffrée pour l'instant{/if}
    </div>
  </div>

  {#if totals.n}
    <div class="kpis">
      <div class="card kpi"><div class="lab">Total</div><div class="val">{eur(totals.cost)}</div><div class="sub">depuis le début</div></div>
      <div class="card kpi"><div class="lab">Par jour</div><div class="val">{eur(totals.perDay)}</div><div class="sub">≈ {eur(totals.perMonth, 0)} / mois</div></div>
    </div>
    {#if totals.coverage < 0.995}
      <div class="warn">
        ⚠︎ {Math.round(totals.coverage * 100)} % de tes calories sont chiffrées : les montants ci-dessus sont donc <b>sous-estimés</b>.
        Renseigne les prix manquants plus bas pour fiabiliser le budget.
      </div>
    {/if}
  {/if}

  {#if chart}
    <div class="card chart-card">
      <div class="chead">
        <span class="label">Dépense par {mode === 'week' ? 'semaine' : 'mois'}</span>
        <div class="seg">
          <button class:on={mode === 'week'} onclick={() => (mode = 'week')}>Semaine</button>
          <button class:on={mode === 'month'} onclick={() => (mode = 'month')}>Mois</button>
        </div>
      </div>
      <svg viewBox={chart.vb} class="bchart" role="img" aria-label="Dépense par période">
        {#each chart.grid as g}
          <line x1={chart.PL} x2={chart.W - chart.PR} y1={g.y} y2={g.y} class="bc-grid" />
          <text x={chart.PL - 6} y={g.y + 3.4} class="bc-tk" text-anchor="end">{g.label}</text>
        {/each}
        {#each chart.bars as b}
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="2" class="bc-bar" class:partial={b.partial} />
          {#if b.show}<text x={b.cx} y={chart.yb + 13} class="bc-tk" text-anchor="middle">{b.label}</text>{/if}
        {/each}
      </svg>
      <div class="caption">En euros. {#if chart.bars.some((b: any) => b.partial)}La dernière barre, plus claire, est une période en cours.{/if}</div>
    </div>
  {/if}

  {#if dupes.length}
    <div class="section-title">Doublons à regrouper ({dupes.length})</div>
    <button class="ignore-all" onclick={() => dismissGroups(dupes, `${dupes.length} proposition${dupes.length > 1 ? 's' : ''} ignorée${dupes.length > 1 ? 's' : ''}`)}>
      Tout ignorer
    </button>
    <div class="caption" style="margin-bottom:8px">
      Même aliment écrit de plusieurs façons. Tu ne donnes le prix qu'une fois, sur l'aliment en gras.
      <b>Les autres quantités sont calculées au prorata des calories</b> : si « 300 ml » coûte 0,33 €, « 100 ml » comptera 0,11 €.
      Ton historique n'est pas modifié.
    </div>
    <div class="list">
      {#each dupes.slice(0, 25) as g (g.key)}
        <div class="row dupe">
          <div class="rinfo">
            <span class="rname">{g.name}{#if g.kind === 'proche'}<span class="tag">à vérifier</span>{/if}</span>
            <span class="rsub">+ {g.members.map((m: any) => m.name).join(' · ')}</span>
            <span class="rsub">{g.count} repas au total{#if g.members.some((m: any) => !m.count)} · dont une écriture jamais mangée{/if}</span>
          </div>
          <div class="dactions">
            <button class="merge" onclick={() => mergeGroup(g)}>Regrouper</button>
            <button class="ignore" onclick={() => dismissGroups([g], 'Proposition ignorée')}>Ignorer</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if dismissed.size}
    <button class="undo" onclick={restoreDismissed}>Réafficher les {dismissed.size} proposition{dismissed.size > 1 ? 's' : ''} ignorée{dismissed.size > 1 ? 's' : ''}</button>
  {/if}

  {#if aliasCount}
    <button class="undo" onclick={undoAliases}>Annuler les {aliasCount} regroupement{aliasCount > 1 ? 's' : ''}</button>
  {/if}

  {#if unpriced.length}
    <div class="section-title">Prix à renseigner ({unpriced.length})</div>
    <div class="caption" style="margin-bottom:8px">
      Saisis le <b>prix au kilo</b> (celui affiché en rayon et sur les sites de courses) : l'app connaît la quantité de chaque ligne.
      Pour un aliment sans quantité lisible (« œuf au plat »), bascule le bouton sur <b>/ligne</b> et donne le prix d'une fois.
    </div>
    {#if missing.length}
      <button class="restore" onclick={restoreMissing} disabled={restoring}>
        {restoring ? 'Restauration…' : `Restaurer ${missing.length} aliment${missing.length > 1 ? 's' : ''} supprimé${missing.length > 1 ? 's' : ''} de la liste`}
      </button>
      <div class="caption" style="margin:4px 2px 10px">Ils reviennent en « archivé » : modifiables dans Aliments, mais pas proposés quand tu ajoutes un repas.</div>
    {/if}
    <button class="ignore-all" onclick={estimateAll}>Estimer tous les prix manquants</button>
    <div class="toolbar">
      <input class="search" type="search" placeholder="Rechercher un aliment…" bind:value={search}
        autocomplete="off" autocorrect="off" spellcheck="false" />
      <div class="seg">
        <button class:on={sortBy === 'az'} onclick={() => (sortBy = 'az')}>A→Z</button>
        <button class:on={sortBy === 'freq'} onclick={() => (sortBy = 'freq')}>Fréquence</button>
      </div>
    </div>
    {#if search && !unpricedView.length}
      <div class="caption" style="padding:10px 2px">Aucun aliment ne correspond à « {search} ».</div>
    {/if}
    <div class="list">
      {#each unpricedView as h (h.key)}
        <div class="row">
          <div class="rinfo">
            <span class="rname">{h.name}{#if !h.inCatalog}<span class="tag">hors liste</span>{/if}</span>
            <span class="rsub">
              {h.count} repas{#if h.variants && h.variants.length > 1} · {h.variants.length} écritures regroupées{/if}{#if h.gramsKnown} · quantité lue : {qty(h.grams)}{/if}
            </span>
            {#if draft[h.key]}<span class="rsub calc">{preview(h)}{#if estimated[h.key]} · estimé ({estimated[h.key]}){/if}</span>{/if}
          </div>
          <div class="rprice">
            <input type="number" inputmode="decimal" min="0" step="0.01" placeholder="€"
              value={draft[h.key] ?? ''}
              oninput={(e) => (draft = { ...draft, [h.key]: (e.target as HTMLInputElement).value })} />
            <button class="unit" onclick={() => (unitDraft = { ...unitDraft, [h.key]: unitOf(h) === 'kg' ? 'portion' : 'kg' })}
              title="Prix au kilo, ou prix d'une ligne">{unitOf(h) === 'kg' ? '/kg' : '/ligne'}</button>
            <button class="unit" onclick={() => { linking = h; linkSearch = ''; }} title="Rattacher à un autre aliment">⇄</button>
            <button class="unit est" onclick={() => estimateOne(h)} title="Proposer un prix, à vérifier">≈</button>
            <button class="ok" onclick={() => savePrice(h)} disabled={busyKey === h.key || !draft[h.key]}>✓</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if hist.some((h: any) => h.priced)}
    <div class="section-title">Ce qui coûte le plus</div>
    <div class="list">
      {#each hist.filter((h: any) => h.priced).sort((a: any, b: any) => b.cost - a.cost).slice(0, 12) as h (h.key)}
        <div class="row">
          <div class="rinfo">
            <span class="rname">{h.name}</span>
            <span class="rsub">{h.count} repas · {totals.cost > 0 ? Math.round((h.cost / totals.cost) * 100) : 0} % du budget</span>
          </div>
          <span class="rcost">{eur(h.cost)}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if !totals.n}
    <div class="empty">
      <div class="empty-icon">🧾</div>
      <div>Aucun prix renseigné pour l'instant.</div>
      <div class="caption">Donne un prix à tes aliments (ici ou dans l'onglet Aliments) : tout ton historique est chiffré automatiquement.</div>
    </div>
  {/if}

  {#if linking}
    <button class="sheet-bg" aria-label="Fermer" onclick={() => (linking = null)}></button>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Rattacher un aliment">
      <div class="sheet-title">Rattacher « {linking.name} »</div>
      <div class="caption">Choisis l'aliment qui porte le prix. Les deux seront comptés ensemble : au kilo, chaque ligne suit sa quantité ; sinon le prix suit le rapport des calories.</div>
      <input class="search" type="search" placeholder="Rechercher…" bind:value={linkSearch} autocomplete="off" spellcheck="false" />
      <div class="list">
        {#each linkTargets as tg (tg.key)}
          <button class="row pick" onclick={() => attachTo(tg)}>
            <span class="rinfo">
              <span class="rname">{tg.name}</span>
              <span class="rsub">{tg.count} repas{#if tg.priced} · prix renseigné{/if}</span>
            </span>
            <span class="rcost">→</span>
          </button>
        {/each}
        {#if !linkTargets.length}<div class="caption" style="padding:10px 2px">Aucun aliment ne correspond.</div>{/if}
      </div>
      <button class="ignore-all" onclick={() => (linking = null)}>Annuler</button>
    </div>
  {/if}

  {#if msg}<div class="msg">{msg}</div>{/if}
</div>

<style>
.header { padding:20px 0 14px; }
.title { font-size:20px; font-weight:500; color:var(--c-text); }
.caption { font-size:12px; color:var(--c-text3); margin-top:2px; }
.kpis { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }
.kpi { padding:14px; }
.kpi .lab { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--c-text3); }
.kpi .val { font-size:22px; font-weight:600; color:var(--c-text); margin-top:4px; font-variant-numeric:tabular-nums; }
.kpi .sub { font-size:11px; color:var(--c-text3); margin-top:2px; }
.warn { font-size:12.5px; line-height:1.45; color:var(--c-text2); background:var(--c-surface); border:1px solid var(--c-border); border-radius:var(--r-md); padding:9px 11px; margin-bottom:10px; }
.chart-card { padding:14px; margin-bottom:10px; }
.chead { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px; }
.label { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--c-text3); }
.seg { display:flex; background:var(--c-surface2); border-radius:9px; padding:2px; gap:2px; }
.seg button { border:0; background:transparent; color:var(--c-text2); font-size:12px; font-weight:500; padding:5px 10px; border-radius:7px; cursor:pointer; font-family:var(--font); }
.seg button.on { background:var(--c-accent); color:var(--c-accent-fg); }
.bchart { width:100%; height:auto; display:block; }
.bc-grid { stroke:var(--c-border); stroke-width:1; }
.bc-tk { font-size:8.5px; fill:var(--c-text3); font-family:var(--font); }
.bc-bar { fill:var(--c-accent); }
.bc-bar.partial { opacity:.45; }
.section-title { font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:0.06em; color:var(--c-text3); margin:18px 0 6px; }
.list { display:flex; flex-direction:column; gap:6px; }
.toolbar { display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
.search { flex:1; min-width:160px; padding:10px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:14px; font-family:var(--font); }
.search:focus { outline:none; border-color:var(--c-accent); }
.row { display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); }
.rinfo { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.rname { font-size:13px; font-weight:500; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rsub { font-size:11px; color:var(--c-text3); }
.rcost { font-size:14px; font-weight:600; color:var(--c-text); font-variant-numeric:tabular-nums; }
.rprice { display:flex; align-items:center; gap:6px; flex-shrink:0; }
.rprice input { width:76px; padding:7px 8px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:15px; text-align:right; font-family:var(--font); }
.rprice input:focus { outline:none; border-color:var(--c-accent); }
.unit { flex-shrink:0; min-width:44px; height:32px; padding:0 6px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text2); font-size:11px; font-weight:600; cursor:pointer; font-family:var(--font); }
.calc { color:var(--c-accent); font-weight:600; }
.est { color:var(--c-accent); border-color:var(--c-accent); }
.ok { width:32px; height:32px; border:none; border-radius:8px; background:var(--c-accent); color:var(--c-accent-fg); font-size:15px; cursor:pointer; }
.ok:disabled { opacity:.4; cursor:default; }
.tag { margin-left:6px; font-size:10px; font-weight:500; color:var(--c-text3); border:0.5px solid var(--c-border); border-radius:6px; padding:0 5px; vertical-align:1px; }
.dupe { align-items:flex-start; }
.dupe .rsub { white-space:normal; }
.dactions { display:flex; flex-direction:column; gap:6px; flex-shrink:0; }
.ignore { border:1px solid var(--c-border); border-radius:8px; background:transparent; color:var(--c-text3); font-size:12px; padding:6px 10px; cursor:pointer; font-family:var(--font); }
.ignore-all { display:block; margin:0 0 8px auto; border:none; background:none; color:var(--c-text3); font-size:12px; text-decoration:underline; cursor:pointer; font-family:var(--font); }
.merge { flex-shrink:0; border:none; border-radius:8px; background:var(--c-accent); color:var(--c-accent-fg); font-size:12.5px; font-weight:600; padding:8px 12px; cursor:pointer; font-family:var(--font); }
.undo { display:block; margin:10px auto 0; border:none; background:none; color:var(--c-text3); font-size:12px; text-decoration:underline; cursor:pointer; font-family:var(--font); }
.restore { width:100%; padding:11px; border:1px dashed var(--c-accent); border-radius:var(--r-md); background:transparent; color:var(--c-accent); font-size:13px; font-weight:600; cursor:pointer; font-family:var(--font); }
.restore:disabled { opacity:.5; cursor:default; }
.sheet-bg { position:fixed; inset:0; z-index:300; border:0; padding:0; background:rgba(0,0,0,.45); cursor:default; }
.sheet { position:fixed; left:0; right:0; bottom:0; z-index:301; max-height:86dvh; overflow-y:auto; background:var(--c-bg); border-radius:18px 18px 0 0; padding:16px 16px calc(18px + env(safe-area-inset-bottom, 0px)); display:flex; flex-direction:column; gap:10px; max-width:620px; margin:0 auto; }
.sheet-title { font-size:16px; font-weight:600; color:var(--c-text); }
.pick { width:100%; text-align:left; cursor:pointer; font-family:var(--font); }
.empty { display:flex; flex-direction:column; align-items:center; gap:8px; padding:50px 20px; text-align:center; color:var(--c-text2); font-size:14px; }
.empty-icon { font-size:40px; }
.msg { position:sticky; bottom:8px; margin-top:12px; font-size:12.5px; color:var(--c-text); background:var(--c-surface2); border:1px solid var(--c-border); border-radius:var(--r-md); padding:9px 11px; }
</style>
