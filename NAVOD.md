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
