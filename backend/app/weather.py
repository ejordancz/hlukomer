"""MET Norway (yr.no) — Locationforecast + Sunrise pro dashboard."""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger("hlukomer.weather")

FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"
SUNRISE_URL = "https://api.met.no/weatherapi/sunrise/3.0/sun"

WIND_WARN_MS = 5.0
WIND_HIGH_MS = 8.0

CARDINALS_CS = ("S", "SV", "V", "JV", "J", "JZ", "Z", "SZ")

_SYMBOL_DESC = (
    (("thunder",), "Bouřka"),
    (("heavysnow", "snow"), "Sníh"),
    (("sleet",), "Sníh s deštěm"),
    (("heavyrain", "rain", "drizzle"), "Déšť"),
    (("fog", "mist"), "Mlha"),
    (("clearsky", "fair"), "Jasno"),
    (("partly",), "Polojasno"),
    (("cloudy",), "Zataženo"),
)


def _env_float(name: str) -> Optional[float]:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        logger.warning("Neplatná hodnota %s=%r", name, raw)
        return None


def get_coords() -> Optional[tuple[float, float]]:
    lat = _env_float("LATITUDE")
    lon = _env_float("LONGITUDE")
    if lat is None or lon is None:
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        logger.warning("Souřadnice mimo rozsah: lat=%s lon=%s", lat, lon)
        return None
    return (round(lat, 4), round(lon, 4))


def user_agent() -> str:
    return (
        os.getenv("YR_USER_AGENT") or ""
    ).strip() or "hlukomer/1.0 (https://github.com/local/hlukomer)"


def wind_cardinal(deg: Optional[float]) -> Optional[str]:
    if deg is None or math.isnan(deg):
        return None
    idx = int((deg % 360) / 45 + 0.5) % 8
    return CARDINALS_CS[idx]


def weather_description(symbol: Optional[str]) -> str:
    if not symbol:
        return "—"
    s = symbol.lower()
    for needles, label in _SYMBOL_DESC:
        if any(n in s for n in needles):
            return label
    if "night" in s:
        return "Oblačno"
    return "Oblačno"


def weather_icon_class(symbol: Optional[str]) -> str:
    """MDI třída podle symbol_code (viz weather.md)."""
    if not symbol:
        return "mdi-weather-partly-cloudy"
    s = symbol.lower()
    if "clearsky" in s or "fair" in s:
        return "mdi-weather-night" if "night" in s else "mdi-weather-sunny"
    if "cloudy" in s and "partly" not in s:
        return "mdi-weather-cloudy"
    if "partly" in s:
        return "mdi-weather-partly-cloudy"
    if "rain" in s or "drizzle" in s:
        return "mdi-weather-rainy"
    if "snow" in s:
        return "mdi-weather-snowy"
    if "fog" in s or "mist" in s:
        return "mdi-weather-fog"
    if "thunder" in s:
        return "mdi-weather-lightning-rainy"
    if "night" in s:
        return "mdi-weather-night-partly-cloudy"
    return "mdi-weather-partly-cloudy"


def _parse_expires(header: Optional[str], fallback_s: float = 3600.0) -> float:
    now = time.time()
    if header:
        try:
            dt = parsedate_to_datetime(header)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            exp = dt.timestamp()
            if exp > now:
                return exp
        except (TypeError, ValueError, OverflowError):
            pass
    return now + fallback_s


def _http_get_json(url: str) -> tuple[dict[str, Any], float]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent(),
            "Accept": "application/json",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read()
        expires = _parse_expires(resp.headers.get("Expires"))
    return json.loads(body.decode("utf-8")), expires


def _tz_offset_str(tz: ZoneInfo, at: Optional[datetime] = None) -> str:
    dt = at or datetime.now(tz)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    else:
        dt = dt.astimezone(tz)
    off = dt.utcoffset() or timedelta(0)
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    return f"{sign}{total // 3600:02d}:{(total % 3600) // 60:02d}"


def _iso_to_ts(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.timestamp()
    except ValueError:
        return None


def _skew_factors(
    symbol: Optional[str],
    wind_ms: Optional[float],
    precip_mm: Optional[float],
) -> list[dict[str, str]]:
    factors: list[dict[str, str]] = []
    sym = (symbol or "").lower()

    if wind_ms is not None:
        if wind_ms >= WIND_HIGH_MS:
            factors.append(
                {
                    "id": "wind",
                    "level": "high",
                    "label": "Silný vítr může výrazně zkreslit měření",
                }
            )
        elif wind_ms >= WIND_WARN_MS:
            factors.append(
                {
                    "id": "wind",
                    "level": "warn",
                    "label": "Vítr může zkreslit měření",
                }
            )

    if precip_mm is not None and precip_mm > 0:
        factors.append(
            {
                "id": "precip",
                "level": "warn" if precip_mm < 2 else "high",
                "label": "Srážky mohou zkreslit měření",
            }
        )

    if "thunder" in sym:
        factors.append(
            {
                "id": "thunder",
                "level": "high",
                "label": "Bouřka — impulzy a déšť zkreslí měření",
            }
        )
    elif "snow" in sym or "sleet" in sym:
        factors.append(
            {
                "id": "snow",
                "level": "warn",
                "label": "Sníh / námraza může zkreslit měření",
            }
        )

    return factors


def _pick_current_entry(timeseries: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not timeseries:
        return None
    now = time.time()
    best = None
    best_delta = None
    for entry in timeseries:
        ts = _iso_to_ts(entry.get("time"))
        if ts is None:
            continue
        # prefer nejbližší slot >= now - 30 min
        if ts < now - 1800:
            continue
        delta = abs(ts - now)
        if best_delta is None or delta < best_delta:
            best = entry
            best_delta = delta
    return best or timeseries[0]


def parse_timeseries_entry(entry: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Jeden slot Locationforecast → snapshot pro UI / DB."""
    ts = _iso_to_ts(entry.get("time"))
    if ts is None:
        return None
    data = entry.get("data") or {}
    instant = (data.get("instant") or {}).get("details") or {}
    n1 = data.get("next_1_hours") or {}
    n6 = data.get("next_6_hours") or {}
    symbol = (n1.get("summary") or {}).get("symbol_code") or (
        (n6.get("summary") or {}).get("symbol_code")
    )
    precip = (n1.get("details") or {}).get("precipitation_amount")
    wind = instant.get("wind_speed")
    direction = instant.get("wind_from_direction")
    wind_f = float(wind) if isinstance(wind, (int, float)) else None
    dir_f = float(direction) if isinstance(direction, (int, float)) else None
    precip_f = float(precip) if isinstance(precip, (int, float)) else None
    temp = instant.get("air_temperature")
    hum = instant.get("relative_humidity")
    press = instant.get("air_pressure_at_sea_level")
    hour_ts = math.floor(ts / 3600.0) * 3600.0

    return {
        "ts": hour_ts,
        "time": entry.get("time"),
        "symbol_code": symbol,
        "description": weather_description(symbol),
        "icon_class": weather_icon_class(symbol),
        "temperature_c": float(temp) if isinstance(temp, (int, float)) else None,
        "wind_speed_ms": wind_f,
        "wind_from_direction_deg": dir_f,
        "wind_from_direction_cardinal": wind_cardinal(dir_f),
        "precipitation_1h_mm": precip_f,
        "relative_humidity_pct": float(hum) if isinstance(hum, (int, float)) else None,
        "pressure_hpa": float(press) if isinstance(press, (int, float)) else None,
        "skew_factors": _skew_factors(symbol, wind_f, precip_f),
    }


def parse_forecast(payload: dict[str, Any]) -> dict[str, Any]:
    series = payload.get("properties", {}).get("timeseries") or []
    entry = _pick_current_entry(series)
    if not entry:
        raise ValueError("prázdná timeseries")
    parsed = parse_timeseries_entry(entry)
    if not parsed:
        raise ValueError("neplatný aktuální slot")
    return parsed


def parse_all_timeseries(payload: dict[str, Any]) -> list[dict[str, Any]]:
    series = payload.get("properties", {}).get("timeseries") or []
    out: list[dict[str, Any]] = []
    seen: set[float] = set()
    for entry in series:
        parsed = parse_timeseries_entry(entry)
        if not parsed:
            continue
        ts = parsed["ts"]
        if ts in seen:
            continue
        seen.add(ts)
        out.append(parsed)
    out.sort(key=lambda s: s["ts"])
    return out


def parse_sunrise(payload: dict[str, Any]) -> dict[str, Optional[str]]:
    props = payload.get("properties") or {}
    sunrise = (props.get("sunrise") or {}).get("time")
    sunset = (props.get("sunset") or {}).get("time")
    return {"sunrise": sunrise, "sunset": sunset}


@dataclass
class _Cache:
    lock: threading.RLock = field(default_factory=threading.RLock)
    forecast: Optional[dict[str, Any]] = None
    forecast_expires: float = 0.0
    forecast_error: Optional[str] = None
    # date YYYY-MM-DD -> {sunrise, sunset, expires}
    sun_by_date: dict[str, dict[str, Any]] = field(default_factory=dict)


_cache = _Cache()

# Callback z main.py: uložení hodinových snapshotů do SQLite
_persist_samples = None  # type: ignore[var-annotated]


def set_persist_callback(fn: Any) -> None:
    global _persist_samples
    _persist_samples = fn


def fetch_forecast(lat: float, lon: float) -> tuple[dict[str, Any], list[dict[str, Any]], float]:
    qs = urllib.parse.urlencode({"lat": f"{lat:.4f}", "lon": f"{lon:.4f}"})
    raw, expires = _http_get_json(f"{FORECAST_URL}?{qs}")
    return parse_forecast(raw), parse_all_timeseries(raw), expires


def fetch_sunrise(
    lat: float, lon: float, date: str, tz: ZoneInfo
) -> tuple[dict[str, Optional[str]], float]:
    offset = _tz_offset_str(tz)
    qs = urllib.parse.urlencode(
        {
            "lat": f"{lat:.4f}",
            "lon": f"{lon:.4f}",
            "date": date,
            "offset": offset,
        }
    )
    raw, expires = _http_get_json(f"{SUNRISE_URL}?{qs}")
    return parse_sunrise(raw), expires


def refresh_forecast() -> None:
    coords = get_coords()
    if not coords:
        with _cache.lock:
            _cache.forecast = None
            _cache.forecast_expires = 0.0
            _cache.forecast_error = "LATITUDE/LONGITUDE not set"
        return
    lat, lon = coords
    try:
        current, samples, expires = fetch_forecast(lat, lon)
        with _cache.lock:
            _cache.forecast = current
            _cache.forecast_expires = expires
            _cache.forecast_error = None
        if _persist_samples and samples:
            try:
                _persist_samples(samples)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Uložení weather snapshots: %s", exc)
        logger.info(
            "Počasí obnoveno (%d slotů), expires=%s",
            len(samples),
            datetime.fromtimestamp(expires, tz=timezone.utc),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Načtení počasí selhalo: %s", exc)
        with _cache.lock:
            _cache.forecast_error = str(exc)
            if _cache.forecast_expires < time.time():
                _cache.forecast_expires = time.time() + 300


def ensure_forecast(force: bool = False) -> None:
    with _cache.lock:
        fresh = _cache.forecast is not None and _cache.forecast_expires > time.time()
    if force or not fresh:
        refresh_forecast()


def get_sun_for_date(date: str, tz: ZoneInfo) -> Optional[dict[str, Optional[str]]]:
    coords = get_coords()
    if not coords:
        return None
    now = time.time()
    with _cache.lock:
        hit = _cache.sun_by_date.get(date)
        if hit and hit.get("expires", 0) > now:
            return {"sunrise": hit.get("sunrise"), "sunset": hit.get("sunset")}

    lat, lon = coords
    try:
        sun, expires = fetch_sunrise(lat, lon, date, tz)
        # sunrise data se mění pomalu — cache min. do konce dne + 6 h
        day_end = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=tz) + timedelta(
            days=1, hours=6
        )
        expires = max(expires, day_end.timestamp())
        with _cache.lock:
            _cache.sun_by_date[date] = {
                "sunrise": sun.get("sunrise"),
                "sunset": sun.get("sunset"),
                "expires": expires,
            }
            # omezit velikost cache
            if len(_cache.sun_by_date) > 120:
                for key in sorted(_cache.sun_by_date.keys())[:-90]:
                    _cache.sun_by_date.pop(key, None)
        return sun
    except Exception as exc:  # noqa: BLE001
        logger.warning("Sunrise %s selhalo: %s", date, exc)
        return None


def prefetch_sun_range(t0: float, t1: float, tz: ZoneInfo) -> None:
    if not get_coords():
        return
    local0 = datetime.fromtimestamp(t0, tz=tz).date()
    local1 = datetime.fromtimestamp(t1, tz=tz).date()
    d = local0 - timedelta(days=1)
    end = local1 + timedelta(days=1)
    while d <= end:
        get_sun_for_date(d.isoformat(), tz)
        d += timedelta(days=1)


def weather_payload(tz: ZoneInfo) -> dict[str, Any]:
    coords = get_coords()
    if not coords:
        return {
            "configured": False,
            "error": "LATITUDE/LONGITUDE not set",
        }

    ensure_forecast()
    lat, lon = coords
    today = datetime.now(tz).date().isoformat()
    sun = get_sun_for_date(today, tz)

    with _cache.lock:
        current = _cache.forecast
        expires = _cache.forecast_expires
        err = _cache.forecast_error

    if current is None:
        return {
            "configured": True,
            "error": err or "weather unavailable",
            "coords": {"lat": lat, "lon": lon},
        }

    skew = current.get("skew_factors") or []
    return {
        "configured": True,
        "updated_at": datetime.now(tz).isoformat(),
        "expires_at": datetime.fromtimestamp(expires, tz=tz).isoformat(),
        "coords": {"lat": lat, "lon": lon},
        "current": {
            "time": current.get("time"),
            "symbol_code": current.get("symbol_code"),
            "description": current.get("description"),
            "icon_class": current.get("icon_class"),
            "temperature_c": current.get("temperature_c"),
            "wind_speed_ms": current.get("wind_speed_ms"),
            "wind_from_direction_deg": current.get("wind_from_direction_deg"),
            "wind_from_direction_cardinal": current.get("wind_from_direction_cardinal"),
            "precipitation_1h_mm": current.get("precipitation_1h_mm"),
            "relative_humidity_pct": current.get("relative_humidity_pct"),
            "pressure_hpa": current.get("pressure_hpa"),
        },
        "skew_factors": skew,
        "sun": {
            "date": today,
            "sunrise": (sun or {}).get("sunrise"),
            "sunset": (sun or {}).get("sunset"),
        },
        "error": err,
    }


def seconds_until_next_hour(now: Optional[float] = None) -> float:
    t = now if now is not None else time.time()
    # příští celá hodina UTC epoch — lokální „celá hodina“ ≈ stejná hranice epoch % 3600
    return 3600.0 - (t % 3600.0) + 2.0  # +2 s jitter


_refresh_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()


def start_hourly_refresh() -> None:
    global _refresh_thread
    if _refresh_thread and _refresh_thread.is_alive():
        return

    def loop() -> None:
        # první načtení hned
        try:
            ensure_forecast(force=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Úvodní počasí: %s", exc)
        while not _stop_event.is_set():
            wait = seconds_until_next_hour()
            if _stop_event.wait(wait):
                break
            try:
                ensure_forecast(force=True)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Hodinový refresh počasí: %s", exc)

    _stop_event.clear()
    _refresh_thread = threading.Thread(target=loop, name="weather-hourly", daemon=True)
    _refresh_thread.start()


def stop_hourly_refresh() -> None:
    _stop_event.set()
