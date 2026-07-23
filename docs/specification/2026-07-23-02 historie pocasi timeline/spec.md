# Historie počasí pod grafem (timeline)

| Pole | Hodnota |
|------|---------|
| **Adresář** | `docs/specification/2026-07-23-02 historie pocasi timeline` |
| **Datum** | 2026-07-23 |
| **Stav** | `implemented` |
| **Navazuje na** | `2026-07-23-01 pocasi pod grafem a sunrise` |

## 1. Cíl

Pod grafem hlasitosti zobrazit **historické** počasí v intervalech (jak tehdy bylo), ne jen aktuální stav. Aktuální detail jako drobný doplňkový sloupec (malé ikony/texty).

## 2. Návrh

- Každý fetch Locationforecast uloží všechny hodinové sloty do SQLite `weather_snapshots` (INSERT OR REPLACE podle hodinového bucketu).
- Při startu/refreshi se tak naplní ~48 h z forecast timeseries; dál se archivuje každou hodinu.
- `GET /api/v1/history` vrací `weather_timeline` (subsample podle rozsahu).
- UI: časová osa ikon pod canvasem (sladěná s `chartArea`) + úzký sloupec „teď“.

### Subsampling

| Rozsah | Krok |
|--------|------|
| ≤ 6 h | 1 h |
| ≤ 24 h | 3 h |
| ≤ 7 d | 6 h |
| > 7 d | 24 h |

## 3. Historie

| Datum | Změna |
|-------|-------|
| 2026-07-23 | Spec + implementace |
