#!/usr/bin/env python3
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("COLLECTOR_DB", ROOT / "collector" / "stations.sqlite3"))
SEED_PATH = Path(os.environ.get("COLLECTOR_SEED", ROOT / "data" / "stations.json"))
HOST = os.environ.get("COLLECTOR_HOST", "0.0.0.0")
PORT = int(os.environ.get("COLLECTOR_PORT", "8090"))
TOKEN = os.environ.get("COLLECTOR_TOKEN", "")
MAX_BODY_BYTES = 256 * 1024
FUEL_SIGNAL_TTL_HOURS = int(os.environ.get("FUEL_SIGNAL_TTL_HOURS", "36"))

FUEL_TYPES = ("АИ-92", "АИ-95", "АИ-98", "АИ-100", "ДТ", "Газ")


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS stations (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              brand TEXT DEFAULT '',
              district TEXT DEFAULT '',
              address TEXT NOT NULL,
              lat REAL NOT NULL,
              lng REAL NOT NULL,
              services_json TEXT DEFAULT '[]',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS station_state (
              station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
              status TEXT NOT NULL DEFAULT 'unknown',
              open_until TEXT DEFAULT '',
              traffic_score REAL NOT NULL DEFAULT 0,
              traffic_label TEXT DEFAULT 'Нет данных',
              traffic_delay_min REAL NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL,
              source TEXT DEFAULT 'seed'
            );

            CREATE TABLE IF NOT EXISTS fuel_state (
              station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
              fuel_type TEXT NOT NULL,
              price REAL,
              available INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL,
              source TEXT DEFAULT 'seed',
              PRIMARY KEY (station_id, fuel_type)
            );

            CREATE TABLE IF NOT EXISTS reports (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              station_id TEXT,
              payload_json TEXT NOT NULL,
              source TEXT DEFAULT 'manual',
              remote_addr TEXT DEFAULT '',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS fuel_signals (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
              category TEXT NOT NULL DEFAULT 'unknown',
              confidence REAL NOT NULL DEFAULT 0.4,
              queue_level TEXT DEFAULT '',
              fuel_types_json TEXT DEFAULT '[]',
              note TEXT DEFAULT '',
              raw_text TEXT NOT NULL,
              source TEXT DEFAULT 'manual',
              source_url TEXT DEFAULT '',
              observed_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            """
        )
        ensure_column(conn, "fuel_signals", "source_url", "TEXT DEFAULT ''")

        count = conn.execute("SELECT COUNT(*) AS count FROM stations").fetchone()["count"]
        if count == 0:
            seed_from_file(conn)


def seed_from_file(conn):
    if not SEED_PATH.exists():
        return

    payload = json.loads(SEED_PATH.read_text("utf-8"))
    for station in payload.get("stations", []):
        upsert_station(conn, station, station.get("updatedAt") or utc_now())
        upsert_state(
            conn,
            station["id"],
            {
                "status": station.get("status", "unknown"),
                "openUntil": station.get("openUntil", ""),
                "traffic": station.get("traffic", {}),
                "updatedAt": station.get("updatedAt"),
                "source": "seed",
            },
        )
        upsert_fuels(conn, station["id"], station.get("fuels", []), station.get("updatedAt"), "seed")


def upsert_station(conn, station, created_at=None):
    coords = station.get("coords") or {}
    services = station.get("services") if isinstance(station.get("services"), list) else []
    station_id = clean_text(station.get("id"))
    name = clean_text(station.get("name"))
    address = clean_text(station.get("address"))
    lat = to_float(coords.get("lat"))
    lng = to_float(coords.get("lng"))

    if not station_id or not name or not address or lat is None or lng is None:
        raise ValueError("station requires id, name, address, coords.lat and coords.lng")

    conn.execute(
        """
        INSERT INTO stations (id, name, brand, district, address, lat, lng, services_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          brand = excluded.brand,
          district = excluded.district,
          address = excluded.address,
          lat = excluded.lat,
          lng = excluded.lng,
          services_json = excluded.services_json
        """,
        (
            station_id,
            name,
            clean_text(station.get("brand")),
            clean_text(station.get("district")),
            address,
            lat,
            lng,
            json.dumps([clean_text(item) for item in services], ensure_ascii=False),
            created_at or utc_now(),
        ),
    )


def upsert_state(conn, station_id, payload):
    current = conn.execute("SELECT * FROM station_state WHERE station_id = ?", (station_id,)).fetchone()
    has_traffic = isinstance(payload.get("traffic"), dict)
    traffic = payload.get("traffic") if has_traffic else {}
    raw_status = clean_text(payload.get("status"))
    if raw_status in ("open", "closed", "unknown"):
        status = raw_status
    elif raw_status:
        status = "unknown"
    elif current:
        status = current["status"]
    else:
        status = "unknown"

    score = to_float(traffic.get("score"))
    if score is None:
        score = current["traffic_score"] if current else 0
    score = clamp(score, 0, 10)

    delay = to_float(traffic.get("delayMin"))
    if delay is None:
        delay = current["traffic_delay_min"] if current else 0

    updated_at = clean_text(payload.get("updatedAt")) or utc_now()
    source = clean_text(payload.get("source")) or "manual"
    label = clean_text(traffic.get("label"))
    if not label and current:
        label = current["traffic_label"]
    if not label and not has_traffic:
        label = "Нет данных"
    if not label:
        label = traffic_label(score)
    open_until = clean_text(payload.get("openUntil"))
    if not open_until and current:
        open_until = current["open_until"]

    conn.execute(
        """
        INSERT INTO station_state (
          station_id, status, open_until, traffic_score, traffic_label,
          traffic_delay_min, updated_at, source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(station_id) DO UPDATE SET
          status = excluded.status,
          open_until = excluded.open_until,
          traffic_score = excluded.traffic_score,
          traffic_label = excluded.traffic_label,
          traffic_delay_min = excluded.traffic_delay_min,
          updated_at = excluded.updated_at,
          source = excluded.source
        """,
        (station_id, status, open_until, score, label, max(0, delay), updated_at, source),
    )


def upsert_fuels(conn, station_id, fuels, updated_at=None, source="manual"):
    if not isinstance(fuels, list):
        return

    stamp = clean_text(updated_at) or utc_now()
    clean_source = clean_text(source) or "manual"
    for fuel in fuels:
        if not isinstance(fuel, dict):
            continue
        fuel_type = clean_text(fuel.get("type"))
        if not fuel_type:
            continue
        price = to_float(fuel.get("price"))
        available = 1 if bool(fuel.get("available")) else 0
        current = conn.execute(
            "SELECT price FROM fuel_state WHERE station_id = ? AND fuel_type = ?",
            (station_id, fuel_type),
        ).fetchone()
        if price is None and available and current and current["price"] is not None:
            price = current["price"]
        conn.execute(
            """
            INSERT INTO fuel_state (station_id, fuel_type, price, available, updated_at, source)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(station_id, fuel_type) DO UPDATE SET
              price = excluded.price,
              available = excluded.available,
              updated_at = excluded.updated_at,
              source = excluded.source
            """,
            (station_id, fuel_type, price, available, stamp, clean_source),
        )


def export_payload():
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT
              s.*,
              COALESCE(st.status, 'unknown') AS status,
              COALESCE(st.open_until, '') AS open_until,
              COALESCE(st.traffic_score, 0) AS traffic_score,
              COALESCE(st.traffic_label, 'Нет данных') AS traffic_label,
              COALESCE(st.traffic_delay_min, 0) AS traffic_delay_min,
              COALESCE(st.updated_at, s.created_at) AS state_updated_at
            FROM stations s
            LEFT JOIN station_state st ON st.station_id = s.id
            ORDER BY s.name COLLATE NOCASE
            """
        ).fetchall()

        stations = []
        for row in rows:
            fuel_rows = conn.execute(
                """
                SELECT fuel_type, price, available, updated_at
                FROM fuel_state
                WHERE station_id = ?
                ORDER BY
                  CASE fuel_type
                    WHEN 'АИ-92' THEN 1
                    WHEN 'АИ-95' THEN 2
                    WHEN 'АИ-98' THEN 3
                    WHEN 'АИ-100' THEN 4
                    WHEN 'ДТ' THEN 5
                    WHEN 'Газ' THEN 6
                    ELSE 99
                  END,
                  fuel_type
                """,
                (row["id"],),
            ).fetchall()

            fuel_updates = [item["updated_at"] for item in fuel_rows if item["updated_at"]]
            updated_at = max([row["state_updated_at"], *fuel_updates])
            stations.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "brand": row["brand"],
                    "district": row["district"],
                    "address": row["address"],
                    "coords": {"lat": row["lat"], "lng": row["lng"]},
                    "status": row["status"],
                    "openUntil": row["open_until"],
                    "updatedAt": updated_at,
                    "traffic": {
                        "score": row["traffic_score"],
                        "label": row["traffic_label"],
                        "delayMin": row["traffic_delay_min"],
                    },
                    "fuels": [
                        {
                            "type": item["fuel_type"],
                            "price": item["price"],
                            "available": bool(item["available"]),
                        }
                        for item in fuel_rows
                    ],
                    "services": json.loads(row["services_json"] or "[]"),
                    "signals": [],
                }
            )

        signals = recent_signals(conn)
        station_by_id = {station["id"]: station for station in stations}
        floating_signals = []
        for signal in signals:
            station_id = signal.get("stationId")
            if station_id and station_id in station_by_id:
                station_by_id[station_id]["signals"].append(signal)
            else:
                floating_signals.append(signal)

        return {
            "generatedAt": utc_now(),
            "sourceLabel": "Collector: АЗС и расписания 2ГИС/OpenStreetMap, цены RUSSIABASE",
            "stations": stations,
            "signals": floating_signals[:50],
        }


def save_report(payload, remote_addr):
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")

    payload = dict(payload)
    payload.pop("token", None)
    station = payload.get("station") if isinstance(payload.get("station"), dict) else None
    station_id = clean_text(payload.get("stationId") or payload.get("station_id") or (station or {}).get("id"))
    if not station_id:
        raise ValueError("stationId is required")

    now = clean_text(payload.get("updatedAt")) or utc_now()
    source = clean_text(payload.get("source")) or "manual"

    with connect() as conn:
        exists = conn.execute("SELECT 1 FROM stations WHERE id = ?", (station_id,)).fetchone()
        if station:
            station["id"] = station_id
            upsert_station(conn, station, now)
        elif not exists:
            station_payload = station or payload
            station_payload["id"] = station_id
            upsert_station(conn, station_payload, now)

        state_payload = {
            "status": payload.get("status"),
            "openUntil": payload.get("openUntil"),
            "traffic": payload.get("traffic"),
            "updatedAt": now,
            "source": source,
        }
        upsert_state(conn, station_id, state_payload)
        upsert_fuels(conn, station_id, payload.get("fuels", []), now, source)
        conn.execute(
            """
            INSERT INTO reports (station_id, payload_json, source, remote_addr, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (station_id, json.dumps(payload, ensure_ascii=False), source, remote_addr, now),
        )

    return {"ok": True, "stationId": station_id, "updatedAt": now}


def reports_payload(query):
    station_id = clean_text((query.get("stationId") or query.get("station_id") or [""])[0])
    limit = int_or_default((query.get("limit") or ["50"])[0], 50)
    limit = int(clamp(limit, 1, 200))

    sql = "SELECT * FROM reports"
    params = []
    if station_id:
        sql += " WHERE station_id = ?"
        params.append(station_id)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    with connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return {
        "reports": [
            {
                "id": row["id"],
                "stationId": row["station_id"],
                "payload": json.loads(row["payload_json"]),
                "source": row["source"],
                "remoteAddr": row["remote_addr"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]
    }


def signals_payload(query):
    station_id = clean_text((query.get("stationId") or query.get("station_id") or [""])[0])
    limit = int_or_default((query.get("limit") or ["80"])[0], 80)
    limit = int(clamp(limit, 1, 300))

    with connect() as conn:
        signals = recent_signals(conn, station_id=station_id, limit=limit)

    return {"signals": signals}


def recent_signals(conn, station_id="", limit=500):
    threshold = datetime.now(timezone.utc) - timedelta(hours=FUEL_SIGNAL_TTL_HOURS)
    sql = """
      SELECT *
      FROM fuel_signals
      WHERE expires_at >= ?
    """
    params = [to_utc_iso(threshold)]
    if station_id:
        sql += " AND station_id = ?"
        params.append(station_id)
    sql += " ORDER BY observed_at DESC, id DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    return [signal_row(row) for row in rows]


def signal_row(row):
    return {
        "id": row["id"],
        "stationId": row["station_id"] or "",
        "category": row["category"],
        "confidence": row["confidence"],
        "queueLevel": row["queue_level"] or "",
        "fuelTypes": json.loads(row["fuel_types_json"] or "[]"),
        "note": row["note"],
        "source": row["source"],
        "sourceUrl": row["source_url"] or "",
        "observedAt": row["observed_at"],
        "expiresAt": row["expires_at"],
    }


def save_signal(payload, remote_addr):
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")

    raw_text = clean_text(payload.get("rawText") or payload.get("text"))
    if not raw_text:
        raise ValueError("rawText is required")

    now = utc_now()
    observed_at = parse_observed_at(payload.get("observedAt"), raw_text) or now
    observed_dt = parse_iso_datetime(observed_at) or datetime.now(timezone.utc)
    expires_at = clean_text(payload.get("expiresAt")) or to_utc_iso(observed_dt + timedelta(hours=FUEL_SIGNAL_TTL_HOURS))
    source = clean_text(payload.get("sourceName") or payload.get("source")) or "social"
    source_url = clean_text(payload.get("sourceUrl") or payload.get("url"))

    with connect() as conn:
        requested_station_id = clean_text(payload.get("stationId") or payload.get("station_id"))
        station_id = requested_station_id
        if station_id and not conn.execute("SELECT 1 FROM stations WHERE id = ?", (station_id,)).fetchone():
            station_id = ""
        if not station_id and not payload.get("skipStationMatch"):
            station_id = match_signal_station(conn, raw_text)

        parsed = parse_signal(raw_text)
        category = clean_text(payload.get("category")) or parsed["category"]
        queue_level = clean_text(payload.get("queueLevel")) or parsed["queueLevel"]
        fuel_types = payload.get("fuelTypes") if isinstance(payload.get("fuelTypes"), list) else parsed["fuelTypes"]
        confidence = to_float(payload.get("confidence"))
        if confidence is None:
            confidence = parsed["confidence"]
        confidence = clamp(confidence, 0, 1)
        note = clean_text(payload.get("note")) or build_signal_note(parsed, raw_text)
        existing = None
        if source_url:
            existing = conn.execute("SELECT id, station_id FROM fuel_signals WHERE source_url = ?", (source_url,)).fetchone()
        if not existing:
            existing = conn.execute(
                "SELECT id, station_id FROM fuel_signals WHERE raw_text = ? AND source = ? AND observed_at = ?",
                (raw_text, source, observed_at),
            ).fetchone()
        if existing:
            if payload.get("skipStationMatch"):
                station_id = ""
            elif requested_station_id:
                station_id = station_id or existing["station_id"] or ""
            conn.execute(
                """
                UPDATE fuel_signals
                SET station_id = ?,
                    category = ?,
                    confidence = ?,
                    queue_level = ?,
                    fuel_types_json = ?,
                    note = ?,
                    raw_text = ?,
                    source = ?,
                    observed_at = ?,
                    expires_at = ?
                WHERE id = ?
                """,
                (
                    station_id or None,
                    category,
                    confidence,
                    queue_level,
                    json.dumps([clean_text(item) for item in fuel_types if clean_text(item)], ensure_ascii=False),
                    note,
                    raw_text,
                    source,
                    observed_at,
                    expires_at,
                    existing["id"],
                ),
            )
            return {"ok": True, "signalId": existing["id"], "stationId": station_id, "category": category, "observedAt": observed_at}

        cursor = conn.execute(
            """
            INSERT INTO fuel_signals (
              station_id, category, confidence, queue_level, fuel_types_json,
              note, raw_text, source, source_url, observed_at, expires_at, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                station_id or None,
                category,
                confidence,
                queue_level,
                json.dumps([clean_text(item) for item in fuel_types if clean_text(item)], ensure_ascii=False),
                note,
                raw_text,
                source,
                source_url,
                observed_at,
                expires_at,
                now,
            ),
        )
        signal_id = cursor.lastrowid

    return {"ok": True, "signalId": signal_id, "stationId": station_id, "category": category, "observedAt": observed_at}


def parse_signal(text):
    lowered = text.lower().replace("ё", "е")
    fuel_types = []
    if re.search(r"\b92\b|аи[-\s]?92", lowered):
        fuel_types.append("АИ-92")
    if re.search(r"\b95\b|аи[-\s]?95", lowered):
        fuel_types.append("АИ-95")
    if re.search(r"\b98\b|аи[-\s]?98", lowered):
        fuel_types.append("АИ-98")
    if re.search(r"\b100\b|аи[-\s]?100", lowered):
        fuel_types.append("АИ-100")
    if re.search(r"\bдт\b|дизел", lowered):
        fuel_types.append("ДТ")
    if re.search(r"\bгаз\b|метан|пропан", lowered):
        fuel_types.append("Газ")
    if not fuel_types and re.search(r"бензин|топлив|заправ", lowered):
        fuel_types.append("Бензин")

    has_delivery = bool(re.search(r"будет|привез|привоз|завоз|поставка|ожида", lowered))
    has_queue = bool(re.search(r"очеред|занима[ею]т|сто[ия]т\s+.*азс|колонн", lowered))
    has_closed = bool(re.search(r"закрыт|не\s+работа|много\s+закрытых", lowered))
    has_no_fuel = bool(
        re.search(
            r"нет\s+(бенз|топлив|дт|95|92)|без\s+(бенз|топлив)|кончил|нельзя\s+купить|не\s+отпускают\s+топлив|топлив[а-я]*\s+нет",
            lowered,
        )
    )
    has_available = bool(
        re.search(
            r"есть\s+(бенз|топлив|дт|95|92)|есть\s+в\s+продаже|в\s+наличии|залил|заправил|заправляют|можно\s+заправ|чтобы\s+заправ|выдают|отпускают|отпускали|продают",
            lowered,
        )
    )

    category = "unknown"
    confidence = 0.45
    if has_delivery:
        category = "delivery_expected"
        confidence = 0.72
    elif has_available:
        category = "fuel_available"
        confidence = 0.75
    elif has_no_fuel:
        category = "no_fuel"
        confidence = 0.72
    elif has_closed:
        category = "closed_many"
        confidence = 0.65
    elif has_queue:
        category = "queue"
        confidence = 0.62

    queue_level = ""
    if has_queue:
        queue_level = "high" if re.search(r"пиздец|огром|больш|много|еще\s+больше|толп", lowered) else "medium"

    if has_queue and category in ("delivery_expected", "fuel_available"):
        confidence = min(1, confidence + 0.08)

    return {
        "category": category,
        "confidence": confidence,
        "queueLevel": queue_level,
        "fuelTypes": fuel_types,
    }


def build_signal_note(parsed, raw_text):
    labels = {
        "delivery_expected": "ожидается привоз",
        "fuel_available": "есть топливо",
        "no_fuel": "сообщают, что топлива нет",
        "closed_many": "сообщают о закрытых АЗС",
        "queue": "сообщают об очереди",
        "unknown": "сообщение требует проверки",
    }
    parts = [labels.get(parsed["category"], labels["unknown"])]
    if parsed["queueLevel"] == "high":
        parts.append("большая очередь")
    elif parsed["queueLevel"]:
        parts.append("есть очередь")
    time_hint = parse_time_hint(raw_text)
    if time_hint:
        parts.append(f"время: {time_hint}")
    if parsed["fuelTypes"]:
        parts.append(", ".join(parsed["fuelTypes"]))
    return "; ".join(parts)


def parse_observed_at(value, raw_text):
    cleaned = clean_text(value)
    if cleaned:
        parsed = parse_iso_datetime(cleaned)
        if parsed:
            return to_utc_iso(parsed)

    match = re.search(r"\[?(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})\]?", raw_text)
    if not match:
        return ""

    day, month, year, hour, minute = match.groups()
    year = int(year)
    if year < 100:
        year += 2000
    observed = datetime(year, int(month), int(day), int(hour), int(minute), tzinfo=timezone(timedelta(hours=3)))
    return to_utc_iso(observed.astimezone(timezone.utc))


def parse_time_hint(raw_text):
    match = re.search(r"(?:в|к)\s*(\d{1,2})[\s:.-]?(\d{2})?", raw_text.lower())
    if not match:
        return ""
    hour = int(match.group(1))
    minute = int(match.group(2) or "0")
    if hour > 23 or minute > 59:
        return ""
    return f"{hour:02d}:{minute:02d}"


def match_signal_station(conn, raw_text):
    text = normalize_match_text(raw_text)
    if not text:
        return ""

    rows = conn.execute("SELECT id, name, brand, address FROM stations").fetchall()
    hinted = match_station_by_hints(rows, text)
    if hinted:
        return hinted

    if not has_station_specific_hint(text):
        return ""

    best = {"id": "", "score": 0}
    for row in rows:
        fields = [row["name"], row["brand"], row["address"]]
        tokens = {
            token
            for value in fields
            for token in normalize_match_text(value).split()
            if is_match_token(token)
        }
        if not tokens:
            continue
        score = sum(1 for token in tokens if token in text)
        if score > best["score"]:
            best = {"id": row["id"], "score": score}

    return best["id"] if best["score"] >= 2 else ""


def match_station_by_hints(rows, text):
    hints = [
        {
            "text_all": ("лукойл",),
            "text_any": ("пять звезд", "пяти звезд", "тц пять звезд", "юмр", "юбилейный"),
            "station_all": ("лукойл", "чекистов"),
        },
        {
            "text_all": ("газпромнефть", "уральская"),
            "station_all": ("газпромнефть", "уральская"),
        },
    ]

    for hint in hints:
        text_all = hint.get("text_all", ())
        text_any = hint.get("text_any", ())
        if text_all and not all(item in text for item in text_all):
            continue
        if text_any and not any(item in text for item in text_any):
            continue

        for row in rows:
            station_text = normalize_match_text(" ".join([row["name"], row["brand"], row["address"]]))
            if all(item in station_text for item in hint["station_all"]):
                return row["id"]

    return ""


def has_station_specific_hint(text):
    brands = (
        "лукойл",
        "lukoil",
        "роснефть",
        "газпромнефть",
        "газпром",
        "татнефть",
        "teboil",
        "rusoil",
        "ирбис",
        "pnb",
    )
    address_or_landmark = re.search(
        r"улиц|ул\s|проспект|шоссе|трасс|километр|\bкм\b|тц|пять\s+звезд|пяти\s+звезд|минск|чекистов|уральск|фадеев|ростовск|дзержинск|западн",
        text,
    )
    return bool(address_or_landmark and any(brand in text for brand in brands))


def normalize_match_text(value):
    return re.sub(r"[^a-zа-я0-9]+", " ", clean_text(value).lower().replace("ё", "е"))


def is_match_token(token):
    stopwords = {
        "автозаправочная",
        "адыгея",
        "бензин",
        "газомоторное",
        "заправка",
        "заправочная",
        "краснодар",
        "краснодарский",
        "край",
        "станция",
        "топливо",
        "улица",
        "федеральная",
        "шоссе",
    }
    if len(token) < 5:
        return False
    return token not in stopwords


def prune_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")

    delete_ids = [
        clean_text(item)
        for item in payload.get("deleteStationIds", [])
        if clean_text(item)
    ]
    if not delete_ids:
        return {"ok": True, "deleted": 0}

    with connect() as conn:
        placeholders = ",".join("?" for _ in delete_ids)
        result = conn.execute(f"DELETE FROM stations WHERE id IN ({placeholders})", delete_ids)
        deleted = result.rowcount if result.rowcount is not None else 0

    return {"ok": True, "deleted": deleted}


class Handler(BaseHTTPRequestHandler):
    server_version = "GasScannerCollector/1.0"

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Collector-Token")
        self.send_header("Access-Control-Max-Age", "86400")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path in ("/health", "/api/health"):
                self.write_json({"ok": True, "generatedAt": utc_now()})
            elif parsed.path in ("/api/stations", "/api/export"):
                self.write_json(export_payload())
            elif parsed.path == "/api/reports":
                self.write_json(reports_payload(parse_qs(parsed.query)))
            elif parsed.path == "/api/signals":
                self.write_json(signals_payload(parse_qs(parsed.query)))
            else:
                self.write_error(HTTPStatus.NOT_FOUND, "Not found")
        except Exception as exc:
            self.write_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path not in ("/api/reports", "/api/prune", "/api/signals"):
                self.write_error(HTTPStatus.NOT_FOUND, "Not found")
                return

            payload = self.read_json_body()
            if not self.authorized(payload):
                self.write_error(HTTPStatus.UNAUTHORIZED, "Invalid collector token")
                return

            if parsed.path == "/api/reports":
                result = save_report(payload, self.client_address[0] if self.client_address else "")
                self.write_json(result, HTTPStatus.CREATED)
            elif parsed.path == "/api/signals":
                result = save_signal(payload, self.client_address[0] if self.client_address else "")
                self.write_json(result, HTTPStatus.CREATED)
            else:
                self.write_json(prune_payload(payload))
        except ValueError as exc:
            self.write_error(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            self.write_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def read_json_body(self):
        size = int_or_default(self.headers.get("Content-Length"), 0)
        if size <= 0:
            raise ValueError("empty request body")
        if size > MAX_BODY_BYTES:
            raise ValueError("request body is too large")

        raw = self.rfile.read(size)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON: {exc}") from exc

    def authorized(self, payload):
        if not TOKEN:
            return True

        auth = self.headers.get("Authorization", "")
        header_token = self.headers.get("X-Collector-Token", "")
        body_token = clean_text(payload.get("token")) if isinstance(payload, dict) else ""
        if auth.startswith("Bearer "):
            header_token = auth.removeprefix("Bearer ").strip()
        return TOKEN in (header_token, body_token)

    def write_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_error(self, status, message):
        self.write_json({"ok": False, "error": message}, status)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {self.log_date_time_string()} - {fmt % args}", file=sys.stderr)


def clean_text(value):
    if value is None:
        return ""
    return str(value).strip()


def ensure_column(conn, table, column, definition):
    columns = {
        row["name"]
        for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def parse_iso_datetime(value):
    text = clean_text(value)
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def to_utc_iso(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_float(value):
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", "."))
    except ValueError:
        return None


def int_or_default(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def clamp(value, min_value, max_value):
    return max(min_value, min(max_value, value))


def traffic_label(score):
    if score <= 2:
        return "Свободно"
    if score <= 5:
        return "Умеренно"
    if score <= 7:
        return "Плотно"
    return "Стоит"


def main():
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Collector listening on http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
