const ROUTE_FILE_FALLBACK = [
  "Aoi.gpx",
  "Daichi.gpx",
  "Hikaru.gpx",
  "Koike.gpx",
  "Takumi.gpx",
  "Tomoya.gpx",
  "Yurino.gpx",
];

const ROUTE_COLORS = [
  "#d9dde1",
  "#7f93a8",
  "#b9775d",
  "#89a06a",
  "#c3a35f",
  "#8f789d",
  "#6b9ea0",
];

const SPEEDS = [4, 8, 16, 32];
const playPause = document.getElementById("playPause");
const timeSlider = document.getElementById("timeSlider");
const timeDisplay = document.getElementById("timeDisplay");
const routeToolbar = document.getElementById("routeToolbar");
const speedBadges = document.getElementById("speedBadges");
const startTimeLabel = document.getElementById("startTimeLabel");
const endTimeLabel = document.getElementById("endTimeLabel");
const currentTimeLabel = document.getElementById("currentTimeLabel");
const photoModal = document.getElementById("photoModal");
const photoModalImage = document.getElementById("photoModalImage");
const photoModalCaption = document.getElementById("photoModalCaption");
const photoModalClose = document.getElementById("photoModalClose");

const state = {
  routes: [],
  routeMap: new Map(),
  visibleRoute: null,
  playing: true,
  speed: 16,
  currentTimeMs: 0,
  minTimeMs: Infinity,
  maxTimeMs: -Infinity,
  lastFrame: null,
  mapReady: false,
  initialized: false,
  photoMarkers: [],
};

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      esri: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution:
          'Tiles &copy; Esri, Maxar, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community',
      },
    },
    layers: [
      {
        id: "base-backdrop",
        type: "background",
        paint: {
          "background-color": "#0b1014",
        },
      },
      {
        id: "esri-satellite",
        type: "raster",
        source: "esri",
        paint: {
          "raster-opacity": 0.88,
        },
      },
    ],
  },
  center: [139.97, 35.8627],
  zoom: 16,
  pitch: 0,
  bearing: 0,
  attributionControl: true,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

map.on("load", () => {
  state.mapReady = true;
  maybeInitialize();
});

bindPhotoModal();

function decodePathEntry(entry) {
  try {
    return decodeURIComponent(entry);
  } catch {
    return entry;
  }
}

function normalizeEntryName(entry) {
  return entry.replace(/^\/+/, "").replace(/^gpx\//i, "").replace(/^photos\//i, "").replace(/\/+$/, "");
}

function baseName(entry) {
  return normalizeEntryName(entry).split("/").pop() || "";
}

async function listDirectoryEntries(directoryUrl) {
  const response = await fetch(directoryUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to list ${directoryUrl}`);
  }

  const text = await response.text();
  const document = new DOMParser().parseFromString(text, "text/html");
  return [...document.querySelectorAll("a[href]")]
    .map((anchor) => anchor.getAttribute("href") || "")
    .map(decodePathEntry)
    .filter((href) => href && href !== "../");
}

async function discoverRouteFiles() {
  try {
    const entries = await listDirectoryEntries("gpx/");
    return entries
      .map(normalizeEntryName)
      .filter((entry) => /\.gpx$/i.test(entry))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn("Falling back to static route list:", error);
    return [...ROUTE_FILE_FALLBACK];
  }
}

async function discoverPhotoFiles(routeName) {
  try {
    const rootEntries = await listDirectoryEntries("photos/");
    const hasFolder = rootEntries.some((entry) => normalizeEntryName(entry) === routeName);
    if (!hasFolder) {
      return [];
    }

    const entries = await listDirectoryEntries(`photos/${routeName}/`);
    return entries
      .map(baseName)
      .filter((entry) => /\.(jpe?g|png|webp)$/i.test(entry))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn(`No photo folder for ${routeName}:`, error);
    return [];
  }
}

function parsePhotoTimeFromFilename(fileName) {
  const match = fileName.match(/PXL_(\d{8})_(\d{9})/i);
  if (!match) {
    return null;
  }

  const [, datePart, timePart] = match;
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6)) - 1;
  const day = Number(datePart.slice(6, 8));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  const second = Number(timePart.slice(4, 6));
  const millisecond = Number(timePart.slice(6, 9));
  return Date.UTC(year, month, day, hour, minute, second, millisecond);
}

function formatPhotoCaption(photo) {
  return `${photo.route.name} · ${photo.displayTime} · ${photo.fileName}`;
}

function openPhotoModal(photo) {
  photoModalImage.src = photo.url;
  photoModalImage.alt = photo.fileName;
  photoModalCaption.textContent = formatPhotoCaption(photo);
  photoModal.hidden = false;
}

function closePhotoModal() {
  photoModal.hidden = true;
  photoModalImage.src = "";
  photoModalImage.alt = "";
  photoModalCaption.textContent = "";
}

function bindPhotoModal() {
  photoModalClose.addEventListener("click", closePhotoModal);
  photoModal.addEventListener("click", (event) => {
    if (event.target?.dataset?.closeModal === "true") {
      closePhotoModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !photoModal.hidden) {
      closePhotoModal();
    }
  });
}

function parseGpx(text, fallbackName, color) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  const metadataName = xml.querySelector("metadata > name")?.textContent?.trim();
  const name = fallbackName.replace(/\.gpx$/i, "");
  const points = [...xml.querySelectorAll("trkpt")].map((trkpt) => {
    const lat = Number(trkpt.getAttribute("lat"));
    const lon = Number(trkpt.getAttribute("lon"));
    const timeText = trkpt.querySelector("time")?.textContent?.trim();
    const timeMs = timeText ? Date.parse(timeText) : NaN;
    return { lat, lon, timeMs };
  }).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon) && Number.isFinite(point.timeMs));

  if (!points.length) {
    throw new Error(`No track points found in ${fallbackName}`);
  }

  const coords = points.map((point) => [point.lon, point.lat]);
  const times = points.map((point) => point.timeMs);
  const bounds = coords.reduce((acc, coord) => {
    acc.extend(coord);
    return acc;
  }, new maplibregl.LngLatBounds(coords[0], coords[0]));

  return {
    id: fallbackName,
    name,
    metadataName,
    shortName: makeShortLabel(name),
    color,
    coords,
    times,
    bounds,
    startMs: times[0],
    endMs: times[times.length - 1],
    sourceId: `route-${fallbackName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`,
  };
}

function makeShortLabel(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "RT";
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function interpolatePosition(route, timeMs) {
  const { times, coords } = route;
  if (timeMs <= times[0]) return coords[0];
  if (timeMs >= times[times.length - 1]) return coords[coords.length - 1];

  let low = 0;
  let high = times.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (times[mid] === timeMs) return coords[mid];
    if (times[mid] < timeMs) low = mid + 1;
    else high = mid - 1;
  }

  const nextIndex = Math.min(low, times.length - 1);
  const prevIndex = Math.max(nextIndex - 1, 0);
  const span = times[nextIndex] - times[prevIndex] || 1;
  const ratio = Math.max(0, Math.min(1, (timeMs - times[prevIndex]) / span));
  return [
    lerp(coords[prevIndex][0], coords[nextIndex][0], ratio),
    lerp(coords[prevIndex][1], coords[nextIndex][1], ratio),
  ];
}

function routeFeature(route, timeMs, visible) {
  if (!visible || timeMs < route.startMs) {
    return null;
  }

  const coords = [];
  for (let i = 0; i < route.coords.length; i += 1) {
    if (route.times[i] <= timeMs) {
      coords.push(route.coords[i]);
      continue;
    }

    if (i === 0) {
      coords.push(route.coords[0]);
    } else {
      coords.push(interpolatePosition(route, timeMs));
    }
    break;
  }

  if (timeMs >= route.endMs) {
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: route.coords },
      properties: { color: route.color },
    };
  }

  if (coords.length < 2) {
    return null;
  }

  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: { color: route.color },
  };
}

function headFeature(route, timeMs, visible) {
  if (!visible || timeMs < route.startMs || timeMs > route.endMs) {
    return null;
  }
  const position = interpolatePosition(route, timeMs);
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: position },
    properties: { color: route.color },
  };
}

function updateRouteLayers() {
  if (!state.mapReady) return;

  for (const route of state.routes) {
    const visible = !state.visibleRoute || state.visibleRoute === route.id;
    const routeFeatureCollection = {
      type: "FeatureCollection",
      features: [routeFeature(route, state.currentTimeMs, visible)].filter(Boolean),
    };
    const headFeatureCollection = {
      type: "FeatureCollection",
      features: [headFeature(route, state.currentTimeMs, visible)].filter(Boolean),
    };

    const routeSource = map.getSource(route.sourceId);
    const headSource = map.getSource(`${route.sourceId}-head`);

    if (routeSource) {
      routeSource.setData(routeFeatureCollection);
    }

    if (headSource) {
      headSource.setData(headFeatureCollection);
    }
  }

  updateTimeDisplay(state.currentTimeMs);
  updatePhotoMarkers();
}

function updateTimeDisplay(timeMs) {
  const date = new Date(timeMs);
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: undefined,
  });
  const timeText = formatter.format(date);
  timeDisplay.textContent = timeText;
  currentTimeLabel.textContent = formatHandleTime(timeMs);
  updateCurrentTimeLabelPosition();
  const ratio = (timeMs - state.minTimeMs) / (state.maxTimeMs - state.minTimeMs || 1);
  timeSlider.value = String(ratio * 100);
}

function formatLabelTime(timeMs) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timeMs));
}

function formatHandleTime(timeMs) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timeMs));
}

function updateToolbar() {
  routeToolbar.innerHTML = "";

  const showAllButton = document.createElement("button");
  showAllButton.className = "show-all-button";
  showAllButton.type = "button";
  showAllButton.title = "Show all routes";
  showAllButton.textContent = "◯";
  showAllButton.addEventListener("click", () => {
    state.visibleRoute = null;
    refreshToolbarState();
    updateRouteLayers();
  });
  routeToolbar.appendChild(showAllButton);

  for (const route of state.routes) {
    const chip = document.createElement("button");
    chip.className = "route-chip";
    chip.type = "button";
    chip.dataset.routeId = route.id;
    chip.setAttribute("aria-pressed", String(!state.visibleRoute || state.visibleRoute === route.id));

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = route.shortName;
    avatar.style.background = route.color;

    const label = document.createElement("span");
    label.className = "route-label";
    label.textContent = route.name;
    if (route.metadataName && route.metadataName !== route.name) {
      chip.title = `${route.name} (${route.metadataName})`;
    } else {
      chip.title = route.name;
    }

    chip.appendChild(avatar);
    chip.appendChild(label);

    chip.addEventListener("click", () => {
      state.visibleRoute = route.id;
      refreshToolbarState();
      updateRouteLayers();
    });

    routeToolbar.appendChild(chip);
  }
}

function updateCurrentTimeLabelPosition() {
  if (!currentTimeLabel) return;
  const ratio = (state.currentTimeMs - state.minTimeMs) / (state.maxTimeMs - state.minTimeMs || 1);
  currentTimeLabel.style.left = `${Math.max(0, Math.min(100, ratio * 100))}%`;
}

function createPhotoMarkerElement(photo) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "photo-marker";
  element.style.backgroundImage = `url("${photo.url}")`;
  element.setAttribute("aria-label", `Open photo ${photo.fileName}`);
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    openPhotoModal(photo);
  });
  return element;
}

async function buildRoutePhotos(route) {
  const photoFiles = await discoverPhotoFiles(route.name);
  const photos = [];

  for (const fileName of photoFiles) {
    const photoFileName = baseName(fileName);
    const timeMs = parsePhotoTimeFromFilename(photoFileName);
    if (!Number.isFinite(timeMs)) {
      continue;
    }

    if (timeMs < route.startMs || timeMs > route.endMs) {
      continue;
    }

    photos.push({
      routeId: route.id,
      route,
      fileName: photoFileName,
      timeMs,
      displayTime: formatHandleTime(timeMs),
      url: `photos/${route.name}/${photoFileName}`,
      coordinates: interpolatePosition(route, timeMs),
      marker: null,
      element: null,
    });
  }

  return photos;
}

async function attachPhotoMarkers() {
  for (const route of state.routes) {
    const photos = await buildRoutePhotos(route);
    for (const photo of photos) {
      photo.element = createPhotoMarkerElement(photo);
      photo.marker = new maplibregl.Marker({
        element: photo.element,
        anchor: "center",
      })
        .setLngLat(photo.coordinates)
        .addTo(map);
      photo.element.classList.remove("is-visible");
      state.photoMarkers.push(photo);
    }
  }
}

function updatePhotoMarkers() {
  for (const photo of state.photoMarkers) {
    const visibleRoute = !state.visibleRoute || state.visibleRoute === photo.routeId;
    const visibleTime = state.currentTimeMs >= photo.timeMs;
    photo.element.classList.toggle("is-visible", visibleRoute && visibleTime);
    if (photo.marker) {
      photo.marker.getElement().style.pointerEvents = visibleRoute && visibleTime ? "auto" : "none";
    }
  }
}

function refreshToolbarState() {
  const chips = routeToolbar.querySelectorAll(".route-chip");
  chips.forEach((chip) => {
    const routeId = chip.dataset.routeId;
    const isActive = state.visibleRoute === routeId;
    chip.setAttribute("aria-pressed", String(!state.visibleRoute || isActive));
    chip.classList.toggle("is-active", isActive);
  });
}

function updateSpeedBadges() {
  speedBadges.innerHTML = "";

  SPEEDS.forEach((speed) => {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "speed-badge";
    badge.textContent = `${speed}x`;
    badge.setAttribute("aria-pressed", String(state.speed === speed));
    badge.addEventListener("click", () => {
      state.speed = speed;
      updateSpeedBadges();
    });
    speedBadges.appendChild(badge);
  });
}

function fitAllRoutes() {
  if (!state.routes.length) {
    return;
  }

  const bounds = state.routes.reduce((acc, route) => {
    route.coords.forEach((coord) => acc.extend(coord));
    return acc;
  }, new maplibregl.LngLatBounds(state.routes[0].coords[0], state.routes[0].coords[0]));

  map.fitBounds(bounds, {
    padding: { top: 110, right: 70, bottom: 190, left: 70 },
    duration: 0,
  });
}

function createRouteLayers(route) {
  map.addSource(route.sourceId, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addSource(`${route.sourceId}-head`, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: `${route.sourceId}-line`,
    type: "line",
    source: route.sourceId,
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": "rgba(0,0,0,0.68)",
      "line-width": 7.5,
      "line-opacity": 0.95,
    },
  });

  map.addLayer({
    id: `${route.sourceId}-line-core`,
    type: "line",
    source: route.sourceId,
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": route.color,
      "line-width": 4.2,
      "line-opacity": 1,
    },
  });

  map.addLayer({
    id: `${route.sourceId}-head`,
    type: "circle",
    source: `${route.sourceId}-head`,
    paint: {
      "circle-radius": 9,
      "circle-color": "rgba(0,0,0,0.68)",
      "circle-stroke-color": "rgba(255,255,255,0.86)",
      "circle-stroke-width": 1.5,
    },
  });

  map.addLayer({
    id: `${route.sourceId}-head-core`,
    type: "circle",
    source: `${route.sourceId}-head`,
    paint: {
      "circle-radius": 5.5,
      "circle-color": route.color,
      "circle-stroke-color": "rgba(255,255,255,0.95)",
      "circle-stroke-width": 2.5,
    },
  });
}

function updatePlayback(timestamp) {
  if (state.lastFrame == null) {
    state.lastFrame = timestamp;
  }

  const delta = timestamp - state.lastFrame;
  state.lastFrame = timestamp;

  if (state.playing) {
    state.currentTimeMs += delta * state.speed;
    if (state.currentTimeMs >= state.maxTimeMs) {
      state.currentTimeMs = state.maxTimeMs;
      state.playing = false;
      playPause.textContent = "Play";
    }
  }

  updateRouteLayers();
  requestAnimationFrame(updatePlayback);
}

function bindControls() {
  playPause.addEventListener("click", () => {
    state.playing = !state.playing;
    playPause.textContent = state.playing ? "Pause" : "Play";
    state.lastFrame = null;
  });

  timeSlider.addEventListener("input", () => {
    const ratio = Number(timeSlider.value) / 100;
    state.currentTimeMs = state.minTimeMs + ratio * (state.maxTimeMs - state.minTimeMs);
    state.lastFrame = null;
    updateRouteLayers();
  });
}

async function maybeInitialize() {
  if (!state.mapReady || !state.routes.length || state.initialized) {
    return;
  }

  state.initialized = true;
  state.routes.forEach(createRouteLayers);
  fitAllRoutes();
  await attachPhotoMarkers();
  updateRouteLayers();
  bindControls();
  playPause.textContent = "Pause";
  requestAnimationFrame(updatePlayback);
}

async function loadRoutes() {
  const routeFiles = await discoverRouteFiles();
  const routes = await Promise.all(
    routeFiles.map(async (file, index) => {
      const response = await fetch(`gpx/${normalizeEntryName(file)}`);
      if (!response.ok) {
        throw new Error(`Failed to load ${file}`);
      }
      const text = await response.text();
      return parseGpx(text, normalizeEntryName(file), ROUTE_COLORS[index % ROUTE_COLORS.length]);
    })
  );

  state.routes = routes;
  state.routes.forEach((route) => {
    state.routeMap.set(route.id, route);
    state.minTimeMs = Math.min(state.minTimeMs, route.startMs);
    state.maxTimeMs = Math.max(state.maxTimeMs, route.endMs);
  });
  state.photoMarkers = [];

  state.currentTimeMs = state.minTimeMs;
  timeSlider.value = "0";
  startTimeLabel.textContent = formatLabelTime(state.minTimeMs);
  endTimeLabel.textContent = formatLabelTime(state.maxTimeMs);
  currentTimeLabel.textContent = formatHandleTime(state.currentTimeMs);
  updateCurrentTimeLabelPosition();

  updateToolbar();
  updateSpeedBadges();
  await maybeInitialize();
}

loadRoutes().catch((error) => {
  console.error(error);
  timeDisplay.textContent = "GPX load failed";
});
