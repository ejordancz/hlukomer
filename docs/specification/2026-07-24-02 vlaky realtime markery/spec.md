# Vlaky — markery průjezdů v grafu

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/specification/2026-07-24-02 vlaky realtime markery` |
| **Datum** | 2026-07-24 |
| **Stav** | `draft` (analýza + návrh; **neimplementovat** bez schválení a volby providera) |
| **Autor** | agent |
| **Související** | `2026-07-24-01 letadla opensky markery` (stejný UX vzor: poll → událost → marker → popup) |

## 0. Verdikt (shrnutí)

| Otázka | Odpověď |
|--------|---------|
| **Obecně (svět / EU) jako OpenSky?** | **Ne.** Neexistuje volné, globální API s GPS polohami vlaků srovnatelné s ADS-B/OpenSky. |
| **Celá ČR jednotně?** | **Ne oficiálně.** Správa železnic polohy osobních vlaků **má** a veřejnosti je **ukazuje** (mapa / Datel), ale **neposkytuje otevřené API**. Scraping GRAPP/mapy je právně i technicky rizikový. |
| **Část ČR legálně / otevřeně?** | **Ano, regionálně.** Zejména **PID (Praha + Středočeský)** přes Golemio a **IDS JMK (Jihomoravský)** přes KORDIS open data. Pokrytí = vlaky v daném IDS, ne nutně všechny spoje na síti SŽ. |
| **Doporučení pro hlukomer** | Feature **vázat na provider + lokalitu**, ne na „jakékoli `LATITUDE`/`LONGITUDE`“. V1 jen pokud měření leží v pokryté oblasti (typicky PID nebo JMK). Jinak feature vypnout / odložit. |

**Rozdíl oproti letadlům:** OpenSky funguje „kdekoliv se souřadnicemi“. U vlaků je datový zdroj **fragmentovaný podle státu / kraje / IDS** a u ČR na národní úrovni **úmyslně uzavřený**.

---

## 1. Cíl

Podle `LATITUDE` / `LONGITUDE` (a zvoleného providera) periodicky načítat polohy vlaků z **legálně použitelného** zdroje, ukládat průjezdy v dosahu slyšitelnosti u měřicího místa a v grafu hlasitosti zobrazit **marker s ikonou vlaku**. Po kliknutí popup s detaily (číslo / linka, zpoždění, vzdálenost, …).

Řešení **není obecné** ve smyslu OpenSky. Je to **pluginová vrstva providerů** s explicitním pokrytím a vypínačem.

## 2. Kontext a motivace

### Současný stav

- Dashboard už má přelety letadel (`aircraft_overflights`, Chart.js markery, popup) — stejný UX vzor lze znovu použít.
- Souřadnice měření existují (`LATITUDE`, `LONGITUDE`).
- DB: SQLite, background poll thread (weather / aircraft).

### Motivace

Venkovní mikrofon zachytí i průjezdy vlaků (zejména blízko trati). Operátor u peaku v grafu chce hned vidět, zda v daný čas kolem projel vlak, a kliknutím zjistit spoj / vzdálenost / zpoždění.

### Proč je to těžší než u letadel

1. **Žádný globální „ADS-B pro vlaky“** — polohy drží provozovatelé infrastruktury / IDS / dopravci.
2. **SŽ (ČR)** data pro veřejnost **nezveřejňuje jako API** (viz §4.1).
3. **Open data v ČR** jsou **regionální** (IDS), ne celostátní.
4. Nákladní / mimo IDS / výlukové spoje často **nejsou** v otevřených feedech.

## 3. Požadavky

### Funkční

- [ ] Feature zapnutá jen pokud je **provider** nakonfigurován a lokalita leží v jeho pokrytí (nebo operátor výslovně potvrdí).
- [ ] Periodicky pollovat polohy vlaků z aktivního providera; filtrovat podle vodorovné vzdálenosti od měření.
- [ ] Deduplikovat sightingy stejného spoje do jedné **průjezdové události**; marker na čas **nejbližšího přiblížení**.
- [ ] `GET /api/v1/history` vrací seznam průjezdů v rozsahu grafu (analogie `aircraft_overflights`).
- [ ] Markery + popup v UI (stejný jazyk jako letadla).
- [ ] Bez providera / vypnuto: žádný poll, žádné markery.

### Nefunkční

- [ ] **Žádný scraping** GRAPP / `mapy.spravazeleznic.cz` / IDOS v produktovém kódu (ToS, autorská práva SŽ, nestabilní API).
- [ ] Výpadek providera nesmí shodit ingest ani graf.
- [ ] Respektovat rate limity (Golemio: typicky ~20 req / 8 s na klíč).
- [ ] Zachovat vanilla JS + CSS dashboardu.
- [ ] Retence stejně jako ostatní historická data (`RETENTION_DAYS` / vlastní env).

## 4. Analýza datových zdrojů

### 4.1 Národní — Správa železnic (celá síť ČR)

| Aspekt | Stav |
|--------|------|
| Data existují | Ano — GPS / provozní polohy osobních vlaků |
| Veřejné zobrazení | Interaktivní mapa SŽ (`mapy.spravazeleznic.cz`), aplikace Datel; GRAPP od 2024/2025 spíš pro přihlášené (zaměstnanci / dopravci / smluvní partneři) |
| Veřejné open API | **Ne** |
| 106 / smlouvyy | SŽ historicky uvádí, že polohy poskytuje dopravcům / smluvně; veřejnosti přes UI, ne jako strojový feed |
| Komunitní scrapery | JrUtil **RtCollect** (scrape GRAPP → historické zpoždění/polohy, RtView) — užitečné pro výzkum, **nevhodné** jako dependency hlukomeru |
| ToS / copyright | GRAPP: „jakékoli užití dat bez souhlasu vlastníka…“ — scraper = právní riziko |

**Závěr:** Celostátní coverage **technicky existuje**, ale **není použitelné** bez smlouvy se SŽ / OLTIS. Pro v1 **nepočítat**. Budoucí cesta: oficiální smluvní feed, pokud někdy vznikne open data politika.

### 4.2 Regionální open data — použitelné kandidáty

#### A) PID / Golemio (Praha + Středočeský kraj) — **doporučený provider #1**

| Položka | Detail |
|---------|--------|
| API | `https://api.golemio.cz/v2/…` (REST JSON; i GTFS-RT) |
| Auth | Volný API key (`X-Access-Token`) — registrace na `api.golemio.cz/api-keys` |
| Vlaky | Ano — v GTFS PID jsou vlaky; `route_type` zahrnuje train; polohy přes `/v2/vehiclepositions` (a public varianty) |
| Filtry | mimo jiné `routeType`, limity, u některých endpointů i bbox |
| Rate limit | Default ~20 requestů / 8 s (lze žádat vyšší) |
| Pokrytí | Spoje v **PID** (Praha + Středočeský). Ne „všechny vlaky na mapě SŽ“ v ČR. Dálkové / mimo PID kontrakt mohou chybět nebo být neúplné. |
| Licence | Open data města Prahy / Golemio — vhodné pro hobby/nekomerční i další použití dle podmínek portálu |

**Proč #1:** Stabilní dokumentované API, bbox/filtry, stejný model jako u letadel (poll → lat/lon → vzdálenost), free key.

#### B) IDS JMK / KORDIS (Jihomoravský kraj) — **provider #2**

| Položka | Detail |
|---------|--------|
| Feed | Open data NKOD — polohy vozidel IDS JMK (JSON / ArcGIS; doporučený WebSocket stream) |
| Update | ~10 s |
| Vlaky | `vtype` / `ltype` = **5** = vlak |
| Pole | `lat`, `lon`, `bearing`, `linename`, `delay`, `laststopid`, … |
| Pokrytí | IDS JMK (Brno + JMK regionální vlaky v systému) |

**Proč #2:** Legální open data; jiný formát než Golemio → druhý adapter ve stejné architektuře.

#### C) Ostatní kraje ČR

| Region | Realtime polohy (open) | Vlaky? |
|--------|------------------------|--------|
| DÚK (Ústecký) a další IDS | Často GTFS jízdní řády; RT polohy **nekonzistentně** / ne vždy open | Ověřit případ od případu |
| Většina ČR mimo PID/JMK | Spíš **žádný** otevřený train GPS feed | — |

FOSDEM 2026 (D. Koňařík): realtime polohy existují interně pro většinu vlaků a objednané spoje, ale **jen ~tři systémy** dávají otevřená API — shoduje se s PID / JMK (+ případně další drobné).

### 4.3 Nevyhovující / mimo scope alternativy

| Zdroj | Proč ne |
|-------|---------|
| Scraping GRAPP / mapy SŽ | ToS, nestabilita, anti-bot; právní riziko |
| `live-cd-wifi-position` (ČD WiFi) | Funguje **jen na palubě** vlaku — ne z pozemního mikrofonu |
| IDOS / CHAPS | Komerční; ne open GPS feed |
| geOps Mobility / placené agregátory | Náklady, vendor lock-in; overkill pro v1 |
| OpenRailwayMap | Infrastruktura (koleje), **ne** živé polohy vlaků |
| CIS JŘ / GTFS jízdní řády samotné | Jen plán; bez RT GPS jen **odhady** průjezdu (viz §4.4) |

### 4.4 Slabá náhradní strategie: „odhad z jízdního řádu + vzdálenost k trati“

Pokud lokalita **není** v PID/JMK:

1. Z OSM / OpenRailwayMap vzít geometrii tratí v okolí měření.
2. Z CIS JŘ / regionálního GTFS spočítat plánované průjezdy nejbližší zastávkou / úsekem.
3. Marker umístit na **plánovaný** čas (± odhad zpoždění, pokud vůbec).

**Problémy:** zpoždění, výluky, nákladní vlaky, nepřesná interpolace na trati → slabá korelace s peakem hluku. **Nedoporučeno jako v1**; maximálně samostatný pozdější experiment se stavem `experimental` a jasným UI štítkem „odhad (jízdní řád)“.

### 4.5 Mezinárodní kontext (pro úplnost)

Stejný problém jinde: Deutsche Bahn, SNCF, … mají různé míry otevřenosti; UK má částečně Darwin/Open Train Times; Švýcarsko/Nizozemsko mají solidní open RT. **Žádný jeden provider** nepokrývá „libovolné místo na Zemi“ jako OpenSky. Proto feature v hlukomeru musí zůstat **provider-local**.

## 5. Návrh řešení (po schválení)

### 5.1 Architektura: TrainProvider

```
┌─────────────────┐     poll      ┌──────────────────┐
│  trains.py      │──────────────▶│ TrainProvider    │
│  (thread+DB)    │               │  interface       │
└────────┬────────┘               └────────┬─────────┘
         │                                 │
         │ upsert                          ├─ GolemioPidProvider
         ▼                                 ├─ IdsJmkProvider
┌─────────────────┐                        └─ (future: SzdContractual…)
│ train_passages  │
└────────┬────────┘
         │ history API
         ▼
   Chart.js trainMarkersPlugin + popup
```

**Společný výstup providera (normalizovaný sighting):**

```python
{
  "vehicle_id": str,      # stabilní ID ve feedu
  "trip_id": str | None,  # GTFS trip / CIS číslo spoje
  "train_number": str | None,  # např. "Os 9801" / trip_short_name
  "route_short_name": str | None,  # např. "S9"
  "agency": str | None,
  "lat": float,
  "lon": float,
  "speed_kmh": float | None,
  "bearing_deg": float | None,
  "delay_s": int | None,
  "observed_at": float,   # unix ts
  "source": "golemio" | "ids_jmk" | …
}
```

### 5.2 Konfigurace

| Proměnná | Default | Popis |
|----------|---------|--------|
| `LATITUDE` / `LONGITUDE` | (již existují) | Střed; bez nich off |
| `TRAINS_ENABLED` | `0` | Explicitní zapnutí (default off — není obecné!) |
| `TRAINS_PROVIDER` | prázdné | `golemio` \| `ids_jmk` (povinné při enabled) |
| `TRAINS_MAX_DISTANCE_M` | **800** | Max. vodorovná vzdálenost [m] — výrazně menší než u letadel |
| `TRAINS_POLL_INTERVAL_S` | **30** | Interval pollu [s] |
| `TRAINS_GAP_S` | **180** | Mezera pro sloučení sightingů do jedné události |
| `TRAINS_RETENTION_DAYS` | `= RETENTION_DAYS` | Retence |
| `GOLEMIO_API_KEY` | prázdné | Pro provider `golemio` |
| `TRAINS_ROUTE_TYPES` | `train` | Filtr (Golemio); neukládat metro/tram |

**Proč default 800 m:** průjezd je slyšitelný hlavně v blízkosti trati; 8 km jako u letadel by zaplnilo graf vzdálenými spoji. Operátor může zvednout na 1500–2000 m v otevřené krajině / snížit na 300–500 m ve městě.

**Auto-detect regionu:** v1 **ne** (křehké). Operátor nastaví `TRAINS_PROVIDER` podle místa. Volitelně later: kontrola „souřadnice mimo bbox PID/JMK → warn v logu / status API“.

### 5.3 Filtr „slyšitelný průjezd“

Uložit, pokud **vše** platí:

1. Provider vrátil platné lat/lon.
2. Typ = vlak (ne autobus omylem ve feedu).
3. `haversine(měření, vlak) ≤ TRAINS_MAX_DISTANCE_M`.
4. (Volitelně) `tracking` / aktivní pozice — vyřadit zastaralé / `isinactive`.

Výška se **nefiltruje** (vlak ≈ terén). Rychlost 0 u stanice blízko mikrofonu může být validní (stání / rozjezd) — **nevyřazovat** jen kvůli nule; marker u stání je pořád užitečný.

### 5.4 Model průjezdové události

Stejný algoritmus jako u letadel (`GAP_S`, update `closest_*` při menší vzdálenosti), klíč identity:

- Preferovat `vehicle_id` + `trip_id` (nebo `train_number`), ne jen číslo linky (více spojů na lince).

### 5.5 Databáze

```sql
CREATE TABLE IF NOT EXISTS train_passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  vehicle_id TEXT,
  trip_id TEXT,
  train_number TEXT,
  route_short_name TEXT,
  agency TEXT,
  first_seen_ts REAL NOT NULL,
  last_seen_ts REAL NOT NULL,
  closest_ts REAL NOT NULL,
  closest_lat REAL,
  closest_lon REAL,
  closest_distance_m REAL NOT NULL,
  closest_speed_kmh REAL,
  closest_bearing_deg REAL,
  delay_s INTEGER,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_train_closest_ts ON train_passages(closest_ts);
CREATE INDEX IF NOT EXISTS idx_train_identity_last
  ON train_passages(source, vehicle_id, trip_id, last_seen_ts);
```

### 5.6 Backend

Nový modul `backend/app/trains.py` (vzor `aircraft.py` / `weather.py`):

- `get_trains_config()`, `haversine_m` (sdílet s aircraft nebo common util)
- Provider registry + `process_poll()`
- `start_trains_poll()` daemon thread
- Start z `on_startup()` jen pokud `TRAINS_ENABLED=1` a provider + credentials OK

**Golemio adapter (v1):**

- `GET /v2/vehiclepositions` s filtrem na train / případně public endpoint s bbox kolem měření
- Mapovat GeoJSON features → normalizovaný sighting
- Cache API key jen v env (ne commitovat)

**IDS JMK adapter (v1.1 nebo paralelní):**

- WebSocket subscribe nebo JSON poll; filtrovat `vtype==5`; haversine lokálně

### 5.7 API

Rozšíření `GET /api/v1/history`:

```json
{
  "train_passages": [
    {
      "id": 3,
      "t": 1721805123.0,
      "source": "golemio",
      "train_number": "Os 9812",
      "route_short_name": "S9",
      "agency": "České dráhy",
      "distance_m": 220.0,
      "speed_kmh": 68.0,
      "bearing_deg": 45.0,
      "delay_s": 120,
      "first_seen_ts": 1721805000.0,
      "last_seen_ts": 1721805200.0
    }
  ],
  "trains": {
    "enabled": true,
    "provider": "golemio",
    "max_distance_m": 800,
    "coverage_note": "PID (Praha + Středočeský); ne celá ČR"
  }
}
```

Soft-cap obdobně jako u letadel (např. 500).

Volitelně `GET /api/v1/trains` — status posledního pollu / chyby.

### 5.8 UI / UX

- Plugin `trainMarkersPlugin` — ikona vlaku (SVG), pozice jako u letadel (horní pás chartArea).
- Popup: číslo spoje / linka, dopravce, vzdálenost, rychlost, zpoždění, čas closest, zdroj.
- Legenda: „průjezd vlaku“.
- Drobný credit zdroje: „data: Golemio / PID“ nebo „KORDIS / IDS JMK“.
- Pokud `TRAINS_ENABLED=0`: žádná legenda povinná (nebo skrytá).

**Souběh s letadly:** oba typy markerů mohou koexistovat; různé ikony; hit-test vybere nejbližší marker libovolného typu.

### 5.9 Dotčené části (až po schválení)

| Oblast | Soubory | Poznámka |
|--------|---------|----------|
| Backend | `trains.py` (nový), `main.py` | Poll, DB, history |
| Frontend | `app.js`, `index.html`, `style.css` | Plugin, popup, legenda |
| Konfigurace | `.env*`, `docker-compose.yml` | `TRAINS_*`, `GOLEMIO_API_KEY` |
| Docs | tento `spec.md` | Pokrytí a limity jasně |

## 6. Alternativy (rozhodovací matice)

| Varianta | Pokrytí | Legálnost | Náročnost | Doporučení |
|----------|---------|-----------|-----------|------------|
| **Golemio PID** | Praha + SčK | Open API | Střední | **V1 pokud lokalita sedí** |
| **IDS JMK** | JMK | Open data | Střední | V1.1 / pokud lokalita v JMK |
| Smluvní feed SŽ | Celá síť osobní | Legální se smlouvou | Vysoká (obchod) | Budoucnost |
| Scrape GRAPP | Celá síť | Rizikové | Střední | **Zamítnout** |
| Jen jízdní řád + OSM | Kdekoliv s tratí | OK | Střední | Experiment, ne v1 |
| Neimplementovat | — | — | 0 | **Default**, pokud lokalita mimo PID/JMK |

## 7. Rizika a omezení

- **Neuniverzální feature** — mimo pokrytý IDS markery chybí i když vlak slyšet je.
- PID/JMK **neobsahují** všechny nákladní ani všechny dálkové spoje.
- GPS ve feedu může být **snapnutá na trasu** / zpožděná o desítky sekund → marker ± od peaku hluku.
- Hustý železniční uzel (Praha) → více markerů; držet nízký `MAX_DISTANCE_M`.
- Záměna s metrem: Golemio musí filtrovat `route_type=train` (metro má vlastní type).
- Rate limit Golemio při krátkém pollu + jiných klientech.
- Změna API / přejmenování endpointů — držet tenký adapter.

## 8. Testovací plán (až při implementaci)

- [ ] S `TRAINS_ENABLED=1` + platným klíčem běží poll; bez klíče jasná chyba v logu, graf OK.
- [ ] Vlak mimo `MAX_DISTANCE_M` se neuloží; uvnitř ano.
- [ ] Opakované sightingy → 1 událost, `closest_*` = min. vzdálenost.
- [ ] History + markery + popup.
- [ ] `TRAINS_ENABLED=0`: žádný poll.
- [ ] Timeout providera: ingest běží dál.
- [ ] Regrese: aircraft, weather, ingest.

## 9. Implementační kroky (až po schválení)

1. [ ] Potvrdit lokalitu měření vůči pokrytí PID / JMK (nebo „neimplementovat“).
2. [ ] Env + compose: `TRAINS_*`, `GOLEMIO_API_KEY` (nebo JMK bez klíče dle feedu).
3. [ ] Tabulka `train_passages` + prune.
4. [ ] `trains.py` + jeden provider (Golemio **nebo** JMK).
5. [ ] History API + frontend markery/popup/legenda.
6. [ ] Manuální ověření; stav → `implemented`.

**Git:** commit provádí výhradně uživatel.  
**Teď:** pouze tato specifikace — **žádná implementace**.

## 10. Otevřené otázky pro uživatele

1. **Kde leží měřicí místo** (kraj / blízko které trati)? Bez toho nelze smysluplně zvolit provider.
2. Je lokalita v **PID** nebo **IDS JMK**? Pokud ne — souhlasíte s verdiktem „zatím neimplementovat“?
3. Preferujete v1 jen **Golemio**, nebo hned abstrakci se dvěma providery?
4. Default **800 m** vzdálenost — OK, nebo jiná hodnota podle vaší tratě?
5. Má smysl vůbec sledovat **nákladní** (pravděpodobně nedostupné) / stačí osobní v IDS?
6. Chcete v UI explicitní štítek „pouze PID“ / „ne celá ČR“, ať operátor nečeká magii?

## 11. Historie

| Datum | Autor | Změna |
|-------|-------|-------|
| 2026-07-24 | agent | Analýza zdrojů + návrh specifikace (`draft`); bez implementace |
