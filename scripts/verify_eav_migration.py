#!/usr/bin/env python3
"""Ověření EAV → wide migrace (spouštět proti kopii produkční DB).

Usage:
  DATA_DIR=/path/to/data python -m scripts.verify_eav_migration
  # nebo:
  python scripts/verify_eav_migration.py /path/to/hlukomer.db
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

# Allow importing backend.app when run as script
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import storage  # noqa: E402


def main() -> int:
    if len(sys.argv) > 1:
        db_path = Path(sys.argv[1])
    else:
        data_dir = Path(os.getenv("DATA_DIR", ROOT / "data"))
        db_path = data_dir / "hlukomer.db"

    if not db_path.exists():
        print(f"DB not found: {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        storage.ensure_wide_tables(conn)
        status = storage.get_meta(conn, storage.META_STATUS, "")
        print(f"status={status}")
        print(storage.storage_status(conn))

        if status in ("", "pending", "migrating"):
            print("Running remaining migration chunks…")
            while True:
                r = storage.migrate_eav_chunk(conn, batch_size=5000)
                conn.commit()
                print(r)
                if r.get("done"):
                    break

        result = storage.auto_verify_migration(conn)
        conn.commit()
        print("verify:", result)
        return 0 if result.get("ok") else 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
