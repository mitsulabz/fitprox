<script lang="ts">
  import { onMount } from 'svelte';
  import { appData, session, sharedFoods, t } from './store';
  import { saveAppState } from './supabase';
  import { refreshSharedFoods } from './sharedFoods';
  import { buildCatalog, foodKey } from './foods';
  import { priceIndex, dailyCosts, groupCosts, historyFoods, missingFromCatalog } from './budget';
  import { setFoodPrice } from './prices';
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
  const daily = $derived(dailyCosts(days, idx, { fromT: j1T }));
  let mode = $state<'week' | 'month'>('week');
  const groups = $derived(groupCosts(daily, mode, todayT));
  const hist = $derived(historyFoods(days, idx, { fromT: j1T }));
  const missing = $derived(missingFromCatalog(days, idx, { fromT: j1T }));
  const unpriced = $derived(hist.filter((h: any) => !h.priced));

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

  // ---- saisie des prix ----
  let draft = $state<Record<string, string>>({});
  let busyKey = $state('');
  let msg = $state('');

  async function savePrice(h: any) {
    const raw = draft[h.key];
    const v = parseFloat(String(raw ?? '').replace(',', '.'));
    if (!isFinite(v) || v < 0) { msg = 'Prix invalide'; return; }
    const item = catalog.find((f: any) => f.key === h.key) ?? { name: h.name, per: h.per, key: h.key };
    busyKey = h.key; msg = '';
    const r = await setFoodPrice(item, v);
    busyKey = '';
    msg = r.ok ? `✓ ${h.name} · ${r.msg}` : r.msg;
    if (r.ok) draft = { ...draft, [h.key]: '' };
    setTimeout(() => (msg = ''), 3000);
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

  {#if unpriced.length}
    <div class="section-title">Prix à renseigner ({unpriced.length})</div>
    <div class="caption" style="margin-bottom:8px">Classés par nombre de repas : les premiers pèsent le plus sur le budget. Prix {'pour 100 g, ou par portion'} selon l'aliment.</div>
    {#if missing.length}
      <button class="restore" onclick={restoreMissing} disabled={restoring}>
        {restoring ? 'Restauration…' : `Restaurer ${missing.length} aliment${missing.length > 1 ? 's' : ''} supprimé${missing.length > 1 ? 's' : ''} de la liste`}
      </button>
      <div class="caption" style="margin:4px 2px 10px">Ils reviennent en « archivé » : modifiables dans Aliments, mais pas proposés quand tu ajoutes un repas.</div>
    {/if}
    <div class="list">
      {#each unpriced.slice(0, 40) as h (h.key)}
        <div class="row">
          <div class="rinfo">
            <span class="rname">{h.name}{#if !h.inCatalog}<span class="tag">hors liste</span>{/if}</span>
            <span class="rsub">{h.count} repas · {Math.round(h.kcal)} kcal au total · {h.per === 'unit' ? 'par portion' : 'pour 100 g'}</span>
          </div>
          <div class="rprice">
            <input type="number" inputmode="decimal" min="0" step="0.01" placeholder="€"
              value={draft[h.key] ?? ''}
              oninput={(e) => (draft = { ...draft, [h.key]: (e.target as HTMLInputElement).value })} />
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
.row { display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); }
.rinfo { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.rname { font-size:13px; font-weight:500; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rsub { font-size:11px; color:var(--c-text3); }
.rcost { font-size:14px; font-weight:600; color:var(--c-text); font-variant-numeric:tabular-nums; }
.rprice { display:flex; align-items:center; gap:6px; flex-shrink:0; }
.rprice input { width:76px; padding:7px 8px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:15px; text-align:right; font-family:var(--font); }
.rprice input:focus { outline:none; border-color:var(--c-accent); }
.ok { width:32px; height:32px; border:none; border-radius:8px; background:var(--c-accent); color:var(--c-accent-fg); font-size:15px; cursor:pointer; }
.ok:disabled { opacity:.4; cursor:default; }
.tag { margin-left:6px; font-size:10px; font-weight:500; color:var(--c-text3); border:0.5px solid var(--c-border); border-radius:6px; padding:0 5px; vertical-align:1px; }
.restore { width:100%; padding:11px; border:1px dashed var(--c-accent); border-radius:var(--r-md); background:transparent; color:var(--c-accent); font-size:13px; font-weight:600; cursor:pointer; font-family:var(--font); }
.restore:disabled { opacity:.5; cursor:default; }
.empty { display:flex; flex-direction:column; align-items:center; gap:8px; padding:50px 20px; text-align:center; color:var(--c-text2); font-size:14px; }
.empty-icon { font-size:40px; }
.msg { position:sticky; bottom:8px; margin-top:12px; font-size:12.5px; color:var(--c-text); background:var(--c-surface2); border:1px solid var(--c-border); border-radius:var(--r-md); padding:9px 11px; }
</style>
