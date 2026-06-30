import { writeFile } from "node:fs/promises";

const BENZUP_BASE_URL = env("BENZUP_BASE_URL", "https://api.omt-consult.ru");
const BENZUP_ENDPOINT = env("BENZUP_ENDPOINT", "/v2/stations");
const BENZUP_PRODUCTS_ENDPOINT = env("BENZUP_PRODUCTS_ENDPOINT", "/v2/products");
const BENZUP_TOKEN = process.env.BENZUP_TOKEN || "";
const COLLECTOR_URL = env("COLLECTOR_URL", "http://127.0.0.1:8090");
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";
const CITY_QUERY = env("BENZUP_CITY", "Краснодар").toLowerCase();
const BOUNDS = parseBounds(env("BENZUP_BOUNDS", "44.92,38.78,45.18,39.18"));
const DRY_RUN = process.argv.includes("--dry-run");
const RAW_OUTPUT = argValue("--save-raw");

main().catch((error) => fail(error.message));

async function main() {
  if (!BENZUP_TOKEN) {
    fail("BENZUP_TOKEN is empty. Add it to .collector.env or the process environment.");
  }

  const products = await loadProducts();
  const rawPayload = await benzupGet(BENZUP_ENDPOINT);
  const records = findRecordArray(rawPayload);

  if (RAW_OUTPUT) {
    await writeFile(RAW_OUTPUT, `${JSON.stringify(rawPayload, null, 2)}\n`, "utf8");
  }

  const stations = records.map((record) => normalizeStation(record, products)).filter(Boolean).filter(inKrasnodar);

  if (DRY_RUN) {
    console.log(`Benzup records: ${records.length}`);
    console.log(`Krasnodar stations: ${stations.length}`);
    console.log(JSON.stringify(stations.slice(0, 5), null, 2));
    return;
  }

  let imported = 0;
  for (const station of stations) {
    await postReport(station);
    imported += 1;
  }

  console.log(`Imported ${imported} Benzup stations into collector`);
}

async function loadProducts() {
  try {
    const payload = await benzupGet(BENZUP_PRODUCTS_ENDPOINT);
    const records = findRecordArray(payload);
    const map = new Map();
    for (const product of records) {
      const id = firstValue(product, ["id", "product_id", "productId", "code"]);
      const name = firstValue(product, ["name", "title", "product_name", "productName"]);
      if (id !== undefined && name) {
        map.set(String(id), String(name));
      }
    }
    return map;
  } catch (error) {
    console.warn(`Product dictionary skipped: ${error.message}`);
    return new Map();
  }
}

async function benzupGet(endpoint) {
  const response = await fetch(new URL(endpoint, BENZUP_BASE_URL), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${BENZUP_TOKEN}`,
    },
  });
  const text = await response.text();
  const payload = parseJson(text, endpoint);

  if (!response.ok) {
    const message = payload?.error_message || payload?.message || response.statusText;
    throw new Error(`Benzup ${endpoint} returned ${response.status}: ${message}`);
  }

  return payload;
}

async function postReport(station) {
  const response = await fetch(`${COLLECTOR_URL.replace(/\/$/, "")}/api/reports`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(COLLECTOR_TOKEN ? { authorization: `Bearer ${COLLECTOR_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      stationId: station.station.id,
      station: station.station,
      status: station.status,
      openUntil: station.openUntil,
      source: "benzup",
      updatedAt: station.updatedAt,
      fuels: station.fuels,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Collector rejected ${station.station.id}: ${payload.error || response.statusText}`);
  }
}

function normalizeStation(record, products) {
  const sourceId = clean(firstValue(record, ["id", "station_id", "stationId", "azs_id", "azsId", "code", "guid"]));
  const coords = extractCoords(record);
  const address = clean(firstValue(record, ["address", "full_address", "fullAddress", "addr", "location.address"]));
  const name =
    clean(firstValue(record, ["name", "title", "station_name", "stationName", "azs_name", "azsName"])) ||
    clean(firstValue(record, ["brand", "brand_name", "brandName", "network", "network_name"])) ||
    (sourceId ? `Benzup АЗС ${sourceId}` : "");

  if (!sourceId || !coords || !address || !name) {
    return null;
  }

  const brand = clean(firstValue(record, ["brand", "brand_name", "brandName", "network", "network_name", "company", "owner"]));
  const city = clean(firstValue(record, ["city", "city_name", "cityName", "settlement"]));
  const updatedAt = normalizeDate(firstValue(record, ["updated_at", "updatedAt", "date_update", "price_date", "priceDate"])) || nowIso();
  const status = normalizeStatus(firstValue(record, ["status", "is_open", "isOpen", "open", "active", "is_active"]));
  const openUntil = clean(firstValue(record, ["openUntil", "open_until", "working_hours", "work_time", "schedule", "hours"])) || "уточняется";
  const fuels = extractFuels(record, products);

  if (!fuels.length) {
    return null;
  }

  return {
    station: {
      id: `benzup-${sourceId}`,
      name,
      brand,
      district: city || CITY_QUERY,
      address,
      coords,
      services: ["Benzup"],
    },
    status,
    openUntil,
    updatedAt,
    fuels,
    raw: record,
  };
}

function extractCoords(record) {
  const lat = numberValue(firstValue(record, ["lat", "latitude", "coord_lat", "gps_lat", "coords.lat", "coordinates.lat", "location.lat"]));
  const lng = numberValue(
    firstValue(record, ["lng", "lon", "longitude", "coord_lng", "coord_lon", "gps_lng", "gps_lon", "coords.lng", "coords.lon", "coordinates.lng", "coordinates.lon", "location.lng", "location.lon"]),
  );

  if (lat !== null && lng !== null) {
    return { lat, lng };
  }

  const coords = firstValue(record, ["coords", "coordinates", "location.coordinates"]);
  if (Array.isArray(coords) && coords.length >= 2) {
    const first = numberValue(coords[0]);
    const second = numberValue(coords[1]);
    if (first !== null && second !== null) {
      return Math.abs(first) <= 90 ? { lat: first, lng: second } : { lat: second, lng: first };
    }
  }

  return null;
}

function extractFuels(record, products) {
  const candidates = [];
  collectPriceObjects(record, candidates);

  const fuels = [];
  const seen = new Set();
  for (const item of candidates) {
    const type = normalizeFuelType(productName(item, products));
    const price = numberValue(firstValue(item, ["price", "value", "cost", "retail_price", "retailPrice", "price_value", "cash_price"]));
    if (!type || price === null) continue;

    if (!seen.has(type)) {
      seen.add(type);
      fuels.push({ type, price, available: true });
    }
  }

  extractFlatPriceFields(record, fuels, seen);
  return fuels;
}

function collectPriceObjects(value, out, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (looksLikePriceRecord(item)) {
        out.push(item);
      } else {
        collectPriceObjects(item, out, depth + 1);
      }
    }
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) && /price|fuel|product|товар|топлив/i.test(key)) {
      for (const child of item) {
        if (looksLikePriceRecord(child)) out.push(child);
      }
    } else if (item && typeof item === "object") {
      collectPriceObjects(item, out, depth + 1);
    }
  }
}

function looksLikePriceRecord(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const keys = Object.keys(item).join(" ").toLowerCase();
  return /(price|cost|value|цена)/.test(keys) && /(product|fuel|name|type|id|товар|топлив)/.test(keys);
}

function productName(item, products) {
  const direct = firstValue(item, ["fuel", "fuel_type", "fuelType", "type", "name", "title", "product", "product_name", "productName"]);
  if (direct && typeof direct === "object") {
    return firstValue(direct, ["name", "title", "product_name", "productName"]);
  }
  if (direct) return direct;

  const productId = firstValue(item, ["product_id", "productId", "id_product", "product"]);
  if (productId !== undefined && products.has(String(productId))) {
    return products.get(String(productId));
  }

  return "";
}

function extractFlatPriceFields(record, fuels, seen) {
  const mappings = [
    [/92/, "АИ-92"],
    [/95/, "АИ-95"],
    [/(98|100)/, "АИ-98"],
    [/(diesel|dt|дт|диз)/i, "ДТ"],
    [/(gas|lpg|газ|метан|пропан)/i, "Газ"],
  ];

  for (const [key, value] of Object.entries(record)) {
    if (!/(price|cost|ai|аи|dt|дт|diesel|gas|газ)/i.test(key)) continue;
    const price = numberValue(value);
    if (price === null) continue;
    const match = mappings.find(([pattern]) => pattern.test(key));
    if (!match) continue;
    const type = match[1];
    if (!seen.has(type)) {
      seen.add(type);
      fuels.push({ type, price, available: true });
    }
  }
}

function normalizeFuelType(value) {
  const text = clean(value).toLowerCase();
  if (!text) return "";
  if (/(^|[^0-9])92([^0-9]|$)/.test(text)) return "АИ-92";
  if (/(^|[^0-9])95([^0-9]|$)/.test(text)) return "АИ-95";
  if (/(^|[^0-9])(98|100)([^0-9]|$)/.test(text)) return "АИ-98";
  if (/(дт|диз|diesel)/i.test(text)) return "ДТ";
  if (/(газ|метан|пропан|lpg|gas)/i.test(text)) return "Газ";
  return "";
}

function inKrasnodar(station) {
  const { lat, lng } = station.station.coords;
  const inBounds = lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng;
  const text = `${station.station.address} ${station.station.district} ${station.station.name}`.toLowerCase();
  return inBounds || text.includes(CITY_QUERY);
}

function findRecordArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", "stations", "items", "result", "results", "rows"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }

  const arrays = [];
  collectArrays(payload, arrays);
  const stationLike = arrays.find((items) => items.filter(isStationLike).length >= Math.max(1, Math.floor(items.length * 0.5)));
  if (stationLike) return stationLike;

  throw new Error("Could not find a station array in Benzup response");
}

function collectArrays(value, out, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return;
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => item && typeof item === "object")) out.push(value);
    for (const item of value) collectArrays(item, out, depth + 1);
    return;
  }
  for (const item of Object.values(value)) collectArrays(item, out, depth + 1);
}

function isStationLike(item) {
  if (!item || typeof item !== "object") return false;
  const keys = Object.keys(item).join(" ").toLowerCase();
  return /(address|адрес|lat|latitude|coord|gps|station|azs|азс)/.test(keys);
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = getPath(object, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function getPath(object, path) {
  return path.split(".").reduce((cursor, key) => {
    if (cursor === undefined || cursor === null) return undefined;
    return cursor[key];
  }, object);
}

function normalizeStatus(value) {
  if (value === undefined || value === null || value === "") return "unknown";
  if (typeof value === "boolean") return value ? "open" : "closed";
  const text = String(value).toLowerCase();
  if (["1", "true", "yes", "open", "active", "работает", "открыта", "открыто"].includes(text)) return "open";
  if (["0", "false", "no", "closed", "inactive", "закрыта", "закрыто"].includes(text)) return "closed";
  return "unknown";
}

function parseBounds(value) {
  const [minLat, minLng, maxLat, maxLng] = value.split(",").map((item) => Number(item.trim()));
  if ([minLat, minLng, maxLat, maxLng].some((item) => !Number.isFinite(item))) {
    fail("BENZUP_BOUNDS must be minLat,minLng,maxLat,maxLng");
  }
  return { minLat, minLng, maxLat, maxLng };
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function numberValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${label}: ${text.slice(0, 120)}`);
  }
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
