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
  signals: [],
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
  globalSignals: document.querySelector("#globalSignals"),
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
    state.signals = normalizeSignals(payload.signals || []);
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
      signals: normalizeSignals(station.signals || []),
      traffic: {
        score: Number(station.traffic?.score ?? 0),
        label: station.traffic?.label || "Нет данных",
        delayMin: Number(station.traffic?.delayMin ?? 0),
        hasData: station.traffic?.label !== "Нет данных",
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

    if (state.filters.traffic !== "all" && !station.traffic.hasData) {
      return false;
    }

    if (!matchesTraffic(station.traffic.score, state.filters.traffic)) {
      return false;
    }

    if (state.filters.query) {
      const haystack = [station.name, station.brand, station.address, station.district, ...station.signals.map((signal) => signal.note)]
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

    if (a.traffic.hasData !== b.traffic.hasData) {
      return a.traffic.hasData ? -1 : 1;
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
  const activeStations = state.stations.filter((station) => station.status !== "closed");
  const ai92 = activeStations
    .flatMap((station) => station.fuels)
    .filter((fuel) => fuel.type === "АИ-92" && fuel.available && fuel.price)
    .map((fuel) => fuel.price);
  const trafficStations = activeStations.filter((station) => station.traffic.hasData);
  const avgTraffic =
    trafficStations.length === 0
      ? null
      : trafficStations.reduce((sum, station) => sum + station.traffic.score, 0) / trafficStations.length;

  els.openCount.textContent = `${openStations.length}/${state.stations.length}`;
  els.bestAi92.textContent = ai92.length ? `${Math.min(...ai92).toFixed(2)} ₽` : "-";
  els.trafficAvg.textContent = String(countFreshSignals());
  els.resultCount.textContent = `${state.filtered.length} ${pluralizeStation(state.filtered.length)}`;
}

function renderList() {
  if (!state.filtered.length) {
    els.stationList.innerHTML = '<div class="empty-state">По текущим фильтрам АЗС не найдены</div>';
    return;
  }

  els.stationList.innerHTML = state.filtered.map(renderStationCard).join("");
  renderGlobalSignals();
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
      <span class="schedule-row">${renderSchedule(station.openUntil)}</span>
      ${renderSignals(station.signals)}
      <span class="station-foot">
        ${renderTraffic(station.traffic)}
        <span>${escapeHtml(formatDateTime(station.updatedAt))}</span>
      </span>
    </button>
  `;
}

function renderGlobalSignals() {
  const signals = [...state.signals]
    .filter(isSignalFresh)
    .sort((a, b) => signalPriority(a.category) - signalPriority(b.category) || Date.parse(b.observedAt || 0) - Date.parse(a.observedAt || 0))
    .slice(0, 4);

  els.globalSignals.innerHTML = signals.map(renderSignalCard).join("");
}

function renderStatus(status) {
  const labels = {
    open: "Открыта",
    closed: "Закрыта",
    unknown: "Статус неизвестен",
  };
  return `<span class="badge badge-${status}">${labels[status] || labels.unknown}</span>`;
}

function renderFuel(fuel) {
  const off = fuel.available ? "" : " is-off";
  const price = fuel.price ? `${Number(fuel.price).toFixed(2)} ₽` : "-";
  return `<span class="fuel-price${off}"><span>${escapeHtml(fuel.type)}</span><span>${price}</span></span>`;
}

function renderTraffic(traffic) {
  if (!traffic.hasData) {
    return `
      <span class="traffic-pill traffic-unknown">
        <i data-lucide="car-front" aria-hidden="true"></i>
        <span>Нет данных</span>
      </span>
    `;
  }

  const level = trafficClass(traffic.score);
  return `
    <span class="traffic-pill ${level}">
      <i data-lucide="car-front" aria-hidden="true"></i>
      <span>${traffic.score}/10 · ${escapeHtml(traffic.label)}</span>
    </span>
  `;
}

function renderSchedule(schedule) {
  const rawSchedule = String(schedule || "").trim();
  const label = formatSchedule(rawSchedule);
  const stateClass = label ? "schedule-pill" : "schedule-pill schedule-unknown";
  const title = rawSchedule && !/нет данных|unknown/i.test(rawSchedule) ? ` title="${escapeHtml(rawSchedule)}"` : "";
  return `
    <span class="${stateClass}"${title}>
      <i data-lucide="clock-3" aria-hidden="true"></i>
      <span>${escapeHtml(label || "График не указан")}</span>
    </span>
  `;
}

function renderSignals(signals = []) {
  const freshSignals = signals.filter(isSignalFresh).slice(0, 3);
  if (!freshSignals.length) return "";
  return `<span class="signal-row">${freshSignals.map(renderSignalPill).join("")}</span>`;
}

function renderSignalCard(signal) {
  const href = signal.sourceUrl ? ` href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer"` : "";
  return `
    <a class="signal-card signal-${escapeHtml(signal.category)}"${href}>
      <span>${escapeHtml(signalLabel(signal))}</span>
      <strong>${escapeHtml(signal.note || "сигнал требует проверки")}</strong>
      <small>${escapeHtml(formatDateTime(signal.observedAt))} · ${escapeHtml(signal.source || "источник")}</small>
    </a>
  `;
}

function renderSignalPill(signal) {
  const title = [signal.source, formatDateTime(signal.observedAt)].filter(Boolean).join(" · ");
  return `
    <span class="signal-pill signal-${escapeHtml(signal.category)}" title="${escapeHtml(title)}">
      <i data-lucide="${signalIcon(signal.category)}" aria-hidden="true"></i>
      <span>${escapeHtml(signalLabel(signal))}: ${escapeHtml(signal.note || "проверить")}</span>
    </span>
  `;
}

function signalLabel(signal) {
  const labels = {
    delivery_expected: "Привоз",
    fuel_available: "Есть топливо",
    no_fuel: "Нет топлива",
    closed_many: "Закрыто",
    queue: "Очередь",
    unknown: "Сигнал",
  };
  return labels[signal.category] || labels.unknown;
}

function signalIcon(category) {
  return {
    delivery_expected: "truck",
    fuel_available: "fuel",
    no_fuel: "circle-off",
    closed_many: "ban",
    queue: "users",
    unknown: "message-circle-warning",
  }[category] || "message-circle-warning";
}

function signalPriority(category) {
  return {
    fuel_available: 1,
    delivery_expected: 2,
    queue: 3,
    no_fuel: 4,
    closed_many: 5,
    unknown: 9,
  }[category] || 9;
}

function isSignalFresh(signal) {
  if (!signal?.observedAt) return false;
  const observed = Date.parse(signal.observedAt);
  const expires = Date.parse(signal.expiresAt || 0);
  if (Number.isNaN(observed)) return false;
  if (!Number.isNaN(expires) && expires < Date.now()) return false;
  return Date.now() - observed <= 48 * 60 * 60 * 1000;
}

function countFreshSignals() {
  return state.stations.reduce((sum, station) => sum + station.signals.filter(isSignalFresh).length, 0) + state.signals.filter(isSignalFresh).length;
}

function formatSchedule(schedule) {
  if (!schedule || /нет данных|unknown/i.test(schedule)) return "";
  if (schedule === "24/7") return "Круглосуточно";

  const dayLabels = {
    Mo: "Пн",
    Mon: "Пн",
    Tu: "Вт",
    Tue: "Вт",
    We: "Ср",
    Wed: "Ср",
    Th: "Чт",
    Thu: "Чт",
    Fr: "Пт",
    Fri: "Пт",
    Sa: "Сб",
    Sat: "Сб",
    Su: "Вс",
    Sun: "Вс",
    PH: "Праздники",
  };
  const formatted = schedule
    .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (day) => dayLabels[day] || day)
    .replace(/\boff\b/gi, "выходной")
    .replace(/\bclosed\b/gi, "закрыто")
    .replace(/00:00\s*-\s*24:00/g, "круглосуточно")
    .replace(/\s*;\s*/g, "; ");

  return formatted.length > 80 ? `${formatted.slice(0, 77)}...` : formatted;
}

function renderMap() {
  markerLayer.clearLayers();
  trafficLayer.clearLayers();

  state.filtered.forEach((station) => {
    if (state.trafficVisible && station.traffic.hasData) {
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
        html: `<span class="marker-dot ${station.status}${station.signals.some(isSignalFresh) ? " has-signal" : ""}">${markerLabel(station)}</span>`,
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
      ${renderSchedule(station.openUntil)}
      ${renderSignals(station.signals)}
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

function normalizeSignals(signals) {
  return Array.isArray(signals)
    ? signals.map((signal) => ({
        id: signal.id || "",
        stationId: signal.stationId || "",
        category: signal.category || "unknown",
        confidence: Number(signal.confidence ?? 0),
        queueLevel: signal.queueLevel || "",
        fuelTypes: Array.isArray(signal.fuelTypes) ? signal.fuelTypes : [],
        note: signal.note || "",
        source: signal.source || "",
        sourceUrl: signal.sourceUrl || "",
        observedAt: signal.observedAt || "",
        expiresAt: signal.expiresAt || "",
      }))
    : [];
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
