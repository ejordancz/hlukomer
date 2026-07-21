# Kalibrace mikrofonu ICS-43434

Cíl: aby **LAeq** odpovídal referenčnímu zvukoměru (±1–2 dB).

## Co už je v konfiguraci

| Parametr | Hodnota | Zdroj |
|---|---|---|
| `mic_sensitivity` | −26 dB | datasheet ICS-43434 (−26 dBFS @ 94 dB SPL) |
| `mic_sensitivity_ref` | 94 dB | standardní referenční SPL |
| `f_ics43434` | SOS EQ @ 48 kHz | frekvenční korekce mikrofonu |
| `f_a` | A-vážení @ 48 kHz | srovnatelné s běžnými limity hluku |
| `offset` | `calibration_offset` | doladění po srovnání s referencí |

Převod: `dB_SPL ≈ dBFS − mic_sensitivity + mic_sensitivity_ref + offset`

## Postup A — kalibrátor 94 dB (nejlepší)

1. Nasaď akustický kalibrátor (1 kHz, 94 dB) na mikrofon (nebo do adaptéru).
2. Počkej ~10 s, sleduj **LAeq 1s** (ESP web UI / Home Assistant / dashboard).
3. Spočítej: `offset = 94 − naměřená_hodnota`
4. Do `esphome/hlukomer.yaml` nastav:
   ```yaml
   substitutions:
     calibration_offset: "X.XdB"   # např. "1.5dB" nebo "-0.8dB"
   ```
5. Znovu flashni (`esphome run …`) a ověř, že LAeq ≈ 94 dB.

## Postup B — referenční zvukoměr (bez kalibrátoru)

1. Postav ESP a referenční meter vedle sebe (stejná vzdálenost od zdroje).
2. Pusť stabilní tón / stálý hluk (ventilátor, bílý šum z reproduktoru).
3. Porovnej LAeq 1 min:
   `offset = LAeq_reference − LAeq_hlukomer`
4. Zapiš offset do `calibration_offset` a flashni.

## Rychlá kontrola bez vybavení

V tiché místnosti v noci by **LAmin / LAeq** měly být zhruba kolem **30–40 dBA** (noise floor MEMS + okolí).  
Pokud je „ticho“ stále > 45 dBA:

- zkrať vodiče I2S, stínění, stabilní 3.3 V
- v YAML sniž `wifi.output_power` (např. `8.5dB`)
- zkus `channel: right` (některé breakouty mají L/R opačně)

Pokud dostáváš **−inf** / nuly: špatné zapojení pinů nebo kanál.

## Zapojení (Adafruit ICS-43434 → ESP32-S3)

| Mikrofon | ESP32-S3 |
|---|---|
| 3V | 3V3 |
| GND | GND |
| BCLK / SCK | GPIO4 |
| WS / LRCLK | GPIO5 |
| DOUT / SD | GPIO6 |
| SEL | obvykle GND na desce → `channel: left` |

Sample rate musí zůstat **48000** — A-vážení a EQ filtry jsou spočítané pro 48 kHz.

## Co sledovat u továrny

- **LAeq 1min** — hlavní metrika pro noční limity a stížnosti
- **LAmax 1min** — špičky (spínání VZT, troubení)
- Limity v Dockeru: `ALERT_DAY_DBA=45` (6:00–22:00), `ALERT_NIGHT_DBA=40` (noční klid) — schodová čárka v grafu a % času nad limitem
