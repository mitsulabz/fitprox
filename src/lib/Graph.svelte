<script lang="ts">
  import { onMount } from 'svelte';
  import { appData, session } from './store';
  import { saveAppState } from './supabase';
  import { get } from 'svelte/store';
  import { nf } from './calc';
  import { buildTimeline, settingsFor, dsToMs } from './engine';
  import { isOwner, userJ1, effectiveSettingsLog } from './account';
  import { initGraphViz } from './graphViz';

  let root: HTMLDivElement;

  onMount(() => {
    const data = (get(appData) as any) ?? {};
    const uid = get(session)?.user?.id ?? '';
    const p = data.profile ?? {};
    const days = data.days ?? {};
    const j1Ds = userJ1(uid, data);        // propriétaire : 22/06/2026 ; autres : leur premier jour
    const [j1d, j1m, j1y] = j1Ds.split('/').map(Number);
    const J1 = Date.UTC(j1y, j1m - 1, j1d);
    const j1Label = new Date(j1y, j1m - 1, j1d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    const nowMs = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    const log = effectiveSettingsLog(uid, data);
    // timeline (glycogène) sur les jours loggés
    const dl = Object.keys(days).map((ds) => ({ ds, t: dsToMs(ds) })).filter((x: any) => !isNaN(x.t)).sort((a: any, b: any) => a.t - b.t);
    const info = (ds: string) => {
      const dd: any = days[ds] ?? {}; const fds = dd.foods ?? [];
      return { weight: nf(dd.weight), bf: nf(dd.bf), eaten: fds.reduce((s: number,f: any)=>s+(f.k||0),0), gluc: fds.reduce((s: number,f: any)=>s+(f.g||0),0), prot: fds.reduce((s: number,f: any)=>s+(f.p||0),0), extraKcal: dd.extraKcal ?? 0, sportKcal: 0, libre: !!dd.libre, logged: fds.length > 0 };
    };
    const tl: any = buildTimeline({ dateList: dl, settingsLog: log, todayTime: nowMs, dayFrac: 1, info });
    // cohérence mensuelle : déficit cumulé vs perte de poids mesurée
    const _MO = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
    const byMonth: any = {};
    const J1recon = dsToMs(j1Ds); // début du régime (J1)
    for (const r of tl.list as any[]) {
      if (!r.logged || r.deficit == null || r.isFuture || r.t < J1recon) continue;
      const dt = new Date(r.t);
      const key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
      if (!byMonth[key]) byMonth[key] = { def: 0, days: 0, recs: [] };
      byMonth[key].def += r.deficit; byMonth[key].days++; byMonth[key].recs.push(r);
    }
    const reconciliation = Object.keys(byMonth).sort().map((k) => {
      const m = byMonth[k]; const wp = m.recs.filter((r: any) => r.pm7 != null);
      const first = wp[0], last = wp[wp.length - 1];
      const actualKg = (first && last) ? +(first.pm7 - last.pm7).toFixed(2) : null;
      const pa = k.split('-');
      return { label: _MO[+pa[1] - 1] + ' ' + pa[0].slice(2), days: m.days, avgDef: Math.round(m.def / m.days), expectedKg: +(m.def / 7700).toFixed(2), actualKg };
    });
    // pesées réelles + poids ajusté (glycogène)
    const pts: { t: number; w: number; f: number | null; adj: number | null }[] = [];
    for (const k of Object.keys(days)) {
      const d = days[k];
      const w = nf(d?.weight); if (!w) continue;
      const parts = k.split('/').map(Number); if (parts.length !== 3) continue;
      const t = Date.UTC(parts[2], parts[1] - 1, parts[0]);
      const bfv = nf(d?.bf);
      const rec = tl.byKey[k];
      pts.push({ t, w, f: bfv > 0 ? +(w * bfv / 100).toFixed(1) : null, adj: rec && rec.poidsAjuste != null ? rec.poidsAjuste : null });
    }
    pts.sort((a, b) => a.t - b.t);
    const history = pts.filter((pt) => pt.t >= J1); // jusqu'a la derniere pesee (aujourd'hui)
    // fibres par jour (historique réel), si le suivi des fibres est activé ; aujourd'hui exclu (journée en cours)
    const _d = new Date(); const todayUTC = Date.UTC(_d.getFullYear(), _d.getMonth(), _d.getDate());
    const fiber: { t: number; fi: number }[] = [];
    if (p.trackFiber) for (const k of Object.keys(days)) {
      const fds: any[] = days[k]?.foods ?? [];
      if (!fds.some((f: any) => f.fi != null)) continue;
      const parts = k.split('/').map(Number); if (parts.length !== 3) continue;
      const t = Date.UTC(parts[2], parts[1] - 1, parts[0]);
      if (t < J1 || t >= todayUTC) continue;
      fiber.push({ t, fi: +fds.reduce((s: number, f: any) => s + (f.fi || 0), 0).toFixed(1) });
    }
    fiber.sort((a, b) => a.t - b.t);
    const fiberTarget = 25; // au moins 25 g/jour pour tous (OMS 2023, EFSA)
    const last = pts[pts.length - 1];
    const W0 = last?.w || nf(p.weight) || 80;
    const lastBf = last && last.f ? (last.f / last.w * 100) : (nf(p.bf) || 25);
    const F0 = +(W0 * lastBf / 100).toFixed(1);
    const st: any = settingsFor(log, nowMs);
    const BASE0 = Math.round(st.baseRef - 12 * (st.poidsRef - W0)) || 2000;
    // bannière eau (dernier jour loggé)
    const lastRec = tl.list[tl.list.length - 1];
    const eau = lastRec ? lastRec.eauGlyco : 0;
    const waterBanner = Math.abs(eau) > 300 ? `~${Math.abs(eau)} g d'eau (glycogène) ${eau > 0 ? 'masquent' : 'exagèrent'} la tendance récente.` : '';
    const saved = data.programme?.graphSettings ?? null;
    const onSave = (state: any) => {
      const ss = get(session); const d = get(appData) as any;
      if (!ss || !d) return;
      const nd = { ...d, programme: { ...(d.programme ?? {}), graphSettings: state } };
      appData.set(nd);
      saveAppState(ss.access_token, ss.user.id, nd);
    };
    const _t = new Date();
    const todayMs = Date.UTC(_t.getFullYear(), _t.getMonth(), _t.getDate());
    return initGraphViz(root, { W0, F0, BASE0, history, waterBanner, saved, onSave, measured: pts, todayMs, reconciliation,
      owner: isOwner(uid), j1Label, baseSource: (st as any).source ?? 'mesure', fiber, fiberTarget });
  });
</script>

<div class="graph-root" bind:this={root}></div>

<style>
:global {
  .graph-root {
    --surface-1: var(--c-bg);
    --surface-2: var(--c-surface);
    --surface-3: var(--c-surface2);
    --text-primary: var(--c-text);
    --text-secondary: var(--c-text2);
    --text-muted: var(--c-text3);
    --line: var(--c-border);
    --s1:#2a78d6; --s2:#eb6834; --s3:#7a5cd6; --s4:#2e9e5b; --band:#2a78d633;
    margin:0; color:var(--text-primary);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    /* même marge haute que les autres onglets (.scroll-area + en-tête) : sous l'encoche / la barre d'état de l'iPhone */
    padding:calc(max(16px, env(safe-area-inset-top, 0px)) + 20px) 14px calc(90px + env(safe-area-inset-bottom, 0px)); min-height:100vh;
  }
  .graph-root * { box-sizing:border-box; }
  .graph-root .wrap { max-width:1020px; margin:0 auto; }
  .graph-root h1 { font-size:21px; margin:0 0 4px; letter-spacing:-.01em; }
  .graph-root .sub { color:var(--text-secondary); font-size:13.5px; margin:0 0 22px; }
  .graph-root section { margin:0 0 30px; border:1px solid var(--line); border-radius:12px; padding:16px 14px 10px; background:var(--surface-1); }
  .graph-root .shead { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px; }
  .graph-root h2 { font-size:16px; margin:0; letter-spacing:-.01em; }
  .graph-root .h2sub { font-size:12.5px; color:var(--text-muted); font-weight:400; margin-top:2px; }
  .graph-root .ctl { display:flex; align-items:center; gap:9px; flex-wrap:wrap; font-size:12.5px; color:var(--text-secondary); }
  .graph-root .seg { display:flex; flex-wrap:wrap; background:var(--surface-2); border:1px solid var(--line); border-radius:9px; padding:2px; gap:2px; }
  .graph-root .seg button { border:0; background:transparent; color:var(--text-secondary); font:inherit; font-size:12.5px; padding:5px 9px; border-radius:7px; cursor:pointer; font-variant-numeric:tabular-nums; min-width:38px; }
  .graph-root .seg button:hover { background:var(--surface-3); }
  .graph-root .seg button[aria-pressed="true"] { background:var(--text-primary); color:var(--surface-1); font-weight:600; }
  .graph-root .kpis { display:flex; flex-wrap:wrap; gap:9px; margin:14px 0 4px; }
  .graph-root .kpi { background:var(--surface-2); border:1px solid var(--line); border-radius:9px; padding:9px 13px; min-width:132px; flex:1; }
  .graph-root .kpi .lab { font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--text-muted); display:flex; align-items:center; gap:6px; }
  .graph-root .kpi .dot { width:8px; height:8px; border-radius:50%; }
  .graph-root .kpi .val { font-size:21px; font-weight:600; letter-spacing:-.02em; margin-top:3px; font-variant-numeric:tabular-nums; }
  .graph-root .kpi .val small { font-size:12.5px; font-weight:400; color:var(--text-secondary); }
  .graph-root .kpi .d { font-size:12px; color:var(--text-secondary); font-variant-numeric:tabular-nums; }
  .graph-root .legend { display:flex; flex-wrap:wrap; gap:14px; font-size:12.5px; color:var(--text-secondary); margin:6px 0 2px; }
  .graph-root .legend span { display:inline-flex; align-items:center; gap:7px; }
  .graph-root .sw { width:20px; height:0; border-top:2.6px solid; border-radius:2px; }
  .graph-root .swb { width:20px; height:11px; background:var(--band); border-radius:3px; }
  .graph-root .cw { position:relative; overflow-x:auto; overflow-y:hidden; }
  .graph-root .cw svg { display:block; }
  .graph-root .tip { position:absolute; pointer-events:none; opacity:0; transition:opacity .1s; background:var(--surface-2); border:1px solid var(--line); border-radius:9px; padding:8px 11px; font-size:12.5px; box-shadow:0 6px 20px rgba(0,0,0,.14); white-space:nowrap; font-variant-numeric:tabular-nums; z-index:5; top:6px; max-width:calc(100% - 8px); }
  .graph-root .tip b { display:block; margin-bottom:4px; font-size:12px; color:var(--text-secondary); font-weight:500; }
  .graph-root .tip div { display:flex; justify-content:space-between; gap:16px; }
  .graph-root .tip i { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:6px; }
  .graph-root .pt { font:600 12.5px ui-sans-serif,-apple-system,sans-serif; fill:var(--text-primary); }
  .graph-root .pu { fill:var(--text-muted); font-weight:400; }
  .graph-root .tk { font:10.5px ui-sans-serif,-apple-system,sans-serif; fill:var(--text-muted); font-variant-numeric:tabular-nums; }
  .graph-root .dl { font:600 13px ui-sans-serif,-apple-system,sans-serif; fill:var(--text-primary); font-variant-numeric:tabular-nums; }
  .graph-root .dl0 { font:11px ui-sans-serif,-apple-system,sans-serif; fill:var(--text-muted); font-variant-numeric:tabular-nums; }
  .graph-root .gr { stroke:var(--line); stroke-width:1; }
  .graph-root .grv { stroke:var(--line); stroke-width:1; opacity:.5; }
  .graph-root .ref { stroke:var(--text-muted); stroke-width:1; stroke-dasharray:4 4; opacity:.55; }
  .graph-root .reftx { font:10px ui-sans-serif,sans-serif; fill:var(--text-muted); }
  .graph-root .cmp { stroke:var(--text-muted); stroke-width:1; stroke-dasharray:2 3; opacity:.6; }
  .graph-root .cmptx { font:9.5px ui-sans-serif,sans-serif; fill:var(--text-muted); }
  .graph-root .obj { stroke:var(--s2); stroke-width:1.5; opacity:.75; }
  .graph-root .crs { stroke:var(--text-muted); stroke-width:1; stroke-dasharray:3 3; }
  .graph-root .water-banner { margin-top:8px; font-size:12.5px; color:var(--text-primary); background:var(--surface-2); border:1px solid var(--s1); border-radius:9px; padding:8px 11px; }
  .graph-root .note { font-size:12.5px; color:var(--text-secondary); border-left:3px solid var(--line); padding-left:12px; margin:16px 0 4px; }
  .graph-root details { margin-top:16px; }
  .graph-root summary { cursor:pointer; font-size:13px; color:var(--text-secondary); }
  .graph-root .tbl { overflow-x:auto; }
  .graph-root table { border-collapse:collapse; font-size:12.5px; margin-top:12px; width:100%; font-variant-numeric:tabular-nums; }
  .graph-root th, .graph-root td { padding:4px 8px; text-align:right; border-bottom:1px solid var(--line); }
  .graph-root th { color:var(--text-muted); font-weight:500; font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; }
  .graph-root td:first-child, .graph-root th:first-child { text-align:left; }
  .graph-root .warn { color:var(--s2); font-weight:600; }
  .graph-root .hyp { margin:12px 0 0; padding:10px 13px; background:var(--surface-2); border:1px solid var(--line); border-radius:9px; font-size:13px; color:var(--text-secondary); font-variant-numeric:tabular-nums; line-height:1.5; }
  .graph-root .hyp b { color:var(--text-primary); font-weight:600; }
  .graph-root .acts { margin-top:14px; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .graph-root .acts .ah { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 12px; background:var(--surface-2); font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--text-muted); }
  .graph-root .acts .ar { display:flex; align-items:center; gap:8px; padding:6px 12px; border-top:1px solid var(--line); flex-wrap:wrap; }
  .graph-root .acts input { font:inherit; font-size:13px; background:var(--surface-1); color:var(--text-primary); border:1px solid var(--line); border-radius:7px; padding:5px 8px; font-variant-numeric:tabular-nums; }
  .graph-root .acts input.nm { flex:1; min-width:120px; }
  .graph-root .acts input.nb { width:78px; text-align:right; }
  .graph-root .acts .u { font-size:12px; color:var(--text-muted); min-width:50px; }
  .graph-root .acts .del { border:0; background:transparent; color:var(--text-muted); font-size:17px; line-height:1; cursor:pointer; padding:2px 7px; border-radius:6px; }
  .graph-root .acts .del:hover { background:var(--surface-3); color:var(--s2); }
  .graph-root .acts .af { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 12px; border-top:1px solid var(--line); background:var(--surface-2); }
  .graph-root .acts .add { border:1px dashed var(--line); background:transparent; color:var(--text-secondary); font:inherit; font-size:12.5px; padding:5px 11px; border-radius:8px; cursor:pointer; }
  .graph-root .acts .add:hover { background:var(--surface-3); }
  .graph-root .acts .tot { font-size:12.5px; color:var(--text-secondary); font-variant-numeric:tabular-nums; }
  .graph-root .acts .tot b { color:var(--text-primary); }
}
</style>
