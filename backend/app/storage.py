"""Wide storage (samples_1s / samples_5s / samples_minute) + hot/cold archive."""

from __future__ import annotations

import logging
import math
import os
import sqlite3
import threading
import time
from typing import Any, Callable, Optional

logger = logging.getLogger("hlukomer.storage")

RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "90"))
HOT_RETENTION_HOURS = float(os.getenv("HOT_RETENTION_HOURS", "48"))
ARCHIVE_INTERVAL_S = int(os.getenv("ARCHIVE_INTERVAL_S", "5"))
if ARCHIVE_INTERVAL_S not in (5, 10):
    logger.warning(
        "ARCHIVE_INTERVAL_S=%s není 5 ani 10 — používám 5", ARCHIVE_INTERVAL_S
    )
    ARCHIVE_INTERVAL_S = 5
ARCHIVE_JOB_INTERVAL_S = int(os.getenv("ARCHIVE_JOB_INTERVAL_S", "300"))

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
SPECTRUM_COLS: tuple[str, ...] = tuple(f"oct_{b}" for b in SPECTRUM_BANDS)

LIVE_VALUE_COLS: tuple[str, ...] = ("laeq_1s", "lez_1s", "lfi_db", *SPECTRUM_COLS)
MINUTE_COLS: tuple[str, ...] = ("laeq_1min", "lamax_1min", "lamin_1min")

META_ARCHIVE_RUN = "archive_last_run"

_COL_LIST_1S = ", ".join(("ts", "device_id", *LIVE_VALUE_COLS))
_COL_LIST_5S = ", ".join(("ts", "device_id", *LIVE_VALUE_COLS, "n_src"))
_COL_LIST_MIN = ", ".join(("ts", "device_id", *MINUTE_COLS))

_archive_thread: Optional[threading.Thread] = None
_stop = threading.Event()
_DbFactory = Callable[[], Any]


def db_to_energy(db: float) -> float:
    return 10.0 ** (db / 10.0)


def energy_average(values: list[float]) -> Optional[float]:
    if not values:
        return None
    e = sum(db_to_energy(v) for v in values) / len(values)
    return 10.0 * math.log10(e) if e > 0 else values[0]


def sanitize_value(value: float) -> Optional[float]:
    if value != value:  # NaN
        return None
    if value < -50 or value > 200:
        return None
    return float(value)


def hot_cutoff(now: Optional[float] = None) -> float:
    t = now if now is not None else time.time()
    return t - HOT_RETENTION_HOURS * 3600.0


def bucket_start(ts: float, interval_s: int = ARCHIVE_INTERVAL_S) -> float:
    return math.floor(ts / interval_s) * interval_s


def get_meta(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    return str(row["value"] if isinstance(row, sqlite3.Row) else row[0])


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return row is not None


def ensure_wide_tables(conn: sqlite3.Connection) -> None:
    cols_1s = ",\n                ".join(f"{c} REAL" for c in LIVE_VALUE_COLS)
    cols_5s = cols_1s + ",\n                n_src INTEGER NOT NULL DEFAULT 1"
    cols_min = ",\n                ".join(f"{c} REAL" for c in MINUTE_COLS)
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS samples_1s (
            ts REAL NOT NULL,
            device_id TEXT NOT NULL,
            {cols_1s},
            PRIMARY KEY (device_id, ts)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS samples_5s (
            ts REAL NOT NULL,
            device_id TEXT NOT NULL,
            {cols_5s},
            PRIMARY KEY (device_id, ts)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS samples_minute (
            ts REAL NOT NULL,
            device_id TEXT NOT NULL,
            {cols_min},
            PRIMARY KEY (device_id, ts)
        ) WITHOUT ROWID;
        """
    )


def upsert_sample_1s(
    conn: sqlite3.Connection,
    ts: float,
    device_id: str,
    values: dict[str, Optional[float]],
) -> int:
    """Zapíše live wide řádek. Vrací počet ne-NULL polí."""
    cleaned: dict[str, Optional[float]] = {}
    written = 0
    for col in LIVE_VALUE_COLS:
        raw = values.get(col)
        if raw is None:
            cleaned[col] = None
            continue
        v = sanitize_value(float(raw))
        cleaned[col] = v
        if v is not None:
            written += 1
    if written == 0:
        return 0

    placeholders = ", ".join("?" for _ in range(2 + len(LIVE_VALUE_COLS)))
    updates = ", ".join(
        f"{c}=COALESCE(excluded.{c}, samples_1s.{c})" for c in LIVE_VALUE_COLS
    )
    conn.execute(
        f"""
        INSERT INTO samples_1s ({_COL_LIST_1S})
        VALUES ({placeholders})
        ON CONFLICT(device_id, ts) DO UPDATE SET {updates}
        """,
        (ts, device_id, *[cleaned[c] for c in LIVE_VALUE_COLS]),
    )
    return written


def upsert_minute(
    conn: sqlite3.Connection,
    ts: float,
    device_id: str,
    values: dict[str, Optional[float]],
) -> int:
    cleaned: dict[str, Optional[float]] = {}
    written = 0
    for col in MINUTE_COLS:
        raw = values.get(col)
        if raw is None:
            cleaned[col] = None
            continue
        v = sanitize_value(float(raw))
        cleaned[col] = v
        if v is not None:
            written += 1
    if written == 0:
        return 0
    placeholders = ", ".join("?" for _ in range(2 + len(MINUTE_COLS)))
    updates = ", ".join(
        f"{c}=COALESCE(excluded.{c}, samples_minute.{c})" for c in MINUTE_COLS
    )
    conn.execute(
        f"""
        INSERT INTO samples_minute ({_COL_LIST_MIN})
        VALUES ({placeholders})
        ON CONFLICT(device_id, ts) DO UPDATE SET {updates}
        """,
        (ts, device_id, *[cleaned[c] for c in MINUTE_COLS]),
    )
    return written


def ingest_live(
    conn: sqlite3.Connection,
    ts: float,
    device_id: str,
    *,
    laeq_1s: Optional[float] = None,
    lez_1s: Optional[float] = None,
    lfi_db: Optional[float] = None,
    spectrum: Optional[list[float]] = None,
    spectrum_cols: Optional[tuple[str, ...]] = None,
) -> int:
    values: dict[str, Optional[float]] = {
        "laeq_1s": laeq_1s,
        "lez_1s": lez_1s,
        "lfi_db": lfi_db,
    }
    if spectrum is not None and spectrum_cols is not None:
        for col, val in zip(spectrum_cols, spectrum):
            values[col] = val
    return upsert_sample_1s(conn, ts, device_id, values)


def latest_row_1s(
    conn: sqlite3.Connection, device_id: str
) -> Optional[sqlite3.Row]:
    return conn.execute(
        f"""
        SELECT {_COL_LIST_1S} FROM samples_1s
        WHERE device_id = ?
        ORDER BY ts DESC LIMIT 1
        """,
        (device_id,),
    ).fetchone()


def latest_metric(
    conn: sqlite3.Connection, device_id: str, metric: str
) -> Optional[tuple[float, float]]:
    if metric in LIVE_VALUE_COLS:
        row = conn.execute(
            f"""
            SELECT ts, {metric} AS value FROM samples_1s
            WHERE device_id = ? AND {metric} IS NOT NULL
            ORDER BY ts DESC LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if row:
            return float(row["ts"]), float(row["value"])
        # cold fallback
        row = conn.execute(
            f"""
            SELECT ts, {metric} AS value FROM samples_5s
            WHERE device_id = ? AND {metric} IS NOT NULL
            ORDER BY ts DESC LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if row:
            return float(row["ts"]), float(row["value"])
    elif metric in MINUTE_COLS:
        row = conn.execute(
            f"""
            SELECT ts, {metric} AS value FROM samples_minute
            WHERE device_id = ? AND {metric} IS NOT NULL
            ORDER BY ts DESC LIMIT 1
            """,
            (device_id,),
        ).fetchone()
        if row:
            return float(row["ts"]), float(row["value"])
    return None


def nearest_sample(
    conn: sqlite3.Connection,
    device_id: str,
    ts: float,
    tolerance: float = 1.5,
) -> Optional[sqlite3.Row]:
    """Nejbližší wide řádek (1s pak 5s) kolem ts."""
    row = conn.execute(
        f"""
        SELECT {_COL_LIST_1S} FROM samples_1s
        WHERE device_id = ? AND ts BETWEEN ? AND ?
        ORDER BY ABS(ts - ?) ASC LIMIT 1
        """,
        (device_id, ts - tolerance, ts + tolerance, ts),
    ).fetchone()
    if row:
        return row
    cold_tol = max(tolerance, ARCHIVE_INTERVAL_S / 2 + 0.5)
    return conn.execute(
        f"""
        SELECT {_COL_LIST_1S} FROM samples_5s
        WHERE device_id = ? AND ts BETWEEN ? AND ?
        ORDER BY ABS(ts - ?) ASC LIMIT 1
        """,
        (device_id, ts - cold_tol, ts + cold_tol, ts),
    ).fetchone()


def max_ts(conn: sqlite3.Connection, device_id: str) -> Optional[float]:
    candidates: list[float] = []
    for table in ("samples_1s", "samples_5s", "samples_minute"):
        if not table_exists(conn, table):
            continue
        row = conn.execute(
            f"SELECT MAX(ts) AS ts FROM {table} WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        if row and row["ts"] is not None:
            candidates.append(float(row["ts"]))
    return max(candidates) if candidates else None


def fetch_metric_points(
    conn: sqlite3.Connection,
    device_id: str,
    metric: str,
    t_start: float,
    t_end: float,
) -> list[dict[str, float]]:
    """Body {t, v} pro graf z wide tabulek."""
    by_ts: dict[float, float] = {}

    if metric in LIVE_VALUE_COLS:
        cutoff = hot_cutoff()
        # Hot / recent: 1s
        rows = conn.execute(
            f"""
            SELECT ts, {metric} AS value FROM samples_1s
            WHERE device_id = ? AND {metric} IS NOT NULL
              AND ts >= ? AND ts <= ?
            ORDER BY ts ASC
            """,
            (device_id, t_start, t_end),
        ).fetchall()
        for r in rows:
            by_ts[float(r["ts"])] = float(r["value"])
        # Cold: jen mimo hot okno (nebo kde 1s chybí — po rollupu)
        rows = conn.execute(
            f"""
            SELECT ts, {metric} AS value FROM samples_5s
            WHERE device_id = ? AND {metric} IS NOT NULL
              AND ts >= ? AND ts <= ? AND ts < ?
            ORDER BY ts ASC
            """,
            (device_id, t_start, t_end, cutoff),
        ).fetchall()
        for r in rows:
            t = float(r["ts"])
            if t not in by_ts:
                by_ts[t] = float(r["value"])
    elif metric in MINUTE_COLS:
        rows = conn.execute(
            f"""
            SELECT ts, {metric} AS value FROM samples_minute
            WHERE device_id = ? AND {metric} IS NOT NULL
              AND ts >= ? AND ts <= ?
            ORDER BY ts ASC
            """,
            (device_id, t_start, t_end),
        ).fetchall()
        for r in rows:
            by_ts[float(r["ts"])] = float(r["value"])

    return [{"t": t, "v": by_ts[t]} for t in sorted(by_ts)]


def fetch_laeq_timestamps(
    conn: sqlite3.Connection,
    device_id: str,
    t_start: float,
    t_end: float,
) -> list[float]:
    points = fetch_metric_points(conn, device_id, "laeq_1s", t_start, t_end)
    return [p["t"] for p in points]


def fetch_spectrum_columns_raw(
    conn: sqlite3.Connection,
    device_id: str,
    t_start: float,
    t_end: float,
    metrics: tuple[str, ...] = SPECTRUM_COLS,
) -> list[tuple[float, list[float]]]:
    """Kompletní spektrum řádky (ts, values) z wide tabulek."""
    cutoff = hot_cutoff()
    by_ts: dict[float, dict[str, float]] = {}

    def absorb_wide(table: str, extra_where: str = "", params: tuple[Any, ...] = ()) -> None:
        cols = ", ".join(metrics)
        rows = conn.execute(
            f"""
            SELECT ts, {cols} FROM {table}
            WHERE device_id = ? AND ts >= ? AND ts <= ? {extra_where}
            ORDER BY ts ASC
            """,
            (device_id, t_start, t_end, *params),
        ).fetchall()
        for r in rows:
            band_map = {m: r[m] for m in metrics if r[m] is not None}
            if len(band_map) < len(metrics):
                # částečné — uložit co je; filtr kompletnosti později
                if not band_map:
                    continue
            by_ts.setdefault(float(r["ts"]), {}).update(
                {m: float(v) for m, v in band_map.items()}
            )

    absorb_wide("samples_1s")
    absorb_wide("samples_5s", "AND ts < ?", (cutoff,))

    complete: list[tuple[float, list[float]]] = []
    for ts in sorted(by_ts):
        band_map = by_ts[ts]
        if not all(m in band_map for m in metrics):
            continue
        complete.append((ts, [band_map[m] for m in metrics]))
    return complete


def metric_stats(
    conn: sqlite3.Connection,
    device_id: str,
    metric: str,
    since: float,
) -> Optional[dict[str, Any]]:
    points = fetch_metric_points(conn, device_id, metric, since, time.time())
    if not points:
        return None
    values = [p["v"] for p in points]
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "avg": sum(values) / len(values),
    }


# --- archive / prune ----------------------------------------------------


def rollup_chunk(conn: sqlite3.Connection, limit_buckets: int = 2000) -> dict[str, Any]:
    """Energy-average samples_1s → samples_5s pod hot_cutoff; smaže hot."""
    cutoff = hot_cutoff()
    rows = conn.execute(
        f"""
        SELECT {_COL_LIST_1S} FROM samples_1s
        WHERE ts < ?
        ORDER BY device_id, ts ASC
        LIMIT ?
        """,
        (cutoff, limit_buckets * ARCHIVE_INTERVAL_S + 50),
    ).fetchall()
    if not rows:
        set_meta(conn, META_ARCHIVE_RUN, str(time.time()))
        return {"rolled": 0, "deleted": 0}

    # Group by device + bucket
    groups: dict[tuple[str, float], list[sqlite3.Row]] = {}
    for r in rows:
        key = (str(r["device_id"]), bucket_start(float(r["ts"])))
        groups.setdefault(key, []).append(r)

    # Limit number of complete buckets (don't partial-cut last incomplete wall-clock
    # if still receiving — but these are all < cutoff so complete)
    rolled = 0
    deleted_ts: list[tuple[str, float]] = []
    for (device_id, bts), chunk in groups.items():
        if rolled >= limit_buckets:
            break
        avg_vals: dict[str, Optional[float]] = {}
        n_src = 0
        for col in LIVE_VALUE_COLS:
            vals = [float(r[col]) for r in chunk if r[col] is not None]
            avg_vals[col] = energy_average(vals)
            if col == "laeq_1s":
                n_src = len(vals) or len(chunk)
        if n_src == 0:
            n_src = len(chunk)
        placeholders = ", ".join("?" for _ in range(3 + len(LIVE_VALUE_COLS)))
        updates = ", ".join(
            f"{c}=excluded.{c}" for c in (*LIVE_VALUE_COLS, "n_src")
        )
        conn.execute(
            f"""
            INSERT INTO samples_5s ({_COL_LIST_5S})
            VALUES ({placeholders})
            ON CONFLICT(device_id, ts) DO UPDATE SET {updates}
            """,
            (
                bts,
                device_id,
                *[avg_vals[c] for c in LIVE_VALUE_COLS],
                n_src,
            ),
        )
        for r in chunk:
            deleted_ts.append((device_id, float(r["ts"])))
        rolled += 1

    deleted = 0
    for device_id, ts in deleted_ts:
        conn.execute(
            "DELETE FROM samples_1s WHERE device_id = ? AND ts = ?",
            (device_id, ts),
        )
        deleted += 1

    set_meta(conn, META_ARCHIVE_RUN, str(time.time()))
    return {"rolled": rolled, "deleted": deleted, "cutoff": cutoff}


def prune_storage(
    conn: sqlite3.Connection,
    *,
    aircraft_cutoff: Optional[float] = None,
) -> None:
    now = time.time()
    cutoff_all = now - RETENTION_DAYS * 86400
    conn.execute("DELETE FROM samples_5s WHERE ts < ?", (cutoff_all,))
    conn.execute("DELETE FROM samples_minute WHERE ts < ?", (cutoff_all,))
    # 1s starší než retention (když archive neběžel) — bezpečnost
    conn.execute("DELETE FROM samples_1s WHERE ts < ?", (cutoff_all,))
    conn.execute("DELETE FROM weather_snapshots WHERE ts < ?", (cutoff_all,))
    if aircraft_cutoff is not None:
        conn.execute(
            "DELETE FROM aircraft_overflights WHERE closest_ts < ?",
            (aircraft_cutoff,),
        )


def storage_status(conn: sqlite3.Connection) -> dict[str, Any]:
    def count(table: str) -> int:
        if not table_exists(conn, table):
            return 0
        row = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()
        return int(row["n"] or 0)

    return {
        "archive_last_run": get_meta(conn, META_ARCHIVE_RUN, ""),
        "hot_retention_hours": HOT_RETENTION_HOURS,
        "archive_interval_s": ARCHIVE_INTERVAL_S,
        "retention_days": RETENTION_DAYS,
        "counts": {
            "samples_1s": count("samples_1s"),
            "samples_5s": count("samples_5s"),
            "samples_minute": count("samples_minute"),
        },
    }


# --- background jobs ----------------------------------------------------


def start_background_jobs(
    db_factory: _DbFactory,
    prune_fn: Optional[Callable[[], None]] = None,
) -> None:
    global _archive_thread
    _stop.clear()

    def archive_loop() -> None:
        _stop.wait(15)
        while not _stop.is_set():
            try:
                with db_factory() as conn:
                    total_rolled = 0
                    for _ in range(20):
                        r = rollup_chunk(conn, limit_buckets=500)
                        if r.get("skipped"):
                            break
                        rolled = int(r.get("rolled") or 0)
                        total_rolled += rolled
                        if rolled == 0:
                            break
                    if total_rolled:
                        logger.info("Archive rollup: rolled_buckets≈%s", total_rolled)
                if prune_fn is not None:
                    prune_fn()
            except Exception:
                logger.exception("Archive job selhal")
            _stop.wait(max(30, ARCHIVE_JOB_INTERVAL_S))

    _archive_thread = threading.Thread(
        target=archive_loop, name="sample-archive", daemon=True
    )
    _archive_thread.start()
