# Ukládání — wide řádky + hot/cold rozlišení

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/specification/2026-07-25-01 ukladani wide a hot-cold` |
| **Datum** | 2026-07-25 |
| **Stav** | `implemented` |
| **Autor** | agent |
| **Související** | ingest ESP → `POST /api/v1/ingest`, spektrogram `GET /api/v1/spectrum/history`, retence `RETENTION_DAYS` / `LIVE_RETENTION_DAYS` |

## 0. Verdikt (shrnutí)

| Otázka | Odpověď |
|--------|---------|
| Proč ~160 MB/den? | EAV tabulka `measurements`: **20 řádků/s** (17 pásem + LAeq/LZeq/LFI) + 2 indexy ≈ velikost tabulky |
| Co se mění? | Live metriky → **1 wide řádek/s**; starší data → **5 s energy average** (cold) |
| Ztráta historie / spektrogramu? | **Ne.** Migrace zachová všechna existující data; API odpovědi zůstanou kompatibilní |
| Odhad po změně | Hot 1 Hz: **~15–25 MB/den**; cold 5 s: **~3–5 MB/den**; 90 d cold + 48 h hot ≈ **řádově stovky MB**, ne GB |
| Produkční riziko | Migrace **vedle** staré tabulky, ověření, teprve pak drop; záloha DB před startem |

---

## 1. Cíl

Snížit diskovou stopu historických měření a spektrogramu z ~160 MB/den na řádově desítky MB/den **bez ztráty**:

- dlouhodobé historie LAeq (graf),
- spektrogramu (heatmapa z pásem),
- kliknutí na sloupec spektrogramu (`/spectrum/at`),
- minutových agregátů (`laeq_1min` / `lamax` / `lamin`).

Řešení má dvě vrstvy, které se doplňují:

1. **Wide schéma** — jeden řádek na sekundu místo 20 EAV řádků (největší zisk při stejném 1 Hz).
2. **Hot / cold** — plných 1 Hz jen v recentním okně; starší data sbalit na 5 s energy average (dlouhá historie, méně místa).

---

## 2. Kontext a motivace

### Současný stav (produkce)

| Položka | Hodnota |
|---------|---------|
| DB | SQLite `data/hlukomer.db` |
| Schéma | EAV `measurements(id, ts, device_id, kind, metric, value)` |
| Live metriky | `laeq_1s`, `lez_1s`, `lfi_db`, `oct_*` (17) — `kind=live`, 1 Hz |
| Minutové | `laeq_1min`, `lamax_1min`, `lamin_1min` — `kind=minute` (~3/min) |
| Indexy | `idx_meas_ts_metric(metric, ts)`, `idx_meas_device_ts(device_id, ts)` |
| Retence | `RETENTION_DAYS=90` (vše), `LIVE_RETENTION_DAYS=7` (live metriky) |
| Prune | jen při `startup` — bez periodického běhu / `VACUUM` |
| Spektrogram | není obrázek; UI skládá heatmapu z `oct_*` přes `pivot_spectrum_rows` |
| Display downsample | jen na čtení (`max_columns` / `max_points`) — neukládá se |

**Měření (2026-07-25):** ~322 MB DB za ~44,5 h ≈ **~170 MB/den**; indexy ≈ polovina velikosti.

### Motivace

Při `LIVE_RETENTION_DAYS=7` steady-state ≈ **1,2 GB** jen za live. Pro 90denní spektrogram by EAV bylo neúnosné. Wide + cold umožní držet spektrogram i graf na měsíce při stovkách MB.

### Co se nemění

- ESP firmware / payload ingestu (`spectrum[17]`, LAeq, …).
- Veřejné JSON API (tvar odpovědí `history`, `spectrum/history`, `latest`, `spectrum/at`).
- UI spektrogramu a grafu (kromě případné informace o rozlišení cold okna — volitelné).
- Tabulky `weather_snapshots`, `aircraft_overflights`, `meta`.

---

## 3. Požadavky

### Funkční

- [ ] Ingest zapisuje **jeden wide řádek** za sekundu (live) místo 20 EAV insertů.
- [ ] Minutové metriky zůstávají (samostatná úzká tabulka nebo EAV-light) — objem zanedbatelný.
- [ ] Background job periodicky **rollup** hot → cold (5 s energy average) a maže hot řádky starší než hot okno.
- [ ] Read path (`history`, `spectrum/history`, `latest`, `spectrum/at`, offline stats) čte z wide hot + cold **transparentně** (stejné API).
- [ ] Migrace existující EAV DB na wide **bez ztráty řádků**; ověřitelné checksumy / počty.
- [ ] Periodický prune + možnost uvolnit místo (`incremental_vacuum` / řízený `VACUUM`).

### Nefunkční

- [ ] Při migraci **žádný výpadek ingestu** delší než krátký restart / dual-write přechod (viz §6).
- [ ] Migrace běží bezpečně na běžící produkci (záloha → create → copy → verify → cutover).
- [ ] SQLite single-writer: migrace a rollup nesmí dlouho blokovat ingest (chunked transakce).
- [ ] Defaulty musí jít přepsat env proměnnými.
- [ ] Legacy 10oktávová data (starý firmware) se při migraci zachovají (NULL ve chybějících 1/3-oktávách / mapování — viz §4.4).

### Explicitní non-goals (v1)

- Ukládání PNG / WebP spektrogramů.
- Komprese celé DB (SQLCipher, zstd vfs) — mimo scope.
- Změna ESP sample rate / počtu pásem.
- Multi-device optimalizace nad rámec stávajícího `device_id` (produkce má 1 device).

---

## 4. Návrh řešení

### 4.1 Cílové schéma

#### A) `samples_1s` — hot (plných 1 Hz)

Jeden řádek = jeden okamžik live měření.

```sql
CREATE TABLE samples_1s (
    ts          REAL NOT NULL,
    device_id   TEXT NOT NULL,
    laeq_1s     REAL,
    lez_1s      REAL,
    lfi_db      REAL,
    oct_25      REAL,
    oct_31      REAL,
    oct_40      REAL,
    oct_50      REAL,
    oct_63      REAL,
    oct_80      REAL,
    oct_100     REAL,
    oct_125     REAL,
    oct_160     REAL,
    oct_200     REAL,
    oct_250     REAL,
    oct_500     REAL,
    oct_1k      REAL,
    oct_2k      REAL,
    oct_4k      REAL,
    oct_8k      REAL,
    oct_16k     REAL,
    PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;
```

| Rozhodnutí | Volba v1 | Důvod |
|------------|----------|--------|
| Typ hodnot | `REAL` (float64) | Jednoduchá migrace 1:1, debuggovatelné, SQL přátelské |
| `WITHOUT ROWID` | ano | PK `(device_id, ts)` = clustered index; druhý index netřeba |
| BLOB `uint16` @ 0,1 dB | **ne v1** (volitelné v2) | Další ~2–3× úspora; složitější rollup/API; odložit |
| UPSERT | `INSERT … ON CONFLICT DO UPDATE` | Opakovaný ingest se stejným `ts` nepřidá duplicity |

**Odhad velikosti:** ~200–280 B/řádek → **~17–24 MB/den** (vs ~170 MB EAV).

#### B) `samples_Ns` — cold (archiv, default N = 5 s)

Stejné sloupce jako `samples_1s`, plus:

```sql
CREATE TABLE samples_5s (
    -- stejné sloupce jako samples_1s
    n_src INTEGER NOT NULL DEFAULT 1,  -- kolik 1s vzorků vstoupilo do průměru
    PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;
```

- `ts` = **začátek** bucketu (unix, zarovnaný na `ARCHIVE_INTERVAL_S`), nebo střed — **zvolit začátek** (jednoznačné, snadný overlap).
- Hodnoty = **energy average** (stejná logika jako `pivot_spectrum_rows` / `_db_to_energy`):

  \[
  L_\mathrm{avg} = 10 \log_{10}\Bigl(\frac{1}{n}\sum_i 10^{L_i/10}\Bigr)
  \]

  pro každé pásmo i pro `laeq_1s` / `lez_1s` / `lfi_db`. Chybějící (NULL) v bucketu se do průměru nepočítají; `n_src` = počet ne-NULL zdrojů pro `laeq_1s` (nebo min. přes metriky — dokumentovat v kódu).

#### C) `samples_minute` — minutové agregáty

```sql
CREATE TABLE samples_minute (
    ts        REAL NOT NULL,
    device_id TEXT NOT NULL,
    laeq_1min REAL,
    lamax_1min REAL,
    lamin_1min REAL,
    PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;
```

Objem ~4 k řádků/den → &lt; 1 MB i za 90 dní. Retence = `RETENTION_DAYS`.

#### D) Staré `measurements`

Po úspěšné migraci a cutoveru **DROP** (až po ověření §6.5). Do té doby jen ke čtení / migraci.

### 4.2 Konfigurace (env)

| Proměnná | Default | Popis |
|----------|---------|--------|
| `RETENTION_DAYS` | `90` | Max stáří cold + minute (+ weather/aircraft beze změny) |
| `HOT_RETENTION_HOURS` | `48` | Jak dlouho držet plných 1 Hz v `samples_1s` |
| `ARCHIVE_INTERVAL_S` | `5` | Délka cold bucketu [s]; povolené 5 nebo 10 |
| `ARCHIVE_JOB_INTERVAL_S` | `300` | Jak často běží rollup+prune job |
| `LIVE_RETENTION_DAYS` | — | **Deprecated** po cutoveru; nahradit `HOT_RETENTION_HOURS` + cold retencí. Během migrace mapovat: hot cutoff = `HOT_RETENTION_HOURS`, cold cutoff = `RETENTION_DAYS` |
| `MIGRATE_EAV_ON_STARTUP` | `1` | Jednorázová / pokračující migrace EAV → wide při startu |
| `VACUUM_AFTER_MIGRATE` | `0` | Po dropu staré tabulky spustit `VACUUM` (blokující; default off, manuálně / off-peak) |

**Doporučený produkční profil:** `HOT_RETENTION_HOURS=48`, `ARCHIVE_INTERVAL_S=5`, `RETENTION_DAYS=90`.

| Okno | Rozlišení | Odhad |
|------|-----------|--------|
| Posledních 48 h | 1 Hz | ~40–50 MB |
| Zbytek do 90 d | 5 s | ~90 × 4 MB ≈ 360 MB |
| **Celkem steady** | | **~400–450 MB** (vs ~1,2 GB jen za 7 d EAV live) |

Variantně `HOT_RETENTION_HOURS=168` (7 d @ 1 Hz): +~120 MB hot, stále OK.

### 4.3 Ingest

`POST /api/v1/ingest` beze změny request body.

Zápis:

1. Live hodnoty (`laeq_1s`, `lez_1s`, `lfi_db`, `spectrum`) → `INSERT INTO samples_1s … ON CONFLICT DO UPDATE`.
2. Minutové → `samples_minute` stejně.
3. Legacy `spectrum` délky 10: vyplnit odpovídající `oct_31`…`oct_16k`; 1/3-oktávy 25/40/… nechat NULL.

Validace hodnot (NaN, &lt; −50, &gt; 200) zůstává jako dnes per-field.

### 4.4 Read path (API beze změny kontraktu)

Jednotná helper vrstva:

```text
query_range(device_id, t_start, t_end) →
  rows from samples_1s WHERE ts in range
  UNION / append
  rows from samples_5s WHERE ts in range AND ts < hot_cutoff
```

Pravidla překryvu:

- Pro `ts >= now - HOT_RETENTION_HOURS` **preferovat** `samples_1s`.
- Pro starší **jen** `samples_5s` (po rollupu už v hot nejsou).
- Během migrace, dokud existuje `measurements`: fallback čtení z EAV pokud wide ještě nemá data pro daný rozsah (nebo naopak: migrace doběhne dřív než cutover — viz §6).

Úpravy funkcí (logicky):

| Funkce | Změna |
|--------|--------|
| `insert_metric` | nahradit `upsert_sample_1s` / `upsert_minute` |
| `latest_metric_value` / `fetch_spectrum` | `SELECT … FROM samples_1s ORDER BY ts DESC LIMIT 1` |
| `fetch_spectrum_at` | nearest row v `samples_1s` ∪ `samples_5s` (tolerance ≥ `ARCHIVE_INTERVAL_S/2` pro cold) |
| `spectrum_history` | číst wide; `pivot_spectrum_rows` zjednodušit (už není EAV pivot — přímo sloupce) |
| `history` | `laeq_1s` z wide (1s+5s); minutové z `samples_minute` |
| `fetch_offline_stats` | timestamps z `samples_1s` (+ cold pro starší okna) |
| `prune_old` | mazat podle nových tabulek + spouštět z periodického jobu |

Display downsample (`max_columns` / `max_points`) **zůstává** — cold 5 s už je řidší, ale UI může dál průměrovat.

### 4.5 Archive / rollup job

Daemon thread (stejný vzor jako weather/aircraft), interval `ARCHIVE_JOB_INTERVAL_S`:

1. `hot_cutoff = now - HOT_RETENTION_HOURS * 3600`.
2. Vybrat z `samples_1s` řádky s `ts < hot_cutoff` (chunky po např. 1 h nebo 10 k řádcích).
3. Seskupit do bucketů `floor(ts / N) * N` kde `N = ARCHIVE_INTERVAL_S`.
4. Energy-average → `INSERT INTO samples_5s … ON CONFLICT DO UPDATE` (idempotentní při restartu).
5. `DELETE FROM samples_1s WHERE ts < hot_cutoff` (jen po úspěšném zápisu daného chunku).
6. `DELETE FROM samples_5s WHERE ts < now - RETENTION_DAYS * 86400`.
7. `DELETE FROM samples_minute WHERE ts < …` stejně.
8. Meta klíč `archive_last_ts` / `archive_last_run` pro monitoring.

**Idempotence:** rollup smí běžet opakovaně; konflikt = přepočet z dosud nesmazaných 1s (proto mazat 1s až po upsertu cold).

### 4.6 Legacy spektrum při migraci

Existující EAV může mít:

- plných 17× `oct_*` (aktuální firmware),
- nebo 10 legacy oktáv.

Migrace do wide:

- Pro každý `ts`+`device_id` pivotnout dostupné metriky do sloupců.
- Chybějící pásma = NULL.
- Řádek zapsat i když spektrum není kompletní (částečná data &gt; ztráta).
- `spectrum/history` už dnes umí legacy fallback; po migraci: pokud v rozsahu jsou jen legacy-vyplněné sloupce, API může dál vrátit 10pásmový mód **nebo** 17 pásem s NULL/mezera — preferovat **17 sloupců s NULL** jen pokud UI snese díry; jinak detekce „jen legacy metriky přítomny“ jako dnes.

**Doporučení v1:** při čtení, pokud `oct_25`/`oct_40`/… jsou všude NULL a legacy oktávy ne, mapovat odpověď na legacy labels (zachovat stávající UX poznámku).

---

## 5. Odhad úspor

| Varianta | MB/den | 90 d |
|----------|--------|------|
| Dnes EAV 1 Hz (live) | ~170 | N/A (řezáno na 7 d ≈ 1,2 GB) |
| Wide REAL 1 Hz only | ~20 | ~1,8 GB (bez cold) |
| Wide 1 Hz 48 h + 5 s cold | ~20 hot transient + ~4 cold | **~400 MB** |
| Wide + uint16 BLOB (v2) | ~7–10 | ještě méně |

Minutové + weather + aircraft: zanedbatelné.

---

## 6. Migrace (produkce — nesmí ztratit data)

### 6.0 Princip

1. **Záloha souboru DB** před jakoukoli destruktivní operací.
2. Nové tabulky **vedle** `measurements` — nikdy `DROP` před verifikací.
3. Migrace **chunkovaná**, restartovatelná (meta kurzor).
4. Ingest během migrace: **dual-write** nebo krátký cutover — viz fáze.
5. Teprve po shodě kontrolních součtů → přepnout čtení → přestat zapisovat EAV → drop EAV → volitelně VACUUM.

### 6.1 Fáze 0 — příprava

- [ ] Off-peak okno (volitelné, ale vhodné kvůli I/O).
- [ ] Zastavit krátce jen pokud je nutný cold copy; jinak online.
- [ ] Záloha:

  ```bash
  sqlite3 data/hlukomer.db ".backup 'data/hlukomer-pre-wide-$(date -u +%Y%m%dT%H%M%SZ).db'"
  ```

  nebo `cp` při zastaveném procesu (konzistence: preferovat `.backup`).
- [ ] Ověřit volné místo na disku ≥ **2×** velikost DB (migrace + backup).
- [ ] Zapsat do `meta`: `eav_migration_status=pending`.

### 6.2 Fáze 1 — schema

Při `ensure_db()` / migračním kroku:

- [ ] `CREATE TABLE IF NOT EXISTS samples_1s …`
- [ ] `CREATE TABLE IF NOT EXISTS samples_5s …`
- [ ] `CREATE TABLE IF NOT EXISTS samples_minute …`
- [ ] Meta klíče: `eav_migration_cursor_ts`, `eav_migration_status`.

Ingest zatím **stále píše jen do EAV** (bezpečné). Nebo dual-write — viz 6.3.

### 6.3 Fáze 2 — kopie EAV → wide (online, chunky)

Algoritmus (pseudokód):

```
cursor = meta.eav_migration_cursor_ts or MIN(ts) - 1
while true:
  batch = SELECT DISTINCT ts, device_id FROM measurements
          WHERE kind='live' AND ts > cursor
          ORDER BY ts ASC LIMIT 5000
  if empty: break
  for each (ts, device_id):
    pivot all metrics for that ts into wide columns
    INSERT OR IGNORE / ON CONFLICT DO UPDATE into samples_1s
  for minute kind in same ts range → samples_minute
  cursor = max ts in batch
  meta.eav_migration_cursor_ts = cursor
  COMMIT
```

Požadavky:

- Chunk ≤ několik tisíc sekund, krátké transakce (ingest čeká max sekundy).
- `INSERT OR IGNORE` / upsert: pokud dual-write už zapsal novější ingest, nepřepsat horšími daty (preferovat `DO UPDATE` jen když EAV má ne-NULL a wide NULL — nebo migraci spustit až po cutover ingestu; viz varianta níže).

**Doporučená varianta cutoveru (jednodušší, méně race conditions):**

| Krok | Ingest | Migrace | Read |
|------|--------|---------|------|
| 2a | EAV only | kopíruje historii do wide | EAV |
| 2b | **přepnout ingest na wide** (+ krátce dual-write 1–2 min) | doběhne do `MAX(ts)` EAV | EAV, dokud status ≠ done |
| 2c | wide only | verify (viz 6.5) | **wide** (+ fallback EAV pokud prázdné) |
| 2d | wide only | — | wide only |
| 2e | | DROP measurements + indexy | wide |
| 2f | | volitelně VACUUM | |

Mezi 2b a 2c doběhnout migraci ještě jednou (dojit zbývající EAV řádky po cutoveru).

### 6.4 Fáze 3 — první rollup hot→cold

Až po cutoveru zápisu:

- [ ] Spustit archive job: vše starší než `HOT_RETENTION_HOURS` z `samples_1s` → `samples_5s`, smazat z hot.
- [ ] **Poznámka:** Migrace nejprve naplní `samples_1s` i starými 1 Hz daty (až `LIVE_RETENTION_DAYS` historie). Rollup je zmenší na cold. To je záměr — nejprve bezpečná 1:1 kopie, teprve pak ztráta časového rozlišení (ne dat).

Energy average je **nevratná** redukce rozlišení. Proto:

- Rollup spouštět až po úspěšné verifikaci migrace (6.5).
- Záloha z 6.1 zůstává s plným 1 Hz EAV pro případný rollback.

### 6.5 Verifikace (povinná před dropem)

Pro náhodný vzorek časů + celkové agregáty:

| Kontrola | Očekávání |
|----------|-----------|
| Počet sekund s `laeq_1s` v EAV vs non-NULL `laeq_1s` ve wide (stejný rozsah) | shoda ± 0 (nebo zdůvodněné díry) |
| `MIN(ts)`, `MAX(ts)` live | shoda |
| Součet / průměr `laeq_1s` na 1h okně (energy avg) | relativní chyba &lt; 1e−6 (float kopie) |
| Počet minutových řádků | shoda |
| Spot check spektrogram: 10 náhodných `ts` — všech 17 pásem | shoda na 0,01 dB |
| `GET /api/v1/history?hours=6` před/po (stejný start) | stejný počet bodů (± downsample) a stats v toleranci |
| `GET /api/v1/spectrum/history?hours=6` | stejné `vmin`/`vmax` ± 0,1; počet sloupců po downsample srovnatelný |

Zapsat `eav_migration_status=verified` až po průchodu checklistu (automatický skript `scripts/verify_eav_migration.py` — součást implementace).

### 6.6 Fáze 4 — drop EAV + uvolnění místa

- [ ] `DROP INDEX idx_meas_ts_metric;` / `idx_meas_device_ts;`
- [ ] `DROP TABLE measurements;`
- [ ] `meta.eav_migration_status=dropped`
- [ ] `VACUUM` nebo `PRAGMA incremental_vacuum` — **off-peak**; `VACUUM` přepíše celý soubor a krátce zamyká DB.

### 6.7 Rollback

| Stav | Postup |
|------|--------|
| Před dropem EAV | Přepnout read+ingest zpět na `measurements`; wide tabulky nechat / dropnout |
| Po dropu | Obnovit ze zálohy `.backup` z 6.1; znovu nasadit předchozí verzi aplikace |
| Po rollupu cold | 1 Hz rozlišení starších dat jen ze zálohy (cold nestačí na návrat) |

**Pravidlo:** zálohu mazat nejdřív po N dnech stabilního provozu (doporučení: ≥ 7 dní).

### 6.8 Pořadí deploye

1. Nasadit verzi umějící **schema + migrace + dual read/write** (feature flag / `MIGRATE_EAV_ON_STARTUP`).
2. Nechat doběhnout migraci (sledovat `eav_migration_status`, velikost DB, log).
3. Verify skript.
4. Zapnout archive job (nebo default on).
5. Po stabilitě: drop EAV (může být další malý release / admin endpoint chráněný heslem).
6. Off-peak VACUUM.

ESP flash **není** potřeba.

---

## 7. Dopad na kód (orientační mapa)

| Oblast | Soubor | Práce |
|--------|--------|-------|
| Schema / migrate / prune / archive job | `backend/app/main.py` (příp. nový `storage.py`) | hlavní |
| Ingest upsert | `main.py` `ingest` | střední |
| History / spectrum read | `main.py` | střední |
| Env příklad | `.env.example` | dokumentace defaultů |
| Verify skript | `scripts/verify_eav_migration.py` | nový |
| README retence | `README.md` | krátká zmínka |

UI (`app.js`) — bez povinných změn. Volitelně badge „archiv 5 s“ když `end < now - hot` a data jdou z cold.

---

## 8. Test plan

- [ ] Unit: energy average bucket (známé dB → očekávaný průměr).
- [ ] Unit: legacy 10pásmový ingest → správné sloupce + NULL.
- [ ] Integrace: ingest 20 s → 20 řádků `samples_1s`, ne 400 EAV.
- [ ] Integrace: rollup 10 s @ 5 s interval → 2 cold řádky, hot smazán pod cutoff.
- [ ] Migrace na kopii produkční DB: verify skript green.
- [ ] API diff: `history` + `spectrum/history` + `spectrum/at` + `latest` na stejných timestamps.
- [ ] Zátěž: ingest 1 Hz během běžící migrace (žádný timeout &gt; pár s).
- [ ] Disk: po drop + VACUUM velikost DB v očekávaném řádu.
- [ ] Restart mid-migration: kurzor pokračuje, bez duplicit / mezer.

---

## 9. Otevřené volby (ke schválení)

| # | Otázka | Doporučení |
|---|--------|------------|
| 1 | `HOT_RETENTION_HOURS`: 48 vs 168? | **48** (menší disk; spektrogram detail jen 2 dny, dál 5 s) |
| 2 | `ARCHIVE_INTERVAL_S`: 5 vs 10? | **5** (lepší spektrogram v archivu; pořád ~5× úspora času) |
| 3 | uint16 BLOB v1? | **Ne** — REAL wide stačí; BLOB jako v2 |
| 4 | Drop EAV automaticky po verify? | **Ne** — explicitní krok / admin, ať je záloha ověřená |
| 5 | `VACUUM` automaticky? | **Ne** default — ručně off-peak |
| 6 | Oddělit `storage.py`? | Ano, pokud `main.py` dál bobtná; jinak OK nechat |

---

## 10. Implementační checklist (po schválení)

1. [x] Schválit volby §9.
2. [x] Implementovat schema + upsert ingest + read helpers.
3. [x] Restartovatelná EAV→wide migrace + meta status.
4. [x] Verify skript.
5. [x] Archive job + periodický prune.
6. [x] Deploy na produkci se zálohou; sledovat migraci.
7. [x] Verify; zapnout hot/cold rollup.
8. [ ] Po stabilitě drop `measurements` + off-peak VACUUM (`POST /api/admin/storage/drop-eav`, `…/vacuum`).
9. [x] Aktualizovat README / `.env.example`; stav specifikace → `implemented`.

---

## 11. Rizika

| Riziko | Mitigace |
|--------|----------|
| Poškození / ztráta při migraci | `.backup`, verify, drop až pozdě |
| Dlouhý lock SQLite | malé chunky, timeout připojení už 30 s |
| Dvojí zápis / mezera na cutoveru | dojetí migrace po přepnutí ingestu; verify min/max ts |
| Rollup před verify | rollup až po `verified` |
| Nárůst DB během migrace (EAV+wide) | volné místo 2×; po dropu VACUUM |
| UI očekává 1 Hz i ve starém okně | 5 s je stále hustší než display `max_columns` (typicky 360–480 sloupců / okno) |

---

## 12. Shrnutí pro schválení

Provést **wide `samples_1s` + cold `samples_5s` (5 s) + `samples_minute`**, s **online chunkovanou migrací** ze stávající EAV tabulky, **verifikací**, teprve poté dropem a rollupem. Historie ani spektrogram se nemažou — u starších dat se jen sníží časové rozlišení z 1 s na 5 s po schváleném rollupu.
