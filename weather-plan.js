// weather-plan.js
// Stiahne 10-dňovú predpoveď počasia pre Čadcu (Open-Meteo, zadarmo, žiadny API kľúč netreba),
// skombinuje s aktuálnou formou (CTL/ATL) a kalendárovými poznámkami, a cez Gemini pripraví návrh
// na každý deň:
//  - Dni BEZ vlastnej poznámky: 4 alternatívy tréningu (rest/long/intensity/indoor), viď
//    KNOWN_INTENSITIES nižšie.
//  - Dni, kde už máš vlastný plán (day_notes.json): AI negeneruje alternatívy (nepretláča sa do
//    toho, ČO si sa rozhodol robiť), ale vráti "notePlan" - krajšie sformulovanú verziu tvojej
//    poznámky doplnenú o konkrétne odporúčanie ako ju ísť (dĺžka/zóny/tempo podľa počasia). Ak sa
//    to nevygeneruje (chyba/orezaná odpoveď), frontend padá späť na tvoju surovú poznámku.
//
// OPRAVA 5.8.2026 (nahlásené Adamom): predtým sa dni s vlastnou poznámkou úplne vynechávali z AI
// generovania ("ak nemám vlastný plán" bola pôvodná explicitná požiadavka) - teraz sa aj pre ne
// generuje AI návrh (notePlan), len iným spôsobom než pre voľné dni.
//
// Dva režimy behu:
//  1) Normálne generovanie (žiadny PLAN_EDIT_INSTRUCTION) - stiahne čerstvé počasie a vygeneruje
//     kompletne nový plán, presne ako predtým.
//  2) Úprava existujúceho plánu (PLAN_EDIT_INSTRUCTION nastavený, napr. z tlačidla "Upraviť plán"
//     na stránke) - NEGENERUJE nový plán od nuly, ale pošle Gemini aktuálny plán + pokyn
//     používateľa (napr. "skráť dnešný tréning na 60 minút", "presuň intervaly na zajtra") a
//     upraví iba dni, ktorých sa pokyn reálne týka. PLAN_CURRENT_SELECTION (JSON mapa
//     dátum->index aktuálne vybranej alternatívy z prehliadača) hovorí AI, čo si používateľ práve
//     pozerá, keďže výber alternatívy žije len v localStorage prehliadača, nie v tomto súbore.
//
// Očakáva: GEMINI_API_KEY (ak chýba, skript sa ticho ukončí)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PLAN_FILE = path.join(DATA_DIR, 'weather_plan.json');
const LAT = 49.4386, LON = 18.7898; // Čadca, Slovensko
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
// PRÍČINA starého "Bez návrhu" bugu: ak primárny model vráti chybu (404 po vyradení, 429 po
// vyčerpaní free-tier kvóty, alebo dočasná nedostupnosť - typické pár dní po vydaní nového
// modelu), skript sa doteraz potichu vzdal a všetky dni bez vlastnej poznámky ostali navždy bez
// návrhu. Rovnaký princíp ako pri fetchWeatherWithParams nižšie: namiesto tvrdého vzdania sa
// skús postupne aj tieto zálohy, kým jedna neodpovie.
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

// Dĺžka hľadaného súvislého okna (v hodinách) a rozumný denný rozsah, v ktorom sa vôbec oplatí
// hľadať (nemá zmysel odporučiť "najlepšie okno" o 3:00 ráno).
const TRAINING_WINDOW_HOURS = 4;
const TRAINING_DAY_START_HOUR = 5;
const TRAINING_DAY_END_HOUR = 22;
// OPRAVA 30.7.2026 (nahlásené Adamom): hľadanie okna predtým prehľadávalo celý deň 5:00-22:00 a
// vždy vyhralo okno s najnižšou šancou dažďa bez ohľadu na dennú dobu - v praxi to takmer vždy
// vyšlo na skoré ráno (napr. "05:00-09:00, šanca dažďa 0%"), keďže skoro ráno býva štatisticky
// najstabilnejšie počasie. Adam ale v tom čase nikdy netrénuje (raňajkuje okolo 8:00) - chce
// primárne poobedné okno. Preto sa teraz hľadá NAJPRV len v PREFERRED rozsahu (poobede/podvečer);
// na celý pôvodný rozsah (FALLBACK, vrátane rána) sa siahne LEN ak v preferovanom okne vôbec nie
// je dosť hodinových dát alebo by tam priemerná šanca dažďa bola vyslovene zlá (nad
// FALLBACK_RAIN_THRESHOLD %) a mimo neho je preukázateľne podstatne lepšie okno - aby aj v daždivé
// dni Adam dostal aspoň nejaké odporúčanie, len jasne označené, že je mimo jeho zvyčajného času.
const PREFERRED_WINDOW_START_HOUR = 12;
const PREFERRED_WINDOW_END_HOUR = 21;
const FALLBACK_RAIN_THRESHOLD = 50; // % - nad touto hranicou sa oplatí pozrieť aj mimo preferovaného rozsahu

// Z hodinovej pravdepodobnosti zrážok (Open-Meteo `precipitation_probability`, v %) nájde pre daný
// deň najlepšie súvislé okno dĺžky TRAINING_WINDOW_HOURS s najnižšou priemernou šancou dažďa, v
// zadanom rozsahu hodín. Vráti null, ak pre daný deň/rozsah chýbajú/nestačia hodinové dáta.
function bestWindowInRange(dayHours, startHour, endHour) {
  const inRange = dayHours.filter(h => h.hour >= startHour && h.hour <= endHour);
  if (inRange.length < TRAINING_WINDOW_HOURS) return null;
  let best = null;
  for (let i = 0; i <= inRange.length - TRAINING_WINDOW_HOURS; i++) {
    const slice = inRange.slice(i, i + TRAINING_WINDOW_HOURS);
    const contiguous = slice.every((h, idx) => idx === 0 || h.hour === slice[idx - 1].hour + 1);
    if (!contiguous) continue; // medzera v dátach (chýbajúca hodina) - okno nie je naozaj súvislé
    const avg = slice.reduce((s, h) => s + h.prob, 0) / slice.length;
    if (!best || avg < best.avg) {
      best = { startHour: slice[0].hour, endHour: slice[slice.length - 1].hour + 1, avg };
    }
  }
  return best;
}

// Vráti { start, end, avgRainProb, outsidePreferred } - posledné pole true, ak sa muselo siahnuť
// mimo preferovaného poobedného rozsahu (frontend/prompt to môže dať najavo, napr. iným textom).
function bestWindowForDay(hourlyTimes, hourlyProb, date) {
  const dayHours = [];
  for (let i = 0; i < hourlyTimes.length; i++) {
    if (hourlyTimes[i].slice(0, 10) === date) {
      const hour = parseInt(hourlyTimes[i].slice(11, 13), 10);
      if (hour >= TRAINING_DAY_START_HOUR && hour <= TRAINING_DAY_END_HOUR && hourlyProb[i] != null) {
        dayHours.push({ hour, prob: hourlyProb[i] });
      }
    }
  }
  dayHours.sort((a, b) => a.hour - b.hour);

  const preferred = bestWindowInRange(dayHours, PREFERRED_WINDOW_START_HOUR, PREFERRED_WINDOW_END_HOUR);
  const fallback = bestWindowInRange(dayHours, TRAINING_DAY_START_HOUR, TRAINING_DAY_END_HOUR);

  let chosen = preferred;
  let outsidePreferred = false;
  if (!preferred) {
    chosen = fallback; // v preferovanom rozsahu nič (napr. koniec 8-dňového okna má neúplné dáta)
    outsidePreferred = !!fallback;
  } else if (fallback && preferred.avg > FALLBACK_RAIN_THRESHOLD && fallback.avg < preferred.avg - 15) {
    // Poobedie je vyslovene zlé (>50 % šanca dažďa) a mimo neho je citeľne lepšie okno - ponúkni
    // radšej to, len označené ako mimo zvyčajného času, namiesto vnucovania zlého poobedia.
    chosen = fallback;
    outsidePreferred = true;
  }
  if (!chosen) return null;
  return {
    start: String(chosen.startHour).padStart(2, '0') + ':00',
    end: String(chosen.endHour).padStart(2, '0') + ':00',
    avgRainProb: Math.round(chosen.avg),
    outsidePreferred,
  };
}

// Kompletný hodinový rozpis daného dňa (5:00-22:00) - šanca dažďa a teplota za každú hodinu, na
// zobrazenie po kliknutí na deň (plan.html). Netreba filtrovať/vyberať okno, frontend si zobrazí
// všetko a Adam sám vidí, kedy presne prší/neprší.
function hourlyBreakdownForDay(hourlyTimes, hourlyProb, hourlyTemp, date) {
  const hours = [];
  for (let i = 0; i < hourlyTimes.length; i++) {
    if (hourlyTimes[i].slice(0, 10) === date) {
      const hour = parseInt(hourlyTimes[i].slice(11, 13), 10);
      if (hour >= TRAINING_DAY_START_HOUR && hour <= TRAINING_DAY_END_HOUR) {
        hours.push({
          hour,
          rainProb: hourlyProb[i] != null ? hourlyProb[i] : null,
          temp: hourlyTemp && hourlyTemp[i] != null ? Math.round(hourlyTemp[i] * 10) / 10 : null,
        });
      }
    }
  }
  hours.sort((a, b) => a.hour - b.hour);
  return hours;
}

// Open-Meteo dokumentácia je v rôznych zdrojoch nekonzistentná v pomenovaní denných parametrov
// (weathercode vs weather_code, windspeed_10m_max vs wind_speed_10m_max - staršia vs. novšia
// konvencia). Keďže zlý názov parametra spôsobí HTTP 400 pre CELÝ request, skúša sa najprv
// klasická konvencia a pri zlyhaní fallback na novšiu, namiesto tvrdého pádu. Hodinová
// `precipitation_probability` má stabilný názov naprieč verziami, tá fallback nepotrebuje.
async function fetchWeatherWithParams(dailyParams) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=${dailyParams}&hourly=precipitation_probability,temperature_2m&timezone=Europe/Bratislava&forecast_days=10`;
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
  const h = data.hourly || {};
  const hourlyTimes = h.time || [];
  const hourlyProb = h.precipitation_probability || [];
  const hourlyTemp = h.temperature_2m || [];
  const weatherCodeArr = d.weather_code || d.weathercode || [];
  const windArr = d.wind_speed_10m_max || d.windspeed_10m_max || [];
  return d.time.map((date, i) => ({
    date,
    tempMax: d.temperature_2m_max[i],
    tempMin: d.temperature_2m_min[i],
    precipMm: d.precipitation_sum[i],
    windMaxKmh: windArr[i],
    weatherCode: weatherCodeArr[i],
    bestWindow: bestWindowForDay(hourlyTimes, hourlyProb, date),
    hourly: hourlyBreakdownForDay(hourlyTimes, hourlyProb, hourlyTemp, date),
  }));
}

// POZOR (rovnaký koreň problému ako v ai-summary.js/sync.js, zistené 30.7.2026): Gemini 3.x
// modely (flash aj flash-lite) majú defaultne zapnuté interné "thinking" tokeny, ktoré sa
// POČÍTAJÚ do maxOutputTokens, ale nie sú vidno vo výstupe. Tento skript pýta výrazne väčší JSON
// než ai-summary.js (10 dní × 4 alternatívy), takže aj pri maxOutputTokens 2600 sa dalo ľahko stať,
// že model minul rozpočet na neviditeľné rozmýšľanie a viditeľný JSON sa orezal uprostred -
// JSON.parse zlyhal, suggestions=[] a ÚPLNE VŠETKY dni skončili ako "Bez návrhu". Riešenie:
// 1) thinkingConfig.thinkingLevel='low' (Gemini 3.x - NIE thinkingBudget, to je len pre 2.5 sériu
//    a na 3.x model by vrátilo 400 Bad Request), 2) vyšší maxOutputTokens ako rezerva, 3) kontrola
//    finishReason - ak model odpoveď orezal (MAX_TOKENS), NEPOUŽIJE sa jeho (nevalidný) text, ale
//    hodí sa chyba, aby to callGemini() nižšie skúsilo s ďalším záložným modelom namiesto toho,
//    aby sa jeden orezaný pokus vydával za konečný výsledok pre všetky dni naraz.
function thinkingConfigFor(model) {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: 'low' };
}

async function callGeminiOnce(model, key, prompt, opts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const generationConfig = {
    temperature: 0.7,
    maxOutputTokens: opts.maxOutputTokens || 1200,
    thinkingConfig: thinkingConfigFor(model),
  };
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
  const candidate = data && data.candidates && data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts
    && candidate.content.parts[0] && candidate.content.parts[0].text;
  const finishReason = candidate && candidate.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    throw new Error(`Gemini (model=${model}) finishReason=${finishReason} - odpoveď pravdepodobne orezaná/nekompletná`);
  }
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
  console.warn('⚠️ Všetky Gemini modely zlyhali.');
  return null;
}

// ---------- Normalizácia alternatív (spoločná pre generovanie aj úpravu) ----------
// OPRAVA 5.8.2026 (nahlásené Adamom): pôvodné recovery/endurance/intensity trio bolo príliš
// vágne, chýbali skutočné opozitá (poriadne voľno vs. poriadny objem) a chýbala samostatná
// indoor možnosť - "indoor" sa predtým len niekedy spomenul VNÚTRI textu iného variantu, čo bolo
// v praxi zbytočné, lebo si to nešlo vybrať ako vlastnú alternatívu. Teraz 4 jasne odlíšené póly.
const KNOWN_INTENSITIES = ['rest', 'long', 'intensity', 'indoor'];
const INTENSITY_LABELS = {
  rest: 'Voľno',
  long: 'Dlhá jazda',
  intensity: 'Intervaly',
  indoor: 'Indoor',
};
// Normalizuje a obmedzí to, čo Gemini vrátil pre jeden deň, na max 4 použiteľné alternatívy s
// konzistentným tvarom (id/label/intensity/suggestion/recommended) - aj keby model vynechal label
// alebo poslal neznámu hodnotu intensity, frontend dostane vždy rozumný tvar dát. Poradie sa
// zachováva podľa toho, čo vrátil model (generovací aj edit prompt ho žiadajú v poradí
// rest/long/intensity/indoor), aby si výber alternatívy v prehliadači (index 0/1/2/3) držal
// rovnaký význam aj po úprave existujúceho plánu.
// OPRAVA 8.8.2026 (nahlásené Adamom - plán vyzeral, akoby dával "veľa oddychu" viacero dní po
// sebe): to nebola AI, ale frontend (plan.html) - kým používateľ na nič neklikol, VŽDY zobrazoval
// ako aktívnu alternatívu index 0, čo je teraz vždy "rest". AI reálne pre každý deň mohla mať úplne
// iný názor, len sa to nikde neprejavilo. Odteraz AI musí pre každý deň označiť presne JEDNU
// alternatívu ako "recommended":true (na základe posúdenia celého obdobia) - frontend potom ako
// predvolenú zobrazí TÚTO, nie mechanicky prvú v poradí. Tu sa to defenzívne normalizuje: ak AI
// označí viac než jednu, platí prvá; ak neoznačí žiadnu, žiadna nemá recommended=true a frontend
// má vlastný fallback na index 0 (pozri plan.html).
// OPRAVA 13.8.2026 (žiadosť Adama): výživové odporúčanie bolo predtým vopchané priamo do
// "suggestion" textu (blokovalo čitateľnosť). Teraz je to samostatné pole "fuelPlan" - podrobnejšie
// (pred jazdou + hodinu po hodine počas), zobrazené na plan.html až po kliknutí na 🍌, nie vždy.
// Prítomné len tam, kde to dáva zmysel (dlhší/namáhavý tréning) - inak null.
function normalizeAlternatives(alts) {
  if (!Array.isArray(alts)) return [];
  let recommendedUsed = false;
  return alts
    .filter(a => a && a.suggestion)
    .slice(0, 4)
    .map((a, i) => {
      const intensity = KNOWN_INTENSITIES.includes(a.intensity) ? a.intensity : 'long';
      let recommended = !!a.recommended;
      if (recommended && recommendedUsed) recommended = false; // druhé a ďalšie "recommended" sa ignorujú
      if (recommended) recommendedUsed = true;
      return {
        id: ['a', 'b', 'c', 'd'][i] || String(i),
        label: a.label || INTENSITY_LABELS[intensity],
        intensity,
        suggestion: String(a.suggestion),
        recommended,
        fuelPlan: a.fuelPlan ? String(a.fuelPlan) : null,
      };
    });
}

function weatherLineFor(date, weatherDesc, tempMin, tempMax, precipMm, windMaxKmh, planLabel, statusTxt, bestWindow, doneActivitiesTxt) {
  const windowTxt = bestWindow
    ? ` [najlepšie okno: ${bestWindow.start}-${bestWindow.end}, šanca dažďa ${bestWindow.avgRainProb}%` +
      `${bestWindow.outsidePreferred ? ', mimo zvyčajného poobedného času' : ''}]`
    : '';
  const doneTxt = doneActivitiesTxt ? ` [UŽ ABSOLVOVANÉ DNES: ${doneActivitiesTxt}]` : '';
  return `- ${date}: ${weatherDesc}, ${Math.round(tempMin)}-${Math.round(tempMax)}°C, zrážky ${precipMm}mm, ` +
    `vietor do ${Math.round(windMaxKmh)}km/h [${planLabel}]${statusTxt}${windowTxt}${doneTxt}`;
}

// Krátky ľudsky čitateľný súhrn už zaznamenaných aktivít pre daný deň (napr. "30min Ride (Z2,
// Load 9), 5min Run" ) - použité najmä pre DNEŠNÝ deň, aby AI vedelo, že časť/celý tréning už
// reálne prebehol a nenavrhovalo duplicitne ďalší plnohodnotný tréning, akoby sa deň ešte
// nezačal. Pre staršie dni v okne (zajtra a ďalej) toto typicky bude prázdne.
function doneActivitiesSummary(dayActivities) {
  if (!dayActivities || !dayActivities.length) return '';
  return dayActivities.map(a => {
    const mins = a.moving_time ? Math.round(a.moving_time / 60) : null;
    const loadTxt = a.icu_training_load != null ? `, Load ${Math.round(a.icu_training_load)}` : '';
    const hrTxt = a.average_heartrate ? `, Ø${Math.round(a.average_heartrate)}bpm` : '';
    return `${mins != null ? mins + 'min ' : ''}${a.type || a.name || 'aktivita'}${loadTxt}${hrTxt}`;
  }).join('; ');
}

function buildPlanPrompt(weatherDays, wellnessRecent, dayNotes, statusByDate, activitiesByDate, recentPastDays) {
  const todayDate = weatherDays.length ? weatherDays[0].date : null;
  const lines = [];
  lines.push(
    'Si osobný cyklistický/bežecký kouč. Na základe počasia a aktuálnej formy nižšie priprav pre ' +
    'KAŽDÝ deň nižšie presne jeden z dvoch výstupov, podľa toho, ako je označený:\n\n' +
    'A) Dni označené "BEZ VLASTNÉHO PLÁNU": navrhni ŠTYRI rôzne alternatívy tréningu (nie štyri ' +
    'preformulovania toho istého), v tomto poradí a presne s týmito hodnotami "intensity":\n' +
    '1) intensity="rest" - SKUTOČNÉ voľno/úplný regeneračný deň (žiadny tréning, prípadne len ' +
    'veľmi ľahký pohyb/strečing) - nie "ľahká jazda", ale reálne voľno,\n' +
    '2) intensity="long" - vytrvalostná/DLHŠIA jazda alebo beh v nižšej zóne, citeľne väčší objem ' +
    'než bežný deň - toto má byť skutočný OPAK alternatívy "rest", nie jej mierne obmenená verzia,\n' +
    '3) intensity="intensity" - intervaly/tempo, kratšie trvanie ale náročné,\n' +
    '4) intensity="indoor" - SAMOSTATNÁ konkrétna indoor alternatíva (trenažér/rolky, beh na ' +
    'páse, posilňovňa, plávanie a pod.), NIE len poznámka pri inom variante ako doteraz, ale ' +
    'reálna štvrtá voliteľná možnosť pre zlé počasie, nedostatok času vonku, alebo keď sa mu von ' +
    'jednoducho nechce.\n' +
    '"rest" a "long" musia vyjsť ako skutočné opačné póly (celkom voľno vs. poriadny objem), nie ' +
    'dve stredné cesty, ktoré vyzerajú skoro rovnako. Navyše pri KAŽDEJ zo 4 alternatív nastav ' +
    'pole "recommended" (boolean) - presne JEDNA zo 4 má "recommended":true (tá, ktorú by si mu ' +
    'reálne odporučil urobiť tento konkrétny deň, ostatné "recommended":false), pozri nižšie ' +
    '"CELÉ OBDOBIE POSUDZUJ SPOLU" - tento výber sa použije ako predvolene zobrazená alternatíva, ' +
    'preto musí naozaj odzrkadľovať tvoje odporúčanie pre daný deň v kontexte celého obdobia, nie ' +
    'mechanicky vždy prvú v poradí.\n\n' +
    'B) Dni označené "MÁ VLASTNÝ PLÁN": TU NEGENERUJ štyri alternatívy. Namiesto toho zober jeho ' +
    'vlastnú poznámku (čo si už sám naplánoval) a vráť JEDNU vec - kratšie a krajšie sformulovanú ' +
    'verziu jeho plánu DOPLNENÚ o konkrétne odporúčanie, ako ho ísť (orientačná dĺžka/objem, ' +
    'zóny/tempo, na čo si dať pozor vzhľadom na počasie toho dňa a nedávnu záťaž). NIKDY nemeň, ' +
    'ČO si naplánoval (napr. ak napísal "idem na túru", nenavrhuj namiesto toho bicykel) - len to ' +
    'vylepši a doplň o praktickú radu. Toto vráť v poli "notePlan" (2-4 vety) - takýto deň v ' +
    'odpovedi NEMÁ pole "alternatives". K nemu navyše priprav DVE malé polia, aby sa dal tento deň ' +
    'zaradiť do prehľadov rovnako ako bežné dni:\n' +
    '   - "noteLabel": VEĽMI krátke zhrnutie 2-4 slová (napr. "Dlhý výjazd s Danom", "Prehliadka ' +
    'Prahy", "Sila v posilňovni") - použije sa v kompaktných prehľadoch, kde na plnú vetu nie je ' +
    'miesto.\n' +
    '   - "noteIntensity": over, ČO jeho poznámka fakticky znamená z hľadiska záťaže, a priraď ' +
    'JEDNU z rovnakých 4 hodnôt ako vyššie (rest/long/intensity/indoor) - napr. "žiadny tréning, ' +
    'oddych" alebo "pešia prehliadka mesta" = "rest", "dlhý výjazd X hodín" = "long", "intervaly/' +
    'preteky" = "intensity", "trenažér/posilňovňa" = "indoor". Toto je DÔLEŽITÉ pre presnosť ' +
    'iných častí appky - klasifikuj podľa skutočného obsahu poznámky, nie automaticky "long" pre ' +
    'každý deň s vlastným plánom.\n\n' +
    'VÝŽIVA/PITNÝ REŽIM ("fuelPlan"): pri KAŽDEJ alternatíve typu A aj pri type B (vtedy vedľa ' +
    '"notePlan"), kde ide o reálne dlhší alebo namáhavý tréning VONKU alebo na trenažéri (typicky ' +
    '"long", "intensity", dlhšie "indoor" sedenie, alebo poznámka s dlhšou aktivitou) - teda NIE ' +
    'pri "rest" a NIE pri krátkych/ľahkých sedeniach, tam nechaj "fuelPlan":null - priprav ' +
    'SAMOSTATNÉ pole "fuelPlan" (string, 3-6 viet, NIE súčasť "suggestion"/"notePlan" textu) s ' +
    'konkrétnym plánom v tomto duchu:\n' +
    '   - Pred tréningom: čo zjesť/vypiť a kedy (napr. koľko hodín vopred, čo ľahko stráviteľné).\n' +
    '   - Počas tréningu, ROZDELENÉ PODĽA ČASU (napr. "prvú hodinu len voda, od 2. hodiny...", ' +
    'alebo "každých 20-30 min dúšok" pri kratších sedeniach) - koľko g sacharidov za hodinu ' +
    'celkovo (podľa dĺžky/intenzity) a KONKRÉTNE jedlo/nápoj na dosiahnutie toho - striedaj medzi ' +
    'pitným izotonickým nápojom a pevnou stravou. Adam má často k dispozícii banány a gumové ' +
    '"žížalky" (gumcukríky) - použi ich ako konkrétne návrhy, kľudne aj iné bežné cyklistické ' +
    'jedlo (energetická tyčinka, sušené ovocie, biely rožok/med a pod.), nech to nie je len ' +
    'abstraktné "sacharidy".\n' +
    '   - Pitný režim: Adam má presne 3 fľaše s celkovou kapacitou 2650 ml (2× 950 ml + 1× 750 ' +
    'ml) a robí si vlastný izotonický nápoj - do každej fľaše zvyčajne 60-80 g bieleho cukru a ' +
    '3-6 g soli. Odporúčanie priprav v RÁMCI/blízko tohto jeho zvyčajného rozsahu (napr. "naplň ' +
    'obe 950 ml fľaše, do každej ~70 g cukru a 4 g soli" alebo pri väčšej horúčave/dĺžke "aj ' +
    'tretiu 750 ml fľašu, o niečo viac soli"), NEVYMÝŠĽAJ úplne inú receptúru.\n\n' +
    'Obe (alternatívy aj notePlan) - teda ich "suggestion"/"notePlan" text, BEZ výživy, tá je ' +
    'oddelene vo "fuelPlan" - prispôsob počasiu toho dňa (dážď/vietor/teplota) a celkovému ' +
    'kontextu okolitých dní a aktuálnej formy (napr. pred/po náročnom dni uprav, čo dáva zmysel ' +
    'odporučiť). Ak je pri dni uvedené "najlepšie okno" (súvislý časový úsek s najnižšou ' +
    'pravdepodobnosťou dažďa), zohľadni ho a v texte (najmä pri "long"/"intensity" variante alebo ' +
    'v notePlan, kde je dĺžka vonku dlhšia) stručne spomeň orientačný čas, kedy je najvhodnejšie ' +
    'ísť trénovať - toto okno je zámerne hľadané prednostne v poobedných/podvečerných hodinách ' +
    '(Adam ráno väčšinou netrénuje), takže ak nie je označené ako "mimo zvyčajného poobedného ' +
    'času", NENAVRHUJ radšej skoré ráno len preto, že by tam bola o pár % nižšia šanca dažďa.\n' +
    `DÔLEŽITÉ - AK je pri dni uvedené "UŽ ABSOLVOVANÉ DNES" (týka sa to prakticky vždy len ` +
    `dnešného dňa, ${todayDate || 'prvý deň v zozname'}): túto aktivitu už reálne vykonal, deň sa ` +
    'pre neho z tréningového hľadiska už čiastočne/úplne odohral - NENAVRHUJ žiadnu z alternatív ' +
    '(ani notePlan) ako keby sa deň ešte len začínal. Namiesto toho: ak už absolvovaná aktivita ' +
    'svojím objemom/záťažou zodpovedá plnohodnotnému tréningu dňa, "rest" alternatíva (alebo ' +
    'notePlan, ak má vlastnú poznámku) nech je jednoducho pochvala/potvrdenie že už má odtrénované ' +
    'a odporúčanie oddychu do konca dňa (a spravidla by mala byť aj "recommended":true), a ostatné ' +
    'alternatívy nech sú buď ĽAHKÝ DOPLNOK (nie duplicitný plnohodnotný druhý tréning) alebo návrh, ' +
    'dokedy ešte dnes prípadne pridať niečo malé, ak by chcel. Text nech explicitne spomenie, že ' +
    'už dnes niečo absolvoval (napr. "keďže si už dnes odjazdil X min, ..."). Pre dni BEZ poznámky ' +
    '"UŽ ABSOLVOVANÉ" postupuj úplne štandardne.\n' +
    'DÔLEŽITÉ - CELÉ OBDOBIE POSUDZUJ SPOLU, NIE DEŇ PO DNI IZOLOVANE: pozri sa na VŠETKY dni ' +
    'nižšie naraz (aj na "Posledných X dní" - čo už reálne predchádzalo, ak je uvedené) a dbaj, ' +
    'aby "recommended" voľby medzi dňami dávali zmysel ako celok - napr. deň PRED plánovaným ' +
    'náročným/dlhým dňom (vlastná poznámka aj alternatíva) nech spravidla odporúča "rest", nie ' +
    '"intensity". Konkrétne: NEODPORÚČAJ (t.j. "recommended":true nedávaj na) "rest"/voľno na 3 a ' +
    'viac dní PO SEBE, pokiaľ to jasne nevyžaduje kontext (napr. bezprostredne pred tým niekoľko ' +
    'veľmi náročných dní za sebou, choroba/extrémna únava spomenutá v poznámke). Zlé počasie viac ' +
    'dní po sebe (horúčava, dážď) NIE JE samo o sebe dôvod odporúčať viacdňové voľno - presne na ' +
    'to slúži samostatná "indoor" alternatíva, tú v takom prípade odporuč namiesto tlačenia na ' +
    '"rest". Ak z kontextu (nedávna záťaž, "Posledných X dní") vyplýva, že si už oddýchol, ' +
    'uprednostni skôr "long"/"indoor" možnosť pred ďalším odporúčaným "rest" dňom, aj keď vonku ' +
    'prší.\n' +
    'Odpovedz IBA validným JSON poľom (žiadny markdown, žiadne ```). Každý prvok má "date" a BUĎ ' +
    '"alternatives" (presne 4 položky v poradí rest/long/intensity/indoor, pre typ A dni) ALEBO ' +
    '"notePlan"+"noteLabel"+"noteIntensity" (pre typ B dni) - nikdy oboje naraz. Presný tvar:\n' +
    '[{"date":"YYYY-MM-DD","alternatives":[' +
    '{"label":"krátky názov 2-4 slová","intensity":"rest","suggestion":"1-2 vety, konkrétne","recommended":false,"fuelPlan":null},' +
    '{"label":"...","intensity":"long","suggestion":"...","recommended":true,"fuelPlan":"pred jazdou.. počas prvej hodiny.. potom.. pitný režim.."},' +
    '{"label":"...","intensity":"intensity","suggestion":"...","recommended":false,"fuelPlan":null},' +
    '{"label":"...","intensity":"indoor","suggestion":"...","recommended":false,"fuelPlan":null}' +
    ']},' +
    '{"date":"YYYY-MM-DD","notePlan":"krajšie sformulovaný plán + konkrétne odporúčanie ako ho ísť","noteLabel":"krátke zhrnutie","noteIntensity":"long","fuelPlan":"..."}]'
  );
  lines.push('');
  if (recentPastDays && recentPastDays.length) {
    lines.push(
      `Posledných ${recentPastDays.length} dní PRED dnešným dňom (už sa odohrali - iba pre ` +
      'kontext ohľadom formy/únavy/toho, koľko oddychu už mal, NIE je to súčasť plánovaného ' +
      'obdobia a nič sa tu nenavrhuje):'
    );
    recentPastDays.forEach(p => {
      const strainTxt = p.strain != null ? `Strain ${p.strain}` : 'Strain —';
      const actTxt = p.activitiesTxt ? `, aktivity: ${p.activitiesTxt}` : ', bez zaznamenanej aktivity';
      lines.push(`- ${p.date}: ${strainTxt}${actTxt}`);
    });
    lines.push('');
  }
  lines.push('Predpoveď počasia (Čadca, Slovensko) - toto JE plánované obdobie:');
  weatherDays.forEach(w => {
    const [desc] = describeWeather(w.weatherCode);
    const note = dayNotes.find(n => n.date === w.date);
    const status = statusByDate[w.date];
    const planLabel = (note && note.note && note.note.trim()) ? `MÁ VLASTNÝ PLÁN: "${note.note.trim()}"` : 'BEZ VLASTNÉHO PLÁNU';
    const statusTxt = status && status !== 'active' ? ' [stav: ' + status + ']' : '';
    const doneTxt = doneActivitiesSummary(activitiesByDate ? activitiesByDate[w.date] : null);
    lines.push(weatherLineFor(w.date, desc, w.tempMin, w.tempMax, w.precipMm, w.windMaxKmh, planLabel, statusTxt, w.bestWindow, doneTxt));
  });
  lines.push('');
  if (wellnessRecent.length) {
    const last = wellnessRecent[wellnessRecent.length - 1];
    lines.push(`Aktuálna forma: CTL ${last.ctl != null ? last.ctl.toFixed(1) : '—'}, ATL ${last.atl != null ? last.atl.toFixed(1) : '—'} (k ${last.date}).`);
  }
  return lines.join('\n');
}

// Prompt pre režim "úprava existujúceho plánu podľa pokynu" - namiesto počasia/formy odznova
// posiela AKTUÁLNY stav plánu (vrátane toho, ktorú alternatívu má užívateľ práve vybranú v
// prehliadači) a jeden voľný pokyn, ktorý hovorí, čo treba zmeniť.
function buildEditPrompt(existingPlan, currentSelection, instruction) {
  const lines = [];
  lines.push(
    'Si osobný cyklistický/bežecký kouč. Nižšie je AKTUÁLNY tréningový plán na najbližšie dni - ' +
    'pre dni bez vlastnej poznámky vidíš všetky 4 momentálne alternatívy (rest/long/intensity/' +
    'indoor), ktorá z nich je momentálne "recommended" (⭐) a ktorú z nich má užívateľ práve ' +
    'ručne vybranú (VYBRANÉ), ak sa to líši. Toto NIE JE požiadavka na nové generovanie od nuly - ' +
    'len na úpravu existujúceho plánu podľa pokynu používateľa.\n\n' +
    `POKYN OD POUŽÍVATEĽA: "${instruction}"\n\n` +
    'Uprav LEN tie dni, ktorých sa pokyn reálne týka (napr. "skráť dnešný tréning na 60 minút" = ' +
    'len dnešok; "presuň intervaly na zajtra" = dnešok aj zajtrajšok; "cítim sa dnes unavený, ' +
    'uprav plán" = najbližší deň, prípadne aj deň po ňom, ak to dáva zmysel kvôli nadväznosti). ' +
    'Dni, ktorých sa pokyn netýka, VYNECHAJ úplne z výstupu - ich pôvodné alternatívy ostanú ' +
    'nezmenené. Dni s vlastným plánom (nižšie označené "MÁ VLASTNÝ PLÁN") NIKDY neuprav a ' +
    'nezaraď do výstupu - tie sú mimo dosahu AI úprav. Pre každý upravovaný deň vráť znova ' +
    'VŠETKY 4 alternatívy v rovnakom poradí podľa intenzity (rest, long, intensity, indoor) - aj ' +
    'tie, ktoré vecne nemeníš, len ich preformuluj/zachovaj - vrátane poľa "recommended" (presne ' +
    'jedna z 4 má true; ak pokyn mení, čo je pre daný deň najlepšie robiť, uprav aj to, inak ' +
    'zachovaj pôvodnú "recommended" voľbu). Pri "long"/"intensity"/dlhšom "indoor" nezabudni ' +
    'zachovať/doplniť aj samostatné pole "fuelPlan" (string, NIE súčasť "suggestion" - pred ' +
    'tréningom + hodinu po hodine počas + pitný režim; Adam: 3 fľaše, 2650 ml spolu, vlastný ' +
    'izotonický nápoj 60-80 g cukru + 3-6 g soli na fľašu, často má banány a gumové "žížalky"), ' +
    'pri "rest" nech je "fuelPlan":null. Presne v tomto JSON tvare:\n' +
    '[{"date":"YYYY-MM-DD","alternatives":[' +
    '{"label":"...","intensity":"rest","suggestion":"...","recommended":false,"fuelPlan":null},' +
    '{"label":"...","intensity":"long","suggestion":"...","recommended":false,"fuelPlan":"..."},' +
    '{"label":"...","intensity":"intensity","suggestion":"...","recommended":true,"fuelPlan":"..."},' +
    '{"label":"...","intensity":"indoor","suggestion":"...","recommended":false,"fuelPlan":null}' +
    ']}]\n' +
    'Odpovedz IBA validným JSON poľom, žiadny markdown, žiadne ```.'
  );
  lines.push('');
  lines.push('Aktuálny plán:');
  existingPlan.days.forEach(d => {
    if (d.ownNote) {
      lines.push(`- ${d.date}: ${d.weatherDesc}, ${Math.round(d.tempMin)}-${Math.round(d.tempMax)}°C [MÁ VLASTNÝ PLÁN: "${d.ownNote}"]`);
      return;
    }
    if (!d.alternatives || !d.alternatives.length) {
      lines.push(`- ${d.date}: ${d.weatherDesc}, ${Math.round(d.tempMin)}-${Math.round(d.tempMax)}°C [BEZ AI NÁVRHU]`);
      return;
    }
    lines.push(weatherLineFor(d.date, d.weatherDesc, d.tempMin, d.tempMax, d.precipMm, d.windMaxKmh, 'BEZ VLASTNÉHO PLÁNU', '', d.bestWindow));
    const recIdx = d.alternatives.findIndex(a => a.recommended);
    const selIdx = (currentSelection[d.date] != null && currentSelection[d.date] < d.alternatives.length)
      ? currentSelection[d.date] : (recIdx !== -1 ? recIdx : 0);
    d.alternatives.forEach((a, i) => {
      const marker = (i === selIdx ? '→ VYBRANÉ ' : '') + (a.recommended ? '⭐' : '');
      lines.push(`   ${marker || '   '} [${a.intensity}] ${a.label}: ${a.suggestion}`);
    });
  });
  return lines.join('\n');
}

// ---------- Režim 1: normálne generovanie nového plánu ----------
// OPRAVA 31.7.2026 (nahlásené Adamom - plán 4x po sebe navrhol "voľno/oddych", keďže počasie
// bolo viac dní po sebe zlé, a AI pri každom dni rozhodovalo izolovane bez vedomia, koľko dní
// oddychu/tréningu už reálne predchádzalo): súhrn POSLEDNÝCH ~10 DNÍ PRED daným dňom (mimo
// predpovedaného/plánovaného obdobia) - skutočné aktivity + Strain z hr_strain_daily.json - aby AI
// vedelo posúdiť, či si už oddýchol/nabral únavu predtým, než navrhne ďalšie voľno. Vytiahnuté do
// samostatnej funkcie, aby ju vedel použiť aj nový "opýtať sa AI" režim nižšie (answerQuestion),
// nielen bežné generovanie plánu.
function gatherRecentPastDays(anchorDate, activitiesMerged, strainByDate) {
  const recentPastDays = [];
  if (!anchorDate) return recentPastDays;
  for (let i = 10; i >= 1; i--) {
    const d = new Date(anchorDate + 'T00:00:00');
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const acts = activitiesMerged.filter(a => a.date === dateStr);
    const strainEntry = strainByDate[dateStr];
    if (!acts.length && !strainEntry) continue; // žiadne dáta pre tento deň - vynechaj, nerobiť šum
    recentPastDays.push({
      date: dateStr,
      strain: strainEntry ? strainEntry.strain : null,
      activitiesTxt: doneActivitiesSummary(acts),
    });
  }
  return recentPastDays;
}

async function generateNewPlan() {
  console.log('Sťahujem predpoveď počasia pre Čadcu...');
  const weatherDays = await fetchWeather();

  const wellnessMerged = mergeById(
    loadJsonSafe(path.join(DATA_DIR, 'wellness_history.json'), []),
    loadJsonSafe(path.join(DATA_DIR, 'wellness_daily.json'), []), 'id'
  ).sort((a, b) => (a.date < b.date ? -1 : 1));

  // Už zaznamenané aktivity v rámci dní pokrytých predpoveďou (v praxi relevantné hlavne pre DNES
  // - viď komentár v buildPlanPrompt) - aby AI vedelo, že časť dňa sa už reálne odohrala, a
  // nenavrhovalo duplicitný plnohodnotný tréning, ako keby deň ešte len začínal.
  const activitiesMerged = mergeById(
    loadJsonSafe(path.join(DATA_DIR, 'activities_history.json'), []),
    loadJsonSafe(path.join(DATA_DIR, 'activities_daily.json'), []), 'id'
  );
  const forecastDates = new Set(weatherDays.map(w => w.date));
  const activitiesByDate = {};
  activitiesMerged.forEach(a => {
    if (!a.date || !forecastDates.has(a.date)) return;
    (activitiesByDate[a.date] = activitiesByDate[a.date] || []).push(a);
  });

  const strainByDate = loadJsonSafe(path.join(DATA_DIR, 'hr_strain_daily.json'), {});
  const todayForHistory = weatherDays.length ? weatherDays[0].date : null;
  const recentPastDays = gatherRecentPastDays(todayForHistory, activitiesMerged, strainByDate);

  const dayNotes = loadJsonSafe(path.join(DATA_DIR, 'day_notes.json'), []);
  const globalStatus = loadJsonSafe(path.join(DATA_DIR, 'status.json'), null);
  const statusByDate = {};
  weatherDays.forEach(w => {
    const note = dayNotes.find(n => n.date === w.date);
    statusByDate[w.date] = (note && note.status) ? note.status : (globalStatus && globalStatus.status) || 'active';
  });

  const prompt = buildPlanPrompt(weatherDays, wellnessMerged, dayNotes, statusByDate, activitiesByDate, recentPastDays);
  console.log('Generujem plán (Gemini)...');
  // maxOutputTokens 7000 (bolo 5500, 4096, predtým 2600) + thinkingConfig v callGeminiOnce() -
  // skutočná príčina "Bez návrhu pre všetky dni" bola, že neviditeľné "thinking" tokeny (počítajú
  // sa do maxOutputTokens, ale nie sú vidno vo výstupe) zjedli veľkú časť rozpočtu na tomto veľkom
  // JSON-e, odpoveď sa orezala uprostred a nedala sa naparsovať. Po rozšírení z 8 na 10 dní
  // (9.8.2026) a pridaní samostatného podrobnejšieho "fuelPlan" poľa (13.8.2026) opäť zvýšené s
  // rezervou - JSON je teraz citeľne väčší než pri pôvodných 2600.
  const result = await callGemini(prompt, { json: true, maxOutputTokens: 7000 });
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
        bestWindow: w.bestWindow || null,
        hourly: w.hourly || [],
        alreadyDone: doneActivitiesSummary(activitiesByDate ? activitiesByDate[w.date] : null) || null,
        ownNote: hasOwnNote ? note.note : null,
        // OPRAVA 5.8.2026 (nahlásené Adamom): predtým sa dni s vlastnou poznámkou úplne vynechali
        // z AI generovania a v pláne sa zobrazila len surová poznámka tak, ako ju napísal. Teraz
        // AI aj pre tieto dni vráti "notePlan" - krajšie sformulovanú verziu jeho plánu doplnenú o
        // konkrétne odporúčanie (dĺžka/zóny/tempo, prispôsobené počasiu) - BEZ zmeny toho, čo si
        // sám naplánoval. Ak AI pre daný deň notePlan nevrátila (chyba, orezaná odpoveď a pod.),
        // frontend nemá o čo prísť - vždy mu ostáva ako záloha jeho pôvodná surová poznámka nižšie
        // (ownNote), tá sa NIKDY nemaže/neprepisuje na disku, len sa v UI prípadne zobrazí krajšia
        // verzia navyše.
        notePlan: hasOwnNote && daySuggestion && daySuggestion.notePlan
          ? String(daySuggestion.notePlan).trim() : null,
        // OPRAVA 13.8.2026 (nahlásené Adamom): "Najbližší týždeň" tabuľka predtým pre KAŽDÝ deň s
        // vlastnou poznámkou používala rovnaký pevný odhad Strain/Recovery (nerozlišovala "idem na
        // dlhý výjazd" od "dnes žiadny tréning, len si užívam výlet") a celý riadok textu namiesto
        // krátkeho zhrnutia. Teraz AI sama klasifikuje, o aký typ dňa ide (noteIntensity, rovnaká
        // škála ako pri alternatives) a dá krátke zhrnutie (noteLabel) - obe null pre staršie
        // uložené plány spred tejto opravy, frontend má na to fallback.
        noteLabel: hasOwnNote && daySuggestion && daySuggestion.noteLabel
          ? String(daySuggestion.noteLabel).trim() : null,
        noteIntensity: hasOwnNote && KNOWN_INTENSITIES.includes(daySuggestion && daySuggestion.noteIntensity)
          ? daySuggestion.noteIntensity : null,
        // Výživa/pitný režim - samostatné pole, nie súčasť notePlan/suggestion textu (viď
        // buildPlanPrompt) - zobrazuje sa na plan.html až po kliknutí na 🍌.
        fuelPlan: hasOwnNote && daySuggestion && daySuggestion.fuelPlan
          ? String(daySuggestion.fuelPlan).trim() : null,
        status: statusByDate[w.date] !== 'active' ? statusByDate[w.date] : null,
        // Dni s vlastným plánom nemajú "alternatives" (majú namiesto toho notePlan vyššie) - tie
        // isté 4 alternatívy by sem nedávali zmysel, keďže deň už má rozhodnutý vlastný plán. Pre
        // ostatné dni až 4 alternatívy (rest/long/intensity/indoor), ktoré si frontend (plan.html)
        // vie prepínať a na základe voľby prepočítať okolité dni.
        alternatives: hasOwnNote ? [] : normalizeAlternatives(daySuggestion && daySuggestion.alternatives),
      };
    }),
  };
  fs.writeFileSync(PLAN_FILE, JSON.stringify(output, null, 1));
  console.log('✅ Plán podľa počasia uložený do data/weather_plan.json.');
}

// ---------- Režim 2: úprava existujúceho plánu podľa voľného pokynu ----------
async function editExistingPlan(instruction) {
  const existing = loadJsonSafe(PLAN_FILE, null);
  if (!existing || !Array.isArray(existing.days) || !existing.days.length) {
    console.warn('⚠️ Neexistuje žiadny vygenerovaný plán na úpravu - generujem nový plán namiesto úpravy pokynom.');
    return generateNewPlan();
  }

  let currentSelection = {};
  const rawSelection = process.env.PLAN_CURRENT_SELECTION || '';
  if (rawSelection) {
    try { currentSelection = JSON.parse(rawSelection); }
    catch (e) { console.warn('⚠️ PLAN_CURRENT_SELECTION sa nedal naparsovať, používam prvú alternatívu pre každý deň:', e.message); }
  }

  const prompt = buildEditPrompt(existing, currentSelection, instruction);
  console.log(`Upravujem existujúci plán podľa pokynu: "${instruction}" (Gemini)...`);
  const result = await callGemini(prompt, { json: true, maxOutputTokens: 6000 });
  const raw = result ? result.text : null;
  const usedModel = result ? result.model : (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);

  let edits = [];
  if (raw) {
    let jsonStr = raw.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) edits = parsed;
      else console.warn('⚠️ Odpoveď na úpravu nie je JSON pole, ignorujem.');
    } catch (e) { console.warn('⚠️ Odpoveď na úpravu sa nedala naparsovať ako JSON:', e.message); }
  }
  if (!edits.length) {
    console.warn('⚠️ AI nevrátila žiadne použiteľné úpravy (chyba API, alebo prázdna/nezrozumiteľná odpoveď) - plán ostáva nezmenený.');
  }

  let changedDates = [];
  edits.forEach(e => {
    const day = existing.days.find(d => d.date === e.date);
    if (!day) { console.warn(`⚠️ AI vrátila úpravu pre neznámy dátum ${e.date}, ignorujem.`); return; }
    if (day.ownNote) { console.warn(`⚠️ AI sa pokúsila upraviť deň ${e.date}, ktorý má vlastný plán - ignorujem (dni s vlastným plánom sa nikdy neprepisujú).`); return; }
    const normalized = normalizeAlternatives(e.alternatives);
    if (normalized.length) { day.alternatives = normalized; changedDates.push(e.date); }
  });

  existing.generatedAt = new Date().toISOString();
  existing.model = usedModel;
  existing.lastEdit = { instruction, at: new Date().toISOString(), changedDates };
  fs.writeFileSync(PLAN_FILE, JSON.stringify(existing, null, 1));
  console.log(`✅ Plán upravený podľa pokynu (zmenené dni: ${changedDates.join(', ') || 'žiadne'}) a uložený do data/weather_plan.json.`);
}

// ---------- Režim 3: len odpovedať na otázku, plán/alternatívy sa VÔBEC nemenia ----------
// OPRAVA 8.8.2026 (žiadosť Adama): predtým jediný spôsob "spýtať sa niečo" bol cez pokyn na
// úpravu plánu (editExistingPlan), čo pri jednoduchej otázke typu "koľko vody si mám vziať?"
// alebo "môžem ísť do vyšších intenzít?" nedávalo zmysel - buď by to AI ignorovala, alebo by sa
// to (nechcene) pokúsilo prepísať alternatívy. Tento režim vráti čistý textový záznam do poľa
// "qa" v data/weather_plan.json - dni/alternatívy/notePlan zostávajú úplne nedotknuté.
function buildAskPrompt(existingPlan, recentPastDays, question) {
  const lines = [];
  lines.push(
    'Si osobný cyklistický/bežecký kouč pre Adama. Používateľ sa ťa niečo PÝTA - toto NIE JE ' +
    'pokyn na úpravu plánu, iba na jeho existujúci plán a nedávnu formu nižšie ODPOVEDZ. ' +
    'Nevracaj JSON, nevracaj plán, nemeň žiadny deň - len vecná, konkrétna odpoveď (2-6 viet ' +
    'podľa zložitosti otázky) v slovenčine, prípadne s jasným zoznamom, ak sa to na otázku hodí. ' +
    'Ak sa otázka týka pitného režimu/sacharidov, ber do úvahy: Adam má 3 fľaše s celkovou ' +
    'kapacitou 2650 ml (2× 950 ml + 1× 750 ml) a robí si vlastný izotonický nápoj - do každej ' +
    'fľaše zvyčajne 60-80 g bieleho cukru a 3-6 g soli; odporúčania priprav v rámci/blízko tohto ' +
    'zvyčajného rozsahu, nevymýšľaj úplne inú receptúru.\n\n' +
    `OTÁZKA: "${question}"\n`
  );
  lines.push('');
  if (recentPastDays && recentPastDays.length) {
    lines.push(`Posledných ${recentPastDays.length} dní (kontext o forme/únave):`);
    recentPastDays.forEach(p => {
      const strainTxt = p.strain != null ? `Strain ${p.strain}` : 'Strain —';
      const actTxt = p.activitiesTxt ? `, aktivity: ${p.activitiesTxt}` : ', bez zaznamenanej aktivity';
      lines.push(`- ${p.date}: ${strainTxt}${actTxt}`);
    });
    lines.push('');
  }
  if (existingPlan && Array.isArray(existingPlan.days) && existingPlan.days.length) {
    lines.push('Aktuálny naplánovaný plán (pre kontext, NEMEŇ ho):');
    existingPlan.days.forEach(d => {
      if (d.ownNote) {
        lines.push(`- ${d.date}: ${d.weatherDesc}, ${Math.round(d.tempMin)}-${Math.round(d.tempMax)}°C [vlastný plán: "${d.notePlan || d.ownNote}"]`);
        return;
      }
      if (!d.alternatives || !d.alternatives.length) return;
      const active = d.alternatives.find(a => a.recommended) || d.alternatives[0];
      lines.push(`- ${d.date}: ${d.weatherDesc}, ${Math.round(d.tempMin)}-${Math.round(d.tempMax)}°C [odporúčané: ${active.label} (${active.intensity})]`);
    });
  }
  return lines.join('\n');
}

async function answerQuestion(question) {
  const existing = loadJsonSafe(PLAN_FILE, null);

  const activitiesMerged = mergeById(
    loadJsonSafe(path.join(DATA_DIR, 'activities_history.json'), []),
    loadJsonSafe(path.join(DATA_DIR, 'activities_daily.json'), []), 'id'
  );
  const strainByDate = loadJsonSafe(path.join(DATA_DIR, 'hr_strain_daily.json'), {});
  const anchorDate = (existing && existing.days && existing.days.length)
    ? existing.days[0].date : new Date().toISOString().slice(0, 10);
  const recentPastDays = gatherRecentPastDays(anchorDate, activitiesMerged, strainByDate);

  const prompt = buildAskPrompt(existing, recentPastDays, question);
  console.log(`Odpovedám na otázku: "${question}" (Gemini)...`);
  const result = await callGemini(prompt, { json: false, maxOutputTokens: 700 });
  const answer = result ? result.text : null;
  const usedModel = result ? result.model : (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);

  if (!answer) {
    console.warn('⚠️ Gemini nevrátila odpoveď (chyba API alebo prázdna odpoveď) - "qa" pole sa neuloží.');
    return;
  }

  // Ak zatiaľ neexistuje žiadny plán, ulož odpoveď aspoň do prázdnej kostry súboru - "qa" musí
  // fungovať nezávisle od toho, či už bol niekedy vygenerovaný plán.
  const output = existing || { generatedAt: null, model: null, location: 'Čadca, Slovensko', days: [] };
  output.qa = { question, answer, answeredAt: new Date().toISOString(), model: usedModel };
  fs.writeFileSync(PLAN_FILE, JSON.stringify(output, null, 1));
  console.log('✅ Odpoveď uložená do data/weather_plan.json (pole "qa") - dni/alternatívy nedotknuté.');
}

async function main() {
  const question = (process.env.PLAN_QUESTION || '').trim();
  const editInstruction = (process.env.PLAN_EDIT_INSTRUCTION || '').trim();
  if (question) {
    await answerQuestion(question);
  } else if (editInstruction) {
    await editExistingPlan(editInstruction);
  } else {
    await generateNewPlan();
  }
}

main().catch(err => {
  console.error('❌ Chyba pri generovaní/úprave plánu:', err.message);
  process.exit(1);
});
