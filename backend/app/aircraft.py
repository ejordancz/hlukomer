"""OpenSky Network — přelety slyšitelných letadel kolem měřicího místa."""

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
from dataclasses import dataclass
from typing import Any, Callable, Optional

from . import weather as weather_svc

logger = logging.getLogger("hlukomer.aircraft")

STATES_URL = "https://opensky-network.org/api/states/all"
TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network"
    "/protocol/openid-connect/token"
)

DEFAULT_MAX_ALTITUDE_M = 1500.0
DEFAULT_MAX_DISTANCE_KM = 8.0
DEFAULT_POLL_INTERVAL_S = 60.0
MIN_POLL_INTERVAL_S = 15.0
DEFAULT_GAP_S = 180.0

EARTH_RADIUS_M = 6_371_000.0

PersistFn = Callable[[list["Sighting"]], None]


@dataclass(frozen=True)
class Sighting:
    icao24: str
    callsign: Optional[str]
    origin_country: Optional[str]
    ts: float
    lat: float
    lon: float
    distance_m: float
    altitude_m: float
    velocity_ms: Optional[float]
    track_deg: Optional[float]
    vertical_rate_ms: Optional[float]


@dataclass(frozen=True)
class AircraftConfig:
    enabled: bool
    lat: Optional[float]
    lon: Optional[float]
    max_altitude_m: float
    max_distance_km: float
    bbox_padding_km: float
    poll_interval_s: float
    gap_s: float
    retention_days: Optional[int]
    client_id: Optional[str]
    client_secret: Optional[str]


_persist_fn: Optional[PersistFn] = None
_refresh_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()

_token: Optional[str] = None
_token_expires_at: float = 0.0
_token_lock = threading.Lock()

_status: dict[str, Any] = {
    "last_poll_at": None,
    "last_poll_ok": None,
    "last_error": None,
    "last_sightings": 0,
}


def _env_float(name: str, default: float) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("Neplatná hodnota %s=%r, použiji %s", name, raw, default)
        return default


def _env_int(name: str) -> Optional[int]:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        logger.warning("Neplatná hodnota %s=%r", name, raw)
        return None


def _env_bool_tri(name: str) -> Optional[bool]:
    """None = default (podle souřadnic), True/False = explicitní."""
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return None
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    logger.warning("Neplatná hodnota %s=%r", name, raw)
    return None


def get_config() -> AircraftConfig:
    coords = weather_svc.get_coords()
    flag = _env_bool_tri("AIRCRAFT_ENABLED")
    enabled = bool(coords) if flag is None else (flag and bool(coords))

    max_dist = _env_float("AIRCRAFT_MAX_DISTANCE_KM", DEFAULT_MAX_DISTANCE_KM)
    padding_raw = (os.getenv("AIRCRAFT_BBOX_PADDING_KM") or "").strip()
    if padding_raw:
        try:
            padding = float(padding_raw)
        except ValueError:
            padding = max_dist
    else:
        padding = max_dist

    poll = max(
        MIN_POLL_INTERVAL_S,
        _env_float("AIRCRAFT_POLL_INTERVAL_S", DEFAULT_POLL_INTERVAL_S),
    )
    client_id = (os.getenv("OPENSKY_CLIENT_ID") or "").strip() or None
    client_secret = (os.getenv("OPENSKY_CLIENT_SECRET") or "").strip() or None

    lat = lon = None
    if coords:
        lat, lon = coords

    return AircraftConfig(
        enabled=enabled,
        lat=lat,
        lon=lon,
        max_altitude_m=_env_float("AIRCRAFT_MAX_ALTITUDE_M", DEFAULT_MAX_ALTITUDE_M),
        max_distance_km=max_dist,
        bbox_padding_km=max(0.5, padding),
        poll_interval_s=poll,
        gap_s=_env_float("AIRCRAFT_GAP_S", DEFAULT_GAP_S),
        retention_days=_env_int("AIRCRAFT_RETENTION_DAYS"),
        client_id=client_id,
        client_secret=client_secret,
    )


def set_persist_callback(fn: PersistFn) -> None:
    global _persist_fn
    _persist_fn = fn


def status_payload() -> dict[str, Any]:
    cfg = get_config()
    return {
        "enabled": cfg.enabled,
        "configured": cfg.lat is not None and cfg.lon is not None,
        "last_poll_at": _status.get("last_poll_at"),
        "last_poll_ok": _status.get("last_poll_ok"),
        "last_error": _status.get("last_error"),
        "last_sightings": _status.get("last_sightings"),
        "authenticated": bool(cfg.client_id and cfg.client_secret),
        "config": {
            "max_altitude_m": cfg.max_altitude_m,
            "max_distance_km": cfg.max_distance_km,
            "poll_interval_s": cfg.poll_interval_s,
            "gap_s": cfg.gap_s,
            "bbox_padding_km": cfg.bbox_padding_km,
        },
    }


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    rlat1, rlon1, rlat2, rlon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def bbox_for(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    dlat = radius_km / 111.32
    cos_lat = math.cos(math.radians(lat))
    dlon = radius_km / (111.32 * max(0.01, abs(cos_lat)))
    lamin = max(-90.0, lat - dlat)
    lamax = min(90.0, lat + dlat)
    lomin = max(-180.0, lon - dlon)
    lomax = min(180.0, lon + dlon)
    return lamin, lomin, lamax, lomax


def _as_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f):
        return None
    return f


def _as_str(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _obtain_token(cfg: AircraftConfig) -> Optional[str]:
    global _token, _token_expires_at
    if not cfg.client_id or not cfg.client_secret:
        return None

    now = time.time()
    with _token_lock:
        if _token and now < _token_expires_at - 60:
            return _token

        body = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
            }
        ).encode()
        req = urllib.request.Request(
            TOKEN_URL,
            data=body,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            logger.warning("OpenSky token: %s", exc)
            return _token  # případně starý, pokud ještě platí

        token = payload.get("access_token")
        if not token:
            logger.warning("OpenSky token odpověď bez access_token")
            return None
        expires_in = float(payload.get("expires_in") or 1800)
        _token = str(token)
        _token_expires_at = now + expires_in
        return _token


def fetch_states(cfg: AircraftConfig) -> tuple[Optional[int], list[list[Any]]]:
    assert cfg.lat is not None and cfg.lon is not None
    lamin, lomin, lamax, lomax = bbox_for(cfg.lat, cfg.lon, cfg.bbox_padding_km)
    query = urllib.parse.urlencode(
        {
            "lamin": f"{lamin:.4f}",
            "lomin": f"{lomin:.4f}",
            "lamax": f"{lamax:.4f}",
            "lomax": f"{lomax:.4f}",
        }
    )
    url = f"{STATES_URL}?{query}"
    headers = {"Accept": "application/json", "User-Agent": weather_svc.user_agent()}
    token = _obtain_token(cfg)
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode()
            payload = json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        retry = exc.headers.get("X-Rate-Limit-Retry-After-Seconds") if exc.headers else None
        if exc.code == 429:
            wait = float(retry or 60)
            logger.warning("OpenSky 429 — čekám %.0f s", wait)
            time.sleep(min(300.0, max(5.0, wait)))
        raise
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        raise

    states = payload.get("states") or []
    if not isinstance(states, list):
        states = []
    api_time = payload.get("time")
    try:
        api_ts = int(api_time) if api_time is not None else None
    except (TypeError, ValueError):
        api_ts = None
    return api_ts, states


def parse_sightings(
    states: list[list[Any]],
    *,
    origin_lat: float,
    origin_lon: float,
    max_altitude_m: float,
    max_distance_km: float,
    now: float,
) -> list[Sighting]:
    max_dist_m = max_distance_km * 1000.0
    out: list[Sighting] = []
    for row in states:
        if not isinstance(row, (list, tuple)) or len(row) < 14:
            continue
        icao24 = _as_str(row[0])
        if not icao24:
            continue
        icao24 = icao24.lower()
        on_ground = bool(row[8]) if row[8] is not None else False
        if on_ground:
            continue
        lat = _as_float(row[6])
        lon = _as_float(row[5])
        if lat is None or lon is None:
            continue
        geo_alt = _as_float(row[13])
        baro_alt = _as_float(row[7])
        altitude = geo_alt if geo_alt is not None else baro_alt
        if altitude is None or altitude > max_altitude_m:
            continue
        if altitude < -100:
            continue

        dist = haversine_m(origin_lat, origin_lon, lat, lon)
        if dist > max_dist_m:
            continue

        t_pos = _as_float(row[3])
        t_contact = _as_float(row[4])
        ts = t_pos or t_contact or now

        out.append(
            Sighting(
                icao24=icao24,
                callsign=_as_str(row[1]),
                origin_country=_as_str(row[2]),
                ts=ts,
                lat=lat,
                lon=lon,
                distance_m=dist,
                altitude_m=altitude,
                velocity_ms=_as_float(row[9]),
                track_deg=_as_float(row[10]),
                vertical_rate_ms=_as_float(row[11]),
            )
        )
    return out


def process_poll(force: bool = False) -> int:  # noqa: ARG001
    """Jeden poll OpenSky → persist sightingů. Vrací počet sightingů."""
    cfg = get_config()
    if not cfg.enabled or cfg.lat is None or cfg.lon is None:
        return 0

    now = time.time()
    try:
        api_ts, states = fetch_states(cfg)
        sightings = parse_sightings(
            states,
            origin_lat=cfg.lat,
            origin_lon=cfg.lon,
            max_altitude_m=cfg.max_altitude_m,
            max_distance_km=cfg.max_distance_km,
            now=float(api_ts) if api_ts else now,
        )
        if _persist_fn is not None and sightings:
            _persist_fn(sightings)
        _status["last_poll_at"] = now
        _status["last_poll_ok"] = True
        _status["last_error"] = None
        _status["last_sightings"] = len(sightings)
        if sightings:
            logger.info("OpenSky: %d slyšitelných sightingů", len(sightings))
        return len(sightings)
    except Exception as exc:  # noqa: BLE001
        _status["last_poll_at"] = now
        _status["last_poll_ok"] = False
        _status["last_error"] = str(exc)
        logger.warning("OpenSky poll: %s", exc)
        return 0


def start_aircraft_poll() -> None:
    global _refresh_thread
    cfg = get_config()
    if not cfg.enabled:
        logger.info("Aircraft poll vypnutý (souřadnice / AIRCRAFT_ENABLED)")
        return
    if _refresh_thread and _refresh_thread.is_alive():
        return

    def loop() -> None:
        try:
            process_poll()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Úvodní aircraft poll: %s", exc)
        while not _stop_event.is_set():
            interval = get_config().poll_interval_s
            if _stop_event.wait(interval):
                break
            try:
                process_poll()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Aircraft poll: %s", exc)

    _stop_event.clear()
    _refresh_thread = threading.Thread(target=loop, name="aircraft-opensky", daemon=True)
    _refresh_thread.start()
    logger.info(
        "Aircraft poll start (interval=%.0fs, max_alt=%.0fm, max_dist=%.1fkm)",
        cfg.poll_interval_s,
        cfg.max_altitude_m,
        cfg.max_distance_km,
    )


def stop_aircraft_poll() -> None:
    _stop_event.set()
