#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
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
            """
        )

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
                }
            )

        return {
            "generatedAt": utc_now(),
            "sourceLabel": "Collector: цены RUSSIABASE, расписания OpenStreetMap/2ГИС",
            "stations": stations,
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
            else:
                self.write_error(HTTPStatus.NOT_FOUND, "Not found")
        except Exception as exc:
            self.write_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path != "/api/reports":
                self.write_error(HTTPStatus.NOT_FOUND, "Not found")
                return

            payload = self.read_json_body()
            if not self.authorized(payload):
                self.write_error(HTTPStatus.UNAUTHORIZED, "Invalid collector token")
                return

            result = save_report(payload, self.client_address[0] if self.client_address else "")
            self.write_json(result, HTTPStatus.CREATED)
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
