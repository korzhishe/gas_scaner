const COLLECTOR_URL = env("COLLECTOR_URL", "http://127.0.0.1:8090");
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";
const OVERPASS_URL = env("OVERPASS_URL", "https://overpass-api.de/api/interpreter");
const OSM_BOUNDS = parseBounds(env("OSM_BOUNDS", "44.90,38.75,45.20,39.20"));
const OSM_MATCH_RADIUS_M = Number(env("OSM_MATCH_RADIUS_M", "220"));
const OSM_TIME_ZONE = env("OSM_TIME_ZONE", "Europe/Moscow");
const DRY_RUN = process.argv.includes("--dry-run");

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const stationsPayload = await collectorGet("/api/stations");
  const stations = stationsPayload.stations || [];
  const osmObjects = await loadOsmFuelObjects();
  const reports = [];

  for (const station of stations) {
    const match = findBestMatch(station, osmObjects);
    if (!match?.tags?.opening_hours) continue;

    const schedule = match.tags.opening_hours.trim();
    const status = isOpenNow(schedule, new Date(), OSM_TIME_ZONE) ? "open" : "closed";
    reports.push({
      stationId: station.id,
      status,
      openUntil: schedule,
      source: "osm-opening-hours",
      updatedAt: new Date().toISOString(),
      osm: {
        type: match.type,
        id: match.id,
        name: match.tags.name || "",
        brand: match.tags.brand || "",
        distanceM: Math.round(match.distanceM),
      },
    });
  }

  if (DRY_RUN) {
    console.log(`Collector stations: ${stations.length}`);
    console.log(`OSM fuel objects: ${osmObjects.length}`);
    console.log(`Matched schedules: ${reports.length}`);
    console.log(JSON.stringify(reports.slice(0, 12), null, 2));
    return;
  }

  let imported = 0;
  for (const report of reports) {
    await postReport(report);
    imported += 1;
  }

  console.log(`Imported ${imported} OSM opening_hours reports into collector`);
}

async function collectorGet(path) {
  const response = await fetch(`${COLLECTOR_URL.replace(/\/$/, "")}${path}`, {
    headers: {
      accept: "application/json",
      ...(COLLECTOR_TOKEN ? { authorization: `Bearer ${COLLECTOR_TOKEN}` } : {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Collector ${path} returned ${response.status}: ${payload.error || response.statusText}`);
  }
  return payload;
}

async function postReport(report) {
  const response = await fetch(`${COLLECTOR_URL.replace(/\/$/, "")}/api/reports`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(COLLECTOR_TOKEN ? { authorization: `Bearer ${COLLECTOR_TOKEN}` } : {}),
    },
    body: JSON.stringify(report),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Collector rejected ${report.stationId}: ${payload.error || response.statusText}`);
  }
}

async function loadOsmFuelObjects() {
  const query = `[out:json][timeout:25];(node["amenity"="fuel"](${boundsString(OSM_BOUNDS)});way["amenity"="fuel"](${boundsString(OSM_BOUNDS)});relation["amenity"="fuel"](${boundsString(OSM_BOUNDS)}););out center tags;`;
  const body = new URLSearchParams({ data: query });
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "gas-scaner-osm-opening-hours/1.0 (+https://github.com/korzhishe/gas_scaner)",
    },
    body,
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Overpass returned ${response.status}: ${text.slice(0, 160)}`);
  }

  const payload = parseJson(text, "Overpass");
  return (payload.elements || [])
    .map((element) => {
      const lat = numberValue(element.lat ?? element.center?.lat);
      const lng = numberValue(element.lon ?? element.center?.lon);
      if (lat === null || lng === null) return null;
      return {
        type: element.type,
        id: element.id,
        lat,
        lng,
        tags: element.tags || {},
      };
    })
    .filter(Boolean);
}

function findBestMatch(station, osmObjects) {
  const stationText = textForMatch(station.name, station.brand, station.address);
  const brandText = clean(station.brand).toLowerCase();
  const candidates = [];

  for (const object of osmObjects) {
    const distanceM = haversineMeters(station.coords.lat, station.coords.lng, object.lat, object.lng);
    if (distanceM > OSM_MATCH_RADIUS_M) continue;

    const objectText = textForMatch(object.tags.name, object.tags.brand, object.tags.operator, object.tags["addr:street"]);
    const brandBonus = brandText && objectText.includes(brandText) ? 80 : 0;
    const nameBonus = sharedTokens(stationText, objectText) * 12;
    const hoursBonus = object.tags.opening_hours ? 60 : 0;
    candidates.push({
      ...object,
      distanceM,
      score: distanceM - brandBonus - nameBonus - hoursBonus,
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || null;
}

function isOpenNow(schedule, date, timeZone) {
  const normalized = schedule.trim();
  if (!normalized || /unknown|нет данных/i.test(normalized)) return false;
  if (normalized === "24/7") return true;

  const local = localDateParts(date, timeZone);
  const previous = { ...local, dayIndex: (local.dayIndex + 6) % 7, minutes: local.minutes + 24 * 60 };
  const rules = normalized.split(";").map((item) => item.trim()).filter(Boolean);

  let matched = false;
  let open = false;
  for (const rule of rules) {
    const currentResult = evaluateRule(rule, local);
    const previousResult = evaluateRule(rule, previous);
    if (!currentResult.matched && !previousResult.matched) continue;
    matched = true;
    open = currentResult.open || previousResult.open;
  }

  return matched ? open : false;
}

function evaluateRule(rule, local) {
  const lowered = rule.toLowerCase();
  const dayPart = parseDayPart(rule);
  if (dayPart && !dayMatches(dayPart, local.dayIndex)) {
    return { matched: false, open: false };
  }

  if (/\boff\b|выходн|closed|закрыт/i.test(lowered)) {
    return { matched: true, open: false };
  }

  const ranges = [...rule.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)].map((match) => ({
    start: Number(match[1]) * 60 + Number(match[2]),
    end: Number(match[3]) * 60 + Number(match[4]),
  }));

  if (!ranges.length && /24\/7/.test(rule)) {
    return { matched: true, open: true };
  }

  if (!ranges.length) {
    return { matched: false, open: false };
  }

  for (const range of ranges) {
    const end = range.end <= range.start ? range.end + 24 * 60 : range.end;
    if (local.minutes >= range.start && local.minutes < end) {
      return { matched: true, open: true };
    }
  }

  return { matched: true, open: false };
}

function parseDayPart(rule) {
  const match = rule.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*[-,]\s*(Mo|Tu|We|Th|Fr|Sa|Su))*[A-Za-z,\-\s]*/);
  if (!match) return null;
  const text = match[0].trim();
  return /^(Mo|Tu|We|Th|Fr|Sa|Su)/.test(text) ? text : null;
}

function dayMatches(dayPart, dayIndex) {
  const days = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const allowed = new Set();
  for (const part of dayPart.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su)$/);
    if (range) {
      const start = days.indexOf(range[1]);
      const end = days.indexOf(range[2]);
      for (let index = start; ; index = (index + 1) % 7) {
        allowed.add(index);
        if (index === end) break;
      }
      continue;
    }

    const single = trimmed.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)$/);
    if (single) allowed.add(days.indexOf(single[1]));
  }
  return allowed.has(dayIndex);
}

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    dayIndex: dayMap[byType.weekday],
    minutes: Number(byType.hour) * 60 + Number(byType.minute),
  };
}

function sharedTokens(left, right) {
  const leftTokens = new Set(left.split(/\s+/).filter((item) => item.length >= 4));
  if (!leftTokens.size) return 0;
  return right.split(/\s+/).filter((token) => leftTokens.has(token)).length;
}

function textForMatch(...parts) {
  return parts.filter(Boolean).join(" ").toLowerCase().replace(/ё/g, "е");
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const p1 = toRadians(lat1);
  const p2 = toRadians(lat2);
  const dp = toRadians(lat2 - lat1);
  const dl = toRadians(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function parseBounds(value) {
  const [minLat, minLng, maxLat, maxLng] = value.split(",").map((item) => Number(item.trim()));
  if ([minLat, minLng, maxLat, maxLng].some((item) => !Number.isFinite(item))) {
    throw new Error("OSM_BOUNDS must be minLat,minLng,maxLat,maxLng");
  }
  return { minLat, minLng, maxLat, maxLng };
}

function boundsString(bounds) {
  return `${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng}`;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${label}: ${text.slice(0, 160)}`);
  }
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function numberValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function clean(value) {
  return String(value ?? "").trim();
}

function env(name, fallback) {
  return process.env[name] || fallback;
}
