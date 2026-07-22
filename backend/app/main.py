"""Hlukoměr API — příjem měření z ESPHome a historie pro dashboard."""

from __future__ import annotations

import math
import os
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "hlukomer.db"
INGEST_API_KEY = os.getenv("INGEST_API_KEY", "changeme")
# Denní limit 6:00–22:00, jinak noční klid
ALERT_DAY_DBA = float(os.getenv("ALERT_DAY_DBA", "45"))
ALERT_NIGHT_DBA = float(os.getenv("ALERT_NIGHT_DBA", "40"))
ALERT_DAY_START_HOUR = int(os.getenv("ALERT_DAY_START_HOUR", "6"))
ALERT_DAY_END_HOUR = int(os.getenv("ALERT_DAY_END_HOUR", "22"))
TZ_NAME = os.getenv("TZ", "Europe/Prague")
TZ = ZoneInfo(TZ_NAME)
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "90"))
LIVE_RETENTION_DAYS = int(os.getenv("LIVE_RETENTION_DAYS", "7"))

STATIC_DIR = Path(__file__).parent / "static"

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
# LFI ≈ 20–200 Hz → 1/3-oktávy 25…200 Hz
LFI_BAND_INDEXES: tuple[int, ...] = tuple(
    i for i, hz in enumerate(SPECTRUM_HZ) if 20.0 <= hz <= 200.0
)
# HVAC typicky do 250 Hz
HVAC_BAND_INDEXES: tuple[int, ...] = tuple(
    i for i, hz in enumerate(SPECTRUM_HZ) if hz <= 250.0
)
HVAC_MAX_INDEX = max(HVAC_BAND_INDEXES) if HVAC_BAND_INDEXES else 0

# Legacy 10 oktáv (starší ESP firmware) — stále přijímáme při ingestu
LEGACY_SPECTRUM_BANDS: tuple[str, ...] = (
    "31",
    "63",
    "125",
    "250",
    "500",
    "1k",
    "2k",
    "4k",
    "8k",
    "16k",
)
LEGACY_SPECTRUM_METRICS: tuple[str, ...] = tuple(f"oct_{b}" for b in LEGACY_SPECTRUM_BANDS)

LIVE_METRICS = frozenset(
    {"laeq_1s", "lez_1s", "lfi_db", *SPECTRUM_METRICS, *LEGACY_SPECTRUM_METRICS}
)

app = FastAPI(title="Hlukoměr", version="1.1.0")


def _db_to_energy(db: float) -> float:
    return 10.0 ** (db / 10.0)


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


def build_threshold_line(t0: float, t1: float) -> list[dict[str, float]]:
    """Schodová řada limitu pro graf (denní / noční)."""
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
                points.append({"t": ts, "v": threshold_at(ts)})
        day += timedelta(days=1)
    if points[-1]["t"] < t1:
        points.append({"t": t1, "v": threshold_at(t1)})
    return points


class IngestPayload(BaseModel):
    device_id: str = Field(default="hlukomer", max_length=64)
    kind: str = Field(default="live", pattern="^(live|minute)$")
    laeq_1s: Optional[float] = None
    lez_1s: Optional[float] = None  # LZeq bez A-vážení
    lfi_db: Optional[float] = None  # přímý LFI 20–200 Hz z ESP
    laeq_1min: Optional[float] = None
    lamax_1min: Optional[float] = None
    lamin_1min: Optional[float] = None
    # 17 pásem (nové) nebo 10 oktáv (legacy ESP)
    spectrum: Optional[list[float]] = Field(default=None, max_length=17)
    ts: Optional[float] = None  # unix seconds; default = server time


def utc_now() -> float:
    return time.time()


def ensure_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                device_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                metric TEXT NOT NULL,
                value REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_meas_ts_metric
                ON measurements(metric, ts);
            CREATE INDEX IF NOT EXISTS idx_meas_device_ts
                ON measurements(device_id, ts);
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
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


def insert_metric(
    conn: sqlite3.Connection,
    ts: float,
    device_id: str,
    kind: str,
    metric: str,
    value: float,
) -> None:
    if value != value:  # NaN
        return
    if value < -50 or value > 200:
        return
    conn.execute(
        "INSERT INTO measurements (ts, device_id, kind, metric, value) VALUES (?,?,?,?,?)",
        (ts, device_id, kind, metric, value),
    )


@app.on_event("startup")
def on_startup() -> None:
    ensure_db()
    prune_old()


def prune_old() -> None:
    now = utc_now()
    cutoff_all = now - RETENTION_DAYS * 86400
    cutoff_live = now - LIVE_RETENTION_DAYS * 86400
    with db() as conn:
        conn.execute("DELETE FROM measurements WHERE ts < ?", (cutoff_all,))
        placeholders = ",".join("?" * len(LIVE_METRICS))
        conn.execute(
            f"DELETE FROM measurements WHERE metric IN ({placeholders}) AND ts < ?",
            (*LIVE_METRICS, cutoff_live),
        )


def latest_metric_value(
    conn: sqlite3.Connection, device_id: str, metric: str
) -> Optional[tuple[float, float]]:
    row = conn.execute(
        """
        SELECT ts, value FROM measurements
        WHERE device_id = ? AND metric = ?
        ORDER BY ts DESC LIMIT 1
        """,
        (device_id, metric),
    ).fetchone()
    if not row:
        return None
    return float(row["ts"]), float(row["value"])


@app.post("/api/v1/ingest")
def ingest(payload: IngestPayload, _: None = Depends(require_api_key)) -> dict[str, Any]:
    metrics_for_spectrum: Optional[tuple[str, ...]] = None
    if payload.spectrum is not None:
        n = len(payload.spectrum)
        if n == len(SPECTRUM_BANDS):
            metrics_for_spectrum = SPECTRUM_METRICS
        elif n == len(LEGACY_SPECTRUM_BANDS):
            metrics_for_spectrum = LEGACY_SPECTRUM_METRICS
        else:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"spectrum must have {len(SPECTRUM_BANDS)} values "
                    f"(or legacy {len(LEGACY_SPECTRUM_BANDS)})"
                ),
            )
    ts = payload.ts if payload.ts is not None else utc_now()
    written = 0
    with db() as conn:
        pairs = [
            ("laeq_1s", payload.laeq_1s),
            ("lez_1s", payload.lez_1s),
            ("lfi_db", payload.lfi_db),
            ("laeq_1min", payload.laeq_1min),
            ("lamax_1min", payload.lamax_1min),
            ("lamin_1min", payload.lamin_1min),
        ]
        for metric, value in pairs:
            if value is None:
                continue
            insert_metric(conn, ts, payload.device_id, payload.kind, metric, float(value))
            written += 1
        if payload.spectrum and metrics_for_spectrum:
            for metric, value in zip(metrics_for_spectrum, payload.spectrum):
                insert_metric(conn, ts, payload.device_id, payload.kind, metric, float(value))
                written += 1
    if written == 0:
        raise HTTPException(status_code=400, detail="No metric values provided")
    return {"ok": True, "written": written, "ts": ts}


def fetch_spectrum(conn: sqlite3.Connection, device_id: str) -> Optional[dict[str, Any]]:
    values: list[Optional[float]] = [None] * len(SPECTRUM_METRICS)
    latest_ts: Optional[float] = None
    for i, metric in enumerate(SPECTRUM_METRICS):
        row = conn.execute(
            """
            SELECT ts, value FROM measurements
            WHERE device_id = ? AND metric = ?
            ORDER BY ts DESC LIMIT 1
            """,
            (device_id, metric),
        ).fetchone()
        if not row:
            continue
        latest_ts = row["ts"] if latest_ts is None else max(latest_ts, row["ts"])
        values[i] = float(row["value"])
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
    # použij ESP metriky jen pokud jsou zhruba ze stejného okamžiku
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
    values: list[Optional[float]] = [None] * len(SPECTRUM_METRICS)
    used_ts: Optional[float] = None
    for i, metric in enumerate(SPECTRUM_METRICS):
        row = conn.execute(
            """
            SELECT ts, value FROM measurements
            WHERE device_id = ? AND metric = ? AND ts BETWEEN ? AND ?
            ORDER BY ABS(ts - ?) ASC LIMIT 1
            """,
            (device_id, metric, ts - tolerance, ts + tolerance, ts),
        ).fetchone()
        if not row:
            return None
        values[i] = float(row["value"])
        used_ts = row["ts"] if used_ts is None else used_ts
    if any(v is None for v in values) or used_ts is None:
        return None

    def near(metric: str) -> Optional[float]:
        row = conn.execute(
            """
            SELECT value FROM measurements
            WHERE device_id = ? AND metric = ? AND ts BETWEEN ? AND ?
            ORDER BY ABS(ts - ?) ASC LIMIT 1
            """,
            (device_id, metric, used_ts - tolerance, used_ts + tolerance, used_ts),
        ).fetchone()
        return float(row["value"]) if row else None

    analysis = analyze_spectrum(
        [float(v) for v in values],  # type: ignore[arg-type]
        lez_1s=near("lez_1s"),
        lfi_db_direct=near("lfi_db"),
    )
    return {"ts": used_ts, **analysis}


def pivot_spectrum_rows(
    rows: list[sqlite3.Row],
    max_columns: int,
    metrics: tuple[str, ...] = SPECTRUM_METRICS,
) -> tuple[list[dict[str, Any]], Optional[float], Optional[float]]:
    """Seskupí řádky metric/ts/value do sloupců spectrogramu."""
    by_ts: dict[float, dict[str, float]] = {}
    for r in rows:
        bucket = by_ts.setdefault(r["ts"], {})
        bucket[r["metric"]] = float(r["value"])

    complete: list[tuple[float, list[float]]] = []
    for ts in sorted(by_ts):
        band_map = by_ts[ts]
        if not all(m in band_map for m in metrics):
            continue
        complete.append((ts, [band_map[m] for m in metrics]))

    if not complete:
        return [], None, None

    n_bands = len(metrics)
    if len(complete) > max_columns:
        bucket_size = len(complete) / max_columns
        down: list[tuple[float, list[float]]] = []
        i = 0.0
        while int(i) < len(complete):
            start = int(i)
            end = min(int(i + bucket_size), len(complete))
            chunk = complete[start:end]
            if not chunk:
                break
            t = sum(c[0] for c in chunk) / len(chunk)
            avg_vals: list[float] = []
            for bi in range(n_bands):
                e = sum(_db_to_energy(c[1][bi]) for c in chunk) / len(chunk)
                avg_vals.append(10.0 * math.log10(e) if e > 0 else chunk[0][1][bi])
            down.append((t, avg_vals))
            i += bucket_size
        complete = down

    all_vals = [v for _, vals in complete for v in vals]
    vmin = min(all_vals)
    vmax = max(all_vals)
    columns = [{"t": t, "v": [round(x, 1) for x in vals]} for t, vals in complete]
    return columns, vmin, vmax


@app.get("/api/v1/latest")
def latest(device_id: str = Query(default="hlukomer")) -> dict[str, Any]:
    metrics = ("laeq_1s", "lez_1s", "lfi_db", "laeq_1min", "lamax_1min", "lamin_1min")
    out: dict[str, Any] = {"device_id": device_id, "metrics": {}, **threshold_meta()}
    with db() as conn:
        for metric in metrics:
            row = conn.execute(
                """
                SELECT ts, value FROM measurements
                WHERE device_id = ? AND metric = ?
                ORDER BY ts DESC LIMIT 1
                """,
                (device_id, metric),
            ).fetchone()
            if row:
                out["metrics"][metric] = {
                    "value": row["value"],
                    "ts": row["ts"],
                    "iso": datetime.fromtimestamp(row["ts"], tz=timezone.utc).isoformat(),
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
        age_row = conn.execute(
            "SELECT MAX(ts) AS ts FROM measurements WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        last_ts = age_row["ts"] if age_row else None
        out["online"] = bool(last_ts and (utc_now() - last_ts) < 30)
        out["last_seen"] = last_ts
    return out


@app.get("/api/v1/spectrum/history")
def spectrum_history(
    hours: float = Query(default=6, ge=0.1, le=24 * 7),
    device_id: str = Query(default="hlukomer"),
    max_columns: int = Query(default=360, ge=10, le=2000),
) -> dict[str, Any]:
    """Heatmapa spektra v čase — sloupce = okamžiky, řádky = frekvenční pásma."""
    since = utc_now() - hours * 3600
    placeholders = ",".join("?" * len(SPECTRUM_METRICS))
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT ts, metric, value FROM measurements
            WHERE device_id = ? AND metric IN ({placeholders}) AND ts >= ?
            ORDER BY ts ASC
            """,
            (device_id, *SPECTRUM_METRICS, since),
        ).fetchall()
    columns, vmin, vmax = pivot_spectrum_rows(rows, max_columns, SPECTRUM_METRICS)
    bands = list(SPECTRUM_BANDS)
    labels = list(SPECTRUM_LABELS)
    hz = list(SPECTRUM_HZ)
    note = "1/3-oktáva 25–250 Hz + oktávy výš (IIR). Trvalá čára = tón (např. 50/63 Hz)."
    if not columns:
        # Do přeflashování ESP: legacy 10 oktáv
        leg_ph = ",".join("?" * len(LEGACY_SPECTRUM_METRICS))
        with db() as conn:
            leg_rows = conn.execute(
                f"""
                SELECT ts, metric, value FROM measurements
                WHERE device_id = ? AND metric IN ({leg_ph}) AND ts >= ?
                ORDER BY ts ASC
                """,
                (device_id, *LEGACY_SPECTRUM_METRICS, since),
            ).fetchall()
        columns, vmin, vmax = pivot_spectrum_rows(
            leg_rows, max_columns, LEGACY_SPECTRUM_METRICS
        )
        if columns:
            bands = list(LEGACY_SPECTRUM_BANDS)
            labels = [
                "31 Hz",
                "63 Hz",
                "125 Hz",
                "250 Hz",
                "500 Hz",
                "1 kHz",
                "2 kHz",
                "4 kHz",
                "8 kHz",
                "16 kHz",
            ]
            hz = [31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0]
            note = "Legacy 10 oktáv (starý firmware). Po flashi ESP uvidíš 1/3-oktávu v basu."
    return {
        "device_id": device_id,
        "hours": hours,
        "bands": bands,
        "labels": labels,
        "hz": hz,
        "columns": columns,
        "vmin": round(vmin, 1) if vmin is not None else None,
        "vmax": round(vmax, 1) if vmax is not None else None,
        "note": note,
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
    device_id: str = Query(default="hlukomer"),
    max_points: int = Query(default=2000, ge=50, le=10000),
) -> dict[str, Any]:
    allowed = {"laeq_1s", "laeq_1min", "lamax_1min", "lamin_1min"}
    if metric not in allowed:
        raise HTTPException(status_code=400, detail=f"metric must be one of {sorted(allowed)}")

    since = utc_now() - hours * 3600
    with db() as conn:
        rows = conn.execute(
            """
            SELECT ts, value FROM measurements
            WHERE device_id = ? AND metric = ? AND ts >= ?
            ORDER BY ts ASC
            """,
            (device_id, metric, since),
        ).fetchall()

    points = [{"t": r["ts"], "v": r["value"]} for r in rows]
    if len(points) > max_points:
        points = downsample(points, max_points)

    values = [p["v"] for p in points]
    stats: dict[str, Any] = {}
    if values:
        above = sum(1 for p in points if p["v"] >= threshold_at(p["t"]))
        stats = {
            "min": min(values),
            "max": max(values),
            "avg": sum(values) / len(values),
            "count": len(values),
            "above_threshold_pct": 100.0 * above / len(values),
        }

    t0 = points[0]["t"] if points else since
    t1 = points[-1]["t"] if points else utc_now()
    meta = threshold_meta()
    return {
        "metric": metric,
        "device_id": device_id,
        "hours": hours,
        "threshold_dba": meta["alert_threshold_dba"],
        "alert_period": meta["alert_period"],
        "thresholds": meta["thresholds"],
        "threshold_points": build_threshold_line(t0, t1),
        "points": points,
        "stats": stats,
    }


@app.get("/api/v1/stats")
def stats(
    hours: float = Query(default=24, ge=1, le=24 * 90),
    device_id: str = Query(default="hlukomer"),
) -> dict[str, Any]:
    since = utc_now() - hours * 3600
    result: dict[str, Any] = {"hours": hours, "device_id": device_id, "metrics": {}}
    with db() as conn:
        for metric in ("laeq_1s", "laeq_1min", "lamax_1min", "lamin_1min"):
            row = conn.execute(
                """
                SELECT
                    COUNT(*) AS n,
                    MIN(value) AS vmin,
                    MAX(value) AS vmax,
                    AVG(value) AS vavg
                FROM measurements
                WHERE device_id = ? AND metric = ? AND ts >= ?
                """,
                (device_id, metric, since),
            ).fetchone()
            if row and row["n"]:
                result["metrics"][metric] = {
                    "count": row["n"],
                    "min": row["vmin"],
                    "max": row["vmax"],
                    "avg": row["vavg"],
                }
    return result


@app.get("/api/health")
def health() -> dict[str, str]:
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
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
