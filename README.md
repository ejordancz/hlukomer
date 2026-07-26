# Hlukoměr

24/7 monitoring hluku za oknem: **ESP32-S3 + Adafruit ICS-43434** → ESPHome → Docker API + dashboard.

## Architektura

```
ICS-43434 ──I2S──► ESP32-S3 (ESPHome sound_level_meter)
                         │ HTTP POST /api/v1/ingest (1s + 1min)
                         ▼
              Docker: FastAPI + SQLite + web grafy
              http://<server>:8080
```

Měří **LAeq / LAmax / LAmin** (A-vážení), **LZeq** (bez A-vážení), **LFI 20–200 Hz** a spektrum: **1/3-oktáva 25–250 Hz** + oktávy 500 Hz–16 kHz přes [esphome-sound-level-meter](https://github.com/stas-sl/esphome-sound-level-meter).

Z těchto dat dashboard počítá:

| Metrika | Význam |
|---|---|
| **Celková hladina (dB)** | LZeq z ESP (fallback: součet pásem) |
| **Low Frequency Index** | ESP filtr 20–200 Hz (fallback: součet 25–200 Hz pásem) |
| **Dominantní frekvence** | střed nejsilnějšího pásma (rozlišení 1/3 oktávy v basu) |
| **HVAC Score (0–100)** | basová dominance + tonalita typická pro VZT |
| **Spectrogram** | heatmapa spektra v čase (tenká čára = stálý tón, např. 50/63 Hz) |
| **Spektrum okamžiku** | klik na sloupec spectrogramu → pásma daného času |

> ESP posílá **IIR pásmové filtry**, ne true FFT. 1/3-oktáva v basu stačí k odlišení 50 Hz (síť) vs 63 Hz (ventilátor).

Po změně spektra je potřeba **znovu flashnout** ESP (`esphome run esphome/hlukomer.yaml`).

## 1. Docker služba

```bash
cp .env.example .env
# nastav INGEST_API_KEY a ADMIN_PASSWORD; limity: ALERT_DAY_DBA / ALERT_NIGHT_DBA (6–22 / noc)

docker compose up -d --build
```

Dashboard: http://localhost:8080  
Administrace (backup/restore DB): http://localhost:8080/admin — heslo jen z `ADMIN_PASSWORD` v `.env`.

API:

| Endpoint | Popis |
|---|---|
| `POST /api/v1/ingest` | data z ESP (hlavička `X-Api-Key`) |
| `GET /api/v1/latest` | poslední hodnoty + spektrum + LFI / HVAC / dominantní frekvence |
| `GET /api/v1/history?metric=laeq_1min&hours=24` | body grafu |
| `GET /api/v1/spectrum/history?hours=6` | sloupce pro spectrogram |
| `GET /api/v1/spectrum/at?ts=…` | spektrum (pseudo-FFT) v daném okamžiku |
| `GET /api/v1/stats?hours=24` | agregace |

Data: SQLite v `./data/hlukomer.db` (bind mount do kontejneru).

Retence (wide storage):

| Env | Default | Význam |
|-----|---------|--------|
| `HOT_RETENTION_HOURS` | 48 | Plných 1 Hz (`samples_1s`); starší se sbalí na 5 s |
| `ARCHIVE_INTERVAL_S` | 5 | Cold bucket (energy average) |
| `RETENTION_DAYS` | 90 | Po N dnech se cold/minuty **smažou** |

Stav úložiště: `GET /api/admin/storage`. Off-peak zmenšení DB: `POST /api/admin/storage/vacuum`.

## 2. ESPHome

```bash
cp esphome/secrets.yaml.example esphome/secrets.yaml
# wifi, OTA, api key, ingest_api_key (= INGEST_API_KEY z .env)
```

V `esphome/hlukomer.yaml` nastav:

- `api_base_url` — IP/hostname serveru s Dockerem (port 8080)
- piny I2S, pokud se liší od GPIO4/5/6

```bash
esphome run esphome/hlukomer.yaml
```

## 3. Kalibrace

Viz [CALIBRATION.md](./CALIBRATION.md). Po srovnání s referencí uprav `calibration_offset` a znovu flashni.

## Rychlý test API bez ESP

```bash
curl -X POST http://localhost:8080/api/v1/ingest \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $(grep INGEST_API_KEY .env | cut -d= -f2)" \
  -d '{"device_id":"hlukomer","kind":"live","laeq_1s":48.2,"spectrum":[35,42,40,38,33,32,30,28,27,26,25,30,28,25,22,20,18]}'
```

`spectrum` = 17 hodnot dB: 1/3-oktáva 25/31.5/40/50/63/80/100/125/160/200/250 + oktávy 500/1k/2k/4k/8k/16k Hz.  
Volitelně `lez_1s` (LZeq) a `lfi_db` (20–200 Hz).

## Poznámky k umístění

- Mikrofon venku / u okna: chraň před deštěm (otvor dolů, pěna/větrná ochrana).
- Pro limity nočního hluku sleduj hlavně **LAeq 1min** a historii v dashboardu.
- ESP i Docker musí být ve stejné LAN (nebo VPN); firewall musí povolit TCP 8080 směrem na server.
