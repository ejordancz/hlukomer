# Korekce měření u okna a penalizace za tónový hluk (jen zobrazení)

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/specification/2026-07-26-01 korekce okna a tonalni penalizace` |
| **Datum** | 2026-07-26 |
| **Stav** | `implemented` |
| **Autor** | agent |
| **Související** | dashboard `backend/app/static/{index.html,app.js,style.css}`, `GET /api/v1/latest`, `GET /api/v1/history`, `GET /api/v1/spectrum/history`, limity `ALERT_*` |

## 0. Verdikt (shrnutí)

| Otázka | Odpověď |
|--------|---------|
| Co se přidá? | Dva přepínače vpravo nahoře (u Online/Offline): korekce u okna (−3 dB od hodnot) a penalizace za tón (−5 dB limitu) |
| Default | Korekce okna **zapnutá**; tónová penalizace **vypnutá**; stav v `localStorage` |
| API / DB / ingest? | **Nemění se.** Žádný výpočet ani ukládání tónové složky |
| Odkud čísla 3 / 5? | `.env` → `window.__DISPLAY_CONFIG` při servírování HTML |
| Limity den/noc? | Korekce okna limity **neovlivní**. Tónový přepínač **vždy** (bez detekce) sníží zobrazený limit o 5 dB |
| Detekce tónu? | **Neprobíhá** — ani FE, ani BE, ani DB |

---

## 1. Cíl

Dvě **display-only** korekce na dashboardu:

1. **Korekce měření u okna** — odečte od naměřených hodnot offset (default 3 dB).
2. **Penalizace za tónový hluk** — pokud je přepínač zapnutý, **plošně** sníží zobrazené hygienické limity o 5 dB. Uživatel sám rozhodne, zda penalizaci uplatnit; systém tón nevyhodnocuje.

Surová data v DB a API zůstávají beze změny.

---

## 2. Kontext

### Co se nemění

- ESP firmware / ingest / SQLite / retence
- Tvar JSON API
- Hodnoty `ALERT_*` na backendu (den/noc)
- Admin

---

## 3. Požadavky

### Funkční

- [x] Dva přepínače u Online/Offline, design pill switch dle přílohy.
- [x] Default: okno **ON**, tón **OFF**; persist `localStorage`.
- [x] Info text po najetí / long-press nad přepínačem.
- [x] Offsety z `.env` → `__DISPLAY_CONFIG`.
- [x] Korekce okna poníží všechny zobrazené naměřené dB (live, spektrum, stats, graf, spektrogram).
- [x] Korekce okna neovlivní limity.
- [x] Tónový přepínač ON → zobrazený limit = raw limit − `DISPLAY_TONAL_PENALTY_DB` **všude a vždy** (live, graf, stats „nad limitem“).
- [x] Žádná detekce tónu, žádné markery tónu ve spektrogramu, žádný sloupec v DB.
- [x] Přepnutí okamžitě přerenderuje z cache raw dat.

### Nefunkční

- [x] Žádná změna API/DB.
- [x] Mobilní layout + long-press tip.
- [x] `role="switch"`, klávesnice.

---

## 4. UI přepínačů

### Umístění

```
[ brand ]                    [ switch 1 ] [ switch 2 ]  ● online
```

### Design

Zapnuto: světle modrý track (~`#4A90D9`), bílý thumb vpravo. Vypnuto: šedý track, thumb vlevo.

### Info text (hover nad switchem)

| ID | Titulek | Info (hover) | Default |
|----|---------|--------------|---------|
| `corr-window` | Korekce měření u okna | Odečte od naměřených hodnot 3 dB. Zvuk přímo u zdi je silnější kvůli odrazu od skla a fasády. Tímto získáte reálnou hladinu hluku ve volném prostoru 2 metry před oknem. | ON |
| `corr-tonal` | Aplikovat penalizaci za tónový hluk | Sníží hygienické limity o 5 dB. Zapněte, pokud hluk obsahuje výrazný otravný tón (např. hučení na jedné frekvenci z větrání či čerpadla). | OFF |

Čísla dB v textech z configu.

### Persist

| Klíč | Default |
|------|---------|
| `hlk.corr.window` | `"1"` (ON) |
| `hlk.corr.tonal` | `"0"` (OFF) |

---

## 5. Konfigurace

```env
DISPLAY_WINDOW_CORRECTION_DB=3
DISPLAY_TONAL_PENALTY_DB=5
```

Injekce do HTML:

```js
window.__DISPLAY_CONFIG = { window_correction_db: 3, tonal_penalty_db: 5 };
```

---

## 6. Přepínač 1 — Korekce u okna

```
display_level = raw − (window_on ? WINDOW_DB : 0)
```

Dotčené: live LAeq, nad/pod limitem (delta), celková hladina, LFI, dominantní dB, spektrum, stats, graf (metric), spektrogram, tooltips.

**Bez vlivu:** limity den/noc, weather, přelety, DB.

---

## 7. Přepínač 2 — Penalizace za tónový hluk

```
display_limit = raw_limit − (tonal_on ? TONAL_DB : 0)
```

**Bez detekce.** Zapnutý přepínač = limity všude o 5 dB níž (live threshold, `threshold_points` v grafu, stats „nad limitem %“).

Live subtext např. `40 dBA (noc, tón −5)` když je přepínač ON.

**Bez vlivu:** naměřené křivky (kromě window korekce), DB, API, spektrogram markery.

### Kombinace

```
display_level = raw_level − (window_on ? WINDOW_DB : 0)
display_limit = raw_limit − (tonal_on ? TONAL_DB : 0)
over_limit    = display_level > display_limit
```

---

## 8. Architektura FE

```text
state.display = { windowCorr, tonalPenalty, windowDb, tonalDb }
applyWindow(v)
effectiveLimit(raw) → raw − (tonalPenalty ? tonalDb : 0)
```

Cache raw API (`lastLatest`, `lastHistory`); při přepnutí přerenderovat.

Soubory: `index.html`, `style.css`, `app.js`, injekce v `main.py`, `.env` / compose.

---

## 9. Test plan

- [ ] Default: okno ON, tón OFF.
- [ ] Tón ON: limit všude −5 (live, graf, stats); žádné spektrální markery.
- [ ] Tón OFF: limity = raw z API.
- [ ] Okno OFF: hodnoty = raw.
- [ ] Kombinace ON+ON: level −3, limit −5.
- [ ] API/DB beze změny.
- [ ] Hover / long-press info.

---

## 10. Mimo scope

- Detekce tónové složky (FE/BE/DB)
- Změna API / alertů na backendu
- ČSN ISO 1996-2
