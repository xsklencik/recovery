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
function buildAiPrompt(wellnessMerged, activitiesMerged) {
  const recs = wellnessMerged
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(r => ({ ...r, hrv: aiEffectiveHrv(r) }));
  if (recs.length === 0) return null;

  const today = recs[recs.length - 1];
  const last7 = recs.slice(-7);

  const hrvBL = aiTrailingBaseline(recs, 'hrv', AI_HRV_BASELINE_BOUNDARY);
  const rhrBL = aiTrailingBaseline(recs, 'restingHR', null);
  const sleepHrBL = aiTrailingBaseline(recs, 'avgSleepingHR', AI_NEW_METHOD_CUTOFF);
  const sleepScoreBL = aiTrailingBaseline(recs, 'sleepScore', null);

  function devLine(label, value, bl, unit) {
    if (value == null || !bl) return null;
    const diff = value - bl.mean;
    return `- ${label}: ${value}${unit || ''} (priemer ${bl.mean.toFixed(1)}${unit || ''}, ${diff >= 0 ? '+' : ''}${diff.toFixed(1)})`;
  }

  const sevenDaysAgo = last7[0].date;
  const recentActs = (activitiesMerged || [])
    .filter(a => a.date >= sevenDaysAgo)
    .sort((a, b) => (a.start_date_local || a.date) < (b.start_date_local || b.date) ? -1 : 1);

  const lines = [];
  lines.push(
    'Si osobný asistent pre regeneráciu cyklistu/bežca. Na základe dát nižšie napíš KRÁTKY ' +
    'súhrn (3-5 viet, po slovensky) v tóne appiek ako Whoop/Bevel: vecný, konkrétny, s číslami, ' +
    'bez emoji a bez nadpisov. NEHÁDAJ presné percento "recovery" - popíš stav slovami (napr. ' +
    '"dobre zregenerovaný", "zvýšená únava") na základe HRV/pokojovej a spánkovej TF/spánku voči ' +
    'jeho vlastnému priemeru a nedávnej tréningovej záťaže. Na konci pridaj jednu vetu odporúčania ' +
    'pre dnešný tréning.'
  );
  lines.push('');
  lines.push(`Dátum: ${today.date}`);
  lines.push('Dnešné ranné dáta oproti jeho vlastnému priemeru (posledných ~60 dní):');
  [
    devLine('HRV', today.hrv, hrvBL, ' ms'),
    devLine('Pokojová TF', today.restingHR, rhrBL, ' bpm'),
    devLine('Spánková TF', today.avgSleepingHR, sleepHrBL, ' bpm'),
    devLine('Sleep score', today.sleepScore, sleepScoreBL, ''),
  ].filter(Boolean).forEach(l => lines.push(l));
  if (today.sleepSecs) lines.push(`- Dĺžka spánku: ${(today.sleepSecs / 3600).toFixed(1)} h`);
  if (today.comments) lines.push(`- Komentár k dnešku: "${today.comments}"`);
  if (today.mood != null || today.soreness != null || today.fatigue != null || today.stress != null) {
    lines.push(`- Subjektívne (1-4): nálada ${today.mood ?? '—'}, bolestivosť ${today.soreness ?? '—'}, únava ${today.fatigue ?? '—'}, stres ${today.stress ?? '—'}`);
  }
  lines.push('');
  lines.push('Posledných 7 dní (dátum: HRV / pokojová TF / spánok / kroky):');
  last7.forEach(r => {
    lines.push(`- ${r.date}: HRV ${r.hrv ?? '—'}, TF ${r.restingHR ?? '—'}, spánok ${r.sleepSecs ? (r.sleepSecs / 3600).toFixed(1) + 'h' : '—'}, kroky ${r.steps ?? '—'}`);
  });
  lines.push('');
  if (recentActs.length) {
    lines.push('Aktivity za posledných 7 dní:');
    recentActs.forEach(a => {
      const mins = a.moving_time ? Math.round(a.moving_time / 60) : null;
      lines.push(`- ${a.date} "${a.name || a.type}"${mins ? ', ' + mins + ' min' : ''}${a.icu_training_load ? ', load ' + Math.round(a.icu_training_load) : ''}`);
    });
  } else {
    lines.push('Žiadne zaznamenané aktivity za posledných 7 dní.');
  }

  return { prompt: lines.join('\n'), date: today.date };
}

// Voláme cez natívny fetch (Node 20 ho má globálne, netreba žiadnu závislosť).
// Free tier Gemini API (Flash / Flash-Lite modely, cez Google AI Studio kľúč) je k júlu 2026
// naozaj bez poplatku a bez karty - limit je rádovo stovky requestov/deň, čo pri 1x denne
// (prípadne pár manuálnych refreshoch) ani zďaleka nevyčerpáme. Jediný kompromis free tieru:
// Google si vyhradzuje právo použiť obsah promptu na zlepšovanie svojich modelov.
async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log('ℹ️ GEMINI_API_KEY nie je nastavený - preskakujem AI súhrn dňa.');
    return null;
  }
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn(`⚠️ Gemini API ${res.status}: ${txt.slice(0, 300)}`);
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
    console.log('Generujem AI súhrn dňa (Gemini)...');
    // wellness_daily.json samo osebe má len pár týždňov (rolling okno) - pre poriadny 60-dňový
    // baseline treba dotiahnuť aj wellness_history.json (veľký statický archív), presne ako to
    // pre výpočty v prehliadači robí index.html/history.html. Číta sa len na výpočet (do
    // wellness_daily.json/wellness_history.json sa nič nedopisuje, tie riadi len časť vyššie).
    const wellnessHistoryFile = path.join(DATA_DIR, 'wellness_history.json');
    const wellnessForAi = mergeById(loadJsonSafe(wellnessHistoryFile), wellnessMerged, 'id');
    const aiCtx = buildAiPrompt(wellnessForAi, activitiesMerged);
    const aiText = aiCtx ? await callGemini(aiCtx.prompt) : null;
    if (aiText) {
      fs.writeFileSync(
        path.join(DATA_DIR, 'ai_summary_daily.json'),
        JSON.stringify({
          date: aiCtx.date,
          generatedAt: new Date().toISOString(),
          model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
          summary: aiText,
        }, null, 1)
      );
      console.log('✅ AI súhrn dňa uložený.');
    } else {
      console.log('ℹ️ AI súhrn dňa sa tentokrát nevygeneroval (chýba kľúč alebo chyba API) - ostatné dáta sú v poriadku.');
    }
  } catch (e) {
    console.warn('⚠️ AI súhrn dňa zlyhal, ale zvyšok syncu je v poriadku:', e.message);
  }
}

main().catch(err => {
  console.error('❌ Chyba pri synchronizácii:', err.message);
  process.exit(1);
});
