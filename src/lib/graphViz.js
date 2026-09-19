// @ts-nocheck
/* Prévisionnel — poids & masse grasse.
   root = conteneur ; seed = { W0, F0, BASE0, owner, j1Label, baseSource, ... } fournis par Graph.svelte.
   Les périodes et compétitions (objectif Toulouse) ne concernent que le compte du propriétaire ;
   les autres utilisateurs ont un prévisionnel générique sur les 3 prochains mois. */
export function initGraphViz(root, seed) {
  const W0 = seed.W0, F0 = seed.F0, L0 = W0 - F0;
  const BASE0 = seed.BASE0, CW = 12, ADAPT = 0.12;
  const KC = 7300, KLO = 6950, KHI = 7600, DAY = 86400000;
  const OPTS = [0,100,200,300,400,500,600,700];
  const OPTSA = [1400,1500,1600,1700,1800,1900,2000,2100,2200,2400];
  let adapt = true, mode = 'app';
  const MEAS = seed.measured || [];
  const TODAY = seed.todayMs || Date.UTC(2026,7,9);
  const OWNER = !!seed.owner;

  // compétitions du propriétaire (traits verticaux) ; aucune pour les autres comptes
  const COMP = OWNER ? [[Date.UTC(2026,8,19),"Chinon"],[Date.UTC(2026,8,27),"Nîmes"],[Date.UTC(2026,8,28),"Toulon"],
    [Date.UTC(2026,9,10),"Monteux"],[Date.UTC(2026,9,11),""],[Date.UTC(2026,10,1),"TOULOUSE"]] : [];
  const nearest = (opts, v) => opts.reduce((b, o) => (Math.abs(o - v) < Math.abs(b - v) ? o : b), opts[0]);

  const PER_ALL = !OWNER ? [
    {id:'G', titre:'Les 3 prochains mois', t0:TODAY, t1:TODAY + 91*DAY, daily:true,
     note:"jour par jour · à partir d'aujourd'hui", app:nearest(OPTSA, BASE0 - 400), def:400, acts:[]}
  ] : [
    {id:'A', titre:'Août 2026', t0:Date.UTC(2026,7,1), t1:Date.UTC(2026,8,1), daily:true,
     note:'jour par jour · routine actuelle', app:1900, def:500,
     acts:[{n:'Vélo elliptique 40 min',k:450,j:7},{n:'Musculation',k:160,j:0}]},
    {id:'B', titre:'Septembre → 1er novembre 2026', t0:Date.UTC(2026,8,1), t1:Date.UTC(2026,10,1), daily:true,
     note:'jour par jour · saison · objectif Toulouse', app:1900, def:500,
     acts:[{n:'Escrime — entraînement',k:963,j:2},{n:'Badminton 1h30',k:570,j:3},{n:'Full body + Z2 25 min',k:425,j:1}]},
    {id:'C', titre:'Novembre 2026 → juillet 2027', t0:Date.UTC(2026,10,1), t1:Date.UTC(2027,6,1), daily:false,
     note:'une valeur au 1er de chaque mois', app:2000, def:200,
     acts:[{n:'Escrime — entraînement',k:963,j:2},{n:'Badminton 1h30',k:570,j:3},{n:'Full body + Z2 25 min',k:425,j:1}]}
  ];

  // applique les réglages sauvegardés (déficit/apport/activités/mode/adaptation)
  if (seed.saved) {
    if (seed.saved.mode) mode = seed.saved.mode;
    if (typeof seed.saved.adapt === 'boolean') adapt = seed.saved.adapt;
    if (Array.isArray(seed.saved.periods)) {
      for (const sp of seed.saved.periods) {
        const P = PER_ALL.find(x => x.id === sp.id);
        if (P) {
          if (typeof sp.def === 'number') P.def = sp.def;
          if (typeof sp.app === 'number') P.app = sp.app;
          if (Array.isArray(sp.acts)) P.acts = sp.acts.map(a => ({ n: a.n, k: +a.k || 0, j: +a.j || 0 }));
        }
      }
    }
  }
  /* Périodes affichées : on masque celles entièrement passées (leur fin est
     derrière nous) — il n'y a plus rien à y projeter, le réel a pris le relais.
     PER_ALL reste la référence pour la sauvegarde, pour ne rien perdre. */
  const PER = PER_ALL.filter(p => p.t1 > TODAY);

  function saveState() {
    if (typeof seed.onSave !== 'function') return;
    seed.onSave({ mode, adapt, periods: PER_ALL.map(p => ({ id: p.id, def: p.def, app: p.app, acts: p.acts.map(a => ({ n: a.n, k: a.k, j: a.j })) })) });
  }

  root.innerHTML = `<div class="wrap">
<h1>Poids — historique & prévisionnel</h1>
<section id="reconSec"><h2>Cohérence : déficit ↔ poids réel</h2><div class="h2sub">Ton déficit cumulé colle-t-il à ta perte de poids mesurée, mois par mois ?</div><div id="reconTbl"></div></section>
<section id="histSec">
<h2>Historique réel</h2>
<div class="h2sub" id="histSub">Tes pesées et masse grasse saisies dans Suivi</div>
<div class="cw" id="histCw"></div>
<div class="legend"><span><span class="sw" style="border-color:var(--s1)"></span>poids</span><span><span class="sw" style="border-color:var(--s2)"></span>masse grasse</span><span><span class="sw" style="border-color:var(--s3)"></span>poids ajusté (glycogène)</span>${(seed.fiber||[]).length ? '<span><span class="sw" style="border-color:var(--s4)"></span>fibres (g/jour)</span>' : ''}</div>
<div id="waterBanner"></div>
</section>
<h2 style="margin:30px 0 2px">Prévisionnel</h2>
<p class="sub">À partir de ta dernière pesée : <strong>${W0.toFixed(2).replace('.',',')} kg · ${F0.toFixed(1).replace('.',',')} kg de masse grasse (${(F0/W0*100).toFixed(1).replace('.',',')} %)</strong>. ${PER.length === 0 ? `Toutes les périodes prévues sont désormais passées — il n'y a plus rien à projeter` : PER.length > 1 ? `${PER.length} périodes indépendantes — chacune a ses activités et son apport, et repart de l'état atteint à la fin de la précédente. Les périodes déjà écoulées ne sont plus affichées : le réel a pris le relais` : `Une seule période à venir, avec ses activités et son apport. Les périodes déjà écoulées ne sont plus affichées : le réel a pris le relais`}.</p>
<p class="ctl" style="margin:0 0 20px;flex-wrap:wrap">
<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="chkAdapt" checked> Thermogenèse adaptative (12 % du déficit)</label>
<span style="margin-left:20px">Je choisis <span class="seg" id="segMode" style="display:inline-flex;vertical-align:middle"></span></span></p>
<div id="sections"></div>
<p class="note"><strong>D'où vient la dépense.</strong> ${['formule', 'estimation', 'defaut'].includes(seed.baseSource) ? `Pour l'instant c'est une <strong>estimation</strong> (ton profil, puis tes premières mesures) : <strong>≈ ${BASE0} kcal/jour hors sport</strong> à ton poids actuel. Elle s'affine à mesure que tu logges repas et pesées (Profil → Dépense).` : `Elle n'est pas estimée par une formule mais mesurée : tes apports quotidiens confrontés à tes pesées depuis le J1 (${seed.j1Label || '—'}), par bilan énergétique. Résultat : <strong>≈ ${BASE0} kcal/jour hors sport</strong> à ton poids actuel`}, puis −12 kcal par kg perdu. L'option « thermogenèse adaptative » retire en plus 12 % du déficit tenu.</p>
${OWNER ? `<p class="note"><strong>Le coût des activités.</strong> Valeurs par défaut issues des séances réellement enregistrées (calories actives, nettes du repos) : vélo elliptique <strong>10,6 kcal/min</strong>, musculation <strong>3,6</strong>. Escrime : médiane de 15 soirées de 70 à 140 min = <strong>963 kcal nettes</strong>. Badminton : médiane 570 kcal pour 1h30. Tous les champs sont modifiables.</p>` : `<p class="note"><strong>Le coût des activités.</strong> Ajoute tes activités avec leur coût net par séance (les calories actives de ta montre) et leur fréquence par semaine. Tous les champs sont modifiables.</p>`}
<p class="note"><strong>Ce que le modèle ne fait pas.</strong> L'apport est constant sur chaque période : ni affûtage, ni journées de compétition, ni refill.${OWNER ? ' Les traits verticaux marquent les compétitions.' : ''} La répartition gras/muscle suit les mesures — ~98 % de graisse à 30 % de masse grasse — et se dégrade jusqu'à 60 % vers 15 %. Le modèle s'arrête à 12 %.</p>
</div>`;

  const moy = L => L.reduce((s,a)=>s+(+a.k||0)*(+a.j||0),0)/7;
  const fg = bf => Math.max(0.60, Math.min(0.98, 0.75+(bf-15)/15.8*0.23));

  function sim(K){
    let w=W0,f=F0,l=L0;
    return PER.map(P=>{
      const sp=moy(P.acts), C=[];
      const brut=ww=>BASE0-CW*(W0-ww)+sp;
      const dOf=ww=>{const bf=100*f/w; if(bf<=12) return 0;
        return mode==='def'?P.def:(brut(ww)-P.app)/(adapt?1+ADAPT:1);};
      const startT=Math.max(P.t0,TODAY);
      if(startT>=P.t1) return C; // periode deja passee : pas de projection (le reel suffit)
      let t=startT;
      const push=()=>{const d=dOf(w); C.push({t,w,f,kcal:Math.round(brut(w)-(adapt?ADAPT*d:0)-d)});};
      push();
      while(t<P.t1){
        const bf=100*f/w, d=dOf(w), dw=d/K, fr=fg(bf);
        f-=dw*fr; l-=dw*(1-fr); w=f+l; t+=DAY;
        if(P.daily) push();
        else {const dt=new Date(t); if(dt.getUTCDate()===1&&t>startT) push();}
      }
      if(C.length&&C[C.length-1].t!==P.t1){t=P.t1;push();}
      return C;
    });
  }
  const MO=['janv.','févr.','mars','avril','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  const fdate=t=>{const d=new Date(t);return d.getUTCDate()+' '+MO[d.getUTCMonth()]+' '+d.getUTCFullYear();};
  const fshort=t=>{const d=new Date(t);return d.getUTCDate()+' '+MO[d.getUTCMonth()];};
  const fmon=t=>{const d=new Date(t);return '1er '+MO[d.getUTCMonth()]+' '+(d.getUTCFullYear()===2027?'27':'26');};
  // dessin à la largeur réelle du cadre : sur mobile le graphique tient dans l'écran
  // (texte à taille lisible) au lieu de déborder à droite
  const geo=cwW=>{const W=Math.max(300,Math.min(940,Math.round(cwW||940))),n=W<600;
    return {W,PL:n?40:54,PR:n?80:104,PH:n?120:155,GAP:n?44:48};};
  // étiquettes de dates : on saute celles qui chevaucheraient la précédente
  const spaced=(ticks,X,minPx)=>{const out=[];let lx=-1e9;for(const t of ticks){const x=X(t);if(x-lx>=minPx){out.push(t);lx=x;}}return out;};
  // bulle : à droite du curseur, basculée à gauche près du bord, toujours dans la zone visible
  function placeTip(tip,px){const box=tip.parentElement,tw=tip.offsetWidth,sl=box.scrollLeft,bw=box.clientWidth;
    let left=px+14; if(left+tw>sl+bw-4) left=px-14-tw;
    tip.style.left=Math.max(sl+4,Math.min(left,sl+bw-tw-4))+'px'; tip.style.opacity=1;}

  function panel(id,C,LO,HI,daily,pT0,pT1,cwW){
    const {W,PL,PR,PH,GAP}=geo(cwW),PT=34,PB=32;
    const t0=pT0,t1=pT1;
    const X=t=>PL+(t1===t0?0:(t-t0)/(t1-t0)*(W-PL-PR));
    const S=[];
    const SER=[['Poids','w','var(--s1)',2,'kg'],['Masse grasse','f','var(--s2)',1,'kg'],['Apport','kcal','var(--s3)',0,'kcal']];
    let ticks=[];
    if(daily){ const n=Math.max(1,Math.round((t1-t0)/DAY/8));
      for(let t=t0;t<=t1;t+=DAY){const d=new Date(t); if(d.getUTCDate()===1||t===t0||t===t1||(n>=2&&(d.getUTCDate()===15||(n<=3&&d.getUTCDate()%10===0)))) ticks.push(t);} }
    else { ticks=C.map(p=>p.t).filter((_,i)=>i%2===0); if(ticks[ticks.length-1]!==t1) ticks.push(t1); }
    const yy=[];
    SER.forEach((se,pi)=>{
      const key=se[1],top=PT+pi*(PH+GAP);
      const vs=C.map(p=>p[key]);
      const mvals=(key==='w'||key==='f')?MEAS.filter(m=>m.t>=t0&&m.t<=t1&&m[key]!=null).map(m=>m[key]):[];
      const lo0=Math.min(...LO.map(p=>p[key]),...vs,...mvals), hi0=Math.max(...HI.map(p=>p[key]),...vs,...mvals);
      const m=(hi0-lo0)*0.20||(se[3]===0?60:0.5), lo=lo0-m, hi=hi0+m;
      const Y=v=>top+PH-(v-lo)/(hi-lo)*PH; yy.push(Y);
      S.push(`<text x="${PL}" y="${top-8}" class="pt">${se[0]}<tspan class="pu"> — ${se[4]}</tspan></text>`);
      const step=se[3]===0?((hi-lo)>600?200:((hi-lo)>300?100:50)):((hi-lo)>9?4:((hi-lo)>4.5?2:((hi-lo)>2.2?1:0.5)));
      for(let v=Math.ceil(lo/step)*step;v<hi;v+=step){
        S.push(`<line x1="${PL}" x2="${W-PR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="gr"/>`);
        S.push(`<text x="${PL-8}" y="${(Y(v)+4).toFixed(1)}" class="tk" text-anchor="end">${(+v.toFixed(1)).toString().replace('.',',')}</text>`);
      }
      ticks.forEach(t=>S.push(`<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${top}" y2="${top+PH}" class="grv"/>`));
      if(pi===1){ [20,15].forEach(p=>{ const vv=C.map(c=>c.f/c.w*100), idx=vv.findIndex(x=>x<=p);
          if(idx>0){ const v=C[idx].f; if(v>lo&&v<hi){
            S.push(`<line x1="${PL}" x2="${W-PR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="ref"/>`);
            S.push(`<text x="${W-PR-4}" y="${(Y(v)-4).toFixed(1)}" class="reftx" text-anchor="end">${p} % de masse grasse</text>`);}}});}
      S.push(`<polygon points="${HI.map(p=>`${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ')} ${LO.slice().reverse().map(p=>`${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ')}" fill="var(--band)" stroke="none"/>`);
      S.push(`<polyline points="${C.map(p=>`${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ')}" fill="none" stroke="${se[2]}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`);
      if(key==='w'||key==='f'){ const mp=MEAS.filter(m=>m[key]!=null&&m.t>=t0&&m.t<=Math.min(t1,TODAY)).sort((a,b)=>a.t-b.t); if(mp.length>1) S.push(`<polyline points="${mp.map(m=>`${X(m.t).toFixed(1)},${Y(m[key]).toFixed(1)}`).join(' ')}" fill="none" stroke="${se[2]}" stroke-width="2" opacity="0.85" stroke-linecap="round" stroke-linejoin="round"/>`); }
      if(key==='w'||key==='f') MEAS.forEach(m=>{ const v=m[key]; if(v==null||m.t<t0||m.t>t1) return; S.push(`<circle cx="${X(m.t).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3" fill="${se[2]}" stroke="var(--surface-1)" stroke-width="1.6"/>`); });
      if(!daily) C.forEach(p=>S.push(`<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p[key]).toFixed(1)}" r="3.1" fill="${se[2]}"/>`));
      COMP.forEach(([t,lab])=>{ if(t>=t0&&t<=t1){
        S.push(`<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${top}" y2="${top+PH}" class="${lab==='TOULOUSE'?'obj':'cmp'}"/>`);
        if(pi===0&&lab){const k=COMP.findIndex(c=>c[0]===t);
          S.push(`<text x="${X(t).toFixed(1)}" y="${top-(k%2?26:15)}" class="cmptx" text-anchor="middle">${lab}</text>`);}}});
      if(C.length){
      const last=C[C.length-1][key], first=C[0][key];
      const fm=v=>se[3]===2?v.toFixed(2).replace('.',','):(se[3]===0?Math.round(v).toString():v.toFixed(1).replace('.',','));
      S.push(`<circle cx="${X(t1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="4.4" fill="${se[2]}" stroke="var(--surface-1)" stroke-width="2"/>`);
      S.push(`<text x="${W-PR+11}" y="${(Y(last)+2).toFixed(1)}" class="dl">${fm(last)}<tspan class="pu"> ${se[4]}</tspan></text>`);
      S.push(`<text x="${W-PR+11}" y="${(Y(last)+19).toFixed(1)}" class="dl0">${last-first>=0?'+':'−'}${se[3]===0?Math.round(Math.abs(last-first)):Math.abs(last-first).toFixed(2).replace('.',',')} ${se[4]}</text>`);
      S.push(`<text x="${PL+4}" y="${(Y(first)-10).toFixed(1)}" class="dl0">${fm(first)}</text>`);
      }
    });
    const yb=PT+3*(PH+GAP)-GAP;
    spaced(ticks,X,daily?46:62).forEach(t=>S.push(`<text x="${X(t).toFixed(1)}" y="${yb+18}" class="tk" text-anchor="middle">${daily?fshort(t):fmon(t)}</text>`));
    S.push(`<line class="crs" id="${id}crs" x1="0" x2="0" y1="${PT-12}" y2="${yb}" style="opacity:0"/>`);
    for(let i=0;i<3;i++) S.push(`<circle id="${id}h${i}" r="5" fill="var(--s${i+1})" stroke="var(--surface-1)" stroke-width="2" style="opacity:0"/>`);
    S.push(`<rect id="${id}hit" x="${PL}" y="${PT-12}" width="${W-PL-PR}" height="${yb-PT+12}" fill="transparent"/>`);
    return {svg:`<svg id="svg${id}" viewBox="0 0 ${W} ${yb+PB}" width="100%">${S.join('')}</svg>`,X,yy,W};
  }

  function actsUI(L){
    const rows=L.map((a,i)=>`<div class="ar">
      <input class="nm" data-i="${i}" data-f="n" value="${(a.n||'').replace(/"/g,'&quot;')}" placeholder="nom de l'activité">
      <input class="nb" data-i="${i}" data-f="k" type="number" step="10" min="0" value="${a.k}"><span class="u">kcal</span>
      <input class="nb" data-i="${i}" data-f="j" type="number" step="1" min="0" max="7" value="${a.j}"><span class="u">j/sem.</span>
      <button class="del" type="button" data-i="${i}" title="supprimer">×</button></div>`).join('');
    return `<div class="ah"><span>Activités — coût net par séance</span><span>fréquence</span></div>${rows}
      <div class="af"><button class="add" type="button">+ ajouter une activité</button>
      <span class="tot">moyenne quotidienne <b>${Math.round(moy(L))}</b> kcal/jour</span></div>`;
  }
  function segHTML(opts,val){return opts.map(o=>`<button type="button" aria-pressed="${o[0]===val}" data-v="${o[0]}" style="min-width:auto;padding:5px 10px">${o[1]}</button>`).join('');}

  function render(){
    const cur=sim(KC), lo=sim(KHI), hi=sim(KLO);
    document.getElementById('segMode').innerHTML=segHTML([['def','mon déficit'],['app','mon apport']],mode);
    const host=document.getElementById('sections'); host.innerHTML='';
    PER.forEach((P,pi)=>{
      const C=cur[pi],a=C[0]||{w:W0,f:F0,kcal:0,t:P.t0},b=C[C.length-1]||a,sp=moy(P.acts);
      const base=Math.round(BASE0-CW*(W0-a.w));
      const def=Math.round(mode==='def'?P.def:(base+sp-a.kcal)/(adapt?1+ADAPT:1));
      const ad=adapt?Math.round(ADAPT*def):0;
      const bf=100*b.f/b.w, imc=b.w/3.24;
      const O=mode==='def'?OPTS:OPTSA, val=mode==='def'?P.def:P.app;
      const sec=document.createElement('section');
      sec.innerHTML=`
       <div class="shead">
        <div><h2>${P.titre}</h2><div class="h2sub">${P.note} · ${Math.round(sp)} kcal/jour de sport en moyenne</div></div>
        <div class="ctl">${mode==='def'?'Déficit':'Apport'} <div class="seg" data-seg="${pi}">${
          O.map(o=>`<button type="button" aria-pressed="${o===val}" data-v="${o}">${o}</button>`).join('')}</div> kcal/jour</div>
       </div>
       <div class="acts" data-acts="${pi}">${actsUI(P.acts)}</div>
       <p class="hyp"><b>Hypothèse :</b> base mesurée <b>${base}</b> kcal/j ${sp?`+ sport <b>${Math.round(sp)}</b> kcal/j en moyenne `:'<b>sans aucune activité</b> '}${ad?`− adaptation <b>${ad}</b> `:''}= dépense <b>${Math.round(base+sp-ad)}</b> kcal/j.
         Apport <b>${a.kcal}</b> kcal → déficit réel <b>${def}</b> kcal/jour.${sp?` Une journée <em>sans</em> activité, la dépense tombe à <b>${base-ad}</b> et ce même apport ne donne plus que <b>${Math.round(base-ad-a.kcal)}</b> de déficit.`:''}</p>
       <div class="kpis">
        <div class="kpi"><div class="lab"><span class="dot" style="background:var(--s1)"></span>Au ${P.daily?fdate(b.t):fmon(b.t)}</div>
         <div class="val">${b.w.toFixed(1).replace('.',',')}<small> kg</small></div><div class="d">${(b.w-a.w).toFixed(2).replace('.',',')} kg sur la période</div></div>
        <div class="kpi"><div class="lab"><span class="dot" style="background:var(--s2)"></span>Masse grasse</div>
         <div class="val">${b.f.toFixed(1).replace('.',',')}<small> kg</small></div><div class="d">${(b.f-a.f).toFixed(2).replace('.',',')} kg</div></div>
        <div class="kpi"><div class="lab">Taux de graisse</div>
         <div class="val">${bf.toFixed(1).replace('.',',')}<small> %</small>${bf<15?' <span class="warn">⚠︎</span>':''}</div><div class="d">${(bf-100*a.f/a.w).toFixed(1).replace('.',',')} pt</div></div>
        <div class="kpi"><div class="lab">IMC</div><div class="val">${imc.toFixed(1).replace('.',',')}</div>
         <div class="d">${imc<25?'poids normal':(imc<30?'surpoids':'obésité')}</div></div>
       </div>
       <div class="legend"><span><span class="sw" style="border-color:var(--s1)"></span>poids</span>
        <span><span class="sw" style="border-color:var(--s2)"></span>masse grasse</span>
        <span><span class="sw" style="border-color:var(--s3)"></span>apport</span>
        <span><span class="swb"></span>incertitude (6 950 – 7 600 kcal/kg)</span>
        <span><span style="width:9px;height:9px;border-radius:50%;background:var(--text-secondary);border:2px solid var(--surface-1);display:inline-block"></span>tes pesées réelles</span>
        ${P.daily && OWNER?'<span style="opacity:.75">┊ compétitions</span>':''}</div>
       <div class="cw"></div>
       <details><summary>Voir le détail</summary><div class="tbl"></div></details>`;
      host.appendChild(sec);
      const cw=sec.querySelector('.cw');
      const PP=panel(P.id,C,lo[pi],hi[pi],P.daily,P.t0,P.t1,cw.clientWidth);
      cw.innerHTML=PP.svg+`<div class="tip" id="tip${P.id}"></div>`;
      sec.querySelector('.tbl').innerHTML=`<table><thead><tr><th>Date</th><th>Poids</th><th>Gras kg</th><th>Gras %</th><th>IMC</th><th>Apport</th></tr></thead><tbody>${
        C.map(p=>`<tr><td>${P.daily?fdate(p.t):fmon(p.t)}</td><td>${p.w.toFixed(2).replace('.',',')}</td><td>${p.f.toFixed(1).replace('.',',')}</td><td>${(100*p.f/p.w).toFixed(1).replace('.',',')}</td><td>${(p.w/3.24).toFixed(1).replace('.',',')}</td><td>${p.kcal}</td></tr>`).join('')}</tbody></table>`;
      hover(P.id,C,PP,P.t0,P.t1);
      sec.querySelector('[data-seg]').onclick=e=>{const b2=e.target.closest('button'); if(!b2)return;
        if(mode==='def')P.def=+b2.dataset.v; else P.app=+b2.dataset.v; render(); saveState();};
      const ae=sec.querySelector('[data-acts]');
      ae.onchange=e=>{const t=e.target; if(!t.dataset||t.dataset.i===undefined)return;
        const i=+t.dataset.i,f=t.dataset.f; P.acts[i][f]=f==='n'?t.value:Math.max(0,+t.value||0); render(); saveState();};
      ae.onclick=e=>{const d=e.target.closest('.del'); if(d){P.acts.splice(+d.dataset.i,1);render();saveState();return;}
        if(e.target.closest('.add')){P.acts.push({n:'Nouvelle activité',k:400,j:1});render();saveState();}};
    });
    document.getElementById('segMode').onclick=e=>{const b=e.target.closest('button'); if(!b)return; mode=b.dataset.v; render(); saveState();};
  }
  function hover(id,C,P,t0,t1){
    const svg=document.getElementById('svg'+id), tip=document.getElementById('tip'+id);
    const hit=document.getElementById(id+'hit'),crs=document.getElementById(id+'crs');
    const h=[0,1,2].map(i=>document.getElementById(id+'h'+i));
    if(!hit) return;
    // survolables : pesées réelles avant aujourd'hui (à gauche) + projection (à droite)
    const mHist=MEAS.filter(m=>m.w!=null&&m.t>=t0&&m.t<TODAY).map(m=>({t:m.t,meas:m}));
    const ALL=mHist.concat(C.map(p=>({t:p.t,proj:p}))).sort((a,b)=>a.t-b.t);
    if(!ALL.length) return;
    const move=e=>{const r=svg.getBoundingClientRect(),sx=(e.clientX-r.left)*P.W/r.width;
      let best=ALL[0]; for(const p of ALL) if(Math.abs(P.X(p.t)-sx)<Math.abs(P.X(best.t)-sx)) best=p;
      const x=P.X(best.t); crs.setAttribute('x1',x); crs.setAttribute('x2',x); crs.style.opacity=1;
      if(best.meas){ const m=best.meas;
        [m.w,m.f].forEach((v,i)=>{ if(v==null){h[i].style.opacity=0;return;} h[i].setAttribute('cx',x);h[i].setAttribute('cy',P.yy[i](v));h[i].style.opacity=1;});
        h[2].style.opacity=0;
        tip.innerHTML=`<b>${fdate(m.t)} — mesuré</b>`
          +`<div><span><i style="background:var(--s1)"></i>Poids réel</span><span>${m.w.toFixed(2).replace('.',',')} kg</span></div>`
          +(m.f!=null?`<div><span><i style="background:var(--s2)"></i>MG réelle</span><span>${m.f.toFixed(1).replace('.',',')} kg</span></div><div><span>Taux de graisse</span><span>${(100*m.f/m.w).toFixed(1).replace('.',',')} %</span></div>`:'');
      } else { const b=best.proj;
        [b.w,b.f,b.kcal].forEach((v,i)=>{h[i].setAttribute('cx',x);h[i].setAttribute('cy',P.yy[i](v));h[i].style.opacity=1;});
        let mReal='';
        { let md=null,mdist=1.5*86400000; for(const mm of MEAS){const dd=Math.abs(mm.t-b.t); if(dd<mdist){mdist=dd; md=mm;}}
          if(md&&md.w!=null){ mReal=`<div style="border-top:1px solid var(--line);margin:5px 0 0;padding-top:5px;color:var(--text-secondary)">↓ ta mesure réelle (${fdate(md.t)})</div>`
            +`<div><span><i style="background:var(--s1)"></i>Poids réel</span><span>${md.w.toFixed(2).replace('.',',')} kg</span></div>`
            +(md.f!=null?`<div><span><i style="background:var(--s2)"></i>MG réelle</span><span>${md.f.toFixed(1).replace('.',',')} kg (${(100*md.f/md.w).toFixed(1).replace('.',',')} %)</span></div>`:''); } }
        tip.innerHTML=`<b>${fdate(b.t)} — projeté</b>
          <div><span><i style="background:var(--s1)"></i>Poids</span><span>${b.w.toFixed(2).replace('.',',')} kg</span></div>
          <div><span><i style="background:var(--s2)"></i>Masse grasse</span><span>${b.f.toFixed(1).replace('.',',')} kg</span></div>
          <div><span>Taux de graisse</span><span>${(100*b.f/b.w).toFixed(1).replace('.',',')} %</span></div>
          <div><span><i style="background:var(--s3)"></i>Apport</span><span>${b.kcal} kcal</span></div>`+mReal;
      }
      placeTip(tip,x*r.width/P.W);};
    hit.addEventListener('mousemove',move);
    hit.addEventListener('mouseleave',()=>{tip.style.opacity=0;crs.style.opacity=0;h.forEach(c=>c.style.opacity=0);});
    hit.addEventListener('touchstart',e=>move(e.touches[0]));
    hit.addEventListener('touchmove',e=>{move(e.touches[0]);e.preventDefault();},{passive:false});
  }

  function histPanel(id,C,cwW,FI,fiT){
    const {W,PL,PR,PH,GAP}=geo(cwW),PT=34,PB=32;
    FI=FI||[];
    const ts=C.map(p=>p.t).concat(FI.map(p=>p.t));
    const t0=Math.min(...ts),t1=Math.max(...ts);
    const X=t=>PL+(t1===t0?0:(t-t0)/(t1-t0)*(W-PL-PR));
    const S=[];
    const SER=[['Poids','w','var(--s1)','kg',C],['Masse grasse','f','var(--s2)','kg',C]];
    if(FI.length) SER.push(['Fibres','fi','var(--s4)','g/jour',FI]);
    const n=Math.max(1,Math.round((t1-t0)/DAY/8)); let ticks=[];
    for(let t=t0;t<=t1;t+=DAY){const d=new Date(t); if(d.getUTCDate()===1||t===t0||t===t1||(n>=2&&(d.getUTCDate()===15||(n<=3&&d.getUTCDate()%10===0)))) ticks.push(t);}
    const yy=[];
    SER.forEach((se,pi)=>{
      const key=se[1],D=se[4],isFi=key==='fi',top=PT+pi*(PH+GAP);
      const vals=D.map(p=>p[key]).concat(key==='w'?C.map(p=>p.adj):[]).filter(v=>v!=null);
      if(!vals.length){yy.push(()=>top+PH); return;}
      const lo0=Math.min(...vals),hi0=Math.max(...vals);
      let lo,hi;
      if(isFi){ lo=0; hi=(Math.max(hi0,fiT||0)*1.15)||10; }
      else { const m=(hi0-lo0)*0.25||0.5; lo=lo0-m; hi=hi0+m; }
      const Y=v=>top+PH-(v-lo)/(hi-lo)*PH; yy.push(Y);
      S.push(`<text x="${PL}" y="${top-8}" class="pt">${se[0]}<tspan class="pu"> — ${se[3]}</tspan></text>`);
      const step=isFi?((hi-lo)>45?10:5):((hi-lo)>9?4:((hi-lo)>4.5?2:((hi-lo)>2.2?1:0.5)));
      for(let v=Math.ceil(lo/step)*step;v<hi;v+=step){
        S.push(`<line x1="${PL}" x2="${W-PR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="gr"/>`);
        S.push(`<text x="${PL-8}" y="${(Y(v)+4).toFixed(1)}" class="tk" text-anchor="end">${(+v.toFixed(1)).toString().replace('.',',')}</text>`);
      }
      ticks.forEach(t=>S.push(`<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${top}" y2="${top+PH}" class="grv"/>`));
      if(isFi&&fiT){
        S.push(`<line x1="${PL}" x2="${W-PR}" y1="${Y(fiT).toFixed(1)}" y2="${Y(fiT).toFixed(1)}" class="ref"/>`);
        S.push(`<text x="${PL+4}" y="${(Y(fiT)-4).toFixed(1)}" class="reftx" text-anchor="start">objectif ${fiT} g</text>`);
      }
      const pres=D.filter(p=>p[key]!=null);
      const pline=pres.map(p=>`${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ');
      S.push(`<polyline points="${pline}" fill="none" stroke="${se[2]}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
      if(key==='w'){ const al=C.filter(p=>p.adj!=null).map(p=>`${X(p.t).toFixed(1)},${Y(p.adj).toFixed(1)}`).join(' '); if(al) S.push(`<polyline points="${al}" fill="none" stroke="var(--s3)" stroke-width="2" stroke-dasharray="4 3" stroke-linecap="round"/>`); }
      pres.forEach(p=>S.push(`<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p[key]).toFixed(1)}" r="2.6" fill="${se[2]}"/>`));
      const last=pres[pres.length-1],first=pres[0];
      const fm=v=>isFi?Math.round(v).toString():v.toFixed(1).replace('.',',');
      const unit=isFi?'g':se[3];
      S.push(`<circle cx="${X(last.t).toFixed(1)}" cy="${Y(last[key]).toFixed(1)}" r="4.2" fill="${se[2]}" stroke="var(--surface-1)" stroke-width="2"/>`);
      S.push(`<text x="${W-PR+11}" y="${(Y(last[key])+2).toFixed(1)}" class="dl">${fm(last[key])}<tspan class="pu"> ${unit}</tspan></text>`);
      if(isFi){ const avg=pres.reduce((s,p)=>s+p.fi,0)/pres.length;
        S.push(`<text x="${W-PR+11}" y="${(Y(last[key])+19).toFixed(1)}" class="dl0">moy. ${Math.round(avg)} g</text>`); }
      else {
        S.push(`<text x="${W-PR+11}" y="${(Y(last[key])+19).toFixed(1)}" class="dl0">${last[key]-first[key]>=0?'+':'−'}${Math.abs(last[key]-first[key]).toFixed(2).replace('.',',')} ${se[3]}</text>`);
        S.push(`<text x="${PL+4}" y="${(Y(first[key])-10).toFixed(1)}" class="dl0">${fm(first[key])}</text>`);
      }
    });
    const yb=PT+SER.length*(PH+GAP)-GAP;
    spaced(ticks,X,46).forEach(t=>S.push(`<text x="${X(t).toFixed(1)}" y="${yb+18}" class="tk" text-anchor="middle">${fshort(t)}</text>`));
    S.push(`<line class="crs" id="${id}crs" x1="0" x2="0" y1="${PT-12}" y2="${yb}" style="opacity:0"/>`);
    SER.forEach((se,i)=>S.push(`<circle id="${id}h${i}" r="5" fill="${se[2]}" stroke="var(--surface-1)" stroke-width="2" style="opacity:0"/>`));
    S.push(`<rect id="${id}hit" x="${PL}" y="${PT-12}" width="${W-PL-PR}" height="${yb-PT+12}" fill="transparent"/>`);
    return {svg:`<svg id="svg${id}" viewBox="0 0 ${W} ${yb+PB}" width="100%">${S.join('')}</svg>`,X,yy,W,keys:SER.map(s=>s[1])};
  }
  function histHover(id,C,P,FI){
    const svg=document.getElementById('svg'+id), tip=document.getElementById('tip'+id);
    const hit=document.getElementById(id+'hit'),crs=document.getElementById(id+'crs');
    const h=P.keys.map((_,i)=>document.getElementById(id+'h'+i));
    if(!hit) return;
    // une entrée par date : pesée (poids, MG) et/ou fibres du jour
    const byT=new Map();
    C.forEach(p=>byT.set(p.t,{...(byT.get(p.t)||{}),t:p.t,w:p.w,f:p.f}));
    (FI||[]).forEach(p=>byT.set(p.t,{...(byT.get(p.t)||{}),t:p.t,fi:p.fi}));
    const R=[...byT.values()].sort((a,b)=>a.t-b.t);
    if(!R.length) return;
    const move=e=>{const r=svg.getBoundingClientRect(),sx=(e.clientX-r.left)*P.W/r.width;
      let best=R[0]; for(const p of R) if(Math.abs(P.X(p.t)-sx)<Math.abs(P.X(best.t)-sx)) best=p;
      const x=P.X(best.t); crs.setAttribute('x1',x); crs.setAttribute('x2',x); crs.style.opacity=1;
      P.keys.forEach((k,i)=>{ const v=best[k]; if(v==null){h[i].style.opacity=0;return;} h[i].setAttribute('cx',x);h[i].setAttribute('cy',P.yy[i](v));h[i].style.opacity=1;});
      let html=`<b>${fdate(best.t)}</b>`;
      if(best.w!=null) html+=`<div><span><i style="background:var(--s1)"></i>Poids</span><span>${best.w.toFixed(2).replace('.',',')} kg</span></div>`;
      if(best.w!=null&&best.f!=null) html+=`<div><span><i style="background:var(--s2)"></i>Masse grasse</span><span>${best.f.toFixed(1).replace('.',',')} kg</span></div><div><span>Taux de graisse</span><span>${(100*best.f/best.w).toFixed(1).replace('.',',')} %</span></div>`;
      if(best.fi!=null) html+=`<div><span><i style="background:var(--s4)"></i>Fibres</span><span>${best.fi.toFixed(1).replace('.',',')} g</span></div>`;
      tip.innerHTML=html;
      placeTip(tip,x*r.width/P.W);};
    hit.addEventListener('mousemove',move);
    hit.addEventListener('mouseleave',()=>{tip.style.opacity=0;crs.style.opacity=0;h.forEach(c=>c.style.opacity=0);});
    hit.addEventListener('touchstart',e=>move(e.touches[0]));
    hit.addEventListener('touchmove',e=>{move(e.touches[0]);e.preventDefault();},{passive:false});
  }

  { const rec = seed.reconciliation || []; const rt = document.getElementById('reconTbl'); const rs = document.getElementById('reconSec');
    if (!rec.length) { if (rs) rs.style.display = 'none'; }
    else if (rt) {
      rt.innerHTML = `<table><thead><tr><th>Mois</th><th>Jours</th><th>Déficit moy/j</th><th>Perte attendue</th><th>Perte réelle</th><th>Écart</th></tr></thead><tbody>`
        + rec.map(m => { const gap = (m.actualKg != null) ? +(m.actualKg - m.expectedKg).toFixed(2) : null;
            const col = gap == null ? 'var(--text-muted)' : (Math.abs(gap) < 0.4 ? 'var(--text-secondary)' : (gap > 0 ? '#2e9e5b' : 'var(--s2)'));
            return `<tr><td>${m.label}</td><td>${m.days}</td><td>${m.avgDef} kcal</td><td>−${m.expectedKg.toFixed(2).replace('.',',')} kg</td><td>${m.actualKg != null ? '−' + m.actualKg.toFixed(2).replace('.',',') + ' kg' : '—'}</td><td style="color:${col};font-weight:600">${gap != null ? (gap > 0 ? '+' : '−') + Math.abs(gap).toFixed(2).replace('.',',') + ' kg' : '—'}</td></tr>`;
          }).join('') + `</tbody></table>`
        + `<p class="note" style="margin-top:10px">« Perte attendue » = déficit cumulé du mois ÷ 7700 kcal/kg. Écart <b style="color:#2e9e5b">vert</b> = tu perds <b>plus</b> que prévu (déficit sous-estimé, ou eau qui part). Écart <b style="color:var(--s2)">orange</b> = tu perds <b>moins</b> (tu sous-estimes ce que tu manges, ou tu retiens de l'eau ce mois-là). Proche de 0 = tes calculs collent.</p>`;
    } }

  function renderHist() {
    const hc = document.getElementById('histCw');
    const HP = histPanel('H', seed.history, hc.clientWidth, seed.fiber, seed.fiberTarget);
    hc.innerHTML = HP.svg + `<div class="tip" id="tipH"></div>`;
    histHover('H', seed.history, HP, seed.fiber);
  }
  const hasHist = seed.history && seed.history.length >= 2;
  if (hasHist) {
    renderHist();
    const hsub = document.getElementById('histSub');
    if (hsub) hsub.textContent = `Tes pesées et masse grasse saisies dans Suivi · ${fshort(seed.history[0].t)} → ${fdate(seed.history[seed.history.length-1].t)}`;
    const wb = document.getElementById('waterBanner');
    if (wb) wb.innerHTML = seed.waterBanner ? `<div class="water-banner">💧 ${seed.waterBanner}</div>` : '';
  } else {
    const hs = document.getElementById('histSec'); if (hs) hs.style.display = 'none';
  }

  root.querySelector('#chkAdapt').addEventListener('change',e=>{adapt=e.target.checked;render();saveState();});
  render();

  // largeur changée (rotation, fenêtre) : on redessine à la nouvelle taille
  let lastW = root.clientWidth, rT = 0;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    clearTimeout(rT);
    rT = setTimeout(() => { const w = root.clientWidth; if (Math.abs(w - lastW) < 30) return; lastW = w; render(); if (hasHist) renderHist(); }, 150);
  }) : null;
  if (ro) ro.observe(root);
  return () => { clearTimeout(rT); if (ro) ro.disconnect(); };
}
