// weather-plan.js
// Stiahne 8-dňovú predpoveď počasia pre Čadcu (Open-Meteo, zadarmo, žiadny API kľúč netreba),
// skombinuje s aktuálnou formou (CTL/ATL) a kalendárovými poznámkami, a pre dni BEZ vlastnej
// poznámky navrhne cez Gemini typ tréningu. Dni, kde už máš vlastný plán (day_notes.json), sa
// nepretláčajú - "ak nemám vlastný plán" bolo explicitná požiadavka.
//
// Očakáva: GEMINI_API_KEY (ak chýba, skript sa ticho ukončí)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LAT = 49.4386, LON = 18.7898; // Čadca, Slovensko
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

function loadJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function mergeById(existing, incoming, idField) {
  const map = new Map(existing.map(r => [r[idField], r]));
  for (const r of incoming) map.set(r[idField], r);
  return Array.from(map.values());
}

// WMO weather codes (Open-Meteo) -> stručný slovenský popis + emoji.
const WEATHER_CODES = {
  0: ['jasno', '☀️'], 1: ['prevažne jasno', '🌤️'], 2: ['polooblačno', '⛅'], 3: ['zamračené', '☁️'],
  45: ['hmla', '🌫️'], 48: ['mrznúca hmla', '🌫️'],
  51: ['slabé mrholenie', '🌦️'], 53: ['mrholenie', '🌦️'], 55: ['silné mrholenie', '🌧️'],
  61: ['slabý dážď', '🌦️'], 63: ['dážď', '🌧️'], 65: ['silný dážď', '🌧️'],
  71: ['slabé sneženie', '🌨️'], 73: ['sneženie', '🌨️'], 75: ['silné sneženie', '❄️'],
  80: ['prehánky', '🌦️'], 81: ['prehánky', '🌧️'], 82: ['silné prehánky', '⛈️'],
  95: ['búrka', '⛈️'], 96: ['búrka s krupobitím', '⛈️'], 99: ['silná búrka s krupobitím', '⛈️'],
};
function describeWeather(code) { return WEATHER_CODES[code] || ['neznáme', '❓']; }

// Open-Meteo dokumentácia je v rôznych zdrojoch nekonzistentná v pomenovaní parametrov
// (weathercode vs weather_code, windspeed_10m_max vs wind_speed_10m_max - staršia vs. novšia
// konvencia). Keďže zlý názov parametra spôsobí HTTP 400 pre CELÝ request, skúša sa najprv
// klasická konvencia a pri zlyhaní fallback na novšiu, namiesto tvrdého pádu.
async function fetchWeatherWithParams(dailyParams) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=${dailyParams}&timezone=Europe/Bratislava&forecast_days=8`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Open-Meteo API ${res.status}: ${txt}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
async function fetchWeather() {
  let data;
  try {
    data = await fetchWeatherWithParams('temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,weathercode');
  } catch (e) {
    console.warn('⚠️ Klasické názvy parametrov zlyhali, skúšam novšiu konvenciu (wind_speed_10m_max, weather_code):', e.message);
    data = await fetchWeatherWithParams('temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code');
  }
  const d = data.daily;
  const weatherCodeArr = d.weather_code || d.weathercode || [];
  const windArr = d.wind_speed_10m_max || d.windspeed_10m_max || [];
  return d.time.map((date, i) => ({
    date,
    tempMax: d.temperature_2m_max[i],
    tempMin: d.temperature_2m_min[i],
    precipMm: d.precipitation_sum[i],
    windMaxKmh: windArr[i],
    weatherCode: weatherCodeArr[i],
  }));
}

async function callGemini(prompt, opts) {
  opts = opts || {};
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.log('ℹ️ GEMINI_API_KEY nie je nastavený.'); return null; }
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  try {
    const generationConfig = { temperature: 0.7, maxOutputTokens: 1200 };
    if (opts.json) generationConfig.responseMimeType = 'application/json';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
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

function buildPlanPrompt(weatherDays, wellnessRecent, dayNotes, statusByDate) {
  const lines = [];
  lines.push(
    'Si osobný cyklistický/bežecký kouč. Na základe počasia a aktuálnej formy nižšie navrhni ' +
    'plán na najbližších 7 dní. Odpovedz IBA validným JSON poľom (žiadny markdown, žiadne ```) ' +
    'v tvare [{"date":"YYYY-MM-DD","suggestion":"..."}], jeden objekt na deň, len pre dni ' +
    'označené nižšie ako "BEZ VLASTNÉHO PLÁNU" - dni, kde už má vlastnú poznámku, VYNECHAJ ' +
    'úplne z výstupu (nepretláčaj sa do jeho vlastných plánov). "suggestion" = 1-2 vety, ' +
    'konkrétne (typ tréningu, orientačná dĺžka/zóny), zohľadňujúce počasie toho dňa (dážď/vietor/ ' +
    'teplota - napr. silný dážď -> radšej doma/rolky, alebo presuň von na iný deň v okne, ak to ' +
    'ide) a to, či je deň skôr na zotavenie alebo záťaž vzhľadom na okolité dni.'
  );
  lines.push('');
  lines.push('Predpoveď počasia (Čadca, Slovensko):');
  weatherDays.forEach(w => {
    const [desc] = describeWeather(w.weatherCode);
    const note = dayNotes.find(n => n.date === w.date);
    const status = statusByDate[w.date];
    const planLabel = (note && note.note && note.note.trim()) ? `MÁ VLASTNÝ PLÁN: "${note.note.trim()}"` : 'BEZ VLASTNÉHO PLÁNU';
    lines.push(`- ${w.date}: ${desc}, ${Math.round(w.tempMin)}-${Math.round(w.tempMax)}°C, zrážky ${w.precipMm}mm, vietor do ${Math.round(w.windMaxKmh)}km/h [${planLabel}]${status && status !== 'active' ? ' [stav: ' + status + ']' : ''}`);
  });
  lines.push('');
  if (wellnessRecent.length) {
    const last = wellnessRecent[wellnessRecent.length - 1];
    lines.push(`Aktuálna forma: CTL ${last.ctl != null ? last.ctl.toFixed(1) : '—'}, ATL ${last.atl != null ? last.atl.toFixed(1) : '—'} (k ${last.date}).`);
  }
  return lines.join('\n');
}

async function main() {
  console.log('Sťahujem predpoveď počasia pre Čadcu...');
  const weatherDays = await fetchWeather();

  const wellnessMerged = mergeById(
    loadJsonSafe(path.join(DATA_DIR, 'wellness_history.json'), []),
    loadJsonSafe(path.join(DATA_DIR, 'wellness_daily.json'), []), 'id'
  ).sort((a, b) => (a.date < b.date ? -1 : 1));
  const dayNotes = loadJsonSafe(path.join(DATA_DIR, 'day_notes.json'), []);
  const globalStatus = loadJsonSafe(path.join(DATA_DIR, 'status.json'), null);
  const statusByDate = {};
  weatherDays.forEach(w => {
    const note = dayNotes.find(n => n.date === w.date);
    statusByDate[w.date] = (note && note.status) ? note.status : (globalStatus && globalStatus.status) || 'active';
  });

  const prompt = buildPlanPrompt(weatherDays, wellnessMerged, dayNotes, statusByDate);
  console.log('Generujem plán (Gemini)...');
  const raw = await callGemini(prompt, { json: true });
  let suggestions = [];
  if (raw) {
    let jsonStr = raw.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    try { suggestions = JSON.parse(jsonStr); }
    catch (e) { console.warn('⚠️ Odpoveď z Gemini sa nedala naparsovať ako JSON:', e.message); }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    location: 'Čadca, Slovensko',
    days: weatherDays.map(w => {
      const [desc, emoji] = describeWeather(w.weatherCode);
      const note = dayNotes.find(n => n.date === w.date);
      const suggestion = suggestions.find(s => s.date === w.date);
      return {
        date: w.date,
        weatherDesc: desc,
        weatherEmoji: emoji,
        tempMax: w.tempMax,
        tempMin: w.tempMin,
        precipMm: w.precipMm,
        windMaxKmh: w.windMaxKmh,
        ownNote: (note && note.note) ? note.note : null,
        status: statusByDate[w.date] !== 'active' ? statusByDate[w.date] : null,
        aiSuggestion: suggestion ? suggestion.suggestion : null,
      };
    }),
  };
  fs.writeFileSync(path.join(DATA_DIR, 'weather_plan.json'), JSON.stringify(output, null, 1));
  console.log('✅ Plán podľa počasia uložený do data/weather_plan.json.');
}

main().catch(err => {
  console.error('❌ Chyba pri generovaní plánu:', err.message);
  process.exit(1);
});
