// analyze-activity.js
// Generuje AI hodnotenie (Gemini) PRE JEDNU KONKRÉTNU aktivitu - spúšťa sa cez tlačidlo
// "🧠 AI hodnotenie" pri aktivite v Kalendári (calendar.html -> runActivityAnalysis()), ktoré
// dispatchne workflow analyze-activity.yml s inputom activity_id. Na rozdiel od ai-summary.js
// (ktorý beží pravidelne raz denne pre CELÝ deň) tento skript beží LEN na požiadanie, pre presne
// jednu aktivitu podľa jej id.
//
// OPRAVA 20.8.2026 (nahlásené Adamom - "AI hodnotenie pri aktivite v Kalendári nefunguje"): tento
// skript aj príslušný .github/workflows/analyze-activity.yml predtým VÔBEC NEEXISTOVALI -
// runActivityAnalysis() v calendar.html sa pokúšal dispatchnúť workflow, ktorý v repe nebol, takže
// GitHub API volanie vždy spadlo na 404 hneď na prvom kroku.
//
// Očakáva: ACTIVITY_ID, GEMINI_API_KEY (ak GEMINI_API_KEY chýba, skript sa ticho ukončí bez chyby -
// rovnaké správanie ako ai-summary.js/weather-plan.js, nech workflow beh nevyzerá ako zlyhaný len
// preto, že secret ešte nie je nastavený)
// Voliteľné: GEMINI_MODEL

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function loadJsonSafe(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
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

// ---------- Baseline pomocníci (skopírované z ai-summary.js - rovnaká metodika/hranice, aby
// "priemer" v hodnotení aktivity znamenal to isté ako všade inde v appke).
// POZOR: ak zmeníš tieto hranice v app-common.js, zmeň ich aj tu AJ v ai-summary.js. ----------
const AI_HRV_SDNN_MANUAL_CUTOFF = '2026-07-09';
const AI_NEW_METHOD_CUTOFF = '2026-06-07';
const AI_HRV_BASELINE_BOUNDARY = AI_HRV_SDNN_MANUAL_CUTOFF > AI_NEW_METHOD_CUTOFF ? AI_HRV_SDNN_MANUAL_CUTOFF : AI_NEW_METHOD_CUTOFF;
function aiEffectiveHrv(r) {
  if (r.date >= AI_HRV_SDNN_MANUAL_CUTOFF) return (r.hrvSDNN != null ? r.hrvSDNN : r.hrv);
  return r.hrv;
}
function aiTrailingBaseline(recsAsc, field, cutoffDate, beforeDate) {
  let pool = recsAsc.filter(r => r.date < beforeDate);
  if (cutoffDate && beforeDate >= cutoffDate) {
    pool = pool.filter(r => r.date >= cutoffDate);
  }
  pool = pool.slice(-60);
  const vals = pool.map(r => r[field]).filter(v => v != null && !isNaN(v));
  if (vals.length < 5) return null;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
  return { mean: m, std: Math.sqrt(variance) || 1 };
}

function fmtMinutes(secs) { return secs != null ? Math.round(secs / 60) + ' min' : null; }
function fmtKm(m) { return m != null ? (m / 1000).toFixed(1) + ' km' : null; }

// activity: jedna aktivita (z activities_history.json/activities_daily.json, zlúčené).
// wellnessMerged/activitiesMerged: KOMPLETNÁ história (rovnaký vstup ako v ai-summary.js).
function buildActivityPrompt(activity, wellnessMerged, activitiesMerged) {
  const recs = wellnessMerged
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(r => ({ ...r, hrv: aiEffectiveHrv(r) }));

  const dayWellness = recs.find(r => r.date === activity.date) || null;
  const hrvBL = aiTrailingBaseline(recs, 'hrv', AI_HRV_BASELINE_BOUNDARY, activity.date);
  const rhrBL = aiTrailingBaseline(recs, 'restingHR', AI_NEW_METHOD_CUTOFF, activity.date);

  function devLine(label, value, bl, unit) {
    if (value == null || !bl) return null;
    const diff = value - bl.mean;
    return `${label}: ${value}${unit || ''} (priemer ${bl.mean.toFixed(1)}${unit || ''}, ${diff >= 0 ? '+' : ''}${diff.toFixed(1)})`;
  }

  // Kontext záťaže: aktivity za 14 dní PRED touto (bez nej samotnej), zoradené najnovšie prvé.
  const fourteenDaysAgoMs = new Date(activity.date).getTime() - 14 * 86400000;
  const recentActs = (activitiesMerged || [])
    .filter(a => a.id !== activity.id && a.date && new Date(a.date).getTime() >= fourteenDaysAgoMs && a.date <= activity.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const lines = [];
  lines.push(
    'Si osobný tréningový asistent cyklistu/bežca. Nižšie je JEDNA konkrétna aktivita a kontext ' +
    'okolo nej (stav tela v ten deň + záťaž z predošlých 14 dní). Na základe toho napíš stručné, ' +
    'vecné hodnotenie TEJTO KONKRÉTNEJ aktivity - bola primeraná vzhľadom na formu/nedávnu záťaž, ' +
    'alebo rizikovo tvrdá/dlhá? Čo z nej vyplýva pre najbližšie dni (napr. potreba regenerácie)? ' +
    'Ak vidíš niečo pozoruhodné v HR zónach alebo intenzite, spomeň to.'
  );
  lines.push(
    'Odpovedz IBA validným JSON objektom (žiadny markdown, žiadne ```, žiadny text mimo JSON) v ' +
    'tvare {"hodnotenie": "..."} - 4-8 viet v slovenčine, tón appiek ako Whoop/Bevel - vecný, ' +
    'konkrétny, s číslami, bez emoji a bez nadpisov.'
  );
  lines.push('');
  lines.push(`Aktivita (${activity.date}): "${activity.name || activity.type}" (${activity.type || '?'})`);
  [
    activity.moving_time != null ? `Trvanie: ${fmtMinutes(activity.moving_time)}` : null,
    activity.distance != null ? `Vzdialenosť: ${fmtKm(activity.distance)}` : null,
    activity.total_elevation_gain != null ? `Prevýšenie: ${Math.round(activity.total_elevation_gain)} m` : null,
    activity.average_heartrate != null ? `Priemerná TF: ${Math.round(activity.average_heartrate)} bpm${activity.max_heartrate ? ' (max ' + Math.round(activity.max_heartrate) + ')' : ''}` : null,
    activity.icu_training_load != null ? `Tréningová záťaž (load): ${Math.round(activity.icu_training_load)}` : null,
    activity.icu_intensity != null ? `Intenzita: ${Math.round(activity.icu_intensity)} %` : null,
    activity.icu_rpe != null ? `Subjektívna vnímaná náročnosť (RPE): ${activity.icu_rpe}/10` : null,
    activity.comments ? `Popis od jazdca: "${activity.comments}"` : null,
  ].filter(Boolean).forEach(l => lines.push('- ' + l));

  const zoneMinLines = ['hr_z1_secs', 'hr_z2_secs', 'hr_z3_secs', 'hr_z4_secs', 'hr_z5_secs']
    .map((k, i) => activity[k] != null ? `Z${i + 1} ${Math.round(activity[k] / 60)} min` : null)
    .filter(Boolean);
  if (zoneMinLines.length) lines.push(`- HR zóny: ${zoneMinLines.join(', ')}`);

  if (dayWellness) {
    lines.push('');
    lines.push(`Stav tela v deň aktivity (${activity.date}) oproti vlastnému priemeru (posledných ~60 dní PRED touto aktivitou):`);
    [
      devLine('HRV', dayWellness.hrv, hrvBL, ' ms'),
      devLine('Pokojová TF', dayWellness.restingHR, rhrBL, ' bpm'),
    ].filter(Boolean).forEach(l => lines.push('- ' + l));
    if (dayWellness.ctl != null && dayWellness.atl != null) {
      const tsb = dayWellness.ctl - dayWellness.atl;
      lines.push(`- CTL (fitness) ${dayWellness.ctl.toFixed(1)}, ATL (únava) ${dayWellness.atl.toFixed(1)}, TSB (forma) ${tsb.toFixed(1)}`);
    }
  }

  lines.push('');
  if (recentActs.length) {
    lines.push('Aktivity za 14 dní PRED touto (najnovšie prvé):');
    recentActs.forEach(a => {
      const mins = a.moving_time ? Math.round(a.moving_time / 60) : null;
      lines.push(`- ${a.date} "${a.name || a.type}"${mins ? ', ' + mins + ' min' : ''}${a.icu_training_load ? ', load ' + Math.round(a.icu_training_load) : ''}`);
    });
  } else {
    lines.push('Žiadne ďalšie zaznamenané aktivity za 14 dní pred touto.');
  }

  return lines.join('\n');
}

// ---------- Gemini volanie (skopírované z ai-summary.js - rovnaké modely/fallbacky/thinking
// config, aby sa oba skripty správali konzistentne a dali sa udržiavať na jednom mieste v hlave).
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const FALLBACK_GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash'];

function thinkingConfigFor(model) {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: 'low' };
}

async function callGeminiOnce(model, key, prompt, opts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const generationConfig = {
    temperature: 0.7,
    maxOutputTokens: opts.maxOutputTokens || 1024,
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

async function callGemini(prompt, opts) {
  opts = opts || {};
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log('ℹ️ GEMINI_API_KEY nie je nastavený - preskakujem AI hodnotenie aktivity.');
    return null;
  }
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
  console.warn('⚠️ Všetky Gemini modely zlyhali (napr. všetky preťažené/503) - AI hodnotenie sa tento beh nevygeneruje.');
  return null;
}

async function main() {
  const activityId = process.env.ACTIVITY_ID;
  if (!activityId) {
    console.error('❌ Chýba ACTIVITY_ID (env premenná) - workflow ju musí dostať ako input z tlačidla na stránke.');
    process.exit(1);
  }

  const activitiesMerged = mergeById(
    loadJsonSafe(path.join(DATA_DIR, 'activities_history.json')),
    loadJsonSafe(path.join(DATA_DIR, 'activities_daily.json')), 'id'
  );
  const activity = activitiesMerged.find(a => String(a.id) === String(activityId));
  if (!activity) {
    // Napr. aktivita bola medzičasom vymazaná z Intervals.icu (viď oprava v sync.js) skôr, než
    // stihlo prebehnúť toto hodnotenie - nepovažuj to za chybu behu, len sa ticho ukonči.
    console.log(`ℹ️ Aktivita ${activityId} sa v activities_history.json/activities_daily.json nenašla (možno bola odvtedy vymazaná) - nič na vyhodnotenie.`);
    return;
  }

  const wellnessMerged = mergeById(
    loadJsonSafe(path.join(DATA_DIR, 'wellness_history.json')),
    loadJsonSafe(path.join(DATA_DIR, 'wellness_daily.json')), 'id'
  );

  const prompt = buildActivityPrompt(activity, wellnessMerged, activitiesMerged);
  console.log(`Generujem AI hodnotenie pre aktivitu ${activityId} ("${activity.name || activity.type}", ${activity.date})...`);
  const result = await callGemini(prompt, { json: true, maxOutputTokens: 1024 });
  const raw = result ? result.text : null;
  let hodnotenie = null;
  if (raw) {
    let jsonStr = raw.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      hodnotenie = parsed.hodnotenie || null;
    } catch (e) {
      console.warn('⚠️ Odpoveď z Gemini sa nedala naparsovať ako JSON, ukladám ako čistý text:', e.message);
      hodnotenie = raw;
    }
  }
  if (!hodnotenie) {
    console.log('ℹ️ AI hodnotenie sa nevygenerovalo (chýba kľúč, chyba API, alebo sa odpoveď nedala spracovať) - pozri warning vyššie.');
    return;
  }

  // Kľúčovaný objekt podľa activity id (rovnaký vzor ako ai_summary_history.json podľa dátumu) -
  // calendar.html číta ANALYSES[a.id].text a ANALYSES[a.id].generatedAt (na zistenie, či sa
  // hodnotenie od poslednej kontroly zmenilo, keď stránka čaká na dokončenie behu).
  const analysesFile = path.join(DATA_DIR, 'activity_analyses.json');
  const analyses = loadJsonObjectSafe(analysesFile) || {};
  analyses[activityId] = {
    generatedAt: new Date().toISOString(),
    model: result.model,
    text: hodnotenie,
  };
  fs.writeFileSync(analysesFile, JSON.stringify(analyses, null, 1));
  console.log(`✅ AI hodnotenie pre aktivitu ${activityId} uložené (data/activity_analyses.json).`);
}

main().catch(err => {
  console.error('❌ Chyba pri generovaní AI hodnotenia aktivity:', err.message);
  process.exit(1);
});
