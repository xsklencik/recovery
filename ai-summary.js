// ai-summary.js
// Generuje/aktualizuje AI súhrn dňa (Gemini) - ÚPLNE ODDELENÉ od sync.js/Intervals.icu.
// Nerobí žiadne Intervals.icu API volania, len číta už-commitnuté data/*.json súbory (tie
// napĺňa sync.js) a volá Gemini. Vďaka tomu môže bežať na VLASTNOM, oveľa riedšom rozvrhu
// (raz denne ráno) nezávisle od toho, ako často beží bežný sync.
//
// Spúšťa sa buď: (a) vlastným cron-job.org behom raz denne ráno cez workflow_dispatch,
// (b) manuálne cez tlačidlo "🧠 AI súhrn" na stránke (posiela FORCE_AI=true).
//
// Očakáva: GEMINI_API_KEY (ak chýba, skript sa ticho ukončí bez chyby)
// Voliteľné: GEMINI_MODEL (default nižšie), FORCE_AI ('true' = vygeneruj aj keď dnešný už existuje)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

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
function mergeById(existing, incoming, idField) {
  const map = new Map(existing.map(r => [r[idField], r]));
  for (const r of incoming) map.set(r[idField], r);
  return Array.from(map.values());
}

// ---------- AI pamäť ako .md ----------
// "## YYYY-MM-DD" nadpis, za ním text až po ďalší nadpis. Formát píše/číta len tento skript.
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
// do baseline nikdy nepočíta). Rovnaká metodika ako rollingStats() v app-common.js.
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

const STATUS_LABELS = { sick: 'Chorý', injured: 'Zranený', break: 'Pauza (dobrovoľné voľno)' };

// wellnessMerged/activitiesMerged: KOMPLETNÁ história (history + daily zlúčené volajúcim).
// pastSummaries: posledných pár vlastných AI súhrnov (z data/ai_memory.md) - "pamäť" naprieč
// dňami, keďže samotné volanie Gemini je bezstavové.
// globalStatus: obsah data/status.json (Activity Status karta na Dashboarde - všeobecný
// "aktuálny" stav, zapisuje sa priamo z prehliadača cez GitHub Contents API).
// dayNotes: obsah data/day_notes.json (Kalendár - poznámky/plány NA KONKRÉTNY DEŇ, vrátane
// budúcich, môžu voliteľne niesť aj vlastné pole "status" pre ten konkrétny deň - ak existuje,
// MÁ PREDNOSŤ pred globalStatus pre daný dátum, keďže je presnejšie/aktuálnejšie).
function buildAiPrompt(wellnessMerged, activitiesMerged, pastSummaries, globalStatus, dayNotes) {
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
    'vlastnému priemeru a nedávnej tréningovej záťaže. Ak v histórii jeho vlastných ' +
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

  // Stav pre DNEŠNÝ deň: ak má kalendárová poznámka pre dnešok vlastné pole "status", má
  // prednosť pred všeobecným status.json (presnejšie - vieš si nastaviť status vopred na
  // konkrétny deň, napr. "zajtra som chorý", nielen "práve teraz som chorý").
  const todayNote = (dayNotes || []).find(n => n.date === today.date);
  const effectiveStatus = (todayNote && todayNote.status) ? todayNote.status
    : (globalStatus && globalStatus.status) ? globalStatus.status : 'active';
  const statusSource = (todayNote && todayNote.status) ? `kalendár na ${today.date}` : 'všeobecný Stav';
  if (effectiveStatus !== 'active') {
    lines.push(`Aktuálny stav: ${STATUS_LABELS[effectiveStatus] || effectiveStatus} (zdroj: ${statusSource}) - zohľadni to v odporúčaní, netlač na tréning.`);
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
      relevant.forEach(n => lines.push(`- ${n.date}: "${n.note.trim()}"${n.status ? ' [stav: ' + (STATUS_LABELS[n.status] || n.status) + ']' : ''}`));
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

// Free tier Gemini API (Flash/Flash-Lite modely cez Google AI Studio kľúč) je k júlu 2026
// naozaj bez poplatku, bez karty. Google si na free tieri vyhradzuje právo použiť obsah
// promptu na zlepšovanie svojich modelov.
//
// POZOR - toto sa už raz stalo (21.7.2026): modely v Gemini API sa menia/rušia OVEĽA rýchlejšie
// než by človek čakal - `gemini-2.5-flash` bol vyradený a vracal 404 mesiace pred pôvodne
// oznámeným dátumom vypnutia. Ak uvidíš v logu "404", zisti aktuálny názov na
// aistudio.google.com/models a nastav ho ako GitHub secret/variable GEMINI_MODEL - kód sa
// nemusí meniť. Aktuálny default (gemini-3.6-flash, PLNÝ Flash nie Lite - výkonnejší, stále
// free tier k 26.7.2026) - ak by robil problémy, over/skús gemini-3.5-flash ako zálohu.
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

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

// Koľko dní vlastných AI súhrnov sa posiela SPÄŤ do promptu (kontext/kontinuita) a koľko sa
// ich maximálne drží v samotnom súbore.
const AI_MEMORY_PROMPT_DAYS = 14;
const AI_MEMORY_FILE_DAYS = 180;

async function main() {
  const wellnessForAi = mergeById(
    loadJsonSafe(path.join(DATA_DIR, 'wellness_history.json')),
    loadJsonSafe(path.join(DATA_DIR, 'wellness_daily.json')), 'id'
  );
  const activitiesMerged = mergeById(
    loadJsonSafe(path.join(DATA_DIR, 'activities_history.json')),
    loadJsonSafe(path.join(DATA_DIR, 'activities_daily.json')), 'id'
  );
  if (wellnessForAi.length === 0) {
    console.log('ℹ️ Žiadne wellness dáta v repe (wellness_history.json/wellness_daily.json prázdne) - niet z čoho generovať súhrn.');
    return;
  }

  const aiMemoryFile = path.join(DATA_DIR, 'ai_memory.md');
  const aiMemoryAll = loadAiMemoryMd(aiMemoryFile);
  const pastSummaries = aiMemoryAll.slice(-AI_MEMORY_PROMPT_DAYS);

  const globalStatus = loadJsonObjectSafe(path.join(DATA_DIR, 'status.json'));
  const dayNotes = loadJsonSafe(path.join(DATA_DIR, 'day_notes.json'));

  const aiCtx = buildAiPrompt(wellnessForAi, activitiesMerged, pastSummaries, globalStatus, dayNotes);
  if (!aiCtx) { console.log('ℹ️ Prompt sa nedal zostaviť.'); return; }

  const aiSummaryFile = path.join(DATA_DIR, 'ai_summary_daily.json');
  const existingAi = loadJsonObjectSafe(aiSummaryFile);
  const forceAi = String(process.env.FORCE_AI || '').toLowerCase() === 'true';
  if (existingAi && existingAi.date === aiCtx.date && !forceAi) {
    console.log(`ℹ️ AI súhrn pre ${aiCtx.date} už existuje - preskakujem (FORCE_AI=true na vynútenie, napr. z tlačidla na stránke).`);
    return;
  }

  console.log('Generujem AI súhrn dňa (Gemini)...');
  const raw = await callGemini(aiCtx.prompt, { json: true, maxOutputTokens: 900 });
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
  if (!kratky) {
    console.log('ℹ️ AI súhrn sa nevygeneroval (chýba kľúč, chyba API, alebo sa odpoveď nedala spracovať) - pozri warning vyššie.');
    return;
  }

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
  const updatedMemory = mergeById(
    aiMemoryAll.map(e => ({ ...e, id: e.date })), [{ id: aiCtx.date, date: aiCtx.date, summary: kratky }], 'id'
  ).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-AI_MEMORY_FILE_DAYS);
  fs.writeFileSync(aiMemoryFile, serializeAiMemoryMd(updatedMemory));
  console.log('✅ AI súhrn dňa uložený (a pripísaný do ai_memory.md).');
}

main().catch(err => {
  console.error('❌ Chyba pri generovaní AI súhrnu:', err.message);
  process.exit(1);
});
