// sync.js
// Spúšťa GitHub Actions každých pár minút cez cron-job.org (workflow_dispatch) ALEBO na
// požiadanie z tlačidla "🔄 Aktualizovať" v stránke.
//
// Stiahne wellness (vrátane steps) + activities (vrátane HR zón pre Strain výpočet)
// z Intervals.icu a zlúči do data/wellness_daily.json a data/activities_daily.json.
//
// Zároveň spracuje data/heart_rate_raw/*.csv (denné exporty tepu z Huawei Health, pushnuté sem
// Google Apps Scriptom - viď google-apps-script/push-heart-rate-csv.gs) a dopočíta CELODENNÝ
// Strain priamo z nepretržitého tepu namiesto Load+krokov - viď processHeartRateCsvs() nižšie.
// Beží v tom istom behu ako Intervals.icu sync (žiadny samostatný workflow netreba), zlyhanie v
// tejto časti NEZASTAVÍ zvyšok syncu (viď try/catch v main()).
//
// POZOR: tento skript už NEROBÍ AI súhrn (Gemini) - to je teraz úplne samostatný skript
// ai-summary.js s vlastným workflow (.github/workflows/ai-summary.yml), aby mohol bežať na
// vlastnom (oveľa riedšom, raz denne) rozvrhu nezávisle od toho, ako často beží tento sync.
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

// ---------------------------------------------------------------------------
// Celodenný Strain z tepu (Huawei Health CSV) - namiesto samostatného heart-strain.js teraz beží
// priamo tu, v tom istom behu ako Intervals.icu sync.
// ---------------------------------------------------------------------------
const RAW_HR_DIR = path.join(DATA_DIR, 'heart_rate_raw');
const HR_STRAIN_FILE = path.join(DATA_DIR, 'hr_strain_daily.json');

// Fyziologické konštanty - ODHADNUTÉ spätne z Adamových Karvonen zón nastavených v Intervals.icu
// (Z1 <143 · Z2 144-157 · Z3 158-171 · Z4 172-185 · Z5 ≥186 bpm). Karvonen: HR = HRrest +
// %HRR*(HRmax-HRrest). Zo 4 hraníc zón (143.5/157.5/171.5/185.5, po 10 % HRR kroku od 60 do 90 %)
// vychádza: HRmax-HRrest=140, HRrest≈60 bpm, HRmax≈200 bpm (sedí aj s 220-vek pre 20-ročného).
// Ak by tvoje SKUTOČNÉ HRrest/HRmax boli iné, uprav tu.
const HR_REST = 60;
const HR_MAX = 200;
// Hranica Z1/Z2 - POD ňou to Adam sám nepovažuje za tréningovú zónu (Z1 = "<143" = spánok až
// ľahký pohyb). NAD touto hranicou začína skutočná kardio záťaž (Z2-Z5).
const HR_Z1_Z2_BOUNDARY = 143;
// Banister TRIMP koeficient (b=1.92 pre mužov). DÔLEŽITÉ (zistené testom na syntetickom dni):
// naivný TRIMP aplikovaný od HRrest CELÝ DEŇ výrazne preďaľuje bežnú dennú TF (70-100 bpm pri
// sedení/chôdzi) - aj deň bez tréningu vyšiel na Strain ~19-20. Preto exponenciála platí LEN NAD
// HR_Z1_Z2_BOUNDARY; pod ňou (ale nad pokojovou TF) dostane minúta len malý plochý príspevok
// (HR_SUBZONE_RATE). Spánok/hlboký pokoj (HR ≤ HRrest) neprispieva vôbec.
const HR_TRIMP_B = 1.92;
const HR_SUBZONE_RATE = 0.045; // raw/min pre bdenie pod 143 bpm (bežný denný pohyb, NEAT)
// Škálovací faktor pre časť NAD 143 bpm - PRVÁ KALIBRÁCIA, over na pár reálnych dňoch a uprav,
// ak sa Strain "necíti" správne (>1 = vyšší Strain za tú istú intenzitu, <1 = nižší).
const HR_STRAIN_SCALE = 1.0;

// PRESNOSŤ POČAS AKTIVÍT: Intervals.icu pozná pre KAŽDÚ zosynchronizovanú aktivitu presný počet
// SEKÚND strávených v každej zóne (hr_z1_secs..hr_z5_secs, z bicyklového počítača/hodiniek -
// oveľa jemnejšie ako 1 riadok/minútu z Huawei Health CSV). Preto: pre časové okno KAŽDEJ
// aktivity, ktorá tieto zónové dáta má, sa Strain počíta PRIAMO z nich (zoneSecondsToRaw nižšie)
// - a zodpovedajúce minúty z CSV sa PRESKOČIA (aby sa nezapočítali dvakrát). Pre zvyšok dňa (mimo
// zaznamenaných aktivít) sa použije minútový CSV tep ako doteraz - tam presnejšie dáta nemáme.
// Reprezentatívna TF pre zóny 2-5 = stred zóny (Z1 v aktivite ide cez rovnakú plochú sadzbu ako
// mimo aktivity - je to stále "pod tréningovou hranicou", či už ide o rozjazdenie/cool-down).
const HR_ZONE_MIDPOINT = { 2: 150.5, 3: 164.5, 4: 178.5, 5: 193 };

// MUSÍ zostať v súlade s rawToStrain() v app-common.js (rovnaká škála 0-21).
function hrRawToStrain(raw) {
  if (raw <= 0) return 0;
  return 21 * (1 - Math.exp(-raw / 140.0));
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function trimpWeight(hr) {
  const hrr = clamp((hr - HR_REST) / (HR_MAX - HR_REST), 0, 1);
  return hrr * 0.64 * Math.exp(HR_TRIMP_B * hrr);
}
// zoneSecs = [z1,z2,z3,z4,z5] v sekundách (jednotlivé polia môžu byť null - staršie/neúplné dáta).
function zoneSecondsToRaw(zoneSecs) {
  let raw = 0;
  if (zoneSecs[0]) raw += (zoneSecs[0] / 60) * HR_SUBZONE_RATE; // Z1
  for (let z = 2; z <= 5; z++) {
    const secs = zoneSecs[z - 1];
    if (!secs) continue;
    raw += (secs / 60) * trimpWeight(HR_ZONE_MIDPOINT[z]) * HR_STRAIN_SCALE;
  }
  return raw;
}
// Časové okno aktivity v rámci JEJ dňa, v sekundách od polnoci (napr. 14:32:10 -> 52330).
// Nerieši aktivity presahujúce cez polnoc (moving_time by musel byť >zvyšok dňa) - u bežných
// tréningov/výletov zanedbateľný okrajový prípad.
function activityWindowSecs(act) {
  if (!act.start_date_local || !act.moving_time) return null;
  const timePart = act.start_date_local.split('T')[1];
  if (!timePart) return null;
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const startSec = hh * 3600 + mm * 60 + (ss || 0);
  return [startSec, startSec + act.moving_time];
}
function timeToSecs(hhmmss) {
  const [hh, mm, ss] = hhmmss.split(':').map(Number);
  return hh * 3600 + mm * 60 + (ss || 0);
}

// Očakávaný formát (Huawei Health export): Date\tTime\tHeart rate\tSource, napr.
// "2026.07.29 00:00:00\t00:00:00\t58\t". Podporuje tabulátor aj čiarku. Riadky s prázdnym/
// neplatným tepom sa preskočia (watch nenasadené/nabíjanie) - menej meraných minút v daný deň
// jednoducho znamená menší (nie skreslený) súčet. Vracia aj čas (nie len TF), aby sa dala minúta
// priradiť/vylúčiť podľa časového okna aktivity (viď vyššie).
function parseHrCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const header = lines[0].split(delim).map(h => h.trim().toLowerCase());
  const dateIdx = header.findIndex(h => h === 'date');
  const hrIdx = header.findIndex(h => h.startsWith('heart rate') || h === 'hr');
  if (dateIdx === -1 || hrIdx === -1) {
    console.warn(`⚠️ ${path.basename(filePath)}: nerozpoznaná hlavička (${header.join('|')}), preskakujem.`);
    return [];
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim);
    const dateRaw = (cols[dateIdx] || '').trim();
    const hrRaw = (cols[hrIdx] || '').trim();
    if (!dateRaw || !hrRaw) continue;
    const hr = parseFloat(hrRaw);
    if (!isFinite(hr) || hr <= 0) continue;
    const [datePart, timePart] = dateRaw.split(' '); // "2026.07.29 00:00:00" -> ["2026.07.29","00:00:00"]
    const isoDate = (datePart || '').replace(/\./g, '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) continue;
    rows.push({ date: isoDate, time: timePart || '00:00:00', hr });
  }
  return rows;
}

// dayRows: [{time,hr}, ...] pre daný deň z CSV. dayActivities: aktivity toho istého dňa (z
// activities_daily.json) - tie, čo MAJÚ aspoň jedno hr_zX_secs pole, sa spočítajú presne zo
// sekúnd (a ich minúty sa v CSV preskočia); ostatné (bez zónových dát) ostanú pokryté cez CSV.
function dayTrimp(dayRows, dayActivities) {
  const windows = [];
  let activityRaw = 0, activitySecondsUsed = 0;
  for (const act of (dayActivities || [])) {
    const zoneSecs = [act.hr_z1_secs, act.hr_z2_secs, act.hr_z3_secs, act.hr_z4_secs, act.hr_z5_secs];
    if (!zoneSecs.some(s => s != null && s > 0)) continue; // bez zónových dát - necháme spracovať cez CSV
    const win = activityWindowSecs(act);
    if (!win) continue;
    windows.push(win);
    activityRaw += zoneSecondsToRaw(zoneSecs);
    activitySecondsUsed += win[1] - win[0];
  }

  let csvRaw = 0, sum = 0, max = 0;
  for (const { time, hr } of dayRows) {
    sum += hr;
    if (hr > max) max = hr;
    const t = timeToSecs(time);
    if (windows.some(([s, e]) => t >= s && t < e)) continue; // presne spočítané vyššie zo sekúnd
    if (hr > HR_REST) {
      csvRaw += hr < HR_Z1_Z2_BOUNDARY ? HR_SUBZONE_RATE : trimpWeight(hr) * HR_STRAIN_SCALE;
    }
  }
  return {
    raw: activityRaw + csvRaw,
    minutes: dayRows.length,
    avgHR: dayRows.length ? Math.round((sum / dayRows.length) * 10) / 10 : null,
    maxHR: dayRows.length ? max : null,
    activitySecondsUsed,
  };
}

function processHeartRateCsvs(activitiesMerged) {
  if (!fs.existsSync(RAW_HR_DIR)) {
    console.log('ℹ️ data/heart_rate_raw/ neexistuje - preskakujem HR-based Strain.');
    return;
  }
  const files = fs.readdirSync(RAW_HR_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  if (files.length === 0) {
    console.log('ℹ️ V data/heart_rate_raw/ nie sú žiadne .csv súbory.');
    return;
  }
  const byDate = new Map();
  let filesRead = 0;
  for (const file of files) {
    const rows = parseHrCsv(path.join(RAW_HR_DIR, file));
    if (rows.length === 0) continue;
    filesRead++;
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push({ time: r.time, hr: r.hr });
    }
  }
  console.log(`💓 HR CSV: spracovaných súborov ${filesRead}/${files.length}, dní s dátami: ${byDate.size}`);

  const activitiesByDate = new Map();
  (activitiesMerged || []).forEach(act => {
    if (!act.date) return;
    if (!activitiesByDate.has(act.date)) activitiesByDate.set(act.date, []);
    activitiesByDate.get(act.date).push(act);
  });

  const existing = loadJsonSafe(HR_STRAIN_FILE);
  const existingObj = Array.isArray(existing) ? {} : existing; // loadJsonSafe defaultuje na [], tu chceme objekt
  for (const [date, dayRows] of byDate.entries()) {
    const dayActivities = activitiesByDate.get(date) || [];
    const { raw, minutes, avgHR, maxHR, activitySecondsUsed } = dayTrimp(dayRows, dayActivities);
    existingObj[date] = {
      strain: Math.round(hrRawToStrain(raw) * 10) / 10,
      raw: Math.round(raw * 10) / 10,
      minutes, avgHR, maxHR,
      preciseActivityMinutes: Math.round(activitySecondsUsed / 60),
      source: 'heart_rate_csv',
      computedAt: new Date().toISOString(),
    };
    console.log(`  ${date}: ${minutes} min CSV (${existingObj[date].preciseActivityMinutes} min presne zo zón aktivity), Ø${avgHR} max${maxHR} bpm → Strain ${existingObj[date].strain}`);
  }
  const sorted = {};
  Object.keys(existingObj).sort().forEach(d => { sorted[d] = existingObj[d]; });
  fs.writeFileSync(HR_STRAIN_FILE, JSON.stringify(sorted, null, 1));
  console.log(`✅ data/hr_strain_daily.json aktualizovaný (${Object.keys(sorted).length} dní spolu).`);
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

  // Samostatný try/catch - ak sa CSV spracovanie pokazí (napr. zlý formát súboru), Intervals.icu
  // sync vyššie je už bezpečne uložený a beh sa neoznačí ako zlyhaný kvôli tomuto.
  try {
    processHeartRateCsvs(activitiesMerged);
  } catch (e) {
    console.warn('⚠️ Spracovanie heart_rate_raw CSV zlyhalo (Intervals.icu sync vyššie je v poriadku):', e.message);
  }
}

main().catch(err => {
  console.error('❌ Chyba pri synchronizácii:', err.message);
  process.exit(1);
});
