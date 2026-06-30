import { writeFile } from "node:fs/promises";

const COLLECTOR_URL = env("COLLECTOR_URL", "http://127.0.0.1:8090");
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";
const DGIS_API_KEY = process.env.DGIS_API_KEY || "";
const DGIS_BASE_URL = env("DGIS_BASE_URL", "https://catalog.api.2gis.com/3.0");
const DGIS_RUBRIC_ID = env("DGIS_RUBRIC_ID", "18547");
const DGIS_CENTER = parsePoint(env("DGIS_CENTER", "45.0355,38.9753"));
const DGIS_RADIUS_M = Number(env("DGIS_RADIUS_M", "40000"));
const DGIS_GRID_STEP_M = Number(env("DGIS_GRID_STEP_M", "8000"));
const DGIS_CELL_RADIUS_M = Number(env("DGIS_CELL_RADIUS_M", "6200"));
const DGIS_PAGE_SIZE = Number(env("DGIS_PAGE_SIZE", "10"));
const DGIS_MAX_PAGES = Number(env("DGIS_MAX_PAGES", "5"));
const DGIS_DELAY_MS = Number(env("DGIS_DELAY_MS", "120"));
const DGIS_TIME_ZONE = env("DGIS_TIME_ZONE", "Europe/Moscow");
const PRICE_MATCH_RADIUS_M = Number(env("DGIS_PRICE_MATCH_RADIUS_M", "500"));
const DRY_RUN = process.argv.includes("--dry-run");
const PRUNE_OTHER_SOURCES = process.argv.includes("--prune-other-sources");
const SAVE_RAW = valueArg("--save-raw");

const DGIS_FIELDS = [
  "items.point",
  "items.address_name",
  "items.full_address_name",
  "items.full_name",
  "items.schedule",
  "items.schedule_special",
  "items.flags",
  "items.context",
  "items.name_ex",
  "items.org",
  "items.reviews",
  "items.rubrics",
].join(",");

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  if (!DGIS_API_KEY) {
    throw new Error("DGIS_API_KEY is empty. Add it to .collector.env before enabling sync.");
  }

  const collectorPayload = await collectorGet("/api/stations");
  const existingStations = collectorPayload.stations || [];
  const dgisItems = await loadDgisStations();
  const reports = dgisItems.map((item) => normalizeDgisReport(item, existingStations)).filter(Boolean);
  const deleteStationIds = existingStations
    .filter((station) => station.id?.startsWith("russiabase-") || station.id?.startsWith("krd-"))
    .map((station) => station.id);

  if (SAVE_RAW) {
    await writeFile(SAVE_RAW, `${JSON.stringify(dgisItems, null, 2)}\n`, "utf8");
  }

  if (DRY_RUN) {
    console.log(`Existing collector stations: ${existingStations.length}`);
    console.log(`2GIS stations found: ${dgisItems.length}`);
    console.log(`Reports: ${reports.length}`);
    console.log(`Would prune old stations: ${PRUNE_OTHER_SOURCES ? deleteStationIds.length : 0}`);
    console.log(JSON.stringify(reports.slice(0, 12), null, 2));
    return;
  }

  let imported = 0;
  for (const report of reports) {
    await postReport(report);
    imported += 1;
  }

  let pruned = 0;
  if (PRUNE_OTHER_SOURCES && deleteStationIds.length) {
    const result = await pruneStations(deleteStationIds);
    pruned = result.deleted || 0;
  }

  console.log(`Imported ${imported} 2GIS stations into collector; pruned ${pruned} old stations`);
}

async function loadDgisStations() {
  const points = gridPoints(DGIS_CENTER, DGIS_RADIUS_M, DGIS_GRID_STEP_M);
  const byId = new Map();
  const truncated = [];

  for (const point of points) {
    for (let page = 1; page <= DGIS_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        key: DGIS_API_KEY,
        rubric_id: DGIS_RUBRIC_ID,
        type: "branch",
        point: `${point.lng},${point.lat}`,
        radius: String(DGIS_CELL_RADIUS_M),
        page_size: String(DGIS_PAGE_SIZE),
        page: String(page),
        fields: DGIS_FIELDS,
      });
      const payload = await dgisGet(`/items?${params}`);
      const items = payload.result?.items || [];
      const total = Number(payload.result?.total || 0);
      if (total > DGIS_PAGE_SIZE * DGIS_MAX_PAGES) {
        truncated.push({ point, total });
      }

      for (const item of items) {
        const lat = numberValue(item.point?.lat);
        const lng = numberValue(item.point?.lon);
        if (lat === null || lng === null) continue;
        const distanceFromCenter = haversineMeters(DGIS_CENTER.lat, DGIS_CENTER.lng, lat, lng);
        if (distanceFromCenter > DGIS_RADIUS_M) continue;
        byId.set(String(item.id), item);
      }

      if (items.length < DGIS_PAGE_SIZE || page * DGIS_PAGE_SIZE >= total) break;
      await sleep(DGIS_DELAY_MS);
    }
    await sleep(DGIS_DELAY_MS);
  }

  if (truncated.length) {
    console.warn(`2GIS warning: ${truncated.length} grid cells hit page limit; increase grid density if stations are missing.`);
  }

  return [...byId.values()].sort((a, b) => clean(a.name).localeCompare(clean(b.name), "ru"));
}

function normalizeDgisReport(item, existingStations) {
  const lat = numberValue(item.point?.lat);
  const lng = numberValue(item.point?.lon);
  const id = clean(item.id);
  if (!id || lat === null || lng === null) return null;

  const station = {
    id: `2gis-${id}`,
    name: clean(item.name) || clean(item.name_ex?.primary) || `АЗС 2ГИС ${id}`,
    brand: clean(item.name_ex?.primary || item.org?.primary || item.org?.name || item.name),
    district: districtFromAddress(item.full_name || item.full_address_name || item.address_name),
    address: clean(item.full_name || item.full_address_name || item.address_name),
    coords: { lat, lng },
    services: extractServices(item),
  };

  const priceMatch = findNearbyPriceStation(station, existingStations);
  const fuels = mergeFuels(extractDgisFuels(item), priceMatch?.fuels || []);
  const scheduleText = formatDgisSchedule(item.schedule);

  return {
    stationId: station.id,
    station,
    status: item.schedule ? (isOpenNow(item.schedule, item.schedule_special, new Date(), DGIS_TIME_ZONE) ? "open" : "closed") : "unknown",
    openUntil: scheduleText || "нет данных",
    source: "2gis-primary",
    updatedAt: new Date().toISOString(),
    traffic: {
      score: 0,
      label: "Нет данных",
      delayMin: 0,
    },
    fuels,
    dgis: {
      id,
      reviews: item.reviews || null,
      priceSourceStationId: priceMatch?.id || "",
    },
  };
}

function extractDgisFuels(item) {
  const fuels = new Map();
  for (const factor of item.context?.stop_factors || []) {
    if (factor.type && factor.type !== "attribute") continue;
    const tag = clean(factor.tag);
    const name = clean(factor.name);
    const type = fuelTypeFromDgis(tag, name);
    if (!type) continue;
    if (!fuels.has(type)) fuels.set(type, { type, price: null, available: true });
  }
  return [...fuels.values()];
}

function fuelTypeFromDgis(tag, name) {
  const text = `${tag} ${name}`.toLowerCase();
  if (/unleaded_100|\b100\b/.test(text)) return "АИ-100";
  if (/unleaded_98|\b98\b/.test(text)) return "АИ-98";
  if (/unleaded_95|\b95/.test(text)) return "АИ-95";
  if (/unleaded_92|\b92/.test(text)) return "АИ-92";
  if (/diesel|eurodiesel|\bдт\b|дизель/.test(text)) return "ДТ";
  if (/gas|lpg|propane|метан|пропан|газ/.test(text)) return "Газ";
  return "";
}

function extractServices(item) {
  const services = ["2ГИС"];
  for (const factor of item.context?.stop_factors || []) {
    if (factor.type && factor.type !== "attribute") continue;
    if (fuelTypeFromDgis(factor.tag, factor.name)) continue;
    const name = clean(factor.name);
    if (name) services.push(name);
  }
  const reviewNote = reviewSummary(item.reviews);
  if (reviewNote) services.push(reviewNote);
  return unique(services).slice(0, 14);
}

function reviewSummary(reviews) {
  if (!reviews) return "";
  const rating = numberValue(reviews.general_rating ?? reviews.rating ?? reviews.org_rating);
  const count = numberValue(reviews.general_review_count ?? reviews.review_count ?? reviews.org_review_count);
  if (rating === null || count === null) return "";
  return `2ГИС ${rating.toFixed(1)} · ${Math.round(count)} отзывов`;
}

function mergeFuels(baseFuels, priceFuels) {
  const byType = new Map();
  for (const fuel of baseFuels) {
    byType.set(fuel.type, { ...fuel });
  }
  for (const fuel of priceFuels) {
    if (!fuel?.type || !fuel.available) continue;
    const existing = byType.get(fuel.type) || { type: fuel.type, price: null, available: true };
    byType.set(fuel.type, {
      ...existing,
      price: numberValue(fuel.price),
      available: true,
    });
  }
  return [...byType.values()].sort((a, b) => fuelOrder(a.type) - fuelOrder(b.type));
}

function fuelOrder(type) {
  return { "АИ-92": 1, "АИ-95": 2, "АИ-98": 3, "АИ-100": 4, "ДТ": 5, "Газ": 6 }[type] || 99;
}

function findNearbyPriceStation(station, existingStations) {
  const candidates = existingStations
    .filter((item) => item.fuels?.length && item.coords?.lat && item.coords?.lng)
    .map((item) => {
      const distanceM = haversineMeters(station.coords.lat, station.coords.lng, item.coords.lat, item.coords.lng);
      const stationText = textForMatch(station.name, station.brand, station.address);
      const itemText = textForMatch(item.name, item.brand, item.address);
      const brandText = clean(station.brand).toLowerCase();
      const brandBonus = brandText && itemText.includes(brandText) ? 140 : 0;
      const nameBonus = sharedTokens(stationText, itemText) * 12;
      return { ...item, distanceM, score: distanceM - brandBonus - nameBonus };
    })
    .filter((item) => item.distanceM <= PRICE_MATCH_RADIUS_M)
    .sort((a, b) => a.score - b.score);

  return candidates[0] || null;
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

async function pruneStations(deleteStationIds) {
  const response = await fetch(`${COLLECTOR_URL.replace(/\/$/, "")}/api/prune`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(COLLECTOR_TOKEN ? { authorization: `Bearer ${COLLECTOR_TOKEN}` } : {}),
    },
    body: JSON.stringify({ deleteStationIds, source: "2gis-primary" }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Collector prune returned ${response.status}: ${payload.error || response.statusText}`);
  }
  return payload;
}

async function dgisGet(path) {
  const response = await fetch(`${DGIS_BASE_URL.replace(/\/$/, "")}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "gas-scaner-2gis-primary/1.0 (+https://github.com/korzhishe/gas_scaner)",
    },
  });
  const text = await response.text();
  const payload = parseJson(text, "2GIS");
  if (response.ok && payload.meta?.code === 404 && /not found/i.test(payload.meta?.error?.message || "")) {
    return { ...payload, result: { items: [], total: 0 } };
  }
  if (!response.ok || payload.meta?.code !== 200) {
    const message = payload.meta?.error?.message || payload.error || response.statusText;
    throw new Error(`2GIS returned ${response.status}/${payload.meta?.code || "unknown"}: ${message}`);
  }
  return payload;
}

function formatDgisSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return "";
  if (schedule.is_24x7) return "24/7";

  const groups = [];
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    const ranges = rangesForDay(schedule, day);
    groups.push({ day, text: ranges.length ? ranges.map(formatRange).join(",") : "off" });
  }

  const merged = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (previous?.text === group.text) {
      previous.end = group.day;
    } else {
      merged.push({ start: group.day, end: group.day, text: group.text });
    }
  }

  return merged
    .map((group) => `${group.start === group.end ? group.start : `${group.start}-${group.end}`} ${group.text}`)
    .join("; ");
}

function rangesForDay(schedule, day) {
  const daySchedule = schedule[day] || {};
  const ranges = Array.isArray(daySchedule.working_hours) ? daySchedule.working_hours : [];
  return ranges
    .map((range) => ({
      from: clean(range.from),
      to: clean(range.to),
    }))
    .filter((range) => range.from && range.to);
}

function formatRange(range) {
  if (range.from === "00:00" && range.to === "24:00") return "00:00-24:00";
  return `${range.from}-${range.to}`;
}

function isOpenNow(schedule, scheduleSpecial, date, timeZone) {
  if (!schedule || typeof schedule !== "object") return false;

  const local = localDateParts(date, timeZone);
  const special = specialScheduleForDate(scheduleSpecial, local.isoDate);
  if (special) return isOpenByRanges(special.working_hours || [], local.minutes);

  if (schedule.is_24x7) return true;

  const currentRanges = rangesForDay(schedule, local.dayKey);
  if (isOpenByRanges(currentRanges, local.minutes)) return true;

  const previousDay = previousDayKey(local.dayKey);
  const previousRanges = rangesForDay(schedule, previousDay).filter((range) => minutesValue(range.to) <= minutesValue(range.from));
  return isOpenByRanges(previousRanges, local.minutes + 24 * 60);
}

function isOpenByRanges(ranges, minutes) {
  for (const range of ranges) {
    const start = minutesValue(range.from);
    let end = minutesValue(range.to);
    if (start === null || end === null) continue;
    if (end <= start) end += 24 * 60;
    if (minutes >= start && minutes < end) return true;
  }
  return false;
}

function specialScheduleForDate(scheduleSpecial, isoDate) {
  if (!scheduleSpecial) return null;
  if (Array.isArray(scheduleSpecial)) {
    return scheduleSpecial.find((item) => item.date === isoDate || item.from === isoDate);
  }
  if (typeof scheduleSpecial === "object") {
    return scheduleSpecial[isoDate] || null;
  }
  return null;
}

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap = { Mon: "Mon", Tue: "Tue", Wed: "Wed", Thu: "Thu", Fri: "Fri", Sat: "Sat", Sun: "Sun" };
  return {
    dayKey: weekdayMap[byType.weekday],
    isoDate: `${byType.year}-${byType.month}-${byType.day}`,
    minutes: Number(byType.hour) * 60 + Number(byType.minute),
  };
}

function previousDayKey(day) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const index = days.indexOf(day);
  return days[(index + 6) % 7];
}

function minutesValue(value) {
  const match = clean(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function gridPoints(center, radiusM, stepM) {
  const points = [];
  for (let northM = -radiusM; northM <= radiusM; northM += stepM) {
    for (let eastM = -radiusM; eastM <= radiusM; eastM += stepM) {
      const point = offsetPoint(center, northM, eastM);
      const distanceM = haversineMeters(center.lat, center.lng, point.lat, point.lng);
      if (distanceM <= radiusM + DGIS_CELL_RADIUS_M) points.push(point);
    }
  }
  points.sort((a, b) => haversineMeters(center.lat, center.lng, a.lat, a.lng) - haversineMeters(center.lat, center.lng, b.lat, b.lng));
  return points;
}

function offsetPoint(center, northM, eastM) {
  const lat = center.lat + northM / 111320;
  const lng = center.lng + eastM / (111320 * Math.cos(toRadians(center.lat)));
  return { lat, lng };
}

function districtFromAddress(address) {
  const firstPart = clean(address).split(",")[0]?.trim();
  return firstPart || "Краснодар + 40 км";
}

function parsePoint(value) {
  const [lat, lng] = value.split(",").map((item) => Number(item.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("DGIS_CENTER must be lat,lng");
  }
  return { lat, lng };
}

function sharedTokens(left, right) {
  const leftTokens = new Set(left.split(/\s+/).filter((item) => item.length >= 4));
  if (!leftTokens.size) return 0;
  return right.split(/\s+/).filter((token) => leftTokens.has(token)).length;
}

function textForMatch(...parts) {
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/["'«»]/g, "");
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

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function valueArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function clean(value) {
  return String(value ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function env(name, fallback) {
  return process.env[name] || fallback;
}
