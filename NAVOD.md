# Recovery / Strain — ako to funguje

Referenčný dokument, nie návod na inštaláciu (appka je už nasadená na
`https://xsklencik.github.io/recovery/`). Toto popisuje, čo sa reálne deje
a prečo je to postavené presne takto — hlavne pre budúceho mňa, keď za
3 mesiace zabudnem, prečo je niečo urobené netriviálne.

## Architektúra v skratke

```
cron-job.org (každých ~10 min)
  → POST na GitHub REST API: workflow_dispatch pre sync.yml
    (rovnaký endpoint, aký volá aj tlačidlo "🔄 Aktualizovať" na stránke)
  → GitHub Actions spustí sync.js
      → stiahne posledné SYNC_DAYS dni z Intervals.icu
      → zlúči do data/wellness_daily.json + data/activities_daily.json
      → skúsi AI súhrn dňa cez Gemini (ale len raz za deň, pozri nižšie)
      → commitne + pushne zmeny

Keď niekto (ja) otvorí stránku:
  index.html stiahne wellness_history.json (stará história) +
  wellness_daily.json (nové dáta) + rovnako pre activities +
  ai_summary_daily.json (ak existuje)
  → computeResults() v app-common.js spočíta Recovery/Strain v prehliadači
  → vykreslí grafy + AI kartu
```

Žiadny krok tu nie je server v klasickom zmysle — GitHub Pages servíruje
statické súbory, GitHub Actions je jediný "backend" a beží len na požiadanie
(cez cron-job.org), nie ako vlastný proces.

### Prečo cron-job.org a nie natívny GitHub Actions `schedule:`

Natívny `schedule:` trigger v `sync.yml` (cron `0 5 * * *`) je tam stále
zapísaný, ale **nespoľahol som sa naň** — GitHub scheduled workflows sú
notoricky nespoľahlivé (bežné oneskorenia 15–60+ min pri vyššej záťaži
GitHubu, a plánované behy sa automaticky vypnú, ak repo 60 dní nemá žiadny
push). Namiesto toho cron-job.org volá **priamo GitHub REST API**
(`POST /repos/xsklencik/recovery/actions/workflows/sync.yml/dispatches`,
s `Authorization: Bearer <fine-grained PAT>`, telom `{"ref":"main"}`) každých
~10 minút. To je ten istý mechanizmus, aký používa aj tlačidlo
"🔄 Aktualizovať" na stránke (viď `btn-refresh` handler v `index.html`, ktorý
robí presne tento istý fetch a potom pollne `last_sync.json`, kým sa
nezmení).

**Dôsledok:** `sync.js` beží cca 144x denne, nie 1x denne. To je dôležité
pre pochopenie AI súhrnu nižšie — bez poistky by sa Gemini volalo zakaždým.

### Sekrety (Settings → Secrets and variables → Actions)

| Secret | Na čo | Povinný? |
|---|---|---|
| `ICU_API_KEY` | autentifikácia voči Intervals.icu API | áno |
| `ICU_ATHLETE_ID` | `i347389` | áno |
| `GEMINI_API_KEY` | AI súhrn dňa (Google AI Studio, zadarmo) | nie — ak chýba, tento krok sa ticho preskočí, zvyšok syncu beží normálne |

### Token pre tlačidlo "🔄 Aktualizovať" / cron-job.org

Fine-grained GitHub PAT (Settings → Developer settings → Personal access
tokens), scope len na repo `recovery`, permission **Contents: Read and
write**. Na stránke sa ukladá cez tlačidlo **⚙️ Token** len do localStorage
prehliadača (nikdy do repa). Ten istý token má aj cron-job.org vo svojej
konfigurácii (custom header), keďže volá ten istý endpoint.

---

## AI súhrn dňa (Gemini) — throttling, tlačidlo, frekvencia

Keďže `sync.js` beží prakticky nepretržite (cca každých 10 min), volanie
Gemini pri každom behu by bolo zbytočné (rovnaké ranné dáta) aj plytvalo
denný limit zadarmo. `sync.js` preto pred volaním Gemini najprv skontroluje
`data/ai_summary_daily.json`:

- ak už existuje záznam **pre dnešný dátum** a nebolo vynútené → Gemini sa
  vôbec nevolá (log: `AI súhrn pre {dátum} už existuje - preskakujem`)
- ak nie, alebo bolo vynútené → zavolá sa Gemini, výsledok sa uloží

V praxi to znamená: prvý beh po tom, čo sa ráno objaví nový wellness záznam,
vygeneruje AI súhrn automaticky. Všetky ďalšie automatické behy v ten istý
deň ho len preskočia.

### Tlačidlo "🧠 AI súhrn" (manuálne vynútenie)

Keďže throttling znamená "najviac raz denne automaticky", pridal som na
stránku tlačidlo, ktoré throttling obchádza — volá presne ten istý
`workflow_dispatch` ako "🔄 Aktualizovať", len s `inputs.force_ai: "true"`.
`sync.js` v tom prípade vygeneruje nový AI súhrn aj keď dnešný už existuje.
Tlačidlo čaká na zmenu `generatedAt` v `data/ai_summary_daily.json` (rovnaký
poll-princíp ako pri refreshi) a potom stránku prekreslí.

### Ako často to môžem volať?

Prakticky bez limitu pri tomto objeme. Rozpad:
- **Gemini free tier** (`gemini-2.5-flash`/`flash-lite`): rádovo stovky až
  tisícky requestov/deň. Pár manuálnych klikov + 1 cron denne = zanedbateľné.
- **GitHub Actions `workflow_dispatch`**: žiadny zmysluplný denný limit pre
  osobné použitie (viaže sa na bežné GitHub API rate limity, tisícky/hodinu).
- **Intervals.icu**: 10 req/s - každé spustenie `sync.js` urobí len 2-3
  volania, takže aj desiatky klikov denne sú úplne v poriadku.

Tvoj plán (max. ~3 manuálne kliky + 1x denne cron-job.org ráno) je teda
ďaleko pod akýmkoľvek reálnym limitom - pokojne by to zvládlo aj rádovo
desiatky klikov denne, keby si niekedy chcel.

### cron-job.org úloha č. 2: automatický AI súhrn každé ráno

Toto je **druhá, samostatná úloha** v cron-job.org (popri tej, čo ti už beží
každých 10 min pre bežný sync) - nastav ju na 1x denne ráno (napr. o 6:45,
tesne po tom, čo prvá úloha stihne pretiahnuť ranné wellness dáta):

- **URL:** `https://api.github.com/repos/xsklencik/recovery/actions/workflows/sync.yml/dispatches`
- **Metóda:** POST
- **Hlavičky:**
  - `Authorization: Bearer <tvoj fine-grained PAT>` (ten istý token ako pre bežný sync)
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- **Telo (Request body):** `{"ref":"main","inputs":{"days":"1","force_ai":"true"}}`

Toto spustí plný sync (neškodí, len 1x navyše denne) a navyše vynúti nový AI
súhrn aj keby už dnešný existoval z skoršieho automatického behu.

**Free tier:** k júlu 2026 sú modely `gemini-2.5-flash` / `flash-lite` cez
Google AI Studio kľúč naozaj bez poplatku, žiadna karta netreba. Jediný
kompromis: Google si na free tieri vyhradzuje právo použiť obsah promptu na
zlepšovanie svojich modelov (na platenom tieri nie).

**Ako sa buduje kontext pre AI:** `buildAiPrompt()` v `sync.js` berie
zlúčenú históriu (`wellness_history.json` + `wellness_daily.json` — pozor,
`wellness_daily.json` samo osebe má len pár týždňov, preto treba oba súbory)
a počíta jednoduchý 60-dňový priemer/odchýlku (rovnaká metodika ako
`rollingStats()` v `app-common.js`, len zjednodušená len na "dnešný deň", nie
na celú sériu). Zámerne **NEpočíta** oficiálne Recovery %/Strain skóre appky
(to je zložitejší vážený model, ktorý beží v prehliadači) — AI dostáva
surové HRV/TF/spánok + odchýlky a text ich opisuje slovami, aby sa nikdy
nerozchádzal s číslom, ktoré appka reálne zobrazuje. Ak `data/status.json`
(pozri "Stav" nižšie) hovorí niečo iné než "aktívny", pridá sa to do promptu
tiež, nech to Gemini zohľadní v odporúčaní.

**Diagnostika, ak sa karta na stránke nezobrazuje:** GitHub → Actions →
posledný beh `sync.yml` → v logu hľadaj riadky s `AI súhrn` — buď uvidíš
dôvod preskočenia (chýba kľúč / API chyba / už vygenerované dnes), alebo
`✅ AI súhrn dňa uložený`. Ak sa uložil, ale karta sa aj tak nezobrazuje,
skontroluj že `data/ai_summary_daily.json` v repe reálne existuje a že
`index.html` v repe obsahuje `id="ai-card"` (overí, že sa nahral správny
súbor a GitHub Pages cache sa už obnovila).

---

## Stav (Activity Status)

Karta na dashboarde (Aktívny / Chorý / Zranený / Pauza), inšpirovaná Bevel
appkou. Na rozdiel od zvyšku appky sa **nezapisuje cez `sync.js`/Intervals.icu**
- klik rovno z prehliadača zavolá GitHub Contents API
(`PUT /repos/xsklencik/recovery/contents/data/status.json`) tým istým PAT
tokenom, čo používa aj tlačidlo Aktualizovať. Žiadny GitHub Actions beh
netreba, zmena sa prejaví v repe do sekundy. `sync.js` si tento súbor pri
ďalšom behu len prečíta a pridá ako kontext pre AI súhrn (pozri vyššie).

---

## Čo appka reálne počíta (algoritmus)

Popis logiky v `app-common.js` — čo sa deje s dátami od chvíle, čo prídu
z Intervals.icu, po to, čo vidíš na obrazovke.

### Recovery % (0–100)

Váži sa **60 % fyziológia · 40 % tréningová únava**:

| zložka | váha | zdroj |
|---|---|---|
| HRV | 30 % | pole `hrv` (pozri nižšie — SDNN vs rMSSD) |
| Spánková TF (`avgSleepingHR`) | 15 % | priemer TF počas noci z hodiniek |
| Denná pokojová TF (`restingHR`) | 10 % | denná hodnota z Intervals.icu |
| Sleep score | 5 % | `sleepScore` z Intervals.icu |
| Tréningová únava (Fatigue Score) | 40 % | pozri nižšie |

Fyziologické zložky (HRV/TF/spánok) sa počítajú ako **z-skóre voči tvojmu
60-dňovému kĺzavému priemeru** (zvlášť pre obdobie pred a po zmene metódy
merania, pozri `NEW_METHOD_CUTOFF`/`HRV_SDNN_MANUAL_CUTOFF` nižšie) a mapujú sa
na stupnicu s posunutým stredom, takže priemerný deň vychádza cca na 63 %,
nie na 50 %. Baseline pre `restingHR` sa reštartuje na rovnakom dátume ako
spánková TF (`NEW_METHOD_CUTOFF`, 7.6.2026) - ovplyvnila ju tá istá zmena
metódy/senzora, takže staré a nové hodnoty by sa inak miešali do jedného
priemeru.

**Farba (ring aj verdikt) je plynulý prechod, nie 3 pásma:** `gradientColor()`
lineárne interpoluje medzi farebnými "zastávkami" (napr. pre Recovery: 0=červená,
34=jantárová, 67=zelená, 100=sýto zelená), takže napr. 69 % a 70 % vyzerajú
takmer identicky namiesto skoku cez starú pevnú hranicu. Textový verdikt
("Udržiavaj Z1/Z2" a pod.) zostáva na pevných hraniciach (34/67) - tie majú
zmysel ako kategórie, len farba už nie je skoková.

**Nočná TF má vyššiu váhu než denná** (15 % vs. 10 %) — podľa toho, ako to
robia Whoop/Oura (ich "resting HR" je v podstate vždy nočný priemer, nie
samostatná denná hodnota).

### HRV — rMSSD vs. SDNN (dôležité pre históriu dát)

Do 8.7.2026 si ručne zapisoval priemernú nočnú HRV do poľa `hrv` (rMSSD).
Od **9.7.2026** (`HRV_SDNN_MANUAL_CUTOFF`) hodinky niekedy pri ďalšom
auto-syncu prepíšu ráno zadanú hodnotu nepresným výpočtom — preto od tohto
dátumu zapisuješ ten istý nočný priemer do poľa `hrvSDNN` namiesto rMSSD.
Funkcia `effectiveHrv()` preto berie:
- **do 8.7.2026:** pole `hrv` (rMSSD)
- **od 9.7.2026:** pole `hrvSDNN` (s fallbackom na `hrv`, ak by SDNN chýbalo)

Rolling baseline (60-dňový priemer pre farbu/odchýlku) sa na tomto dátume
tiež reštartuje, lebo SDNN a rMSSD nie sú na rovnakej číselnej škále.

(`sync.js` má pre AI súhrn tú istú hranicu duplikovanú ako
`AI_HRV_SDNN_MANUAL_CUTOFF` — ak niekedy zmeníš dátum v `app-common.js`,
zmeň ho aj tam.)

### Strain (0–21)

Počíta sa z Intervals.icu **Load** (`icu_training_load`) každej aktivity za
deň + z **krokov**. Kroky sa pripočítajú **vždy**, ale ak si mal v ten deň
pešiu aktivitu (hike/walk/beh), jej odhadnuté kroky sa z denného súčtu
najprv **odčítajú**, aby sa nezapočítali dvakrát (raz cez Load, raz cez
kroky). Keďže Intervals.icu API nevracia kroky jednotlivej aktivity, "peší"
charakter aktivity sa odhaduje takto (`isFootActivity()`):
1. typ `Walk/Hike/Run/TrailRun/VirtualRun/Elliptical/StairStepper/Snowshoe` → vždy peší
2. typ obsahuje `ride/cycl/mtb/bike/velomobile` → **nikdy** nie peší (ani pri pomalej jazde)
3. inak (napr. zle uložený typ) → peší len ak je priemerná rýchlosť pod 6,5 km/h

Kroky danej pešej aktivity sa odhadujú z jej vzdialenosti / 0,75 m (priemerná
dĺžka kroku). Súčet celého dňa sa škáluje logaritmicky (`rawToStrain`), takže
pridávanie záťaže pri už vysokom strain rastie čoraz pomalšie. Kalibrácia:
10 000 krokov samo osebe vychádza na strain cca 7–8 (WHOOP "Light" zóna).

Kontinuálne HR dáta mimo aktivít (napr. Google Heart Points štýl) sa
zámerne nepoužívajú — pozri poznámku o Huawei Health API na konci.

### Forma (TSB = CTL − ATL)

Informačná metrika (do Recovery nevstupuje priamo, len cez Fatigue Score
nižšie). Počíta sa z **dnešných** CTL/ATL — mení sa teda počas dňa, akonáhle
sa zosynchronizuje nová aktivita (vrátane okamžitého poklesu hneď po
tréningu — čerstvá záťaž = okamžitá únava).

### Tréningová únava / Fatigue Score (40 % Recovery)

`fatigueScoreForDate()`: súčet Load z posledných 14 dní (T-1 a staršie,
nikdy nie z dnešného dňa), exponenciálne menej váhový smerom do minulosti
(0,70×/deň) a nelineárne "napenalizovaný" (`Load^1,12`), aby veľké tréningy
dopadli neúmerne viac než malé. Porovná sa s "kapacitou" odvodenou z CTL
predošlého dňa (vyšší CTL = viac tolerancie), výsledný pomer sa mapuje na
skóre s pevným stredom v 1,0. Samostatný graf tejto metriky bol na tvoju
žiadosť odstránený (bol zle vyladený, väčšina dní vychádzala príliš vysoko)
— hodnota sa naďalej počíta a vstupuje do Recovery, vidno ju len ako %
v banneri "Tréningová únava".

### Grafy HRV / pokojová TF / spánková TF

Presunuté vyššie na stránku (hneď za Strain trend) a defaultne na **7 dní**
(predtým 30). Prerušovaná čiara = **rovná vodorovná čiara = priemer za práve
zvolené obdobie** (nie kĺzavý priemer bod po bode - pri 7D je to teda
7-dňový priemer, pri 30D 30-dňový atď.). Tieňované pásmo okolo čiary =
priemer ± 1 smerodajná odchýlka za rovnaké obdobie ("normálny rozsah",
v duchu grafov ako Bevel Cardio Load). Čiary sú odteraz hladké krivky
(`smoothPathD()` v `app-common.js`, Catmull-Rom → kubické Bezier segmenty)
namiesto lomenej čiary bod-po-bode.

### História dní a aktivít

Klik na riadok v histórii otvorí detail dňa (recovery, strain, HRV, RHR,
spánková TF, CTL, ATL, Forma, komentár) a zoznam aktivít toho dňa. Klik na
konkrétnu aktivitu otvorí jej detail (typ, vzdialenosť, trvanie, prevýšenie,
TF, Load, RPE, HR zóny) s možnosťou **premenovania** alebo **zmazania**
priamo na Intervals.icu (pozri nižšie).

### Zápis do Intervals.icu zo stránky

Tlačidlo **"🔑 Intervals kľúč"** uloží tvoj API kľúč len do localStorage
tohto prehliadača (nikdy do repozitára). Odtiaľ appka vie:
- zapísať nočnú TF (`avgSleepingHR`), HRV do `hrvSDNN` a komentár dňa (PUT `/api/v1/athlete/0/wellness/{date}`)
- premenovať aktivitu (PUT `/api/v1/activity/{id}`)
- zmazať aktivitu (DELETE `/api/v1/activity/{id}`)

Zápis ide priamo na Intervals.icu okamžite, ale na tejto stránke sa prejaví
až po ďalšom syncu (tlačidlo "🔄 Aktualizovať" alebo najbližší cron-job.org beh).

---

## Kontinuálne HR dáta mimo aktivít (Huawei Watch Fit 5) — otvorený problém

Cieľ: mať dennú "záťaž srdca mimo tréningu" (podobne ako Google Heart
Points), nie len steps-proxy, ktorý appka používa teraz.

**Zistené (júl 2026):** Health Sync vie reálne posielať Huawei Health
per-minútové HR dáta do **Google Fit** (funguje, overené na telefóne).
Do **Health Connect** (nástupca Google Fit) zatiaľ Health Sync HR posielať
nevie — len niektoré iné typy dát (napr. spánok) tam už majú podporu.

**Prečo to aj tak zatiaľ nepoužiť:** Google Fit REST API od 1.5.2024
nepríjma nové registrácie vývojárov (čiže by som si nevedel tie dáta
programovo stiahnuť vlastným kódom) a celé API (aj appka) končí definitívne
koncom roka 2026. Stavať teraz nový pipeline na Google Fit nemá zmysel — aj
keby sa dal jednorazovo obísť, o pár mesiacov by aj tak zanikol.

**Ďalší krok:** sledovať, kedy Health Sync pridá HR podporu pre Health
Connect ako destination (keďže smerom ta sa presúvajú všetky podobné
bridge appky) — v tom momente by šlo Health Connect čítať priamo cez
natívne Android API. Do tej doby najreálnejšie alternatívy: Gadgetbridge
(priama BLE komunikácia s hodinkami, treba overiť podporu Watch Fit 5) alebo
občasný manuálny export z Huawei Health účtu (GDPR data export) spracovaný
v Colabe.

---

## Časté otázky

**Čo ak chcem zmeniť interval syncu?**
Uprav interval v cron-job.org dashboarde (nie `schedule:` v `sync.yml` —
ten sa reálne nepoužíva, pozri vyššie).

**Čo ak Huawei hodinky sync-ujú do Intervals.icu neskoro (napr. až podvečer)?**
Sync skript sťahuje vždy posledných `SYNC_DAYS` (default 3) dní dozadu, nie
len dnešok, takže aj keď sa dáta objavia v Intervals.icu neskôr, ďalší beh
(o max. 10 min) ich doplní.

**Môžem si to spustiť aj lokálne na počítači na test?**
Áno: `ICU_API_KEY=xxx ICU_ATHLETE_ID=i347389 GEMINI_API_KEY=yyy node sync.js`
v termináli.

**Rate limit API?**
Intervals.icu povoľuje 10 volaní/sekundu na IP. Pri behu každých 10 minút
= 2 volania (wellness + activities) každých 10 minút, ďaleko pod limitom.
Gemini free tier (rádovo stovky-tisíc requestov/deň pre Flash/Flash-Lite) je
vďaka throttlingu vyššie zaťažený len 1x denne, tiež bez problému.
