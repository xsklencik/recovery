// Rýchly test, či Gemini API kľúč a model fungujú - BEZ toho, aby si musel spúšťať celý sync.js
// (žiadne Intervals.icu volania, žiadny git commit, len jedno malé Gemini volanie).
//
// Použitie lokálne:
//   GEMINI_API_KEY=tvoj_kluc node test-gemini.js
//   GEMINI_API_KEY=tvoj_kluc GEMINI_MODEL=gemini-3.5-flash-lite node test-gemini.js   (iný model)
//
// Použitie cez GitHub Actions (bez sťahovania repa lokálne): repo -> Actions -> "Test Gemini API"
// -> Run workflow (ak si pridal aj priložený test-gemini.yml, pozri NAVOD.md).

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

if (!key) {
  console.error('❌ GEMINI_API_KEY nie je nastavený v prostredí. Spusti napr.:');
  console.error('   GEMINI_API_KEY=tvoj_kluc node test-gemini.js');
  process.exit(1);
}

async function main() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  console.log(`Testujem model "${model}"...`);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Odpovedz presne jedným slovom: "funguje".' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 20 },
      }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`❌ Gemini API vrátilo chybu ${res.status} po ${ms} ms:`);
      console.error(txt);
      if (res.status === 404) {
        console.error('\n👉 404 zvyčajne znamená, že model "' + model + '" už neexistuje/bol vyradený.');
        console.error('   Choď na https://aistudio.google.com/ -> "Models" a over si aktuálny názov,');
        console.error('   potom ho nastav ako GEMINI_MODEL (GitHub secret alebo env premenná).');
      } else if (res.status === 429) {
        console.error('\n👉 429 = prekročený limit (rate limit / denná kvóta). Skús o chvíľu znova.');
      } else if (res.status === 400) {
        console.error('\n👉 400 zvyčajne znamená zlý formát requestu alebo neplatný kľúč.');
      } else if (res.status === 403) {
        console.error('\n👉 403 zvyčajne znamená neplatný/zablokovaný API kľúč.');
      }
      process.exit(1);
    }
    const data = await res.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    console.log(`✅ Funguje! Model "${model}" odpovedal za ${ms} ms:`);
    console.log('   ' + (text ? text.trim() : '(prázdna odpoveď - nezvyčajné, over si model)'));
  } catch (e) {
    console.error('❌ Chyba siete/spojenia:', e.message);
    process.exit(1);
  }
}

main();
