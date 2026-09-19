<script lang="ts">
  import { theme, t, session, appData, persistSession, sharedFoods } from "./store";
  import { saveAppState } from "./supabase";
  import { buildTimeline, estimateBase, settingsFor, dsToMs, nf, ADAPT_DEFAULT } from "./engine";
  import { userJ1, effectiveSettingsLog, basePrior, isEstimateSource } from "./account";
  import { buildCatalog } from "./foods";
  import BaseSetup from "./BaseSetup.svelte";

  const uid = $derived($session?.user?.id ?? '');

  // Suivi des fibres (option du profil) : ajoute une 4e macro dans Suivi, la saisie et les listes
  const trackFiber = $derived(!!($appData as any)?.profile?.trackFiber);
  let fiberStatus = $state('');
  async function toggleFiber() {
    const s = $session; const data = $appData as any;
    if (!s || !data) return;
    const newData = { ...data, profile: { ...(data.profile ?? {}), trackFiber: !trackFiber } };
    appData.set(newData);
    try { await saveAppState(s.access_token, s.user.id, newData); fiberStatus = ''; }
    catch { fiberStatus = 'Erreur de sauvegarde'; }
  }

  function toggleTheme() { theme.update(v => v === "dark" ? "light" : "dark"); }

  function exportData() {
    const data = $appData;
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fitpro-export-${new Date().toLocaleDateString('fr-FR').replace(/\//g,'-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Journal quotidien en CSV (à donner à une IA pour analyse) :
  // une ligne par jour depuis le J1 — apport + macros, Sport cal, poids, %MG.
  function exportJournal() {
    const data = $appData as any;
    if (!data) return;
    const days = data.days ?? {};
    const rows = ['date,kcal_mangees,proteines_g,glucides_g,lipides_g,fibres_g,sport_kcal_actives,poids_kg,masse_grasse_pct'];
    const [jd, jm, jy] = userJ1(uid, data).split('/').map(Number);
    const j1 = new Date(jy, jm - 1, jd); // J1 de l'utilisateur (propriétaire : 22 juin 2026)
    const end = new Date(); end.setHours(0, 0, 0, 0);
    for (const c = new Date(j1); c.getTime() <= end.getTime(); c.setDate(c.getDate() + 1)) {
      const ds = c.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const dd: any = days[ds] ?? {};
      const fds = dd.foods ?? [];
      const logged = fds.length > 0;
      const sum = (key: string) => fds.reduce((s: number, f: any) => s + (f[key] || 0), 0);
      const iso = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}-${String(c.getDate()).padStart(2, '0')}`;
      const w = nf(dd.weight), bf = nf(dd.bf);
      rows.push([
        iso,
        logged ? Math.round(sum('k')) : '',
        logged ? +sum('p').toFixed(1) : '',
        logged ? +sum('g').toFixed(1) : '',
        logged ? +sum('l').toFixed(1) : '',
        fds.some((f: any) => f.fi != null) ? +sum('fi').toFixed(1) : '',
        logged ? Math.round(nf(dd.extraKcal)) : '',
        w > 0 ? w : '',
        bf > 0 ? bf : '',
      ].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fitpro-journal-${new Date().toLocaleDateString('fr-FR').replace(/\//g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Aliments visibles (catalogue partagé ∪ favoris, hors masqués) + macros, en CSV.
  function exportAliments() {
    const data = $appData as any;
    if (!data) return;
    const favs = buildCatalog({
      shared: $sharedFoods, personal: data.favorites, hidden: data.hiddenFoods, myId: $session?.user?.id ?? '',
    });
    const esc = (v: any) => {
      const s = String(v ?? '');
      return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = ['nom,base,kcal,proteines_g,glucides_g,lipides_g,fibres_g,sel_g'];
    for (const f of favs) {
      rows.push([
        esc(f.name),
        f.per === 'unit' ? 'portion' : '100g',
        Math.round(nf(f.kcal)),
        +nf(f.p).toFixed(1),
        +nf(f.g).toFixed(1),
        +nf(f.l).toFixed(1),
        f.fi != null && f.fi !== '' ? +nf(f.fi).toFixed(1) : '',
        f.sel != null && f.sel !== '' ? +nf(f.sel).toFixed(2) : '',
      ].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fitpro-aliments-${new Date().toLocaleDateString('fr-FR').replace(/\//g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  let importStatus = $state('');
  let fileInput: HTMLInputElement;

  // ── Base hors sport : datée ; estimation rapide = formule + mesures pondérées ──
  const _now = new Date(); _now.setHours(0,0,0,0);
  const todayMs = _now.getTime();
  const todayDs = _now.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  const J1_DS = $derived(userJ1(uid, $appData)); // propriétaire : 22/06/2026 ; autres : leur 1er jour
  const curSettings = $derived(settingsFor(effectiveSettingsLog(uid, $appData), todayMs) as any);
  const prior = $derived(basePrior(uid, $appData, curSettings));
  let baseForm = $state({ baseRef: '', poidsRef: '', adaptCoef: '' });
  let baseLoaded = false;
  let baseStatus = $state('');
  let showSetup = $state(false);

  function syncForm() {
    const cur: any = settingsFor(effectiveSettingsLog(uid, $appData), todayMs);
    baseForm = { baseRef: String(cur.baseRef), poidsRef: String(cur.poidsRef), adaptCoef: String(cur.adaptCoef ?? ADAPT_DEFAULT) };
  }
  $effect(() => {
    if ($appData && !baseLoaded) { syncForm(); baseLoaded = true; }
  });

  const timelineAll = $derived.by(() => {
    const data = $appData as any; if (!data) return null;
    const days = data.days ?? {};
    const dateList = Object.keys(days).map((ds: string) => ({ ds, t: dsToMs(ds) })).filter((x: any) => !isNaN(x.t)).sort((a: any, b: any) => a.t - b.t);
    const info = (ds: string) => {
      const dd: any = days[ds] ?? {}; const fds = dd.foods ?? [];
      return { weight: nf(dd.weight), bf: nf(dd.bf), eaten: fds.reduce((s: number,f: any)=>s+(f.k||0),0), gluc: fds.reduce((s: number,f: any)=>s+(f.g||0),0), prot: fds.reduce((s: number,f: any)=>s+(f.p||0),0), extraKcal: dd.extraKcal ?? 0, sportKcal: 0, libre: !!dd.libre, logged: fds.length > 0 };
    };
    return buildTimeline({ dateList, settingsLog: effectiveSettingsLog(uid, data), todayTime: todayMs, dayFrac: 1, info }) as any;
  });
  const recalib = $derived(timelineAll ? estimateBase(timelineAll, prior, { startT: dsToMs(J1_DS) }) as any : null);

  /* Base historique (information seulement) : même bilan énergétique, mais sur TOUT l'historique
     depuis J1 + 7 jours, sans mélange avec le réglage. Elle vaut au poids moyen de la période ;
     on la ramène aussi au poids actuel (−12 kcal par kg perdu depuis). */
  const histBase = $derived.by(() => {
    if (!timelineAll) return null;
    const r: any = estimateBase(timelineAll, null, { startT: dsToMs(J1_DS), window: Infinity });
    if (!r.ok) return r;
    const last = [...timelineAll.list].reverse().find((x: any) => !x.isFuture && (x.pm7 != null || x.weight > 0));
    const nowW = last ? (last.pm7 ?? last.weight) : null;
    const fmt = (t: number) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    return { ...r, from: fmt(r.t0), to: fmt(r.tEnd), nowW: nowW ? +(+nowW).toFixed(1) : null,
      atNow: nowW ? Math.round(r.measured - 12 * (r.poidsRef - nowW)) : null };
  });

  /* Date d'effet : aujourd'hui par défaut (le passé reste figé).
     Avec allHistory, on remplace TOUT le journal par une seule entrée datée du J1.
     Ce cas sert quand la base précédente n'était pas une mesure mais une estimation :
     la figer perpétuerait l'erreur au lieu de la corriger. extra : source, incertitude. */
  async function saveBase(baseRef: any, poidsRef: any, adaptCoef: any, allHistory = false, extra: Record<string, unknown> = {}) {
    const s = $session; const data = $appData as any;
    if (!s || !data) return;
    const fromDs = allHistory ? J1_DS : todayDs;
    baseStatus = 'Sauvegarde…';
    const prog = data.programme ?? {};
    let log: any[] = [];
    if (!allHistory) {
      log = Array.isArray(prog.settingsLog) ? [...prog.settingsLog] : [];
      if (!log.length) log = effectiveSettingsLog(uid, data).slice(); // fige le passé avec la base initiale
      log = log.filter((e: any) => e.from !== fromDs);
    }
    log.push({ from: fromDs, baseRef: Math.round(nf(baseRef)), poidsRef: +nf(poidsRef).toFixed(2), adaptCoef: Math.max(0, Math.min(0.15, nf(adaptCoef))), ...extra });
    log.sort((a: any, b: any) => dsToMs(a.from) - dsToMs(b.from));
    const newData = { ...data, programme: { ...prog, settingsLog: log } };
    appData.set(newData);
    try {
      await saveAppState(s.access_token, s.user.id, newData);
      baseStatus = allHistory ? '✓ Base appliquée à tout l’historique' : '✓ Base enregistrée (dès aujourd’hui)';
    } catch { baseStatus = 'Erreur de sauvegarde'; }
    setTimeout(() => baseStatus = '', 2600);
  }
  function saveBaseForm() { saveBase(baseForm.baseRef, baseForm.poidsRef, baseForm.adaptCoef); }
  function saveBaseAll() {
    const b = Math.round(nf(baseForm.baseRef));
    if (!confirm(`Appliquer ${b} kcal/j à TOUT ton historique depuis le ${J1_DS} ?

Les déficits de tous tes jours passés seront recalculés, et les réglages datés précédents remplacés.

À n'utiliser que si la base précédente était une estimation, pas une mesure.`)) return;
    saveBase(baseForm.baseRef, baseForm.poidsRef, baseForm.adaptCoef, true);
  }

  /* Appliquer l'estimation : tant que la base en vigueur n'est qu'une estimation, on corrige
     tout l'historique ; dès que la confiance est bonne, elle devient une mesure (passé figé ensuite).
     Adaptation à 0 : l'estimation s'appuie sur tes mesures, qui contiennent déjà le ralentissement. */
  function applyEstimate() {
    const r: any = recalib;
    if (!r || !r.ok) return;
    const allHistory = isEstimateSource(curSettings.source);
    baseForm = { ...baseForm, baseRef: String(r.base), poidsRef: String(r.poidsRef), adaptCoef: '0' };
    saveBase(r.base, r.poidsRef, 0, allHistory, { source: r.confidence === 'bonne' ? 'mesure' : 'estimation', sigma: r.sigma });
  }

  function triggerImport() { fileInput.click(); }

  async function onFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    importStatus = 'Lecture…';
    try {
      const text = await file.text();
      const json = JSON.parse(text);

      const s = $session;
      if (!s) { importStatus = 'Non connecté'; return; }

      // Garde-fou : l'import remplace TOUT l'état cloud — on n'accepte qu'un export complet.
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        importStatus = 'Fichier invalide : pas un export FitProX.'; fileInput.value = ''; return;
      }
      if ((json as any).jours && !(json as any).days) {
        importStatus = 'Fichier « programme » (obsolète) refusé — importe un export complet.'; fileInput.value = ''; return;
      }
      if (!(json as any).days && !(json as any).profile) {
        importStatus = 'Fichier refusé : il ne contient ni jours ni profil (export complet requis).'; fileInput.value = ''; return;
      }
      const newData: Record<string, unknown> = json;

      importStatus = 'Sauvegarde…';
      const r = await fetch(`https://arydsxswhbgpfayjgtak.supabase.co/rest/v1/app_state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyeWRzeHN3aGJncGZheWpndGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODU1NzcsImV4cCI6MjA5Njk2MTU3N30.JwhGPqopTzi74jv-1zM5JSOAZ0O78p1Q667pB4ZMcH8',
          'Authorization': `Bearer ${s.access_token}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ user_id: s.user.id, data: newData, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) {
        const err = await r.text();
        console.error('saveAppState error:', r.status, err);
        importStatus = `Erreur sauvegarde (${r.status})`;
        return;
      }

      appData.set(newData);
      importStatus = '✓ Importé — rechargement…';
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      console.error('Import error:', err);
      importStatus = 'Erreur : fichier invalide';
    }
    fileInput.value = '';
  }

  function signout() {
    persistSession(null);
    appData.set(null);
  }
</script>

<div class="scroll-area">
  <div class="sheader">
    <div class="label">{$t.nav.reglages}</div>
    <div class="stitle">{$t.nav.reglages}</div>
  </div>

  <div class="section-title">Dépense hors sport (base)</div>
  <div class="section profile-form">
    <button class="card save-btn" onclick={() => (showSetup = true)}>🧮 Calcul calories de départ</button>
    {#if isEstimateSource(curSettings.source)}
      <p class="pf-hint">Ta base actuelle est une <b>estimation</b>{curSettings.source === 'formule' ? ' par formule' : ''} : elle s'affine avec tes repas et tes pesées.</p>
    {/if}
    <label class="pf-row"><span>Base (kcal/j)</span><input type="number" inputmode="numeric" step="10" bind:value={baseForm.baseRef} /></label>
    <label class="pf-row"><span>Poids de réf. (kg)</span><input type="number" inputmode="decimal" step="0.1" bind:value={baseForm.poidsRef} /></label>
    <label class="pf-row"><span>Adaptation (0–0,15)</span><input type="number" inputmode="decimal" step="0.01" bind:value={baseForm.adaptCoef} /></label>
    <p class="pf-hint">Dépense hors sport à ce poids de référence. Elle varie ensuite de −12 kcal par kg perdu.<br/><b>Adaptation</b> : 0 si la base vient de tes mesures (elle contient déjà le ralentissement métabolique) ; 0,12 si c'est une estimation par formule.</p>
    {#if recalib && recalib.ok}
      {@const pctMes = Math.round(recalib.weightMeasured * 100)}
      <div class="recalib-banner">
        📏 D'après tes données : <b>{recalib.base} kcal</b> ± {recalib.sigma} · confiance {recalib.confidence}
        <div class="recalib-sub">{recalib.days} j loggés · {recalib.weighIns} pesées · {pctMes} % tes mesures, {100 - pctMes} % {prior.source === 'formule' ? 'formule de départ' : 'réglage actuel'}{recalib.carbShift ? ' · glucides variables : prudence' : ''}</div>
        <button class="recalib-btn" onclick={applyEstimate}>Appliquer</button>
      </div>
    {:else if recalib && !recalib.ok}
      <p class="pf-hint">📏 Affinage par tes mesures dès 7 jours loggés et 4 pesées, hors 1re semaine de régime (où la perte est surtout de l'eau) — {recalib.reason}.</p>
    {/if}
    {#if histBase && histBase.ok}
      <div class="hist-base">
        📚 <b>Base historique</b> : <b>{histBase.measured} kcal</b> ± {histBase.measuredSigma} à {String(histBase.poidsRef).replace('.', ',')} kg (poids moyen de la période){#if histBase.atNow}&nbsp;· ≈ <b>{histBase.atNow} kcal</b> à ton poids actuel ({String(histBase.nowW).replace('.', ',')} kg, moyenne des 7 derniers jours){/if}
        <div class="recalib-sub">Tout l'historique : du {histBase.from} au {histBase.to} · {histBase.days} j loggés · {histBase.weighIns} pesées · perte {String(histBase.lossPerWeek).replace('.', ',')} kg/sem. À titre d'information : c'est ta dépense moyenne sur toute la période, qui mélange des phases différentes (poids, activité). La base utilisée reste celle ci-dessus.</div>
      </div>
    {/if}
    <button class="card save-btn" onclick={saveBaseForm}>Enregistrer la base (dès aujourd'hui)</button>
    <button class="card save-btn alt-btn" onclick={saveBaseAll}>Appliquer aussi au passé (depuis le J1)</button>
    <p class="pf-hint">« Dès aujourd'hui » fige le passé : à utiliser quand l'ancienne base était juste à l'époque. « Aussi au passé » recalcule tout l'historique : à utiliser quand l'ancienne base était une estimation de départ, jamais mesurée.</p>
    {#if baseStatus}<div class="import-status" class:success={baseStatus.startsWith('✓')}>{baseStatus}</div>{/if}
  </div>

  <div class="section-title">Suivi nutritionnel</div>
  <div class="section">
    <button class="card setting-row" onclick={toggleFiber}>
      <span class="body">Suivre les fibres</span>
      <div class="pill">{trackFiber ? 'Activé' : 'Désactivé'}</div>
    </button>
    <p class="pf-hint">Ajoute les fibres comme 4ᵉ macro : cible ≈ 14 g pour 1000 kcal (25 g minimum). Elles sont reprises de la recherche, du scan, de l'IA et de ta liste d'aliments ; les repas notés avant n'en ont pas toujours.</p>
    {#if fiberStatus}<div class="import-status">{fiberStatus}</div>{/if}
  </div>

  <div class="section-title">Apparence</div>
  <div class="section">
    <button class="card setting-row" onclick={toggleTheme}>
      <span class="body">Thème</span>
      <div class="pill">{$theme === "dark" ? "Sombre" : "Clair"}</div>
    </button>
  </div>

  <div class="section-title">Données</div>
  <div class="section">
    <button class="card setting-row" onclick={exportAliments}>
      <span class="body">Export aliments (CSV)</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="card setting-row" onclick={exportJournal}>
      <span class="body">Exporter le journal (CSV pour IA)</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="card setting-row" onclick={exportData}>
      <span class="body">Exporter tout (JSON)</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="card setting-row" onclick={triggerImport}>
      <span class="body">Importer un export (JSON)</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="transform:scaleY(-1)" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <input bind:this={fileInput} type="file" accept=".json" onchange={onFileChange} style="display:none" />
    {#if importStatus}
      <div class="import-status" class:success={importStatus.startsWith('✓')}>{importStatus}</div>
    {/if}
  </div>

  <div class="section-title">Compte</div>
  <div class="section">
    <div class="card setting-row info-row">
      <span class="body">Connecté</span>
      <span class="caption">{$session?.user?.email ?? ''}</span>
    </div>
    <button class="card setting-row danger-btn" onclick={signout}>
      <span class="body">Se déconnecter</span>
    </button>
  </div>

  <div class="version caption">FitProX · V14.4</div>
</div>

{#if showSetup}
  <BaseSetup onclose={() => { showSetup = false; syncForm(); }} />
{/if}

<style>
.sheader { padding:20px 0 14px; }
.stitle { font-size:20px; font-weight:500; color:var(--c-text); margin-top:3px; }
.section-title { font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:0.06em; color:var(--c-text3); margin:20px 0 8px; }
.section { display:flex; flex-direction:column; gap:8px; }
.setting-row { display:flex; align-items:center; justify-content:space-between; cursor:pointer; width:100%; text-align:left; font-family:var(--font); color:var(--c-text); }
.setting-row svg { color:var(--c-text3); flex-shrink:0; }
.pill { background:var(--c-surface2); border:0.5px solid var(--c-border2); border-radius:20px; padding:4px 12px; font-size:12px; font-weight:500; color:var(--c-text2); }
.import-status { font-size:13px; color:var(--c-text2); padding:8px 4px; }
.import-status.success { color:var(--c-green); }
.info-row { cursor:default; }
.danger-btn { color:var(--c-red); }
.version { text-align:center; margin-top:32px; color:var(--c-text3); }

.profile-form { display:flex; flex-direction:column; gap:6px; }
.pf-row { display:flex; align-items:center; justify-content:space-between; gap:12px; background:var(--c-surface); border:0.5px solid var(--c-border); border-radius:var(--r-md); padding:10px 14px; }
.pf-row span { font-size:14px; color:var(--c-text); }
.pf-hint { font-size:11px; color:var(--c-text3); margin:2px 2px 0; line-height:1.4; }
.recalib-banner { font-size:12.5px; color:var(--c-text); background:var(--c-surface2); border:1px solid var(--c-border); border-radius:var(--r-md); padding:9px 11px; line-height:1.5; }
.recalib-sub { font-size:11px; color:var(--c-text3); margin-top:2px; }
.hist-base { font-size:12.5px; color:var(--c-text2); background:transparent; border:1px dashed var(--c-border); border-radius:var(--r-md); padding:9px 11px; line-height:1.5; }
.recalib-btn { margin-top:6px; border:none; background:var(--c-accent); color:var(--c-accent-fg); font-size:12px; font-weight:600; padding:5px 12px; border-radius:7px; cursor:pointer; font-family:var(--font); }
.pf-row input { width:110px; padding:6px 8px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:14px; text-align:right; font-family:var(--font); }
.pf-row input:focus { outline:none; border-color:var(--c-accent); }
.save-btn { text-align:center; justify-content:center; padding:12px; background:var(--c-accent); color:var(--c-accent-fg); border:none; font-size:14px; font-weight:600; cursor:pointer; font-family:var(--font); border-radius:var(--r-md); }
.alt-btn { background:transparent; color:var(--c-accent); border:1px solid var(--c-accent); margin-top:6px; }
</style>
