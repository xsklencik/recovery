// heart-strain.js
// ---------------------------------------------------------------------------
// Počíta CELODENNÝ Strain priamo z nepretržitého (minútového) srdcového tepu,
// namiesto z Intervals.icu Load + krokov. Vstup: CSV exporty z Huawei Health
// (Google Drive → "Heart rate YYYY.MM.DD Huawei Health.csv"), ktoré si Adam
// commitne/pushne RUČNE do priečinka data/heart_rate_raw/. Tento skript ich
// spracuje a výsledok (jedno číslo Strain 0-21 na deň + pár diagnostických
// polí) uloží do data/hr_strain_daily.json, kľúčované podľa dátumu.
//
// app-common.js (browser) potom pri výpočte Strain pre daný deň POUŽIJE túto
// hodnotu namiesto starého výpočtu z Load/krokov, ak pre ten deň existuje -
// viď computeDailyStrain() v app-common.js. Dni BEZ CSV dát (napr. história
// pred 18.7.2026, keď export ešte neexistoval) naďalej používajú starý
// Load+kroky výpočet - žiadna spätná dáta sa nestratia.
//
// Spustenie: node heart-strain.js
// (voliteľne cez GitHub Action, ktorá sa spustí pri pushnutí nového CSV do
// data/heart_rate_raw/ - pozri .github/workflows/heart-strain.yml)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const RAW_DIR = path.join(__dirname, 'data', 'heart_rate_raw');
const OUT_FILE = path.join(__dirname, 'data', 'hr_strain_daily.json');

// ---------------------------------------------------------------------------
// Fyziologické konštanty - ODHADNUTÉ spätne z Adamových Karvonen zón, ktoré má
// nastavené v Intervals.icu (Z1 <143 · Z2 144-157 · Z3 158-171 · Z4 172-185 ·
// Z5 ≥186 bpm). Karvonen: HR = HRrest + %HRR*(HRmax-HRrest). Zo 4 hraníc zón
// (143.5/157.5/171.5/185.5, po 10 % HRR kroku od 60 do 90 %) vychádza:
//   HRmax - HRrest = 140,  HRrest ≈ 60 bpm,  HRmax ≈ 200 bpm
// (200 bpm sedí aj s odhadom 220-vek pre 20-ročného). Ak by tvoje SKUTOČNÉ
// HRrest/HRmax boli iné (napr. z testu), uprav tu - inak sa celý prepočet
// posunie.
const HR_REST = 60;
const HR_MAX = 200;
// Hranica medzi Z1 a Z2 podľa tvojho nastavenia v Intervals.icu - POD touto
// hranicou to Adam sám nepovažuje za tréningovú zónu (Z1 = "<143", teda
// všetko od spánku po ľahký pohyb). NAD touto hranicou začína skutočná
// kardio záťaž (Z2-Z5).
const Z1_Z2_BOUNDARY = 143;

// Banister TRIMP koeficient (b=1.92 pre mužov, 1.67 pre ženy) - exponenciálne
// zvýhodňuje vyššiu intenzitu, rovnaký princíp ako existujúce zónové váhy
// (exp(0.55*zóna)) v app-common.js, len aplikovaný SPOJITO na %HRR namiesto
// diskrétnych zón (počíta sa minútu po minúte cez celý deň).
//
// DÔLEŽITÉ (zistené testom na syntetickom dni): naivný Banister TRIMP
// aplikovaný od HRrest celý deň VÝRAZNE PREĎAĽUJE bežnú dennú TF (70-100 bpm
// pri sedení/chôdzi/škole) - aj deň BEZ AKÉHOKOĽVEK tréningu vyšiel na
// Strain~15-20, lebo exponenciála nie je pri 15-25 % HRR zanedbateľná a cez
// 14-16 hodín bdenia sa to nasčíta. Preto Banister exponenciála platí LEN NAD
// Z1_Z2_BOUNDARY (143 bpm = tvoja vlastná hranica "toto už je tréning") -
// pod ňou (ale nad pokojovou TF, teda bdenie/bežný pohyb bez cvičenia)
// dostane minúta len malý PLOCHÝ príspevok (SUBZONE_RATE), nie exponenciálu.
// Spánok/hlboký pokoj (HR ≤ HRrest) neprispieva vôbec.
const TRIMP_B = 1.92;
const SUBZONE_RATE = 0.045; // raw/min pre bdenie pod 143 bpm (bežný denný pohyb, NEAT)

// Škálovací faktor pre časť NAD 143 bpm - prevádza súčet minútových TRIMP
// príspevkov na rovnaké "raw" jednotky, aké používa existujúci
// rawToStrain(raw) v app-common.js (raw~140 → Strain~13.3). TOTO JE PRVÁ
// KALIBRÁCIA - porovnaj pár reálnych dní so starým Strain číslom (dni, keď
// máš aj Load aj CSV) a over, či celkový pocit (Ľahký/Stredný/Vysoký deň)
// sedí; ak nie, uprav HR_STRAIN_SCALE (>1 = vyšší Strain za tú istú
// intenzitu, <1 = nižší).
const HR_STRAIN_SCALE = 1.0;

// MUSÍ zostať v súlade s rawToStrain() v app-common.js (rovnaká škála 0-21).
function rawToStrain(raw) {
  if (raw <= 0) return 0;
  return 21 * (1 - Math.exp(-raw / 140.0));
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------
// Očakávaný formát (Huawei Health export cez Google Drive "Health Sync"):
//   Date\tTime\tHeart rate\tSource
//   2026.07.29 00:00:00\t00:00:00\t58\t
// Podporuje tabulátor aj čiarku ako oddeľovač. Riadky s prázdnym/neplatným
// tepom sa preskočia (napr. keď hodinky neboli nasadené/nabíjali sa) - menej
// nameraných minút v daný deň jednoducho znamená menší (nie skreslený) súčet.
function parseCsvFile(filePath) {
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
    // "2026.07.29 00:00:00" -> dátumová časť "2026.07.29" -> "2026-07-29"
    const datePart = dateRaw.split(' ')[0];
    const isoDate = datePart.replace(/\./g, '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) continue;
    rows.push({ date: isoDate, hr });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// TRIMP výpočet pre jeden deň (3 pásma, pozri komentár pri konštantách vyššie)
// ---------------------------------------------------------------------------
function dayTrimp(hrValues) {
  let raw = 0, sum = 0, max = 0;
  for (const hr of hrValues) {
    if (hr > HR_REST) {
      if (hr < Z1_Z2_BOUNDARY) {
        raw += SUBZONE_RATE;
      } else {
        const hrr = clamp((hr - HR_REST) / (HR_MAX - HR_REST), 0, 1);
        const weight = 0.64 * Math.exp(TRIMP_B * hrr);
        raw += hrr * weight * HR_STRAIN_SCALE;
      }
    }
    sum += hr;
    if (hr > max) max = hr;
  }
  return {
    raw,
    minutes: hrValues.length,
    avgHR: hrValues.length ? Math.round((sum / hrValues.length) * 10) / 10 : null,
    maxHR: hrValues.length ? max : null,
  };
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.log(`ℹ️ ${RAW_DIR} neexistuje - nič na spracovanie (vytvor priečinok a commitni doň CSV).`);
    return;
  }
  const files = fs.readdirSync(RAW_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  if (files.length === 0) {
    console.log('ℹ️ V data/heart_rate_raw/ nie sú žiadne .csv súbory.');
    return;
  }

  // Riadky zo VŠETKÝCH súborov sa najprv zoskupia podľa dátumu (jeden deň sa
  // môže teoreticky rozdeliť do viacerých exportov, alebo prekrývať) - takto
  // sa to spracuje správne bez ohľadu na názov súboru.
  const byDate = new Map(); // date -> [hr, hr, ...]
  let filesRead = 0;
  for (const file of files) {
    const rows = parseCsvFile(path.join(RAW_DIR, file));
    if (rows.length === 0) continue;
    filesRead++;
    for (const { date, hr } of rows) {
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(hr);
    }
  }
  console.log(`📄 Spracovaných súborov: ${filesRead}/${files.length}, dní s dátami: ${byDate.size}`);

  const existing = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};
  for (const [date, hrValues] of byDate.entries()) {
    const { raw, minutes, avgHR, maxHR } = dayTrimp(hrValues);
    existing[date] = {
      strain: Math.round(rawToStrain(raw) * 10) / 10,
      raw: Math.round(raw * 10) / 10,
      minutes,
      avgHR,
      maxHR,
      source: 'heart_rate_csv',
      computedAt: new Date().toISOString(),
    };
    console.log(`  ${date}: ${minutes} min, Ø${avgHR} max${maxHR} bpm → Strain ${existing[date].strain}`);
  }

  const sorted = {};
  Object.keys(existing).sort().forEach(d => { sorted[d] = existing[d]; });
  fs.writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 1));
  console.log(`✅ Uložené do ${path.relative(__dirname, OUT_FILE)} (${Object.keys(sorted).length} dní spolu).`);
}

main();
