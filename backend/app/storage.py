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

# High-res FFT 190–270 Hz (1 Hz bins, 3 s energy average → spectrum_fine_3s).
FINE_FFT_F0_HZ = 190
FINE_FFT_F1_HZ = 270
FINE_FFT_DF_HZ = 1.0
FINE_FFT_INTEGRATE_S = 3
FINE_FFT_N_BINS = FINE_FFT_F1_HZ - FINE_FFT_F0_HZ + 1  # 81
FINE_FFT_HZ: tuple[int, ...] = tuple(
    range(FINE_FFT_F0_HZ, FINE_FFT_F1_HZ + 1, int(FINE_FFT_DF_HZ))
)
FINE_FFT_BANDS: tuple[str, ...] = tuple(str(hz) for hz in FINE_FFT_HZ)
FINE_FFT_DB0 = 0.0
FINE_FFT_DB_STEP = 0.5

# High-res FFT 25–70 Hz (same packing / 3 s → spectrum_fine_lf_3s; oddělená historie).
FINE_LF_FFT_F0_HZ = 25
FINE_LF_FFT_F1_HZ = 70
FINE_LF_FFT_N_BINS = FINE_LF_FFT_F1_HZ - FINE_LF_FFT_F0_HZ + 1  # 46
FINE_LF_FFT_HZ: tuple[int, ...] = tuple(
    range(FINE_LF_FFT_F0_HZ, FINE_LF_FFT_F1_HZ + 1, int(FINE_FFT_DF_HZ))
)
FINE_LF_FFT_BANDS: tuple[str, ...] = tuple(str(hz) for hz in FINE_LF_FFT_HZ)

# Staré IIR wide sloupce (drop bez náhrady).
LEGACY_FINE_COLS: tuple[str, ...] = tuple(
    f"fine_{hz}" for hz in range(190, 271, 5)
)

LIVE_VALUE_COLS: tuple[str, ...] = (
    "laeq_1s",
    "lez_1s",
    "lfi_db",
    *SPECTRUM_COLS,
)
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


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})")}


def ensure_live_columns(conn: sqlite3.Connection) -> None:
    """Doplní chybějící LIVE_VALUE_COLS do existujících wide tabulek (ALTER)."""
    for table in ("samples_1s", "samples_5s"):
        if not table_exists(conn, table):
            continue
        existing = _table_columns(conn, table)
        for col in LIVE_VALUE_COLS:
            if col not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} REAL")


def ensure_fine_fft_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS spectrum_fine_3s (
            device_id TEXT NOT NULL,
            ts REAL NOT NULL,
            n_bins INTEGER NOT NULL DEFAULT 81,
            f0_hz REAL NOT NULL DEFAULT 190,
            df_hz REAL NOT NULL DEFAULT 1,
            db0 REAL NOT NULL DEFAULT 0,
            payload BLOB NOT NULL,
            PRIMARY KEY (device_id, ts)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS spectrum_fine_lf_3s (
            device_id TEXT NOT NULL,
            ts REAL NOT NULL,
            n_bins INTEGER NOT NULL DEFAULT 46,
            f0_hz REAL NOT NULL DEFAULT 25,
            df_hz REAL NOT NULL DEFAULT 1,
            db0 REAL NOT NULL DEFAULT 0,
            payload BLOB NOT NULL,
            PRIMARY KEY (device_id, ts)
        ) WITHOUT ROWID;
        """
    )


def drop_legacy_fine_columns(conn: sqlite3.Connection) -> None:
    """Hard-drop starých IIR sloupců fine_* (data i struktura, bez migrace)."""
    legacy = set(LEGACY_FINE_COLS)
    for table in ("samples_1s", "samples_5s"):
        if not table_exists(conn, table):
            continue
        existing = _table_columns(conn, table)
        to_drop = [c for c in LEGACY_FINE_COLS if c in existing]
        if not to_drop:
            continue
        dropped = 0
        for col in to_drop:
            try:
                conn.execute(f"ALTER TABLE {table} DROP COLUMN {col}")
                dropped += 1
            except sqlite3.OperationalError:
                logger.warning(
                    "DROP COLUMN %s.%s selhal — recreate tabulky", table, col
                )
                _recreate_wide_table_without_legacy(conn, table, legacy)
                dropped = -1
                break
        if dropped > 0:
            logger.info("Dropped %s legacy fine columns from %s", dropped, table)
        elif dropped == -1:
            logger.info("Recreated %s without legacy fine columns", table)


def _recreate_wide_table_without_legacy(
    conn: sqlite3.Connection, table: str, legacy: set[str]
) -> None:
    """SQLite fallback, když ALTER DROP COLUMN není dostupný."""
    info = list(conn.execute(f"PRAGMA table_info({table})"))
    keep_cols = [str(r[1]) for r in info if str(r[1]) not in legacy]
    if len(keep_cols) == len(info):
        return
    col_defs: list[str] = []
    for r in info:
        name = str(r[1])
        if name in legacy:
            continue
        ctype = str(r[2] or "REAL")
        notnull = " NOT NULL" if int(r[3] or 0) else ""
        dflt = r[4]
        dflt_sql = f" DEFAULT {dflt}" if dflt is not None else ""
        col_defs.append(f"{name} {ctype}{notnull}{dflt_sql}")
    tmp = f"{table}__nofine"
    cols_csv = ", ".join(keep_cols)
    conn.execute(f"DROP TABLE IF EXISTS {tmp}")
    conn.execute(
        f"CREATE TABLE {tmp} ({', '.join(col_defs)}, "
        f"PRIMARY KEY (device_id, ts)) WITHOUT ROWID"
    )
    conn.execute(
        f"INSERT INTO {tmp} ({cols_csv}) SELECT {cols_csv} FROM {table}"
    )
    conn.execute(f"DROP TABLE {table}")
    conn.execute(f"ALTER TABLE {tmp} RENAME TO {table}")


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
    ensure_live_columns(conn)
    drop_legacy_fine_columns(conn)
    ensure_fine_fft_table(conn)


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


def pack_fine_fft_payload(
    values_db: list[float],
    *,
    db0: float = FINE_FFT_DB0,
    step: float = FINE_FFT_DB_STEP,
    n_bins: Optional[int] = None,
) -> bytes:
    expected = FINE_FFT_N_BINS if n_bins is None else int(n_bins)
    if len(values_db) != expected:
        raise ValueError(f"expected {expected} bins, got {len(values_db)}")
    out = bytearray(expected)
    for i, raw in enumerate(values_db):
        v = sanitize_value(float(raw))
        if v is None:
            out[i] = 0
            continue
        q = int(round((v - db0) / step))
        out[i] = 0 if q < 0 else 255 if q > 255 else q
    return bytes(out)


def unpack_fine_fft_payload(
    payload: bytes,
    *,
    db0: float = FINE_FFT_DB0,
    step: float = FINE_FFT_DB_STEP,
    n_bins: int = FINE_FFT_N_BINS,
) -> list[float]:
    data = payload[:n_bins]
    return [round(db0 + b * step, 1) for b in data]


def fine_fft_bucket_start(ts: float) -> float:
    return math.floor(ts / FINE_FFT_INTEGRATE_S) * FINE_FFT_INTEGRATE_S


def upsert_spectrum_fine_3s(
    conn: sqlite3.Connection,
    ts: float,
    device_id: str,
    values_db: list[float],
    *,
    f0_hz: float = float(FINE_FFT_F0_HZ),
    df_hz: float = FINE_FFT_DF_HZ,
    db0: float = FINE_FFT_DB0,
) -> int:
    if len(values_db) != FINE_FFT_N_BINS:
        raise ValueError(f"spectrum_fine must have {FINE_FFT_N_BINS} values")
    bucket = fine_fft_bucket_start(ts)
    payload = pack_fine_fft_payload(values_db, db0=db0, n_bins=FINE_FFT_N_BINS)
    conn.execute(
        """
        INSERT INTO spectrum_fine_3s
            (device_id, ts, n_bins, f0_hz, df_hz, db0, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, ts) DO UPDATE SET
            n_bins = excluded.n_bins,
            f0_hz = excluded.f0_hz,
            df_hz = excluded.df_hz,
            db0 = excluded.db0,
            payload = excluded.payload
        """,
        (
            device_id,
            bucket,
            FINE_FFT_N_BINS,
            f0_hz,
            df_hz,
            db0,
            payload,
        ),
    )
    return 1


def upsert_spectrum_fine_lf_3s(
    conn: sqlite3.Connection,
    ts: float,
    device_id: str,
    values_db: list[float],
    *,
    f0_hz: float = float(FINE_LF_FFT_F0_HZ),
    df_hz: float = FINE_FFT_DF_HZ,
    db0: float = FINE_FFT_DB0,
) -> int:
    if len(values_db) != FINE_LF_FFT_N_BINS:
        raise ValueError(f"spectrum_fine_lf must have {FINE_LF_FFT_N_BINS} values")
    bucket = fine_fft_bucket_start(ts)
    payload = pack_fine_fft_payload(values_db, db0=db0, n_bins=FINE_LF_FFT_N_BINS)
    conn.execute(
        """
        INSERT INTO spectrum_fine_lf_3s
            (device_id, ts, n_bins, f0_hz, df_hz, db0, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, ts) DO UPDATE SET
            n_bins = excluded.n_bins,
            f0_hz = excluded.f0_hz,
            df_hz = excluded.df_hz,
            db0 = excluded.db0,
            payload = excluded.payload
        """,
        (
            device_id,
            bucket,
            FINE_LF_FFT_N_BINS,
            f0_hz,
            df_hz,
            db0,
            payload,
        ),
    )
    return 1


def _fetch_fine_fft_columns_raw(
    conn: sqlite3.Connection,
    table: str,
    device_id: str,
    t_start: float,
    t_end: float,
    *,
    expected_bins: int,
) -> list[tuple[float, list[float]]]:
    """(t_mid, values_db) z fine FFT tabulky; t_mid = bucket_start + 1.5 s."""
    if not table_exists(conn, table):
        return []
    rows = conn.execute(
        f"""
        SELECT ts, n_bins, db0, payload
        FROM {table}
        WHERE device_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
        """,
        (device_id, t_start - FINE_FFT_INTEGRATE_S, t_end),
    ).fetchall()
    out: list[tuple[float, list[float]]] = []
    half = FINE_FFT_INTEGRATE_S / 2.0
    for r in rows:
        ts0 = float(r["ts"])
        t_mid = ts0 + half
        if ts0 + FINE_FFT_INTEGRATE_S < t_start or ts0 > t_end:
            continue
        n_bins = int(r["n_bins"] or expected_bins)
        db0 = float(r["db0"] if r["db0"] is not None else FINE_FFT_DB0)
        payload = r["payload"]
        if payload is None:
            continue
        if isinstance(payload, memoryview):
            payload = payload.tobytes()
        elif not isinstance(payload, (bytes, bytearray)):
            payload = bytes(payload)
        if len(payload) < n_bins:
            continue
        vals = unpack_fine_fft_payload(payload, db0=db0, n_bins=n_bins)
        if len(vals) < expected_bins:
            pad = vals[-1] if vals else 0.0
            vals = vals + [pad] * (expected_bins - len(vals))
        elif len(vals) > expected_bins:
            vals = vals[:expected_bins]
        out.append((t_mid, vals))
    return out


def fetch_spectrum_fine_columns_raw(
    conn: sqlite3.Connection,
    device_id: str,
    t_start: float,
    t_end: float,
) -> list[tuple[float, list[float]]]:
    """(t_mid, values_db[81]) z spectrum_fine_3s; t_mid = bucket_start + 1.5 s."""
    return _fetch_fine_fft_columns_raw(
        conn,
        "spectrum_fine_3s",
        device_id,
        t_start,
        t_end,
        expected_bins=FINE_FFT_N_BINS,
    )


def fetch_spectrum_fine_lf_columns_raw(
    conn: sqlite3.Connection,
    device_id: str,
    t_start: float,
    t_end: float,
) -> list[tuple[float, list[float]]]:
    """(t_mid, values_db[46]) z spectrum_fine_lf_3s; t_mid = bucket_start + 1.5 s."""
    return _fetch_fine_fft_columns_raw(
        conn,
        "spectrum_fine_lf_3s",
        device_id,
        t_start,
        t_end,
        expected_bins=FINE_LF_FFT_N_BINS,
    )


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
    if table_exists(conn, "spectrum_fine_3s"):
        conn.execute("DELETE FROM spectrum_fine_3s WHERE ts < ?", (cutoff_all,))
    if table_exists(conn, "spectrum_fine_lf_3s"):
        conn.execute("DELETE FROM spectrum_fine_lf_3s WHERE ts < ?", (cutoff_all,))
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
            "spectrum_fine_3s": count("spectrum_fine_3s"),
            "spectrum_fine_lf_3s": count("spectrum_fine_lf_3s"),
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
