// sync.js
// Spúšťa GitHub Actions raz denne (plný sync) ALEBO na požiadanie z tlačidla v stránke
// (rýchly sync len posledných dní, cez workflow_dispatch input "days").
//
// Stiahne wellness (vrátane steps) + activities (vrátane HR zón pre Strain výpočet)
// z Intervals.icu a zlúči do data/wellness_daily.json a data/activities_daily.json.
//
// Očakáva premenné prostredia: ICU_API_KEY, ICU_ATHLETE_ID
// Voliteľné: SYNC_DAYS (koľko dní dozadu sťahovať, default 10)

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ICU_API_KEY;
const ATHLETE_ID = process.env.ICU_ATHLETE_ID;
const SYNC_DAYS = parseInt(process.env.SYNC_DAYS || '10', 10);

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
}

main().catch(err => {
  console.error('❌ Chyba pri synchronizácii:', err.message);
  process.exit(1);
});
