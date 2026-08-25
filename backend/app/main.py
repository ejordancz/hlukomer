"""Hlukoměr API — příjem měření z ESPHome a historie pro dashboard."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional
from zoneinfo import ZoneInfo

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import aircraft as aircraft_svc
from . import storage
from . import weather as weather_svc

import logging

logger = logging.getLogger("hlukomer")
logging.getLogger("hlukomer.storage").setLevel(logging.INFO)
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO)

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "hlukomer.db"
INGEST_API_KEY = os.getenv("INGEST_API_KEY", "changeme")
ADMIN_PASSWORD = (os.getenv("ADMIN_PASSWORD") or "").strip()
if not ADMIN_PASSWORD:
    raise RuntimeError(
        "ADMIN_PASSWORD není nastaveno. Doplň ho do .env (viz .env.example)."
    )
ADMIN_SESSION_SECRET = os.getenv(
    "ADMIN_SESSION_SECRET",
    hashlib.sha256(f"hlukomer-admin-session:{ADMIN_PASSWORD}".encode()).hexdigest(),
)
ADMIN_SESSION_TTL = int(os.getenv("ADMIN_SESSION_TTL", "3600"))
ADMIN_COOKIE = "hlukomer_admin"
ADMIN_COOKIE_SECURE = os.getenv("ADMIN_COOKIE_SECURE", "0") == "1"
# Denní limit 6:00–22:00, jinak noční klid
ALERT_DAY_DBA = float(os.getenv("ALERT_DAY_DBA", "45"))
ALERT_NIGHT_DBA = float(os.getenv("ALERT_NIGHT_DBA", "40"))
ALERT_DAY_START_HOUR = int(os.getenv("ALERT_DAY_START_HOUR", "6"))
ALERT_DAY_END_HOUR = int(os.getenv("ALERT_DAY_END_HOUR", "22"))
# Jen zobrazení na dashboardu (neovlivní DB / API metriky)
DISPLAY_WINDOW_CORRECTION_DB = float(os.getenv("DISPLAY_WINDOW_CORRECTION_DB", "3"))
DISPLAY_TONAL_PENALTY_DB = float(os.getenv("DISPLAY_TONAL_PENALTY_DB", "5"))
APP_ENV = (os.getenv("APP_ENV", "DEV") or "DEV").strip().upper()
if APP_ENV not in {"DEV", "PROD"}:
    logger.warning("Unknown APP_ENV=%r, falling back to DEV", APP_ENV)
    APP_ENV = "DEV"
TZ_NAME = os.getenv("TZ", "Europe/Prague")
TZ = ZoneInfo(TZ_NAME)
RETENTION_DAYS = storage.RETENTION_DAYS

STATIC_DIR = Path(__file__).parent / "static"
_NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


def _static_file_v(name: str) -> str:
    path = STATIC_DIR / name
    try:
        st = path.stat()
        return f"{int(st.st_mtime)}-{st.st_size}"
    except OSError:
        return "0"


def static_rev() -> str:
    """Změní se při úpravě CSS/JS — dashboard se na to umí sám přenačíst."""
    return f"{_static_file_v('style.css')}.{_static_file_v('app.js')}"
TIANJI_TRACKER_SCRIPT = (
    '<script async defer src="https://tianji.ejordan.cz/tracker.js" '
    'data-website-id="cms78kn1z0k4lurf4uhwzjzu7"></script>'
)

# Spektrum: 1/3-oktáva 25–250 Hz + oktávy 500 Hz–16 kHz (pořadí = ESP spectrum[])
SPECTRUM_BANDS: tuple[str, ...] = (
    "25",
    "31",
    "40",
    "50",
    "63",
    "80",
    "100",
    "125",
    "160",
    "200",
    "250",
    "500",
    "1k",
    "2k",
    "4k",
    "8k",
    "16k",
)
SPECTRUM_LABELS: tuple[str, ...] = (
    "25 Hz",
    "31.5 Hz",
    "40 Hz",
    "50 Hz",
    "63 Hz",
    "80 Hz",
    "100 Hz",
    "125 Hz",
    "160 Hz",
    "200 Hz",
    "250 Hz",
    "500 Hz",
    "1 kHz",
    "2 kHz",
    "4 kHz",
    "8 kHz",
    "16 kHz",
)
SPECTRUM_HZ: tuple[float, ...] = (
    25.0,
    31.5,
    40.0,
    50.0,
    63.0,
    80.0,
    100.0,
    125.0,
    160.0,
    200.0,
    250.0,
    500.0,
    1000.0,
    2000.0,
    4000.0,
    8000.0,
    16000.0,
)
SPECTRUM_METRICS: tuple[str, ...] = tuple(f"oct_{b}" for b in SPECTRUM_BANDS)

# High-res FFT 170–270 Hz (1 Hz bins → spectrum_fine_3s)
FINE_SPECTRUM_HZ: tuple[float, ...] = tuple(float(hz) for hz in storage.FINE_FFT_HZ)
FINE_SPECTRUM_BANDS: tuple[str, ...] = storage.FINE_FFT_BANDS
FINE_SPECTRUM_LABELS: tuple[str, ...] = tuple(
    f"{int(hz)} Hz" for hz in FINE_SPECTRUM_HZ
)
# High-res FFT 25–70 Hz (1 Hz bins → spectrum_fine_lf_3s)
FINE_LF_SPECTRUM_HZ: tuple[float, ...] = tuple(float(hz) for hz in storage.FINE_LF_FFT_HZ)
FINE_LF_SPECTRUM_BANDS: tuple[str, ...] = storage.FINE_LF_FFT_BANDS
FINE_LF_SPECTRUM_LABELS: tuple[str, ...] = tuple(
    f"{int(hz)} Hz" for hz in FINE_LF_SPECTRUM_HZ
)
# LFI ≈ 20–200 Hz → 1/3-oktávy 25…200 Hz
LFI_BAND_INDEXES: tuple[int, ...] = tuple(
    i for i, hz in enumerate(SPECTRUM_HZ) if 20.0 <= hz <= 200.0
)
# HVAC typicky do 250 Hz
HVAC_BAND_INDEXES: tuple[int, ...] = tuple(
    i for i, hz in enumerate(SPECTRUM_HZ) if hz <= 250.0
)
HVAC_MAX_INDEX = max(HVAC_BAND_INDEXES) if HVAC_BAND_INDEXES else 0

app = FastAPI(title="Hlukoměr", version="1.2.0")


def _db_to_energy(db: float) -> float:
    return storage.db_to_energy(db)


def analyze_spectrum(
    values: list[float],
    *,
    lez_1s: Optional[float] = None,
    lfi_db_direct: Optional[float] = None,
) -> dict[str, Any]:
    """Odvozené metriky ze spektra; LZeq/LFI z ESP mají přednost."""
    if len(values) != len(SPECTRUM_BANDS):
        raise ValueError(f"expected {len(SPECTRUM_BANDS)} spectrum values")
    energies = [_db_to_energy(v) for v in values]
    total_e = sum(energies)
    leq_from_bands = 10.0 * math.log10(total_e) if total_e > 0 else None
    leq_total_db = lez_1s if lez_1s is not None else leq_from_bands

    lf_e = sum(energies[i] for i in LFI_BAND_INDEXES)
    lfi_from_bands = 10.0 * math.log10(lf_e) if lf_e > 0 else None
    lfi_db = lfi_db_direct if lfi_db_direct is not None else lfi_from_bands
    lfi_ratio = (lf_e / total_e) if total_e > 0 else None

    dom_i = max(range(len(values)), key=lambda i: values[i])
    dominant_hz = SPECTRUM_HZ[dom_i]
    dominant_label = SPECTRUM_LABELS[dom_i]
    dominant_db = values[dom_i]

    hvac_e = sum(energies[i] for i in HVAC_BAND_INDEXES)
    bass_frac = (hvac_e / total_e) if total_e > 0 else 0.0
    if dom_i <= HVAC_MAX_INDEX:
        in_hvac = 1.0
    elif dom_i == HVAC_MAX_INDEX + 1:
        in_hvac = 0.35
    else:
        in_hvac = 0.0
    median = sorted(values)[len(values) // 2]
    tonality = min(1.0, max(0.0, (dominant_db - median) / 15.0))
    lf_norm = 0.0
    if lfi_db is not None and math.isfinite(lfi_db):
        lf_norm = min(1.0, max(0.0, (lfi_db - 30.0) / 40.0))
    hvac_score = round(
        100.0 * (0.35 * bass_frac + 0.25 * in_hvac + 0.20 * tonality + 0.20 * lf_norm),
        1,
    )

    return {
        "leq_total_db": round(leq_total_db, 1) if leq_total_db is not None else None,
        "lfi_db": round(lfi_db, 1) if lfi_db is not None else None,
        "lfi_ratio": round(lfi_ratio, 3) if lfi_ratio is not None else None,
        "lfi_source": "esp" if lfi_db_direct is not None else "bands",
        "leq_source": "esp" if lez_1s is not None else "bands",
        "dominant_hz": dominant_hz,
        "dominant_label": dominant_label,
        "dominant_db": round(dominant_db, 1),
        "hvac_score": hvac_score,
        "bands": [
            {"band": b, "label": lab, "hz": hz, "value": round(v, 1)}
            for b, lab, hz, v in zip(SPECTRUM_BANDS, SPECTRUM_LABELS, SPECTRUM_HZ, values)
        ],
    }


def is_daytime(ts: float) -> bool:
    hour = datetime.fromtimestamp(ts, tz=TZ).hour
    return ALERT_DAY_START_HOUR <= hour < ALERT_DAY_END_HOUR


def threshold_at(ts: float) -> float:
    return ALERT_DAY_DBA if is_daytime(ts) else ALERT_NIGHT_DBA


def threshold_meta(ts: Optional[float] = None) -> dict[str, Any]:
    now = ts if ts is not None else utc_now()
    day = is_daytime(now)
    return {
        "alert_threshold_dba": threshold_at(now),
        "alert_period": "day" if day else "night",
        "thresholds": {
            "day_dba": ALERT_DAY_DBA,
            "night_dba": ALERT_NIGHT_DBA,
            "day_start_hour": ALERT_DAY_START_HOUR,
            "day_end_hour": ALERT_DAY_END_HOUR,
            "timezone": TZ_NAME,
        },
    }


def build_alert_night_bands(t0: float, t1: float) -> list[dict[str, float]]:
    """Intervaly nočního klidu (ALERT_*) — fallback stínování / legacy."""
    if t1 < t0:
        return []
    bands: list[dict[str, float]] = []
    local0 = datetime.fromtimestamp(t0, tz=TZ)
    day = local0.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
    end_local = datetime.fromtimestamp(t1, tz=TZ)
    while day <= end_local + timedelta(days=1):
        night_start = day.replace(
            hour=ALERT_DAY_END_HOUR, minute=0, second=0, microsecond=0
        )
        night_end = (day + timedelta(days=1)).replace(
            hour=ALERT_DAY_START_HOUR, minute=0, second=0, microsecond=0
        )
        a = max(night_start.timestamp(), t0)
        b = min(night_end.timestamp(), t1)
        if a < b:
            bands.append({"t0": a, "t1": b})
        day += timedelta(days=1)
    return bands


def build_sun_night_bands(t0: float, t1: float) -> Optional[list[dict[str, float]]]:
    """Astronomická noc podle sunrise/sunset (MET Norway). None = použít fallback."""
    if t1 < t0 or weather_svc.get_coords() is None:
        return None
    try:
        weather_svc.prefetch_sun_range(t0, t1, TZ)
    except Exception:  # noqa: BLE001
        return None

    bands: list[dict[str, float]] = []
    local0 = datetime.fromtimestamp(t0, tz=TZ)
    day = local0.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
    end_local = datetime.fromtimestamp(t1, tz=TZ)
    ok_days = 0
    while day <= end_local + timedelta(days=1):
        date_str = day.date().isoformat()
        next_str = (day + timedelta(days=1)).date().isoformat()
        sun = weather_svc.get_sun_for_date(date_str, TZ)
        sun_next = weather_svc.get_sun_for_date(next_str, TZ)
        if sun is None:
            day += timedelta(days=1)
            continue
        sunset_s = sun.get("sunset")
        sunrise_next = (sun_next or {}).get("sunrise") if sun_next else None
        # polar night: no sunrise/sunset — treat whole civil day as night if both null
        if not sunset_s and not sun.get("sunrise"):
            night_start = day.timestamp()
            night_end = (day + timedelta(days=1)).timestamp()
        elif not sunset_s or not sunrise_next:
            day += timedelta(days=1)
            continue
        else:
            night_start = datetime.fromisoformat(
                sunset_s.replace("Z", "+00:00")
            ).timestamp()
            night_end = datetime.fromisoformat(
                sunrise_next.replace("Z", "+00:00")
            ).timestamp()
        ok_days += 1
        a = max(night_start, t0)
        b = min(night_end, t1)
        if a < b:
            bands.append({"t0": a, "t1": b})
        day += timedelta(days=1)

    if ok_days == 0:
        return None
    return bands


def build_night_bands(t0: float, t1: float) -> tuple[list[dict[str, float]], str]:
    """Stínování den/noc v grafu — preferuje sunrise/sunset, jinak ALERT hodiny."""
    sun = build_sun_night_bands(t0, t1)
    if sun is not None:
        return sun, "met.no"
    return build_alert_night_bands(t0, t1), "fallback-alert-hours"


def build_limit_change_edges(t0: float, t1: float) -> list[float]:
    """Časy změn denního/nočního limitu (ALERT_*) pro spektrogram."""
    if t1 < t0:
        return []
    edges: list[float] = []
    local0 = datetime.fromtimestamp(t0, tz=TZ)
    day = local0.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = datetime.fromtimestamp(t1, tz=TZ)
    while day <= end_local + timedelta(days=1):
        for hour in (ALERT_DAY_START_HOUR, ALERT_DAY_END_HOUR):
            boundary = day.replace(hour=hour, minute=0, second=0, microsecond=0)
            ts = boundary.timestamp()
            if t0 < ts < t1:
                edges.append(ts)
        day += timedelta(days=1)
    return edges


def build_threshold_line(t0: float, t1: float) -> list[dict[str, float]]:
    """Schodová řada limitu pro graf (denní / noční).

    Na každé hranici dne/noci vloží dvojici bodů se stejným časem
    (stará → nová hodnota), aby Chart.js vykreslil svislý schod
    bez závislosti na stepped before/after.
    """
    if t1 < t0:
        return []
    points: list[dict[str, float]] = [{"t": t0, "v": threshold_at(t0)}]
    local0 = datetime.fromtimestamp(t0, tz=TZ)
    day = local0.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = datetime.fromtimestamp(t1, tz=TZ)
    while day <= end_local + timedelta(days=1):
        for hour in (ALERT_DAY_START_HOUR, ALERT_DAY_END_HOUR):
            boundary = day.replace(hour=hour, minute=0, second=0, microsecond=0)
            ts = boundary.timestamp()
            if t0 < ts <= t1:
                new_v = threshold_at(ts)
                prev_v = points[-1]["v"]
                if new_v != prev_v:
                    points.append({"t": ts, "v": prev_v})
                    points.append({"t": ts, "v": new_v})
        day += timedelta(days=1)
    if points[-1]["t"] < t1:
        points.append({"t": t1, "v": threshold_at(t1)})
    return points


# Mezera mezi vzorky LAeq 1s, od které považujeme zařízení za offline
OFFLINE_GAP_S = float(os.getenv("OFFLINE_GAP_S", "30"))


def compute_offline(
    timestamps: list[float],
    t0: float,
    t1: float,
    gap_threshold_s: float = OFFLINE_GAP_S,
) -> dict[str, Any]:
    """Spočítá období bez dat (offline) v intervalu [t0, t1].

    Vstupem jsou časové značky pravidelné metriky (typicky laeq_1s).
    Mezera > gap_threshold_s = výpadek; stejně chybějící data na začátku/konci rozsahu.
    """
    range_s = max(0.0, t1 - t0)
    gaps: list[dict[str, float]] = []

    def add_gap(a: float, b: float) -> None:
        a = max(a, t0)
        b = min(b, t1)
        if b - a > gap_threshold_s:
            gaps.append({"t0": a, "t1": b, "duration_s": b - a})

    if not timestamps:
        add_gap(t0, t1)
    else:
        add_gap(t0, timestamps[0])
        for prev, cur in zip(timestamps, timestamps[1:]):
            add_gap(prev, cur)
        add_gap(timestamps[-1], t1)

    total_s = sum(g["duration_s"] for g in gaps)
    online_s = max(0.0, range_s - total_s)
    offline_pct = (100.0 * total_s / range_s) if range_s > 0 else 0.0
    gaps.sort(key=lambda g: g["t0"])
    return {
        "gap_threshold_s": gap_threshold_s,
        "t0": round(t0, 3),
        "t1": round(t1, 3),
        "range_s": round(range_s, 1),
        "offline_s": round(total_s, 1),
        "online_s": round(online_s, 1),
        "offline_pct": round(offline_pct, 1),
        "gap_count": len(gaps),
        "gaps": [
            {
                "t0": round(g["t0"], 3),
                "t1": round(g["t1"], 3),
                "duration_s": round(g["duration_s"], 1),
            }
            for g in gaps
        ],
    }


def fetch_offline_stats(
    conn: sqlite3.Connection,
    device_id: str,
    since: float,
    until: Optional[float] = None,
) -> dict[str, Any]:
    """Offline statistika z časových značek laeq_1s (bez downsample)."""
    t1 = until if until is not None else utc_now()
    return compute_offline(
        storage.fetch_laeq_timestamps(conn, device_id, since, t1), since, t1
    )


class IngestPayload(BaseModel):
    device_id: str = Field(default="hlukomer", max_length=64)
    kind: str = Field(default="live", pattern="^(live|minute|spectrum_fine)$")
    laeq_1s: Optional[float] = None
    lez_1s: Optional[float] = None  # LZeq bez A-vážení
    lfi_db: Optional[float] = None  # přímý LFI 20–200 Hz z ESP
    laeq_1min: Optional[float] = None
    lamax_1min: Optional[float] = None
    lamin_1min: Optional[float] = None
    # 17 pásem: 1/3-oktáva 25–250 Hz + oktávy výš
    spectrum: Optional[list[float]] = Field(default=None, max_length=17)
    # High-res FFT 170–270 Hz (101 × 1 Hz); kind=spectrum_fine
    spectrum_fine: Optional[list[float]] = Field(
        default=None, max_length=max(storage.FINE_FFT_INGEST_LAYOUTS)
    )
    spectrum_fine_meta: Optional[dict[str, Any]] = None
    # High-res FFT 25–70 Hz (46 × 1 Hz); volitelně spolu se spectrum_fine
    spectrum_fine_lf: Optional[list[float]] = Field(
        default=None, max_length=max(storage.FINE_LF_FFT_INGEST_LAYOUTS)
    )
    spectrum_fine_lf_meta: Optional[dict[str, Any]] = None
    ts: Optional[float] = None  # unix seconds; default = server time

def utc_now() -> float:
    return time.time()


def ensure_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS weather_snapshots (
                ts REAL PRIMARY KEY,
                symbol_code TEXT,
                description TEXT,
                icon_class TEXT,
                temperature_c REAL,
                wind_speed_ms REAL,
                wind_from_direction_deg REAL,
                wind_from_direction_cardinal TEXT,
                precipitation_1h_mm REAL,
                relative_humidity_pct REAL,
                pressure_hpa REAL,
                skew_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_weather_ts ON weather_snapshots(ts);
            CREATE TABLE IF NOT EXISTS aircraft_overflights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                icao24 TEXT NOT NULL,
                callsign TEXT,
                origin_country TEXT,
                aircraft_type TEXT,
                origin_airport TEXT,
                destination_airport TEXT,
                first_seen_ts REAL NOT NULL,
                last_seen_ts REAL NOT NULL,
                closest_ts REAL NOT NULL,
                closest_lat REAL,
                closest_lon REAL,
                closest_distance_m REAL NOT NULL,
                closest_altitude_m REAL NOT NULL,
                closest_velocity_ms REAL,
                closest_track_deg REAL,
                closest_vertical_rate_ms REAL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_aircraft_closest_ts
                ON aircraft_overflights(closest_ts);
            CREATE INDEX IF NOT EXISTS idx_aircraft_icao_last
                ON aircraft_overflights(icao24, last_seen_ts);
            """
        )
        storage.ensure_wide_tables(conn)
        _migrate_aircraft_columns(conn)


def _migrate_aircraft_columns(conn: sqlite3.Connection) -> None:
    """Doplní enrichment sloupce u starší DB (CREATE IF NOT EXISTS je nestačí)."""
    try:
        cols = {
            str(r[1])
            for r in conn.execute("PRAGMA table_info(aircraft_overflights)").fetchall()
        }
    except sqlite3.OperationalError:
        return
    for col, typedef in (
        ("aircraft_type", "TEXT"),
        ("origin_airport", "TEXT"),
        ("destination_airport", "TEXT"),
    ):
        if col not in cols:
            conn.execute(
                f"ALTER TABLE aircraft_overflights ADD COLUMN {col} {typedef}"
            )


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    if not INGEST_API_KEY or INGEST_API_KEY == "changeme":
        return
    if x_api_key != INGEST_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def _create_admin_token() -> str:
    exp = int(time.time()) + ADMIN_SESSION_TTL
    nonce = secrets.token_hex(16)
    payload = f"{exp}.{nonce}"
    sig = hmac.new(
        ADMIN_SESSION_SECRET.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload}.{sig}"


def _verify_admin_token(token: Optional[str]) -> bool:
    if not token:
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    exp_s, nonce, sig = parts
    if not exp_s.isdigit() or not nonce or not sig:
        return False
    payload = f"{exp_s}.{nonce}"
    expected = hmac.new(
        ADMIN_SESSION_SECRET.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    if int(exp_s) < int(time.time()):
        return False
    return True


def _set_admin_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=ADMIN_COOKIE,
        value=token,
        max_age=ADMIN_SESSION_TTL,
        httponly=True,
        samesite="strict",
        secure=ADMIN_COOKIE_SECURE,
        path="/api/admin",
    )


def _clear_admin_cookie(response: Response) -> None:
    response.delete_cookie(
        key=ADMIN_COOKIE,
        path="/api/admin",
        httponly=True,
        samesite="strict",
        secure=ADMIN_COOKIE_SECURE,
    )


def require_admin_session(
    hlukomer_admin: Optional[str] = Cookie(default=None, alias=ADMIN_COOKIE),
) -> None:
    if not _verify_admin_token(hlukomer_admin):
        raise HTTPException(status_code=401, detail="Neautorizováno")


class AdminLogin(BaseModel):
    password: str = Field(min_length=1, max_length=256)


@app.on_event("startup")
def on_startup() -> None:
    ensure_db()
    prune_old()
    weather_svc.set_persist_callback(persist_weather_samples)
    weather_svc.start_hourly_refresh()
    aircraft_svc.set_persist_callback(persist_aircraft_sightings)
    aircraft_svc.start_aircraft_poll()
    _start_aircraft_enrichment_backfill()
    storage.start_background_jobs(db, prune_fn=prune_old)


def prune_old() -> None:
    now = utc_now()
    ac_days = aircraft_svc.get_config().retention_days
    if ac_days is None:
        ac_days = RETENTION_DAYS
    cutoff_aircraft = now - max(1, ac_days) * 86400
    with db() as conn:
        storage.prune_storage(conn, aircraft_cutoff=cutoff_aircraft)


def persist_weather_samples(samples: list[dict[str, Any]]) -> None:
    """Uloží hodinové snapshoty z Locationforecast (UPSERT)."""
    if not samples:
        return
    with db() as conn:
        for s in samples:
            skew = s.get("skew_factors") or []
            conn.execute(
                """
                INSERT INTO weather_snapshots (
                    ts, symbol_code, description, icon_class,
                    temperature_c, wind_speed_ms, wind_from_direction_deg,
                    wind_from_direction_cardinal, precipitation_1h_mm,
                    relative_humidity_pct, pressure_hpa, skew_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ts) DO UPDATE SET
                    symbol_code=excluded.symbol_code,
                    description=excluded.description,
                    icon_class=excluded.icon_class,
                    temperature_c=excluded.temperature_c,
                    wind_speed_ms=excluded.wind_speed_ms,
                    wind_from_direction_deg=excluded.wind_from_direction_deg,
                    wind_from_direction_cardinal=excluded.wind_from_direction_cardinal,
                    precipitation_1h_mm=excluded.precipitation_1h_mm,
                    relative_humidity_pct=excluded.relative_humidity_pct,
                    pressure_hpa=excluded.pressure_hpa,
                    skew_json=excluded.skew_json
                """,
                (
                    float(s["ts"]),
                    s.get("symbol_code"),
                    s.get("description"),
                    s.get("icon_class"),
                    s.get("temperature_c"),
                    s.get("wind_speed_ms"),
                    s.get("wind_from_direction_deg"),
                    s.get("wind_from_direction_cardinal"),
                    s.get("precipitation_1h_mm"),
                    s.get("relative_humidity_pct"),
                    s.get("pressure_hpa"),
                    json.dumps(skew, ensure_ascii=False),
                ),
            )


def persist_aircraft_sightings(sightings: list[aircraft_svc.Sighting]) -> None:
    """UPSERT přeletových událostí podle icao24 + GAP_S."""
    if not sightings:
        return
    gap_s = aircraft_svc.get_config().gap_s
    now = utc_now()
    enrich_ids: list[tuple[int, str, float]] = []
    with db() as conn:
        for s in sightings:
            open_row = conn.execute(
                """
                SELECT id, closest_distance_m,
                       aircraft_type, origin_airport, destination_airport
                FROM aircraft_overflights
                WHERE icao24 = ? AND (? - last_seen_ts) <= ?
                ORDER BY last_seen_ts DESC
                LIMIT 1
                """,
                (s.icao24, s.ts, gap_s),
            ).fetchone()
            if open_row:
                if s.distance_m < float(open_row["closest_distance_m"]):
                    conn.execute(
                        """
                        UPDATE aircraft_overflights SET
                            callsign = COALESCE(?, callsign),
                            origin_country = COALESCE(?, origin_country),
                            last_seen_ts = ?,
                            closest_ts = ?,
                            closest_lat = ?,
                            closest_lon = ?,
                            closest_distance_m = ?,
                            closest_altitude_m = ?,
                            closest_velocity_ms = ?,
                            closest_track_deg = ?,
                            closest_vertical_rate_ms = ?,
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            s.callsign,
                            s.origin_country,
                            s.ts,
                            s.ts,
                            s.lat,
                            s.lon,
                            s.distance_m,
                            s.altitude_m,
                            s.velocity_ms,
                            s.track_deg,
                            s.vertical_rate_ms,
                            now,
                            open_row["id"],
                        ),
                    )
                else:
                    conn.execute(
                        """
                        UPDATE aircraft_overflights SET
                            callsign = COALESCE(?, callsign),
                            origin_country = COALESCE(?, origin_country),
                            last_seen_ts = MAX(last_seen_ts, ?),
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            s.callsign,
                            s.origin_country,
                            s.ts,
                            now,
                            open_row["id"],
                        ),
                    )
                # Doplnit enrichment, pokud chybí typ nebo letiště
                if (
                    not open_row["aircraft_type"]
                    or not open_row["origin_airport"]
                    or not open_row["destination_airport"]
                ):
                    enrich_ids.append((int(open_row["id"]), s.icao24, float(s.ts)))
            else:
                cur = conn.execute(
                    """
                    INSERT INTO aircraft_overflights (
                        icao24, callsign, origin_country,
                        first_seen_ts, last_seen_ts, closest_ts,
                        closest_lat, closest_lon,
                        closest_distance_m, closest_altitude_m,
                        closest_velocity_ms, closest_track_deg,
                        closest_vertical_rate_ms, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        s.icao24,
                        s.callsign,
                        s.origin_country,
                        s.ts,
                        s.ts,
                        s.ts,
                        s.lat,
                        s.lon,
                        s.distance_m,
                        s.altitude_m,
                        s.velocity_ms,
                        s.track_deg,
                        s.vertical_rate_ms,
                        now,
                    ),
                )
                enrich_ids.append((int(cur.lastrowid), s.icao24, float(s.ts)))

    # HTTP enrichment mimo DB transakci (cache v aircraft.py)
    for row_id, icao24, ts in enrich_ids:
        try:
            meta = aircraft_svc.enrich_aircraft(icao24, ts)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Aircraft enrich %s: %s", icao24, exc)
            continue
        with db() as conn:
            conn.execute(
                """
                UPDATE aircraft_overflights SET
                    aircraft_type = COALESCE(aircraft_type, ?),
                    origin_airport = COALESCE(?, origin_airport),
                    destination_airport = COALESCE(?, destination_airport),
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    meta.aircraft_type or "",
                    meta.origin_airport,
                    meta.destination_airport,
                    utc_now(),
                    row_id,
                ),
            )


AIRCRAFT_HISTORY_CAP = 500


def fetch_aircraft_overflights(t0: float, t1: float) -> list[dict[str, Any]]:
    """Přeletové markery v časovém rozsahu grafu (max AIRCRAFT_HISTORY_CAP)."""

    def _query() -> list[sqlite3.Row]:
        with db() as conn:
            return conn.execute(
                """
                SELECT
                    id, icao24, callsign, origin_country,
                    aircraft_type, origin_airport, destination_airport,
                    closest_ts, closest_distance_m, closest_altitude_m,
                    closest_velocity_ms, closest_track_deg, closest_vertical_rate_ms,
                    first_seen_ts, last_seen_ts
                FROM aircraft_overflights
                WHERE closest_ts >= ? AND closest_ts <= ?
                ORDER BY closest_distance_m ASC, closest_ts DESC
                LIMIT ?
                """,
                (t0, t1, AIRCRAFT_HISTORY_CAP),
            ).fetchall()

    try:
        rows = _query()
    except sqlite3.OperationalError:
        # Obnovená / ručně zkopírovaná stará DB bez tabulky / sloupců
        ensure_db()
        rows = _query()
    items = [
        {
            "id": r["id"],
            "t": r["closest_ts"],
            "icao24": r["icao24"],
            "callsign": r["callsign"],
            "origin_country": r["origin_country"],
            "aircraft_type": r["aircraft_type"] or None,
            "origin_airport": r["origin_airport"] or None,
            "destination_airport": r["destination_airport"] or None,
            "distance_m": r["closest_distance_m"],
            "altitude_m": r["closest_altitude_m"],
            "velocity_ms": r["closest_velocity_ms"],
            "track_deg": r["closest_track_deg"],
            "vertical_rate_ms": r["closest_vertical_rate_ms"],
            "first_seen_ts": r["first_seen_ts"],
            "last_seen_ts": r["last_seen_ts"],
        }
        for r in rows
    ]
    items.sort(key=lambda x: x["t"])
    return items


def backfill_aircraft_enrichment(limit: int = 40) -> int:
    """Doplní typ/letiště u starších přeletů bez blockování history API."""
    try:
        with db() as conn:
            rows = conn.execute(
                """
                SELECT id, icao24, closest_ts
                FROM aircraft_overflights
                WHERE aircraft_type IS NULL
                ORDER BY closest_ts DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
    except sqlite3.OperationalError:
        return 0

    done = 0
    for r in rows:
        try:
            meta = aircraft_svc.enrich_aircraft(str(r["icao24"]), float(r["closest_ts"]))
        except Exception as exc:  # noqa: BLE001
            logger.debug("Aircraft backfill %s: %s", r["icao24"], exc)
            # Označit typ jako „zkoušeno“, ať backfill necyklí
            with db() as conn:
                conn.execute(
                    """
                    UPDATE aircraft_overflights SET
                        aircraft_type = COALESCE(aircraft_type, ''),
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (utc_now(), r["id"]),
                )
            continue
        with db() as conn:
            conn.execute(
                """
                UPDATE aircraft_overflights SET
                    aircraft_type = COALESCE(aircraft_type, ?),
                    origin_airport = COALESCE(?, origin_airport),
                    destination_airport = COALESCE(?, destination_airport),
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    meta.aircraft_type or "",
                    meta.origin_airport,
                    meta.destination_airport,
                    utc_now(),
                    r["id"],
                ),
            )
        done += 1
    return done


def _start_aircraft_enrichment_backfill() -> None:
    import threading

    def run() -> None:
        try:
            n = backfill_aircraft_enrichment()
            if n:
                logger.info("Aircraft enrichment backfill: %d záznamů", n)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Aircraft enrichment backfill: %s", exc)

    threading.Thread(
        target=run, name="aircraft-enrich-backfill", daemon=True
    ).start()


def weather_step_seconds(hours: float) -> float:
    if hours <= 6:
        return 3600.0
    if hours <= 24:
        return 3 * 3600.0
    if hours <= 168:
        return 6 * 3600.0
    return 24 * 3600.0


def fetch_weather_timeline(t0: float, t1: float, hours: float) -> list[dict[str, Any]]:
    """Snapshoty v [t0, t1] podvzorkované podle rozsahu grafu."""
    step = weather_step_seconds(hours)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM weather_snapshots
            WHERE ts >= ? AND ts <= ?
            ORDER BY ts ASC
            """,
            (t0 - step, t1 + step),
        ).fetchall()
    if not rows:
        return []

    samples: list[dict[str, Any]] = []
    next_bucket: Optional[float] = None
    for row in rows:
        ts = float(row["ts"])
        if ts < t0 or ts > t1:
            continue
        bucket = math.floor(ts / step) * step
        if next_bucket is not None and bucket < next_bucket:
            continue
        skew_raw = row["skew_json"] or "[]"
        try:
            skew = json.loads(skew_raw)
        except json.JSONDecodeError:
            skew = []
        samples.append(
            {
                "t": ts,
                "symbol_code": row["symbol_code"],
                "description": row["description"],
                "icon_class": row["icon_class"],
                "temperature_c": row["temperature_c"],
                "wind_speed_ms": row["wind_speed_ms"],
                "wind_from_direction_deg": row["wind_from_direction_deg"],
                "wind_from_direction_cardinal": row["wind_from_direction_cardinal"],
                "precipitation_1h_mm": row["precipitation_1h_mm"],
                "skew_factors": skew,
            }
        )
        next_bucket = bucket + step
    return samples


def latest_metric_value(
    conn: sqlite3.Connection, device_id: str, metric: str
) -> Optional[tuple[float, float]]:
    return storage.latest_metric(conn, device_id, metric)


@app.post("/api/v1/ingest")
def ingest(payload: IngestPayload, _: None = Depends(require_api_key)) -> dict[str, Any]:
    ts = payload.ts if payload.ts is not None else utc_now()

    if payload.kind == "spectrum_fine":
        if payload.spectrum_fine is None:
            raise HTTPException(status_code=400, detail="spectrum_fine required")
        try:
            f0, df, _n = storage.resolve_fine_fft_ingest(
                payload.spectrum_fine,
                payload.spectrum_fine_meta,
                layouts=storage.FINE_FFT_INGEST_LAYOUTS,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        written_lf = 0
        lf_f0: Optional[float] = None
        lf_df: Optional[float] = None
        if payload.spectrum_fine_lf is not None:
            try:
                lf_f0, lf_df, _n_lf = storage.resolve_fine_fft_ingest(
                    payload.spectrum_fine_lf,
                    payload.spectrum_fine_lf_meta,
                    layouts=storage.FINE_LF_FFT_INGEST_LAYOUTS,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        with db() as conn:
            written = storage.upsert_spectrum_fine_3s(
                conn,
                ts,
                payload.device_id,
                payload.spectrum_fine,
                f0_hz=f0,
                df_hz=df,
            )
            if payload.spectrum_fine_lf is not None:
                written_lf = storage.upsert_spectrum_fine_lf_3s(
                    conn,
                    ts,
                    payload.device_id,
                    payload.spectrum_fine_lf,
                    f0_hz=lf_f0 if lf_f0 is not None else storage.FINE_LF_FFT_F0_HZ,
                    df_hz=lf_df if lf_df is not None else storage.FINE_FFT_DF_HZ,
                )
        return {
            "ok": True,
            "written": written,
            "written_lf": written_lf,
            "ts": ts,
            "kind": "spectrum_fine",
        }

    spectrum_cols: Optional[tuple[str, ...]] = None
    if payload.spectrum is not None:
        if len(payload.spectrum) != len(SPECTRUM_BANDS):
            raise HTTPException(
                status_code=400,
                detail=f"spectrum must have {len(SPECTRUM_BANDS)} values",
            )
        spectrum_cols = SPECTRUM_METRICS
    if payload.spectrum_fine is not None:
        # Starý IIR firmware (17 hodnot) — ignorovat, ať nerozbije LAeq ingest.
        logger.info(
            "Ignoring legacy spectrum_fine on live ingest (len=%s)",
            len(payload.spectrum_fine),
        )
    written = 0
    with db() as conn:
        written += storage.ingest_live(
            conn,
            ts,
            payload.device_id,
            laeq_1s=payload.laeq_1s,
            lez_1s=payload.lez_1s,
            lfi_db=payload.lfi_db,
            spectrum=payload.spectrum,
            spectrum_cols=spectrum_cols,
        )
        written += storage.upsert_minute(
            conn,
            ts,
            payload.device_id,
            {
                "laeq_1min": payload.laeq_1min,
                "lamax_1min": payload.lamax_1min,
                "lamin_1min": payload.lamin_1min,
            },
        )
    if written == 0:
        raise HTTPException(status_code=400, detail="No metric values provided")
    return {"ok": True, "written": written, "ts": ts}

def fetch_spectrum(conn: sqlite3.Connection, device_id: str) -> Optional[dict[str, Any]]:
    row = storage.latest_row_1s(conn, device_id)
    values: list[Optional[float]] = [None] * len(SPECTRUM_METRICS)
    latest_ts: Optional[float] = None
    if row:
        latest_ts = float(row["ts"])
        for i, metric in enumerate(SPECTRUM_METRICS):
            if row[metric] is not None:
                values[i] = float(row[metric])
    else:
        # cold fallback per band (samples_5s přes latest_metric)
        for i, metric in enumerate(SPECTRUM_METRICS):
            got = storage.latest_metric(conn, device_id, metric)
            if got:
                latest_ts = got[0] if latest_ts is None else max(latest_ts, got[0])
                values[i] = got[1]

    if any(v is None for v in values) or latest_ts is None:
        bands: list[dict[str, Any]] = []
        for i, (band, label) in enumerate(zip(SPECTRUM_BANDS, SPECTRUM_LABELS)):
            if values[i] is None:
                continue
            bands.append({"band": band, "label": label, "value": values[i]})
        if not bands:
            return None
        return {"ts": latest_ts, "bands": bands}

    lez = latest_metric_value(conn, device_id, "lez_1s")
    lfi = latest_metric_value(conn, device_id, "lfi_db")
    lez_1s = lez[1] if lez and abs(lez[0] - latest_ts) < 3 else None
    lfi_direct = lfi[1] if lfi and abs(lfi[0] - latest_ts) < 3 else None
    analysis = analyze_spectrum(
        [float(v) for v in values],  # type: ignore[arg-type]
        lez_1s=lez_1s,
        lfi_db_direct=lfi_direct,
    )
    return {"ts": latest_ts, **analysis}


def fetch_spectrum_at(
    conn: sqlite3.Connection, device_id: str, ts: float, tolerance: float = 1.5
) -> Optional[dict[str, Any]]:
    """Spektrum nejbližší k ts (pro FFT okamžiku)."""
    row = storage.nearest_sample(conn, device_id, ts, tolerance=tolerance)
    if row is None:
        return None

    values_f = [float(row[m]) for m in SPECTRUM_METRICS if row[m] is not None]
    if len(values_f) != len(SPECTRUM_METRICS):
        return None
    used_ts = float(row["ts"])
    lez_1s = float(row["lez_1s"]) if row["lez_1s"] is not None else None
    lfi_direct = float(row["lfi_db"]) if row["lfi_db"] is not None else None
    analysis = analyze_spectrum(
        [float(row[m]) for m in SPECTRUM_METRICS],
        lez_1s=lez_1s,
        lfi_db_direct=lfi_direct,
    )
    return {"ts": used_ts, **analysis}


def downsample_spectrum_columns(
    complete: list[tuple[float, list[Optional[float]]]],
    max_columns: int,
) -> tuple[list[dict[str, Any]], Optional[float], Optional[float]]:
    if not complete:
        return [], None, None

    n_bands = len(complete[0][1])
    if len(complete) > max_columns:
        bucket_size = len(complete) / max_columns
        down: list[tuple[float, list[Optional[float]]]] = []
        i = 0.0
        while int(i) < len(complete):
            start = int(i)
            end = min(int(i + bucket_size), len(complete))
            chunk = complete[start:end]
            if not chunk:
                break
            t = sum(c[0] for c in chunk) / len(chunk)
            avg_vals: list[Optional[float]] = []
            for bi in range(n_bands):
                band_vals = [
                    c[1][bi]
                    for c in chunk
                    if bi < len(c[1]) and c[1][bi] is not None
                ]
                if not band_vals:
                    avg_vals.append(None)
                    continue
                e = sum(_db_to_energy(v) for v in band_vals) / len(band_vals)
                avg_vals.append(
                    10.0 * math.log10(e) if e > 0 else band_vals[0]
                )
            down.append((t, avg_vals))
            i += bucket_size
        complete = down

    all_vals = [v for _, vals in complete for v in vals if v is not None]
    vmin = min(all_vals) if all_vals else None
    vmax = max(all_vals) if all_vals else None
    columns = [
        {
            "t": t,
            "v": [None if x is None else round(x, 1) for x in vals],
        }
        for t, vals in complete
    ]
    return columns, vmin, vmax


@app.get("/api/v1/latest")
def latest(device_id: str = Query(default="hlukomer")) -> dict[str, Any]:
    metrics = ("laeq_1s", "lez_1s", "lfi_db", "laeq_1min", "lamax_1min", "lamin_1min")
    out: dict[str, Any] = {"device_id": device_id, "metrics": {}, **threshold_meta()}
    with db() as conn:
        for metric in metrics:
            got = storage.latest_metric(conn, device_id, metric)
            if got:
                ts, value = got
                out["metrics"][metric] = {
                    "value": value,
                    "ts": ts,
                    "iso": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
                }
        spectrum = fetch_spectrum(conn, device_id)
        if spectrum:
            out["spectrum"] = spectrum
            out["analysis"] = {
                k: spectrum[k]
                for k in (
                    "leq_total_db",
                    "lfi_db",
                    "lfi_ratio",
                    "lfi_source",
                    "leq_source",
                    "dominant_hz",
                    "dominant_label",
                    "dominant_db",
                    "hvac_score",
                )
                if k in spectrum
            }
        last_ts = storage.max_ts(conn, device_id)
        out["online"] = bool(last_ts and (utc_now() - last_ts) < 30)
        out["last_seen"] = last_ts
    return out


@app.get("/api/v1/spectrum/history")
def spectrum_history(
    hours: float = Query(default=6, ge=0.1, le=24 * 90),
    start: float | None = Query(
        default=None,
        description="Unix začátek okna; bez něj končí okno na teď (živě).",
    ),
    device_id: str = Query(default="hlukomer"),
    max_columns: int = Query(default=360, ge=10, le=2000),
) -> dict[str, Any]:
    """Heatmapa spektra v čase — sloupce = okamžiky, řádky = frekvenční pásma.

    Okno je [start, start+hours]. Bez `start` je start = now − hours (živý konec).
    """
    now = utc_now()
    span = hours * 3600
    if start is None:
        t_end = now
        t_start = t_end - span
    else:
        t_start = float(start)
        t_end = t_start + span
        if t_start >= now:
            raise HTTPException(status_code=400, detail="start must be in the past")
        if t_end > now:
            t_end = now
        if t_end <= t_start:
            raise HTTPException(status_code=400, detail="empty time window")

    with db() as conn:
        complete = storage.fetch_spectrum_columns_raw(
            conn, device_id, t_start, t_end, SPECTRUM_METRICS
        )
    columns, vmin, vmax = downsample_spectrum_columns(complete, max_columns)
    bands = list(SPECTRUM_BANDS)
    labels = list(SPECTRUM_LABELS)
    hz = list(SPECTRUM_HZ)
    note = "1/3-oktáva 25–250 Hz + oktávy výš (IIR). Trvalá čára = tón (např. 250 Hz nebo 50/63 Hz)."
    with db() as conn:
        offline = fetch_offline_stats(conn, device_id, t_start, t_end)
        storage_info = {
            "hot_retention_hours": storage.HOT_RETENTION_HOURS,
            "archive_interval_s": storage.ARCHIVE_INTERVAL_S,
            "resolution": (
                "1s"
                if t_start >= storage.hot_cutoff(now)
                else "mixed"
                if t_end > storage.hot_cutoff(now)
                else f"{storage.ARCHIVE_INTERVAL_S}s"
            ),
        }
    night_bands, sun_source = build_night_bands(t_start, t_end)
    return {
        "device_id": device_id,
        "hours": hours,
        "start": round(t_start, 3),
        "end": round(t_end, 3),
        "bands": bands,
        "labels": labels,
        "hz": hz,
        "columns": columns,
        "vmin": round(vmin, 1) if vmin is not None else None,
        "vmax": round(vmax, 1) if vmax is not None else None,
        "night_bands": night_bands,
        "limit_change_edges": build_limit_change_edges(t_start, t_end),
        "sun": {"source": sun_source},
        "offline": offline,
        "storage": storage_info,
        "note": note,
    }


@app.get("/api/v1/spectrum/fine/history")
def spectrum_fine_history(
    hours: float = Query(default=6, ge=0.1, le=24 * 90),
    start: float | None = Query(
        default=None,
        description="Unix začátek okna; bez něj končí okno na teď (živě).",
    ),
    device_id: str = Query(default="hlukomer"),
    max_columns: int = Query(default=360, ge=10, le=2000),
) -> dict[str, Any]:
    """Heatmapa high-res FFT 170–270 Hz (1 Hz bins, 3 s energy average)."""
    now = utc_now()
    span = hours * 3600
    if start is None:
        t_end = now
        t_start = t_end - span
    else:
        t_start = float(start)
        t_end = t_start + span
        if t_start >= now:
            raise HTTPException(status_code=400, detail="start must be in the past")
        if t_end > now:
            t_end = now
        if t_end <= t_start:
            raise HTTPException(status_code=400, detail="empty time window")

    with db() as conn:
        complete = storage.fetch_spectrum_fine_columns_raw(
            conn, device_id, t_start, t_end
        )
    columns, vmin, vmax = downsample_spectrum_columns(complete, max_columns)
    with db() as conn:
        offline = fetch_offline_stats(conn, device_id, t_start, t_end)
        storage_info = {
            "hot_retention_hours": storage.HOT_RETENTION_HOURS,
            "archive_interval_s": storage.ARCHIVE_INTERVAL_S,
            "fine_integrate_s": storage.FINE_FFT_INTEGRATE_S,
            "resolution": f"{storage.FINE_FFT_INTEGRATE_S}s",
        }
    night_bands, sun_source = build_night_bands(t_start, t_end)
    return {
        "device_id": device_id,
        "hours": hours,
        "start": round(t_start, 3),
        "end": round(t_end, 3),
        "bands": list(FINE_SPECTRUM_BANDS),
        "labels": list(FINE_SPECTRUM_LABELS),
        "hz": list(FINE_SPECTRUM_HZ),
        "bandwidth_hz": storage.FINE_FFT_DF_HZ,
        "df_hz": storage.FINE_FFT_DF_HZ,
        "integrate_s": storage.FINE_FFT_INTEGRATE_S,
        "kind": "fft",
        "columns": columns,
        "vmin": round(vmin, 1) if vmin is not None else None,
        "vmax": round(vmax, 1) if vmax is not None else None,
        "night_bands": night_bands,
        "limit_change_edges": build_limit_change_edges(t_start, t_end),
        "sun": {"source": sun_source},
        "offline": offline,
        "storage": storage_info,
        "note": (
            "High-res FFT 170–270 Hz (Δf=1 Hz). "
            "Sloupec ≈ 3 s energy average. Trvalá čára = tonální složka."
        ),
    }


@app.get("/api/v1/spectrum/fine-lf/history")
def spectrum_fine_lf_history(
    hours: float = Query(default=6, ge=0.1, le=24 * 90),
    start: float | None = Query(
        default=None,
        description="Unix začátek okna; bez něj končí okno na teď (živě).",
    ),
    device_id: str = Query(default="hlukomer"),
    max_columns: int = Query(default=360, ge=10, le=2000),
) -> dict[str, Any]:
    """Heatmapa high-res FFT 25–70 Hz (1 Hz bins, 3 s energy average)."""
    now = utc_now()
    span = hours * 3600
    if start is None:
        t_end = now
        t_start = t_end - span
    else:
        t_start = float(start)
        t_end = t_start + span
        if t_start >= now:
            raise HTTPException(status_code=400, detail="start must be in the past")
        if t_end > now:
            t_end = now
        if t_end <= t_start:
            raise HTTPException(status_code=400, detail="empty time window")

    with db() as conn:
        complete = storage.fetch_spectrum_fine_lf_columns_raw(
            conn, device_id, t_start, t_end
        )
    columns, vmin, vmax = downsample_spectrum_columns(complete, max_columns)
    with db() as conn:
        offline = fetch_offline_stats(conn, device_id, t_start, t_end)
        storage_info = {
            "hot_retention_hours": storage.HOT_RETENTION_HOURS,
            "archive_interval_s": storage.ARCHIVE_INTERVAL_S,
            "fine_integrate_s": storage.FINE_FFT_INTEGRATE_S,
            "resolution": f"{storage.FINE_FFT_INTEGRATE_S}s",
        }
    night_bands, sun_source = build_night_bands(t_start, t_end)
    return {
        "device_id": device_id,
        "hours": hours,
        "start": round(t_start, 3),
        "end": round(t_end, 3),
        "bands": list(FINE_LF_SPECTRUM_BANDS),
        "labels": list(FINE_LF_SPECTRUM_LABELS),
        "hz": list(FINE_LF_SPECTRUM_HZ),
        "bandwidth_hz": storage.FINE_FFT_DF_HZ,
        "df_hz": storage.FINE_FFT_DF_HZ,
        "integrate_s": storage.FINE_FFT_INTEGRATE_S,
        "kind": "fft",
        "columns": columns,
        "vmin": round(vmin, 1) if vmin is not None else None,
        "vmax": round(vmax, 1) if vmax is not None else None,
        "night_bands": night_bands,
        "limit_change_edges": build_limit_change_edges(t_start, t_end),
        "sun": {"source": sun_source},
        "offline": offline,
        "storage": storage_info,
        "note": (
            "High-res FFT 25–70 Hz (Δf=1 Hz). "
            "Sloupec ≈ 3 s energy average. Trvalá čára = tonální složka "
            "(např. 50 Hz síť, 25/63 Hz VZT)."
        ),
    }


@app.get("/api/v1/spectrum/at")
def spectrum_at(
    ts: float = Query(..., description="Unix timestamp okamžiku"),
    device_id: str = Query(default="hlukomer"),
) -> dict[str, Any]:
    """Oktávové spektrum (pseudo-FFT) v daném okamžiku."""
    with db() as conn:
        spectrum = fetch_spectrum_at(conn, device_id, ts)
    if not spectrum:
        raise HTTPException(status_code=404, detail="No spectrum near that timestamp")
    return {"device_id": device_id, "spectrum": spectrum}


@app.get("/api/v1/history")
def history(
    metric: str = Query(default="laeq_1s"),
    hours: float = Query(default=24, ge=0.1, le=24 * 90),
    start: float | None = Query(
        default=None,
        description="Unix začátek okna; bez něj končí okno na teď (živě).",
    ),
    device_id: str = Query(default="hlukomer"),
    max_points: int = Query(default=2000, ge=50, le=10000),
) -> dict[str, Any]:
    """Okno je [start, start+hours]. Bez `start` je start = now − hours (živý konec)."""
    allowed = {"laeq_1s", "laeq_1min", "lamax_1min", "lamin_1min"}
    if metric not in allowed:
        raise HTTPException(status_code=400, detail=f"metric must be one of {sorted(allowed)}")

    now = utc_now()
    span = hours * 3600
    if start is None:
        t_end = now
        t_start = t_end - span
    else:
        t_start = float(start)
        t_end = t_start + span
        if t_start >= now:
            raise HTTPException(status_code=400, detail="start must be in the past")
        if t_end > now:
            t_end = now
        if t_end <= t_start:
            raise HTTPException(status_code=400, detail="empty time window")

    with db() as conn:
        points = storage.fetch_metric_points(conn, device_id, metric, t_start, t_end)

    if len(points) > max_points:
        points = downsample(points, max_points)

    values = [p["v"] for p in points]
    stats: dict[str, Any] = {}
    if values:
        excesses: list[float] = []
        above = 0
        for p in points:
            lim = threshold_at(p["t"])
            if p["v"] >= lim:
                above += 1
                excesses.append(float(p["v"]) - float(lim))
        stats = {
            "min": min(values),
            "max": max(values),
            "avg": sum(values) / len(values),
            "count": len(values),
            "above_threshold_pct": 100.0 * above / len(values),
            "avg_excess_db": (sum(excesses) / len(excesses)) if excesses else 0.0,
        }

    meta = threshold_meta()
    night_bands, sun_source = build_night_bands(t_start, t_end)
    ac_cfg = aircraft_svc.get_config()
    return {
        "metric": metric,
        "device_id": device_id,
        "hours": hours,
        "start": round(t_start, 3),
        "end": round(t_end, 3),
        "threshold_dba": meta["alert_threshold_dba"],
        "alert_period": meta["alert_period"],
        "thresholds": meta["thresholds"],
        "threshold_points": build_threshold_line(t_start, t_end),
        "night_bands": night_bands,
        "sun": {"source": sun_source},
        "weather_timeline": fetch_weather_timeline(t_start, t_end, hours),
        "aircraft_overflights": (
            fetch_aircraft_overflights(t_start, t_end) if ac_cfg.show_ui else []
        ),
        "aircraft": {
            "enabled": ac_cfg.enabled,
            "show_ui": ac_cfg.show_ui,
            "source": "opensky",
            "max_altitude_m": ac_cfg.max_altitude_m,
            "max_distance_km": ac_cfg.max_distance_km,
        },
        "points": points,
        "stats": stats,
    }


@app.get("/api/v1/aircraft")
def aircraft_status() -> dict[str, Any]:
    """Stav OpenSky pollu (debug)."""
    return aircraft_svc.status_payload()


@app.get("/api/v1/weather")
def weather() -> dict[str, Any]:
    """Aktuální počasí + faktory zkreslení hlasitosti (MET Norway)."""
    return weather_svc.weather_payload(TZ)


@app.get("/api/v1/stats")
def stats(
    hours: float = Query(default=24, ge=1, le=24 * 90),
    device_id: str = Query(default="hlukomer"),
) -> dict[str, Any]:
    since = utc_now() - hours * 3600
    result: dict[str, Any] = {"hours": hours, "device_id": device_id, "metrics": {}}
    with db() as conn:
        for metric in ("laeq_1s", "laeq_1min", "lamax_1min", "lamin_1min"):
            st = storage.metric_stats(conn, device_id, metric, since)
            if st:
                result["metrics"][metric] = st
    return result


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "static_rev": static_rev()}


@app.get("/api/admin/storage")
def admin_storage(_: None = Depends(require_admin_session)) -> dict[str, Any]:
    with db() as conn:
        return storage.storage_status(conn)


@app.post("/api/admin/storage/vacuum")
def admin_storage_vacuum(_: None = Depends(require_admin_session)) -> dict[str, Any]:
    """Blokující VACUUM — spouštět off-peak."""
    conn = sqlite3.connect(DB_PATH, timeout=120)
    try:
        conn.execute("VACUUM")
    finally:
        conn.close()
    return {"ok": True}


@app.post("/api/admin/login")
def admin_login(body: AdminLogin, response: Response) -> dict[str, str]:
    provided = hashlib.sha256(body.password.encode("utf-8")).digest()
    expected = hashlib.sha256(ADMIN_PASSWORD.encode("utf-8")).digest()
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Neplatné heslo")
    _set_admin_cookie(response, _create_admin_token())
    return {"status": "ok"}


@app.post("/api/admin/logout")
def admin_logout(response: Response) -> dict[str, str]:
    _clear_admin_cookie(response)
    return {"status": "ok"}


@app.get("/api/admin/session")
def admin_session(_: None = Depends(require_admin_session)) -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/admin/backup")
def admin_backup(_: None = Depends(require_admin_session)) -> FileResponse:
    """Konzistentní hot-copy přes sqlite3.backup() (bezpečné i při ingestu)."""
    if not DB_PATH.exists():
        raise HTTPException(status_code=404, detail="Databáze neexistuje")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        delete=False, dir=DATA_DIR, suffix=".backup.db"
    ) as tmp:
        tmp_path = Path(tmp.name)

    try:
        src = sqlite3.connect(DB_PATH, timeout=60)
        try:
            dst = sqlite3.connect(tmp_path)
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
    except sqlite3.Error as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Záloha selhala") from exc

    return FileResponse(
        path=tmp_path,
        filename="hlukomer.db",
        media_type="application/octet-stream",
        background=BackgroundTask(tmp_path.unlink, missing_ok=True),
    )


@app.post("/api/admin/restore")
async def admin_restore(
    request: Request,
    _: None = Depends(require_admin_session),
) -> dict[str, str]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Prázdný soubor")

    with tempfile.NamedTemporaryFile(delete=False, dir=DATA_DIR, suffix=".db") as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(body)

    try:
        probe = sqlite3.connect(f"file:{tmp_path}?mode=ro", uri=True)
        try:
            probe.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        finally:
            probe.close()
    except sqlite3.Error as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Neplatný SQLite soubor") from exc

    # Nahradit DB včetně případných WAL/SHM souborů
    for side in (Path(str(DB_PATH) + "-wal"), Path(str(DB_PATH) + "-shm")):
        side.unlink(missing_ok=True)
    shutil.move(str(tmp_path), str(DB_PATH))
    # Starší backup nemusí mít novější tabulky (aircraft_overflights, …)
    ensure_db()
    return {"status": "ok"}


def downsample(points: list[dict[str, float]], max_points: int) -> list[dict[str, float]]:
    """Jednoduchý LTTB-like bucket average pro graf."""
    if len(points) <= max_points:
        return points
    bucket_size = len(points) / max_points
    out: list[dict[str, float]] = []
    i = 0.0
    while int(i) < len(points):
        start = int(i)
        end = min(int(i + bucket_size), len(points))
        chunk = points[start:end]
        if not chunk:
            break
        t = sum(p["t"] for p in chunk) / len(chunk)
        v = sum(p["v"] for p in chunk) / len(chunk)
        out.append({"t": t, "v": v})
        i += bucket_size
    return out


@app.get("/")
def index() -> HTMLResponse:
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = re.sub(
        r"/static/style\.css\?v=[^\"']+",
        f"/static/style.css?v={_static_file_v('style.css')}",
        html,
        count=1,
    )
    html = re.sub(
        r"/static/app\.js\?v=[^\"']+",
        f"/static/app.js?v={_static_file_v('app.js')}",
        html,
        count=1,
    )
    config = {
        "window_correction_db": DISPLAY_WINDOW_CORRECTION_DB,
        "tonal_penalty_db": DISPLAY_TONAL_PENALTY_DB,
    }
    config_script = (
        "<script>"
        f"window.__DISPLAY_CONFIG={json.dumps(config, separators=(',', ':'))};"
        f"window.__STATIC_REV={json.dumps(static_rev())};"
        "</script>"
    )
    if "<!-- DISPLAY_CONFIG -->" in html:
        html = html.replace("<!-- DISPLAY_CONFIG -->", config_script, 1)
    else:
        html = html.replace("</head>", f"{config_script}\n</head>", 1)
    tracker_script = TIANJI_TRACKER_SCRIPT if APP_ENV == "PROD" else ""
    if "<!-- TRACKER_SCRIPT -->" in html:
        html = html.replace("<!-- TRACKER_SCRIPT -->", tracker_script, 1)
    elif tracker_script:
        html = html.replace("</head>", f"{tracker_script}\n</head>", 1)
    return HTMLResponse(html, headers=_NO_STORE_HEADERS)


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.png", media_type="image/png")


@app.get("/admin")
def admin_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "admin.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
