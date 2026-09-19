<script lang="ts">
  import { t, appData, session } from "./store";
  import { nf } from './calc';
  import { buildTimeline, sundayRule, APPORT_FLOOR, estimateBase, settingsFor } from './engine';
  import { isOwner, userJ1, userEnd, effectiveSettingsLog, basePrior } from './account';
  import { saveAppState, refreshToken } from "./supabase";
  import { get } from "svelte/store";
  import FoodModal from "./FoodModal.svelte";

  const MOIS: Record<string, number> = {
    janvier:0, février:1, fevrier:1, mars:2, avril:3, mai:4, juin:5,
    juillet:6, août:7, aout:7, septembre:8, octobre:9, novembre:10, décembre:11, decembre:11
  };

  function parseJour(str: string): Date | null {
    if (!str) return null;
    if (str.includes('/')) {
      const [d, m, y] = str.split('/');
      return new Date(+y, +m - 1, +d);
    }
    const parts = str.trim().toLowerCase().split(/\s+/);
    const dayNum = parts.find(p => /^\d+$/.test(p));
    const monthStr = parts.find(p => MOIS[p] !== undefined);
    if (!dayNum || !monthStr) return null;
    return new Date(2026, MOIS[monthStr], +dayNum);
  }

  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const todayKey = todayDate.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  const nowD = new Date();
  const dayFrac = Math.min(1, (nowD.getHours() * 60 + nowD.getMinutes()) / (24 * 60));
  const heureLabel = nowD.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  // Bornes du suivi : propriétaire = J1 22/06 → objectif du 1er novembre (Toulouse) ;
  // autres utilisateurs = leur premier jour → aujourd'hui + 90 jours.
  const uid = $derived($session?.user?.id ?? '');
  const owner = $derived(isOwner(uid));
  const J1_DS = $derived(userJ1(uid, $appData));
  const trackFiber = $derived(!!($appData as any)?.profile?.trackFiber);
  const END_DS = $derived(userEnd(uid));
  const avgMacros = $derived.by(() => {
    const j1 = parseJour(J1_DS);
    if (j1) j1.setHours(0, 0, 0, 0);
    let sp = 0, sg = 0, sl = 0, n = 0, sfi = 0, nfi = 0;
    Object.entries((days as any) ?? {}).forEach(([k, d]: [string, any]) => {
      const fds = d?.foods ?? [];
      if (!fds.length) return;
      const parts = k.split('/').map(Number);
      if (parts.length !== 3) return;
      const t = new Date(parts[2], parts[1]-1, parts[0]);
      if (j1 && t < j1) return; // avant le 1er jour de regime
      if (t > todayDate) return;
      sp += fds.reduce((s: number, f: any) => s + (f.p||0), 0);
      sg += fds.reduce((s: number, f: any) => s + (f.g||0), 0);
      sl += fds.reduce((s: number, f: any) => s + (f.l||0), 0);
      // fibres : moyenne sur les seuls jours où elles sont renseignées (les anciens repas n'en ont pas)
      if (fds.some((f: any) => f.fi != null)) { sfi += fds.reduce((s: number, f: any) => s + (f.fi||0), 0); nfi++; }
      n++;
    });
    if (!n) return null;
    return { p: Math.round(sp / n), g: Math.round(sg / n), l: Math.round(sl / n), fi: nfi ? Math.round(sfi / nfi) : null, n };
  });
  const days = $derived(($appData as any)?.days ?? {});
  const today = $derived(days[todayKey] ?? {});
  const foods = $derived(today?.foods ?? []);

  // ── v11 : moteur de dépense mesurée (base datée + dynamique + adaptation) ──
  // sans réglage enregistré : propriétaire = base historique ; autres = formule du profil
  const settingsLog = $derived(effectiveSettingsLog(uid, $appData));
  const timeline = $derived.by(() => {
    // un jour = une entrée, du J1 à l'objectif ; le sport vient du champ « Sport cal » (extraKcal)
    const start = parseJour(J1_DS)!; start.setHours(0,0,0,0);
    const end = parseJour(END_DS)!; end.setHours(0,0,0,0);
    const dateList: any[] = [];
    for (const c = new Date(start); c.getTime() <= end.getTime(); c.setDate(c.getDate() + 1)) {
      const d0 = new Date(c); d0.setHours(0,0,0,0);
      dateList.push({ ds: d0.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }), t: d0.getTime() });
    }
    const info = (ds: string) => {
      const dd = (days as any)[ds] ?? {};
      const fds = dd.foods ?? [];
      return {
        weight: nf(dd.weight), bf: nf(dd.bf),
        eaten: fds.reduce((s: number,f: any)=>s+(f.k||0),0),
        gluc: fds.reduce((s: number,f: any)=>s+(f.g||0),0),
        prot: fds.reduce((s: number,f: any)=>s+(f.p||0),0),
        extraKcal: dd.extraKcal ?? 0, sportKcal: 0, libre: !!dd.libre, logged: fds.length>0,
      };
    };
    return buildTimeline({ dateList, settingsLog, todayTime: todayDate.getTime(), dayFrac, info });
  });
  const todayRec = $derived((timeline.byKey as any)[todayKey] ?? null);
  const sundaySug = $derived(sundayRule(timeline, todayDate.getTime()));

  const macros = $derived(foods.reduce(
    (acc: any, f: any) => ({ k: acc.k+(f.k||0), p: acc.p+(f.p||0), g: acc.g+(f.g||0), l: acc.l+(f.l||0), fi: acc.fi+(f.fi||0) }),
    { k:0, p:0, g:0, l:0, fi:0 }
  ));

  const tIntake = $derived(todayRec
    ? (todayRec.libre ? Math.round(todayRec.base + todayRec.sportK)
       : Math.round(Math.max(APPORT_FLOOR, (todayRec.base + todayRec.sportK) * 0.75)))
    : 1850);
  const curBody = $derived.by(() => {
    const dd = (days as any) ?? {};
    let last: any = null;
    for (const k of Object.keys(dd)) {
      const dy = dd[k]; const w = nf(dy?.weight); if (!(w > 0)) continue;
      const pr = k.split('/').map(Number); if (pr.length !== 3) continue;
      const t = new Date(pr[2], pr[1]-1, pr[0]).getTime();
      if (!last || t > last.t) last = { t, w, bf: nf(dy?.bf) };
    }
    const pf: any = ($appData as any)?.profile ?? {};
    return { w: last ? last.w : (nf(pf.weight) || 100), bf: last && last.bf > 0 ? last.bf : nf(pf.bf) };
  });
  const mCible = $derived.by(() => {
    const w = curBody.w || 100;
    const bf = curBody.bf || 0;
    const lean = bf > 0 ? w * (1 - bf / 100) : w * 0.75; // masse maigre
    const kcal = tIntake > 0 ? tIntake : 1850; // repli si pas de cible du jour
    const p = Math.round(2.2 * lean); // 2,2 g/kg de masse maigre (anti-fonte, contexte cortisone)
    const l = Math.round(0.6 * w);
    const g = Math.max(0, Math.round((kcal - p * 4 - l * 9) / 4));
    const fi = Math.max(25, Math.round(14 * kcal / 1000)); // 14 g / 1000 kcal, 25 g minimum
    return { p, g, l, fi };
  });

  // ── Cumul reel des deficits (alimente le cumul et la %MG projetee) ──
  const nfp = nf;
  const progStats = $derived.by(() => {
    const w = curBody.w || 100;
    const pTargetDay = 1.6 * w;
    let totalCible = 0, realBrule = 0, expectedSoFar = 0;
    let fatKcal = 0, leanKcalDef = 0, defKcalPos = 0, protEaten = 0, protTarget = 0, protShortfall = 0;
    for (const r of (timeline as any).list) {
      const dayExp = r.base + r.sportK; // dépense pleine du jour
      const cible = r.libre ? 0 : Math.max(0, Math.round(Math.min(dayExp * 0.25, dayExp - APPORT_FLOOR)));
      totalCible += cible;
      if (r.deficit == null) continue;
      realBrule += r.deficit;
      expectedSoFar += r.isToday ? cible * dayFrac : cible;
      const def = r.deficit;
      if (def > 0) {
        const ratio = pTargetDay > 0 ? Math.max(0, Math.min(1, r.prot / pTargetDay)) : 1;
        const fatFrac = 0.70 + 0.20 * ratio;
        fatKcal += def * fatFrac; leanKcalDef += def * (1 - fatFrac); defKcalPos += def;
        protEaten += r.prot; protTarget += pTargetDay; protShortfall += Math.max(0, pTargetDay - r.prot);
      } else {
        fatKcal += def * 0.85;
      }
    }
    fatKcal = Math.max(0, fatKcal);
    const fatShare = (fatKcal + leanKcalDef) > 0 ? fatKcal / (fatKcal + leanKcalDef) : 0.9;
    const protPct = protTarget > 0 ? protEaten / protTarget : 1;
    return { totalCible, realBrule, expectedSoFar, fatKcal, leanKcalDef, fatShare, protPct, defKcalPos, protShortfall };
  });
  const fatLost = $derived.by(() => {
    // ancré sur les pesées MESURÉES (poids + %MG saisis) : vérité, pas modèle
    const meas: any[] = [];
    for (const k of Object.keys(days as any)) {
      const d: any = (days as any)[k]; const w = nfp(d?.weight), bf = nfp(d?.bf);
      if (w > 0 && bf > 0) { const pr = k.split('/').map(Number); if (pr.length === 3) meas.push({ t: new Date(pr[2], pr[1]-1, pr[0]).getTime(), w, bf, fat: w * bf / 100 }); }
    }
    meas.sort((a, b) => a.t - b.t);
    if (meas.length < 1) return null;
    const start = meas[0], now = meas[meas.length - 1];
    const fatLostKg = start.fat - now.fat;          // signé
    const weightLostKg = start.w - now.w;           // signé
    const leanChangeKg = weightLostKg - fatLostKg;  // < 0 = muscle GAGNÉ (recomposition)
    return {
      fatLostKg, weightLostKg, leanChangeKg,
      bf: +start.bf.toFixed(1), bfNow: +now.bf.toFixed(1),
      startW: start.w, nowW: now.w, startFat: start.fat, nowFat: now.fat,
    };
  });
  /* Part d'énergie qui vient réellement du gras, CALIBRÉE sur tes pesées + %MG
     (et non sur une formule théorique liée aux protéines, qui ignorait le sport
     et surestimait la perte de muscle). Bornée : une mesure d'impédancemétrie
     bruitée ne doit pas produire une part aberrante. */
  const FAT_FRAC_DEFAULT = 0.85;
  const fatFracMeasured = $derived.by(() => {
    if (!fatLost) return FAT_FRAC_DEFAULT;
    const fatE = fatLost.fatLostKg * 7700;      // énergie venue du gras
    const leanE = fatLost.leanChangeKg * 1850;  // < 0 si masse maigre gagnée
    const totE = fatE + leanE;
    if (!(fatE > 0) || !(totE > 0)) return FAT_FRAC_DEFAULT;
    return Math.max(0.70, Math.min(1, fatE / totE));
  });
  // %MG projetée au 1er novembre — même méthode MESURÉE que la cellule de projection
  const bfProjected = $derived.by(() => {
    if (!fatLost || !(progStats.expectedSoFar > 0 && progStats.totalCible > 0)) return null;
    const futFrac = Math.max(0, (progStats.totalCible - progStats.expectedSoFar) / progStats.expectedSoFar);
    const futFatKg = Math.max(0, fatLost.fatLostKg) * futFrac;
    const endW = fatLost.nowW - futFatKg;
    const endFat = fatLost.nowFat - futFatKg;
    return endW > 0 ? +Math.max(0, endFat / endW * 100).toFixed(1) : null;
  });

  // Cumul reel = identique a la barre (deficit live, J1, jour en cours au prorata)
  const cumulReal = $derived(-Math.round(progStats.realBrule));

  const recentDays = $derived(() => {
    const result: any[] = [];
    // plancher : premier jour effectivement loggé (on ne remonte pas avant)
    let floorTime = Infinity;
    for (const k of Object.keys(days)) {
      if (!(days as any)[k]?.foods?.length) continue;
      const parts = k.split('/').map(Number);
      if (parts.length === 3) {
        const t = new Date(parts[2], parts[1]-1, parts[0]).getTime();
        if (t < floorTime) floorTime = t;
      }
    }
    // plancher J1 : on ne montre rien avant le premier jour du régime
    const j1 = parseJour(J1_DS)!; j1.setHours(0,0,0,0);
    const j1Time = j1.getTime();
    for (let i = 1; i <= 366; i++) {
      const d = new Date(todayDate);
      d.setDate(d.getDate() - i);
      if (d.getTime() < j1Time) break; // avant le J1 du régime
      const key = d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
      const dayData = (days as any)[key];
      const hasFood = !!dayData?.foods?.length;
      const within7 = i <= 7 && d.getTime() >= floorTime;
      // on garde les 7 derniers jours (>= 1er jour loggé) meme vides, + tout jour loggé au-dela
      if (!hasFood && !within7) continue;
      const foods = dayData?.foods ?? [];
      const total = (foods as any[]).reduce((s: number, f: any) => s + (f.k||0), 0);
      const label = d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'short' });
      const jNum = d.getTime() >= j1Time ? Math.round((d.getTime() - j1Time) / 86400000) + 1 : null;
      const extraKcal = dayData?.extraKcal ?? 0;
      const sp = (foods as any[]).reduce((s: number, f: any) => s + (f.p||0), 0);
      const sg = (foods as any[]).reduce((s: number, f: any) => s + (f.g||0), 0);
      const sl = (foods as any[]).reduce((s: number, f: any) => s + (f.l||0), 0);
      const sfi = (foods as any[]).some((f: any) => f.fi != null) ? (foods as any[]).reduce((s: number, f: any) => s + (f.fi||0), 0) : null;
      // deficit reel du jour = depense - mange
      const rec = (timeline.byKey as any)[key];
      const expend = rec ? rec.exp : 0;
      const adaptation = rec ? rec.adaptation : 0;
      const deficit = hasFood ? (rec ? rec.deficit : null) : null; // null si rien loggé
      const neutre = deficit !== null && Math.abs(deficit) <= 50; // neutre = mange ~ depense
      /* Grammes de gras du jour, via la part mesurée sur TES pesées + %MG.
         Pas de découpage muscle/eau : sur une seule journée il n'est pas mesurable,
         et l'ancienne formule pénalisait les jours d'entraînement (plus de sport
         = plus gros déficit = plus de "muscle perdu", ce qui est l'inverse du réel).
         signe : négatif = perdu, positif = pris */
      let gFat: number | null = null;
      if (deficit !== null) {
        gFat = deficit > 0
          ? -Math.round(deficit * fatFracMeasured / 7700 * 1000)
          : Math.round(-deficit / 7700 * 1000);
      }
      result.push({ key, label, jNum, foods, total, expend, adaptation, extraKcal, p: sp, g: sg, l: sl, fi: sfi, deficit, neutre, gFat });
    }
    return result;
  });


  function pct(a: number, b: number) { return b > 0 ? Math.min(100, Math.round(a/b*100)) : 0; }
  function fmt(n: number) { return (n > 0 ? '+' : '') + Math.round(n).toLocaleString('fr'); }

  const BUILD = "V14.5";
  // Recharge la dernière version déployée (en PWA sur iPhone il n'y a pas de bouton « recharger ») :
  // URL anti-cache pour forcer un index.html frais, et mise à jour d'un éventuel service worker.
  async function hardReload() {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((regs ?? []).map((r) => r.update()));
    } catch {}
    const u = new URL(location.href);
    u.searchParams.set('r', String(Date.now()));
    location.replace(u.toString());
  }
  const dateLabel = $derived((() => { const s = todayDate.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' }); return s.charAt(0).toUpperCase() + s.slice(1); })());

  let showModal = $state(false);
  let modalDayKey = $state(todayKey);

  function openModal(key: string) { modalDayKey = key; showModal = true; }

  async function saveExtraKcal(val: string, dayKey: string = todayKey) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const kcal = Math.max(0, Math.round(parseFloat(String(val).replace(',', '.')) || 0));
    const dayData = data.days?.[dayKey] ?? {};
    const newData = { ...data, days: { ...data.days, [dayKey]: { ...dayData, extraKcal: kcal } } };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  async function saveWeight(val: string, dayKey: string = todayKey) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const w = parseFloat(String(val).replace(',', '.')) || 0;
    const dayData = data.days?.[dayKey] ?? {};
    const newData = { ...data, days: { ...data.days, [dayKey]: { ...dayData, weight: w || undefined } } };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  async function saveBf(val: string, dayKey: string = todayKey) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const bf = parseFloat(String(val).replace(',', '.')) || 0;
    const dayData = data.days?.[dayKey] ?? {};
    const newData = { ...data, days: { ...data.days, [dayKey]: { ...dayData, bf: bf || undefined } } };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }

  // ---- Graphe de poids : points saisis + moyenne glissante 7 jours ----
  const weightSeries = $derived.by(() => {
    const entries: { t: number; w: number }[] = [];
    Object.entries((days as any) ?? {}).forEach(([k, d]: [string, any]) => {
      const w = nf(d?.weight);
      if (!w) return;
      const parts = k.split('/').map(Number);
      if (parts.length !== 3) return;
      entries.push({ t: new Date(parts[2], parts[1]-1, parts[0]).getTime(), w });
    });
    entries.sort((a, b) => a.t - b.t);
    if (entries.length < 2) return null;
    // moyenne glissante 7 jours (fenêtre calendaire)
    const avg = entries.map((e) => {
      const win = entries.filter((x) => e.t - x.t >= 0 && e.t - x.t < 7 * 86400000);
      return { t: e.t, w: win.reduce((s, x) => s + x.w, 0) / win.length };
    });
    const all = entries.map(e => e.w).concat(avg.map(a => a.w));
    const min = Math.min(...all), max = Math.max(...all);
    const pad = Math.max(0.4, (max - min) * 0.15);
    const lo = min - pad, hi = max + pad;
    const t0 = entries[0].t, t1 = entries[entries.length - 1].t || t0 + 1;
    const X = (t: number) => t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * 300;
    const Y = (w: number) => 80 - ((w - lo) / (hi - lo)) * 80;
    const pts = entries.map(e => `${X(e.t).toFixed(1)},${Y(e.w).toFixed(1)}`).join(' ');
    const avgPts = avg.map(a => `${X(a.t).toFixed(1)},${Y(a.w).toFixed(1)}`).join(' ');
    const last = entries[entries.length - 1];
    const lastAvg = avg[avg.length - 1];
    const delta = +(last.w - entries[0].w).toFixed(1);
    // serie masse grasse (echelle propre, superposee)
    const bfE: { t: number; v: number }[] = [];
    Object.entries((days as any) ?? {}).forEach(([k, d]: [string, any]) => {
      const v = nf(d?.bf);
      if (!v) return;
      const parts = k.split('/').map(Number);
      if (parts.length !== 3) return;
      bfE.push({ t: new Date(parts[2], parts[1]-1, parts[0]).getTime(), v });
    });
    bfE.sort((a, b) => a.t - b.t);
    let bfPts = '', lastBf = 0;
    if (bfE.length >= 2) {
      const bmin = Math.min(...bfE.map(e => e.v)), bmax = Math.max(...bfE.map(e => e.v));
      const bpad = Math.max(0.3, (bmax - bmin) * 0.15);
      const blo = bmin - bpad, bhi = bmax + bpad;
      const YB = (v: number) => 80 - ((v - blo) / (bhi - blo)) * 80;
      bfPts = bfE.map(e => `${X(e.t).toFixed(1)},${YB(e.v).toFixed(1)}`).join(' ');
      lastBf = bfE[bfE.length - 1].v;
    } else if (bfE.length === 1) {
      lastBf = bfE[0].v;
    }
    return { pts, avgPts, last: last.w, lastAvg: +lastAvg.w.toFixed(1), delta, n: entries.length,
             lastX: X(last.t).toFixed(1), lastY: Y(last.w).toFixed(1), bfPts, lastBf };
  });

  const SUPPS = [
    { key: 'folic', label: 'Folic Expert' },
    { key: 'omega3', label: 'Oméga 3' },
    { key: 'b12', label: 'B12' },
    { key: 'mag1', label: 'Magnésium 1' },
    { key: 'mag2', label: 'Magnésium 2' },
    { key: 'curcumine', label: 'Curcumine' },
    { key: 'coq10', label: 'CoQ10' },
    { key: 'vitc', label: 'Vitamine C' },
  ];
  async function toggleSupp(key: string) {
    const s = get(session); const data = get(appData) as any;
    if (!s || !data) return;
    const dayData = data.days?.[todayKey] ?? {};
    const supps = { ...(dayData.supps ?? {}) };
    supps[key] = !supps[key];
    const newData = { ...data, days: { ...data.days, [todayKey]: { ...dayData, supps } } };
    appData.set(newData);
    let token = s.access_token;
    try { const fresh = await refreshToken(s.refresh_token); token = fresh.access_token; } catch {}
    await saveAppState(token, s.user.id, newData);
  }

  async function removeFood(idx: number, dayKey: string = todayKey) {
    const s = get(session);
    const data = get(appData) as any;
    if (!s || !data) return;
    const dayData = data.days?.[dayKey] ?? {};
    const newFoods = [...(dayData.foods ?? [])];
    newFoods.splice(idx, 1);
    const newData = { ...data, days: { ...data.days, [dayKey]: { ...dayData, foods: newFoods } } };
    appData.set(newData);
    saveAppState(s.access_token, s.user.id, newData);
  }



</script>

<div class="scroll-area">
  <div class="header">
    <div>
      <div class="label">{$t.dashboard.today}</div>
      <div class="date">{dateLabel} <span class="heure-tag">{heureLabel}</span><span class="build-tag">{BUILD}</span><button class="reload-btn" onclick={hardReload} aria-label="Recharger l'app" title="Recharger"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg></button></div>
    </div>
    <div class="app-title">FitPro<span class="x">X</span></div>
  </div>

  {#if sundaySug?.show && sundaySug.delta !== 0}
  <div class="card sunday-card">
    <span class="sunday-ico">📅</span>
    <span class="sunday-msg">{sundaySug.msg}</span>
  </div>
  {/if}

  {#if avgMacros}
  <div class="section-label" style="margin-top:0">Moyenne / jour depuis le début ({avgMacros.n} j)</div>
  <div class="macro-row" class:four={trackFiber}>
    {#each [
      { key: 'p', label: $t.dashboard.proteins, color: 'var(--c-accent)', cible: mCible.p },
      { key: 'g', label: $t.dashboard.carbs,    color: 'var(--c-blue)',   cible: mCible.g },
      { key: 'l', label: $t.dashboard.fats,     color: 'var(--c-red)',    cible: mCible.l },
      ...(trackFiber ? [{ key: 'fi', label: 'Fibres', color: 'var(--c-green)', cible: mCible.fi }] : []),
    ] as m}
    {@const avg = (avgMacros as any)[m.key]}
    <div class="card macro-card">
      <div class="label">{m.label}</div>
      <div class="progress-bar" style="margin:10px 0 8px">
        <div class="progress-fill" style="width:{pct(avg ?? 0, m.cible)}%;background:{m.color};opacity:.65"></div>
      </div>
      <div class="macro-val">{avg ?? '—'}<span class="macro-target">/{m.cible}g</span></div>
    </div>
    {/each}
  </div>
  {/if}


  <div class="section-label" style="margin-top:0">Aujourd'hui</div>
  <div class="macro-row" class:four={trackFiber}>
    {#each [
      { key: 'p', label: $t.dashboard.proteins, color: 'var(--c-accent)', cible: mCible.p },
      { key: 'g', label: $t.dashboard.carbs,    color: 'var(--c-blue)',   cible: mCible.g },
      { key: 'l', label: $t.dashboard.fats,     color: 'var(--c-red)',    cible: mCible.l },
      ...(trackFiber ? [{ key: 'fi', label: 'Fibres', color: 'var(--c-green)', cible: mCible.fi }] : []),
    ] as m}
    {@const actual = Math.round(macros[m.key as keyof typeof macros])}
    <div class="card macro-card">
      <div class="label">{m.label}</div>
      <div class="progress-bar" style="margin:10px 0 8px">
        <div class="progress-fill" style="width:{pct(actual, m.cible)}%;background:{m.color}"></div>
      </div>
      <div class="macro-val">{actual}<span class="macro-target">/{m.cible}g</span></div>
    </div>
    {/each}
  </div>


  <!-- Repas du jour -->
  <div class="card foods-card">
    <div class="foods-header">
      <span class="label">Repas du jour</span>
      <button class="add-food-btn" onclick={() => openModal(todayKey)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Ajouter
      </button>
    </div>

    {#if foods.length === 0}
      <div class="foods-empty">Rien de loggé — ajoute ton premier repas !</div>
    {:else}
      <div class="foods-list">
        {#each foods as food, i}
          <div class="food-item">
            <div class="food-nm">
              <span class="food-n">{food.n}</span>
              <span class="food-m">P {Math.round(food.p ?? 0)}g · G {Math.round(food.g ?? 0)}g · L {Math.round(food.l ?? 0)}g{trackFiber && food.fi != null ? ' · F ' + Math.round(food.fi) + 'g' : ''}</span>
            </div>
            <span class="food-k">{Math.round(food.k)} kcal</span>
            <button class="food-del" onclick={() => removeFood(i)} aria-label="Supprimer">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        {/each}
        <div class="foods-total">
          <span>Total</span>
          <span class="total-k">{Math.round(macros.k)} kcal</span>
        </div>
      </div>
    {/if}

    <!-- Sport cal : calories actives réelles (montre) du jour -->
    <div class="sport-extra-row">
      <span class="sport-extra-label">⌚ Sport cal</span>
      <input class="sport-extra-inp" type="number" min="0" step="10"
        placeholder="0"
        value={today?.extraKcal ?? 0}
        onblur={(e) => saveExtraKcal((e.target as HTMLInputElement).value)}
      />
      <span class="sport-extra-unit">kcal actives</span>
    </div>
    <div class="supp-row">
      {#each SUPPS as sp}
        <button class="supp-chip" class:on={today?.supps?.[sp.key]} onclick={() => toggleSupp(sp.key)}><span class="supp-box">{today?.supps?.[sp.key] ? '✓' : ''}</span> {sp.label}</button>
      {/each}
    </div>
    <div class="sport-extra-row" style="border-top:0.5px solid var(--c-border);margin-top:8px;padding-top:10px">
      <span class="sport-extra-label">⚖️ Poids du jour</span>
      <input class="sport-extra-inp" type="number" inputmode="decimal" min="0" step="0.1"
        placeholder="—"
        value={today?.weight ?? ''}
        onblur={(e) => saveWeight((e.target as HTMLInputElement).value)}
      />
      <span class="sport-extra-unit">kg</span>
    </div>
    <div class="sport-extra-row">
      <span class="sport-extra-label">📊 Masse grasse</span>
      <input class="sport-extra-inp" type="number" inputmode="decimal" min="0" max="60" step="0.1"
        placeholder="—"
        value={today?.bf ?? ''}
        onblur={(e) => saveBf((e.target as HTMLInputElement).value)}
      />
      <span class="sport-extra-unit">%</span>
    </div>
  </div>

  <!-- Courbe de poids -->
  {#if weightSeries}
  <div class="card foods-card">
    <div class="foods-header">
      <span class="label">Poids</span>
      <span class="weight-badge">{weightSeries.last.toLocaleString('fr')} kg · moy. 7j {weightSeries.lastAvg.toLocaleString('fr')} kg{#if weightSeries.lastBf} · <span style="color:var(--c-blue)">{weightSeries.lastBf.toLocaleString('fr')}% MG</span>{/if}</span>
    </div>
    <svg viewBox="-4 -6 312 92" class="weight-chart" preserveAspectRatio="none">
      <polyline points={weightSeries.pts} fill="none" stroke="var(--c-border2)" stroke-width="1.5" />
      <polyline points={weightSeries.avgPts} fill="none" stroke="var(--c-accent)" stroke-width="2.5" stroke-linecap="round" />
      {#if weightSeries.bfPts}<polyline points={weightSeries.bfPts} fill="none" stroke="var(--c-blue)" stroke-width="2" stroke-dasharray="4 3" stroke-linecap="round" />{/if}
      <circle cx={weightSeries.lastX} cy={weightSeries.lastY} r="3" fill="var(--c-accent)" />
    </svg>
    <div class="caption" style="margin-top:6px">{weightSeries.n} pesées · {weightSeries.delta <= 0 ? '' : '+'}{weightSeries.delta.toLocaleString('fr')} kg depuis le début · ligne épaisse = poids moy. 7 j · fine = pesées brutes · pointillés bleus = % MG</div>
  </div>
  {/if}


  <!-- Historique des jours passés -->
  <div class="section-label">Historique</div>
  {#each recentDays() as day}
  <details class="card hist-card">
    <summary class="hist-summary">
      <div class="hist-top">
        <span class="hist-date">{day.label}{#if day.jNum} (J{day.jNum}){/if}</span>
        <span class="hist-kcal" style="color:{day.foods.length ? (day.total <= day.expend ? 'var(--c-green)' : 'var(--c-red)') : 'var(--c-text2)'}">
          {Math.round(day.total).toLocaleString('fr')} kcal
        </span>
        {#if day.foods.length}
        <span class="hist-cible">/ {Math.round(day.expend).toLocaleString('fr')}</span>
        {/if}
      </div>
      {#if day.foods.length}
      <div class="hist-macros">P {Math.round(day.p)}g · G {Math.round(day.g)}g · L {Math.round(day.l)}g{trackFiber ? ' · F ' + (day.fi != null ? Math.round(day.fi) + 'g' : '–') : ''}{#if day.deficit !== null}{' · '}<span style="font-weight:600;color:{day.neutre ? 'var(--c-blue)' : (day.deficit >= 0 ? 'var(--c-green)' : 'var(--c-red)')}">{day.neutre ? 'neutre' : (day.deficit >= 0 ? 'déficit −' + day.deficit.toLocaleString('fr') : 'surplus +' + Math.abs(day.deficit).toLocaleString('fr'))}</span>{#if !day.neutre && day.gFat !== null}<span class="grams-detail"><span style="color:{day.gFat > 0 ? 'var(--c-red)' : 'var(--c-green)'}">{day.gFat < 0 ? '−' : day.gFat > 0 ? '+' : ''}{Math.abs(day.gFat)}g gras</span></span>{/if}{/if}</div>
      {/if}
    </summary>
    <div class="hist-foods">
      {#each day.foods as f, fi}
      <div class="hist-food-row">
        <div class="food-nm">
          <span class="food-n">{f.n}</span>
          <span class="food-m">P {Math.round(f.p ?? 0)}g · G {Math.round(f.g ?? 0)}g · L {Math.round(f.l ?? 0)}g{trackFiber && f.fi != null ? ' · F ' + Math.round(f.fi) + 'g' : ''}</span>
        </div>
        <span class="food-k">{Math.round(f.k)} kcal</span>
        <button class="food-del" onclick={() => removeFood(fi, day.key)} aria-label="Supprimer">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      {/each}
      <!-- Ajouter aliment -->
      <button class="hist-add-btn" onclick={() => openModal(day.key)}>+ Ajouter un aliment</button>
      <!-- Sport cal : calories actives réelles (montre) de ce jour -->
      <div class="sport-extra-row" style="border-top:0.5px solid var(--c-border);margin-top:6px;padding-top:10px">
        <span class="sport-extra-label">⌚ Sport cal</span>
        <input class="sport-extra-inp" type="number" min="0" step="10"
          placeholder="0"
          value={day.extraKcal}
          onblur={(e) => saveExtraKcal((e.target as HTMLInputElement).value, day.key)}
        />
        <span class="sport-extra-unit">kcal actives</span>
      </div>
      <div class="sport-extra-row">
        <span class="sport-extra-label">⚖️ Poids</span>
        <input class="sport-extra-inp" type="number" inputmode="decimal" min="0" step="0.1"
          placeholder="—"
          value={(days as any)[day.key]?.weight ?? ''}
          onblur={(e) => saveWeight((e.target as HTMLInputElement).value, day.key)}
        />
        <span class="sport-extra-unit">kg</span>
      </div>
      <div class="sport-extra-row">
        <span class="sport-extra-label">📊 Masse grasse</span>
        <input class="sport-extra-inp" type="number" inputmode="decimal" min="0" max="60" step="0.1"
          placeholder="—"
          value={(days as any)[day.key]?.bf ?? ''}
          onblur={(e) => saveBf((e.target as HTMLInputElement).value, day.key)}
        />
        <span class="sport-extra-unit">%</span>
      </div>
      {#if day.adaptation}<div class="caption" style="padding:8px 0 0">🔥 Thermogénèse adaptative comptée ce jour-là : −{day.adaptation} kcal</div>{/if}
    </div>
  </details>
  {/each}

  <div class="stats-row">
    <div class="card stat-card">
      <div class="label">{$t.dashboard.cumul}</div>
      <div class="value-accent" style="color:{cumulReal <= 0 ? 'var(--c-accent)' : 'var(--c-red)'}">
        {fmt(cumulReal)}
      </div>
      <div class="caption">{$t.dashboard.since_start}</div>
    </div>
    {#if owner}
    <div class="card stat-card">
      <div class="label">{$t.dashboard.goal_nov}</div>
      {#if bfProjected}
        <div class="value-sm">{bfProjected}%</div>
        <div class="caption">{$t.dashboard.body_fat_projected}</div>
      {:else}
        <div class="value-sm">—</div>
      {/if}
    </div>
    {:else}
    {@const cur = settingsFor(settingsLog, todayDate.getTime()) as any}
    <div class="card stat-card">
      <div class="label">Dépense hors sport</div>
      <div class="value-sm">{Math.round(cur.baseRef)} kcal</div>
      <div class="caption">{['formule', 'estimation', 'defaut'].includes(cur.source) ? `estimation${cur.sigma ? ' ± ' + cur.sigma : ''} · s'affine (Profil)` : 'mesurée'}</div>
    </div>
    {/if}
  </div>

</div>

{#if showModal}
  <FoodModal dayKey={modalDayKey} onclose={() => showModal = false} />
{/if}

<style>
.header { display:flex; align-items:center; justify-content:space-between; padding:20px 0 12px; }
.date { font-size:20px; font-weight:500; color:var(--c-text); margin-top:3px; letter-spacing:-0.3px; display:flex; align-items:baseline; gap:8px; }
.build-tag { font-size:11px; font-weight:500; color:var(--c-text3); letter-spacing:0; text-transform:none; }
.reload-btn { align-self:center; display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; margin-left:-6px; padding:0; border:0; border-radius:8px; background:transparent; color:var(--c-text3); cursor:pointer; -webkit-tap-highlight-color:transparent; }
.reload-btn:active { background:var(--c-surface2); color:var(--c-text); }
.macro-row { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:10px; }
.macro-row.four { grid-template-columns:repeat(4,1fr); gap:6px; }
.macro-row.four .macro-card { padding:12px 9px; min-width:0; }
.macro-row.four .macro-val { font-size:15px; }
.macro-row.four .label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.macro-card { padding:14px; }
.macro-val { font-size:18px; font-weight:600; color:var(--c-text); }
.macro-target { font-size:11px; font-weight:400; color:var(--c-text3); }

/* Foods */
.foods-card { padding:16px; margin-bottom:10px; }
.weight-badge { font-size:12px; font-weight:600; color:var(--c-text2); }
.weight-chart { width:100%; height:88px; display:block; }
.foods-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.add-food-btn { display:flex; align-items:center; gap:5px; padding:6px 12px; border:none; border-radius:20px; background:var(--c-accent); color:var(--c-accent-fg); font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font); }
.foods-empty { font-size:13px; color:var(--c-text3); text-align:center; padding:12px 0; }
.sport-extra-row { display:flex; align-items:center; gap:8px; padding:12px 0 2px; border-top:0.5px solid var(--c-border); margin-top:4px; }
.sport-extra-label { flex:1; font-size:13px; color:var(--c-text2); }
.sport-extra-inp { width:72px; padding:6px 8px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg); color:var(--c-text); font-size:13px; text-align:right; font-family:var(--font); }
.sport-extra-inp:focus { outline:none; border-color:var(--c-accent); }
.sport-extra-unit { font-size:12px; color:var(--c-text3); white-space:nowrap; }
.foods-list { display:flex; flex-direction:column; gap:0; }
.food-item { display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:0.5px solid var(--c-border); }
.food-nm { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.food-n { font-size:13px; color:var(--c-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.food-m { font-size:10px; color:var(--c-text3); white-space:nowrap; }
.food-k { font-size:12px; font-weight:500; color:var(--c-text2); flex-shrink:0; }
.food-del { border:none; background:none; color:var(--c-text3); cursor:pointer; padding:2px; display:flex; align-items:center; }
.food-del:hover { color:var(--c-red,#e05); }
.foods-total { display:flex; justify-content:space-between; padding:8px 0 0; font-size:13px; color:var(--c-text2); font-weight:500; }
.total-k { color:var(--c-accent); font-weight:600; }

.stats-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }
.stat-card { display:flex; flex-direction:column; gap:4px; padding:16px; }
.value-accent { font-size:24px; font-weight:500; letter-spacing:-0.5px; }
.value-sm { font-size:24px; font-weight:500; letter-spacing:-0.5px; color:var(--c-text); }


.section-label { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--c-text3); margin:14px 0 8px; }
.hist-card { padding:0; margin-bottom:6px; overflow:hidden; }
.hist-summary { display:flex; flex-direction:column; gap:3px; padding:12px 14px; cursor:pointer; list-style:none; }
.hist-top { display:flex; align-items:center; gap:8px; }
.hist-macros { font-size:11px; color:var(--c-text3); }
.grams-detail { display:block; margin-top:2px; font-weight:600; }
.hist-summary::-webkit-details-marker { display:none; }
.hist-date { flex:1; font-size:13px; font-weight:500; color:var(--c-text); text-transform:capitalize; }
.hist-kcal { font-size:13px; font-weight:600; flex-shrink:0; }
.hist-cible { font-size:11px; color:var(--c-text3); flex-shrink:0; }
.hist-foods { padding:0 14px 12px; display:flex; flex-direction:column; gap:0; border-top:0.5px solid var(--c-border); }
.hist-food-row { display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:0.5px solid var(--c-border); }
.hist-food-row:last-child { border-bottom:none; }
.hist-add-btn { width:100%; padding:8px; border:1px dashed var(--c-border); border-radius:8px; background:none; color:var(--c-accent); font-size:13px; cursor:pointer; font-family:var(--font); margin-top:6px; }
.hist-add-btn:hover { background:var(--c-surface); }


  /* Cellules colorees (mode clair) — palette FitNoobX */

.app-title { font-size:22px; font-weight:700; color:var(--c-text); letter-spacing:-0.5px; }
.app-title .x { color:var(--c-accent); }

  /* Polices uniformisees des cellules (style FitNoobX) */
  .macro-card .label { font-weight:600; }

  /* Uniformisation avec FitNoobX */
  .header .label { font-weight:600; letter-spacing:.07em; }

  /* Alignement exact sur le design FitNoobX (onglet Suivi) */
  .macro-row { margin-bottom:8px; }

  .heure-tag { font-size:14px; font-weight:400; color:var(--c-text2); letter-spacing:0; }

.supp-row { display:flex; flex-wrap:wrap; gap:6px; border-top:0.5px solid var(--c-border); margin-top:8px; padding-top:10px; }
.supp-chip { display:flex; align-items:center; gap:5px; border:0.5px solid var(--c-border); background:var(--c-bg); color:var(--c-text2); border-radius:20px; padding:5px 10px; font-size:12px; cursor:pointer; font-family:var(--font); }
.supp-chip.on { background:var(--c-green); border-color:var(--c-green); color:#fff; }
.supp-box { width:14px; height:14px; border-radius:4px; border:1px solid currentColor; display:inline-flex; align-items:center; justify-content:center; font-size:10px; line-height:1; flex-shrink:0; }
.supp-chip.on .supp-box { background:#fff; color:var(--c-green); border-color:#fff; }
.sunday-card { display:flex; align-items:flex-start; gap:9px; padding:12px 14px; margin-bottom:10px; background:var(--c-surface); border:1px solid var(--c-accent); border-radius:var(--r-md); }
.sunday-ico { font-size:16px; flex-shrink:0; }
.sunday-msg { font-size:13px; color:var(--c-text); line-height:1.4; }
</style>
