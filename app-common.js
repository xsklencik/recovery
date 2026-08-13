// ============================================================
// app-common.js — zdieľaná logika pre index.html a history.html
// ============================================================

// Jediný zdroj pravdy pre farby použité priamo v JS (SVG grafy, pill/hex+alpha triky, kde CSS
// premenné nejdú použiť napr. kvôli reťazeniu "farba22" pre priehľadnosť). Musí zostať v súlade
// s :root/[data-theme="dark"] premennými v style.css - ak zmeníš jedno, zmeň aj druhé.
// POZOR: "chrome" farby (bg/surface*/line*/text*/chartGrid/chartCrosshair/avgLine) sa menia
// medzi light/dark - pozri applyPaletteForTheme() nižšie. Sémantické farby (accent/data/good/
// warn/bad/neutral/purple) sú ZÁMERNE identické v oboch témach, pretože RECOVERY_GRADIENT,
// STRAIN_GRADIENT, FORMA_ZONES a FATIGUE_RATIO_ZONES nižšie ich čítajú len raz pri načítaní
// skriptu a ukladajú si ich HODNOTU (nie live referenciu) - keby sa sémantické farby menili
// podľa témy, tieto polia by po prepnutí témy zobrazovali starú farbu až do reloadu stránky.
const PALETTE = {
  bg: '#EEF1F5',
  surface: '#FFFFFF',
  surface2: '#F6F7F9',
  surface3: '#EDEFF3',
  line: '#E3E6EB',
  lineSoft: '#ECEEF2',
  text: '#171A1F',
  textDim: '#666D78',
  textFaint: '#9199A6',
  accent: '#FF6A3D',
  data: '#2F7BE0',
  good: '#1E9E6B',
  warn: '#C97A17',
  bad: '#E0392C',
  neutral: '#8A909B',
  purple: '#7C5CFA',
  avgLine: '#ADB3BD',
  chartGrid: '#E7E9ED',
  chartCrosshair: '#B9BFC8',
};

// ---------- Dark mode ----------
// Jediné miesto, ktoré rozhoduje o svetlej/tmavej téme pre všetky stránky. Princíp:
// 1) Malý inline <script> úplne na začiatku <head> každej stránky nastaví data-theme atribút
//    na <html> ešte pred prvým vykreslením (podľa localStorage, inak podľa OS preferencie) -
//    to isté sa deje aj tu nižšie (setThemeAttribute), aby PALETTE sedela s tým, čo si CSS už
//    vybralo skôr, než ktorákoľvek stránka začne kresliť grafy/gauge.
// 2) CSS premenné (var(--bg) atď.) sa prepnú samé cez [data-theme="dark"] v style.css.
// 3) SVG grafy/gauge kreslené touto stránkou používajú PALETTE (hex reťazce, nie CSS premenné),
//    preto sa PALETTE musí prepísať na tú istú farebnú sadu skôr, než main()/render funkcie na
//    danej stránke začnú kresliť.
// 4) Prepnutie témy (toggleTheme) uloží voľbu a spraví location.reload() - namiesto prekresľovania
//    každého grafu na každej stránke zvlášť (rôzne render funkcie na rôznych stránkach) sa spolieha
//    na to, že reload + krok 1 vždy vykreslí všetko konzistentne v novej téme na prvý pokus.
const THEME_STORAGE_KEY = 'theme';

function getStoredTheme(){
  try{ const t = localStorage.getItem(THEME_STORAGE_KEY); return (t === 'light' || t === 'dark') ? t : null; }
  catch(e){ return null; }
}

function getPreferredTheme(){
  const stored = getStoredTheme();
  if(stored) return stored;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

// Prepíše "chrome" farby v PALETTE podľa témy. Sémantické farby sa nedotýkajú (viď komentár
// vyššie) - preto tento objekt nemá good/warn/bad/accent/data/neutral/purple kľúče vôbec.
function applyPaletteForTheme(theme){
  const dark = theme === 'dark';
  Object.assign(PALETTE, {
    bg: dark ? '#10131A' : '#EEF1F5',
    surface: dark ? '#181C24' : '#FFFFFF',
    surface2: dark ? '#1F242E' : '#F6F7F9',
    surface3: dark ? '#262C38' : '#EDEFF3',
    line: dark ? '#2C3240' : '#E3E6EB',
    lineSoft: dark ? '#232833' : '#ECEEF2',
    text: dark ? '#EDEFF3' : '#171A1F',
    textDim: dark ? '#9BA3B0' : '#666D78',
    textFaint: dark ? '#6B7383' : '#9199A6',
    avgLine: dark ? '#78818F' : '#ADB3BD',
    chartGrid: dark ? '#262C38' : '#E7E9ED',
    chartCrosshair: dark ? '#4A5262' : '#B9BFC8',
  });
}

function setThemeAttribute(theme){
  document.documentElement.setAttribute('data-theme', theme);
  applyPaletteForTheme(theme);
}

// Aplikuje sa hneď pri načítaní tohto skriptu - skôr, než akákoľvek stránka-špecifická <script>
// časť za ním začne volať drawChart()/renderRingGauge() a čítať PALETTE.
setThemeAttribute(getPreferredTheme());

function setTheme(theme){
  try{ localStorage.setItem(THEME_STORAGE_KEY, theme); }catch(e){}
  setThemeAttribute(theme);
  // Reload namiesto ručného prekresľovania - pozri komentár vyššie, bod 4.
  location.reload();
}

function toggleTheme(){
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  setTheme(current === 'dark' ? 'light' : 'dark');
}

// Vloží prepínač témy do .top-row na aktuálnej stránke (do existujúceho .btn-group, ak tam je,
// inak si vlastný .btn-group vytvorí). Volá sa raz nižšie, keď sa tento skript načíta - v tom
// bode je .top-row v DOM už vždy prítomný, keďže <script src="app-common.js"> je na každej
// stránke až za obsahom <body>.
function initThemeToggle(){
  const topRow = document.querySelector('.top-row');
  if(!topRow) return;
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.id = 'theme-toggle-btn';
  btn.setAttribute('aria-label', 'Prepnúť tmavý/svetlý režim');
  btn.innerHTML = theme === 'dark'
    ? '<span class="btn-icon">☀️</span> Svetlý režim'
    : '<span class="btn-icon">🌙</span> Tmavý režim';
  btn.addEventListener('click', toggleTheme);
  let group = topRow.querySelector('.btn-group');
  if(!group){
    group = document.createElement('div');
    group.className = 'btn-group';
    topRow.appendChild(group);
  }
  group.appendChild(btn);
}
initThemeToggle();

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
// Denný AI súhrn (Gemini) generovaný v sync.js počas GitHub Actions behu - pozri tam.
const AI_SUMMARY_URL = 'data/ai_summary_daily.json';
const HR_STRAIN_URL = 'data/hr_strain_daily.json';

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

// ---------- Zjednotený "Komentár dňa" (Dashboard / História / Kalendár - jedna a tá istá položka) ----------
// Dva zdroje toho istého údaja:
//  1) Intervals.icu wellness.comments — pravidelne sa ťahá do data/wellness_daily.json/
//     wellness_history.json cez sync.js. Toto je "master" zdroj, historicky tu už bolo veľa
//     komentárov napísaných priamo v Intervals.icu alebo cez check-in.
//  2) data/day_notes.json — lokálny cache zapisovaný priamo z prehliadača cez GitHub Contents
//     API (okamžite, bez čakania na sync beh). Pôvodne slúžil len na budúce plány v Kalendári;
//     odteraz sa doň zrkadlí presne to isté, čo sa ukladá aj do Intervals.icu, takže funguje aj
//     ako okamžitý fallback pre dni, ktoré ešte žiadny sync nestihol stiahnuť (typicky budúce dni,
//     alebo dni tesne po uložení pred najbližším cron behom).
// Priorita zobrazenia: ak Intervals.icu už niečo má, berie sa TO (je to autoritatívny zdroj a
// pravidelne sa synchronizuje) - inak sa použije lokálna kópia z day_notes.json.
function dayCommentFor(wellnessComment, noteText){
  if(wellnessComment && wellnessComment.trim()) return wellnessComment.trim();
  if(noteText && noteText.trim()) return noteText.trim();
  return '';
}

const DAY_NOTES_URL = 'data/day_notes.json';
// Rovnaký GitHub token ako pri tlačidle "Token" na Dashboarde (zdieľaný cez localStorage 'gh_pat'
// naprieč všetkými stránkami - stačí zadať raz).
function getGhToken(){ return localStorage.getItem('gh_pat') || ''; }
function setGhToken(t){ localStorage.setItem('gh_pat', t); }

// Uloží komentár/plán na daný deň naraz na OBIDVE miesta, aby si "komentár dňa" v Histórii a
// "poznámka" v Kalendári boli navždy tá istá položka:
//  1) data/day_notes.json cez GitHub Contents API - MUSÍ prejsť (inak sa hodí chyba), toto je čo
//     robí zmenu okamžite viditeľnú na všetkých stránkach appky bez čakania na cron.
//  2) Intervals.icu wellness.comments cez PUT - best-effort ("synchronizuje sa aj do Intervals.icu",
//     ale chýbajúci/neplatný API key lokálne uloženie nezablokuje, len sa to nahlási v návratovej
//     hodnote, aby to vedelo UI zobraziť ako varovanie).
// status: voliteľný per-deň override Stavu (Kalendár) - ak sa nemení, pošli existujúcu hodnotu,
// aby sa neprepísala na prázdno len preto, že niekto upravil komentár z inej stránky.
async function saveDayComment(dateStr, note, status){
  const token = getGhToken();
  if(!token) throw new Error('Chýba GitHub token (tlačidlo "Token" na Dashboarde).');
  const apiUrl = `https://api.github.com/repos/xsklencik/recovery/contents/${DAY_NOTES_URL}`;
  let sha = null, existing = [];
  const getRes = await fetch(apiUrl + '?t=' + Date.now(), {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
  });
  if(getRes.ok){
    const j = await getRes.json();
    sha = j.sha;
    try{ existing = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g,''))))); }catch(e){ existing = []; }
  }
  const idx = existing.findIndex(n=>n.date===dateStr);
  const isEmpty = note.trim()==='' && !status;
  if(isEmpty){
    if(idx>=0) existing.splice(idx,1); // prázdny komentár AJ žiadny stav = zmazať záznam
  } else {
    const entry = { date: dateStr, note, status: status || undefined, updatedAt: new Date().toISOString() };
    if(idx>=0) existing[idx] = entry; else existing.push(entry);
  }
  const content = JSON.stringify(existing, null, 1);
  const b64 = btoa(unescape(encodeURIComponent(content)));
  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ message: `Update day note: ${dateStr}`, content: b64, sha: sha || undefined, branch: 'main' }),
  });
  if(!putRes.ok){
    const txt = await putRes.text();
    throw new Error(`GitHub API ${putRes.status}: ${txt.slice(0,150)}`);
  }

  // Best-effort synchronizácia smerom do Intervals.icu — len ak sa komentár skutočne mení na
  // niečo neprázdne (zmazanie tu úmyselne nemažeme aj v Intervals.icu, nech sa lokálna appka
  // nespráva ako jediný zdroj pravdy pre mazanie dát, ktoré mohli vzniknúť aj mimo nej).
  let icuOk = false, icuError = null;
  if(note.trim() !== ''){
    try{
      if(!getIcuApiKey()) throw new Error('Chýba Intervals.icu API key (tlačidlo "Intervals kľúč") — uložené len lokálne.');
      await icuPutWellness(dateStr, { comments: note.trim() });
      icuOk = true;
    }catch(e){ icuError = e.message; }
  }

  return { notes: existing, icuOk, icuError };
}

// ---------- Priemer poľa cez pole záznamov (ignoruje null/undefined) ----------
function meanOf(arr, field){
  const vals = arr.map(r=>r[field]).filter(v=>v!=null && !isNaN(v));
  if(!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}

// ---------- Týždenný súhrn (zoskupenie podľa týždňa, pondelok = začiatok) ----------
// POZOR na rovnaký bug, aký rieši komentár pri localDateStr() nižšie: new Date(dateStr+'T00:00:00')
// bez 'Z' sa parsuje ako MIESTNA polnoc, ale d.toISOString() ju späť prevedie na UTC - v Bratislave
// (UTC+1/+2) to polnoc posunie o deň naspäť. Preto tu (na rozdiel od pôvodnej verzie) pracujeme
// výhradne v UTC - presne ako už správne robí dateAddDays() nižšie - aby žiadny lokálny/UTC prechod
// dátum nezmenil. Overené: mondayOf('2026-07-31') musí vrátiť '2026-07-27', nie '2026-07-26'.
function mondayOf(dateStr){
  const d = new Date(dateStr+'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Ne,1=Po,...
  const diff = (day===0 ? -6 : 1-day);
  d.setUTCDate(d.getUTCDate()+diff);
  return d.toISOString().slice(0,10);
}
function addDaysStr(dateStr, days){
  const d = new Date(dateStr+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+days);
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

// ---------- Týždenné najazdené km (bicykel) - pre samostatnú podstránku Histórie ----------
// Vracia pole VZOSTUPNE zoradené podľa dátumu (najstarší týždeň prvý) v tvare
// {date: pondelok týždňa (YYYY-MM-DD), km}, priamo použiteľné v drawChart (ten očakáva vzostupne
// zoradené dáta s poľom .date). Počíta len bicyklové aktivity (BIKE_ACTIVITY_TYPE_RE) - to je to,
// čo si Adam predstavuje pod "koľko som najazdil". Aktivity bez poľa "distance" (staršie
// importy do activities_history.json) sa do súčtu nezapočítajú.
function weeklyBikeKmSeries(activities){
  const weekMap = new Map(); // pondelok týždňa -> súčet metrov
  (activities||[]).forEach(a=>{
    if(!BIKE_ACTIVITY_TYPE_RE.test(a.type||'')) return;
    if(a.distance==null || isNaN(a.distance)) return;
    const date = a.date || (a.start_date_local||'').slice(0,10);
    if(!date) return;
    const wk = mondayOf(date);
    weekMap.set(wk, (weekMap.get(wk)||0) + a.distance);
  });
  return [...weekMap.keys()].sort().map(wk => ({
    date: wk,
    km: Math.round((weekMap.get(wk)/1000) * 10) / 10,
  }));
}

// POZOR: nikdy nepoužívaj new Date().toISOString().slice(0,10) na "dnešný dátum" - to prevádza
// na UTC, čo v skorých ranných hodinách (Slovensko UTC+1/+2) posunie dátum o deň dozadu (presne
// tento bug spôsoboval, že klik na 26. v kalendári otváral 25.). localDateStr() číta lokálne
// zložky dátumu (getFullYear/getMonth/getDate), žiadny UTC prevod.
function localDateStr(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayISO(){ return localDateStr(new Date()); }

async function loadJson(url){
  try{
    const res = await fetch(url + '?t=' + Date.now());
    if(!res.ok) return null;
    return await res.json();
  }catch(e){ return null; }
}
// data/hr_strain_daily.json je objekt kľúčovaný dátumom (viď heart-strain.js) - táto pomocná
// funkcia ho premení na Map, ktorú computeResults()/computeDailyStrain() vedia priamo použiť.
// Ak súbor ešte neexistuje (napr. pred prvým behom heart-strain.js), vráti prázdnu Map -
// výpočet Strain potom jednoducho použije pôvodný Load+kroky spôsob pre všetky dni.
async function loadHrStrainMap(){
  const data = await loadJson(HR_STRAIN_URL);
  return new Map(Object.entries(data || {}));
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
// ---------- Plynulý farebný prechod (namiesto skokových 3-pásmových farieb) ----------
// stops musí byť zoradené vzostupne podľa .at. Medzi susednými zastávkami sa farba lineárne
// interpoluje v RGB priestore, takže napr. hodnota 69 a 70 vyzerajú takmer identicky namiesto
// skoku cez hranicu pásma.
function hexToRgbTriplet(hex){
  const h = hex.replace('#','');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function lerpColor(hexA, hexB, t){
  const a = hexToRgbTriplet(hexA), b = hexToRgbTriplet(hexB);
  const r = Math.round(a[0]+(b[0]-a[0])*t);
  const g = Math.round(a[1]+(b[1]-a[1])*t);
  const bl = Math.round(a[2]+(b[2]-a[2])*t);
  return `rgb(${r},${g},${bl})`;
}
function gradientColor(value, stops){
  if(value==null || isNaN(value)) return PALETTE.neutral;
  if(value<=stops[0].at) return stops[0].color;
  if(value>=stops[stops.length-1].at) return stops[stops.length-1].color;
  for(let i=0;i<stops.length-1;i++){
    const s0=stops[i], s1=stops[i+1];
    if(value>=s0.at && value<=s1.at){
      return lerpColor(s0.color, s1.color, (value-s0.at)/(s1.at-s0.at));
    }
  }
  return stops[stops.length-1].color;
}
// Recovery 0-100: červená -> jantárová (na starej hranici 34) -> zelená (na starej hranici 67) ->
// sýtejšia zelená pri 100, aby aj v hornom pásme bolo vidno postupný, nie plochý, prechod.
const RECOVERY_GRADIENT = [
  {at:0,   color:PALETTE.bad},
  {at:34,  color:PALETTE.warn},
  {at:67,  color:PALETTE.good},
  {at:100, color:'#0F7A4F'},
];
// Strain 0-21: opačný smer (nízke = dobré).
const STRAIN_GRADIENT = [
  {at:0,  color:PALETTE.good},
  {at:8,  color:PALETTE.good},
  {at:14, color:PALETTE.warn},
  {at:18, color:PALETTE.bad},
  {at:21, color:'#B32A1F'},
];

function verdictFor(rec){
  if(rec.recovery===null) return {label:'Nedostatok dát', color:PALETTE.neutral, detail:'Chýbajú HRV/RHR/spánok dáta.'};
  const color = gradientColor(rec.recovery, RECOVERY_GRADIENT);
  if(rec.recovery>=67) return {label:'Pripravený na intenzitu', color, detail:'Telo je zotavené. Priestor na kvalitný tréning.'};
  if(rec.recovery>=34) return {label:'Udržiavaj Z1/Z2', color, detail:'Čiastočné zotavenie. Žiadne tvrdé intervaly.'};
  return {label:'Regeneruj', color, detail:'Nízke zotavenie. Odporúčaný odpočinok.'};
}
function pillColor(rec){
  if(rec===null||rec===undefined) return PALETTE.neutral;
  return gradientColor(rec, RECOVERY_GRADIENT);
}

// ---------- Forma (TSB) zóny — hranice odčítané z referenčného grafu (20 / 5 / -10 / -30) ----------
const FORMA_ZONES = [
  {min:20,   max:Infinity, label:'Prechod',       color:PALETTE.warn},
  {min:5,    max:20,       label:'Svieži',        color:PALETTE.data},
  {min:-10,  max:5,        label:'Sivá zóna',     color:PALETTE.neutral},
  {min:-30,  max:-10,      label:'Optimálne',     color:PALETTE.good},
  {min:-Infinity, max:-30, label:'Vysoké riziko', color:PALETTE.bad},
];
function formaZoneFor(tsb){
  if(tsb===null || tsb===undefined || isNaN(tsb)) return null;
  for(const z of FORMA_ZONES){ if(tsb>=z.min && tsb<z.max) return z; }
  return FORMA_ZONES[FORMA_ZONES.length-1];
}

// ---------- Tréningová únava (Fatigue Score / kapacita) zóny ----------
// pomer = 1.0 znamená "presne na hranici udržateľnej záťaže pri tvojom aktuálnom CTL".
const FATIGUE_RATIO_ZONES = [
  {min:-Infinity, max:0.75, label:'Svieži, veľký priestor',  color:PALETTE.good},
  {min:0.75,       max:1.15, label:'V norme',                 color:PALETTE.data},
  {min:1.15,       max:1.6,  label:'Zvýšená únava',           color:PALETTE.warn},
  {min:1.6,        max:2.1,  label:'Vysoká únava',            color:PALETTE.bad},
  {min:2.1,        max:Infinity, label:'Extrémna únava',      color:PALETTE.bad},
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
  if(dz >= 0.6) return PALETTE.good;   // lepšie než zvyčajne
  if(dz >= -0.6) return null;       // v norme -> necha sa default farba textu
  if(dz >= -1.5) return PALETTE.warn;  // mierne horšie
  return PALETTE.bad;                 // výrazne horšie
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
// PÔVODNE sa tu Strain príspevok jednej aktivity počítal z Intervals.icu Load (icu_training_load)
// - to je ale iná fyzikálna veličina (výkon/tempo/prevýšenie), nie priamo z tepu, takže sa vedelo
// stať, že aktivita strávená väčšinou v Z1 (napr. dlhá nenáročná túra) ukázala vyšší "Strain
// príspevok" než zodpovedá reálnej srdcovej záťaži - a nesedelo to s celodenným Strain, ktorý (ak
// existuje CSV tepu) počíta sync.js z presných HR zón. Teraz sa aj TU použije ROVNAKÝ model ako v
// sync.js (Banister TRIMP so stredom zóny ako reprezentatívnou TF) - MUSÍ zostať v súlade s
// zoneSecondsToRaw()/HR_ZONE_MIDPOINT v sync.js, ak sa tam niečo prekalibruje.
const HR_REST_STRAIN = 60, HR_MAX_STRAIN = 200, HR_TRIMP_B_STRAIN = 1.92;
const HR_SUBZONE_RATE_STRAIN = 0.045; // raw/min pre čas v Z1 (<143 bpm) počas aktivity
const HR_STRAIN_SCALE_CLIENT = 1.0;
const HR_ZONE_MIDPOINT_CLIENT = {2:150.5, 3:164.5, 4:178.5, 5:193};
function hrTrimpWeight(hr){
  const hrr = clamp((hr-HR_REST_STRAIN)/(HR_MAX_STRAIN-HR_REST_STRAIN), 0, 1);
  return hrr * 0.64 * Math.exp(HR_TRIMP_B_STRAIN*hrr);
}
// OPRAVA 30.7.2026 (viď rovnaký dátovaný komentár v sync.js pre plné vysvetlenie): plochá
// HR_SUBZONE_RATE_STRAIN pre CELÝ rozsah pod 143bpm dávala rovnaký "Strain príspevok" aktivite,
// kde bola väčšina Z1 času pri 65bpm, aj aktivite, kde bola väčšina Z1 času pri 140bpm (reálne
// dáta ukázali, že pri skutočnom tréningu je to takmer vždy to druhé). sync.js to teraz rieši
// presne - zo skutočného minútového tepu v okne aktivity. Tento súbor (prehliadač) nemá k
// dispozícii surové minútové CSV dáta, len súhrnné sekundy v zóne, takže namiesto plochej sadzby
// použije REPREZENTATÍVNU TF pre "Z1 počas aktivity" (rovnaký princíp ako zónové stredy Z2-Z5
// nižšie) - 125bpm, čo zodpovedá priemeru reálne nameraného rozloženia Z1 minút počas
// tréningových aktivít (overené na dátach z 25.7. a 29.7.2026). Toto číslo je len pre zobrazenie
// orientačného príspevku jednej aktivity v UI - autoritatívny denný Strain vždy počíta presnejšie
// sync.js z minútového CSV (data/hr_strain_daily.json).
const HR_Z1_ACTIVITY_MIDPOINT_CLIENT = 125;
// Vráti raw príspevok z presných HR zón (sekundy), alebo null ak aktivita nemá žiadne zónové dáta
// (vtedy sa použije fallback nižšie).
function hrZoneSecondsToRawStrain(act){
  const zoneSecs = [act.hr_z1_secs, act.hr_z2_secs, act.hr_z3_secs, act.hr_z4_secs, act.hr_z5_secs];
  if(!zoneSecs.some(s => s!=null && s>0)) return null;
  let raw = 0;
  if(zoneSecs[0]) raw += (zoneSecs[0]/60) * hrTrimpWeight(HR_Z1_ACTIVITY_MIDPOINT_CLIENT) * HR_STRAIN_SCALE_CLIENT;
  for(let z=2; z<=5; z++){
    const secs = zoneSecs[z-1];
    if(!secs) continue;
    raw += (secs/60) * hrTrimpWeight(HR_ZONE_MIDPOINT_CLIENT[z]) * HR_STRAIN_SCALE_CLIENT;
  }
  return raw;
}
// Staršia (pred zavedením TRIMP modelu) hrubá zónová váha - už sa nepoužíva priamo, len ako
// posledný záchranný fallback v loadToRawStrain() nižšie pre prípad úplne chýbajúcich dát.
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
// Poradie priorít pre raw Strain príspevok jednej aktivity: 1) presné HR zóny (TRIMP, rovnaký
// model ako celodenný Strain) → 2) Intervals.icu Load (aktivity bez zónových dát, napr. veľmi
// staré/nekompletné) → 3) hrubý zónový odhad ako posledná záchrana.
function loadToRawStrain(act){
  const hrBased = hrZoneSecondsToRawStrain(act);
  if(hrBased!=null) return hrBased;
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
// hrStrainByDate: Map<date, {strain, raw, minutes, avgHR, maxHR}> z heart-strain.js (spracované
// z Huawei Health CSV exportov, viď data/hr_strain_daily.json). Pre dni, kde tieto dáta existujú,
// POUŽIJEME priamo hotové Strain číslo namiesto výpočtu z Load/krokov nižšie - reálny nepretržitý
// tep celého dňa je presnejší signál záťaže než odvodzovanie z počtu krokov. Pre staršie dni (bez
// CSV, napr. pred 18.7.2026) sa naďalej použije pôvodný Load+kroky výpočet, aby história nezmizla.
function computeDailyStrain(activities, wellnessByDate, stepsBaselineByDate, hrStrainByDate){
  const rawByDate = new Map();
  const footStepsByDate = new Map();
  for(const act of activities){
    const raw = loadToRawStrain(act);
    rawByDate.set(act.date, (rawByDate.get(act.date)||0) + raw);
    const footSteps = estimateActivitySteps(act);
    if(footSteps>0) footStepsByDate.set(act.date, (footStepsByDate.get(act.date)||0) + footSteps);
  }
  const strainByDate = new Map();
  const allDates = new Set([...rawByDate.keys(), ...Object.keys(wellnessByDate), ...(hrStrainByDate ? hrStrainByDate.keys() : [])]);
  for(const date of allDates){
    if(hrStrainByDate && hrStrainByDate.has(date)){
      strainByDate.set(date, hrStrainByDate.get(date).strain);
      continue;
    }
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
  if(strain===undefined || strain===null) return {label:'Bez dát', color:PALETTE.neutral, detail:'Žiadna aktivita ani kroky zaznamenané.'};
  const color = gradientColor(strain, STRAIN_GRADIENT);
  if(strain < 8) return {label:'Ľahký deň', color, detail:'Nízka záťaž. Priestor na ďalší tréning zajtra.'};
  if(strain < 14) return {label:'Stredná záťaž', color, detail:'Bežný tréningový deň.'};
  if(strain < 18) return {label:'Vysoká záťaž', color, detail:'Náročný deň — daj pozor na regeneráciu.'};
  return {label:'Extrémna záťaž', color, detail:'Veľmi náročný deň. Zajtra pravdepodobne nižšie recovery.'};
}

// ---------- Sleep 0-100 (Intervals.icu sleepScore) — verdikt/farba na rovnakom princípe ako Recovery ----------
const SLEEP_GRADIENT = [
  {at:0,   color:PALETTE.bad},
  {at:50,  color:PALETTE.warn},
  {at:75,  color:PALETTE.data},
  {at:100, color:'#1B4F91'},
];
function sleepVerdict(score){
  if(score===undefined || score===null || isNaN(score)) return {label:'Bez dát', color:PALETTE.neutral, detail:'Chýba nočné meranie spánku.'};
  const color = gradientColor(score, SLEEP_GRADIENT);
  if(score>=75) return {label:'Kvalitný spánok', color, detail:'Dobrá dĺžka aj kvalita spánku.'};
  if(score>=50) return {label:'Priemerný spánok', color, detail:'Spánok mierne pod tvojím štandardom.'};
  return {label:'Nedostatočný spánok', color, detail:'Krátky alebo prerušovaný spánok — počítaj s tým v Recovery.'};
}

// ---------- Cieľový rozsah Strain ("target strain range", Whoop-style) ----------
// Whoopov presný interný vzorec nie je verejne publikovaný — toto je vlastná, plne
// transparentná náhrada s rovnakou myšlienkou: čím vyššie ranné Recovery (a čím vyššia
// aktuálna natrénovanosť/CTL), tým vyššie je dnešné "bezpečné okno" záťaže, do ktorého sa
// oplatí mieriť. Pod pásmom = netrénuješ na svoj dnešný potenciál, nad pásmom = riskuješ
// neprimeranú akútnu záťaž vzhľadom na aktuálny stav tela. Celé počítané na škále Strain 0–21:
//
//  1) Stred pásma (center) sa lineárne odvodí z Recovery %:
//       center = 2.5 + (recovery / 100) * 15        → recovery 0 % → 2.5, recovery 100 % → 17.5
//  2) Fitness korekcia — vyššie CTL (chronická tréningová záťaž = lepšia natrénovanosť) mierne
//     posúva stred nahor, lebo rovnaká záťaž je pri vyššom CTL relatívne "lacnejšia":
//       fitnessAdj = clamp((CTL − 35) × 0.045, −1.5, +1.5)     (35 = orientačný stredný CTL)
//       center = clamp(center + fitnessAdj, 1.5, 19.5)
//  3) Šírka pásma je pevná ±2.3 (dosť úzka, aby mala zmysel ako konkrétny cieľ, no nie tak
//     úzka, aby bola nereálna trafiť presne):
//       low = max(0, center − 2.3), high = min(21, center + 2.3)
const STRAIN_TARGET_CENTER_BASE = 2.5;
const STRAIN_TARGET_CENTER_SPAN = 15;
const STRAIN_TARGET_CTL_MID = 35;
const STRAIN_TARGET_CTL_COEF = 0.045;
const STRAIN_TARGET_CTL_ADJ_CLAMP = 1.5;
const STRAIN_TARGET_HALF_WIDTH = 2.3;
function computeStrainTarget(recoveryPct, ctl){
  if(recoveryPct==null || isNaN(recoveryPct)) return null;
  let center = STRAIN_TARGET_CENTER_BASE + (recoveryPct/100) * STRAIN_TARGET_CENTER_SPAN;
  if(ctl!=null && !isNaN(ctl)){
    const fitnessAdj = Math.max(-STRAIN_TARGET_CTL_ADJ_CLAMP, Math.min(STRAIN_TARGET_CTL_ADJ_CLAMP, (ctl - STRAIN_TARGET_CTL_MID) * STRAIN_TARGET_CTL_COEF));
    center += fitnessAdj;
  }
  center = Math.max(1.5, Math.min(19.5, center));
  const low = Math.max(0, Math.round((center - STRAIN_TARGET_HALF_WIDTH) * 10) / 10);
  const high = Math.min(21, Math.round((center + STRAIN_TARGET_HALF_WIDTH) * 10) / 10);
  return {low, high, center: Math.round(center*10)/10};
}
// Krátky text popisujúci, kde je dnešný strain voči cieľovému pásmu.
function strainTargetNote(strain, target){
  if(!target) return null;
  if(strain==null || isNaN(strain)) return `Cieľ dnes: ${target.low}–${target.high}`;
  if(strain < target.low) return `Cieľ dnes: ${target.low}–${target.high} · pod pásmom, je priestor pridať`;
  if(strain > target.high) return `Cieľ dnes: ${target.low}–${target.high} · nad pásmom, zvažuj skôr regeneráciu`;
  return `Cieľ dnes: ${target.low}–${target.high} · v pásme ✓`;
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
function computeResults(recs, activities, hrStrainByDate){
  // Nahradíme r.hrv efektívnou hodnotou (od HRV_SDNN_MANUAL_CUTOFF berieme manuálne zadané SDNN
  // namiesto rMSSD prepísaného hodinkami) - odteraz sa v celom výpočte aj zobrazení (tabuľky,
  // karty, AI kontext) používa už len toto zjednotené pole r.hrv.
  recs = recs.map(r => ({...r, hrv: effectiveHrv(r)}));
  const hrvStats = rollingStats(recs, 'hrv', HRV_BASELINE_BOUNDARY);
  const rhrStats = rollingStats(recs, 'restingHR', NEW_METHOD_CUTOFF);
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

  const strainByDate = computeDailyStrain(activities, wellnessByDate, stepsBaselineByDate, hrStrainByDate);
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

// ---------- Projekcia Strain/Recovery pre naplánované dni (použité na plan.html) ----------
// FEATURE 8.8.2026 (žiadosť Adama): "hrubý odhad" Strain/Recovery pre najbližší týždeň
// naplánovaných dní.
// OPRAVA 9.8.2026 v1 (nahlásené Adamom - "stále je to každý deň okolo 40 %, čo je BS"): prvý
// pokus rekonštruoval fyziológiu cez fatigueScoreForDate-štýl exponenciálny rozpad + z-skóre cez
// zToScore(). Problém: zToScore() aj fatigueRatioToScore() sú centrované na PEVNÚ konštantu
// (SCORE_CENTER/FATIGUE_RATIO_CENTER = 63), ktorá NIE JE prispôsobená Adamovi - ak jeho reálny
// fatigueRatio dlhodobo sedí okolo ~1.7 (bežné pri tréningu blízko/nad aktuálnou kapacitou), obe
// zložky vychádzajú blízko rovnakého čísla bez ohľadu na kategóriu dňa, a výsledok pôsobí
// "zaseknuto".
// OPRAVA 9.8.2026 v2 (tento presun): namiesto skladania z generických konštánt teraz PRIAMO
// hľadáme v TVOJEJ VLASTNEJ histórii odpoveď na otázku "ako si sa reálne zvykol zotaviť po dni s
// takýmto Strain?" - žiadne CTL/kapacita/z-skóre netreba. Rovnaké 4 pásma Strain ako
// strainVerdict() vyššie (Ľahký/Stredná/Vysoká/Extrémna záťaž) sa použijú ako "kľúč": pre každé
// pásmo sa z tvojej histórie spočíta priemerný Recovery na NASLEDUJÚCI deň. Predikcia pre
// plánovaný deň = priemer pre pásmo, do ktorého patrí Strain PREDCHÁDZAJÚCEHO dňa (skutočného
// alebo, pri reťazení viacero dní dopredu, už odhadnutého). Toto sa automaticky kalibruje na tvoje
// skutočné čísla - ak sa fakticky zotavuješ na 40 %, ukáže to pravdivo (nie je to chyba vzorca,
// ale realita, ktorú treba riešiť tréningom/spánkom, nie kozmetikou výpočtu); ak sa zotavuješ inak
// po rôznych typoch dní, presne TO sa teraz prejaví ako skutočný rozptyl medzi dňami.
const PLAN_ESTIMATED_RAW_LOAD = {
  rest: 0,          // skutočné voľno
  indoor: 75,        // ~45-60 min. štruktúrované indoor sedenie
  intensity: 140,    // ~60-90 min. intervaly/tempo
  long: 180,         // ~2.5-4h vytrvalostná/dlhá jazda alebo beh
  note: 110,         // deň s vlastnou poznámkou (napr. túra) - orientačný stredný odhad, keďže typ nie je štruktúrovaný ako alternatívy
  unknown: 60,
};
// Tieto konštanty sú vedomý odhad (ovplyvňujú len odhadovaný Strain danéh dňa, nie Recovery -
// Recovery teraz ide čisto z historického priemeru pre dané Strain pásmo, viď vyššie) - ak po pár
// týždňoch uvidíš, že sa systematicky líšia od toho, čo potom reálne nasynchronizuje sync.js,
// pokojne im tu priprav iné hodnoty.
const STRAIN_TIER_MIN_SAMPLES = 3; // menej ako toľko dní v histórii pre dané pásmo = nedôveryhodné, použi celkový priemer namiesto toho
// Rovnaké hranice ako strainVerdict() vyššie, nech "deň po takomto predchádzajúcom dni" znamená to
// isté, na čo si zvyknutý z Dashboardu.
function strainTier(strain) {
  if (strain == null) return 'light';
  if (strain < 8) return 'light';
  if (strain < 14) return 'moderate';
  if (strain < 18) return 'high';
  return 'extreme';
}

async function projectPlanRecoveryStrain(plan, choices) {
  if (!plan || !Array.isArray(plan.days) || !plan.days.length) return [];
  choices = choices || {};

  const [wellHistory, wellDaily, actHistory, actDaily, hrStrainMap] = await Promise.all([
    loadJson(HISTORY_URL), loadJson(DAILY_URL), loadJson(ACT_HISTORY_URL), loadJson(ACT_DAILY_URL), loadHrStrainMap(),
  ]);
  const recs = mergeById(wellHistory || [], wellDaily || []).sort((a, b) => (a.date < b.date ? -1 : 1));
  const activities = mergeById(actHistory || [], actDaily || []);
  if (!recs.length) return [];

  const { results } = computeResults(recs, activities, hrStrainMap);
  const last = results[results.length - 1];
  if (!last) return [];

  // Priemerný Recovery na deň PO dni z daného Strain pásma, spočítané priamo z tvojej histórie.
  const overallRecoveries = results.map(r => r.recovery).filter(v => v != null);
  const overallAvgRecovery = overallRecoveries.length ? mean(overallRecoveries) : 55;
  const tierBuckets = { light: [], moderate: [], high: [], extreme: [] };
  for (let i = 1; i < results.length; i++) {
    const prevStrain = results[i - 1].strain;
    const curRecovery = results[i].recovery;
    if (prevStrain == null || curRecovery == null) continue;
    tierBuckets[strainTier(prevStrain)].push(curRecovery);
  }
  const tierAvgRecovery = {};
  Object.keys(tierBuckets).forEach(tier => {
    const vals = tierBuckets[tier];
    tierAvgRecovery[tier] = vals.length >= STRAIN_TIER_MIN_SAMPLES ? mean(vals) : overallAvgRecovery;
  });

  let prevTier = strainTier(last.strain); // posledný SKUTOČNÝ deň - odtiaľto sa reťazenie začína
  const rows = [];
  plan.days.slice(0, 7).forEach(d => {
    let category, activityLabel;
    if (d.ownNote) {
      category = 'note';
      activityLabel = '📝 ' + (d.notePlan || d.ownNote);
    } else if (d.alternatives && d.alternatives.length) {
      const choice = choices[d.date];
      const recIdx = d.alternatives.findIndex(a => a.recommended);
      const i = (choice && choice.i < d.alternatives.length) ? choice.i : (recIdx !== -1 ? recIdx : 0);
      const active = d.alternatives[i];
      category = active.intensity;
      activityLabel = active.label;
    } else {
      category = 'unknown';
      activityLabel = 'Bez návrhu';
    }
    const estLoad = PLAN_ESTIMATED_RAW_LOAD[category] != null ? PLAN_ESTIMATED_RAW_LOAD[category] : PLAN_ESTIMATED_RAW_LOAD.unknown;
    const predictedStrain = Math.round(rawToStrain(estLoad) * 10) / 10;
    const predictedRecovery = Math.round(clamp(tierAvgRecovery[prevTier], 0, 100));

    rows.push({ date: d.date, category, activityLabel, predictedStrain, predictedRecovery });

    // Dnešný (odhadovaný) Strain sa stáva "predchádzajúcim dňom" pre zajtrajšiu predikciu.
    prevTier = strainTier(predictedStrain);
  });
  return rows;
}

// ---------- Unified chart renderer: auto-scaled line chart s crosshair/tooltip + voliteľné farebné pásma ----------
// series: [{field, color, label, width?, dash?, hideDots?}]
// opts: {fixedMin,fixedMax,gridValues,minAtZero,hideDots,dotColorFn,yFormat,tooltipFormat,bands:[{min,max,color}],height}
// Kruhový gauge (prstenec, plynule od 12. hodiny v smere hodinových ručičiek) + jemné rysky
// po obvode v kroku 25 % - "prístrojový" motív namiesto hladkého wellness-app prstenca.
// value/min/max: dátový rozsah, z ktorého sa odvodí percento vyplnenia (orezané na [0,1]).
// opts (voliteľné):
//   target: {low, high}  — na dráhu sa navyše nakreslí zvýraznený "cieľový" pás medzi low/high
//                           (napr. dnešné cieľové okno Strain podľa Recovery), pod progress oblúkom.
//   targetColor: farba pásu (default: color s priehľadnosťou)
//   animate: false        — vypne "kreslenie sa" oblúka od nuly (default true)
function renderRingGauge(svgId, value, min, max, color, opts){
  opts = opts || {};
  const svg = document.getElementById(svgId);
  if(!svg) return;
  const size = 160, cx = size/2, cy = size/2, r = 64, trackW = 13;
  const pct = (value==null || isNaN(value)) ? 0 : Math.max(0, Math.min(1, (value-min)/(max-min)));
  const circumference = 2*Math.PI*r;
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.innerHTML = '';

  const ticks = document.createElementNS('http://www.w3.org/2000/svg','g');
  for(let i=0;i<=4;i++){
    const a = (-90 + i*90) * Math.PI/180;
    const rOuter = r + trackW/2 + 6, rInner = r + trackW/2 + 2;
    const tick = document.createElementNS('http://www.w3.org/2000/svg','line');
    tick.setAttribute('x1', cx + rInner*Math.cos(a)); tick.setAttribute('y1', cy + rInner*Math.sin(a));
    tick.setAttribute('x2', cx + rOuter*Math.cos(a)); tick.setAttribute('y2', cy + rOuter*Math.sin(a));
    tick.setAttribute('stroke', PALETTE.line); tick.setAttribute('stroke-width','2'); tick.setAttribute('stroke-linecap','round');
    ticks.appendChild(tick);
  }
  svg.appendChild(ticks);

  const track = document.createElementNS('http://www.w3.org/2000/svg','circle');
  track.setAttribute('cx',cx); track.setAttribute('cy',cy); track.setAttribute('r',r);
  track.setAttribute('fill','none'); track.setAttribute('stroke', PALETTE.surface3); track.setAttribute('stroke-width', trackW);
  svg.appendChild(track);

  // Cieľový pás (napr. dnešné odporúčané okno Strain) — širší, priehľadný oblúk pod progress arc.
  if(opts.target && opts.target.low!=null && opts.target.high!=null && opts.target.high > opts.target.low){
    const lowPct = Math.max(0, Math.min(1, (opts.target.low - min)/(max-min)));
    const highPct = Math.max(0, Math.min(1, (opts.target.high - min)/(max-min)));
    const bandLen = Math.max(0, highPct - lowPct) * circumference;
    if(bandLen > 0){
      const band = document.createElementNS('http://www.w3.org/2000/svg','circle');
      band.setAttribute('cx',cx); band.setAttribute('cy',cy); band.setAttribute('r',r);
      band.setAttribute('fill','none');
      band.setAttribute('stroke', opts.targetColor || ((color || PALETTE.accent) + '30'));
      band.setAttribute('stroke-width', trackW + 7);
      band.setAttribute('stroke-linecap','round');
      band.setAttribute('stroke-dasharray', `${bandLen} ${circumference}`);
      band.setAttribute('stroke-dashoffset', String(-lowPct * circumference));
      band.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      band.classList.add('ring-target-band');
      svg.appendChild(band);
    }
  }

  if(pct > 0){
    const arc = document.createElementNS('http://www.w3.org/2000/svg','circle');
    arc.setAttribute('cx',cx); arc.setAttribute('cy',cy); arc.setAttribute('r',r);
    arc.setAttribute('fill','none'); arc.setAttribute('stroke', color || PALETTE.accent);
    arc.setAttribute('stroke-width', trackW); arc.setAttribute('stroke-linecap','round');
    arc.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
    arc.classList.add('ring-arc-fill');
    const finalDasharray = `${circumference*pct} ${circumference}`;
    if(opts.animate === false){
      arc.setAttribute('stroke-dasharray', finalDasharray);
      svg.appendChild(arc);
    } else {
      arc.setAttribute('stroke-dasharray', `0 ${circumference}`);
      svg.appendChild(arc);
      // Nastaviť cieľový dasharray až v ďalšom frame, aby CSS transition mala z čoho animovať.
      requestAnimationFrame(()=>{
        requestAnimationFrame(()=>{ arc.setAttribute('stroke-dasharray', finalDasharray); });
      });
    }
  }
}

// Plynulé "počítanie" číselnej hodnoty v prstenci (namiesto skokovej zmeny textu) - jemný
// efekt, ktorý dopĺňa kresliacu sa animáciu oblúka pri každom (re)renderi.
function animateRingNumber(el, toValue, decimals){
  if(!el) return;
  decimals = decimals || 0;
  if(toValue==null || isNaN(toValue)){ el.textContent = '—'; return; }
  const fromValue = parseFloat((el.textContent||'').replace(',', '.'));
  const start = (isNaN(fromValue) ? toValue : fromValue);
  const t0 = performance.now();
  const duration = 850;
  if(el._ringAnimFrame) cancelAnimationFrame(el._ringAnimFrame);
  function step(now){
    const t = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = start + (toValue - start) * eased;
    el.textContent = decimals > 0 ? val.toFixed(decimals) : String(Math.round(val));
    if(t < 1) el._ringAnimFrame = requestAnimationFrame(step);
  }
  el._ringAnimFrame = requestAnimationFrame(step);
}

// Hladká krivka cez body (Catmull-Rom -> kubické Bezier segmenty), namiesto lomenej čiary -
// vizuálne bližšie k modernému "wellness app" štýlu grafov (napr. Bevel).
function smoothPathD(points){
  if(points.length < 2) return '';
  if(points.length === 2) return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} L${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} `;
  for(let i=0;i<points.length-1;i++){
    const p0 = points[i-1] || points[i];
    const p1 = points[i];
    const p2 = points[i+1];
    const p3 = points[i+2] || p2;
    const cp1x = p1.x + (p2.x - p0.x)/6, cp1y = p1.y + (p2.y - p0.y)/6;
    const cp2x = p2.x - (p3.x - p1.x)/6, cp2y = p2.y - (p3.y - p1.y)/6;
    d += `C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)} `;
  }
  return d;
}

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
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" fill="${PALETTE.textFaint}" font-size="12" text-anchor="middle">Nedostatok dát</text>`;
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
    line.setAttribute('stroke',PALETTE.chartGrid); line.setAttribute('stroke-width','1');
    gridGroup.appendChild(line);
    const t = document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x',6); t.setAttribute('y',y+3);
    t.setAttribute('fill',PALETTE.textFaint); t.setAttribute('font-size','9.5');
    t.textContent = opts.yFormat ? opts.yFormat(val) : Math.round(val*10)/10;
    gridGroup.appendChild(t);
  });
  svg.appendChild(gridGroup);

  // draw each series
  series.forEach(s=>{
    const valid = data.map((d,i)=>({...d,i})).filter(d=>d[s.field]!=null && !isNaN(d[s.field]));
    if(valid.length < 2) return;
    const pts = valid.map(d=>({x:xFor(d.i), y:yFor(d[s.field])}));
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg','path');
    pathEl.setAttribute('d', s.straight ? pts.map((p,idx)=>(idx===0?'M':'L')+p.x.toFixed(1)+','+p.y.toFixed(1)).join(' ') : smoothPathD(pts));
    pathEl.setAttribute('fill','none');
    pathEl.setAttribute('stroke',s.color); pathEl.setAttribute('stroke-width', s.width || 2.4);
    pathEl.setAttribute('stroke-linecap','round'); pathEl.setAttribute('stroke-linejoin','round');
    if(s.dash) pathEl.setAttribute('stroke-dasharray', typeof s.dash === 'string' ? s.dash : '5,4');
    svg.appendChild(pathEl);

    const hideDots = s.hideDots!=null ? s.hideDots : opts.hideDots;
    if(!hideDots){
      valid.forEach(d=>{
        const x=xFor(d.i), y=yFor(d[s.field]);
        const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
        c.setAttribute('cx',x); c.setAttribute('cy',y); c.setAttribute('r', n<=10?4.5:2.5);
        c.setAttribute('fill', opts.dotColorFn ? opts.dotColorFn(d[s.field]) : s.color);
        c.setAttribute('stroke', PALETTE.surface); c.setAttribute('stroke-width', n<=10?1.8:0);
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
    t.setAttribute('fill',PALETTE.textFaint); t.setAttribute('font-size','9');
    t.setAttribute('text-anchor','middle');
    t.textContent = d.date.slice(5);
    svg.appendChild(t);
  });

  // ---------- Crosshair + tooltip (mouse + touch) ----------
  const crosshairLine = document.createElementNS('http://www.w3.org/2000/svg','line');
  crosshairLine.setAttribute('y1', pad.t); crosshairLine.setAttribute('y2', H-pad.b);
  crosshairLine.setAttribute('stroke', PALETTE.chartCrosshair); crosshairLine.setAttribute('stroke-width','1');
  crosshairLine.setAttribute('stroke-dasharray','3,3');
  crosshairLine.style.display = 'none';
  svg.appendChild(crosshairLine);

  const crosshairDots = series.map(s=>{
    const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('r','4.5'); c.setAttribute('fill', s.color);
    c.setAttribute('stroke', PALETTE.surface); c.setAttribute('stroke-width','1.5');
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
// notesByDate (voliteľné): Map date -> {note, status, ...} z data/day_notes.json - spolu s
// dayResult.comments (Intervals.icu) tvorí zjednotený "komentár dňa", pozri dayCommentFor().
function drawTable(tableId, rows, activities, notesByDate){
  notesByDate = notesByDate || new Map();
  const table = document.getElementById(tableId);
  if(!table) return;
  let html = '<thead><tr><th>Dátum</th><th>Recovery</th><th>Strain</th><th>Load</th><th>HRV</th><th>TF pokoj.</th><th>TF spánok</th><th>Kroky</th></tr></thead><tbody>';
  rows.forEach(r=>{
    const color = pillColor(r.recovery);
    const mergedComment = dayCommentFor(r.comments, notesByDate.get(r.date) ? notesByDate.get(r.date).note : null);
    html += `<tr class="history-row" data-date="${r.date}" style="cursor:pointer;">
      <td>${r.date}${mergedComment ? '<span class="comment-dot" title="Má komentár k dňu"></span>' : ''}</td>
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
      openDayModal(date, dayResult, dayActivities, notesByDate, {
        onSaved: ()=> drawTable(tableId, rows, activities, notesByDate), // prekresli, nech sa hneď ukáže/skryje bodka komentára
      });
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
      <button class="cancel" id="act-delete-btn" style="color:var(--bad);">Zmazať z Intervals</button>
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

function openDayModal(date, dayResult, dayActivities, notesByDate, opts){
  notesByDate = notesByDate || new Map();
  opts = opts || {};
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
  const noteEntry = notesByDate.get(date);
  const mergedComment = dayCommentFor(dayResult ? dayResult.comments : null, noteEntry ? noteEntry.note : null);

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
    <div style="margin-bottom:16px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-3);">
      <div style="font-size:0.72rem;color:var(--text-faint);margin-bottom:6px;">Komentár dňa <span style="font-weight:400;">— spoločný s Kalendárom, pri uložení sa zapíše aj do Intervals.icu</span></div>
      <textarea id="day-modal-comment-input" rows="2" style="width:100%;font-family:var(--sans);font-size:0.88rem;">${escapeHtml(mergedComment)}</textarea>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px;">
        <button class="btn primary" id="day-modal-comment-save" style="padding:7px 14px;font-size:0.78rem;">Uložiť komentár</button>
        <span id="day-modal-comment-status" style="font-size:0.74rem;color:var(--text-faint);"></span>
      </div>
    </div>
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
  const commentSaveBtn = content.querySelector('#day-modal-comment-save');
  if(commentSaveBtn){
    commentSaveBtn.addEventListener('click', async ()=>{
      const statusEl = content.querySelector('#day-modal-comment-status');
      const val = content.querySelector('#day-modal-comment-input').value;
      commentSaveBtn.disabled = true;
      statusEl.style.color = 'var(--text-faint)';
      statusEl.textContent = 'Ukladám…';
      try{
        const existingStatus = notesByDate.get(date) ? notesByDate.get(date).status : undefined;
        const res = await saveDayComment(date, val, existingStatus);
        if(val.trim()===''){ notesByDate.delete(date); }
        else notesByDate.set(date, { date, note: val, status: existingStatus, updatedAt: new Date().toISOString() });
        if(dayResult) dayResult.comments = val;
        if(res.icuOk){
          statusEl.style.color = 'var(--good)';
          statusEl.textContent = '✅ Uložené (aj do Intervals.icu)';
        } else if(res.icuError){
          statusEl.style.color = 'var(--warn)';
          statusEl.textContent = '✅ Uložené lokálne — ⚠️ Intervals.icu: ' + res.icuError;
        } else {
          statusEl.style.color = 'var(--good)';
          statusEl.textContent = '✅ Uložené';
        }
        if(typeof opts.onSaved === 'function') opts.onSaved(date, val);
      }catch(e){
        statusEl.style.color = 'var(--bad)';
        statusEl.textContent = '⚠️ ' + e.message;
      }finally{
        commentSaveBtn.disabled = false;
      }
    });
  }
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
