// sync.js
// Spúšťa GitHub Actions raz denne (plný sync) ALEBO na požiadanie z tlačidla v stránke
// (rýchly sync len posledných dní, cez workflow_dispatch input "days").
//
// Stiahne wellness (vrátane steps) + activities (vrátane HR zón pre Strain výpočet)
// z Intervals.icu a zlúči do data/wellness_daily.json a data/activities_daily.json.
//
// Očakáva premenné prostredia: ICU_API_KEY, ICU_ATHLETE_ID
// Voliteľné: SYNC_DAYS (koľko dní dozadu sťahovať, default 3)

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ICU_API_KEY;
const ATHLETE_ID = process.env.ICU_ATHLETE_ID;
const SYNC_DAYS = parseInt(process.env.SYNC_DAYS || '3', 10);

if (!API_KEY || !ATHLETE_ID) {
  console.error('Chýba ICU_API_KEY alebo ICU_ATHLETE_ID v environment premenných.');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from('API_KEY:' + API_KEY).toString('base64');
const DATA_DIR = path.join(__dirname, 'data');

function get(pathAndQuery) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'intervals.icu',
      path: pathAndQuery,
      headers: { 'Authorization': AUTH_HEADER },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Zlý JSON: ' + body.slice(0, 200))); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    }).on('error', reject);
  });
}

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function loadJsonSafe(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
// Ako loadJsonSafe, ale pre súbor, ktorý je objekt (nie pole) - vráti null namiesto [].
function loadJsonObjectSafe(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// ---------- AI pamäť ako .md namiesto .json ----------
// Dôvod prechodu: obsah je čistá próza (denné AI súhrny), takže .md sa dobre číta priamo na
// GitHube (nadpisy + text), zatiaľ čo .json s vnoreným dlhým textom v úvodzovkách je na manuálne
// prezretie nepríjemný. Formát je jednoduchý a plne pod našou kontrolou (píše aj číta ho len tento
// skript), takže parsovanie je spoľahlivé - "## YYYY-MM-DD" nadpis, za ním text až po ďalší nadpis.
function parseAiMemoryMd(content) {
  if (!content) return [];
  const entries = [];
  const re = /^## (\d{4}-\d{2}-\d{2})\s*\n([\s\S]*?)(?=\n## \d{4}-\d{2}-\d{2}|\s*$)/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    entries.push({ date: m[1], summary: m[2].trim() });
  }
  return entries;
}
function serializeAiMemoryMd(entries) {
  return entries.map(e => `## ${e.date}\n${e.summary}`).join('\n\n') + '\n';
}
function loadAiMemoryMd(file) {
  if (!fs.existsSync(file)) return [];
  try { return parseAiMemoryMd(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function mergeById(existing, incoming, idField) {
  const map = new Map(existing.map(r => [r[idField], r]));
  for (const r of incoming) map.set(r[idField], r);
  return Array.from(map.values());
}

// ============================================================
// AI denný súhrn (Gemini) — voliteľný krok, nesmie nikdy zhodiť sync.
// ============================================================

// Rovnaká hranica ako v app-common.js effectiveHrv() - od tohto dátumu sa HRV zapisuje
// manuálne ako SDNN (pole hrvSDNN), staršie dni zostávajú na rMSSD (pole hrv).
// POZOR: ak zmeníš tento dátum v app-common.js, zmeň ho aj tu.
const AI_HRV_SDNN_MANUAL_CUTOFF = '2026-07-09';
const AI_NEW_METHOD_CUTOFF = '2026-06-07';
const AI_HRV_BASELINE_BOUNDARY = AI_HRV_SDNN_MANUAL_CUTOFF > AI_NEW_METHOD_CUTOFF ? AI_HRV_SDNN_MANUAL_CUTOFF : AI_NEW_METHOD_CUTOFF;
function aiEffectiveHrv(r) {
  if (r.date >= AI_HRV_SDNN_MANUAL_CUTOFF) return (r.hrvSDNN != null ? r.hrvSDNN : r.hrv);
  return r.hrv;
}

// Priemer/smerodajná odchýlka poľa za posledných max. 60 dní PRED dneškom (dnešný záznam sa
// do baseline nikdy nepočíta). Rovnaká metodika ako rollingStats() v app-common.js (populačný
// rozptyl, min. 5 hodnôt), len zjednodušená len na "posledný deň", lebo to je jediné, čo AI súhrn
// potrebuje - nepočíta sa celá séria pre každý deň v histórii.
function aiTrailingBaseline(recsAsc, field, cutoffDate) {
  const today = recsAsc[recsAsc.length - 1];
  let pool = recsAsc.slice(0, -1);
  if (cutoffDate && today && today.date >= cutoffDate) {
    pool = pool.filter(r => r.date >= cutoffDate);
  }
  pool = pool.slice(-60);
  const vals = pool.map(r => r[field]).filter(v => v != null && !isNaN(v));
  if (vals.length < 5) return null;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
  return { mean: m, std: Math.sqrt(variance) || 1 };
}

// Zostaví textový kontext pre Gemini z KOMPLETNEJ zlúčenej histórie (wellnessMerged/activitiesMerged
// v main() už obsahujú celú históriu, nielen posledný SYNC_DAYS okno). Zámerne NEpočíta oficiálne
// Recovery %/Strain skóre appky (to je zložitejší vážený model v app-common.js, ktorý sa počíta
// v prehliadači) - AI dostáva surové metriky + odchýlky od vlastného priemeru a text opisuje stav
// slovami, nie prekvapivým číslom, ktoré by sa mohlo rozchádzať s tým, čo appka reálne zobrazuje.
//
// pastSummaries: posledných pár vlastných AI súhrnov (z data/ai_memory.json) - toto je "pamäť"
// pre AI naprieč dňami, keďže samotné volanie Gemini je bezstavové a nič si nepamätá samo od seba.
// status: obsah data/status.json (Activity Status - Aktívny/Chorý/Zranený/Pauza), zapisuje sa
// priamo z prehliadača cez GitHub Contents API (pozri index.html), sync.js ho len ČÍTA.
// dayNotes: obsah data/day_notes.json (Kalendár - poznámky/plány na konkrétne dni, VRÁTANE
// budúcich, napr. "29.7 idem na túru") - zapisuje sa priamo z calendar.html cez GitHub Contents
// API, sync.js ho tu len ČÍTA a posiela okolie dneška (minulé aj budúce dni) do promptu.
function buildAiPrompt(wellnessMerged, activitiesMerged, pastSummaries, status, dayNotes) {
  const recs = wellnessMerged
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(r => ({ ...r, hrv: aiEffectiveHrv(r) }));
  if (recs.length === 0) return null;

  const today = recs[recs.length - 1];
  const last7 = recs.slice(-7);

  const hrvBL = aiTrailingBaseline(recs, 'hrv', AI_HRV_BASELINE_BOUNDARY);
  const rhrBL = aiTrailingBaseline(recs, 'restingHR', AI_NEW_METHOD_CUTOFF);
  const sleepHrBL = aiTrailingBaseline(recs, 'avgSleepingHR', AI_NEW_METHOD_CUTOFF);
  const sleepScoreBL = aiTrailingBaseline(recs, 'sleepScore', null);

  function devLine(label, value, bl, unit) {
    if (value == null || !bl) return null;
    const diff = value - bl.mean;
    return `- ${label}: ${value}${unit || ''} (priemer ${bl.mean.toFixed(1)}${unit || ''}, ${diff >= 0 ? '+' : ''}${diff.toFixed(1)})`;
  }

  // Aktivity za posledné 2 TÝŽDNE (nie len 7 dní) - podrobný tréningový plán potrebuje dlhší
  // pohľad dozadu na to, čo už bolo odtrénované, než len posledný týždeň.
  const fourteenDaysAgo = recs.length >= 14 ? recs[recs.length - 14].date : recs[0].date;
  const recentActs = (activitiesMerged || [])
    .filter(a => a.date >= fourteenDaysAgo)
    .sort((a, b) => (a.start_date_local || a.date) < (b.start_date_local || b.date) ? -1 : 1);

  const lines = [];
  lines.push(
    'Si osobný asistent pre regeneráciu a tréning cyklistu/bežca. Na základe dát nižšie odpovedz ' +
    'IBA validným JSON objektom (žiadny markdown, žiadne ```, žiadny text mimo JSON) v tvare ' +
    '{"kratky": "...", "podrobny": "..."} - obe hodnoty sú texty v slovenčine.'
  );
  lines.push('');
  lines.push(
    '"kratky": 3-5 vety v tóne appiek ako Whoop/Bevel - vecný, konkrétny, s číslami, bez emoji a ' +
    'bez nadpisov. NEHÁDAJ presné percento "recovery" - popíš stav slovami (napr. "dobre ' +
    'zregenerovaný", "zvýšená únava") na základe HRV/pokojovej a spánkovej TF/spánku voči jeho ' +
    'vlastnému priemeru a nedávnej tréningovej záťaži. Ak v histórii jeho vlastných ' +
    'predchádzajúcich súhrnov nižšie vidíš opakujúci sa vzor (napr. viac dní po sebe znížené HRV), ' +
    'môžeš naň v jednej vete upozorniť.'
  );
  lines.push(
    '"podrobny": dlhší podrobný tréningový plán na DNES (5-10 viet). Zohľadni dnešné dáta, ' +
    'posledných 14 dní aktivít/záťaže nižšie, a AKÝKOĽVEK komentár v posledných dňoch, kde ' +
    'spomína plány dopredu (napr. "zajtra chcem voľno", "v piatok mám preteky") - ak niečo také ' +
    'nájdeš pri dátume blízko dneška, zohľadni to ako jeho vlastnú požiadavku, nie len ako dáta. ' +
    'Daj 2-3 konkrétne alternatívy pre dnešok podľa rôznych scenárov (napr. "ak chceš intenzitu: ' +
    '...", "ak radšej pokojnejšie: ...", "ak máš málo času: ..."), s konkrétnymi odporúčaniami ' +
    '(zóny, orientačná dĺžka/objem) - nie len všeobecné rady.'
  );
  lines.push('');
  lines.push(`Dátum: ${today.date}`);
  if (status && status.status && status.status !== 'active') {
    const statusLabels = { sick: 'Chorý', injured: 'Zranený', break: 'Pauza (dobrovoľné voľno)' };
    lines.push(`Aktuálny stav: ${statusLabels[status.status] || status.status} (nastavené ${status.updatedAt ? status.updatedAt.slice(0, 10) : '?'}) - zohľadni to v odporúčaní, netlač na tréning.`);
  }
  // Kalendárové poznámky/plány - okno 3 dni dozadu až 10 dní dopredu od dneška. Toto je ako sa
  // do promptu dostane napr. "29.7 idem na túru", zapísané vopred cez calendar.html.
  if (dayNotes && dayNotes.length) {
    const todayMs = new Date(today.date).getTime();
    const relevant = dayNotes
      .filter(n => n.note && n.note.trim())
      .filter(n => {
        const diffDays = (new Date(n.date).getTime() - todayMs) / 86400000;
        return diffDays >= -3 && diffDays <= 10;
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (relevant.length) {
      lines.push('Poznámky/plány v kalendári (minulé aj budúce, voči dnešku):');
      relevant.forEach(n => lines.push(`- ${n.date}: "${n.note.trim()}"`));
    }
  }
  lines.push('Dnešné ranné dáta oproti jeho vlastnému priemeru (posledných ~60 dní):');
  [
    devLine('HRV', today.hrv, hrvBL, ' ms'),
    devLine('Pokojová TF', today.restingHR, rhrBL, ' bpm'),
    devLine('Spánková TF', today.avgSleepingHR, sleepHrBL, ' bpm'),
    devLine('Sleep score', today.sleepScore, sleepScoreBL, ''),
  ].filter(Boolean).forEach(l => lines.push(l));
  if (today.sleepSecs) lines.push(`- Dĺžka spánku: ${(today.sleepSecs / 3600).toFixed(1)} h`);
  if (today.mood != null || today.soreness != null || today.fatigue != null || today.stress != null) {
    lines.push(`- Subjektívne (1-4): nálada ${today.mood ?? '—'}, bolestivosť ${today.soreness ?? '—'}, únava ${today.fatigue ?? '—'}, stres ${today.stress ?? '—'}`);
  }
  lines.push('');
  // Komentáre sa posielajú za CELÉ okno (nie len dnešok) - napr. včerajší komentár "zajtra chcem
  // voľno" musí byť viditeľný v DNEŠNOM prompte, inak sa taká poznámka dopredu nikdy nezohľadní.
  lines.push('Posledných 7 dní (dátum: HRV / pokojová TF / spánok / kroky / komentár):');
  last7.forEach(r => {
    const commentPart = r.comments ? ` / komentár: "${r.comments}"` : '';
    lines.push(`- ${r.date}: HRV ${r.hrv ?? '—'}, TF ${r.restingHR ?? '—'}, spánok ${r.sleepSecs ? (r.sleepSecs / 3600).toFixed(1) + 'h' : '—'}, kroky ${r.steps ?? '—'}${commentPart}`);
  });
  lines.push('');
  if (recentActs.length) {
    lines.push('Aktivity za posledných 14 dní:');
    recentActs.forEach(a => {
      const mins = a.moving_time ? Math.round(a.moving_time / 60) : null;
      lines.push(`- ${a.date} "${a.name || a.type}"${mins ? ', ' + mins + ' min' : ''}${a.icu_training_load ? ', load ' + Math.round(a.icu_training_load) : ''}`);
    });
  } else {
    lines.push('Žiadne zaznamenané aktivity za posledných 14 dní.');
  }
  if (pastSummaries && pastSummaries.length) {
    lines.push('');
    lines.push(`Tvoje vlastné AI súhrny za posledných ${pastSummaries.length} dní (pamäť pre kontinuitu, len na kontext):`);
    pastSummaries.forEach(p => lines.push(`- ${p.date}: ${p.summary}`));
  }

  return { prompt: lines.join('\n'), date: today.date };
}

// Voláme cez natívny fetch (Node 20 ho má globálne, netreba žiadnu závislosť).
// Free tier Gemini API (Flash / Flash-Lite modely, cez Google AI Studio kľúč) je k júlu 2026
// Voláme cez natívny fetch (Node 20 ho má globálne, netreba žiadnu závislosť).
// Free tier Gemini API (Flash / Flash-Lite modely, cez Google AI Studio kľúč) je k júlu 2026
// naozaj bez poplatku a bez karty - limit je rádovo stovky requestov/deň, čo pri 1x denne
// (prípadne pár manuálnych refreshoch) ani zďaleka nevyčerpáme. Jediný kompromis free tieru:
// Google si vyhradzuje právo použiť obsah promptu na zlepšovanie svojich modelov.
//
// POZOR - toto sa už raz stalo (21.7.2026): Google modely v Gemini API menia/rušia OVEĽA
// rýchlejšie než by človek čakal - `gemini-2.5-flash` bol vyradený a začal vracať 404 mesiace
// pred pôvodne oznámeným dátumom vypnutia. Ak raz uvidíš v logu "404" z Gemini API, najprv skús
// zistiť aktuálny názov modelu (napr. cez aistudio.google.com/models) a nastav ho ako GitHub
// secret/variable GEMINI_MODEL - kód sa nemusí meniť, len táto jedna hodnota. Aktuálny default
// (gemini-3.5-flash-lite) je k 23.7.2026 potvrdený ako stabilný, GA, free-tier model.
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

async function callGemini(prompt, opts) {
  opts = opts || {};
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log('ℹ️ GEMINI_API_KEY nie je nastavený - preskakujem AI súhrn dňa.');
    return null;
  }
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  try {
    const generationConfig = { temperature: 0.7, maxOutputTokens: opts.maxOutputTokens || 900 };
    if (opts.json) generationConfig.responseMimeType = 'application/json';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      // Celá chybová správa (nie orezaná) - Google tu zvyčajne napíše presný dôvod (napr. "model
      // not found", konkrétny quota limit a pod.), takže sa dá diagnostikovať priamo z logu.
      console.warn(`⚠️ Gemini API ${res.status} (model=${model}): ${txt}`);
      return null;
    }
    const data = await res.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    return text ? text.trim() : null;
  } catch (e) {
    console.warn('⚠️ Chyba pri volaní Gemini API:', e.message);
    return null;
  }
}

// Koľko dní vlastných AI súhrnov sa posiela SPÄŤ do promptu (kontext/kontinuita) a koľko sa
// ich maximálne drží v samotnom súbore (dlhšia história pre prípadné budúce použitie/analýzu,
// aj keď sa do promptu naráz posiela len posledných AI_MEMORY_PROMPT_DAYS).
const AI_MEMORY_PROMPT_DAYS = 14;
const AI_MEMORY_FILE_DAYS = 180;

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const oldest = daysAgoISO(SYNC_DAYS);
  const newest = todayISO();

  console.log(`Sťahujem wellness ${oldest} → ${newest} ...`);
  const wellnessRaw = await get(
    `/api/v1/athlete/${ATHLETE_ID}/wellness.json?oldest=${oldest}&newest=${newest}`
  );
  const wellnessNew = (Array.isArray(wellnessRaw) ? wellnessRaw : [wellnessRaw]).map(w => ({
    id: w.id,
    date: w.id,
    restingHR: w.restingHR ?? null,
    hrv: w.hrv ?? null,
    hrvSDNN: w.hrvSDNN ?? null,
    avgSleepingHR: w.avgSleepingHR ?? null,
    sleepScore: w.sleepScore ?? null,
    sleepSecs: w.sleepSecs ?? null,
    steps: w.steps ?? null,
    ctl: w.ctl ?? null,
    atl: w.atl ?? null,
    weight: w.weight ?? null,
    comments: w.comments ?? null,
    // Subjektívne ranné hodnotenie (1-4 škála, zapisované cez formulár na stránke alebo priamo
    // v Intervals.icu appke) - zatiaľ len na zobrazenie v histórii/týždennom súhrne, do výpočtu
    // Recovery nevstupuje.
    mood: w.mood ?? null,
    soreness: w.soreness ?? null,
    fatigue: w.fatigue ?? null,
    stress: w.stress ?? null,
    source: 'intervals_api',
    syncedAt: new Date().toISOString(),
  }));

  console.log(`Sťahujem activities ${oldest} → ${newest} ...`);
  // DÔLEŽITÉ: bulk /activities endpoint nevracia hr_z1_secs...hr_z5_secs ako samostatné polia
  // (tie existujú len na detailnom /activities/{id} endpointe). Namiesto toho vracia
  // icu_hr_zone_times ako pole [z1_secs, z2_secs, z3_secs, z4_secs, z5_secs, ...].
  // Parameter fields= to vynucuje explicitne, aby sa pole vždy vrátilo.
  const activityFields = [
    'id','start_date_local','name','type','description','moving_time','distance',
    'total_elevation_gain','average_heartrate','max_heartrate',
    'icu_training_load','icu_ctl','icu_atl','icu_intensity','icu_rpe',
    'icu_hr_zone_times',
  ].join(',');
  const activitiesRaw = await get(
    `/api/v1/athlete/${ATHLETE_ID}/activities?oldest=${oldest}&newest=${newest}&fields=${activityFields}`
  );
  const activitiesNew = (Array.isArray(activitiesRaw) ? activitiesRaw : []).map(a => {
    const zoneTimes = Array.isArray(a.icu_hr_zone_times) ? a.icu_hr_zone_times : [];
    return {
      id: String(a.id),
      date: (a.start_date_local || '').slice(0, 10),
      start_date_local: a.start_date_local,
      name: a.name,
      type: a.type,
      comments: a.description ?? null,
      moving_time: a.moving_time,
      distance: a.distance,
      total_elevation_gain: a.total_elevation_gain,
      average_heartrate: a.average_heartrate,
      max_heartrate: a.max_heartrate,
      icu_training_load: a.icu_training_load,
      icu_ctl: a.icu_ctl,
      icu_atl: a.icu_atl,
      icu_intensity: a.icu_intensity,
      icu_rpe: a.icu_rpe ?? null,
      hr_z1_secs: zoneTimes[0] ?? null,
      hr_z2_secs: zoneTimes[1] ?? null,
      hr_z3_secs: zoneTimes[2] ?? null,
      hr_z4_secs: zoneTimes[3] ?? null,
      hr_z5_secs: zoneTimes[4] ?? null,
    };
  });

  const wellnessFile = path.join(DATA_DIR, 'wellness_daily.json');
  const activitiesFile = path.join(DATA_DIR, 'activities_daily.json');

  const wellnessMerged = mergeById(loadJsonSafe(wellnessFile), wellnessNew, 'id')
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const activitiesMerged = mergeById(loadJsonSafe(activitiesFile), activitiesNew, 'id')
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  fs.writeFileSync(wellnessFile, JSON.stringify(wellnessMerged, null, 1));
  fs.writeFileSync(activitiesFile, JSON.stringify(activitiesMerged, null, 1));

  fs.writeFileSync(
    path.join(DATA_DIR, 'last_sync.json'),
    JSON.stringify({
      lastSync: new Date().toISOString(),
      syncDays: SYNC_DAYS,
      wellnessDays: wellnessNew.length,
      activities: activitiesNew.length,
    }, null, 1)
  );

  console.log(`✅ Hotovo. wellness_daily.json: ${wellnessMerged.length} dní, activities_daily.json: ${activitiesMerged.length} aktivít.`);

  // AI súhrn dňa - úmyselne AŽ TU, po úspešnom zápise wellness/activities, a úmyselne v samostatnom
  // try/catch mimo hlavného reťazca chýb: ak Gemini API zlyhá alebo chýba kľúč, sync Intervals.icu
  // dát (to podstatné) je už bezpečne hotový a uložený bez ohľadu na to, čo sa stane ďalej.
  try {
    const aiSummaryFile = path.join(DATA_DIR, 'ai_summary_daily.json');
    const aiMemoryFile = path.join(DATA_DIR, 'ai_memory.md');
    // wellness_daily.json samo osebe má len pár týždňov (rolling okno) - pre poriadny 60-dňový
    // baseline treba dotiahnuť aj wellness_history.json (veľký statický archív), presne ako to
    // pre výpočty v prehliadači robí index.html/history.html. Číta sa len na výpočet (do
    // wellness_daily.json/wellness_history.json sa nič nedopisuje, tie riadi len časť vyššie).
    const wellnessHistoryFile = path.join(DATA_DIR, 'wellness_history.json');
    const wellnessForAi = mergeById(loadJsonSafe(wellnessHistoryFile), wellnessMerged, 'id');
    // "Pamäť" pre AI naprieč dňami - posledných pár vlastných súhrnov sa posiela späť do promptu,
    // aby Gemini mohol nadviazať na vzory naprieč dňami (samotné volanie je inak bezstavové).
    const aiMemoryAll = loadAiMemoryMd(aiMemoryFile);
    const pastSummaries = aiMemoryAll.slice(-AI_MEMORY_PROMPT_DAYS);
    // status.json zapisuje priamo prehliadač cez GitHub Contents API (Activity Status karta),
    // sync.js ho tu len číta ako ďalší kus kontextu pre Gemini.
    const status = loadJsonObjectSafe(path.join(DATA_DIR, 'status.json'));
    const dayNotes = loadJsonSafe(path.join(DATA_DIR, 'day_notes.json'));
    const aiCtx = buildAiPrompt(wellnessForAi, activitiesMerged, pastSummaries, status, dayNotes);

    // DÔLEŽITÉ: tento sync beh sa u teba nespúšťa raz denne cez natívny GitHub Actions
    // "schedule:" (ten sa nepodarilo spoľahlivo rozbehať), ale externe cez cron-job.org,
    // ktorý volá workflow_dispatch cca každých 10 minút. Bez tejto poistky by sa Gemini
    // volalo ~144x denne namiesto raz - zbytočné (rovnaké ranné dáta) aj plytvajúce limit.
    const existingAi = loadJsonObjectSafe(aiSummaryFile);
    const forceAi = String(process.env.FORCE_AI || '').toLowerCase() === 'true';
    if (existingAi && aiCtx && existingAi.date === aiCtx.date && !forceAi) {
      console.log(`ℹ️ AI súhrn pre ${aiCtx.date} už existuje - preskakujem Gemini (sync beží často, netreba generovať znova). Vynúť cez tlačidlo na stránke, ak chceš nový.`);
    } else {
      console.log('Generujem AI súhrn dňa (Gemini)...');
      const raw = aiCtx ? await callGemini(aiCtx.prompt, { json: true, maxOutputTokens: 900 }) : null;
      // Model má prísny pokyn odpovedať čistým JSON-om {"kratky":..,"podrobny":..}, ale keby náhodou
      // vrátil niečo iné (napr. markdown code fence okolo), skús to vytiahnuť namiesto tvrdého zlyhania.
      let kratky = null, podrobny = null;
      if (raw) {
        let jsonStr = raw.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();
        try {
          const parsed = JSON.parse(jsonStr);
          kratky = parsed.kratky || null;
          podrobny = parsed.podrobny || null;
        } catch (e) {
          console.warn('⚠️ Odpoveď z Gemini sa nedala naparsovať ako JSON, ukladám ako krátky súhrn bez podrobného plánu:', e.message);
          kratky = raw;
        }
      }
      if (kratky) {
        fs.writeFileSync(
          aiSummaryFile,
          JSON.stringify({
            date: aiCtx.date,
            generatedAt: new Date().toISOString(),
            model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
            summary: kratky,
            plan: podrobny || '',
          }, null, 1)
        );
        // Do pamäte ide len krátky súhrn (podrobný plán je "pre dnešok", nie dlhodobo zaujímavý
        // kontext) - upsert podľa dátumu, orezané na posledných AI_MEMORY_FILE_DAYS záznamov.
        const updatedMemory = mergeById(
          aiMemoryAll.map(e => ({ ...e, id: e.date })), [{ id: aiCtx.date, date: aiCtx.date, summary: kratky }], 'id'
        ).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-AI_MEMORY_FILE_DAYS);
        fs.writeFileSync(aiMemoryFile, serializeAiMemoryMd(updatedMemory));
        console.log('✅ AI súhrn dňa uložený (a pripísaný do ai_memory.md).');
      } else {
        console.log('ℹ️ AI súhrn dňa sa tentokrát nevygeneroval (chýba kľúč, chyba API, alebo sa odpoveď nedala spracovať) - ostatné dáta sú v poriadku.');
      }
    }
  } catch (e) {
    console.warn('⚠️ AI súhrn dňa zlyhal, ale zvyšok syncu je v poriadku:', e.message);
  }
}

main().catch(err => {
  console.error('❌ Chyba pri synchronizácii:', err.message);
  process.exit(1);
});
