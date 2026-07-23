# Počasí — provider, API a ikony (referenční popis)

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/2026-07-23-01 pocasi provider dokumentace` |
| **Datum** | 2026-07-23 |
| **Stav** | `implemented` (popis stávajícího chování) |
| **Zdroj v kódu** | `src/server/weatherService.ts`, `src/client/weatherDisplay.ts` |

Stručný popis integrace počasí v Hawaii pro přenos do jiného projektu.

---

## 1. Provider

**MET Norway / yr.no** — Locationforecast 2.0 (compact).

- Oficiální dokumentace: https://api.met.no/weatherapi/locationforecast/2.0/documentation
- Podmínky použití: https://api.met.no/doc/TermsOfService  
  (povinný identifikující `User-Agent`, respektovat cache/`Expires`, souřadnice na 4 desetinná místa)

Interní identifikátor providera v aplikaci: `'yr.no'`.

---

## 2. Konfigurace

| Položka | Povinné? | Popis |
|---------|----------|--------|
| **API key** | Ne | MET Norway API klíč nevyžaduje. |
| **`YR_USER_AGENT`** | Doporučeno | Env proměnná s identifikací klienta. Bez ní se použije výchozí string ve stylu `hawaii/X.Y.Z (https://github.com/…)`. |
| **Souřadnice** | Ano | `lat`, `lon` (aplikace je zaokrouhlí na 4 desetinná místa). |

Příklad:

```bash
YR_USER_AGENT=moje-app/1.0.0 (https://example.com; kontakt@example.com)
```

---

## 3. Volané API

### Request

```
GET https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={lat}&lon={lon}
```

**Headers:**

```
User-Agent: <YR_USER_AGENT nebo výchozí>
```

### Relevantní části odpovědi

Kořen: `properties.timeseries[]`. Každý záznam:

| Cesta | Význam |
|-------|--------|
| `time` | ISO čas slotu |
| `data.instant.details.air_temperature` | Teplota (°C) |
| `data.instant.details.relative_humidity` | Vlhkost (%) |
| `data.instant.details.air_pressure_at_sea_level` | Tlak (hPa) |
| `data.next_1_hours.summary.symbol_code` | Symbol počasí (preferovaný) |
| `data.next_6_hours.summary.symbol_code` | Symbol počasí (fallback / denní agregace) |
| `data.next_1_hours.details.precipitation_amount` | Srážky za 1 h (mm) |

**Cache:** hlavička `Expires` z odpovědi; při chybě/minulém datu fallback ≈ 1 hodina. Hawaii ukládá výsledek lokálně (SQLite).

### Co aplikace skládá ze timeseries

- **current** — nejbližší budoucí/aktuální slot: teplota, icon (`next_1_hours` → `next_6_hours`), vlhkost, tlak  
- **today / upcoming days** — den (6–18 h) max. teplota + icon z `next_6_hours`; noc (&lt;6 / ≥18) min. teplota + icon  
- **hourlyTimeline** — ~48 hodin od aktuální hodiny

---

## 4. Ikony a párování se `symbol_code`

API vrací stringy typu `clearsky_day`, `partlycloudy_night`, `rain`, `lightsnow`, …  
Hawaii **nepoužívá oficiální SVG z yr.no**, ale mapuje `symbol_code` na **Material Design Icons (MDI)** podle podřetězců (case-insensitive).

Logika (pořadí podmínek má význam):

| Podmínka na `symbol_code` | MDI třída | Výchozí barva | CZ popis |
|--------------------------|-----------|---------------|----------|
| `clearsky` nebo `fair` | `mdi-weather-sunny` | `#eab308` | Jasno |
| `cloudy` (bez `partly`) | `mdi-weather-cloudy` | `#64748b` | Zataženo |
| `partly` | `mdi-weather-partly-cloudy` | `#38bdf8` | Polojasno |
| `rain` nebo `drizzle` | `mdi-weather-rainy` | `#0ea5e9` | Déšť |
| `snow` | `mdi-weather-snowy` | `#e0f2fe` | Sníh |
| `fog` nebo `mist` | `mdi-weather-fog` | `#94a3b8` | Mlha |
| `night` (pokud nic výše) | `mdi-weather-night-partly-cloudy` | `#1e3a5f` | (bez zvláštního popisu) |
| jinak / `null` | `mdi-weather-partly-cloudy` | `#38bdf8` | Oblačno / — |

Implementace: `weatherIconClass()` / `weatherDescription()` v `src/client/weatherDisplay.ts`.

### Poznámky k mapování

- Suffixy `_day` / `_night` u symbolů většinou „spolkne“ dřívější větev (`clearsky`, `partly`, …); větev `night` se uplatní jen u symbolů, které obsahují `night` a nepasují na jasno/oblačnost/srážky.
- `sleet`, `heavysnow`, `heavyrain` mají v popisu speciální větev „Srážky“, ale u ikon často spadnou pod `rain`/`snow` podle podřetězce, jinak default.
- Thunderstorm (`thunder*`) není samostatně ošetřen → default `mdi-weather-partly-cloudy`.

Pro přesnější UI lze místo MDI použít [oficiální weather icons MET Norway](https://github.com/metno/weathericons) 1:1 podle `symbol_code`.

---

## 5. Minimální ukázka volání

```ts
const lat = Number(coords.lat.toFixed(4));
const lon = Number(coords.lon.toFixed(4));
const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;

const res = await fetch(url, {
  headers: {
    'User-Agent': process.env.YR_USER_AGENT ?? 'my-app/1.0.0 (https://example.com)'
  }
});
if (!res.ok) throw new Error(`met.no ${res.status}`);
const json = await res.json();
const symbol =
  json.properties.timeseries[0]?.data?.next_1_hours?.summary?.symbol_code
  ?? json.properties.timeseries[0]?.data?.next_6_hours?.summary?.symbol_code
  ?? null;
```

---

## Historie

| Datum | Změna |
|-------|--------|
| 2026-07-23 | Vytvořen referenční popis stávající integrace yr.no / met.no |
