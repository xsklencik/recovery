# Recovery Score — návod na nasadenie (GitHub Pages + automatický sync)

Táto stránka beží úplne bez tvojho počítača — GitHub raz denne sám stiahne
dáta z Intervals.icu a stránka na `https://xsklencik.github.io/recovery/`
sa zobrazí vždy s aktuálnymi dátami.

## Ako to funguje (v skratke)

```
Každý deň o 5:00 UTC:
  GitHub Actions sa spustí
    → zavolá Intervals.icu API (s tvojím kľúčom, uloženým ako "Secret")
    → uloží dáta do data/wellness_daily.json a data/activities_daily.json
    → commitne zmenu do repozitára

Keď otvoríš stránku:
  index.html načíta data/wellness_history.json (tvoja stará história)
  + data/wellness_daily.json (nové dáta od 5.7.2026)
  → spočíta recovery a zobrazí grafy
```

Tvoj API kľúč **nikdy nie je vo verejnom kóde** — je uložený ako GitHub
Secret, čo je šifrované úložisko prístupné len samotnému workflow behu.

---

## Čo appka reálne počíta (algoritmus)

Toto je popis logiky v `app-common.js` — čo sa deje s dátami od chvíle, čo
prídu z Intervals.icu, po to, čo vidíš na obrazovke.

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
nie na 50 %.

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

Prerušovaná čiara = **7-dňový trailing priemer** (`rollingStats(...,7)`),
aby si na prvý pohľad videl, či si nad alebo pod svojím nedávnym priemerom.

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
až po ďalšom syncu (tlačidlo "🔄 Aktualizovať" alebo denný cron).

---

## Krok 1 — Založ repozitár

1. Choď na github.com, prihlás sa ako `xsklencik`
2. Vytvor nový repozitár s presným názvom **`recovery`** (musí sedieť s URL, ktorú chceš: `xsklencik.github.io/recovery/`)
3. Nastav ho ako **Public** (GitHub Pages zadarmo funguje len na public repách, pokiaľ nemáš platený plán)

## Krok 2 — Nahraj súbory

Nahraj do repozitára presne túto štruktúru (zachovaj priečinky):

```
recovery/
├── index.html
├── sync.js
├── .gitignore
├── data/
│   ├── wellness_history.json     ← tvoja pôvodná história z Excelu (wellness)
│   ├── activities_history.json   ← tvoja pôvodná história z Excelu (aktivity, HR zóny)
│   ├── wellness_daily.json       ← začni s obsahom: []
│   ├── activities_daily.json     ← začni s obsahom: []
│   └── last_sync.json            ← začni s obsahom: {}
└── .github/
    └── workflows/
        └── sync.yml
```

Najjednoduchšie: cez GitHub web rozhranie "Add file → Upload files" a
pretiahni všetky súbory naraz (GitHub sám vytvorí priečinky podľa ciest).

**Dôležité:** Súbory `data/wellness_daily.json`, `data/activities_daily.json`
musia na začiatku obsahovať `[]` (prázdne pole) a `data/last_sync.json` obsah `{}`,
inak prvý beh sync skriptu zlyhá pri čítaní.

## Krok 3 — Nastav API kľúč ako Secret

1. V repozitári choď na **Settings → Secrets and variables → Actions**
2. Klikni **New repository secret**
3. Vytvor dva secrets:
   - Name: `ICU_API_KEY` → Value: tvoj API kľúč z intervals.icu/settings (Developer Settings)
   - Name: `ICU_ATHLETE_ID` → Value: `i347389`

## Krok 4 — Zapni GitHub Pages

1. **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, priečinok `/ (root)`
4. Save

Po pár minútach bude stránka dostupná priamo na `https://xsklencik.github.io/recovery/`
(súbor sa volá `index.html`, takže GitHub Pages ho zobrazí automaticky na koreňovej URL).

## Krok 5 — Over si automatický sync

1. Choď na záložku **Actions** v repozitári
2. Klikni na workflow "Sync Intervals.icu data"
3. Klikni **Run workflow** (ručné spustenie, netreba čakať na cron)
4. Po ~30 sekundách skontroluj, či sa v `data/wellness_daily.json` objavili nové záznamy

Od tohto momentu beží automaticky každý deň o 5:00 UTC bez toho, aby si čokoľvek robil.

## Krok 6 — Nastav tlačidlo "🔄 Aktualizovať" (voliteľné, ale odporúčané)

Toto tlačidlo na stránke ti umožní po skončení jazdy okamžite spustiť sync
namiesto čakania na denný cron o 5:00 UTC.

1. Choď na github.com → klikni na svoj profil vpravo hore → **Settings**
2. **Developer settings** (úplne dole vľavo) → **Personal access tokens** → **Fine-grained tokens**
3. **Generate new token**
4. Nastav:
   - Token name: napr. `recovery-refresh-button`
   - Expiration: podľa chuti (napr. 1 rok)
   - Repository access: **Only select repositories** → vyber `recovery`
   - Repository permissions → **Contents** → **Read and write**
5. Generate token, skopíruj hodnotu (začína `github_pat_...`) — **uvidíš ju len raz**
6. Na stránke klikni **⚙️ Token**, vlož token, ulož

Token sa uloží len v prehliadači tvojho zariadenia (localStorage), nikdy sa
neposiela nikam okrem `api.github.com`. Ak používaš viac zariadení (telefón
aj počítač), token treba vložiť na každom zvlášť.

**Bezpečnostná poznámka:** aj keď je token obmedzený len na tento jeden
repozitár, ktokoľvek s fyzickým prístupom k tvojmu odomknutému prehliadaču by
ho teoreticky mohol nájsť cez Developer Tools. Pre osobné použitie na
vlastnom zariadení je to bežne akceptovateľné riziko.

---

## Časté otázky

**Čo ak zmením čas, kedy chcem sync?**
Uprav riadok `- cron: '0 5 * * *'` v `.github/workflows/sync.yml`. Formát je
`minúta hodina deň mesiac deň-v-týždni`, čas je vždy v UTC.

**Čo ak Huawei hodinky sync-ujú do Intervals.icu neskoro (napr. až podvečer)?**
Sync skript sťahuje vždy posledných 3 dní dozadu (nie len dnešok), takže aj
keď sa dáta objavia v Intervals.icu neskôr, ďalší denný beh ich doplní.

**Môžem si to spustiť aj lokálne na počítači na test?**
Áno: `ICU_API_KEY=xxx ICU_ATHLETE_ID=i347389 node sync.js` v termináli.

**Rate limit API?**
Intervals.icu povoľuje 10 volaní/sekundu na IP a plánuje pridať denné limity
na úrovni kľúča. Sync beží raz denne = 2 volania (wellness + activities).
Nie je sa čoho obávať ani zďaleka.
