# Nastavení — přepínače z Hero do panelu

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/specification/2026-07-28-01 nastaveni` |
| **Datum** | 2026-07-28 |
| **Stav** | `implemented` (UI polish: přístrojový FAB + animovaný panel) |
| **Autor** | agent |
| **Související** | `2026-07-26-01 korekce okna a tonalni penalizace`, dashboard `backend/app/static/{index.html,app.js,style.css}` |

## 0. Verdikt (shrnutí)

| Otázka | Odpověď |
|--------|---------|
| Problém? | Tři display přepínače jsou jen v Hero (`position: absolute` header) — po scrollu dolů je nelze přepnout |
| Co se mění? | Přepínače pryč z Hero; **fixní ikona ozubeného kola** vpravo dole → panel **Nastavení** se třemi přepínači |
| Logika korekcí / `localStorage`? | **Beze změny** — jen přesun UI |
| API / DB? | **Nemění se** |

---

## 1. Cíl

Zpřístupnit tři display-only přepínače odkudkoli na stránce (včetně historie pod Hero), aniž by clutterovaly Hero.

1. Odebrat přepínače z headeru Hero.
2. Přidat fixní tlačítko s ikonou ozubeného kola (vpravo dole).
3. Po kliknutí otevřít panel Nastavení se stejnými třemi přepínači (včetně tipů a persist).

---

## 2. Kontext

### Současný stav

- Header `.top` je `position: absolute` nad Hero → po scrollu zmizí.
- Tři přepínače v `.display-toggles`: okno, tón, limit frekvencí.
- Stav a výpočty: `state.display`, `localStorage` (`hlk.corr.*`), `setDisplayToggle` / `syncDisplayToggleUi`.

### Co se nemění

- Význam a defaulty přepínačů (okno ON, tón OFF, limitFreq OFF)
- Tip texty / long-press / hover
- `localStorage` klíče a `__DISPLAY_CONFIG`
- API, DB, ingest, admin
- Online/Offline status v headeru zůstává

---

## 3. Požadavky

### Funkční

- [x] Přepínače **nejsou** v Hero headeru.
- [x] Fixní tlačítko (FAB) vpravo dole: ikona ozubeného kola (`mdi-cog`).
- [x] Klik / Enter / Space na FAB → otevře panel Nastavení.
- [x] Panel obsahuje stejné tři přepínače (label + pill switch + tip).
- [x] Přepnutí okamžitě přerenderuje (stávající `setDisplayToggle`).
- [x] Zavření: tlačítko ×, Escape, klik na backdrop / mimo panel.
- [x] FAB dostupný na mobilu i desktopu při scrollu (fixed).

### Nefunkční / a11y

- [x] `aria-expanded` na FAB; panel `role="dialog"` + `aria-modal="true"` + `aria-labelledby`.
- [x] Focus na zavření / Escape; `role="switch"` na přepínačích zachován.
- [x] Z-index nad grafem a tipy, pod případnými kritickými overlayi.

---

## 4. UI

### FAB

```
┌─────────────────────────────┐
│  (stránka / graf)           │
│                        [⚙]  │  ← fixed, bottom-right
└─────────────────────────────┘
```

- Pozice: `position: fixed; right: ~1.25rem; bottom: ~1.25rem`
- Kruhové tlačítko, ikona `mdi mdi-cog`
- `aria-label="Nastavení"`, `aria-controls="settingsPanel"`, `aria-expanded`
- Při otevřeném panelu vizuálně aktivní (např. `is-open`)

### Panel Nastavení

```
┌──────────────────────────────┐
│ Nastavení                 ×  │
├──────────────────────────────┤
│ [●] Korekce měření u okna    │
│ [ ] Penalizace za tónový hluk│
│ [●] Limit jen 25/200/250 Hz  │
└──────────────────────────────┘
                         [⚙]
```

- Desktop: panel kotvený nad FAB (bottom-right), max-width ~22rem
- Mobil: stejné kotvení; tipy uvnitř panelu (scroll pokud třeba)
- Backdrop poloprůhledný (klik = zavřít)
- Vertikální stack přepínačů (stejný markup `.display-toggle`)

### Hero po změně

```
[ brand ]                              ● online
```

Žádné přepínače v `.top-right`.

---

## 5. Architektura FE

```text
#settingsFab          → open/close
#settingsBackdrop     → close
#settingsPanel        → dialog s #displayToggles
bindSettingsPanel()   → Escape, outside, aria-expanded
bindDisplayToggles()  → beze změny logiky (selektor .display-toggle)
```

Soubory: `index.html`, `style.css`, `app.js` (cache-bust `?v=`).

---

## 6. Test plan

- [ ] Hero nemá tři přepínače; status Online/Offline zůstává.
- [ ] FAB vždy viditelný (scroll Hero → Historie).
- [ ] Otevření: panel + backdrop; zavření × / Escape / backdrop.
- [ ] Přepnutí okna/tón/limitFreq funguje stejně jako dřív (včetně tipů).
- [ ] Persist po reloadu.
- [ ] Klávesnice: FAB, switchy, Escape.

---

## 7. Mimo scope

- Nové položky nastavení (jen přesun stávajících tří)
- Změna výpočtů korekcí / limitů
- Backend / API
