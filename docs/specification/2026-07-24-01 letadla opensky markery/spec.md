# Letadla z OpenSky — markery přeletů v grafu

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/specification/2026-07-24-01 letadla opensky markery` |
| **Datum** | 2026-07-24 |
| **Stav** | `implemented` |
| **Autor** | agent |
| **Související** | `2026-07-23-01 pocasi pod grafem a sunrise` (souřadnice, Chart.js overlay vzory) |

## 1. Cíl

Podle `LATITUDE` / `LONGITUDE` periodicky načítat polohy letadel z **OpenSky Network**, ukládat přelety, které by u měřicího místa **měly jít slyšet** (nízká výška + přiměřená vzdálenost), a v grafu hlasitosti zobrazit **marker s ikonou letadla** v momentě přeletu. Po kliknutí myší popup s detaily.

Řešení je **obecné** (jakékoli místo se souřadnicemi), ne vázané na konkrétní letiště.

## 2. Kontext a motivace

### Současný stav

- Dashboard (Chart.js) zobrazuje historii hluku (`GET /api/v1/history`), stínování den/noc, limitní křivku, timeline počasí pod grafem.
- Souřadnice měření už existují (`LATITUDE`, `LONGITUDE`) pro počasí / sunrise.
- DB: SQLite (`ensure_db()`), bez ORM; background job vzor: daemon thread jako u počasí (`weather.start_hourly_refresh`).
- Overlay grafu: vlastní Chart.js pluginy (`dayNightBandsPlugin`, `offlineBandsPlugin`) + DOM timeline počasí — **bez** chartjs-plugin-annotation.

### Motivace

Venkovní mikrofon zachytí i přelety. Operátor potřebuje u peaků v grafu hned vidět, zda v daném čase prolétlo nízko letadlo, a kliknutím zjistit callsign / výšku / vzdálenost.

## 3. Požadavky

### Funkční

- [ ] Periodicky pollovat OpenSky `/states/all` s bounding boxem odvozeným od `LATITUDE`/`LONGITUDE`.
- [ ] Ukládat do SQLite jen letadla splňující filtry „slyšitelnosti“ (výška + vodorovná vzdálenost); prahy konfigurovatelné přes env.
- [ ] Deduplikovat průběžné sightingy stejného letadla do jedné **přeletové události**; marker umístit na čas **nejbližšího přiblížení**.
- [ ] `GET /api/v1/history` vrací seznam přeletů v rozsahu grafu.
- [ ] V grafu malé markery (ikona letadla) na časové ose přeletu.
- [ ] Klik na marker → popup s detaily (callsign, ICAO24, výška, vzdálenost, rychlost, směr, časy).
- [ ] Bez souřadnic nebo při vypnutém feature: žádný poll, žádné markery; graf hluku beze změny.

### Nefunkční

- [ ] Respektovat OpenSky ToS / kreditový systém (malý bbox, rozumný interval, volitelná OAuth2 autentizace).
- [ ] Výpadek OpenSky nesmí shodit ingest ani graf; jen chybějící/nové markery.
- [ ] Zachovat vizuální jazyk dashboardu (vanilla JS + CSS, žádný nový UI framework).
- [ ] Retence přeletů stejně jako ostatní historická data (`RETENTION_DAYS`), případně samostatný env.

## 4. Návrh řešení

### 4.1 Provider (OpenSky Network)

| Účel | Endpoint |
|------|----------|
| Aktuální stav letadel v oblasti | `GET https://opensky-network.org/api/states/all?lamin=&lomin=&lamax=&lomax=` |
| OAuth2 token (volitelně) | `POST https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token` |

**State vector** (relevantní indexy pole `states[]`):

| Index | Pole | Použití |
|-------|------|---------|
| 0 | `icao24` | Identita letadla |
| 1 | `callsign` | UI (trim) |
| 2 | `origin_country` | UI |
| 3 / 4 | `time_position` / `last_contact` | Čas sightingu |
| 5 / 6 | `longitude` / `latitude` | Vzdálenost od měření |
| 7 | `baro_altitude` | Výška [m], fallback |
| 8 | `on_ground` | Vyřadit `true` |
| 9 | `velocity` | Rychlost [m/s] |
| 10 | `true_track` | Směr [°] |
| 11 | `vertical_rate` | Stoupání/klesání [m/s] |
| 13 | `geo_altitude` | Preferovaná výška [m] |

Výška pro filtr: `geo_altitude` pokud není `null`, jinak `baro_altitude`. Pokud obě `null` → **neukládat** (nelze rozhodnout o slyšitelnosti).

**Autentizace (2026):** OpenSky vyžaduje OAuth2 client credentials (basic auth zrušeno). Anonymní přístup stále možný s nízkým limitem kreditů.

| Tier | Credits `/states/*` | Poznámka |
|------|---------------------|----------|
| Anonymous | ~400 / den | Vhodné jen pro dlouhý poll (≥ ~5–10 min) |
| Standard (účet + API client) | ~4 000 / den | Doporučeno pro poll 30–60 s |
| Active feeder | ~8 000 / den | Volitelně |

Malý bbox (≤ 25 sq°) stojí **1 kredit** / request. Při pollu každých **60 s** ≈ 1 440 kreditů/den → stačí standardní účet.

Implementace: vlastní HTTP klient ve `aircraft.py` (jako `weather.py`), **bez** povinné závislosti na oficiálním `opensky-api` balíčku (stačí `urllib`/`httpx` pokud už bude v projektu; v1 preferovat stdlib + stejný styl jako weather).

### 4.2 Konfigurace

| Proměnná | Default | Popis |
|----------|---------|--------|
| `LATITUDE` / `LONGITUDE` | (již existují) | Střed oblasti; bez nich feature vypnuta |
| `AIRCRAFT_ENABLED` | `1` pokud jsou souřadnice, jinak efektivně off | Explicitní vypínač (`0`/`1`) |
| `AIRCRAFT_MAX_ALTITUDE_M` | **1500** | Max. výška AGL/MSL z ADS-B [m] pro uložení (viz §4.3) |
| `AIRCRAFT_MAX_DISTANCE_KM` | **8** | Max. vodorovná vzdálenost od měření [km] |
| `AIRCRAFT_POLL_INTERVAL_S` | **60** | Interval pollu [s]; min. 15 (ochrana kreditů) |
| `AIRCRAFT_BBOX_PADDING_KM` | `= AIRCRAFT_MAX_DISTANCE_KM` | Poloměr → bbox (mírně větší než filtr, default stejný) |
| `AIRCRAFT_GAP_S` | **180** | Max. mezera mezi sightingy stejného `icao24` v jedné události |
| `AIRCRAFT_RETENTION_DAYS` | `= RETENTION_DAYS` | Retence tabulky přeletů |
| `OPENSKY_CLIENT_ID` | prázdné | OAuth2 client id (doporučeno) |
| `OPENSKY_CLIENT_SECRET` | prázdné | OAuth2 client secret |

Doplnit do `.env.example` a `docker-compose.yml` `environment:`.

### 4.3 Filtr „slyšitelné letadlo“

Uložit sighting / zahrnout do přeletu, pokud **vše** platí:

1. `on_ground` je `false`
2. výška ≤ `AIRCRAFT_MAX_ALTITUDE_M`
3. haversine(měření, letadlo) ≤ `AIRCRAFT_MAX_DISTANCE_KM`
4. platná lat/lon

**Proč default 1500 m (ne 1000):**  
U letištních přístupů/odletů jsou proudová letadla často slyšitelná i kolem 1000–2000 m; 1000 m by při vzdálenosti několika km od dráhy vynechalo část reálných přeletů. 1500 m je kompromis „nízko dost na hluk“ vs. „neclutterovat graf cestujícími ve FL300“. Operátor může v `.env` stáhnout na `1000` nebo zvednout na `2000`.

**Proč 8 km:** typický dosah slyšitelnosti nízkého přeletu / boční odstup od osy přiblížení u regionálního letiště. Menší hodnota = méně markerů, přísnější korelace.

Bbox pro API: čtverec kolem měření s poloměrem `AIRCRAFT_BBOX_PADDING_KM` (převod km → ° lat/lon). Finální filtr vzdálenosti je haversine (bbox je jen hrubý výřez pro API).

### 4.4 Model přeletové události

OpenSky vrací **snapshoty**. Jedno letadlo v oblasti po dobu minut = řada řádků. V DB a v grafu chceme **jednu událost** a marker v čase **nejbližšího přiblížení**.

**Algoritmus (poll):**

1. Načíst states v bbox.
2. Pro každé letadlo splňující filtr:
   - Najít otevřenou událost se stejným `icao24` kde `now - last_seen_ts ≤ AIRCRAFT_GAP_S`.
   - Pokud existuje: aktualizovat `last_seen_ts`; pokud je aktuální vzdálenost menší než `closest_distance_m`, přepsat closest-* pole (čas, lat, lon, alt, speed, track, vrate).
   - Jinak: `INSERT` nové události (`first_seen` = `last_seen` = `closest_*` = teď).
3. (Volitelně v1) Události nechat „otevřené“; uzavření implicitně mezerou `GAP_S` — pro UI stačí `closest_ts`.

### 4.5 Databáze

Nová tabulka v `ensure_db()`:

```sql
CREATE TABLE IF NOT EXISTS aircraft_overflights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  icao24 TEXT NOT NULL,
  callsign TEXT,
  origin_country TEXT,
  first_seen_ts REAL NOT NULL,
  last_seen_ts REAL NOT NULL,
  closest_ts REAL NOT NULL,
  closest_lat REAL,
  closest_lon REAL,
  closest_distance_m REAL NOT NULL,
  closest_altitude_m REAL NOT NULL,
  closest_velocity_ms REAL,
  closest_track_deg REAL,
  closest_vertical_rate_ms REAL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aircraft_closest_ts ON aircraft_overflights(closest_ts);
CREATE INDEX IF NOT EXISTS idx_aircraft_icao_last ON aircraft_overflights(icao24, last_seen_ts);
```

**Retence:** v `prune_old()` (nebo rozšířeném prune) mazat řádky s `closest_ts` / `last_seen_ts` starší než `AIRCRAFT_RETENTION_DAYS`.

Žádné raw „každý poll“ tabulky v v1 — jen agregované události (jednodušší UI a méně místa).

### 4.6 Backend služby

Nový modul `backend/app/aircraft.py` (vzor `weather.py`):

- `get_aircraft_config()` — souřadnice + prahy + enabled
- `fetch_states()` — OAuth token cache + GET states
- `haversine_m(lat1, lon1, lat2, lon2)`
- `process_poll()` — filtr + upsert událostí (callback / přímý zápis přes `db()` z main, nebo injekce `persist_fn` jako u weather)
- `start_aircraft_poll()` / `stop_…` — daemon thread: sleep `POLL_INTERVAL_S`, při chybě log + pokračovat; při `429` respektovat `X-Rate-Limit-Retry-After-Seconds` pokud je
- Start z `on_startup()` jen pokud `enabled` a platné souřadnice

Token: in-memory cache `access_token` + `expires_at` (obnova ~ před expirací 30 min).

### 4.7 API

#### Úprava `GET /api/v1/history`

Přidat pole (stejný časový rozsah jako `points`):

```json
{
  "aircraft_overflights": [
    {
      "id": 12,
      "t": 1721805123.0,
      "icao24": "4ca1a9",
      "callsign": "RYR3PX",
      "origin_country": "Ireland",
      "distance_m": 2140.5,
      "altitude_m": 820.0,
      "velocity_ms": 85.2,
      "track_deg": 268.0,
      "vertical_rate_ms": -5.2,
      "first_seen_ts": 1721805000.0,
      "last_seen_ts": 1721805200.0
    }
  ],
  "aircraft": {
    "enabled": true,
    "source": "opensky",
    "max_altitude_m": 1500,
    "max_distance_km": 8
  }
}
```

- `t` = `closest_ts` (pozice markeru).
- Subsampling **není** nutný jako u počasí: počet slyšitelných přeletů za 24–90 dní je řádově desítky–stovky. Horní soft-cap např. **500** nejbližších k měření / nejnovějších v rozsahu (dokumentovat v implementaci), ať dlouhý rozsah nezahltí JSON.

#### Volitelně `GET /api/v1/aircraft` (debug / status)

```json
{
  "enabled": true,
  "configured": true,
  "last_poll_at": "…",
  "last_poll_ok": true,
  "last_error": null,
  "credits_hint": null,
  "config": { "max_altitude_m": 1500, "max_distance_km": 8, "poll_interval_s": 60 }
}
```

V1 stačí metadata v history; samostatný endpoint je nice-to-have.

### 4.8 UI / UX

**Markery v grafu**

- Nový Chart.js plugin `aircraftMarkersPlugin` (vzor day/night): v `afterDatasetsDraw` (nebo `afterDraw`) vykreslit ikonu letadla na `x = closest_ts`, `y` = spodní část plot area nebo kotva nad horním okrajem plotu (preferovat **těsně nad horním okrajem chartArea / v horním pásu**, ať nepřekrývá křivku dBA).
- Ikona: jednoduché SVG (inline path) nebo Material Design Icons / unicode ✈ — konzistentní s existujícími ikonami; barva neutrální (např. tmavě šedá / accent), hover zvýraznění.
- Hit-test: při `click` na canvas spočítat vzdálenost kurzoru k markerům (pixel radius ~12–16 px); při zásahu otevřít popup.
- Při překryvu více markerů blízko sebe: klik vybere nejbližší; v popup volitelně „další v okolí“ není v1 povinné.

**Popup**

- Absolutně pozicovaný `#aircraftPopup` (ne `alert`, ne `title=`):
  - Callsign (nebo `icao24` pokud callsign prázdný)
  - Země
  - Výška: `XXX m`
  - Vzdálenost: `X.X km`
  - Rychlost: `XXX km/h` (převod z m/s)
  - Směr / vertical rate (stoupá / klesá)
  - Čas přiblížení (lokální `TZ`)
  - Interval first–last seen (krátce)
- Zavření: klik mimo, Escape, nebo křížek.
- Na mobilu: stejný popup (tap).

**Legenda**

- Do `.chart-legend` přidat položku „přelet“ se stejnou ikonou (malý swatch).

**Stavy**

- Feature off / bez souřadnic: žádné markery, žádná chyba v UI.
- Žádné přelety v rozsahu: legenda může zůstat; prázdné pole OK.
- OpenSky down: tiché (log na backendu); staré DB markery se dál zobrazí.

### 4.9 Dotčené části systému

| Oblast | Soubory | Poznámka |
|--------|---------|----------|
| Backend | `backend/app/aircraft.py` (nový), `main.py` | Poll, DB, history pole, prune |
| Frontend | `static/app.js`, `index.html`, `style.css` | Plugin, popup, legenda |
| Konfigurace | `.env`, `.env.example`, `docker-compose.yml` | Nové `AIRCRAFT_*`, `OPENSKY_*` |
| Dokumentace | tento `spec.md`; volitelně krátká zmínka v README | Jak získat OpenSky API client |

## 5. Alternativy

| Alternativa | Proč nezvoleno (pro v1) |
|-------------|-------------------------|
| Přílety/odlety podle ICAO letiště | Váže na konkrétní letiště; nemusí odpovídat slyšitelnosti u měření |
| FlightRadar24 / placená API | Zbytečné náklady; OpenSky stačí pro hobby/nekomerční |
| Ukládat každý raw poll sample | Víc místa; UI stejně chce událost + closest |
| chartjs-plugin-annotation | Nová závislost; projekt už má vlastní pluginy |
| Frontend volá OpenSky přímo | CORS, tajemství, kreditový účet — jen přes backend |
| Filtrovat jen podle výšky bez vzdálenosti | Nízko nad vzdáleným krajem bboxu ≠ slyšitelné |

## 6. Rizika a omezení

- **ADS-B pokrytí** závisí na dobrovolných přijímačích; výpadky / díry možné.
- Letadla **bez ADS-B** (část GA, některé vojenské) v datech nebudou — marker ≠ kompletní vysvětlení hluku.
- OpenSky výška je typicky AMSL, ne AGL; u kopcovitého terénu je filtr přibližný.
- **Kredity / 429:** při anonymním přístupu zkrátit poll nebo vyžadovat `OPENSKY_*`.
- Poll 60 s může „minout“ velmi krátký přelet v okraji filtru; `GAP` a opakované sightingy to částečně řeší, ne 100 %.
- Hustý provoz (velké hub letiště) → více markerů; soft-cap v history API.
- ToS OpenSky: nekomerční / fair use; uvést zdroj v UI drobně („data: OpenSky Network“) volitelně ve status/popup patičce.

## 7. Testovací plán

- [ ] S platnými souřadnicemi a `AIRCRAFT_ENABLED=1` běží poll (log / `last_poll_at`).
- [ ] Letadlo nad limitem výšky nebo vzdálenosti se **neuloží**.
- [ ] Opakované sightingy stejného `icao24` v `GAP_S` = 1 řádek; `closest_*` odpovídá minimální vzdálenosti.
- [ ] `GET /api/v1/history` vrací `aircraft_overflights` v rozsahu; markery sedí na časové ose s body hluku.
- [ ] Klik na marker otevře popup s očekávanými poli; Escape/klik mimo zavře.
- [ ] Bez souřadnic / `AIRCRAFT_ENABLED=0`: žádný poll, prázdné pole, graf OK.
- [ ] Simulace 429 / timeout OpenSky: měření a historie fungují.
- [ ] Retence maže staré přelety.
- [ ] Regrese: weather timeline, night bands, ingest, admin.

## 8. Implementační kroky

Po schválení specifikace:

1. [x] Env + compose: `AIRCRAFT_*`, `OPENSKY_CLIENT_ID` / `SECRET`.
2. [x] Tabulka `aircraft_overflights` + prune v `ensure_db` / `prune_old`.
3. [x] `aircraft.py`: OAuth, fetch, filtr, upsert, poll thread.
4. [x] Napojení startup + `aircraft_overflights` do `/api/v1/history`.
5. [x] Frontend: plugin markerů, popup, legenda, styly.
6. [ ] Manuální ověření dle §7; stav specifikace → `implemented`.

**Git:** commit provádí výhradně uživatel.

## 9. Otevřené otázky

1. **Default výška 1500 m** — OK, nebo preferujete hned **1000 m**?
2. Máte / založíte OpenSky účet + API client (`OPENSKY_CLIENT_ID`/`SECRET`), nebo nejdřív anonymní režim s delším pollem?
3. Zobrazit v UI drobný credit „OpenSky Network“ u legendy / popup?
4. Soft-cap 500 přeletů na history response — stačí?

## 10. Historie

| Datum | Autor | Změna |
|-------|-------|-------|
| 2026-07-24 | agent | Vytvoření specifikace (`draft`) |
| 2026-07-24 | agent | Implementace — stav `implemented` |
