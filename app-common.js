// ============================================================
// app-common.js — zdieľaná logika pre index.html a history.html
// ============================================================

const NEW_METHOD_CUTOFF = '2026-06-07'; // zmena meracej metódy/senzora HRV a spánkovej TF

// Od 9.7.2026 hodinky niekedy pri ďalšom auto-syncu (každých 10 min) prepíšu ráno ručne zadanú
// nočnú HRV (rMSSD) nepresnou dopočítanou hodnotou. Adam preto od tohto dátumu zapisuje presný
// priemer HRV počas spánku manuálne do poľa SDNN namiesto rMSSD. Staršie dni (do 8.7.2026 vrátane)
// zostávajú tak, ako boli - tam je referenčná hodnota v poli rMSSD (hrv).
const HRV_SDNN_MANUAL_CUTOFF = '2026-07-09';
// Keďže sa pri tomto dátume mení aj číselná škála (SDNN a rMSSD nie sú priamo porovnateľné),
// rolling baseline pre HRV sa musí resetovať aj na tejto hranici (podobne ako pri NEW_METHOD_CUTOFF).
const HRV_BASELINE_BOUNDARY = HRV_SDNN_MANUAL_CUTOFF > NEW_METHOD_CUTOFF ? HRV_SDNN_MANUAL_CUTOFF : NEW_METHOD_CUTOFF;
// Vráti HRV hodnotu, ktorá sa má reálne použiť vo výpočtoch/zobrazení pre daný deň:
// - od HRV_SDNN_MANUAL_CUTOFF: pole hrvSDNN (manuálne zadaný presný priemer), s fallbackom na
//   rMSSD (hrv) ak by SDNN pre daný deň chýbalo (napr. zabudnuté dopísať).
// - pred cutoffom: pôvodné pole hrv (rMSSD), tak ako doteraz.
function effectiveHrv(r){
  if(r.date >= HRV_SDNN_MANUAL_CUTOFF){
    return (r.hrvSDNN!=null ? r.hrvSDNN : r.hrv);
  }
  return r.hrv;
}

const HISTORY_URL = 'data/wellness_history.json';
const DAILY_URL = 'data/wellness_daily.json';
const SYNC_URL = 'data/last_sync.json';
const ACT_HISTORY_URL = 'data/activities_history.json';
const ACT_DAILY_URL = 'data/activities_daily.json';

// ---------- Zápis do Intervals.icu z prehliadača ----------
// /api/v1/ endpointy Intervals.icu podporujú CORS (na rozdiel od starších /api/ bez v1), takže
// sa dá zapisovať priamo z tejto (statickej, GitHub Pages) stránky - bez vlastného backendu.
// API key sa NIKDY neukladá do repozitára - zadáva sa raz v prehliadači a ostáva len v localStorage
// tohto zariadenia (rovnaký princíp ako GitHub token pri tlačidle "Aktualizovať").
function getIcuApiKey(){ return localStorage.getItem('icu_api_key') || ''; }
function setIcuApiKey(k){ localStorage.setItem('icu_api_key', k); }
function icuAuthHeader(){
  return 'Basic ' + btoa('API_KEY:' + getIcuApiKey());
}
async function icuRequest(path, method, body){
  const key = getIcuApiKey();
  if(!key) throw new Error('Chýba Intervals.icu API key (tlačidlo "Intervals kľúč").');
  const res = await fetch(`https://intervals.icu/api/v1${path}`, {
    method,
    headers: { 'Authorization': icuAuthHeader(), 'Content-Type': 'application/json' },
    body: body!=null ? JSON.stringify(body) : undefined,
  });
  if(!res.ok){
    const txt = await res.text().catch(()=> '');
    throw new Error(`Intervals.icu API ${res.status}: ${txt.slice(0,200) || res.statusText}`);
  }
  if(res.status===204) return null;
  return res.json().catch(()=>null);
}
// athlete/0 = "prihlásený athlete podľa API key" - nemusíme poznať/posielať skutočné ID.
function icuGetWellness(date){ return icuRequest(`/athlete/0/wellness/${date}`, 'GET'); }
// Nie je isté, či Intervals.icu PUT robí čiastočný merge alebo prepíše celý záznam - preto si
// najprv vždy vytiahneme existujúci záznam pre daný deň a odošleme ho SPOJENÝ s novými hodnotami.
// Takto sa nič, čo si tam mal predtým zapísané (napr. komentár, nálada), nikdy neprepíše na prázdno
// len preto, že si teraz vyplnil iné pole.
async function icuPutWellness(date, payload){
  let existing = null;
  try{ existing = await icuGetWellness(date); }catch(e){ /* pre daný deň zatiaľ nič neexistuje - OK */ }
  const merged = Object.assign({}, existing || {}, payload);
  delete merged.id; // id sa posiela cez URL, nie v tele
  return icuRequest(`/athlete/0/wellness/${date}`, 'PUT', merged);
}
function icuUpdateActivity(id, payload){ return icuRequest(`/activity/${id}`, 'PUT', payload); }
function icuDeleteActivity(id){ return icuRequest(`/activity/${id}`, 'DELETE'); }

// ---------- Priemer poľa cez pole záznamov (ignoruje null/undefined) ----------
function meanOf(arr, field){
  const vals = arr.map(r=>r[field]).filter(v=>v!=null && !isNaN(v));
  if(!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}

// ---------- Týždenný súhrn (zoskupenie podľa týždňa, pondelok = začiatok) ----------
function mondayOf(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  const day = d.getDay(); // 0=Ne,1=Po,...
  const diff = (day===0 ? -6 : 1-day);
  d.setDate(d.getDate()+diff);
  return d.toISOString().slice(0,10);
}
function addDaysStr(dateStr, days){
  const d = new Date(dateStr+'T00:00:00');
  d.setDate(d.getDate()+days);
  return d.toISOString().slice(0,10);
}
function fmtHM(totalSeconds){
  if(!totalSeconds) return '0 min';
  const h = Math.floor(totalSeconds/3600);
  const m = Math.round((totalSeconds%3600)/60);
  return h>0 ? (h+' h'+(m>0?' '+m+' min':'')) : (m+' min');
}
function activityBucket(type){
  const t = type || '';
  if(BIKE_ACTIVITY_TYPE_RE.test(t)) return 'Bicykel';
  if(t==='Run' || t==='TrailRun' || t==='VirtualRun') return 'Beh';
  if(t==='Walk' || t==='Hike' || t==='Snowshoe') return 'Chôdza/Hike';
  return 'Ostatné';
}
function renderWeeklySummary(containerId, results, activities){
  const el = document.getElementById(containerId);
  if(!el) return;
  const weekMap = new Map(); // pondelok (YYYY-MM-DD) -> {days:[], acts:[]}
  results.forEach(r=>{
    const wk = mondayOf(r.date);
    if(!weekMap.has(wk)) weekMap.set(wk, {days:[], acts:[]});
    weekMap.get(wk).days.push(r);
  });
  activities.forEach(a=>{
    const date = a.date || (a.start_date_local||'').slice(0,10);
    if(!date) return;
    const wk = mondayOf(date);
    if(!weekMap.has(wk)) weekMap.set(wk, {days:[], acts:[]});
    weekMap.get(wk).acts.push(a);
  });
  const weeks = [...weekMap.keys()].sort().reverse();
  el.innerHTML = weeks.map(wk=>{
    const {days, acts} = weekMap.get(wk);
    const wkEnd = addDaysStr(wk, 6);
    const timeByBucket = {};
    acts.forEach(a=>{ const b = activityBucket(a.type); timeByBucket[b] = (timeByBucket[b]||0) + (a.moving_time||0); });
    const totalLoad = acts.reduce((s,a)=>s+(a.icu_training_load||0),0);
    const avgRecovery = meanOf(days,'recovery');
    const avgStrain = meanOf(days,'strain');
    const avgHrv = meanOf(days,'hrv');
    const avgRhr = meanOf(days,'restingHR');
    const avgSleepHr = meanOf(days,'avgSleepingHR');
    const totalSteps = days.reduce((s,d)=>s+(d.steps||0),0);
    const avgMood = meanOf(days,'mood');
    const avgSoreness = meanOf(days,'soreness');
    const avgFatiguePerceived = meanOf(days,'fatigue');
    const avgStress = meanOf(days,'stress');
    const bucketsHtml = Object.keys(timeByBucket).length
      ? Object.entries(timeByBucket).map(([b,s])=>`<span class="pill" style="background:var(--surface-3);color:var(--text-dim);margin-right:6px;">${b}: ${fmtHM(s)}</span>`).join('')
      : '<span style="color:var(--text-faint);font-size:0.8rem;">žiadne aktivity</span>';
    return `
      <div class="chart-card" style="padding:14px 16px;margin-bottom:10px;">
        <div style="font-weight:600;margin-bottom:8px;">${wk} – ${wkEnd}</div>
        <div style="margin-bottom:10px;">${bucketsHtml}</div>
        <div style="display:flex;flex-wrap:wrap;gap:12px 18px;font-family:var(--mono);font-size:0.8rem;color:var(--text-dim);">
          <div>Load: <b>${Math.round(totalLoad)}</b></div>
          <div>Ø Recovery: <b>${avgRecovery!=null?Math.round(avgRecovery)+'%':'—'}</b></div>
          <div>Ø Strain: <b>${avgStrain!=null?avgStrain.toFixed(1):'—'}</b></div>
          <div>Ø HRV: <b>${avgHrv!=null?avgHrv.toFixed(1):'—'}</b></div>
          <div>Ø RHR: <b>${avgRhr!=null?Math.round(avgRhr):'—'}</b></div>
          <div>Ø TF spánok: <b>${avgSleepHr!=null?Math.round(avgSleepHr):'—'}</b></div>
          <div>Kroky spolu: <b>${totalSteps.toLocaleString('sk-SK')}</b></div>
          ${avgMood!=null?`<div>Ø nálada: <b>${avgMood.toFixed(1)}</b></div>`:''}
          ${avgSoreness!=null?`<div>Ø bolestivosť: <b>${avgSoreness.toFixed(1)}</b></div>`:''}
          ${avgFatiguePerceived!=null?`<div>Ø vnímaná únava: <b>${avgFatiguePerceived.toFixed(1)}</b></div>`:''}
          ${avgStress!=null?`<div>Ø stres: <b>${avgStress.toFixed(1)}</b></div>`:''}
        </div>
      </div>
    `;
  }).join('');
}

function mean(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function stdev(arr){ const m = mean(arr); return Math.sqrt(mean(arr.map(x=>(x-m)**2))); }
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}

function todayISO(){ return new Date().toISOString().slice(0,10); }

async function loadJson(url){
  try{
    const res = await fetch(url + '?t=' + Date.now());
    if(!res.ok) return null;
    return await res.json();
  }catch(e){ return null; }
}
function mergeById(a, b){
  const map = new Map();
  for(const r of (a||[])) map.set(r.id, r);
  for(const r of (b||[])) map.set(r.id, r);
  return Array.from(map.values());
}
function escapeHtml(str){
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function fmt(v, digits, suffix){
  suffix = suffix || '';
  if(v===null||v===undefined) return '—';
  return v.toFixed(digits) + suffix;
}

// ---------- Recovery skóre ----------
// Whoop kalibruje recovery tak, že priemerný deň (z=0) vychádza cca 58-60%, nie 50%.
// Preto namiesto symetrického z*25+50 používame posunutý stred + asymetrickú strmosť:
// horšie-než-zvyčajne dni klesajú rýchlejšie (DOWN_SCALE), než lepšie-než-zvyčajne dni stúpajú (UP_SCALE).
const SCORE_CENTER = 63;
const SCORE_UP_SCALE = 18;
const SCORE_DOWN_SCALE = 19; // zmiernené z 26 -> 19: pôvodná hodnota pri ~2 std horšej HRV noci
// strhla skóre danej zložky takmer na 0, čo pri váhe HRV 45% zrútilo celé recovery skóre aj keď
// RHR a spánková TF boli v norme. Whoop v praxi nedovolí, aby jeden zhoršený parameter takto
// dominoval nad ostatnými - zníženie strmosti to lepšie vybalansuje.

// ---------- Tréningová únava (Fatigue Score) ----------
// Huawei Watch Fit 5 dáva len nočné HRV/RHR/spánok - žiadne dennodenné dáta ako WHOOP.
// Preto recovery nevychádza hlavne z jedného nočného merania, ale primárne zo skutočnej
// tréningovej záťaže (Intervals.icu Load), s fyziológiou ako druhotným korekčným vstupom.
//
// Fatigue Score = súčet Load z posledných FATIGUE_LOOKBACK_DAYS dní (T-1, T-2, ...), každý deň
// exponenciálne menej váhový (FATIGUE_DECAY na deň), a každý deň najprv nelineárne "napenalizovaný"
// (Load^FATIGUE_LOAD_EXPONENT), aby veľké tréningy dopadli neúmerne viac než malé.
// Zámerne NEPOUŽÍVAME rovno importované ATL, lebo ATL pre deň T v Intervals.icu už zahŕňa
// tréning vykonaný POČAS dňa T (napr. ATL ráno 30.6. ~30, večer po jazde ~55) - pri počítaní
// Fatigue Score pre ráno dňa T preto berieme Load len zo dní T-1 a starších, nikdy nie z T.
const FATIGUE_LOOKBACK_DAYS = 14;
const FATIGUE_DECAY = 0.70;          // váha klesá na 70% za každý deň dozadu (deň T-1 = 100%)
const FATIGUE_LOAD_EXPONENT = 1.12;  // nelineárna penalizácia: Load 200 zaváži neúmerne viac než Load 100
const FATIGUE_CTL_FLOOR = 15;        // ochrana proti extrémnym pomerom pri veľmi nízkom/nulovom CTL
// Súčet váh 1 + FATIGUE_DECAY + FATIGUE_DECAY^2 + ... (geometrický rad) - použité na prepočet
// CTL (chronická záťaž/fitness) na rovnakú škálu ako Fatigue Score, aby sa dali priamo porovnať.
const FATIGUE_WEIGHT_SUM = (1 - Math.pow(FATIGUE_DECAY, FATIGUE_LOOKBACK_DAYS)) / (1 - FATIGUE_DECAY);
// Mapovanie pomeru (aktuálna záťaž / tvoja obvyklá "udržateľná" záťaž pri danom CTL) na skóre.
// Zámerne FIXNÉ, nie prispôsobené kĺzavému priemeru poslednách 60 dní - keby sme ho nechali
// "plávať" s vlastnou históriou, chronicky preťažený športovec by si sám posunul "normál" hore
// a algoritmus by prestal reagovať práve vtedy, keď má varovať najviac.
const FATIGUE_RATIO_CENTER = 63; // pomer = 1.0 (presne na svojej udržateľnej hranici) -> stred škály
const FATIGUE_RATIO_DOWN_SLOPE = 32; // nad pomerom 1.0 (viac než zvyčajne) skóre klesá strmo
const FATIGUE_RATIO_UP_SLOPE = 37;   // pod pomerom 1.0 (menej než zvyčajne, oddych) skóre stúpa

function dateAddDays(dateStr, n){
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}

// Vypočíta Fatigue Score pre ráno dňa `dateStr` použitím Load hodnôt z dní T-1 až T-FATIGUE_LOOKBACK_DAYS.
function fatigueScoreForDate(dateStr, loadByDate){
  let score = 0;
  for(let n=1; n<=FATIGUE_LOOKBACK_DAYS; n++){
    const d = dateAddDays(dateStr, -n);
    const load = loadByDate[d] || 0;
    const effectiveLoad = load > 0 ? Math.pow(load, FATIGUE_LOAD_EXPONENT) : 0;
    score += effectiveLoad * Math.pow(FATIGUE_DECAY, n-1);
  }
  return score;
}

// Prevedie Fatigue Score (v porovnaní s "kapacitou" danou tvojím CTL) na skóre 0-100.
// pomer=1.0 znamená "trénuješ presne na hranici toho, čo tvoja aktuálna forma (CTL) udrží".
// pomer>1 = viac než zvyčajne (únava rastie rýchlejšie než ju stíhaš vstrebávať) -> skóre klesá.
// pomer<1 = menej než zvyčajne (oddychuješ) -> skóre stúpa.
function fatigueRatioToScore(ratio){
  const raw = ratio >= 1
    ? FATIGUE_RATIO_CENTER - (ratio - 1) * FATIGUE_RATIO_DOWN_SLOPE
    : FATIGUE_RATIO_CENTER + (1 - ratio) * FATIGUE_RATIO_UP_SLOPE;
  return clamp(raw, 0, 100);
}

function zToScore(z){
  const raw = z>=0 ? SCORE_CENTER + z*SCORE_UP_SCALE : SCORE_CENTER + z*SCORE_DOWN_SCALE;
  return clamp(raw, 0, 100);
}
function verdictFor(rec){
  if(rec.recovery===null) return {label:'Nedostatok dát', color:'#7a7f89', detail:'Chýbajú HRV/RHR/spánok dáta.'};
  if(rec.recovery>=67) return {label:'Pripravený na intenzitu', color:'#3ddc97', detail:'Telo je zotavené. Priestor na kvalitný tréning.'};
  if(rec.recovery>=34) return {label:'Udržiavaj Z1/Z2', color:'#f0b429', detail:'Čiastočné zotavenie. Žiadne tvrdé intervaly.'};
  return {label:'Regeneruj', color:'#f0553f', detail:'Nízke zotavenie. Odporúčaný odpočinok.'};
}
function pillColor(rec){
  if(rec===null||rec===undefined) return '#7a7f89';
  if(rec>=67) return '#3ddc97';
  if(rec>=34) return '#f0b429';
  return '#f0553f';
}

// ---------- Forma (TSB) zóny — hranice odčítané z referenčného grafu (20 / 5 / -10 / -30) ----------
const FORMA_ZONES = [
  {min:20,   max:Infinity, label:'Prechod',       color:'#f0b429'},
  {min:5,    max:20,       label:'Svieži',        color:'#4a9eff'},
  {min:-10,  max:5,        label:'Sivá zóna',     color:'#7a7f89'},
  {min:-30,  max:-10,      label:'Optimálne',     color:'#3ddc97'},
  {min:-Infinity, max:-30, label:'Vysoké riziko', color:'#f0553f'},
];
function formaZoneFor(tsb){
  if(tsb===null || tsb===undefined || isNaN(tsb)) return null;
  for(const z of FORMA_ZONES){ if(tsb>=z.min && tsb<z.max) return z; }
  return FORMA_ZONES[FORMA_ZONES.length-1];
}

// ---------- Tréningová únava (Fatigue Score / kapacita) zóny ----------
// pomer = 1.0 znamená "presne na hranici udržateľnej záťaže pri tvojom aktuálnom CTL".
const FATIGUE_RATIO_ZONES = [
  {min:-Infinity, max:0.75, label:'Svieži, veľký priestor',  color:'#3ddc97'},
  {min:0.75,       max:1.15, label:'V norme',                 color:'#4a9eff'},
  {min:1.15,       max:1.6,  label:'Zvýšená únava',           color:'#f0b429'},
  {min:1.6,        max:2.1,  label:'Vysoká únava',            color:'#f0553f'},
  {min:2.1,        max:Infinity, label:'Extrémna únava',      color:'#f0553f'},
];
function fatigueRatioZoneFor(ratio){
  if(ratio===null || ratio===undefined || isNaN(ratio)) return null;
  for(const z of FATIGUE_RATIO_ZONES){ if(ratio>=z.min && ratio<z.max) return z; }
  return FATIGUE_RATIO_ZONES[FATIGUE_RATIO_ZONES.length-1];
}
function hexToRgba(hex, alpha){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function renderFormaLegend(containerId){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = FORMA_ZONES.map(z=>`<div class="forma-legend-item"><span class="forma-legend-dot" style="background:${z.color}"></span>${z.label}</div>`).join('');
}
function renderFatigueLegend(containerId){
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = FATIGUE_RATIO_ZONES.map(z=>`<div class="forma-legend-item"><span class="forma-legend-dot" style="background:${z.color}"></span>${z.label}</div>`).join('');
}

// ---------- Odchýlka od baseline -> farba (pre metrics-row bannery) ----------
// direction: +1 = vyššia hodnota je lepšia (napr. HRV), -1 = nižšia je lepšia (napr. pokojová TF)
function baselineColor(z, direction){
  if(z===null || z===undefined || isNaN(z)) return null;
  const dz = direction * z;
  if(dz >= 0.6) return '#3ddc97';   // lepšie než zvyčajne
  if(dz >= -0.6) return null;       // v norme -> necha sa default farba textu
  if(dz >= -1.5) return '#f0b429';  // mierne horšie
  return '#f0553f';                 // výrazne horšie
}

// ---------- Tag parser: vyčíta kľúčové slová z názvu aktivity a wellness komentárov ----------
const TAG_PATTERNS = [
  {tag:'Z1', re:/\bz(?:óna|ona)?\s?1\b|\bzona jedna\b/i},
  {tag:'Z2', re:/\bz(?:óna|ona)?\s?2\b|\bzona dva\b/i},
  {tag:'Z3', re:/\bz(?:óna|ona)?\s?3\b/i},
  {tag:'Z4', re:/\bz(?:óna|ona)?\s?4\b/i},
  {tag:'Z5', re:/\bz(?:óna|ona)?\s?5\b/i},
  {tag:'Recovery', re:/\brecovery\b|\bregener/i},
  {tag:'Dlhá etapa', re:/\betapa\b|\bdlh[áa]\b/i},
  {tag:'Kopcovitá jazda', re:/\bkopec\b|\bkopcovit/i},
  {tag:'Sprinty', re:/\bsprint/i},
  {tag:'Test/PR', re:/\btest\b|\bPR\b|\bpokus/i},
  {tag:'Skupinová jazda', re:/\bskupin/i},
];
function parseTags(...texts){
  const combined = texts.filter(Boolean).join(' ');
  if(!combined) return [];
  const found = [];
  for(const {tag, re} of TAG_PATTERNS){
    if(re.test(combined)) found.push(tag);
  }
  return found;
}

// ---------- Strain calculation ----------
// HR zóny (z1-z5 secs) sa NEPOUŽÍVAJÚ na výpočet Strain — slúžia len ako doplnkový detail
// v modáli dňa (bulk API endpoint niekedy vracia neúplné zónové dáta).
function zoneSecsToRawStrain(act){
  const zones = [act.hr_z1_secs, act.hr_z2_secs, act.hr_z3_secs, act.hr_z4_secs, act.hr_z5_secs];
  let total = 0;
  zones.forEach((secs, idx)=>{
    if(secs===null || secs===undefined || secs==='') return;
    const zone = idx+1;
    const weight = Math.exp(0.55*zone);
    total += (secs/60) * weight;
  });
  return total;
}
function loadToRawStrain(act){
  if(act.icu_training_load!=null && act.icu_training_load>0) return act.icu_training_load;
  return zoneSecsToRawStrain(act) * 0.35;
}
// Kroky prispievajú do strain vyšším podielom, ak sú NAD 60-dňovým priemerom (baselineSteps) —
// t.j. deň s nadpriemernou chôdzou/pohybom sa počíta ako väčšia záťaž než rovnaký počet krokov
// v rámci bežného priemeru. Pod baseline sa počíta rovnako ako doteraz (lineárne).
function stepsToRawStrain(steps, baselineSteps){
  if(!steps) return 0;
  const RATE = 6.0;
  if(!baselineSteps || steps <= baselineSteps){
    return (steps/1000.0) * RATE;
  }
  const base = (baselineSteps/1000.0) * RATE;
  const excess = ((steps-baselineSteps)/1000.0) * RATE * 1.6; // +60% váha za kroky nad zvyčajný priemer
  return base + excess;
}
function rawToStrain(raw){
  if(raw<=0) return 0;
  return 21 * (1 - Math.exp(-raw/140.0));
}
// Intervals.icu API bohužiaľ nevracia počet krokov jednotlivej aktivity (len denný súčet z
// hodiniek), takže kroky z hike/walk/run sa nedajú "odpárovať" priamym API poľom. Odhad preto
// stojí na kombinácii typu aktivity a rýchlosti - NIE len na rýchlosti samotnej, aby sa pomalá
// (napr. technická/kopcovitá) bicyklová jazda nikdy neomylom nezarátala ako chôdza.
// 1) Známe "na nohách" typy sa berú vždy, bez ohľadu na rýchlosť.
const FOOT_ACTIVITY_TYPES = new Set(['Walk','Hike','Run','TrailRun','VirtualRun','Elliptical','StairStepper','Snowshoe']);
// 2) Čokoľvek, čo vyzerá ako bicykel (podľa typu), sa NIKDY nepovažuje za "na nohách" - ani keby
// bolo veľmi pomalé (strmé stúpanie na gravel bicykli vie byť pomalšie ako svižná chôdza).
const BIKE_ACTIVITY_TYPE_RE = /ride|cycl|mtb|bike|velomobile/i;
// 3) Fallback pre prípad, že watch/Intervals uloží skutočnú pešiu aktivitu pod iný/nesprávny typ
// (napr. dnešný hike sa uložil ako "RockClimbing") - platí len pri naozaj chôdzovom tempe, aby sa
// tým nezachytila ani pomalá bicyklová jazda.
const FOOT_FALLBACK_MAX_SPEED_MS = 1.8; // ~6.5 km/h
// Priemerná dĺžka kroku pri zmiešanom tempe chôdza/hike/beh - použitá na odhad počtu krokov
// z prejdenej vzdialenosti danej aktivity.
const STEP_STRIDE_METERS = 0.75;
function isFootActivity(act){
  const type = act.type || '';
  if(FOOT_ACTIVITY_TYPES.has(type)) return true;
  if(BIKE_ACTIVITY_TYPE_RE.test(type)) return false;
  if(!act.distance || !act.moving_time) return false;
  const speed = act.distance / act.moving_time; // m/s
  return speed>0 && speed <= FOOT_FALLBACK_MAX_SPEED_MS;
}
function estimateActivitySteps(act){
  if(!act.distance || !isFootActivity(act)) return 0;
  return act.distance / STEP_STRIDE_METERS;
}
function computeDailyStrain(activities, wellnessByDate, stepsBaselineByDate){
  const rawByDate = new Map();
  const footStepsByDate = new Map();
  for(const act of activities){
    const raw = loadToRawStrain(act);
    rawByDate.set(act.date, (rawByDate.get(act.date)||0) + raw);
    const footSteps = estimateActivitySteps(act);
    if(footSteps>0) footStepsByDate.set(act.date, (footStepsByDate.get(act.date)||0) + footSteps);
  }
  const strainByDate = new Map();
  const allDates = new Set([...rawByDate.keys(), ...Object.keys(wellnessByDate)]);
  for(const date of allDates){
    let raw = rawByDate.get(date) || 0;
    const w = wellnessByDate[date];
    // OPRAVA: predtým sa kroky do strain započítali LEN ak v ten deň nebola žiadna aktivita
    // (aj tá najmenšia, napr. 15-min. prechádzka s Load 15). Dôsledok: deň so 14-tis. krokmi,
    // ale s drobnou aktivitou, dopadol na strain ~2, zatiaľ čo deň s 9-tis. krokmi a ŽIADNOU
    // aktivitou dopadol na strain ~7 - viac krokov = nižší strain, číselne "fungovalo",
    // fyziologicky nie. Kroky (bežný denný pohyb/NEAT) teraz prispievajú VŽDY, bez ohľadu na to,
    // či bola zaznamenaná štruktúrovaná aktivita - sú to dva rôzne zdroje záťaže.
    // OPRAVA 2: aby sa kroky "z hike/walk/run" nezapočítali DVAKRÁT (raz cez Load aktivity, raz cez
    // denné kroky), odčítame od denných krokov odhadnuté kroky peších aktivít daného dňa
    // (footStepsByDate) predtým, než sa z krokov počíta strain príspevok.
    if(w && w.steps){
      const baseline = stepsBaselineByDate ? stepsBaselineByDate.get(date) : null;
      const footSteps = footStepsByDate.get(date) || 0;
      const stepsExclActivities = Math.max(0, Math.round(w.steps - footSteps));
      raw += stepsToRawStrain(stepsExclActivities, baseline);
    }
    strainByDate.set(date, Math.round(rawToStrain(raw)*10)/10);
  }
  return strainByDate;
}
function strainVerdict(strain){
  if(strain===undefined || strain===null) return {label:'Bez dát', color:'#7a7f89', detail:'Žiadna aktivita ani kroky zaznamenané.'};
  if(strain < 8) return {label:'Ľahký deň', color:'#3ddc97', detail:'Nízka záťaž. Priestor na ďalší tréning zajtra.'};
  if(strain < 14) return {label:'Stredná záťaž', color:'#f0b429', detail:'Bežný tréningový deň.'};
  if(strain < 18) return {label:'Vysoká záťaž', color:'#f0553f', detail:'Náročný deň — daj pozor na regeneráciu.'};
  return {label:'Extrémna záťaž', color:'#f0553f', detail:'Veľmi náročný deň. Zajtra pravdepodobne nižšie recovery.'};
}

// ---------- Rolling baseline (60-dňové kĺzavé okno) ----------
function rollingStats(recs, field, methodBoundaryDate, window){
  window = window || 60;
  const stats = [];
  for(let i=0;i<recs.length;i++){
    const lo = Math.max(0, i-window);
    let win = recs.slice(lo,i);
    if(methodBoundaryDate && recs[i].date >= methodBoundaryDate){
      win = win.filter(r => r.date >= methodBoundaryDate);
    }
    const vals = win.map(r=>r[field]).filter(v=>v!==null && v!==undefined && !isNaN(v));
    if(vals.length >= 5) stats.push({mean: mean(vals), std: stdev(vals) || 1});
    else stats.push(null);
  }
  return stats;
}

// ---------- Hlavný výpočet: wellness+aktivity -> results (recovery/strain/tsb pre každý deň) ----------
function computeResults(recs, activities){
  // Nahradíme r.hrv efektívnou hodnotou (od HRV_SDNN_MANUAL_CUTOFF berieme manuálne zadané SDNN
  // namiesto rMSSD prepísaného hodinkami) - odteraz sa v celom výpočte aj zobrazení (tabuľky,
  // karty, AI kontext) používa už len toto zjednotené pole r.hrv.
  recs = recs.map(r => ({...r, hrv: effectiveHrv(r)}));
  const hrvStats = rollingStats(recs, 'hrv', HRV_BASELINE_BOUNDARY);
  const rhrStats = rollingStats(recs, 'restingHR', null);
  const sleepHrStats = rollingStats(recs, 'avgSleepingHR', NEW_METHOD_CUTOFF);
  const sleepScoreStats = rollingStats(recs, 'sleepScore', null);
  const stepsStats = rollingStats(recs, 'steps', null);

  // Forma (TSB) - predtým sa zámerne brala z T-1, aby ju "neskreslil" dnešný tréning. Adam chce,
  // aby sa Forma počas dňa reálne hýbala (nie len raz ráno) - preto teraz berieme priamo dnešné
  // CTL/ATL z Intervals.icu (tie sa aktualizujú akonáhle sa dnešná aktivita zosynchronizuje).
  // Dôsledok, o ktorom treba vedieť: hneď po tvrdom tréningu Forma v ten istý deň klesne (namiesto
  // toho, aby to bolo vidieť až zajtra) - to je fyziologicky správne (čerstvá záťaž = okamžitá únava),
  // len to vyzerá "nervóznejšie" než predtým.
  const tsbSeries = recs.map((r,i) => {
    return (r.ctl!=null && r.atl!=null) ? r.ctl-r.atl : null;
  });

  // Denný Load (Intervals.icu icu_training_load) spočítaný podľa dátumu aktivity - vstup pre
  // Fatigue Score. Viacero aktivít v ten istý deň sa spočíta dokopy.
  const loadByDate = {};
  (activities||[]).forEach(a=>{
    if(!a || !a.date) return;
    loadByDate[a.date] = (loadByDate[a.date]||0) + (a.icu_training_load||0);
  });

  const fatigueScoreSeries = recs.map(r => fatigueScoreForDate(r.date, loadByDate));
  // "Kapacita" = koľko Fatigue Score by si mal, keby si trénoval rovnomerne presne na úrovni
  // svojho aktuálneho CTL každý deň - inými slovami tvoja momentálna udržateľná norma. CTL sa
  // berie z predchádzajúceho dňa (T-1) z rovnakého dôvodu ako TSB vyššie.
  const fatigueRatioSeries = recs.map((r,i)=>{
    const prev = i>0 ? recs[i-1] : null;
    const ctlPrev = prev && prev.ctl!=null ? prev.ctl : null;
    if(ctlPrev==null) return null;
    const capacity = Math.pow(Math.max(ctlPrev, FATIGUE_CTL_FLOOR), FATIGUE_LOAD_EXPONENT) * FATIGUE_WEIGHT_SUM;
    if(!capacity) return null;
    return fatigueScoreSeries[i] / capacity;
  });

  function buildRecovery(r, i){
    const parts = [];
    // Rozdelenie váh: 60 % fyziológia (HRV/RHR/spánková TF/spánok), 40 % tréningová únava.
    // Huawei Watch Fit 5 poskytuje len jedno nočné meranie, ktoré samo o sebe nevie spoľahlivo
    // zachytiť viacdňovú kumulovanú únavu - preto má skutočná tréningová záťaž (Fatigue Score)
    // väčšiu váhu než pri klasických HRV-first modeloch (napr. Whoop).
    // Whoop/Oura porovnania (viď diskusia) ukazujú, že "RHR" u špičkových trackerov je v podstate
    // vždy nočný priemer TF - žiadna samostatná "denná" pokojová TF sa tam nepoužíva. Garminova
    // denná resting HR sa naopak počíta z ľubovoľného 30-min okna cez deň (metodicky slabšie).
    // Preto má nočná TF (avgSleepingHR) VYŠŠIU váhu než denná (restingHR) - opak pôvodného 15/10.
    if(r.hrv!=null && hrvStats[i]){ const z=(r.hrv-hrvStats[i].mean)/hrvStats[i].std; parts.push({w:0.30,score:zToScore(z)}); }
    if(r.restingHR!=null && rhrStats[i]){ const z=(r.restingHR-rhrStats[i].mean)/rhrStats[i].std; parts.push({w:0.10,score:zToScore(-z)}); }
    if(r.avgSleepingHR!=null && sleepHrStats[i]){ const z=(r.avgSleepingHR-sleepHrStats[i].mean)/sleepHrStats[i].std; parts.push({w:0.15,score:zToScore(-z)}); }
    if(r.sleepScore!=null && sleepScoreStats[i]){ const z=(r.sleepScore-sleepScoreStats[i].mean)/sleepScoreStats[i].std; parts.push({w:0.05,score:zToScore(z)}); }
    const fatigueRatio = fatigueRatioSeries[i];
    if(fatigueRatio!=null){
      parts.push({w:0.40, score: fatigueRatioToScore(fatigueRatio)});
    }
    if(parts.length===0) return {recovery:null};
    const totalW = parts.reduce((s,p)=>s+p.w,0);
    const recovery = parts.reduce((s,p)=>s+p.score*(p.w/totalW),0);
    return {recovery: Math.round(recovery)};
  }

  const results = recs.map((r,i)=>{
    const built = buildRecovery(r, i);
    const dayLoad = loadByDate[r.date] || 0;
    return {...r, recovery: built.recovery, tsb: tsbSeries[i], fatigueScore: fatigueScoreSeries[i], fatigueRatio: fatigueRatioSeries[i], load: dayLoad>0 ? Math.round(dayLoad) : null};
  });

  const wellnessByDate = {};
  recs.forEach(r=>{ wellnessByDate[r.date] = r; });

  const stepsBaselineByDate = new Map();
  recs.forEach((r,i)=>{ if(stepsStats[i]) stepsBaselineByDate.set(r.date, stepsStats[i].mean); });

  const strainByDate = computeDailyStrain(activities, wellnessByDate, stepsBaselineByDate);
  const resultsWithStrain = results.map(r => ({...r, strain: strainByDate.has(r.date) ? strainByDate.get(r.date) : null}));

  const latestBaseline = {
    hrv: hrvStats[hrvStats.length-1],
    restingHR: rhrStats[rhrStats.length-1],
    avgSleepingHR: sleepHrStats[sleepHrStats.length-1],
    sleepScore: sleepScoreStats[sleepScoreStats.length-1],
    steps: stepsStats[stepsStats.length-1],
  };

  return {results: resultsWithStrain, strainByDate, latestBaseline, stepsBaselineByDate};
}

// ---------- Unified chart renderer: auto-scaled line chart s crosshair/tooltip + voliteľné farebné pásma ----------
// series: [{field, color, label, width?, dash?, hideDots?}]
// opts: {fixedMin,fixedMax,gridValues,minAtZero,hideDots,dotColorFn,yFormat,tooltipFormat,bands:[{min,max,color}],height}
function drawChart(svgId, data, series, opts){
  opts = opts || {};
  const svg = document.getElementById(svgId);
  if(!svg) return;
  const W = svg.clientWidth || 600, H = opts.height || 190;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';

  const pad = {l:40, r:12, t:14, b:22};
  const plotW = W-pad.l-pad.r, plotH = H-pad.t-pad.b;
  const n = data.length;

  const anyValid = series.some(s => data.filter(d=>d[s.field]!=null && !isNaN(d[s.field])).length >= 2);
  if(n < 2 || !anyValid){
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" fill="#7a7f89" font-size="12" text-anchor="middle">Nedostatok dát</text>`;
    return;
  }

  let yMin, yMax;
  if(opts.fixedMin!=null && opts.fixedMax!=null){
    yMin = opts.fixedMin; yMax = opts.fixedMax;
  } else {
    const allVals = series.flatMap(s => data.map(d=>d[s.field]).filter(v=>v!=null && !isNaN(v)));
    const vMin = Math.min(...allVals), vMax = Math.max(...allVals);
    const margin = (vMax-vMin)*0.15 || (Math.abs(vMax)*0.1) || 2;
    yMin = opts.minAtZero ? Math.max(0, vMin-margin) : vMin-margin;
    yMax = vMax+margin;
  }

  const xFor = i => pad.l + (n>1 ? (i/(n-1))*plotW : plotW/2);
  const yFor = val => pad.t + plotH - ((val-yMin)/(yMax-yMin||1))*plotH;

  // farebné pásma na pozadí (napr. zóny Forma grafu) — kreslia sa ako prvé, pod grid aj dáta
  if(opts.bands && opts.bands.length){
    opts.bands.forEach(b=>{
      const bMin = Math.max(b.min, yMin), bMax = Math.min(b.max, yMax);
      if(bMax <= bMin) return;
      const yTop = yFor(bMax), yBot = yFor(bMin);
      const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      rect.setAttribute('x', pad.l); rect.setAttribute('y', yTop);
      rect.setAttribute('width', plotW); rect.setAttribute('height', Math.max(0, yBot-yTop));
      rect.setAttribute('fill', b.color);
      svg.appendChild(rect);
    });
  }

  // gridlines + y labels
  const gridVals = opts.gridValues || [yMin, (yMin+yMax)/2, yMax];
  const gridGroup = document.createElementNS('http://www.w3.org/2000/svg','g');
  gridVals.forEach(val=>{
    const y = yFor(val);
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',pad.l); line.setAttribute('x2',W-pad.r);
    line.setAttribute('y1',y); line.setAttribute('y2',y);
    line.setAttribute('stroke','#24282f'); line.setAttribute('stroke-width','1');
    gridGroup.appendChild(line);
    const t = document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x',6); t.setAttribute('y',y+3);
    t.setAttribute('fill','#7a7f89'); t.setAttribute('font-size','9.5');
    t.textContent = opts.yFormat ? opts.yFormat(val) : Math.round(val*10)/10;
    gridGroup.appendChild(t);
  });
  svg.appendChild(gridGroup);

  // draw each series
  series.forEach(s=>{
    const valid = data.map((d,i)=>({...d,i})).filter(d=>d[s.field]!=null && !isNaN(d[s.field]));
    if(valid.length < 2) return;
    let path='';
    valid.forEach((d,idx)=>{
      const x=xFor(d.i), y=yFor(d[s.field]);
      path += (idx===0?'M':'L')+x.toFixed(1)+','+y.toFixed(1)+' ';
    });
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg','path');
    pathEl.setAttribute('d',path); pathEl.setAttribute('fill','none');
    pathEl.setAttribute('stroke',s.color); pathEl.setAttribute('stroke-width', s.width || 2.2);
    if(s.dash) pathEl.setAttribute('stroke-dasharray', typeof s.dash === 'string' ? s.dash : '5,4');
    svg.appendChild(pathEl);

    const hideDots = s.hideDots!=null ? s.hideDots : opts.hideDots;
    if(!hideDots){
      valid.forEach(d=>{
        const x=xFor(d.i), y=yFor(d[s.field]);
        const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
        c.setAttribute('cx',x); c.setAttribute('cy',y); c.setAttribute('r', n<=10?4:2.5);
        c.setAttribute('fill', opts.dotColorFn ? opts.dotColorFn(d[s.field]) : s.color);
        c.setAttribute('class','chart-dot');
        svg.appendChild(c);
      });
    }
  });

  // legend (viac serii)
  if(series.length > 1){
    series.forEach((s,idx)=>{
      const ly = pad.t + idx*13;
      const t = document.createElementNS('http://www.w3.org/2000/svg','text');
      t.setAttribute('x', W-pad.r); t.setAttribute('y', ly+8);
      t.setAttribute('fill', s.color); t.setAttribute('font-size','9.5');
      t.setAttribute('text-anchor','end');
      t.textContent = s.label;
      svg.appendChild(t);
    });
  }

  // x-axis date labels (sparse)
  const labelEvery = Math.max(1, Math.ceil(n/6));
  data.forEach((d,i)=>{
    if(i % labelEvery !== 0 && i !== n-1) return;
    const x = xFor(i);
    const t = document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x',x); t.setAttribute('y', H-6);
    t.setAttribute('fill','#7a7f89'); t.setAttribute('font-size','9');
    t.setAttribute('text-anchor','middle');
    t.textContent = d.date.slice(5);
    svg.appendChild(t);
  });

  // ---------- Crosshair + tooltip (mouse + touch) ----------
  const crosshairLine = document.createElementNS('http://www.w3.org/2000/svg','line');
  crosshairLine.setAttribute('y1', pad.t); crosshairLine.setAttribute('y2', H-pad.b);
  crosshairLine.setAttribute('stroke', '#4a4f58'); crosshairLine.setAttribute('stroke-width','1');
  crosshairLine.setAttribute('stroke-dasharray','3,3');
  crosshairLine.style.display = 'none';
  svg.appendChild(crosshairLine);

  const crosshairDots = series.map(s=>{
    const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('r','4.5'); c.setAttribute('fill', s.color);
    c.setAttribute('stroke', '#0a0b0d'); c.setAttribute('stroke-width','1.5');
    c.style.display = 'none';
    svg.appendChild(c);
    return c;
  });

  let tooltip = svg.parentElement.querySelector('.chart-tooltip');
  if(!tooltip){
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    svg.parentElement.style.position = 'relative';
    svg.parentElement.appendChild(tooltip);
  }
  tooltip.style.display = 'none';

  function nearestIndex(mouseX){
    const rel = (mouseX-pad.l)/plotW;
    const idx = Math.round(rel*(n-1));
    return clamp(idx, 0, n-1);
  }

  function showAt(i){
    const d = data[i];
    const x = xFor(i);
    crosshairLine.setAttribute('x1',x); crosshairLine.setAttribute('x2',x);
    crosshairLine.style.display = '';

    let rows = '';
    series.forEach((s, si)=>{
      const val = d[s.field];
      const dot = crosshairDots[si];
      if(val!=null && !isNaN(val)){
        dot.setAttribute('cx',x); dot.setAttribute('cy', yFor(val));
        dot.style.display = '';
        const formatted = opts.tooltipFormat ? opts.tooltipFormat(s.field, val) : val;
        rows += `<div class="tt-row"><span class="tt-dot" style="background:${opts.dotColorFn ? opts.dotColorFn(val) : s.color}"></span>${s.label||s.field}: <b>${formatted}</b></div>`;
      } else {
        dot.style.display = 'none';
      }
    });
    tooltip.innerHTML = `<div class="tt-date">${d.date}</div>${rows}`;
    tooltip.style.display = 'block';

    const svgRect = svg.getBoundingClientRect();
    const xRatio = x / W;
    let left = xRatio * svgRect.width;
    const ttWidth = 160;
    if(left + ttWidth > svgRect.width) left = svgRect.width - ttWidth - 4;
    if(left < 4) left = 4;
    tooltip.style.left = left + 'px';
    tooltip.style.top = '4px';
  }
  function hideTooltip(){
    crosshairLine.style.display = 'none';
    crosshairDots.forEach(d=>d.style.display='none');
    tooltip.style.display = 'none';
  }
  function handlePointer(clientX){
    const rect = svg.getBoundingClientRect();
    const scaleX = W / rect.width;
    const mouseX = (clientX - rect.left) * scaleX;
    const idx = nearestIndex(mouseX);
    showAt(idx);
  }
  svg.addEventListener('mousemove', e => handlePointer(e.clientX));
  svg.addEventListener('mouseleave', hideTooltip);
  svg.addEventListener('touchstart', e => { handlePointer(e.touches[0].clientX); }, {passive:true});
  svg.addEventListener('touchmove', e => { handlePointer(e.touches[0].clientX); e.preventDefault(); }, {passive:false});
  svg.addEventListener('touchend', hideTooltip);
}

// ---------- História tabuľka + modál dňa ----------
// rows musí obsahovať aspoň {date, recovery, strain, hrv, restingHR, steps, comments}
// dayResult sa hľadá priamo v `rows`, takže funguje nezávisle na tom, koľko dní sa práve zobrazuje.
function drawTable(tableId, rows, activities){
  const table = document.getElementById(tableId);
  if(!table) return;
  let html = '<thead><tr><th>Dátum</th><th>Recovery</th><th>Strain</th><th>Load</th><th>HRV</th><th>TF pokoj.</th><th>TF spánok</th><th>Kroky</th></tr></thead><tbody>';
  rows.forEach(r=>{
    const color = pillColor(r.recovery);
    html += `<tr class="history-row" data-date="${r.date}" style="cursor:pointer;">
      <td>${r.date}${r.comments ? '<span class="comment-dot" title="Má komentár k dňu"></span>' : ''}</td>
      <td><span class="pill" style="background:${color}22;color:${color}">${r.recovery!==null? r.recovery+'%':'—'}</span></td>
      <td>${r.strain!=null ? r.strain.toFixed(1) : '—'}</td>
      <td>${r.load!=null ? r.load : '—'}</td>
      <td>${fmt(r.hrv,1)}</td>
      <td>${fmt(r.restingHR,0)}</td>
      <td>${fmt(r.avgSleepingHR,0)}</td>
      <td>${r.steps!=null ? r.steps.toLocaleString('sk-SK') : '—'}</td>
    </tr>`;
  });
  html += '</tbody>';
  table.innerHTML = html;

  table.querySelectorAll('.history-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      const date = row.dataset.date;
      const dayResult = rows.find(r=>r.date===date);
      const dayActivities = activities.filter(a=>a.date===date);
      openDayModal(date, dayResult, dayActivities);
    });
  });
}

function activityDetailHtml(a){
  const mins = a.moving_time ? Math.round(a.moving_time/60) : null;
  const km = a.distance ? (a.distance/1000).toFixed(1) : null;
  const elev = a.total_elevation_gain!=null ? Math.round(a.total_elevation_gain) : null;
  const zoneRows = [1,2,3,4,5].map(z=>{
    const secs = a[`hr_z${z}_secs`];
    if(secs==null) return '';
    const m = Math.round(secs/60);
    return m>0 ? `<div class="tt-row"><span class="tt-dot" style="background:var(--text-faint)"></span>Z${z}: <b>${m} min</b></div>` : '';
  }).join('');
  return `
    <div style="font-family:var(--mono);font-size:0.8rem;color:var(--text-dim);line-height:1.8;">
      <div>Typ: <b>${a.type||'—'}</b></div>
      <div>Dátum/čas: <b>${a.start_date_local ? a.start_date_local.slice(0,16).replace('T',' ') : (a.date||'—')}</b></div>
      ${mins!=null?`<div>Trvanie: <b>${mins} min</b></div>`:''}
      ${km?`<div>Vzdialenosť: <b>${km} km</b></div>`:''}
      ${elev!=null?`<div>Prevýšenie: <b>${elev} m</b></div>`:''}
      ${a.average_heartrate!=null?`<div>Priem. TF: <b>${Math.round(a.average_heartrate)} bpm</b></div>`:''}
      ${a.max_heartrate!=null?`<div>Max TF: <b>${Math.round(a.max_heartrate)} bpm</b></div>`:''}
      ${a.icu_training_load!=null?`<div>Load: <b>${Math.round(a.icu_training_load)}</b></div>`:''}
      ${a.icu_intensity!=null?`<div>Intenzita: <b>${Math.round(a.icu_intensity)}</b></div>`:''}
      ${a.icu_rpe!=null?`<div>RPE: <b>${a.icu_rpe}</b></div>`:''}
      ${a.comments?`<div style="margin-top:6px;white-space:pre-wrap;">${escapeHtml(a.comments)}</div>`:''}
    </div>
    ${zoneRows?`<div style="font-family:var(--mono);font-size:0.68rem;color:var(--text-faint);margin:10px 0 4px;">čas v HR zónach</div><div style="font-family:var(--mono);font-size:0.78rem;color:var(--text-dim);">${zoneRows}</div>`:''}
  `;
}

// Detail aktivity - premenovanie a zmazanie sa posiela priamo na Intervals.icu (vyžaduje uložený
// API key). Lokálne dáta na tejto stránke sa aktualizujú až pri ďalšom syncu (tlačidlo "Aktualizovať").
function openActivityModal(a){
  const modal = document.getElementById('activity-modal');
  const content = document.getElementById('activity-modal-content');
  if(!modal || !content) return;
  content.innerHTML = `
    <h3 style="display:flex;justify-content:space-between;align-items:center;">
      <span>Detail aktivity</span>
      <button id="activity-modal-close" style="background:none;border:none;color:var(--text-dim);font-size:1.2rem;cursor:pointer;">✕</button>
    </h3>
    <div style="margin-bottom:10px;">
      <input type="text" id="act-name-input" value="${escapeHtml(a.name||'')}" style="width:100%;font-size:0.95rem;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface-3);color:var(--text);box-sizing:border-box;">
    </div>
    ${activityDetailHtml(a)}
    <div id="act-modal-status" style="font-size:0.76rem;color:var(--text-faint);margin-top:10px;min-height:1.2em;"></div>
    <div class="modal-actions" style="margin-top:10px;">
      <button class="cancel" id="act-delete-btn" style="color:#f0553f;">Zmazať z Intervals</button>
      <button class="save" id="act-rename-btn">Uložiť názov do Intervals</button>
    </div>
  `;
  modal.classList.add('show');
  const status = document.getElementById('act-modal-status');
  document.getElementById('activity-modal-close').addEventListener('click', ()=> modal.classList.remove('show'));
  document.getElementById('act-rename-btn').addEventListener('click', async ()=>{
    const newName = document.getElementById('act-name-input').value.trim();
    if(!newName) return;
    status.textContent = 'Ukladám do Intervals.icu…';
    try{
      await icuUpdateActivity(a.id, {name: newName});
      status.textContent = '✅ Uložené na Intervals.icu. Tu na stránke sa to prejaví po ďalšom syncu ("Aktualizovať").';
    }catch(e){ status.textContent = '⚠️ ' + e.message; }
  });
  document.getElementById('act-delete-btn').addEventListener('click', async ()=>{
    if(!confirm('Naozaj natrvalo zmazať túto aktivitu z Intervals.icu? Nedá sa to vrátiť späť.')) return;
    status.textContent = 'Mažem na Intervals.icu…';
    try{
      await icuDeleteActivity(a.id);
      status.textContent = '✅ Zmazané na Intervals.icu. Tu na stránke zmizne po ďalšom syncu ("Aktualizovať").';
    }catch(e){ status.textContent = '⚠️ ' + e.message; }
  });
}

function openDayModal(date, dayResult, dayActivities){
  const content = document.getElementById('day-modal-content');
  const v = dayResult ? verdictFor(dayResult) : null;

  let activitiesHtml = '';
  if(dayActivities.length===0){
    activitiesHtml = '<div style="color:var(--text-dim);font-size:0.85rem;">Žiadna aktivita tento deň.</div>';
  } else {
    activitiesHtml = dayActivities.map(a=>{
      const mins = a.moving_time ? Math.round(a.moving_time/60) : null;
      const km = a.distance ? (a.distance/1000).toFixed(1) : null;
      const tags = parseTags(a.name, a.comments);
      const raw = loadToRawStrain(a);
      const contrib = rawToStrain(raw);
      return `
        <div class="day-modal-activity" data-activity-id="${a.id}" style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;cursor:pointer;">
          <div style="font-weight:600;margin-bottom:4px;">${a.name || a.type}</div>
          <div style="color:var(--text-faint);font-family:var(--mono);font-size:0.76rem;margin-bottom:4px;">
            ${a.start_date_local ? a.start_date_local.slice(11,16) : ''}${mins!=null ? ' · '+mins+' min' : ''}${km ? ' · '+km+' km' : ''}${a.icu_training_load!=null ? ' · Load '+Math.round(a.icu_training_load) : ''}
          </div>
          ${tags.length ? `<div style="margin-bottom:4px;">${tags.map(t=>`<span class="pill" style="background:var(--surface-3);color:var(--text-dim);margin-right:4px;">${t}</span>`).join('')}</div>` : ''}
          <div style="font-family:var(--mono);font-size:0.82rem;color:var(--data);">Strain príspevok: +${contrib.toFixed(1)} <span style="color:var(--text-faint);font-size:0.7rem;">· klikni pre detail / premenovanie / zmazanie</span></div>
        </div>
      `;
    }).join('');
  }

  const tsbZone = dayResult && dayResult.tsb!=null ? formaZoneFor(dayResult.tsb) : null;

  content.innerHTML = `
    <h3 style="display:flex;justify-content:space-between;align-items:center;">
      <span>${date}</span>
      <button id="day-modal-close" style="background:none;border:none;color:var(--text-dim);font-size:1.2rem;cursor:pointer;">✕</button>
    </h3>
    ${dayResult ? `
      <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;color:${v.color};">${dayResult.recovery!=null?dayResult.recovery+'%':'—'}</div><div style="font-size:0.72rem;color:var(--text-faint);">recovery</div></div>
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;color:var(--data);">${dayResult.strain!=null?dayResult.strain.toFixed(1):'—'}</div><div style="font-size:0.72rem;color:var(--text-faint);">strain</div></div>
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;">${fmt(dayResult.hrv,1)}</div><div style="font-size:0.72rem;color:var(--text-faint);">HRV</div></div>
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;">${fmt(dayResult.restingHR,0)}</div><div style="font-size:0.72rem;color:var(--text-faint);">RHR</div></div>
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;">${fmt(dayResult.avgSleepingHR,0)}</div><div style="font-size:0.72rem;color:var(--text-faint);">TF spánok</div></div>
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;">${dayResult.sleepScore!=null?dayResult.sleepScore:'—'}</div><div style="font-size:0.72rem;color:var(--text-faint);">sleep score</div></div>
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;">${dayResult.sleepSecs!=null?fmtHM(dayResult.sleepSecs):'—'}</div><div style="font-size:0.72rem;color:var(--text-faint);">dĺžka spánku</div></div>
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;">${fmt(dayResult.ctl,1)}</div><div style="font-size:0.72rem;color:var(--text-faint);">CTL</div></div>
        <div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;">${fmt(dayResult.atl,1)}</div><div style="font-size:0.72rem;color:var(--text-faint);">ATL</div></div>
        ${tsbZone ? `<div><div style="font-family:var(--mono);font-size:1.4rem;font-weight:700;color:${tsbZone.color};">${dayResult.tsb.toFixed(1)}</div><div style="font-size:0.72rem;color:var(--text-faint);">forma · ${tsbZone.label}</div></div>` : ''}
      </div>
    ` : ''}
    ${dayResult && (dayResult.mood!=null||dayResult.soreness!=null||dayResult.fatigue!=null||dayResult.stress!=null) ? `
      <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;font-family:var(--mono);font-size:0.8rem;color:var(--text-dim);">
        ${dayResult.mood!=null?`<div>Nálada: <b>${dayResult.mood}/4</b></div>`:''}
        ${dayResult.soreness!=null?`<div>Bolestivosť: <b>${dayResult.soreness}/4</b></div>`:''}
        ${dayResult.fatigue!=null?`<div>Vnímaná únava: <b>${dayResult.fatigue}/4</b></div>`:''}
        ${dayResult.stress!=null?`<div>Stres: <b>${dayResult.stress}/4</b></div>`:''}
      </div>
    ` : ''}
    ${dayResult && dayResult.comments ? `
      <div style="margin-bottom:16px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-3);">
        <div style="font-size:0.72rem;color:var(--text-faint);margin-bottom:4px;">Komentár dňa</div>
        <div style="font-size:0.88rem;color:var(--text-dim);white-space:pre-wrap;">${escapeHtml(dayResult.comments)}</div>
      </div>
    ` : ''}
    <div class="section-title" style="margin:16px 0 10px;">Aktivity</div>
    ${activitiesHtml}
  `;
  document.getElementById('day-modal').classList.add('show');
  document.getElementById('day-modal-close').addEventListener('click', ()=>{
    document.getElementById('day-modal').classList.remove('show');
  });
  content.querySelectorAll('.day-modal-activity').forEach(el=>{
    el.addEventListener('click', ()=>{
      const act = dayActivities.find(x => String(x.id)===el.dataset.activityId);
      if(act) openActivityModal(act);
    });
  });
}

// zatvorenie modálu kliknutím mimo neho (na tmavé pozadie) — spoločné pre obe stránky
document.addEventListener('DOMContentLoaded', ()=>{
  const dm = document.getElementById('day-modal');
  if(dm){
    dm.addEventListener('click', (e)=>{
      if(e.target.id==='day-modal') dm.classList.remove('show');
    });
  }
  const am = document.getElementById('activity-modal');
  if(am){
    am.addEventListener('click', (e)=>{
      if(e.target.id==='activity-modal') am.classList.remove('show');
    });
  }
});
