// weather-plan.js
// Stiahne 10-dňovú predpoveď počasia pre Čadcu (Open-Meteo, zadarmo, žiadny API kľúč netreba),
// skombinuje s aktuálnou formou (CTL/ATL) a kalendárovými poznámkami, a cez Gemini pripraví návrh
// na každý deň:
//  - Dni BEZ vlastnej poznámky: 3 alternatívy tréningu (rest/long/intensity), viď
//    KNOWN_INTENSITIES nižšie. (Indoor bol dočasne 4. možnosť, odstránený 14.8.2026 - Adam
//    momentálne nemá k dispozícii trenažér/posilňovňu.)
//  - Dni, kde už máš vlastný plán (day_notes.json): AI negeneruje alternatívy (nepretláča sa do
//    toho, ČO si sa rozhodol robiť), ale vráti "notePlan" - krajšie sformulovanú verziu tvojej
//    poznámky doplnenú o konkrétne odporúčanie ako ju ísť (dĺžka/zóny/tempo podľa počasia). Ak sa
//    to nevygeneruje (chyba/orezaná odpoveď), frontend padá späť na tvoju surovú poznámku.
//
// OPRAVA 5.8.2026 (nahlásené Adamom): predtým sa dni s vlastnou poznámkou úplne vynechávali z AI
// generovania ("ak nemám vlastný plán" bola pôvodná explicitná požiadavka) - teraz sa aj pre ne
// generuje AI návrh (notePlan), len iným spôsobom než pre voľné dni.
//
// Tri režimy behu:
//  1) Normálne generovanie (žiadny PLAN_EDIT_INSTRUCTION ani PLAN_QUESTION) - stiahne čerstvé
//     počasie a vygeneruje kompletne nový plán, presne ako predtým.
//  2) Úprava existujúceho plánu (PLAN_EDIT_INSTRUCTION nastavený, napr. z tlačidla "Upraviť plán"
//     na stránke) - NEGENERUJE nový plán od nuly, ale pošle Gemini aktuálny plán + pokyn
//     používateľa (napr. "skráť dnešný tréning na 60 minút", "presuň intervaly na zajtra") a
//     upraví iba dni, ktorých sa pokyn reálne týka. PLAN_CURRENT_SELECTION (JSON mapa
//     dátum->index aktuálne vybranej alternatívy z prehliadača) hovorí AI, čo si používateľ práve
//     pozerá, keďže výber alternatívy žije len v localStorage prehliadača, nie v tomto súbore.
//  3) Otázka bez úpravy plánu (PLAN_QUESTION nastavený, tlačidlo "Opýtať sa AI") - odpovie na
//     voľnú otázku (napr. "koľko vody si mám vziať?") s kontextom plánu/nedávnej formy, ale
//     NEMENÍ žiadny deň - odpoveď sa pridá do histórie v poli "qaHistory" (viď answerQuestion()).
//
// Očakáva: GEMINI_API_KEY (ak chýba, skript sa ticho ukončí)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PLAN_FILE = path.join(DATA_DIR, 'weather_plan.json');
// OPRAVA 4.9.2026 (žiadosť Adama): weather_plan.json je vždy len ROLLING 10-dňové okno od
// "dneška" (Open-Meteo tak vracia predpoveď) - pri každom novom vygenerovaní tak dni, čo už
// prešli, jednoducho vypadnú a nenávratne sa stratia pri ďalšom prepísaní súboru. Do tohto
// súboru sa PRED prepísaním archivuje, čo bolo pre taký deň naplánované, nech sa dá spätne v
// Kalendári pozrieť "čo som mal robiť" aj keď sa plán medzitým dávno pregeneroval - najmä ako
// náhrada/doplnok pre dni, kde zlyhal/chýba "aktivity súhrn" (ai-summary.js).
const PLAN_HISTORY_FILE = path.join(DATA_DIR, 'plan_history.json');

function archiveExpiredDays(newFirstDate) {
  if (!newFirstDate) return;
  const oldPlan = loadJsonSafe(PLAN_FILE, null);
  if (!oldPlan || !Array.isArray(oldPlan.days) || !oldPlan.days.length) return;
  const expired = oldPlan.days.filter(d => d.date < newFirstDate);
  if (!expired.length) return;
  const history = loadJsonSafe(PLAN_HISTORY_FILE, {});
  expired.forEach(d => {
    const recommendedAlt = Array.isArray(d.alternatives) ? d.alternatives.find(a => a.recommended) : null;
    history[d.date] = {
      date: d.date,
      archivedAt: new Date().toISOString(),
      weatherDesc: d.weatherDesc || null,
      ownNote: d.ownNote || null,
      plannedLabel: d.ownNote ? (d.noteLabel || 'Vlastný plán') : (recommendedAlt ? recommendedAlt.label : null),
      plannedSuggestion: d.ownNote ? (d.notePlan || d.ownNote) : (recommendedAlt ? recommendedAlt.suggestion : null),
    };
  });
  fs.writeFileSync(PLAN_HISTORY_FILE, JSON.stringify(history, null, 1));
  console.log(`🗄️ data/plan_history.json - archivovaných ${expired.length} dní (${expired.map(d => d.date).join(', ')}).`);
}
const LAT = 49.4386, LON = 18.7898; // Čadca, Slovensko
// OPRAVA 4.9.2026 (žiadosť Adama - "vylepši ten model toho plánu"): Gemini 3.8 Flash vyšlo
// 2.9.2026 (GA, model ID gemini-3.8-flash) - podľa zverejnených Google benchmarkov je pred
// 3.7 Flash na všetkom, čo publikovali (napr. DeepSWE 73.7 % vs 65.3 %), a AKTUÁLNE (do
// 31.12.2026, potom zdvojnásobenie) stojí MENEJ za token než predtým používané 3.6 Flash
// ($0.75/$3.75 oproti $1.50/$7.50 za 1M tokenov) - teda zlepšenie kvality bez zvýšenia ceny za
// token (spotreba tokenov môže byť o niečo vyššia, model si podľa Google zámerne "viac rozmýšľa"
// na zložitých úlohách, ale thinkingLevel je nižšie nastavený na 'medium' - vyváženie kvality a
// spotreby, 'high' by šlo skúsiť neskôr, ak by 'medium' nestačilo).
// Záložný reťazec aktualizovaný na súčasné modely namiesto starnúcich 3.1/3.5 verzií.
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
// PRÍČINA starého "Bez návrhu" bugu: ak primárny model vráti chybu (404 po vyradení, 429 po
// vyčerpaní free-tier kvóty, alebo dočasná nedostupnosť - typické pár dní po vydaní nového
// modelu), skript sa doteraz potichu vzdal a všetky dni bez vlastnej poznámky ostali navždy bez
// návrhu. Rovnaký princíp ako pri fetchWeatherWithParams nižšie: namiesto tvrdého vzdania sa
// skús postupne aj tieto zálohy, kým jedna neodpovie.
const FALLBACK_GEMINI_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

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
// OPRAVA 2.9.2026 (nahlásené Adamom): okno sa doteraz vyberalo VÝHRADNE podľa najnižšej šance
// dažďa v rozsahu 12:00-21:00, úplne bez ohľadu na to, či je vtedy ešte svetlo - v septembri tak
// vedelo vyjsť napr. "18:00-22:00" ako "najlepšie okno bez dažďa", hoci slnko zapadá už okolo
// 19:30 a posledná hodina či dve z toho boli reálne poza tmou. `sunsetHour` (desatinné číslo,
// napr. 19.53 pre 19:32) sa teraz odčíta z Open-Meteo `daily.sunset` a hodiny PO zotmení sa do
// kandidátov na okno vôbec nezarátajú - okno tak už fyzicky nemôže siahať do tmy.
function bestWindowForDay(hourlyTimes, hourlyProb, date, sunsetHour) {
  const dayHours = [];
  for (let i = 0; i < hourlyTimes.length; i++) {
    if (hourlyTimes[i].slice(0, 10) === date) {
      const hour = parseInt(hourlyTimes[i].slice(11, 13), 10);
      const isDaylight = sunsetHour == null || hour < sunsetHour;
      if (hour >= TRAINING_DAY_START_HOUR && hour <= TRAINING_DAY_END_HOUR && hourlyProb[i] != null && isDaylight) {
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
    `&daily=${dailyParams},sunrise,sunset&hourly=precipitation_probability,temperature_2m&timezone=Europe/Bratislava&forecast_days=10`;
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
  const sunsetArr = d.sunset || [];
  return d.time.map((date, i) => {
    // sunsetArr[i] je ISO lokálny čas napr. "2026-09-02T19:32" (vďaka timezone=Europe/Bratislava
    // v requeste) - desatinná hodina (19.533) sa použije na orezanie okna, "HH:MM" na zobrazenie/prompt.
    let sunsetHour = null, sunsetTxt = null;
    if (sunsetArr[i]) {
      const m = sunsetArr[i].match(/T(\d{2}):(\d{2})/);
      if (m) { sunsetHour = parseInt(m[1], 10) + parseInt(m[2], 10) / 60; sunsetTxt = `${m[1]}:${m[2]}`; }
    }
    return {
      date,
      tempMax: d.temperature_2m_max[i],
      tempMin: d.temperature_2m_min[i],
      precipMm: d.precipitation_sum[i],
      windMaxKmh: windArr[i],
      weatherCode: weatherCodeArr[i],
      sunset: sunsetTxt,
      bestWindow: bestWindowForDay(hourlyTimes, hourlyProb, date, sunsetHour),
      hourly: hourlyBreakdownForDay(hourlyTimes, hourlyProb, hourlyTemp, date),
    };
  });
}

// POZOR (rovnaký koreň problému ako v ai-summary.js/sync.js, zistené 30.7.2026): Gemini 3.x
// modely (flash aj flash-lite) majú defaultne zapnuté interné "thinking" tokeny, ktoré sa
// POČÍTAJÚ do maxOutputTokens, ale nie sú vidno vo výstupe. Tento skript pýta výrazne väčší JSON
// než ai-summary.js (10 dní × 3 alternatívy), takže aj pri maxOutputTokens 2600 sa dalo ľahko stať,
// že model minul rozpočet na neviditeľné rozmýšľanie a viditeľný JSON sa orezal uprostred -
// JSON.parse zlyhal, suggestions=[] a ÚPLNE VŠETKY dni skončili ako "Bez návrhu". Riešenie:
// 1) thinkingConfig.thinkingLevel='medium' (Gemini 3.x - NIE thinkingBudget, to je len pre 2.5
//    sériu a na 3.x model by vrátilo 400 Bad Request; OPRAVA 4.9.2026 - 'low'→'medium' na žiadosť
//    Adama pre kvalitnejšie zdôvodnené odporúčania, maxOutputTokens zodpovedajúco zvýšené nižšie
//    pri oboch veľkých volaniach), 2) vyšší maxOutputTokens ako rezerva, 3) kontrola
//    finishReason - ak model odpoveď orezal (MAX_TOKENS), NEPOUŽIJE sa jeho (nevalidný) text, ale
//    hodí sa chyba, aby to callGemini() nižšie skúsilo s ďalším záložným modelom namiesto toho,
//    aby sa jeden orezaný pokus vydával za konečný výsledok pre všetky dni naraz.
function thinkingConfigFor(model) {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: 'medium' };
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
// OPRAVA 14.8.2026 (nahlásené Adamom): indoor tréning (trenažér/posilňovňa) mu momentálne nie je k
// dispozícii - odstránené zo zoznamu možností. Späť na 3 alternatívy: rest/long/intensity.
const KNOWN_INTENSITIES = ['rest', 'long', 'intensity'];
const INTENSITY_LABELS = {
  rest: 'Voľno',
  long: 'Dlhá jazda',
  intensity: 'Intervaly',
};
// Normalizuje a obmedzí to, čo Gemini vrátil pre jeden deň, na max 3 použiteľné alternatívy s
// konzistentným tvarom (id/label/intensity/suggestion/recommended/fuelPlan) - aj keby model
// vynechal label alebo poslal neznámu hodnotu intensity, frontend dostane vždy rozumný tvar dát.
// Poradie sa zachováva podľa toho, čo vrátil model (generovací aj edit prompt ho žiadajú v poradí
// rest/long/intensity), aby si výber alternatívy v prehliadači (index 0/1/2) držal rovnaký význam
// aj po úprave existujúceho plánu.
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
    .slice(0, 3)
    .map((a, i) => {
      const intensity = KNOWN_INTENSITIES.includes(a.intensity) ? a.intensity : 'long';
      let recommended = !!a.recommended;
      if (recommended && recommendedUsed) recommended = false; // druhé a ďalšie "recommended" sa ignorujú
      if (recommended) recommendedUsed = true;
      return {
        id: ['a', 'b', 'c'][i] || String(i),
        label: a.label || INTENSITY_LABELS[intensity],
        intensity,
        suggestion: String(a.suggestion),
        recommended,
        fuelPlan: a.fuelPlan ? String(a.fuelPlan) : null,
      };
    });
}

function weatherLineFor(date, weatherDesc, tempMin, tempMax, precipMm, windMaxKmh, planLabel, statusTxt, bestWindow, doneActivitiesTxt, sunsetTxt) {
  const windowTxt = bestWindow
    ? ` [najlepšie okno: ${bestWindow.start}-${bestWindow.end}, šanca dažďa ${bestWindow.avgRainProb}%` +
      `${bestWindow.outsidePreferred ? ', mimo zvyčajného poobedného času' : ''}]`
    : '';
  const sunsetLineTxt = sunsetTxt ? ` [zotmenie ~${sunsetTxt}]` : '';
  const doneTxt = doneActivitiesTxt ? ` [UŽ ABSOLVOVANÉ DNES: ${doneActivitiesTxt}]` : '';
  return `- ${date}: ${weatherDesc}, ${Math.round(tempMin)}-${Math.round(tempMax)}°C, zrážky ${precipMm}mm, ` +
    `vietor do ${Math.round(windMaxKmh)}km/h [${planLabel}]${statusTxt}${windowTxt}${sunsetLineTxt}${doneTxt}`;
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
  // OPRAVA 14.8.2026 (nahlásené Adamom - "u každého dňa je málo textu, asi bolo málo tokenov"):
  // pri 10 dňoch × viacero polí na deň sa pevný počet tokenov nutne rozriedil na plytký text
  // všade. Namiesto rovnomerného rozdelenia teraz podrobnosť KLESÁ so vzdialenosťou - najbližších
  // NEAR_DAYS dní (tie, čo si reálne pôjde robiť) dostane výrazne viac priestoru (konkrétne
  // intervaly/štruktúra tréningu), zvyšok len stručne (veci sa do vzdialenej budúcnosti aj tak
  // zvyknú zmeniť - netreba tam plytvať tokenmi na detaily, ktoré sa možno prepíšu).
  const NEAR_DAYS = 5;
  const nearCutoff = weatherDays.length > NEAR_DAYS ? weatherDays[NEAR_DAYS - 1].date : null;
  const lines = [];
  lines.push(
    'Si osobný cyklistický/bežecký kouč. Na základe počasia a aktuálnej formy nižšie priprav pre ' +
    'KAŽDÝ deň nižšie presne jeden z dvoch výstupov, podľa toho, ako je označený:\n\n' +
    'A) Dni označené "BEZ VLASTNÉHO PLÁNU": navrhni TRI rôzne alternatívy tréningu (nie tri ' +
    'preformulovania toho istého), v tomto poradí a presne s týmito hodnotami "intensity":\n' +
    '1) intensity="rest" - SKUTOČNÉ voľno/úplný regeneračný deň (žiadny tréning, prípadne len ' +
    'veľmi ľahký pohyb/strečing) - nie "ľahká jazda", ale reálne voľno,\n' +
    '2) intensity="long" - vytrvalostná/DLHŠIA jazda alebo beh v nižšej zóne, citeľne väčší objem ' +
    'než bežný deň - toto má byť skutočný OPAK alternatívy "rest", nie jej mierne obmenená verzia. ' +
    'DĹŽKU/OBJEM aj TRASU/PROFIL odvoď z reálneho kontextu nižšie (CTL/ATL, koľko a čo bolo ' +
    'najbližšie predtým/potom, deň v týždni) - NIE je to vždy rovnaké číslo hodín ani rovnaký ' +
    'plochý Z2 výjazd: pri nižšom CTL/po dlhšej prestávke navrhni kratšie, pri dobrej forme a bez ' +
    'blízkeho náročného dňa dlhšie, občas zvlnenejší profil alebo iný smer/cieľ namiesto vždy ' +
    'rovnakého plochého okruhu. Adam si sťažoval, že mu "long" vychádza stále rovnako (~2.5-3h Z2 ' +
    'dokola) - vyhni sa tomu, nech to naozaj odzrkadľuje aktuálnu situáciu, nie šablónu,\n' +
    '3) intensity="intensity" - intervaly/tempo, kratšie trvanie ale náročné. INDOOR TRÉNING ' +
    '(trenažér/rolky/posilňovňa) Adam momentálne nemá k dispozícii - NENAVRHUJ ho vôbec, ani ako ' +
    'súčasť inej alternatívy.\n' +
    '"rest" a "long" musia vyjsť ako skutočné opačné póly (celkom voľno vs. poriadny objem), nie ' +
    'dve stredné cesty, ktoré vyzerajú skoro rovnako. Navyše pri KAŽDEJ z 3 alternatív nastav ' +
    'pole "recommended" (boolean) - presne JEDNA z 3 má "recommended":true (tá, ktorú by si mu ' +
    'reálne odporučil urobiť tento konkrétny deň, ostatné "recommended":false), pozri nižšie ' +
    '"CELÉ OBDOBIE POSUDZUJ SPOLU" - tento výber sa použije ako predvolene zobrazená alternatíva, ' +
    'preto musí naozaj odzrkadľovať tvoje odporúčanie pre daný deň v kontexte celého obdobia, nie ' +
    'mechanicky vždy prvú v poradí.\n\n' +
    'B) Dni označené "MÁ VLASTNÝ PLÁN": TU NEGENERUJ tri alternatívy. Namiesto toho zober jeho ' +
    'vlastnú poznámku (čo si už sám naplánoval) a vráť JEDNU vec - kratšie a krajšie sformulovanú ' +
    'verziu jeho plánu DOPLNENÚ o konkrétne odporúčanie, ako ho ísť (orientačná dĺžka/objem, ' +
    'zóny/tempo, na čo si dať pozor vzhľadom na počasie toho dňa a nedávnu záťaž). NIKDY nemeň, ' +
    'ČO si naplánoval (napr. ak napísal "idem na túru", nenavrhuj namiesto toho bicykel) - len to ' +
    'vylepši a doplň o praktickú radu. Toto vráť v poli "notePlan" - takýto deň v odpovedi NEMÁ ' +
    'pole "alternatives". K nemu navyše priprav DVE malé polia, aby sa dal tento deň zaradiť do ' +
    'prehľadov rovnako ako bežné dni:\n' +
    '   - "noteLabel": VEĽMI krátke zhrnutie 2-4 slová (napr. "Dlhý výjazd s Danom", "Prehliadka ' +
    'Prahy") - použije sa v kompaktných prehľadoch, kde na plnú vetu nie je miesto.\n' +
    '   - "noteIntensity": over, ČO jeho poznámka fakticky znamená z hľadiska záťaže, a priraď ' +
    'JEDNU z rovnakých 3 hodnôt ako vyššie (rest/long/intensity) - napr. "žiadny tréning, oddych" ' +
    'alebo "pešia prehliadka mesta" = "rest", "dlhý výjazd X hodín" = "long", "intervaly/preteky" ' +
    '= "intensity". Toto je DÔLEŽITÉ pre presnosť iných častí appky - klasifikuj podľa skutočného ' +
    'obsahu poznámky, nie automaticky "long" pre každý deň s vlastným plánom.\n\n' +
    `PODROBNOSŤ TEXTU PODĽA VZDIALENOSTI: pre prvých ${NEAR_DAYS} dní (do ${nearCutoff || 'konca zoznamu'} vrátane) - ` +
    'tie si pôjde reálne robiť čoskoro - napíš "suggestion"/"notePlan" PODROBNE (3-5 viet): pri ' +
    '"intensity" KONKRÉTNU štruktúru intervalov - VYBER podľa kontextu (forma, čo bolo nedávno, ' +
    'ročné obdobie/fáza) z celého spektra, NIE stále to isté: VO2max repáky (napr. "5x3min na ' +
    'hrane, 3min voľno"), prahové/sweet-spot bloky ("3x12min tesne pod prahom"), over-under ' +
    '("6x4min: 2min mierne nad prahom / 2min mierne pod"), krátke sprinty/neuromuskulárne ' +
    '"10x20s naplno, 3min voľno"), kopcovité repáky (ak sa hodí terén), fartlek/pyramída atď. - ' +
    'toto je len ukážka ŠÍRKY možností, nie šablóna na kopírovanie; pri "long" orientačnú dĺžku/ ' +
    'zónu a kde/kadiaľ, pri "rest" čo konkrétne pre ' +
    'regeneráciu (strečing, valcovanie, spánok). ' +
    'POROVNÁVACIE SEGMENTY (nahlásené Adamom 4.9.2026 - predtým sa toto pochopilo zle): Adam má ' +
    'dva segmenty, na ktorých si chce merať/zlepšovať výkon, keď sa prirodzene hodia do trasy - ' +
    '"Valy" (v oblasti Čierneho) a "Husárik" (slepá cesta - dá sa tam ísť LEN TAM A SPÄŤ, nie ' +
    'preto ísť ďalej cez neho niekam inam). Sú to DVE ÚPLNE SAMOSTATNÉ, geograficky vzdialené ' +
    'miesta - NIKDY ich nedávaj do jednej vety ako keby tvorili jednu súvislú trasu (napr. ' +
    '"kopcovitá trasa cez Husárik a Valy" NEDÁVA ZMYSEL a Adama to nahnevalo, presne toto sa už ' +
    'raz stalo). Ak sa v texte pre "long"/"intensity" hodí navrhnúť jeden z nich (nie nutne oba ' +
    'naraz, skôr príležitostne, keď to zapadá do dĺžky/zóny dňa), spomeň VÝSLOVNE len ten jeden a ' +
    'nechaj ostatnú časť trasy/výberu otvorenú/všeobecnú namiesto vymýšľania ďalších konkrétnych ' +
    'miestnych názvov, ktoré nepoznáš. ' +
    'NAPRIEČ VŠETKÝMI BLÍZKYMI DŇAMI SA ' +
    'ŠTRUKTÚRA "intensity" AJ "long" MUSÍ LÍŠIŤ deň od dňa (iný typ intervalu, iná dĺžka/zóna) - ' +
    'Adam sa sťažoval, že dostáva stále tú istú vytrvalostnú jazdu a žiadne iné nápady na ' +
    'intervaly, takže nad opakovaním rovnakej štruktúry si daj obzvlášť pozor. PRE ZVYŠNÉ DNI (za ' +
    'týmto dátumom) ' +
    'napíš "suggestion"/"notePlan" NAOPAK VEĽMI STRUČNE - JEDNA veta, len podstata, ALE stále ' +
    'konkrétna a odvodená od kontextu toho dňa (nie generická šablóna) - napr. pri "intensity" ' +
    'uveď aspoň hrubú štruktúru (počet/dĺžku intervalov, typ - VO2max/prah/sprint/kopce...), pri ' +
    '"long" konkrétnu dĺžku/zónu, ktorá ' +
    'sedí s formou a okolitými dňami toho dňa (POZOR: rôzne dni majú mať rôzne čísla/formuláciu ' +
    'podľa toho, čo je v ten deň naozaj v pláne - NIKDY nekopíruj rovnaké "cca X h Z2" naprieč ' +
    'viacerými dňami len preto, že to je najjednoduchšie), bez rozpisovania - tieto dni sa aj tak ' +
    'často prepíšu, keď sa k nim priblížiš, netreba do nich investovať toľko textu ako do ' +
    `najbližších ${NEAR_DAYS}.\n\n` +
    'VÝŽIVA/PITNÝ REŽIM ("fuelPlan"): pri KAŽDEJ alternatíve typu A aj pri type B (vtedy vedľa ' +
    '"notePlan"), kde ide o reálne dlhší alebo namáhavý tréning VONKU (typicky "long", ' +
    '"intensity", alebo poznámka s dlhšou aktivitou) - teda NIE pri "rest" a NIE pri krátkych/ ' +
    'ľahkých sedeniach, tam nechaj "fuelPlan":null - priprav SAMOSTATNÉ pole "fuelPlan" (string, ' +
    'pri dňoch v rámci prvých ' + NEAR_DAYS + ' 3-6 viet, pri vzdialenejších dňoch pokojne len 1-2 ' +
    'vety - NIE súčasť "suggestion"/"notePlan" textu) s konkrétnym plánom v tomto duchu:\n' +
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
    'aby "recommended" voľby medzi dňami dávali zmysel ako celok - toto zahŕňa AJ dni typu B (MÁ ' +
    'VLASTNÝ PLÁN), tie sa síce nedajú meniť, ale pri plánovaní OKOLITÝCH dní ich rátaj úplne ' +
    'rovnako, ako keby mali "recommended":true na tom, čo z ich poznámky vyplýva (dlhý/namáhavý ' +
    'výjazd = počítaj to ako "long"/"intensity" deň pri susedných dňoch, pokojná prehliadka mesta ' +
    'bez tréningu = počítaj to ako "rest" deň). KONKRÉTNE: ak deň PRED alebo PO type B dni s ' +
    'dlhým/namáhavým vlastným plánom je typu A, na taký deň NEODPORÚČAJ ĎALŠÍ "long"/"intensity" ' +
    '- odporuč "rest", presne ako keby tam bol namiesto neho iný AI-navrhnutý náročný deň (dva ' +
    'ťažké/dlhé dni tesne vedľa seba, jeden pevný a jeden ako "odporúčaný", nedáva zmysel o nič ' +
    'viac než dva pevné dni vedľa seba). Všeobecne: NEODPORÚČAJ (t.j. "recommended":true nedávaj ' +
    'na) "rest"/voľno na 3 a viac dní PO SEBE, pokiaľ to jasne nevyžaduje kontext (napr. ' +
    'bezprostredne pred tým niekoľko veľmi náročných dní za sebou, choroba/extrémna únava ' +
    'spomenutá v poznámke). Zlé počasie viac dní po sebe (horúčava, dážď) NIE JE samo o sebe ' +
    'dôvod odporúčať viacdňové voľno - zváž aspoň kratšiu/miernejšiu vonkajšiu alternatívu ' +
    '(indoor momentálne nie je k dispozícii, viď vyššie). Ak z kontextu (nedávna záťaž, ' +
    '"Posledných X dní") vyplýva, že si už oddýchol, uprednostni skôr "long" možnosť pred ďalším ' +
    'odporúčaným "rest" dňom, aj keď vonku prší. SYMETRICKY (toto konkrétne nahlásil Adam ako ' +
    'chýbajúce): ak bolo NEDÁVNO niekoľko namáhavých dní za sebou (opakované "intensity", alebo ' +
    '"long"/vysoký objem bez skutočného voľna medzi nimi) - podľa "Posledných X dní" aj podľa ' +
    'okolitých dní v TOMTO pláne - NEODPORÚČAJ (t.j. "recommended":true nedávaj na) ďalší "long" ' +
    'ani "intensity", aj keby počasie/okno vyzeralo lákavo - v tej chvíli dáva väčšmi zmysel ' +
    '"rest"/pasívna regenerácia a tá by mala byť "recommended":true, presne rovnako ako pri ' +
    'sérii "rest" dní vyššie sa uprednostňuje "long". Viacero dní vysokého objemu za sebou bez ' +
    'skutočného voľna je kumulatívna záťaž, aj keď každý jednotlivý deň bol technicky "len" nižšia ' +
    'zóna.\n' +
    'Odpovedz IBA validným JSON poľom (žiadny markdown, žiadne ```). Každý prvok má "date" a BUĎ ' +
    '"alternatives" (presne 3 položky v poradí rest/long/intensity, pre typ A dni) ALEBO ' +
    '"notePlan"+"noteLabel"+"noteIntensity" (pre typ B dni) - nikdy oboje naraz. Presný tvar:\n' +
    '[{"date":"YYYY-MM-DD","alternatives":[' +
    '{"label":"krátky názov 2-4 slová","intensity":"rest","suggestion":"...","recommended":false,"fuelPlan":null},' +
    '{"label":"...","intensity":"long","suggestion":"...","recommended":true,"fuelPlan":"pred jazdou.. počas prvej hodiny.. potom.. pitný režim.."},' +
    '{"label":"...","intensity":"intensity","suggestion":"...","recommended":false,"fuelPlan":null}' +
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
    lines.push(weatherLineFor(w.date, desc, w.tempMin, w.tempMax, w.precipMm, w.windMaxKmh, planLabel, statusTxt, w.bestWindow, doneTxt, w.sunset));
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
    'pre dni bez vlastnej poznámky vidíš všetky 3 momentálne alternatívy (rest/long/intensity), ' +
    'ktorá z nich je momentálne "recommended" (⭐) a ktorú z nich má užívateľ práve ručne vybranú ' +
    '(VYBRANÉ), ak sa to líši. Toto NIE JE požiadavka na nové generovanie od nuly - len na úpravu ' +
    'existujúceho plánu podľa pokynu používateľa. Indoor tréning Adam momentálne nemá k dispozícii ' +
    '- nenavrhuj ho.\n\n' +
    `POKYN OD POUŽÍVATEĽA: "${instruction}"\n\n` +
    'Uprav LEN tie dni, ktorých sa pokyn reálne týka (napr. "skráť dnešný tréning na 60 minút" = ' +
    'len dnešok; "presuň intervaly na zajtra" = dnešok aj zajtrajšok; "cítim sa dnes unavený, ' +
    'uprav plán" = najbližší deň, prípadne aj deň po ňom, ak to dáva zmysel kvôli nadväznosti). ' +
    'Dni, ktorých sa pokyn netýka, VYNECHAJ úplne z výstupu - ich pôvodné alternatívy ostanú ' +
    'nezmenené. Dni s vlastným plánom (nižšie označené "MÁ VLASTNÝ PLÁN") NIKDY neuprav a ' +
    'nezaraď do výstupu - tie sú mimo dosahu AI úprav. Pre každý upravovaný deň vráť znova ' +
    'VŠETKY 3 alternatívy v rovnakom poradí podľa intenzity (rest, long, intensity) - aj tie, ' +
    'ktoré vecne nemeníš, len ich preformuluj/zachovaj - vrátane poľa "recommended" (presne ' +
    'jedna z 3 má true; ak pokyn mení, čo je pre daný deň najlepšie robiť, uprav aj to, inak ' +
    'zachovaj pôvodnú "recommended" voľbu). Pri "long"/"intensity" nezabudni zachovať/doplniť aj ' +
    'samostatné pole "fuelPlan" (string, NIE súčasť "suggestion" - pred tréningom + hodinu po ' +
    'hodine počas + pitný režim; Adam: 3 fľaše, 2650 ml spolu, vlastný izotonický nápoj 60-80 g ' +
    'cukru + 3-6 g soli na fľašu, často má banány a gumové "žížalky"), pri "rest" nech je ' +
    '"fuelPlan":null. Presne v tomto JSON tvare:\n' +
    '[{"date":"YYYY-MM-DD","alternatives":[' +
    '{"label":"...","intensity":"rest","suggestion":"...","recommended":false,"fuelPlan":null},' +
    '{"label":"...","intensity":"long","suggestion":"...","recommended":false,"fuelPlan":"..."},' +
    '{"label":"...","intensity":"intensity","suggestion":"...","recommended":true,"fuelPlan":"..."}' +
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
    lines.push(weatherLineFor(d.date, d.weatherDesc, d.tempMin, d.tempMax, d.precipMm, d.windMaxKmh, 'BEZ VLASTNÉHO PLÁNU', '', d.bestWindow, null, d.sunset));
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
  // maxOutputTokens 10000 (bolo 7000, 5500, 4096, predtým 2600) + thinkingConfig v callGeminiOnce() -
  // skutočná príčina "Bez návrhu pre všetky dni" bola, že neviditeľné "thinking" tokeny (počítajú
  // sa do maxOutputTokens, ale nie sú vidno vo výstupe) zjedli veľkú časť rozpočtu na tomto veľkom
  // JSON-e, odpoveď sa orezala uprostred a nedala sa naparsovať. Po rozšírení z 8 na 10 dní
  // (9.8.2026), pridaní samostatného podrobnejšieho "fuelPlan" poľa (13.8.2026) a zvýšení
  // thinkingLevel z 'low' na 'medium' (4.9.2026, žiadosť Adama - viac "premýšľania" spotrebuje aj
  // viac neviditeľných tokenov) opäť zvýšené s rezervou.
  const result = await callGemini(prompt, { json: true, maxOutputTokens: 10000 });
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
        sunset: w.sunset || null,
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
        // isté 3 alternatívy by sem nedávali zmysel, keďže deň už má rozhodnutý vlastný plán. Pre
        // ostatné dni až 3 alternatívy (rest/long/intensity), ktoré si frontend (plan.html)
        // vie prepínať a na základe voľby prepočítať okolité dni.
        alternatives: hasOwnNote ? [] : normalizeAlternatives(daySuggestion && daySuggestion.alternatives),
      };
    }),
  };
  archiveExpiredDays(todayForHistory);
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
  // maxOutputTokens 8500 (bolo 6000) - rovnaká rezerva ako pri hlavnom generovaní vyššie, kvôli
  // vyššiemu thinkingLevel ('medium' namiesto 'low', 4.9.2026).
  const result = await callGemini(prompt, { json: true, maxOutputTokens: 8500 });
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
function buildAskPrompt(existingPlan, recentPastDays, qaHistory, question) {
  const lines = [];
  lines.push(
    'Si osobný cyklistický/bežecký kouč pre Adama. Používateľ sa ťa niečo PÝTA - toto NIE JE ' +
    'pokyn na úpravu plánu, iba na jeho existujúci plán a nedávnu formu nižšie ODPOVEDZ. ' +
    'Nevracaj JSON, nevracaj plán, nemeň žiadny deň - len vecná, konkrétna odpoveď (2-6 viet ' +
    'podľa zložitosti otázky) v slovenčine, prípadne s jasným zoznamom, ak sa to na otázku hodí. ' +
    'Ak sa otázka týka pitného režimu/sacharidov, ber do úvahy: Adam má 3 fľaše s celkovou ' +
    'kapacitou 2650 ml (2× 950 ml + 1× 750 ml) a robí si vlastný izotonický nápoj - do každej ' +
    'fľaše zvyčajne 60-80 g bieleho cukru a 3-6 g soli; odporúčania priprav v rámci/blízko tohto ' +
    'zvyčajného rozsahu, nevymýšľaj úplne inú receptúru. Ak sa otázka týka trás/segmentov: Adam má ' +
    'dva porovnávacie segmenty, na ktorých chce podávať čo najlepší výkon - "Valy" (v oblasti ' +
    'Čierneho) a "Husárik" (slepá cesta, len tam a späť) - sú to dve úplne samostatné, ' +
    'geograficky vzdialené miesta, nikdy ich nekombinuj do jednej trasy.\n\n' +
    `OTÁZKA: "${question}"\n`
  );
  lines.push('');
  if (qaHistory && qaHistory.length) {
    lines.push('Predošlé otázky a tvoje odpovede v tomto rozhovore (pre nadväznosť, ak sa nová otázka na niečo z toho odvoláva):');
    qaHistory.slice(-3).forEach(qa => {
      lines.push(`- Ty predtým: "${qa.question}"`);
      lines.push(`  Odpovedal si: "${qa.answer}"`);
    });
    lines.push('');
  }
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

  const prompt = buildAskPrompt(existing, recentPastDays, existing && existing.qaHistory, question);
  console.log(`Odpovedám na otázku: "${question}" (Gemini)...`);
  const result = await callGemini(prompt, { json: false, maxOutputTokens: 700 });
  const answer = result ? result.text : null;
  const usedModel = result ? result.model : (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);

  if (!answer) {
    console.warn('⚠️ Gemini nevrátila odpoveď (chyba API alebo prázdna odpoveď) - "qaHistory" sa nedoplní.');
    return;
  }

  // Ak zatiaľ neexistuje žiadny plán, ulož odpoveď aspoň do prázdnej kostry súboru - Q&A musí
  // fungovať nezávisle od toho, či už bol niekedy vygenerovaný plán.
  const output = existing || { generatedAt: null, model: null, location: 'Čadca, Slovensko', days: [] };
  // OPRAVA 14.8.2026 (žiadosť Adama - "chat s AI čo sa pýtam otázky by sa mohli niekde ukladať"):
  // predtým "qa" bolo jediné pole, ktoré každá nová otázka prepísala - videl si len poslednú.
  // Teraz je to história "qaHistory" (pole), každá nová otázka sa PRIDÁ, nie prepíše. QA_HISTORY_MAX
  // obmedzuje, aby súbor v repe rástol donekonečna - staršie sa postupne odsúvajú.
  const QA_HISTORY_MAX = 30;
  output.qaHistory = Array.isArray(output.qaHistory) ? output.qaHistory : [];
  if (output.qa && !output.qaHistory.length) output.qaHistory.push(output.qa); // jednorazová migrácia zo starého formátu
  delete output.qa;
  output.qaHistory.push({ question, answer, answeredAt: new Date().toISOString(), model: usedModel });
  if (output.qaHistory.length > QA_HISTORY_MAX) output.qaHistory = output.qaHistory.slice(-QA_HISTORY_MAX);
  fs.writeFileSync(PLAN_FILE, JSON.stringify(output, null, 1));
  console.log(`✅ Odpoveď pridaná do data/weather_plan.json (pole "qaHistory", ${output.qaHistory.length} celkom) - dni/alternatívy nedotknuté.`);
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
