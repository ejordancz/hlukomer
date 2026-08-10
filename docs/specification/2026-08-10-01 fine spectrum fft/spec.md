# Přechod BETA spektra 190–270 Hz z IIR na skutečné FFT

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/specification/2026-08-10-01 fine spectrum fft` |
| **Datum** | 2026-08-10 |
| **Stav** | `implemented` |
| **Autor** | agent |
| **Související** | ESP `esphome/hlukomer.yaml` (FINE blok), ingest `spectrum_fine`, DB `fine_*`, `GET /api/v1/spectrum/fine/history`, UI přepínač High-res FFT 190–270 Hz (Beta) |

## 0. Verdikt

| Otázka | Odpověď |
|--------|---------|
| Co se mění? | Jen **druhý (BETA) spektrogram** 190–270 Hz: místo 17 IIR pásem **skutečná FFT** |
| Co se **nemění**? | Hlavní spektrogram (1/3-oktáva + oktávy), LAeq/LZeq/LFI/HVAC, hlavní `spectrum[]` |
| Frekvence | **Δf = 1 Hz**, 81 binů (190…270) |
| Časové ukládání | **1 záznam / 3 s** (energy average z až 3 jednosekundových FFT) |
| UI titulek | **High-res FFT 190–270 Hz** + tag **Beta** (default OFF) |
| Úložiště | Oddělená tabulka + **kompaktní binární blob** (ne JSON text, ne 81 wide sloupců) |
| Stará IIR fine data | **Zahodit bez náhrady** — data i DB struktura (`fine_*`), žádná migrace / legacy čtení |

---

## 1. Cíl

Nahradit experimentální jemné spektrum (SOS IIR) **pravou FFT** v pásmu 190–270 Hz ve stávajícím druhém spektrogramu.

Hlavní spektrogram zůstává beze změny.

**Stará IIR data 190–270 Hz se nemigrují:** při nasazení se zahodí hodnoty i sloupce; historie BETA grafu začíná znovu od FFT.

---

## 2. Rozsah (in / out)

### In scope

- ESP: FFT z I2S PCM @ 48 kHz → 81 binů dB
- Ingest jen fine FFT (řidší než 1 Hz live)
- DB: úsporná tabulka `spectrum_fine_3s`
- API: `GET /api/v1/spectrum/fine/history`
- UI: přejmenování + tip FFT; heatmapa 81 řádků
- Odstranění IIR fine filtrů / generátoru
- **Hard drop** starých `fine_*` dat a sloupců ve `samples_1s` / `samples_5s` (bez zálohy, bez přepočtu)

### Out of scope

- Hlavní `spectrum[]`, `/spectrum/history`, HVAC/LFI
- Full-band FFT
- Zachování / export / přepočet staré IIR fine historie
- Odstranění tagu Beta

---

## 3. Současný stav (baseline)

```
ICS-43434 @ 48 kHz
  → 17× SOS IIR (190…270, bw 5 Hz)
  → spectrum_fine[17] dB / 1 s  →  wide fine_* ve samples_1s
  → BETA heatmapa
```

Problém: IIR ≠ ostré 1 Hz; při přechodu na 81 binů / 1 s by data zbytečně narostla.

---

## 4. Cílové DSP (normativní)

### 4.1 Parametry — **rozhodnuto**

| Parametr | Hodnota | Poznámka |
|----------|---------|----------|
| `fs` | 48 000 Hz | stávající mikrofon |
| Okno | Hann, `N = 48 000` | **Δf = 1 Hz** (1,0 s audio na jednu FFT) |
| Výpočet na ESP | **1 FFT / s** | potřeba pro Δf = 1 Hz a hladký energy average |
| Odeslání / zápis | **1× za 3 s** | energy average z 3 po sobě jdoucích výkonových spekter |
| Pásmo | 190 … 270 Hz | 81 binů |
| Overlap | **ne** (MVP) | stačí non-overlap 1 s okna; méně CPU |
| A-vážení | ne (Z / SPL) | jako dnešní fine / hlavní spektrum |

**Proč počítat každou 1 s, ale ukládat po 3 s:**  
Frekvenční rozlišení určuje délka okna (`N/fs`), ne interval ukládání. Uložený sloupec heatmapy = průměr výkonu za 3 s, pořád s biny po 1 Hz. Časová osa je hrubší (sloupec ≈ 3 s), frekvence zůstává jemná.

### 4.2 Fallback jen při OOM/CPU na ESP

| Varianta | Kdy |
|----------|-----|
| **A (cíl)** N=48k, Δf=1 Hz | default |
| C N=24k, Δf=2 Hz | jen když A nejede stabilně |
| B Δf=5 Hz | nouzově; **nechtěné** (ztráta 1 Hz) |

### 4.3 Mapování bin → dB

1. `k = round(f * N / fs)`, `P = |X[k]|²`
2. Přes 3 s: `P_avg[k] = (P1+P2+P3)/3` (chybějící frame = průměr z dostupných)
3. `dB = 10·log10(P_avg) + kalibrace` (ICS EQ ve frekvenční oblasti preferována)
4. Výstup 81× dB, 1 desetinné místo **před** kompresí do blobu (nebo rovnou kvantizace — §5.2)

### 4.4 ICS EQ

Preferováno: korekce binů 190–270 ve frekvenci. Hlavní SLM řetězec neměnit.

---

## 5. Úložiště a velikost (priorita: málo místa)

### 5.1 Proč ne „81 hodnot každou 1 s v JSON u samples_1s“

Orientačně (jeden den, jedno zařízení):

| Varianta | Záznamů / den | Payload / záznam | Hrubý odhad |
|----------|---------------|------------------|-------------|
| Dnes IIR wide 17× float / 1 s | 86 400 | ~17×4 B + overhead | ~jednotky MB + indexy |
| Naivně 81× JSON text / 1 s | 86 400 | ~400–800 B text | **desítky MB / den** |
| **Cíl: packed blob / 3 s** | **28 800** | **81 B** | **≈ 2,3 MB / den** raw |

Cíl je řádově **blízko nebo pod** dnešní IIR fine stopu, při 81× lepším frekvenčním rozlišení.

### 5.2 Formát záznamu — **rozhodnuto**

Oddělená tabulka (ne sloupec ve `samples_1s`):

```sql
CREATE TABLE spectrum_fine_3s (
  device_id TEXT NOT NULL,
  ts        REAL NOT NULL,   -- unix začátek 3s bucketu (např. floor(t/3)*3)
  n_bins    INTEGER NOT NULL DEFAULT 81,
  f0_hz     REAL NOT NULL DEFAULT 190,
  df_hz     REAL NOT NULL DEFAULT 1,
  -- packed: 81 × uint8, dB = db0 + u8 * 0.5  (rozsah db0 .. db0+127.5)
  db0       REAL NOT NULL DEFAULT 0,   -- offset kvantizace (např. 0)
  payload   BLOB NOT NULL,            -- přesně n_bins bytů
  PRIMARY KEY (device_id, ts)
);
```

**Kvantizace:** `u8 = clamp(round((dB - db0) / 0.5), 0, 255)` → krok **0.5 dB**, rozsah 128 dB při `db0` pevném (doporučení: `db0 = 0`, platné ~0…127.5 dB SPL; případně `db0 = -10` podle kalibrace).

Pro heatmapu 0.5 dB stačí; frekvence zůstává 1 Hz.

**Nepoužívat:** JSON text, 81 SQL sloupců, ukládání fine do každého `samples_1s`.

### 5.2a Zahození původní IIR struktury — **rozhodnuto**

Při migraci schématu (jednorázově při startu aplikace / deploy):

1. **Zahodit data** ve sloupcích `fine_190` … `fine_270` — není potřeba je číst, exportovat ani mapovat na FFT.
2. **Odstranit DB strukturu** těchto sloupců z `samples_1s` i `samples_5s` (SQLite: recreate table bez `fine_*`, nebo ekvivalentní migrace; `ALTER … DROP COLUMN` pokud verze dovolí).
3. Odstranit z kódu: `FINE_SPECTRUM_*` wide konstanty vázané na IIR, `LIVE_VALUE_COLS` položky `fine_*`, zápis `spectrum_fine` do wide ingestu, validaci délky 17 pro starý tvar.
4. Žádný fallback „když JSON chybí, čti fine_*“. API fine history čte **jen** `spectrum_fine_3s`.
5. Po dropu uvolnit místo: `VACUUM` (off-peak / admin endpoint, dle stávající praxe).

Hlavní `oct_*` a ostatní live metriky **nesmí** být touto migrací poškozeny.

### 5.3 Retence

| Vrstva | Interval | Retence (návrh) |
|--------|----------|-----------------|
| Fine FFT | 3 s | stejné jako cold hlavní historie, default **`RETENTION_DAYS`** (90), **bez** hot 1s duplikace |
| Hlavní live | 1 s → 5 s archive | beze změny |

Fine data **nevstupují** do `samples_1s` / hot rollupu. Žádný second copy.

Volitelně později: po N dnech downsample 3 s → 15 s energy-avg (stejný blob formát) — **ne v MVP**.

### 5.4 Ingest kontrakt

ESP (nebo bridge) pošle **nejvýš 1× / 3 s** (ne v každém `laeq_1s` POST):

```json
{
  "device_id": "hlukomer",
  "kind": "spectrum_fine",
  "ts": 1710000000.0,
  "spectrum_fine": [ /* 81 float dB, nebo rovnou base64 blob */ ],
  "spectrum_fine_meta": {
    "kind": "fft",
    "f0_hz": 190,
    "f1_hz": 270,
    "df_hz": 1.0,
    "n_fft": 48000,
    "window": "hann",
    "integrate_s": 3
  }
}
```

Pravidla:

- Oddělený `kind: "spectrum_fine"` **nebo** volitelné pole jen každým 3. live POSTem — preferováno **oddělený kind**, ať live 1s payload nezůstane velký.
- Backend zvaliduje délku 81, zkvantizuje do BLOB, `INSERT OR REPLACE` do `spectrum_fine_3s`.
- Hlavní `kind: "live"` **bez** `spectrum_fine` (po migraci).
- Ingest se starým `spectrum_fine` délky 17: **odmítnout** (400) nebo ignorovat pole — preferováno **ignorovat + log**, ať starý firmware nerozbije LAeq ingest; po flashi ESP pole nepřijde.

### 5.5 API

`GET /api/v1/spectrum/fine/history` — beze změny query parametrů; čte `spectrum_fine_3s`, dekvantizuje.

| Pole | Hodnota |
|------|---------|
| `bands` / `hz` | 190…270 (81) |
| `bandwidth_hz` / `df_hz` | `1.0` |
| `integrate_s` | `3` |
| `kind` | `"fft"` |
| `note` | High-res FFT 1 Hz, sloupec = 3 s energy average |
| `columns[].v` | `number[81]` (float dB po dekvantizaci) |
| `columns[].t` | střed nebo začátek 3s bucketu (dokumentovat jedno; doporučení: **střed** `ts + 1.5`) |

Downsample v API (`max_columns`) dál platí — energy avg přes více 3s sloupců.

---

## 6. UI

| Prvek | Text |
|-------|------|
| Titulek přepínače | **High-res FFT 190–270 Hz** |
| Tag | **Beta** (ponechat) |
| Tip | Zobrazí spektrogram 190–270 Hz po 1 Hz (skutečná FFT). Sloupec ≈ 3 s. Experimentální — vyšší zátěž ESP. |
| Default | vypnuto |
| Y labely | po 10 Hz; hover = přesný bin (např. 237 Hz) |
| Výška stripu | o něco vyšší než hlavní (81 řádků), labely ne na každý bin |

LS klíč `hlk.corr.fineSpectrum` může zůstat (stav přepínače).

---

## 7. Architektura ESP

### 7.1 Odstranit

Blok `# === FINE 5Hz 190-270 BEGIN/END ===` (filtry, senzory, ingest `spectrum_fine` v live POST).

### 7.2 Přidat

Komponenta `fine_fft`:

1. Ring buffer ≥ 48k sample.
2. Každou 1 s: Hann → FFT → výkon binů 190–270 → přičíst do akumulátoru.
3. Každé 3 s: průměr → dB → HTTP POST `kind=spectrum_fine`.
4. Vlastní task (neblokovat SLM).

### 7.3 Integrace se SLM

Preferováno: jeden I2S stream + tee/callback do FFT. Hlavní LAeq beze změny.

### 7.4 CPU / RAM

- N=48k: měřit čas a heap; při problému nejdřív zmenšit frekvenci POST (už 3 s), ne Δf.
- int16 PCM + in-place FFT, pokud float nevejde.

---

## 8. Fáze implementace

### Fáze 0

- [x] Δf = 1 Hz
- [x] Ukládání 3 s + packed blob
- [x] Titulek High-res FFT + Beta
- [x] Bez overlap v MVP
- [ ] Ověřit PCM přístup bez rozbití LAeq

### Fáze 1 — Backend

- [ ] Tabulka `spectrum_fine_3s` + kvantizace
- [ ] Ingest `kind=spectrum_fine`
- [ ] `fine/history` **jen** z `spectrum_fine_3s`
- [ ] Migrace: **drop** sloupců `fine_190`…`fine_270` (+ data) z `samples_1s` / `samples_5s`; vyčistit `LIVE_VALUE_COLS` / konstanty; off-peak `VACUUM`
- [ ] Žádný legacy read path pro IIR fine

### Fáze 2 — ESP

- [ ] FFT prototyp + 3 s average + POST
- [ ] Odstranění IIR fine bloku z YAML
- [ ] 24 h stabilita

### Fáze 3 — UI

- [ ] Titulek / tip
- [ ] Heatmapa 81 × 3 s sloupce
- [ ] Hover bin

### Fáze 4 — Úklid

- [ ] Smazat / přestat generovat fine IIR v `generate_spectrum_filters.py` + fragment YAML
- [ ] README: hlavní = IIR; druhý graf = FFT Beta; stará fine IIR historie neexistuje
- [ ] Beta tag zůstává

---

## 9. Akceptační kritéria

1. Hlavní spektrogram / LAeq / HVAC beze změny.
2. Fine: 81 binů, Δf = 1 Hz, záznamy po ≈ 3 s.
3. Velikost: řádově ≤ ~3 MB raw blobů / den (bez index overhead), ne desítky MB JSON.
4. Tón ~250 Hz → úzká čára na správném binu (±1 Hz).
5. Přepínač „High-res FFT 190–270 Hz“ + Beta, default OFF.
6. 24 h bez leaků / restart smyčky.

---

## 10. Rizika a mitigace

| Riziko | Mitigace |
|--------|----------|
| Málo RAM na N=48k | int16, in-place; krajně Δf=2 Hz |
| FFT vs SLM | oddělený task |
| 3 s „rozmaže“ krátké peaky | OK pro VZT tón; LAeq 1s zůstává jinde |
| Kvantizace 0.5 dB | pro heatmap OK; při potřebě int16 tenths (162 B) |
| Ztráta staré fine historie | **Akceptováno** — hard drop bez náhrady |

---

## 11. Rozhodnutí (dříve „otevřené otázky“)

Vysvětlení jednoduše + **závazná odpověď**:

| # | Otázka lidsky | Rozhodnutí |
|---|---------------|------------|
| 1 | **Jak jemné frekvence?** 1 Hz = 81 „řádků“ heatmapy (190, 191, …). 5 Hz = jen 17 řádků jako dnes, ale pořád ostřejší než IIR. | **1 Hz (81 binů).** To je smysl high-res. |
| 2 | **Jak ukládat?** JSON je čitelný, ale nafukuje DB. „Blob“ = binární balíček 81 čísel v jednom poli. | **Kompaktní BLOB v tabulce `spectrum_fine_3s`**, ne JSON, ne wide sloupce. |
| 3 | **Jak pojmenovat přepínač?** | Titulek **High-res FFT 190–270 Hz**, tag **Beta** ponechat. |
| 4 | **Overlap?** Počítat FFT z překrývajících se oken (víc práce, hladší čas). | **Ne v MVP** — 1 s okna bez překryvu, average do 3 s záznamu. |

**Úspora místa (shrnutí):** rozlišení 1 Hz držíme; šetříme **časovou hustotou** (3 s) + **binární kvantizací** (81 B/záznam) + **oddělením od 1s live tabulky**.

---

## 12. Explicitní non-goals

- Neměnit hlavní 1/3-oktávový spektrogram.
- Nedělat full-band FFT.
- **Nezachovávat** starou IIR fine historii ani `fine_*` sloupce (drop bez migrace hodnot).
- Neodstraňovat Beta tag.
- Neukládat fine FFT každou 1 s.
