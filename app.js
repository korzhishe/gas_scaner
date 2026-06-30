const KRASNODAR_CENTER = [45.0355, 38.9753];
const DEFAULT_CONFIG = {
  dataUrl: "data/stations.json",
  mapTiles: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
};

const state = {
  config: DEFAULT_CONFIG,
  stations: [],
  filtered: [],
  selectedId: null,
  trafficVisible: true,
  filters: {
    status: "all",
    fuel: "all",
    traffic: "all",
    query: "",
    sort: "traffic",
  },
};

let map;
let tileLayer;
let markerLayer;
let trafficLayer;
let didInitialFit = false;

const els = {
  openCount: document.querySelector("#openCount"),
  bestAi92: document.querySelector("#bestAi92"),
  trafficAvg: document.querySelector("#trafficAvg"),
  searchInput: document.querySelector("#searchInput"),
  trafficFilter: document.querySelector("#trafficFilter"),
  sortSelect: document.querySelector("#sortSelect"),
  stationList: document.querySelector("#stationList"),
  stationDetail: document.querySelector("#stationDetail"),
  resultCount: document.querySelector("#resultCount"),
  dataStamp: document.querySelector("#dataStamp"),
  sourceLabel: document.querySelector("#sourceLabel"),
  refreshButton: document.querySelector("#refreshButton"),
  fitButton: document.querySelector("#fitButton"),
  trafficToggle: document.querySelector("#trafficToggle"),
};

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindEvents();
  loadAll();
});

function initMap() {
  map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
  }).setView(KRASNODAR_CENTER, 12);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  trafficLayer = L.layerGroup().addTo(map);

  window.addEventListener("resize", () => refreshMapLayout({ fit: false }));
  requestAnimationFrame(() => refreshMapLayout({ fit: false }));
}

async function loadAll() {
  setLoading(true);

  try {
    state.config = await loadConfig();
    resetTiles();
    const payload = await fetchJson(withCacheBust(state.config.dataUrl));
    state.stations = normalizeStations(payload.stations || []);
    render(payload);
  } catch (error) {
    console.error(error);
    renderError("Не удалось загрузить данные АЗС");
  } finally {
    setLoading(false);
  }
}

async function loadConfig() {
  try {
    const config = await fetchJson(withCacheBust("data/config.json"));
    return mergeConfig(DEFAULT_CONFIG, config);
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function mergeConfig(base, incoming = {}) {
  return {
    ...base,
    ...incoming,
    mapTiles: {
      ...base.mapTiles,
      ...(incoming.mapTiles || {}),
    },
  };
}

function resetTiles() {
  if (tileLayer) {
    map.removeLayer(tileLayer);
  }

  tileLayer = L.tileLayer(state.config.mapTiles.url, {
    maxZoom: 19,
    attribution: state.config.mapTiles.attribution,
  }).addTo(map);
}

function normalizeStations(stations) {
  return stations
    .filter((station) => station?.coords?.lat && station?.coords?.lng)
    .map((station) => ({
      ...station,
      status: station.status || "unknown",
      fuels: Array.isArray(station.fuels) ? station.fuels : [],
      services: Array.isArray(station.services) ? station.services : [],
      traffic: {
        score: Number(station.traffic?.score ?? 0),
        label: station.traffic?.label || "Нет данных",
        delayMin: Number(station.traffic?.delayMin ?? 0),
      },
    }));
}

function bindEvents() {
  els.refreshButton.addEventListener("click", loadAll);
  els.fitButton.addEventListener("click", fitToStations);
  els.searchInput.addEventListener("input", (event) => {
    state.filters.query = event.target.value.trim().toLowerCase();
    render();
  });
  els.trafficFilter.addEventListener("change", (event) => {
    state.filters.traffic = event.target.value;
    render();
  });
  els.sortSelect.addEventListener("change", (event) => {
    state.filters.sort = event.target.value;
    render();
  });
  els.trafficToggle.addEventListener("click", () => {
    state.trafficVisible = !state.trafficVisible;
    els.trafficToggle.classList.toggle("is-pressed", state.trafficVisible);
    els.trafficToggle.setAttribute("aria-pressed", String(state.trafficVisible));
    renderMap();
  });

  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filters.status = button.dataset.status;
      setActive("[data-status]", button);
      render();
    });
  });

  document.querySelectorAll("[data-fuel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filters.fuel = button.dataset.fuel;
      setActive("[data-fuel]", button);
      render();
    });
  });
}

function setActive(selector, activeButton) {
  document.querySelectorAll(selector).forEach((button) => button.classList.remove("is-active"));
  activeButton.classList.add("is-active");
}

function render(payload) {
  state.filtered = applyFilters(state.stations);
  renderSummary();
  renderList();
  renderMap();
  renderDetail();
  refreshMapLayout({ fit: Boolean(payload && !didInitialFit) });

  if (payload && !didInitialFit) {
    didInitialFit = true;
  }

  if (payload) {
    els.dataStamp.textContent = formatDateTime(payload.generatedAt);
    els.sourceLabel.textContent = payload.sourceLabel || "Источник не указан";
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function applyFilters(stations) {
  const filtered = stations.filter((station) => {
    if (state.filters.status !== "all" && station.status !== state.filters.status) {
      return false;
    }

    if (state.filters.fuel !== "all") {
      const hasFuel = station.fuels.some((fuel) => fuel.type === state.filters.fuel && fuel.available);
      if (!hasFuel) return false;
    }

    if (!matchesTraffic(station.traffic.score, state.filters.traffic)) {
      return false;
    }

    if (state.filters.query) {
      const haystack = [station.name, station.brand, station.address, station.district]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(state.filters.query)) return false;
    }

    return true;
  });

  return filtered.sort((a, b) => {
    if (state.filters.sort === "price") {
      return minVisiblePrice(a) - minVisiblePrice(b);
    }

    if (state.filters.sort === "updated") {
      return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
    }

    return a.traffic.score - b.traffic.score;
  });
}

function matchesTraffic(score, range) {
  if (range === "all") return true;
  const [min, max] = range.split("-").map(Number);
  return score >= min && score <= max;
}

function minVisiblePrice(station) {
  const fuel = state.filters.fuel;
  const prices = station.fuels
    .filter((item) => item.available && item.price && (fuel === "all" || item.type === fuel))
    .map((item) => item.price);
  return prices.length ? Math.min(...prices) : Number.POSITIVE_INFINITY;
}

function renderSummary() {
  const openStations = state.stations.filter((station) => station.status === "open");
  const ai92 = openStations
    .flatMap((station) => station.fuels)
    .filter((fuel) => fuel.type === "АИ-92" && fuel.available && fuel.price)
    .map((fuel) => fuel.price);
  const avgTraffic =
    openStations.length === 0
      ? null
      : openStations.reduce((sum, station) => sum + station.traffic.score, 0) / openStations.length;

  els.openCount.textContent = String(openStations.length);
  els.bestAi92.textContent = ai92.length ? `${Math.min(...ai92).toFixed(2)} ₽` : "-";
  els.trafficAvg.textContent = avgTraffic === null ? "-" : `${avgTraffic.toFixed(1)}/10`;
  els.resultCount.textContent = `${state.filtered.length} ${pluralizeStation(state.filtered.length)}`;
}

function renderList() {
  if (!state.filtered.length) {
    els.stationList.innerHTML = '<div class="empty-state">По текущим фильтрам АЗС не найдены</div>';
    return;
  }

  els.stationList.innerHTML = state.filtered.map(renderStationCard).join("");
  els.stationList.querySelectorAll(".station-card").forEach((card) => {
    card.addEventListener("click", () => selectStation(card.dataset.id));
  });
}

function renderStationCard(station) {
  const selected = station.id === state.selectedId ? " is-selected" : "";
  return `
    <button class="station-card${selected}" type="button" data-id="${escapeHtml(station.id)}">
      <span class="station-head">
        <span>
          <strong class="station-title">${escapeHtml(station.name)}</strong>
          <span class="station-address">${escapeHtml(station.address)}</span>
        </span>
        ${renderStatus(station.status)}
      </span>
      <span class="fuel-row">${station.fuels.map(renderFuel).join("")}</span>
      <span class="station-foot">
        ${renderTraffic(station.traffic)}
        <span>${escapeHtml(formatDateTime(station.updatedAt))}</span>
      </span>
    </button>
  `;
}

function renderStatus(status) {
  const labels = {
    open: "Открыта",
    closed: "Закрыта",
    unknown: "Нет данных",
  };
  return `<span class="badge badge-${status}">${labels[status] || labels.unknown}</span>`;
}

function renderFuel(fuel) {
  const off = fuel.available ? "" : " is-off";
  const price = fuel.price ? `${Number(fuel.price).toFixed(2)} ₽` : "-";
  return `<span class="fuel-price${off}"><span>${escapeHtml(fuel.type)}</span><span>${price}</span></span>`;
}

function renderTraffic(traffic) {
  const level = trafficClass(traffic.score);
  return `
    <span class="traffic-pill ${level}">
      <i data-lucide="car-front" aria-hidden="true"></i>
      <span>${traffic.score}/10 · ${escapeHtml(traffic.label)}</span>
    </span>
  `;
}

function renderMap() {
  markerLayer.clearLayers();
  trafficLayer.clearLayers();

  state.filtered.forEach((station) => {
    if (state.trafficVisible) {
      L.circle([station.coords.lat, station.coords.lng], {
        radius: 520 + station.traffic.score * 55,
        color: trafficColor(station.traffic.score),
        fillColor: trafficColor(station.traffic.score),
        fillOpacity: 0.16,
        opacity: 0.42,
        weight: 2,
      }).addTo(trafficLayer);
    }

    const marker = L.marker([station.coords.lat, station.coords.lng], {
      icon: L.divIcon({
        className: "",
        html: `<span class="marker-dot ${station.status}">${markerLabel(station)}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      }),
      title: station.name,
    });

    marker.on("click", () => selectStation(station.id));
    markerLayer.addLayer(marker);
  });

  refreshMapLayout({ fit: false });
}

function refreshMapLayout({ fit = false } = {}) {
  if (!map) return;

  requestAnimationFrame(() => {
    map.invalidateSize({ animate: false, pan: false });

    if (fit) {
      fitToStations({ animate: false });
    }
  });
}

function renderDetail() {
  const station = state.stations.find((item) => item.id === state.selectedId);

  if (!station) {
    els.stationDetail.classList.remove("is-visible");
    els.stationDetail.innerHTML = "";
    return;
  }

  els.stationDetail.classList.add("is-visible");
  els.stationDetail.innerHTML = `
    <div class="detail-main">
      <div>
        <h2>${escapeHtml(station.name)}</h2>
        <p>${escapeHtml(station.address)}</p>
      </div>
      ${renderStatus(station.status)}
    </div>
    <div class="fuel-row">${station.fuels.map(renderFuel).join("")}</div>
    <div class="service-row">
      ${renderTraffic(station.traffic)}
      <span class="fuel-price">${escapeHtml(station.openUntil || "График не указан")}</span>
      ${station.services.map((service) => `<span class="fuel-price">${escapeHtml(service)}</span>`).join("")}
    </div>
  `;

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function selectStation(id) {
  state.selectedId = id;
  const station = state.stations.find((item) => item.id === id);

  if (station) {
    map.flyTo([station.coords.lat, station.coords.lng], Math.max(map.getZoom(), 14), {
      duration: 0.45,
    });
  }

  renderList();
  renderDetail();
}

function fitToStations(options = {}) {
  const stations = state.filtered.length ? state.filtered : state.stations;
  if (!stations.length) {
    map.setView(KRASNODAR_CENTER, 12);
    return;
  }

  const bounds = L.latLngBounds(stations.map((station) => [station.coords.lat, station.coords.lng]));
  map.fitBounds(bounds.pad(0.18), { maxZoom: 13, animate: options.animate ?? true });
}

function markerLabel(station) {
  const available = station.fuels.filter((fuel) => fuel.available).length;
  return available || "!";
}

function trafficColor(score) {
  if (score <= 2) return "#177c55";
  if (score <= 5) return "#d28b00";
  return "#b9383a";
}

function trafficClass(score) {
  if (score <= 2) return "traffic-low";
  if (score <= 5) return "traffic-mid";
  return "traffic-high";
}

function setLoading(isLoading) {
  els.refreshButton.disabled = isLoading;
  els.refreshButton.style.opacity = isLoading ? "0.55" : "";
}

function renderError(message) {
  els.stationList.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  els.resultCount.textContent = "0 АЗС";
  els.dataStamp.textContent = "-";
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function pluralizeStation(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "АЗС";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "АЗС";
  return "АЗС";
}

function withCacheBust(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}t=${Date.now()}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
