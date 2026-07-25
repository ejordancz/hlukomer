"""Wide storage (samples_1s / samples_5s / samples_minute) + EAV migrace + hot/cold."""

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
# LIVE_RETENTION_DAYS deprecated — mapováno jen pro EAV prune během migrace
LIVE_RETENTION_DAYS = int(os.getenv("LIVE_RETENTION_DAYS", "7"))
HOT_RETENTION_HOURS = float(os.getenv("HOT_RETENTION_HOURS", "48"))
ARCHIVE_INTERVAL_S = int(os.getenv("ARCHIVE_INTERVAL_S", "5"))
if ARCHIVE_INTERVAL_S not in (5, 10):
    logger.warning(
        "ARCHIVE_INTERVAL_S=%s není 5 ani 10 — používám 5", ARCHIVE_INTERVAL_S
    )
    ARCHIVE_INTERVAL_S = 5
ARCHIVE_JOB_INTERVAL_S = int(os.getenv("ARCHIVE_JOB_INTERVAL_S", "300"))
MIGRATE_EAV_ON_STARTUP = os.getenv("MIGRATE_EAV_ON_STARTUP", "1") == "1"
VACUUM_AFTER_MIGRATE = os.getenv("VACUUM_AFTER_MIGRATE", "0") == "1"

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
LEGACY_SPECTRUM_COLS: tuple[str, ...] = tuple(
    f"oct_{b}" for b in LEGACY_SPECTRUM_BANDS
)

LIVE_VALUE_COLS: tuple[str, ...] = ("laeq_1s", "lez_1s", "lfi_db", *SPECTRUM_COLS)
MINUTE_COLS: tuple[str, ...] = ("laeq_1min", "lamax_1min", "lamin_1min")

LIVE_METRICS_EAV = frozenset(
    {"laeq_1s", "lez_1s", "lfi_db", *SPECTRUM_COLS, *LEGACY_SPECTRUM_COLS}
)

META_STATUS = "eav_migration_status"
META_CURSOR = "eav_migration_cursor_ts"
META_ARCHIVE_RUN = "archive_last_run"

_COL_LIST_1S = ", ".join(("ts", "device_id", *LIVE_VALUE_COLS))
_COL_LIST_5S = ", ".join(("ts", "device_id", *LIVE_VALUE_COLS, "n_src"))
_COL_LIST_MIN = ", ".join(("ts", "device_id", *MINUTE_COLS))

_migrate_thread: Optional[threading.Thread] = None
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
    # EAV fallback během migrace
    if table_exists(conn, "measurements"):
        row = conn.execute(
            """
            SELECT ts, value FROM measurements
            WHERE device_id = ? AND metric = ?
            ORDER BY ts DESC LIMIT 1
            """,
            (device_id, metric),
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
    if table_exists(conn, "measurements"):
        row = conn.execute(
            "SELECT MAX(ts) AS ts FROM measurements WHERE device_id = ?",
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
    """Body {t, v} pro graf — wide (+ EAV fallback)."""
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

    status = get_meta(conn, META_STATUS, "")
    if (
        table_exists(conn, "measurements")
        and status not in ("dropped",)
        and metric in (LIVE_METRICS_EAV | frozenset(MINUTE_COLS))
    ):
        # Doplň mezery z EAV (během migrace)
        rows = conn.execute(
            """
            SELECT ts, value FROM measurements
            WHERE device_id = ? AND metric = ? AND ts >= ? AND ts <= ?
            ORDER BY ts ASC
            """,
            (device_id, metric, t_start, t_end),
        ).fetchall()
        for r in rows:
            t = float(r["ts"])
            if t not in by_ts:
                by_ts[t] = float(r["value"])

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
    """Kompletní spektrum řádky (ts, values) z wide (+ EAV fallback)."""
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

    status = get_meta(conn, META_STATUS, "")
    if table_exists(conn, "measurements") and status != "dropped":
        placeholders = ",".join("?" * len(metrics))
        rows = conn.execute(
            f"""
            SELECT ts, metric, value FROM measurements
            WHERE device_id = ? AND metric IN ({placeholders})
              AND ts >= ? AND ts <= ?
            ORDER BY ts ASC
            """,
            (device_id, *metrics, t_start, t_end),
        ).fetchall()
        for r in rows:
            t = float(r["ts"])
            if t in by_ts and r["metric"] in by_ts[t]:
                continue
            by_ts.setdefault(t, {})[r["metric"]] = float(r["value"])

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


# --- migrace EAV → wide -------------------------------------------------


def _pivot_eav_batch(
    conn: sqlite3.Connection,
    device_id: str,
    timestamps: list[float],
) -> None:
    if not timestamps:
        return
    t_min = min(timestamps)
    t_max = max(timestamps)
    rows = conn.execute(
        """
        SELECT ts, metric, value, kind FROM measurements
        WHERE device_id = ? AND ts >= ? AND ts <= ?
        """,
        (device_id, t_min, t_max),
    ).fetchall()
    live: dict[float, dict[str, float]] = {}
    minute: dict[float, dict[str, float]] = {}
    wanted = set(timestamps)
    for r in rows:
        ts = float(r["ts"])
        if ts not in wanted:
            continue
        metric = str(r["metric"])
        val = float(r["value"])
        kind = str(r["kind"])
        if kind == "minute" or metric in MINUTE_COLS:
            if metric in MINUTE_COLS:
                minute.setdefault(ts, {})[metric] = val
        else:
            if metric in LIVE_VALUE_COLS or metric in LEGACY_SPECTRUM_COLS:
                # legacy oct_* mapují na stejné názvy sloupců
                if metric in LIVE_VALUE_COLS:
                    live.setdefault(ts, {})[metric] = val
    for ts, vals in live.items():
        upsert_sample_1s(conn, ts, device_id, vals)  # type: ignore[arg-type]
    for ts, vals in minute.items():
        upsert_minute(conn, ts, device_id, vals)  # type: ignore[arg-type]


def migrate_eav_chunk(conn: sqlite3.Connection, batch_size: int = 5000) -> dict[str, Any]:
    """Zkopíruje další chunk EAV → wide. Restartovatelné přes meta kurzor."""
    if not table_exists(conn, "measurements"):
        set_meta(conn, META_STATUS, "done")
        return {"done": True, "copied": 0, "reason": "no_measurements"}

    status = get_meta(conn, META_STATUS, "pending")
    if status in ("verified", "dropped", "done"):
        return {"done": True, "copied": 0, "status": status}

    set_meta(conn, META_STATUS, "migrating")
    cursor_raw = get_meta(conn, META_CURSOR, "")
    cursor = float(cursor_raw) if cursor_raw else -1.0

    # Distinct (ts, device_id) after cursor
    rows = conn.execute(
        """
        SELECT ts, device_id FROM measurements
        WHERE ts > ?
        GROUP BY ts, device_id
        ORDER BY ts ASC
        LIMIT ?
        """,
        (cursor, batch_size),
    ).fetchall()
    if not rows:
        set_meta(conn, META_STATUS, "migrated")
        set_meta(conn, META_CURSOR, str(cursor))
        return {"done": True, "copied": 0, "status": "migrated"}

    # Group by device
    by_dev: dict[str, list[float]] = {}
    max_ts_batch = cursor
    for r in rows:
        ts = float(r["ts"])
        max_ts_batch = max(max_ts_batch, ts)
        by_dev.setdefault(str(r["device_id"]), []).append(ts)

    copied = 0
    for device_id, timestamps in by_dev.items():
        _pivot_eav_batch(conn, device_id, timestamps)
        copied += len(timestamps)

    set_meta(conn, META_CURSOR, str(max_ts_batch))
    return {
        "done": False,
        "copied": copied,
        "cursor": max_ts_batch,
        "status": "migrating",
    }


def auto_verify_migration(conn: sqlite3.Connection) -> dict[str, Any]:
    """Rychlá kontrola po migraci; při úspěchu status=verified."""
    if not table_exists(conn, "measurements"):
        set_meta(conn, META_STATUS, "done")
        return {"ok": True, "status": "done"}

    status = get_meta(conn, META_STATUS, "")
    if status in ("verified", "dropped", "done"):
        # Už ověřeno — nepřepisovat kvůli novému ingestu do wide
        return {"ok": True, "status": status, "skipped": True}
    if status not in ("migrated",):
        return {"ok": False, "status": status, "error": "not_ready"}

    issues: list[str] = []
    eav_laeq = conn.execute(
        """
        SELECT COUNT(*) AS n, MIN(ts) AS tmin, MAX(ts) AS tmax
        FROM measurements WHERE metric = 'laeq_1s'
        """
    ).fetchone()
    wide_laeq = conn.execute(
        """
        SELECT COUNT(*) AS n, MIN(ts) AS tmin, MAX(ts) AS tmax
        FROM samples_1s WHERE laeq_1s IS NOT NULL
        """
    ).fetchone()
    eav_n = int(eav_laeq["n"] or 0)
    wide_n = int(wide_laeq["n"] or 0)
    # Wide smí mít víc řádků (nový ingest po cutoveru)
    if eav_n and wide_n + 2 < eav_n * 0.999:
        issues.append(f"laeq_1s count EAV={eav_n} wide={wide_n}")

    if eav_laeq["tmin"] is not None and wide_laeq["tmin"] is not None:
        if abs(float(eav_laeq["tmin"]) - float(wide_laeq["tmin"])) > 2:
            issues.append("min ts mismatch")
        # Wide max smí být novější než EAV (ingest už píše jen wide)
        if float(wide_laeq["tmax"]) + 2 < float(eav_laeq["tmax"]):
            issues.append("max ts mismatch (wide behind EAV)")

    # Spot-check 20 náhodných ts z EAV
    samples = conn.execute(
        """
        SELECT ts, device_id FROM measurements
        WHERE metric = 'laeq_1s'
        ORDER BY RANDOM() LIMIT 20
        """
    ).fetchall()
    for s in samples:
        ts = float(s["ts"])
        device_id = str(s["device_id"])
        eav_v = conn.execute(
            """
            SELECT value FROM measurements
            WHERE device_id = ? AND metric = 'laeq_1s' AND ts = ?
            """,
            (device_id, ts),
        ).fetchone()
        wide_v = conn.execute(
            """
            SELECT laeq_1s FROM samples_1s
            WHERE device_id = ? AND ts = ?
            """,
            (device_id, ts),
        ).fetchone()
        if not eav_v or not wide_v or wide_v["laeq_1s"] is None:
            issues.append(f"missing wide at ts={ts}")
            continue
        if abs(float(eav_v["value"]) - float(wide_v["laeq_1s"])) > 0.01:
            issues.append(f"value mismatch at ts={ts}")

    if issues:
        set_meta(conn, META_STATUS, "migrated")
        return {"ok": False, "status": "migrated", "issues": issues[:10]}

    set_meta(conn, META_STATUS, "verified")
    return {"ok": True, "status": "verified", "eav_laeq": eav_n, "wide_laeq": wide_n}


def drop_eav_table(conn: sqlite3.Connection) -> dict[str, Any]:
    status = get_meta(conn, META_STATUS, "")
    if status != "verified":
        return {"ok": False, "error": f"status must be verified, got {status!r}"}
    if not table_exists(conn, "measurements"):
        set_meta(conn, META_STATUS, "dropped")
        return {"ok": True, "already": True}
    conn.execute("DROP INDEX IF EXISTS idx_meas_ts_metric")
    conn.execute("DROP INDEX IF EXISTS idx_meas_device_ts")
    conn.execute("DROP TABLE IF EXISTS measurements")
    set_meta(conn, META_STATUS, "dropped")
    if VACUUM_AFTER_MIGRATE:
        conn.execute("VACUUM")
    return {"ok": True, "dropped": True, "vacuum": VACUUM_AFTER_MIGRATE}


# --- archive / prune ----------------------------------------------------


def rollup_chunk(conn: sqlite3.Connection, limit_buckets: int = 2000) -> dict[str, Any]:
    """Energy-average samples_1s → samples_5s pod hot_cutoff; smaže hot."""
    status = get_meta(conn, META_STATUS, "done")
    # Archivovat až po verify / když EAV není / done
    if status in ("pending", "migrating", "migrated"):
        return {"skipped": True, "reason": f"migration_status={status}"}

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

    status = get_meta(conn, META_STATUS, "")
    if table_exists(conn, "measurements") and status not in ("dropped",):
        # Během migrace nemaž live EAV pod LIVE_RETENTION (ať nepřijdeme o nemigrované).
        # Mazat jen starší než RETENTION_DAYS.
        conn.execute("DELETE FROM measurements WHERE ts < ?", (cutoff_all,))
        if status in ("verified", "done"):
            cutoff_live = now - LIVE_RETENTION_DAYS * 86400
            placeholders = ",".join("?" * len(LIVE_METRICS_EAV))
            conn.execute(
                f"DELETE FROM measurements WHERE metric IN ({placeholders}) AND ts < ?",
                (*LIVE_METRICS_EAV, cutoff_live),
            )


def storage_status(conn: sqlite3.Connection) -> dict[str, Any]:
    def count(table: str) -> int:
        if not table_exists(conn, table):
            return 0
        row = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()
        return int(row["n"] or 0)

    return {
        "migration_status": get_meta(conn, META_STATUS, "pending"),
        "migration_cursor_ts": get_meta(conn, META_CURSOR, ""),
        "archive_last_run": get_meta(conn, META_ARCHIVE_RUN, ""),
        "hot_retention_hours": HOT_RETENTION_HOURS,
        "archive_interval_s": ARCHIVE_INTERVAL_S,
        "retention_days": RETENTION_DAYS,
        "counts": {
            "samples_1s": count("samples_1s"),
            "samples_5s": count("samples_5s"),
            "samples_minute": count("samples_minute"),
            "measurements": count("measurements"),
        },
    }


# --- background jobs ----------------------------------------------------


def start_background_jobs(
    db_factory: _DbFactory,
    prune_fn: Optional[Callable[[], None]] = None,
) -> None:
    global _migrate_thread, _archive_thread
    _stop.clear()

    if MIGRATE_EAV_ON_STARTUP:
        def migrate_loop() -> None:
            logger.info("EAV migrace: start")
            while not _stop.is_set():
                try:
                    with db_factory() as conn:
                        result = migrate_eav_chunk(conn, batch_size=3000)
                    if result.get("done"):
                        status = result.get("status") or ""
                        if status == "migrated":
                            with db_factory() as conn:
                                vr = auto_verify_migration(conn)
                            logger.info("EAV migrace verify: %s", vr)
                        else:
                            logger.info("EAV migrace hotova: %s", result)
                        break
                    logger.info(
                        "EAV migrace chunk: copied=%s cursor=%s",
                        result.get("copied"),
                        result.get("cursor"),
                    )
                except Exception:
                    logger.exception("EAV migrace selhala")
                    time.sleep(5)
                    continue
                # krátká pauza ať ingest dýchá
                _stop.wait(0.05)

        _migrate_thread = threading.Thread(
            target=migrate_loop, name="eav-migrate", daemon=True
        )
        _migrate_thread.start()

    def archive_loop() -> None:
        # první běh po krátké pauze (migrace má přednost)
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


def stop_background_jobs() -> None:
    _stop.set()
