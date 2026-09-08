<script lang="ts">
  import { theme, t, session, appData, persistSession } from "./store";
  import { saveAppState } from "./supabase";
  import { buildTimeline, recalibrate, settingsFor, dsToMs, nf, ADAPT_DEFAULT } from "./engine";

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
    const rows = ['date,kcal_mangees,proteines_g,glucides_g,lipides_g,sport_kcal_actives,poids_kg,masse_grasse_pct'];
    const j1 = new Date(2026, 5, 22); // J1 du régime (22 juin 2026)
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

  // Liste des aliments enregistrés + macros, en CSV.
  function exportAliments() {
    const data = $appData as any;
    if (!data) return;
    const favs = [...(Array.isArray(data.favorites) ? data.favorites : [])]
      .sort((a: any, b: any) => (a.name ?? '').localeCompare(b.name ?? '', 'fr'));
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

  // ── Profil editable ──

  // ── v11 : base mesurée datée + recalibrage ──
  const _now = new Date(); _now.setHours(0,0,0,0);
  const todayMs = _now.getTime();
  const todayDs = _now.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  function effectiveLog(data: any) {
    const log = data?.programme?.settingsLog;
    if (Array.isArray(log) && log.length) return log;
    let from = todayDs, minT = Infinity;
    for (const k of Object.keys(data?.days ?? {})) { const t = dsToMs(k); if (!isNaN(t) && t < minT) { minT = t; from = k; } }
    return [{ from, baseRef: 2020, poidsRef: 97.92, adaptCoef: ADAPT_DEFAULT }];
  }
  let baseForm = $state({ baseRef: '', poidsRef: '', adaptCoef: '' });
  let baseLoaded = false;
  let baseStatus = $state('');
  $effect(() => {
    const data = $appData as any;
    if (data && !baseLoaded) {
      const cur: any = settingsFor(effectiveLog(data), todayMs);
      baseForm = { baseRef: String(cur.baseRef), poidsRef: String(cur.poidsRef), adaptCoef: String(cur.adaptCoef ?? ADAPT_DEFAULT) };
      baseLoaded = true;
    }
  });
  const recalib = $derived.by(() => {
    const data = $appData as any; if (!data) return null;
    const days = data.days ?? {};
    const dateList = Object.keys(days).map((ds: string) => ({ ds, t: dsToMs(ds) })).filter((x: any) => !isNaN(x.t)).sort((a: any, b: any) => a.t - b.t);
    const info = (ds: string) => {
      const dd: any = days[ds] ?? {}; const fds = dd.foods ?? [];
      return { weight: nf(dd.weight), bf: nf(dd.bf), eaten: fds.reduce((s: number,f: any)=>s+(f.k||0),0), gluc: fds.reduce((s: number,f: any)=>s+(f.g||0),0), prot: fds.reduce((s: number,f: any)=>s+(f.p||0),0), extraKcal: dd.extraKcal ?? 0, sportKcal: 0, libre: !!dd.libre, logged: fds.length > 0 };
    };
    const tl = buildTimeline({ dateList, settingsLog: effectiveLog(data), todayTime: todayMs, dayFrac: 1, info });
    return recalibrate(tl);
  });
  async function saveBase(baseRef: any, poidsRef: any, adaptCoef: any) {
    const s = $session; const data = $appData as any;
    if (!s || !data) return;
    baseStatus = 'Sauvegarde…';
    const prog = data.programme ?? {};
    let log = Array.isArray(prog.settingsLog) ? [...prog.settingsLog] : [];
    if (!log.length) log = effectiveLog(data).slice(); // fige le passé avec la base initiale
    log = log.filter((e: any) => e.from !== todayDs);
    log.push({ from: todayDs, baseRef: Math.round(nf(baseRef)), poidsRef: +nf(poidsRef).toFixed(2), adaptCoef: Math.max(0, Math.min(0.15, nf(adaptCoef) || ADAPT_DEFAULT)) });
    log.sort((a: any, b: any) => dsToMs(a.from) - dsToMs(b.from));
    const newData = { ...data, programme: { ...prog, settingsLog: log } };
    appData.set(newData);
    try { await saveAppState(s.access_token, s.user.id, newData); baseStatus = '\u2713 Base enregistr\u00e9e (d\u00e8s aujourd\u2019hui)'; }
    catch { baseStatus = 'Erreur de sauvegarde'; }
    setTimeout(() => baseStatus = '', 2600);
  }
  function saveBaseForm() { saveBase(baseForm.baseRef, baseForm.poidsRef, baseForm.adaptCoef); }
  function applyRecalib() { if (recalib && (recalib as any).ok) { const r: any = recalib; baseForm = { ...baseForm, baseRef: String(r.baseRef), poidsRef: String(r.poidsRef) }; saveBase(r.baseRef, r.poidsRef, baseForm.adaptCoef); } }

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

  <div class="section-title">Dépense mesurée (base)</div>
  <div class="section profile-form">
    <label class="pf-row"><span>Base mesurée (kcal/j)</span><input type="number" inputmode="numeric" step="10" bind:value={baseForm.baseRef} /></label>
    <label class="pf-row"><span>Poids de réf. (kg)</span><input type="number" inputmode="decimal" step="0.1" bind:value={baseForm.poidsRef} /></label>
    <label class="pf-row"><span>Adaptation (0–0,15)</span><input type="number" inputmode="decimal" step="0.01" bind:value={baseForm.adaptCoef} /></label>
    <p class="pf-hint">Dépense hors sport à ce poids de référence (mesurée par bilan énergétique). Elle varie ensuite de −12 kcal par kg perdu. Enregistrer applique la valeur À PARTIR D'AUJOURD'HUI — le passé n'est jamais recalculé.</p>
    {#if recalib && recalib.ok}
      <div class="recalib-banner">📏 Base mesurée sur {recalib.days} j : <b>{recalib.baseRef}</b> kcal · poids réf {String(recalib.poidsRef).replace('.', ',')} kg · perte {String(recalib.perteMM7).replace('.', ',')} kg
        <button class="recalib-btn" onclick={applyRecalib}>Appliquer</button></div>
    {:else if recalib && !recalib.ok}
      <p class="pf-hint">Recalibrage indispo : {recalib.reason}.</p>
    {/if}
    <button class="card save-btn" onclick={saveBaseForm}>Enregistrer la base (dès aujourd'hui)</button>
    {#if baseStatus}<div class="import-status" class:success={baseStatus.startsWith('✓')}>{baseStatus}</div>{/if}
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

  <div class="version caption">FitProX · V13.6</div>
</div>

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
.recalib-btn { margin-left:6px; border:none; background:var(--c-accent); color:var(--c-accent-fg); font-size:12px; font-weight:600; padding:4px 10px; border-radius:7px; cursor:pointer; font-family:var(--font); }
.pf-row input, .pf-row select { width:110px; padding:6px 8px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:14px; text-align:right; font-family:var(--font); }
.pf-row input:focus, .pf-row select:focus { outline:none; border-color:var(--c-accent); }
.save-btn { text-align:center; justify-content:center; padding:12px; background:var(--c-accent); color:var(--c-accent-fg); border:none; font-size:14px; font-weight:600; cursor:pointer; font-family:var(--font); border-radius:var(--r-md); }
</style>
