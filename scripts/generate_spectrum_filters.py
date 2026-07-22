#!/usr/bin/env python3
"""Generate SOS bandpass coeffs for ESPHome sound_level_meter @ 48 kHz."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.signal import butter

FS = 48000
BANDS = [
    ("25", 25.0, "third"),
    ("31", 31.5, "third"),
    ("40", 40.0, "third"),
    ("50", 50.0, "third"),
    ("63", 63.0, "third"),
    ("80", 80.0, "third"),
    ("100", 100.0, "third"),
    ("125", 125.0, "third"),
    ("160", 160.0, "third"),
    ("200", 200.0, "third"),
    ("250", 250.0, "third"),
    ("500", 500.0, "octave"),
    ("1k", 1000.0, "octave"),
    ("2k", 2000.0, "octave"),
    ("4k", 4000.0, "octave"),
    ("8k", 8000.0, "octave"),
    ("16k", 16000.0, "octave"),
]


def edges(fc: float, kind: str) -> tuple[float, float]:
    r = 2 ** (1 / 6) if kind == "third" else 2**0.5
    return fc / r, fc * r


def fmt_sos(sos: np.ndarray) -> list[list[float]]:
    rows = []
    for sec in sos.astype(np.float64):
        b0, b1, b2, a0, a1, a2 = [float(x) for x in sec]
        if abs(a0 - 1.0) > 1e-9:
            b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
        b0, b1, b2, a1, a2 = [float(np.float32(x)) for x in (b0, b1, b2, a1, a2)]
        rows.append([b0, b1, b2, a1, a2])
    return rows


def main() -> None:
    out: dict = {"bands": []}
    out["lfi"] = fmt_sos(butter(4, [20.0, 200.0], btype="band", fs=FS, output="sos"))
    for bid, fc, kind in BANDS:
        flo, fhi = edges(fc, kind)
        fhi = min(fhi, FS / 2 * 0.95)
        flo = max(flo, 5.0)
        order = 4 if kind == "third" else 6
        sos = butter(order, [flo, fhi], btype="band", fs=FS, output="sos")
        out["bands"].append(
            {
                "id": bid,
                "fc": fc,
                "kind": kind,
                "flo": flo,
                "fhi": fhi,
                "order": order,
                "sos": fmt_sos(sos),
            }
        )
    path = Path(__file__).with_name("spectrum_filters.json")
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {path} ({len(out['bands'])} bands)")


if __name__ == "__main__":
    main()
