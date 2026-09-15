<script lang="ts">
  import { get } from 'svelte/store';
  import { appData, session } from './store';
  import { saveAppState } from './supabase';
  import { settingsFor, nf } from './engine';
  import { ACTIVITY_LEVELS, startingBase, userJ1, isEstimateSource } from './account';

  let { onclose, firstRun = false }: { onclose: () => void; firstRun?: boolean } = $props();

  const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
  const todayKey = todayDate.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // Pré-remplissage : dernière pesée connue, sinon profil
  const data0: any = get(appData) ?? {};
  const pf: any = data0.profile ?? {};
  let lastW = 0, lastBf = 0, lastT = -1;
  for (const k of Object.keys(data0.days ?? {})) {
    const p = k.split('/').map(Number);
    if (p.length !== 3) continue;
    const t = new Date(p[2], p[1] - 1, p[0]).getTime();
    const w = nf(data0.days[k]?.weight);
    if (w > 0 && t > lastT) { lastT = t; lastW = w; lastBf = nf(data0.days[k]?.bf); }
  }
  const hasWeighToday = nf(data0.days?.[todayKey]?.weight) > 0;

  let sex = $state<'h' | 'f'>(pf.sex === 'f' ? 'f' : 'h');
  let age = $state(nf(pf.age) > 0 ? String(pf.age) : '');
  let height = $state(nf(pf.height) > 0 ? String(pf.height) : '');
  let weight = $state(lastW > 0 ? String(lastW) : (nf(pf.weight) > 0 ? String(pf.weight) : ''));
  let bf = $state(lastBf > 0 ? String(lastBf) : (nf(pf.bf) > 0 ? String(pf.bf) : ''));
  let act = $state(ACTIVITY_LEVELS.some((a) => a.key === String(pf.act)) ? String(pf.act) : ACTIVITY_LEVELS[0].key);
  let saveWeighIn = $state(true);
  let saving = $state(false);

  const result = $derived(startingBase({ sex, age, height, weight, bf, act }));
  const missing = $derived(
    !(nf(weight) > 0) ? 'ton poids'
      : (!(nf(bf) > 0) && (!(nf(age) > 0) || !(nf(height) > 0))) ? 'ton âge et ta taille (ou ta masse grasse)' : ''
  );
  const actLabel = $derived(ACTIVITY_LEVELS.find((a) => a.key === act)?.label ?? '');
  const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');

  async function persist(newData: any) {
    const s = get(session);
    if (!s) return;
    appData.set(newData);
    await saveAppState(s.access_token, s.user.id, newData);
  }

  async function apply() {
    const s = get(session);
    const data: any = get(appData);
    if (!s || !data || !result) return;
    const log = data.programme?.settingsLog;
    if (Array.isArray(log) && log.length) {
      const cur: any = settingsFor(log, todayDate.getTime());
      const msg = isEstimateSource(cur.source)
        ? `Remplacer ta base actuelle (${fmt(cur.baseRef)} kcal) par cette estimation (${fmt(result.base)} kcal) ?`
        : `Ta base actuelle (${fmt(cur.baseRef)} kcal) a été MESURÉE sur tes données.\n\nLa remplacer par une estimation par formule (${fmt(result.base)} kcal) recalculera tout ton historique avec une valeur moins précise. Continuer ?`;
      if (!confirm(msg)) return;
    }
    saving = true;
    const w = nf(weight), b = nf(bf);
    const j1 = userJ1(s.user.id, data);
    const profile = { ...(data.profile ?? {}), sex, age: nf(age) || '', height: nf(height) || '', weight: w, bf: b || '', act };
    let days = data.days ?? {};
    if (saveWeighIn && !hasWeighToday) {
      const d = days[todayKey] ?? {};
      days = { ...days, [todayKey]: { ...d, weight: w, ...(b > 0 ? { bf: b } : {}) } };
    }
    // Estimation de départ : appliquée à tout l'historique (ce n'est pas une mesure)
    const entry = { from: j1, baseRef: result.base, poidsRef: +w.toFixed(2), adaptCoef: 0.12, source: 'formule', sigma: result.sigma };
    await persist({
      ...data, profile, days, startDs: data.startDs ?? j1, baseSetupDone: true,
      programme: { ...(data.programme ?? {}), settingsLog: [entry] },
    });
    saving = false;
    onclose();
  }

  async function later() {
    const data: any = get(appData);
    if (data) await persist({ ...data, baseSetupSkipped: true });
    onclose();
  }
</script>

<div class="overlay" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title">{firstRun ? 'Bienvenue sur FitProX 👋' : 'Calcul calories de départ'}</span>
      <button class="close-btn" onclick={firstRun ? later : onclose} aria-label="Fermer">✕</button>
    </div>
    <div class="modal-body">
      <p class="hint">
        {firstRun ? "Pour calculer tes déficits dès aujourd'hui, il faut une première estimation de ta dépense." : 'Estime ta dépense de départ à partir de ton profil.'}
        Elle sera ensuite affinée automatiquement par tes vraies pesées.
      </p>

      <div class="field">
        <span class="flabel">Sexe</span>
        <div class="seg">
          <button type="button" class:on={sex === 'h'} onclick={() => (sex = 'h')}>Homme</button>
          <button type="button" class:on={sex === 'f'} onclick={() => (sex = 'f')}>Femme</button>
        </div>
      </div>

      <div class="grid2">
        <label class="field"><span class="flabel">Âge</span><input type="number" inputmode="numeric" min="10" max="100" placeholder="ans" bind:value={age} /></label>
        <label class="field"><span class="flabel">Taille</span><input type="number" inputmode="numeric" min="100" max="230" placeholder="cm" bind:value={height} /></label>
        <label class="field"><span class="flabel">Poids</span><input type="number" inputmode="decimal" min="30" max="300" step="0.1" placeholder="kg" bind:value={weight} /></label>
        <label class="field"><span class="flabel">Masse grasse <em>(optionnel)</em></span><input type="number" inputmode="decimal" min="3" max="60" step="0.1" placeholder="%" bind:value={bf} /></label>
      </div>

      <div class="field">
        <span class="flabel">Activité au quotidien <em>(hors sport)</em></span>
        {#each ACTIVITY_LEVELS as a (a.key)}
          <button type="button" class="act" class:on={act === a.key} onclick={() => (act = a.key)}>
            <span class="act-l">{a.label} <span class="muted">×{a.key.replace('.', ',')}</span></span>
            <span class="act-h">{a.hint}</span>
          </button>
        {/each}
        <p class="note">Le sport n'est pas compté ici : tu le saisis chaque jour dans « ⌚ Sport cal ».</p>
      </div>

      {#if result}
        <div class="result">
          <div class="res-l">Ta dépense hors sport estimée</div>
          <div class="res-v">{fmt(result.base)} <span>kcal/j</span></div>
          <div class="res-s">± {fmt(result.sigma)} kcal · métabolisme {fmt(result.bmr)} kcal ({result.method}) × {String(result.factor).replace('.', ',')} {actLabel.toLowerCase()}</div>
          <div class="res-n">C'est un point de départ. Dès <b>7 jours</b> de repas loggés et <b>4 pesées</b>, FitProX le corrige avec tes vraies mesures, et la marge d'erreur se resserre ensuite de semaine en semaine.</div>
        </div>
        {#if !hasWeighToday}
          <label class="chk"><input type="checkbox" bind:checked={saveWeighIn} /> Enregistrer ce poids comme pesée d'aujourd'hui</label>
        {/if}
        <button type="button" class="btn-accent full" onclick={apply} disabled={saving}>{saving ? 'Enregistrement…' : 'Utiliser cette estimation'}</button>
      {:else}
        <div class="missing">Renseigne {missing} pour obtenir l'estimation.</div>
      {/if}

      {#if firstRun}
        <button type="button" class="later" onclick={later}>Plus tard (Profil → Calcul calories de départ)</button>
      {/if}
    </div>
  </div>
</div>

<style>
.overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:300; display:flex; align-items:flex-end; }
.modal { width:100%; max-height:90dvh; background:var(--c-bg); border-radius:20px 20px 0 0; display:flex; flex-direction:column; overflow:hidden; }
.modal-header { display:flex; align-items:center; justify-content:space-between; padding:16px 18px 10px; flex-shrink:0; border-bottom:0.5px solid var(--c-border); }
.modal-title { font-size:16px; font-weight:600; color:var(--c-text); }
.close-btn { border:none; background:none; color:var(--c-text3); font-size:18px; cursor:pointer; padding:4px; }
.modal-body { overflow-y:auto; padding:14px 16px 28px; display:flex; flex-direction:column; gap:12px; }
.hint { font-size:13px; color:var(--c-text2); margin:0; line-height:1.45; }
.field { display:flex; flex-direction:column; gap:6px; }
.flabel { font-size:11px; font-weight:500; color:var(--c-text3); text-transform:uppercase; letter-spacing:.05em; }
.flabel em { text-transform:none; letter-spacing:0; font-style:normal; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.field input { padding:9px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text); font-size:15px; font-family:var(--font); }
.field input:focus { outline:none; border-color:var(--c-accent); }
.seg { display:flex; gap:6px; }
.seg button { flex:1; padding:9px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); color:var(--c-text2); font-size:14px; cursor:pointer; font-family:var(--font); }
.seg button.on, .act.on { border-color:var(--c-accent); color:var(--c-text); background:var(--c-surface2); }
.act { display:flex; flex-direction:column; align-items:flex-start; gap:1px; padding:9px 12px; border:1px solid var(--c-border); border-radius:var(--r-md); background:var(--c-surface); cursor:pointer; text-align:left; font-family:var(--font); }
.act-l { font-size:14px; color:var(--c-text); font-weight:500; }
.act-h { font-size:12px; color:var(--c-text3); }
.muted { color:var(--c-text3); font-weight:400; }
.note { font-size:11px; color:var(--c-text3); margin:0; }
.result { padding:14px; border:1px solid var(--c-accent); border-radius:var(--r-md); background:var(--c-surface); display:flex; flex-direction:column; gap:4px; }
.res-l { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--c-text3); }
.res-v { font-size:28px; font-weight:700; color:var(--c-text); letter-spacing:-.5px; }
.res-v span { font-size:14px; font-weight:400; color:var(--c-text2); }
.res-s { font-size:12px; color:var(--c-text2); }
.res-n { font-size:12px; color:var(--c-text2); margin-top:4px; line-height:1.45; }
.missing { font-size:13px; color:var(--c-text2); padding:12px; border:1px dashed var(--c-border); border-radius:var(--r-md); text-align:center; }
.chk { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--c-text2); }
.btn-accent { padding:12px; border:none; border-radius:var(--r-md); background:var(--c-accent); color:var(--c-accent-fg); font-size:15px; font-weight:600; cursor:pointer; font-family:var(--font); }
.btn-accent:disabled { opacity:.6; cursor:not-allowed; }
.full { width:100%; }
.later { border:none; background:none; color:var(--c-text3); font-size:12px; text-decoration:underline; cursor:pointer; font-family:var(--font); padding:4px; }
</style>
