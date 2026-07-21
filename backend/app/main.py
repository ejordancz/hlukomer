"""Hlukoměr API — příjem měření z ESPHome a historie pro dashboard."""

from __future__ import annotations

import os
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "hlukomer.db"
INGEST_API_KEY = os.getenv("INGEST_API_KEY", "changeme")
ALERT_THRESHOLD_DBA = float(os.getenv("ALERT_THRESHOLD_DBA", "55"))
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "90"))
LIVE_RETENTION_DAYS = int(os.getenv("LIVE_RETENTION_DAYS", "7"))

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Hlukoměr", version="1.0.0")


class IngestPayload(BaseModel):
    device_id: str = Field(default="hlukomer", max_length=64)
    kind: str = Field(default="live", pattern="^(live|minute)$")
    laeq_1s: Optional[float] = None
    laeq_1min: Optional[float] = None
    lamax_1min: Optional[float] = None
    lamin_1min: Optional[float] = None
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
        conn.execute(
            "DELETE FROM measurements WHERE metric = 'laeq_1s' AND ts < ?",
            (cutoff_live,),
        )


@app.post("/api/v1/ingest")
def ingest(payload: IngestPayload, _: None = Depends(require_api_key)) -> dict[str, Any]:
    ts = payload.ts if payload.ts is not None else utc_now()
    written = 0
    with db() as conn:
        pairs = [
            ("laeq_1s", payload.laeq_1s),
            ("laeq_1min", payload.laeq_1min),
            ("lamax_1min", payload.lamax_1min),
            ("lamin_1min", payload.lamin_1min),
        ]
        for metric, value in pairs:
            if value is None:
                continue
            insert_metric(conn, ts, payload.device_id, payload.kind, metric, float(value))
            written += 1
    if written == 0:
        raise HTTPException(status_code=400, detail="No metric values provided")
    return {"ok": True, "written": written, "ts": ts}


@app.get("/api/v1/latest")
def latest(device_id: str = Query(default="hlukomer")) -> dict[str, Any]:
    metrics = ("laeq_1s", "laeq_1min", "lamax_1min", "lamin_1min")
    out: dict[str, Any] = {"device_id": device_id, "metrics": {}, "alert_threshold_dba": ALERT_THRESHOLD_DBA}
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
        age_row = conn.execute(
            "SELECT MAX(ts) AS ts FROM measurements WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        last_ts = age_row["ts"] if age_row else None
        out["online"] = bool(last_ts and (utc_now() - last_ts) < 30)
        out["last_seen"] = last_ts
    return out


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
        stats = {
            "min": min(values),
            "max": max(values),
            "avg": sum(values) / len(values),
            "count": len(values),
            "above_threshold_pct": 100.0 * sum(1 for v in values if v >= ALERT_THRESHOLD_DBA) / len(values),
        }

    return {
        "metric": metric,
        "device_id": device_id,
        "hours": hours,
        "threshold_dba": ALERT_THRESHOLD_DBA,
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
