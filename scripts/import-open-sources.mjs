const COLLECTOR_URL = env("COLLECTOR_URL", "http://127.0.0.1:8090");
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";
const RUSSIABASE_CITY_ID = env("RUSSIABASE_CITY_ID", "154778");
const RUSSIABASE_DELAY_MS = Number(env("RUSSIABASE_DELAY_MS", "800"));
const RUSSIABASE_BRANDS = parseBrands(
  env(
    "RUSSIABASE_BRANDS",
    "118:Газпромнефть,119:Лукойл,127:Роснефть,259:PNB,271:Teboil,783:RUSOIL,802:Irbis,836:КТК",
  ),
);
const DRY_RUN = process.argv.includes("--dry-run");

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const allStations = [];

  for (const brand of RUSSIABASE_BRANDS) {
    const stations = await loadRussiabaseBrand(brand).catch((error) => {
      console.warn(`RUSSIABASE ${brand.id} ${brand.name} skipped: ${error.message}`);
      return [];
    });
    allStations.push(...stations);
    await sleep(RUSSIABASE_DELAY_MS);
  }

  const uniqueStations = dedupeStations(allStations);

  if (DRY_RUN) {
    console.log(`Open-source stations: ${uniqueStations.length}`);
    console.log(JSON.stringify(uniqueStations.slice(0, 8), null, 2));
    return;
  }

  let imported = 0;
  for (const station of uniqueStations) {
    await postReport(station);
    imported += 1;
  }

  console.log(`Imported ${imported} open-source stations into collector`);
}

async function loadRussiabaseBrand(brand) {
  const url = `https://russiabase.ru/prices?brand=${encodeURIComponent(brand.id)}&city=${encodeURIComponent(RUSSIABASE_CITY_ID)}`;
  const html = await fetchText(url);
  const pageData = parseNextData(html, url);
  const pageProps = pageData.props?.pageProps || {};
  const listing = pageProps.listing?.listing || [];
  const listingMap = pageProps.listingMap?.listing || [];
  const brandName = pageProps.listing?.page?.brand_name || brand.name;
  const byId = new Map(listing.map((item) => [String(item.poiid), item]));

  return listingMap
    .map((mapItem) => normalizeRussiabaseStation(mapItem, byId.get(String(mapItem.poiid)) || {}, brandName))
    .filter(Boolean);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "gas-scaner-open-source-import/1.0 (+https://github.com/korzhishe/gas_scaner)",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function parseNextData(html, url) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find __NEXT_DATA__ in ${url}`);
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Invalid __NEXT_DATA__ JSON in ${url}: ${error.message}`);
  }
}

function normalizeRussiabaseStation(mapItem, detailItem, brandName) {
  const lat = numberValue(mapItem.Y);
  const lng = numberValue(mapItem.X);
  const poiid = clean(mapItem.poiid || detailItem.poiid);
  const address = clean(mapItem.address || detailItem.address);
  const name = clean(mapItem.name || detailItem.name || `${brandName} ${poiid}`);

  if (!poiid || !lat || !lng || !address) {
    return null;
  }

  const fuels = extractRussiabaseFuels(mapItem.prices || detailItem.prices || mapItem);
  if (!fuels.length) {
    return null;
  }

  const updatedAt = parseRussiabaseDate(mapItem.prices_updated || mapItem.LastUpdate || detailItem.prices_updated || detailItem.LastUpdate);
  const services = [];
  const sourceServices = Array.isArray(detailItem.uslugi) ? detailItem.uslugi : [];
  for (const service of sourceServices) {
    if (service?.name) services.push(clean(service.name));
  }
  services.push("RUSSIABASE");

  return {
    stationId: `russiabase-${poiid}`,
    station: {
      id: `russiabase-${poiid}`,
      name,
      brand: brandName,
      district: clean(mapItem.city_name || detailItem.city_name || "Краснодар"),
      address,
      coords: { lat, lng },
      services: [...new Set(services.filter(Boolean))],
    },
    source: "russiabase",
    updatedAt,
    fuels,
  };
}

function extractRussiabaseFuels(prices) {
  const fields = [
    ["ai92", "АИ-92"],
    ["ai95", "АИ-95"],
    ["ai98", "АИ-98"],
    ["ai100", "АИ-100"],
    ["dt", "ДТ"],
    ["gas", "Газ"],
    ["propan", "Газ"],
  ];

  const fuels = [];
  const seen = new Set();
  for (const [field, type] of fields) {
    const raw = prices?.[field]?.value ?? prices?.[field];
    const price = numberValue(raw);
    if (price === null || seen.has(type)) continue;
    seen.add(type);
    fuels.push({ type, price, available: true });
  }
  return fuels;
}

async function postReport(station) {
  const response = await fetch(`${COLLECTOR_URL.replace(/\/$/, "")}/api/reports`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(COLLECTOR_TOKEN ? { authorization: `Bearer ${COLLECTOR_TOKEN}` } : {}),
    },
    body: JSON.stringify(station),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Collector rejected ${station.stationId}: ${payload.error || response.statusText}`);
  }
}

function dedupeStations(stations) {
  const byId = new Map();
  for (const station of stations) {
    byId.set(station.stationId, station);
  }
  return [...byId.values()];
}

function parseBrands(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [id, ...nameParts] = item.split(":");
      return { id: id.trim(), name: nameParts.join(":").trim() || id.trim() };
    });
}

function parseRussiabaseDate(value) {
  const text = clean(value);
  const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return new Date().toISOString();
  const [, day, month, year] = match;
  return new Date(`${year}-${month}-${day}T12:00:00+03:00`).toISOString();
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
