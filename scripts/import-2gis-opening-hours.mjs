import { readFile, writeFile } from "node:fs/promises";

const COLLECTOR_URL = env("COLLECTOR_URL", "http://127.0.0.1:8090");
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";
const DGIS_API_KEY = process.env.DGIS_API_KEY || "";
const DGIS_BASE_URL = env("DGIS_BASE_URL", "https://catalog.api.2gis.com/3.0");
const DGIS_RUBRIC_ID = env("DGIS_RUBRIC_ID", "18547");
const DGIS_MATCH_RADIUS_M = Number(env("DGIS_MATCH_RADIUS_M", "450"));
const DGIS_MATCH_FILE = env("DGIS_MATCH_FILE", "data/2gis-matches.json");
const DGIS_TIME_ZONE = env("DGIS_TIME_ZONE", "Europe/Moscow");
const DRY_RUN = process.argv.includes("--dry-run");
const REFRESH_MATCHES = process.argv.includes("--refresh-matches");

const DGIS_FIELDS = [
  "items.point",
  "items.address_name",
  "items.full_address_name",
  "items.schedule",
  "items.schedule_special",
  "items.flags",
  "items.name_ex",
  "items.org",
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

  const stationsPayload = await collectorGet("/api/stations");
  const stations = stationsPayload.stations || [];
  const matchFile = await loadMatchFile();
  const matches = { ...(matchFile.matches || {}) };
  const missingStations = stations.filter((station) => REFRESH_MATCHES || !matches[station.id]);

  let searched = 0;
  for (const station of missingStations) {
    const match = await findDgisMatch(station);
    searched += 1;
    if (!match) continue;
    matches[station.id] = match;
    await sleep(120);
  }

  const matchedIds = unique(Object.values(matches).map((match) => match.id).filter(Boolean));
  const dgisItems = matchedIds.length ? await loadDgisItemsById(matchedIds) : [];
  const itemsById = new Map(dgisItems.map((item) => [String(item.id), item]));
  const reports = [];

  for (const station of stations) {
    const match = matches[station.id];
    if (!match?.id) continue;
    const item = itemsById.get(String(match.id));
    if (!item?.schedule) continue;

    const scheduleText = formatDgisSchedule(item.schedule);
    if (!scheduleText) continue;

    reports.push({
      stationId: station.id,
      status: isOpenNow(item.schedule, item.schedule_special, new Date(), DGIS_TIME_ZONE) ? "open" : "closed",
      openUntil: scheduleText,
      source: "2gis-opening-hours",
      updatedAt: new Date().toISOString(),
      dgis: {
        id: item.id,
        name: item.name || "",
        address: item.full_address_name || item.address_name || "",
        distanceM: Math.round(match.distanceM),
      },
    });
  }

  const nextMatchFile = {
    generatedAt: new Date().toISOString(),
    source: "2gis",
    matchRadiusM: DGIS_MATCH_RADIUS_M,
    matches,
  };

  if (DRY_RUN) {
    console.log(`Collector stations: ${stations.length}`);
    console.log(`2GIS searches: ${searched}`);
    console.log(`2GIS matches: ${Object.keys(matches).length}`);
    console.log(`2GIS byid items: ${dgisItems.length}`);
    console.log(`Reports: ${reports.length}`);
    console.log(JSON.stringify(reports.slice(0, 12), null, 2));
    return;
  }

  if (searched || REFRESH_MATCHES || !matchFile.generatedAt) {
    await writeFile(DGIS_MATCH_FILE, `${JSON.stringify(nextMatchFile, null, 2)}\n`, "utf8");
  }

  let imported = 0;
  for (const report of reports) {
    await postReport(report);
    imported += 1;
  }

  console.log(`Imported ${imported} 2GIS opening_hours reports into collector`);
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

async function findDgisMatch(station) {
  const lat = numberValue(station.coords?.lat);
  const lng = numberValue(station.coords?.lng);
  if (lat === null || lng === null) return null;

  const params = new URLSearchParams({
    key: DGIS_API_KEY,
    rubric_id: DGIS_RUBRIC_ID,
    type: "branch",
    point: `${lng},${lat}`,
    radius: String(DGIS_MATCH_RADIUS_M),
    page_size: "10",
    page: "1",
    fields: DGIS_FIELDS,
  });
  const payload = await dgisGet(`/items?${params}`);
  const candidates = (payload.result?.items || [])
    .map((item) => scoreDgisCandidate(station, item))
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  const best = candidates[0];
  if (!best || best.distanceM > DGIS_MATCH_RADIUS_M) return null;

  return {
    id: String(best.id),
    name: best.name || "",
    address: best.full_address_name || best.address_name || "",
    lat: best.point.lat,
    lng: best.point.lon,
    distanceM: Math.round(best.distanceM),
    score: Math.round(best.score),
  };
}

function scoreDgisCandidate(station, item) {
  const lat = numberValue(item.point?.lat);
  const lng = numberValue(item.point?.lon);
  if (lat === null || lng === null) return null;

  const stationText = textForMatch(station.name, station.brand, station.address);
  const itemText = textForMatch(
    item.name,
    item.name_ex?.primary,
    item.name_ex?.extension,
    item.org?.name,
    item.full_address_name,
    item.address_name,
  );
  const brandText = clean(station.brand).toLowerCase();
  const distanceM = haversineMeters(station.coords.lat, station.coords.lng, lat, lng);
  const brandBonus = brandText && itemText.includes(brandText) ? 120 : 0;
  const nameBonus = sharedTokens(stationText, itemText) * 14;
  const scheduleBonus = item.schedule ? 40 : 0;

  return {
    ...item,
    point: { lat, lon: lng },
    distanceM,
    score: distanceM - brandBonus - nameBonus - scheduleBonus,
  };
}

async function loadDgisItemsById(ids) {
  const items = [];
  for (const chunk of chunks(ids, 40)) {
    const params = new URLSearchParams({
      key: DGIS_API_KEY,
      id: chunk.join(","),
      fields: DGIS_FIELDS,
    });
    const payload = await dgisGet(`/items/byid?${params}`);
    items.push(...(payload.result?.items || []));
    await sleep(120);
  }
  return items;
}

async function dgisGet(path) {
  const response = await fetch(`${DGIS_BASE_URL.replace(/\/$/, "")}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "gas-scaner-2gis-opening-hours/1.0 (+https://github.com/korzhishe/gas_scaner)",
    },
  });
  const text = await response.text();
  const payload = parseJson(text, "2GIS");
  if (!response.ok || payload.meta?.code !== 200) {
    const message = payload.meta?.error?.message || payload.error || response.statusText;
    throw new Error(`2GIS returned ${response.status}/${payload.meta?.code || "unknown"}: ${message}`);
  }
  return payload;
}

async function loadMatchFile() {
  try {
    return JSON.parse(await readFile(DGIS_MATCH_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { matches: {} };
    throw error;
  }
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

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function unique(items) {
  return [...new Set(items)];
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function env(name, fallback) {
  return process.env[name] || fallback;
}
