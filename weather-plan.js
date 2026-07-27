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
// PRÍČINA "Bez návrhu" bugu: ak primárny model vráti chybu (404 po vyradení, 429 po vyčerpaní
// free-tier kvóty, alebo dočasná nedostupnosť - typické pár dní po vydaní nového modelu), skript
// sa doteraz potichu vzdal a všetky dni bez vlastnej poznámky ostali navždy bez návrhu. Rovnaký
// princíp ako pri fetchWeatherWithParams nižšie: namiesto tvrdého vzdania sa skús postupne aj
// tieto zálohy, kým jedna neodpovie.
const FALLBACK_GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash'];

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

async function callGeminiOnce(model, key, prompt, opts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const generationConfig = { temperature: 0.7, maxOutputTokens: opts.maxOutputTokens || 1200 };
  if (opts.json) generationConfig.responseMimeType = 'application/json';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status} (model=${model}): ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  return text ? text.trim() : null;
}

// Skúša modely v poradí: env premenná GEMINI_MODEL (ak je nastavená) alebo DEFAULT_GEMINI_MODEL,
// potom FALLBACK_GEMINI_MODELS. Vráti { text, model } prvého modelu, ktorý naozaj odpovedal
// (nie null/prázdne), namiesto toho, aby jedno zlyhanie znamenalo "žiadny návrh na celý týždeň".
async function callGemini(prompt, opts) {
  opts = opts || {};
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.log('ℹ️ GEMINI_API_KEY nie je nastavený.'); return null; }
  const primary = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const models = [primary, ...FALLBACK_GEMINI_MODELS.filter(m => m !== primary)];
  for (const model of models) {
    try {
      const text = await callGeminiOnce(model, key, prompt, opts);
      if (text) {
        if (model !== primary) console.log(`ℹ️ Primárny model zlyhal, použitý záložný model: ${model}`);
        return { text, model };
      }
      console.warn(`⚠️ Gemini (model=${model}) vrátil prázdnu odpoveď, skúšam ďalší model...`);
    } catch (e) {
      console.warn(`⚠️ ${e.message} - skúšam ďalší model...`);
    }
  }
  console.warn('⚠️ Všetky Gemini modely zlyhali, plán ostane bez AI návrhov.');
  return null;
}

function buildPlanPrompt(weatherDays, wellnessRecent, dayNotes, statusByDate) {
  const lines = [];
  lines.push(
    'Si osobný cyklistický/bežecký kouč. Na základe počasia a aktuálnej formy nižšie navrhni pre ' +
    'KAŽDÝ deň označený nižšie ako "BEZ VLASTNÉHO PLÁNU" TRI rôzne alternatívy tréningu (nie tri ' +
    'preformulovania toho istého) - dni, kde už má vlastnú poznámku, VYNECHAJ úplne z výstupu ' +
    '(nepretláčaj sa do jeho vlastných plánov). Tri alternatívy na deň:\n' +
    '1) intensity="recovery" - regenerácia/voľno/veľmi ľahko,\n' +
    '2) intensity="endurance" - vytrvalostná jazda/beh v nižšej zóne, dlhšie trvanie,\n' +
    '3) intensity="intensity" - intervaly/tempo, kratšie ale náročnejšie.\n' +
    'Každú alternatívu prispôsob počasiu toho dňa (dážď/vietor/teplota - napr. silný dážď -> ' +
    'radšej doma/rolky aj pre "intensity" variant) a celkovému kontextu okolitých dní a aktuálnej ' +
    'formy (napr. pred/po náročnom dni uprav, čo dáva zmysel odporučiť). Odpovedz IBA validným ' +
    'JSON poľom (žiadny markdown, žiadne ```), presne v tvare:\n' +
    '[{"date":"YYYY-MM-DD","alternatives":[' +
    '{"label":"krátky názov 2-4 slová","intensity":"recovery","suggestion":"1-2 vety, konkrétne"},' +
    '{"label":"...","intensity":"endurance","suggestion":"..."},' +
    '{"label":"...","intensity":"intensity","suggestion":"..."}' +
    ']}]'
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
  // Vyššie maxOutputTokens ako predtým (1200 -> 2600) - odkedy sa pre každý deň pýtame na 3
  // alternatívy namiesto 1 návrhu, je výstupný JSON cca 3x dlhší a pri starom limite by sa
  // Gemini odpoveď mohla orezať uprostred JSON-u a celá sa nedala naparsovať (=> opäť "bez návrhu").
  const result = await callGemini(prompt, { json: true, maxOutputTokens: 2600 });
  const raw = result ? result.text : null;
  const usedModel = result ? result.model : (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
  let suggestions = [];
  if (raw) {
    let jsonStr = raw.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) suggestions = parsed;
      else console.warn('⚠️ Odpoveď z Gemini nie je JSON pole, ignorujem.');
    } catch (e) { console.warn('⚠️ Odpoveď z Gemini sa nedala naparsovať ako JSON:', e.message); }
  }

  const KNOWN_INTENSITIES = ['recovery', 'endurance', 'intensity'];
  const INTENSITY_LABELS = { recovery: 'Regenerácia', endurance: 'Vytrvalosť', intensity: 'Intenzita' };
  // Normalizuje a obmedzí to, čo Gemini vrátil pre jeden deň, na max 3 použiteľné alternatívy s
  // konzistentným tvarom (id/label/intensity/suggestion) - aj keby model vynechal label alebo
  // poslal neznámu hodnotu intensity, frontend dostane vždy rozumný tvar dát.
  function normalizeAlternatives(alts) {
    if (!Array.isArray(alts)) return [];
    return alts
      .filter(a => a && a.suggestion)
      .slice(0, 3)
      .map((a, i) => {
        const intensity = KNOWN_INTENSITIES.includes(a.intensity) ? a.intensity : 'endurance';
        return {
          id: ['a', 'b', 'c'][i] || String(i),
          label: a.label || INTENSITY_LABELS[intensity],
          intensity,
          suggestion: String(a.suggestion),
        };
      });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    model: usedModel,
    location: 'Čadca, Slovensko',
    days: weatherDays.map(w => {
      const [desc, emoji] = describeWeather(w.weatherCode);
      const note = dayNotes.find(n => n.date === w.date);
      const hasOwnNote = !!(note && note.note);
      const daySuggestion = suggestions.find(s => s.date === w.date);
      return {
        date: w.date,
        weatherDesc: desc,
        weatherEmoji: emoji,
        tempMax: w.tempMax,
        tempMin: w.tempMin,
        precipMm: w.precipMm,
        windMaxKmh: w.windMaxKmh,
        ownNote: hasOwnNote ? note.note : null,
        status: statusByDate[w.date] !== 'active' ? statusByDate[w.date] : null,
        // Dni s vlastným plánom nemajú alternatívy (rovnaká logika ako predtým pri aiSuggestion -
        // "ak nemám vlastný plán" bola explicitná požiadavka). Pre ostatné dni až 3 alternatívy,
        // ktoré si frontend (plan.html) vie prepínať a na základe voľby prepočítať okolité dni.
        alternatives: hasOwnNote ? [] : normalizeAlternatives(daySuggestion && daySuggestion.alternatives),
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
