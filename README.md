# Recovery / Strain

Osobná appka na sledovanie zotavenia a tréningovej záťaže. Beží na GitHub Pages
(`https://xsklencik.github.io/recovery/`), žiadny vlastný server — GitHub Actions
je jediný "backend" a spúšťa sa len na požiadanie (cez cron-job.org).

## Dátový tok / automatizácia

```
cron-job.org (~15 min) ──POST──▶ GitHub Actions workflow_dispatch (sync.yml)
                                    └─▶ sync.js
                                          ├─ stiahne wellness + activities z Intervals.icu
                                          ├─ spracuje data/heart_rate_raw/*.csv → Strain
                                          ├─ (1×/deň) AI súhrn cez Gemini
                                          └─ commit + push

Google Apps Script (1×/hod) ──▶ nájde nový export z Health Sync (telefón → Google
                                 Drive, Huawei Health per-minútový tep) a pushne CSV
                                 do data/heart_rate_raw/ v repe cez GitHub API

Prehliadač (pri otvorení stránky) ──▶ stiahne *_history.json + *_daily.json
                                    └─▶ computeResults() v app-common.js spočíta
                                        Recovery/Strain naživo v JS a vykreslí
```

Tlačidlo "🔄 Aktualizovať" na stránke volá presne ten istý endpoint ako cron-job.org.

**Secrets:** `ICU_API_KEY`, `ICU_ATHLETE_ID` (povinné), `GEMINI_API_KEY` (voliteľný —
bez neho sa AI súhrn ticho preskočí).

## Recovery % (0–100)

Vážený súčet z-skóre (voči 60-dňovému kĺzavému priemeru/odchýlke):

| zložka | váha |
|---|---|
| HRV | 30 % |
| nočná TF (avgSleepingHR) | 15 % |
| pokojová TF (restingHR) | 10 % |
| sleep score | 5 % |
| Tréningová únava (Fatigue Score) | 40 % |

**Fatigue Score:** Load z posledných 14 dní (T-1 a staršie), exponenciálne
menej váhovaný do minulosti (0.70×/deň), nelineárne penalizovaný (`Load^1.12`),
porovnaný s kapacitou odvodenou z včerajšieho CTL.

**HRV:** do 8.7.2026 pole `hrv` (rMSSD), od 9.7.2026 pole `hrvSDNN` (hodinky
inak občas prepíšu ručne zadanú hodnotu) — baseline sa na tomto dátume reštartuje.

## Strain (0–21)

Hybridný model, `sync.js` → `data/hr_strain_daily.json`:

- **Aktivita, ≥143 bpm (Z2–Z5):** presne z Intervals.icu zónových **sekúnd**
  (`hr_zX_secs`) — TRIMP exponenciála (Banister, b=1.92) na strede zóny.
- **Aktivita, <143 bpm (Z1):** Intervals.icu vie len "koľko sekúnd pod 143",
  nie akú konkrétnu hodnotu — preto sa použije skutočný **minútový tep z CSV**
  (Huawei Health export) so stupňovanou rampou 0.045 → plná váha pri 143 bpm.
- **Mimo aktivity (celý zvyšok dňa):** len minútový CSV, rovnaká rampa.
- Súčet (`raw`) sa preženie cez saturujúcu funkciu `21×(1-e^(-raw/140))`
  (Whoop-štýl škála 0–21).
- **Oprava 3.8.2026:** `data/heart_rate_raw/` obsahuje popri denných CSV aj
  prekrývajúce sa týždenné/mesačné bulk exporty → riadky sa dedupujú podľa
  `(dátum, čas)`, inak sa rovnaká minúta počítala 2–3×.

Konštanty (HR_REST=60, HR_MAX=200, hranica Z1/Z2=143) sú odhadnuté z Karvonen
zón nastavených v Intervals.icu — ak sa zmenia zóny, treba prepočítať aj tu.

## Forma (TSB = CTL − ATL)

Priamo z **dnešných** CTL/ATL z Intervals.icu → mení sa počas dňa (klesne
hneď po tréningu, nie až zajtra).

## AI súhrn dňa (Gemini)

`sync.js` volá Gemini **max 1×/deň** (throttling cez `data/ai_summary_daily.json`,
obchádza sa tlačidlom "🧠 AI súhrn"). Do promptu ide surové HRV/TF/spánok +
odchýlky + posledných ~10 dní histórie + komentáre dní (aj dopredu napísané) —
**nikdy** hotové Recovery/Strain číslo appky, aby sa text nikdy nerozchádzal
s tým, čo appka reálne zobrazuje. Model: `gemini-3.5-flash-lite` (ak vráti 404,
pozri Actions → "Test Gemini API").

## Weather plan (`weather-plan.js`)

Hľadá súvislé okno (dĺžka `TRAINING_WINDOW_HOURS`) s najnižšou šancou dažďa,
primárne v poobedňajšom/večernom rozsahu; mimo neho len ak je v preferovanom
okne >50 % šanca dažďa a inde preukázateľne lepšie.

## Ostatné stránky

- **power.html** — výkon/VO2max/FTP zo stúpaní na segmentoch, fyzika (hmotnosť
  bicykla, Crr pneumatík).
- **calendar.html** — poznámky k dňom (`data/day_notes.json`), 3 dni dozadu až
  10 dní dopredu ide do AI kontextu.
- **history.html / history-weekly.html** — história dní a týždenné súhrny.

## Časté otázky

**Zmena intervalu syncu?** Nastav v cron-job.org dashboarde, nie `schedule:`
v `sync.yml` (natívny GitHub scheduler je nespoľahlivý, reálne sa nepoužíva).

**Lokálny test?**
`ICU_API_KEY=xxx ICU_ATHLETE_ID=i347389 GEMINI_API_KEY=yyy node sync.js`

**Rate limity?** Intervals.icu 10 req/s (sync robí 2-3 volania/beh) — pri
behu každých 15 min ďaleko pod limitom. Gemini free tier zvládne aj desiatky
volaní denne, reálne sa volá ~1×/deň vďaka throttlingu.
