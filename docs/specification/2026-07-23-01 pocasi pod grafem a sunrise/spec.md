# Počasí pod grafem a den/noc podle východu/západu slunce

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/specification/2026-07-23-01 pocasi pod grafem a sunrise` |
| **Datum** | 2026-07-23 |
| **Stav** | `implemented` |
| **Autor** | agent |
| **Související** | `weather.md` (referenční popis MET Norway / yr.no) |

## 1. Cíl

Pod grafem hlasitosti zobrazit aktuální počasí relevantní pro interpretaci měřeného hluku (ikona, vítr, srážky a další zkreslující faktory). Data počasí načítat každou celou hodinu. Stínování den/noc v grafu odvodit z východu a západu slunce (API), ne z pevných hodin nočního klidu.

## 2. Kontext a motivace

### Současný stav

- Dashboard (Chart.js) stínuje „den“ / „noc“ podle `ALERT_DAY_START_HOUR` / `ALERT_DAY_END_HOUR` (výchozí 6–22) přes `build_night_bands()` v `backend/app/main.py` a plugin `dayNightBandsPlugin` v `app.js`.
- Stejné hodiny řídí **limitní křivku** (denní/noční dBA) — to zůstává regulační logikou a **nesmí** se zaměnit za astronomický den/noc.
- Počasí v projektu **není** implementováno; `weather.md` popisuje portovatelnou integraci MET Norway (Locationforecast 2.0 compact) z projektu Hawaii.
- Souřadnice měřicího místa v `.env` chybí.

### Motivace

Venkovní mikrofon zkresluje vítr, déšť a další jevy. Operátor potřebuje u grafu hned vidět kontext počasí. Stínování grafu podle skutečného světla (sunrise/sunset) lépe odpovídá vizuální legendě „den / noc“.

## 3. Požadavky

### Funkční

- [ ] Pod grafem hlasitosti (sekce `.chart-wrap`, pod `#chart`) zobrazit panel počasí.
- [ ] Panel obsahuje minimálně: **ikonu počasí**, **rychlost větru**, **směr větru**, a další informace, které mohou zkreslit měřenou hlasitost (viz §4.3).
- [ ] Data počasí se načítají **každou celou hodinu** (např. 10:00, 11:00, …), ne v intervalu 15 s jako historie měření.
- [ ] Stínování světlé/tmavé části grafu vychází z **východu a západu slunce** získaných z API pro zadané souřadnice.
- [ ] Limitní křivka a vyhodnocení alertů zůstávají na `ALERT_DAY_*` hodinách (beze změny významu).
- [ ] Do `.env` / `.env.example` / `docker-compose.yml` přidat `LATITUDE` a `LONGITUDE`.

### Nefunkční

- [ ] Respektovat podmínky MET Norway (povinný identifikující `User-Agent`, cache dle `Expires`, souřadnice na 4 desetinná místa).
- [ ] Při výpadku API zobrazit srozumitelný fallback v UI (poslední známá data nebo „nedostupné“), graf hlasitosti zůstane funkční.
- [ ] Bez API klíče (MET Norway klíč nevyžaduje).
- [ ] Zachovat stávající vizuální jazyk dashboardu (žádný nový framework; vanilla JS + CSS).

## 4. Návrh řešení

### 4.1 Providery (MET Norway)

| Účel | Endpoint |
|------|----------|
| Aktuální počasí / vítr / srážky / symbol | `GET https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={lat}&lon={lon}` |
| Východ / západ slunce | `GET https://api.met.no/weatherapi/sunrise/3.0/sun?lat={lat}&lon={lon}&date={YYYY-MM-DD}&offset={±HH:MM}` |

Referenční mapování `symbol_code` → ikona / CZ popis: `weather.md` §4 (MDI nebo oficiální weathericons). Doporučení pro hlukoměr: **oficiální SVG z [metno/weathericons](https://github.com/metno/weathericons)** 1:1 podle `symbol_code` (přesnější než MDI substring mapování), případně MDI jako rychlejší první iterace — rozhodnutí v implementaci, výchozí preference **weathericons**.

**User-Agent:** env `YR_USER_AGENT` (doporučeno). Fallback např. `hlukomer/1.0 (local; contact via admin)`.

### 4.2 Konfigurace

| Proměnná | Povinné? | Popis |
|----------|----------|--------|
| `LATITUDE` | Ano (pro počasí + sunrise) | Zeměpisná šířka; zaokrouhlit na 4 des. místa před voláním API |
| `LONGITUDE` | Ano | Zeměpisná délka; stejně |
| `YR_USER_AGENT` | Doporučeno | Identifikace klienta pro met.no |
| `TZ` | Již existuje | Pro offset u sunrise API a lokální „celou hodinu“ |

Pokud `LATITUDE` / `LONGITUDE` chybí nebo jsou neplatné: endpoint počasí vrátí 503/configured=false; stínování grafu **fallback** na stávající `ALERT_DAY_*` pásma (aby graf nezůstal bez den/noc).

### 4.3 Model „aktuálního počasí“ (pro UI pod grafem)

Ze slotu Locationforecast (nejbližší aktuální/budoucí v `timeseries`):

| Pole | Zdroj v API | UI |
|------|-------------|-----|
| `symbol_code` | `next_1_hours.summary` → fallback `next_6_hours` | Ikona + krátký CZ popis |
| `air_temperature` | `instant.details` | Teplota (°C) — kontext |
| `wind_speed` | `instant.details` | Rychlost (m/s), volitelně i km/h v tooltipu |
| `wind_from_direction` | `instant.details` | Stupně + kardinalita (S, SV, V, …) + šipka |
| `precipitation_amount` | `next_1_hours.details` | Srážky za 1 h (mm) |
| `relative_humidity` | `instant.details` | Volitelně |
| `air_pressure_at_sea_level` | `instant.details` | Volitelně |

**Faktory zkreslující hlasitost** (zvýraznit v UI, pokud překročí práh nebo jsou přítomny):

| Faktor | Podmínka (návrh prahů) | Proč |
|--------|------------------------|------|
| Silný vítr | `wind_speed` ≥ 5 m/s (výrazně ≥ 8 m/s) | Vítr na pouzdře / listí |
| Srážky | `precipitation_amount` > 0 | Déšť na površích a mikrofonu |
| Bouřka | `symbol_code` obsahuje `thunder` | Impulzy / déšť |
| Sníh / námraza | `snow` / `sleet` v symbolu | Mechanický šum |

Prahy lze v implementaci držet jako konstanty v backendu (ne nutně env). UI: vedle hodnot krátké varovné štítky (např. „vítr může zkreslit měření“), ne přeplněný dashboard.

### 4.4 Obnovování každou celou hodinu

**Backend**

- Modul `weatherService` (nový soubor vedle `main.py` nebo `backend/app/weather.py`):
  - in-memory (nebo SQLite) cache forecast + sunrise,
  - respektovat HTTP `Expires` z met.no; při chybě TTL ≈ 1 h,
  - prediktivní refresh: background task / lazy refresh při requestu, pokud cache expirovala.
- Align na celou hodinu: po startu aplikace spočítat `next_hour = ceil(now → :00)` a periodicky volat refresh; případně refresh při prvním requestu po `:00`, pokud background scheduler není žádoucí (preferovat **jednoduchý asyncio task** v lifespan FastAPI).

**Frontend**

- Oddělený poll od historie měření: `refreshWeather()` volaný ihned po loadu a poté `setTimeout` do příští celé hodiny (+ malý jitter 1–5 s), pak `setInterval(3600_000)`.
- Nevolat `/api/v1/weather` každých 15 s.

### 4.5 Den/noc pásma podle sunrise/sunset

**Změna významu `night_bands` v odpovědi historie** (nebo nový klíč `sun_night_bands` — preferovat **přejmenování významu `night_bands`** na astronomickou noc, protože legenda už říká „den / noc“; limit zůstane v `threshold_points`):

1. Pro každý kalendářní den v intervalu `[t0, t1]` (v `TZ`) načíst sunrise/sunset z cache (dávkově dopředu pro rozsah historie, max. např. 31 dní + 1).
2. Noc = interval od `sunset(d)` do `sunrise(d+1)` (oříznout na `[t0, t1]`).
3. Polární den / noc (`sunrise`/`sunset` null): celý den světlý, resp. tmavý podle `solarnoon.visible` / dokumentace Sunrise 3.0.
4. Pokud souřadnice/API nedostupné → fallback na současnou logiku `ALERT_DAY_END` → `ALERT_DAY_START`.

**Neměnit:** `is_daytime()`, `threshold_for_ts()`, `build_threshold_line()` — ty zůstávají na regulačních hodinách.

Spektrogram: svislé čáry na hranicích `night_bands` dnes značí změnu limitu. Po přechodu na sunrise/sunset **přestanou** odpovídat změnám limitu. Úprava:

- Spektrogram kreslí značky změn limitu z `threshold_points` (nebo oddělené `limit_change_bands` odvozené z `ALERT_*`), **ne** z astronomických `night_bands`.
- Chart plugin `dayNightBandsPlugin` používá astronomické `night_bands`.

### 4.6 Dotčené části systému

| Oblast | Soubory / moduly | Poznámka |
|--------|------------------|----------|
| Backend | `backend/app/weather.py` (nový), `main.py` | Služba + endpoint + úprava `build_night_bands` |
| Frontend | `static/index.html`, `app.js`, `style.css` | Panel pod grafem, poll, ikony |
| Ikony | `static/weather-icons/` nebo CDN/static copy | Dle zvoleného mapování |
| Konfigurace | `.env`, `.env.example`, `docker-compose.yml` | `LATITUDE`, `LONGITUDE`, volitelně `YR_USER_AGENT` |
| Dokumentace | `weather.md`, případně `README.md` | Odkaz na env a chování |

### 4.7 API a data

#### `GET /api/v1/weather`

Odpověď (návrh):

```json
{
  "configured": true,
  "updated_at": "2026-07-23T21:00:00+02:00",
  "expires_at": "2026-07-23T22:00:00+02:00",
  "coords": { "lat": 50.0755, "lon": 14.4378 },
  "current": {
    "time": "2026-07-23T21:00:00Z",
    "symbol_code": "partlycloudy_night",
    "temperature_c": 18.2,
    "wind_speed_ms": 3.1,
    "wind_from_direction_deg": 240,
    "wind_from_direction_cardinal": "JZ",
    "precipitation_1h_mm": 0.0,
    "relative_humidity_pct": 72.0,
    "pressure_hpa": 1013.2
  },
  "skew_factors": [
    { "id": "wind", "level": "none|warn|high", "label": "…" }
  ],
  "sun": {
    "date": "2026-07-23",
    "sunrise": "2026-07-23T05:12:00+02:00",
    "sunset": "2026-07-23T21:05:00+02:00"
  }
}
```

Při chybějící konfiguraci: `{ "configured": false, "error": "LATITUDE/LONGITUDE not set" }`.

#### Úprava `GET /api/v1/history` (a případně spectrum history)

- `night_bands`: astronomická noc (sunrise/sunset), se stejným tvarem `[{ "t0", "t1" }, …]`.
- Volitelně doplnit `sun: { source: "met.no"|"fallback-alert-hours" }` pro ladění.
- Spektrogram: značky limitu oddělit od `night_bands` (viz §4.5).

Žádná nová DB tabulka není nutná v první iteraci (in-memory cache); SQLite cache je volitelná pro přetrvání přes restart — **v1: in-memory**.

### 4.8 UI / UX

Umístění: nový blok `#weatherPanel` uvnitř / hned pod `.chart-wrap`, **nad** sekcí `#stats`.

Obsah (jedna řádka na desktopu, stack na mobilu):

1. Ikona + popis počasí  
2. Teplota  
3. Vítr: `X.X m/s` + kardinalita / šipka rotovaná o `wind_from_direction`  
4. Srážky 1 h (pokud > 0 nebo vždy s „0 mm“)  
5. Skupina `skew_factors` jako textové upozornění (jen pokud `warn`/`high`)

Stavy: loading → data → error/unconfigured (např. „Počasí: nastavte LATITUDE a LONGITUDE“).

Legenda grafu „den / noc“ beze změny textu; význam se stane astronomickým.

## 5. Alternativy

| Alternativa | Proč nezvoleno (pro v1) |
|-------------|-------------------------|
| Open-Meteo / OpenWeather | `weather.md` a ToS už cílí na met.no; bez API key |
| Lokální astronomický výpočet (astral/skyfield) | Extra závislost; met.no Sunrise je konzistentní se forecast |
| Ponechat stínování na ALERT hodinách | Odporuje zadání; limity zůstanou oddělené |
| Frontend volá met.no přímo | User-Agent, CORS, cache — lepší přes backend |
| Obnova počasí každých 15 s | Zbytečná zátěž a proti ToS cache; zadání = celá hodina |

## 6. Rizika a omezení

- MET Norway může rate-limitovat při špatném User-Agentu nebo ignorování `Expires`.
- Dlouhé historie (30 dní) = až ~31 volání Sunrise; nutná agresivní cache po dnech.
- Spektrogram dnes váže vizuální „změny“ na `night_bands` — nutná úprava, jinak matoucí UI.
- Kardinalita větru a prahy „zkreslení“ jsou heuristiky, ne metrologie.
- Ikony: licence weathericons / MDI — ověřit při vložení do `static/`.

## 7. Testovací plán

- [ ] S platnými `LATITUDE`/`LONGITUDE` vrací `/api/v1/weather` aktuální slot včetně větru a symbolu.
- [ ] Po startu a na celé hodině se data obnoví (ověřit log / `updated_at`).
- [ ] Graf: tmavé pásmo začíná kolem sunset a končí kolem sunrise (porovnat s yr.no / met.no pro stejné souřadnice).
- [ ] Limitní křivka stále skáče v `ALERT_DAY_START/END`, ne při sunset.
- [ ] Bez souřadnic: počasí unconfigured; graf fallback stínování; měření funguje.
- [ ] Simulace výpadku met.no: UI error/fallback, historie OK.
- [ ] Mobilní layout panelu pod grafem.
- [ ] Regrese: ingest, latest, history stats, admin.

## 8. Implementační kroky

Po schválení specifikace:

1. [ ] Přidat `LATITUDE`, `LONGITUDE` (+ volitelně `YR_USER_AGENT`) do `.env.example`, `docker-compose.yml`; doplnit hodnoty do lokálního `.env` jen pokud uživatel dodá souřadnice.
2. [ ] Implementovat `weather.py`: fetch compact + sunrise, cache, parse current + skew_factors.
3. [ ] Endpoint `GET /api/v1/weather` + lifespan hourly refresh.
4. [ ] Upravit `build_night_bands` na sunrise/sunset s fallbackem; oddělit spektrogramové značky limitu.
5. [ ] UI panel pod grafem + styly + mapování ikon.
6. [ ] Frontend hourly refresh timer.
7. [ ] Manuální ověření dle §7; stav specifikace → `implemented`.

**Git:** commit provádí výhradně uživatel.

## 9. Otevřené otázky

1. **Přesné souřadnice** měřicího místa pro výchozí `.env` — dodá uživatel při implementaci?
2. **Ikony:** oficiální MET weathericons vs. MDI z `weather.md`?
3. **Prah větru** 5 / 8 m/s — vyhovuje, nebo upravit podle zkušenosti z provozu?
4. Má panel ukazovat i vlhkost/tlak vždy, nebo jen při relevantním skew faktoru?

## 10. Historie

| Datum | Autor | Změna |
|-------|-------|-------|
| 2026-07-23 | agent | Vytvoření specifikace (`draft`) |
| 2026-07-23 | agent | Implementace — stav `implemented` |
