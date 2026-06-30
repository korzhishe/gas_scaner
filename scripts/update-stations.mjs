import { writeFile } from "node:fs/promises";

const DATA_SOURCE_URL = process.env.DATA_SOURCE_URL;
const OUTPUT_FILE = process.env.OUTPUT_FILE || "data/stations.json";

if (!DATA_SOURCE_URL) {
  console.log("DATA_SOURCE_URL is empty; keeping existing station data.");
  process.exit(0);
}

const response = await fetch(DATA_SOURCE_URL, {
  headers: {
    accept: "application/json",
    authorization: process.env.DATA_SOURCE_TOKEN ? `Bearer ${process.env.DATA_SOURCE_TOKEN}` : "",
  },
});

if (!response.ok) {
  throw new Error(`Data source returned ${response.status} ${response.statusText}`);
}

const incoming = await response.json();
const payload = normalizePayload(incoming);

await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Updated ${OUTPUT_FILE}: ${payload.stations.length} stations`);

function normalizePayload(input) {
  const stations = Array.isArray(input) ? input : input.stations;

  if (!Array.isArray(stations)) {
    throw new Error("Expected JSON array or object with a stations array");
  }

  return {
    generatedAt: input.generatedAt || new Date().toISOString(),
    sourceLabel: input.sourceLabel || "Live data source",
    stations: stations.map(normalizeStation),
  };
}

function normalizeStation(station) {
  const required = ["id", "name", "address", "coords"];
  for (const field of required) {
    if (!station[field]) {
      throw new Error(`Station is missing required field: ${field}`);
    }
  }

  if (!Number.isFinite(Number(station.coords.lat)) || !Number.isFinite(Number(station.coords.lng))) {
    throw new Error(`Station ${station.id} has invalid coordinates`);
  }

  return {
    id: String(station.id),
    name: String(station.name),
    brand: station.brand ? String(station.brand) : "",
    district: station.district ? String(station.district) : "",
    address: String(station.address),
    coords: {
      lat: Number(station.coords.lat),
      lng: Number(station.coords.lng),
    },
    status: ["open", "closed", "unknown"].includes(station.status) ? station.status : "unknown",
    openUntil: station.openUntil ? String(station.openUntil) : "",
    updatedAt: station.updatedAt || new Date().toISOString(),
    traffic: {
      score: clamp(Number(station.traffic?.score ?? 0), 0, 10),
      label: station.traffic?.label ? String(station.traffic.label) : "Нет данных",
      delayMin: Math.max(0, Number(station.traffic?.delayMin ?? 0)),
    },
    fuels: Array.isArray(station.fuels) ? station.fuels.map(normalizeFuel) : [],
    services: Array.isArray(station.services) ? station.services.map(String) : [],
  };
}

function normalizeFuel(fuel) {
  return {
    type: String(fuel.type),
    price: fuel.price === null || fuel.price === undefined || fuel.price === "" ? null : Number(fuel.price),
    available: Boolean(fuel.available),
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
