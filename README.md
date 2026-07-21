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

Měří **LAeq / LAmax / LAmin** (A-vážení, dB SPL) přes komponentu [esphome-sound-level-meter](https://github.com/stas-sl/esphome-sound-level-meter) s EQ pro ICS-43434.

## 1. Docker služba

```bash
cp .env.example .env
# nastav INGEST_API_KEY; limity: ALERT_DAY_DBA / ALERT_NIGHT_DBA (6–22 / noc)

docker compose up -d --build
```

Dashboard: http://localhost:8080  

API:

| Endpoint | Popis |
|---|---|
| `POST /api/v1/ingest` | data z ESP (hlavička `X-Api-Key`) |
| `GET /api/v1/latest` | poslední hodnoty + online stav |
| `GET /api/v1/history?metric=laeq_1min&hours=24` | body grafu |
| `GET /api/v1/stats?hours=24` | agregace |

Data: Docker volume `hlukomer_data` (SQLite). Retence minutových dat: `RETENTION_DAYS` (90). Živá 1s data: `LIVE_RETENTION_DAYS` (7).

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
  -d '{"device_id":"hlukomer","kind":"live","laeq_1s":48.2}'
```

## Poznámky k umístění

- Mikrofon venku / u okna: chraň před deštěm (otvor dolů, pěna/větrná ochrana).
- Pro limity nočního hluku sleduj hlavně **LAeq 1min** a historii v dashboardu.
- ESP i Docker musí být ve stejné LAN (nebo VPN); firewall musí povolit TCP 8080 směrem na server.
