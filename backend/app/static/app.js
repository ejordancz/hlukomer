const $ = (id) => document.getElementById(id);

const SPECTRUM_FALLBACK = [
  "25 Hz",
  "31.5 Hz",
  "40 Hz",
  "50 Hz",
  "63 Hz",
  "80 Hz",
  "100 Hz",
  "125 Hz",
  "160 Hz",
  "200 Hz",
  "250 Hz",
  "500 Hz",
  "1 kHz",
  "2 kHz",
  "4 kHz",
  "8 kHz",
  "16 kHz",
];

const SPECTRUM_BAND_IDS = [
  "25",
  "31",
  "40",
  "50",
  "63",
  "80",
  "100",
  "125",
  "160",
  "200",
  "250",
  "500",
  "1k",
  "2k",
  "4k",
  "8k",
  "16k",
];

const LF_BANDS = new Set([
  "25",
  "31",
  "40",
  "50",
  "63",
  "80",
  "100",
  "125",
  "160",
  "200",
]);

const CHART_SPEC_HEIGHT = 288;
/** Spektrogram pod hlavním grafem jen pro rozsah ≤ 24 h. */
const CHART_SPEC_MAX_HOURS = 24;

const LS_WINDOW_CORR = "hlk.corr.window";
const LS_TONAL_CORR = "hlk.corr.tonal";

function readLsBool(key, defaultOn = true) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultOn;
    return v === "1";
  } catch (_) {
    return defaultOn;
  }
}

function writeLsBool(key, on) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch (_) {
    /* ignore */
  }
}

function readDisplayConfig() {
  const cfg = window.__DISPLAY_CONFIG || {};
  const windowDb = Number(cfg.window_correction_db);
  const tonalDb = Number(cfg.tonal_penalty_db);
  return {
    windowDb: Number.isFinite(windowDb) ? windowDb : 3,
    tonalDb: Number.isFinite(tonalDb) ? tonalDb : 5,
  };
}

const _displayCfg = readDisplayConfig();

const state = {
  threshold: 45,
  period: "day",
  chart: null,
  nightBands: [],
  liveSpectrum: null,
  weatherTimeline: [],
  chartRange: { t0: 0, t1: 1 },
  aircraftOverflights: [],
  aircraftShowUi: true,
  aircraftPopupId: null,
  historyReqId: 0,
  chartSpecReqId: 0,
  chartSpectrogram: null,
  hoverTs: null,
  /** Klíč aktivních bodů Chart.js tooltipu (méně update při mousemove). */
  chartTooltipKey: null,
  /** Čas sloupce spektrogramu u Y stupnice (méně překreslení). */
  specTooltipColTs: null,
  /** Hlavní graf: true = okno končí „teď“, start se posouvá s časem. */
  chartLive: true,
  /** Pevný začátek okna grafu (unix s), když chartLive=false. */
  chartStart: null,
  chartPanning: false,
  /** Display-only korekce (neovlivní API/DB). */
  display: {
    windowCorr: readLsBool(LS_WINDOW_CORR, true),
    tonalPenalty: readLsBool(LS_TONAL_CORR, false),
    windowDb: _displayCfg.windowDb,
    tonalDb: _displayCfg.tonalDb,
  },
  lastLatest: null,
  lastHistory: null,
};

const CHART_MAX_LOOKBACK_S = 90 * 24 * 3600;

/** Aktuální časový rozsah hlavního grafu podle selectu (+ live / pan). */
function selectedHistoryRange() {
  const hours = Number($("rangeSelect")?.value || 6);
  const span = hours * 3600;
  const now = Date.now() / 1000;
  if (state.chartLive || state.chartStart == null) {
    return { t0: now - span, t1: now, hours, start: null };
  }
  let t0 = state.chartStart;
  let t1 = t0 + span;
  if (t1 > now) {
    t1 = now;
    t0 = t1 - span;
  }
  const earliest = now - CHART_MAX_LOOKBACK_S;
  if (t0 < earliest) {
    t0 = earliest;
    t1 = Math.min(t0 + span, now);
  }
  return { t0, t1, hours, start: t0 };
}

function setChartLive(live) {
  state.chartLive = !!live;
  const btn = $("chartLiveBtn");
  if (btn) {
    btn.classList.toggle("is-active", state.chartLive);
    btn.setAttribute("aria-pressed", state.chartLive ? "true" : "false");
  }
  if (state.chartLive) state.chartStart = null;
}

/** Osa X hlavního grafu + markery / mini-spektrogram pod ním. */
function applyHistoryTimeRange(t0, t1, hours) {
  state.chartRange = { t0, t1 };
  const chart = state.chart;
  if (chart) {
    chart.options.scales.x.min = t0 * 1000;
    chart.options.scales.x.max = t1 * 1000;
    chart.options.scales.x.time.displayFormats = chartTimeFormats(hours);
    syncChartSpecVisibility(hours);
    chart.update("none");
  } else {
    syncChartSpecVisibility(hours);
  }
  drawChartSpectrogram();
  renderChartAxisLabels();
  renderAircraftTimeline();
  renderWeatherTimeline();
  requestAnimationFrame(() => {
    layoutChartUnderTimelines();
    layoutChartSpecStrip();
    if (state.hoverTs != null) showChartCrosshair(state.hoverTs);
  });
}

function chartSpecEnabled(hours = Number($("rangeSelect")?.value || 6)) {
  return Number(hours) <= CHART_SPEC_MAX_HOURS + 1e-9;
}

function syncChartSpecVisibility(hours) {
  const on = chartSpecEnabled(hours);
  const strip = $("chartSpecStrip");
  const labels = $("chartAxisLabels");
  const stack = $("chartStack");
  if (strip) strip.hidden = !on;
  if (labels) labels.hidden = !on;
  stack?.classList.toggle("has-spec", on);
  const chart = state.chart;
  if (chart?.options?.scales?.x?.ticks) {
    chart.options.scales.x.ticks.display = !on;
  }
  if (!on) {
    hideChartCrosshair();
    state.chartSpectrogram = null;
    const yEl = $("chartSpecYLabels");
    if (yEl) yEl.innerHTML = "";
  }
}


function fmtDb(v) {
  if (v == null || Number.isNaN(v)) return "—.—";
  return Number(v).toFixed(1);
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(0)} %`;
}

function windowOffset() {
  return state.display.windowCorr ? state.display.windowDb : 0;
}

function applyWindow(v) {
  if (v == null || Number.isNaN(Number(v))) return v;
  return Number(v) - windowOffset();
}

function setConnectionStatus(online, offlineText) {
  const dot = $("onlineDot");
  const label = $("onlineLabel");
  const status = $("status");
  if (dot) dot.className = `dot ${online ? "on" : "off"}`;
  if (label) {
    if (online) {
      label.textContent = "";
      label.hidden = true;
    } else {
      label.textContent = offlineText || "offline / bez dat";
      label.hidden = false;
    }
  }
  if (status) {
    const msg = online ? "Online" : label?.textContent || "Offline";
    status.title = msg;
    status.setAttribute("aria-label", msg);
  }
}

function effectiveLimit(rawLimit) {
  if (rawLimit == null || Number.isNaN(Number(rawLimit))) return rawLimit;
  if (state.display.tonalPenalty) {
    return Number(rawLimit) - state.display.tonalDb;
  }
  return Number(rawLimit);
}

function thresholdAtTime(limitPts, tSec) {
  if (!limitPts?.length) return state.threshold;
  let v = limitPts[0].v;
  for (const p of limitPts) {
    if (p.t <= tSec) v = p.v;
    else break;
  }
  return v;
}

/** Index bodu schodové řady platný v čase (poslední s x ≤ tMs). */
function steppedIndexAt(ds, tMs) {
  if (!ds?.length) return -1;
  let best = 0;
  for (let i = 0; i < ds.length; i++) {
    if (ds[i].x <= tMs) best = i;
    else break;
  }
  return best;
}

/** Y limitu z grafu v čase tMs (už po tonální korekci). */
function chartLimitYAt(tMs) {
  const ds = state.chart?.data?.datasets?.[1]?.data;
  if (!ds?.length) return effectiveLimit(state.threshold);
  const idx = steppedIndexAt(ds, tMs);
  return idx >= 0 ? ds[idx].y : effectiveLimit(state.threshold);
}

function syncDisplayToggleUi() {
  const sw = $("switchWindow");
  const st = $("switchTonal");
  if (sw) sw.setAttribute("aria-checked", state.display.windowCorr ? "true" : "false");
  if (st) st.setAttribute("aria-checked", state.display.tonalPenalty ? "true" : "false");

  const wDb = state.display.windowDb;
  const tDb = state.display.tonalDb;
  const windowTip =
    `Odečte od naměřených hodnot ${wDb} dB. Zvuk přímo u zdi je silnější kvůli odrazu od skla a fasády. ` +
    `Tímto získáte reálnou hladinu hluku ve volném prostoru 2 metry před oknem.`;
  const tonalTip =
    `Sníží hygienické limity o ${tDb} dB. Zapněte, pokud hluk obsahuje výrazný otravný tón ` +
    `(např. hučení na jedné frekvenci z větrání či čerpadla).`;
  const tipW = $("tipWindowCorr");
  const tipT = $("tipTonalCorr");
  const descW = $("descWindowCorr");
  const descT = $("descTonalCorr");
  if (tipW) tipW.textContent = windowTip;
  if (descW) descW.textContent = windowTip;
  if (tipT) tipT.textContent = tonalTip;
  if (descT) descT.textContent = tonalTip;
}

function setDisplayToggle(kind, on) {
  if (kind === "window") {
    state.display.windowCorr = !!on;
    writeLsBool(LS_WINDOW_CORR, state.display.windowCorr);
  } else if (kind === "tonal") {
    state.display.tonalPenalty = !!on;
    writeLsBool(LS_TONAL_CORR, state.display.tonalPenalty);
  }
  syncDisplayToggleUi();
  applyLatestDisplay();
  applyHistoryDisplay({ refetchSpec: false });
}

function applyLatestDisplay() {
  const data = state.lastLatest;
  if (!data) return;

  state.threshold = data.alert_threshold_dba ?? state.threshold;
  state.period = data.alert_period ?? state.period;

  const online = Boolean(data.online);
  setConnectionStatus(online);

  const live = data.metrics?.laeq_1s;
  const bands = data.spectrum?.bands || null;
  const lim = effectiveLimit(state.threshold);

  if (live) {
    const shown = applyWindow(live.value);
    const txt = fmtDb(shown);
    document.querySelectorAll(".js-live-level").forEach((el) => {
      el.textContent = txt;
      setLevelClass(el, shown, lim);
    });
    const age = Math.max(0, Math.round(Date.now() / 1000 - live.ts));
    setAllText(".js-live-meta", fmtAge(age));
    updateOverLimit(shown, lim);
  } else {
    updateOverLimit(null, lim);
  }

  state.liveSpectrum = data.spectrum || null;
  renderAnalysis(data.analysis || data.spectrum);
  renderSpectrumBars(bands);
}

function mapBandsWindow(bands) {
  if (!bands) return bands;
  const off = windowOffset();
  if (!off) return bands;
  return bands.map((b) => ({
    ...b,
    value: b.value == null || Number.isNaN(Number(b.value)) ? b.value : Number(b.value) - off,
  }));
}

function computeDisplayStats(points, limitPts) {
  if (!points?.length) {
    return { avg: null, min: null, max: null, above_threshold_pct: null };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let above = 0;
  let n = 0;
  for (const p of points) {
    if (p.v == null || Number.isNaN(Number(p.v))) continue;
    const level = applyWindow(p.v);
    const lim = effectiveLimit(thresholdAtTime(limitPts, p.t));
    sum += level;
    if (level < min) min = level;
    if (level > max) max = level;
    if (level > lim) above += 1;
    n += 1;
  }
  if (!n) return { avg: null, min: null, max: null, above_threshold_pct: null };
  return {
    avg: sum / n,
    min,
    max,
    above_threshold_pct: (100 * above) / n,
  };
}

function applyHistoryDisplay({ refetchSpec = true } = {}) {
  const data = state.lastHistory;
  if (!data || !state.chart) return;

  state.threshold = data.threshold_dba ?? state.threshold;
  state.period = data.alert_period ?? state.period;
  state.nightBands = data.night_bands || [];
  state.weatherTimeline = data.weather_timeline || [];
  state.aircraftOverflights = data.aircraft_overflights || [];
  setAircraftUiVisible(data.aircraft?.show_ui !== false);
  if (
    state.aircraftPopupId != null &&
    !state.aircraftOverflights.some((a) => a.id === state.aircraftPopupId)
  ) {
    closeAircraftPopup();
  }

  const rawPoints = data.points || [];
  const limitPts = data.threshold_points || [];

  state.chart.data.datasets[0].data = rawPoints.map((p) => ({
    x: p.t * 1000,
    y: applyWindow(p.v),
  }));

  state.chart.data.datasets[1].data = limitPts.map((p) => ({
    x: p.t * 1000,
    y: effectiveLimit(p.v),
  }));
  state.chartTooltipKey = null;

  const range = selectedHistoryRange();
  if (state.chartLive && data.start != null) {
    state.chartStart = null;
  } else if (!state.chartLive && data.start != null) {
    state.chartStart = data.start;
  }
  applyHistoryTimeRange(range.t0, range.t1, range.hours);

  const needRecompute = state.display.windowCorr || state.display.tonalPenalty;
  const s = needRecompute
    ? computeDisplayStats(rawPoints, limitPts)
    : data.stats || {};
  $("statAvg").textContent = s.avg != null ? `${fmtDb(s.avg)} dBA` : "—";
  $("statMin").textContent = s.min != null ? `${fmtDb(s.min)} dBA` : "—";
  $("statMax").textContent = s.max != null ? `${fmtDb(s.max)} dBA` : "—";
  $("statAbove").textContent = fmtPct(s.above_threshold_pct);

  syncDisplayToggleUi();
  if (refetchSpec) {
    refreshChartSpectrogram();
  } else {
    drawChartSpectrogram();
    renderChartAxisLabels();
    if (state.hoverTs != null) showChartCrosshair(state.hoverTs);
    state.chart.update("none");
  }
}

/** Jednotný český 24h formát času (bez AM/PM). */
const TIME_OPTS = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    ...TIME_OPTS,
    second: "2-digit",
  });
}

/** Osa grafu / spektrogramu: HH:mm, u delších rozsahů i den. */
function fmtAxisTime(ts, { withDate = false } = {}) {
  const d = new Date(ts * 1000);
  return d.toLocaleString("cs-CZ", {
    ...TIME_OPTS,
    ...(withDate ? { day: "2-digit", month: "2-digit" } : {}),
  });
}

/** Chart.js displayFormats — vždy 24h, české tečky u data. */
function chartTimeFormats(hours) {
  const withDate = Number(hours) >= 48;
  return {
    millisecond: "HH:mm:ss",
    second: "HH:mm:ss",
    minute: withDate ? "dd. MM. HH:mm" : "HH:mm",
    hour: withDate ? "dd. MM. HH:mm" : "HH:mm",
    day: "dd. MM.",
    week: "dd. MM.",
    month: "MM. yyyy",
    quarter: "QQQ yyyy",
    year: "yyyy",
  };
}

function setLevelClass(el, value, limit = null) {
  el.classList.remove("hot", "over");
  if (value == null) return;
  const lim = limit != null ? limit : state.threshold;
  if (value >= lim + 5) el.classList.add("over");
  else if (value >= lim) el.classList.add("hot");
}

function setAllText(selector, text) {
  document.querySelectorAll(selector).forEach((el) => {
    el.textContent = text;
  });
}

function fmtAge(ageSec) {
  if (ageSec < 5) return "právě teď";
  if (ageSec < 60) return `naposledy před ${ageSec} s`;
  if (ageSec < 3600) return `naposledy před ${Math.round(ageSec / 60)} min`;
  return `naposledy před ${Math.round(ageSec / 3600)} h`;
}

function updateOverLimit(laeq, limit = null) {
  const periodLabel = state.period === "night" ? "noc" : "den";
  const labels = document.querySelectorAll(".js-over-label");
  const values = document.querySelectorAll(".js-over-value");
  const subs = document.querySelectorAll(".js-over-sub");
  const lim = limit != null ? limit : effectiveLimit(state.threshold);

  if (laeq == null || lim == null) {
    labels.forEach((el) => {
      el.textContent = "Od limitu";
    });
    values.forEach((el) => {
      el.textContent = "—.—";
      el.classList.remove("over-limit", "under-limit");
    });
    subs.forEach((el) => {
      el.textContent = "dB vs limit";
    });
    return;
  }
  const delta = laeq - lim;
  const over = delta >= 0;
  const sign = over ? "+" : "−";
  const label = over ? "Nad limitem" : "Pod limitem";
  const value = `${sign}${Math.abs(delta).toFixed(1)}`;
  const tonalSuffix = state.display.tonalPenalty
    ? `, tón −${state.display.tonalDb}`
    : "";
  const sub = `dB ${over ? "nad" : "pod"} ${Number(lim).toFixed(0)} dBA (${periodLabel}${tonalSuffix})`;
  labels.forEach((el) => {
    el.textContent = label;
  });
  values.forEach((el) => {
    el.textContent = value;
    el.classList.toggle("over-limit", over);
    el.classList.toggle("under-limit", !over);
  });
  subs.forEach((el) => {
    el.textContent = sub;
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${url}`);
  }
  return res.json();
}

/** Viridis-ish: quiet → loud */
function dbToColor(t) {
  const stops = [
    [0.0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1.0, [253, 231, 37]],
  ];
  const x = Math.max(0, Math.min(1, t));
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (x >= stops[i][0] && x <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const u = (x - a[0]) / (b[0] - a[0] || 1);
  const r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * u);
  const g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * u);
  const bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * u);
  return `rgb(${r},${g},${bl})`;
}

/** Stínování den/noc v pozadí grafu (za datovými řadami). */
const dayNightBandsPlugin = {
  id: "dayNightBands",
  beforeDatasetsDraw(chart) {
    const bands = state.nightBands;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x;
    if (!chartArea || !x) return;

    const width = chartArea.right - chartArea.left;
    const height = chartArea.bottom - chartArea.top;

    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, width, height);
    ctx.clip();

    // Den — jemný zelený nádech přes celou plochu
    ctx.fillStyle = "rgba(126, 200, 163, 0.10)";
    ctx.fillRect(chartArea.left, chartArea.top, width, height);

    // Noc — výrazně tmavší pásy
    if (bands.length) {
      ctx.fillStyle = "rgba(2, 6, 14, 0.62)";
      for (const band of bands) {
        const x0 = x.getPixelForValue(band.t0 * 1000);
        const x1 = x.getPixelForValue(band.t1 * 1000);
        const left = Math.max(chartArea.left, Math.min(x0, x1));
        const right = Math.min(chartArea.right, Math.max(x0, x1));
        if (right - left < 0.5) continue;
        ctx.fillRect(left, chartArea.top, right - left, height);

        // tenká hrana na přechodu den↔noc
        ctx.strokeStyle = "rgba(196, 240, 130, 0.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left + 0.5, chartArea.top);
        ctx.lineTo(left + 0.5, chartArea.bottom);
        ctx.moveTo(right - 0.5, chartArea.top);
        ctx.lineTo(right - 0.5, chartArea.bottom);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
};


function aircraftLabel(item) {
  const cs = (item.callsign || "").trim();
  return cs || (item.icao24 || "—").toUpperCase();
}

function aircraftSubtitle(item) {
  const parts = [];
  const icao = (item.icao24 || "").trim();
  if (icao) parts.push(icao.toUpperCase());
  const country = (item.origin_country || "").trim();
  if (country) parts.push(country);
  return parts.join(" · ");
}

function aircraftRouteLabel(item) {
  const o = (item.origin_airport || "").trim().toUpperCase();
  const d = (item.destination_airport || "").trim().toUpperCase();
  if (o && d) return `${o} → ${d}`;
  if (o) return o;
  if (d) return d;
  return "";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function closeAircraftPopup() {
  const el = $("aircraftPopup");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
  state.aircraftPopupId = null;
  document.querySelectorAll(".aircraft-slot.is-active").forEach((n) => {
    n.classList.remove("is-active");
  });
}

function openAircraftPopup(item, anchorEl) {
  const el = $("aircraftPopup");
  const wrap = el?.closest(".chart-wrap") || el?.parentElement;
  if (!el || !wrap || !item) return;

  state.aircraftPopupId = item.id;
  document.querySelectorAll(".aircraft-slot.is-active").forEach((n) => {
    n.classList.remove("is-active");
  });
  if (anchorEl) anchorEl.classList.add("is-active");

  const sub = aircraftSubtitle(item);
  const typ = (item.aircraft_type || "").trim();
  const route = aircraftRouteLabel(item);
  const rows = [];
  if (typ) rows.push(`<dt>Typ</dt><dd>${escapeHtml(typ)}</dd>`);
  if (route) rows.push(`<dt>Letiště</dt><dd>${escapeHtml(route)}</dd>`);
  const gridHtml = rows.length
    ? `<dl class="aircraft-popup-grid">${rows.join("")}</dl>`
    : "";
  const subHtml = sub
    ? `<div class="aircraft-popup-sub">${escapeHtml(sub)}</div>`
    : "";

  el.innerHTML = `
    <div class="aircraft-popup-head">
      <div>
        <div class="aircraft-popup-title">${escapeHtml(aircraftLabel(item))}</div>
        ${subHtml}
      </div>
      <button type="button" class="aircraft-popup-close" id="aircraftPopupClose" aria-label="Zavřít">×</button>
    </div>
    ${gridHtml}
  `;
  el.hidden = false;

  const wrapRect = wrap.getBoundingClientRect();
  const approxW = 220;
  const approxH = rows.length ? 130 : 70;
  let left;
  let top;
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    left = r.left - wrapRect.left + r.width / 2 - approxW / 2;
    top = r.bottom - wrapRect.top + 8;
  } else {
    left = 8;
    top = 8;
  }
  left = Math.max(8, Math.min(left, wrapRect.width - approxW - 8));
  top = Math.max(8, Math.min(top, wrapRect.height - approxH - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  $("aircraftPopupClose")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeAircraftPopup();
  });
}

function initChart() {
  const ctx = $("chart").getContext("2d");
  state.chart = new Chart(ctx, {
    type: "line",
    plugins: [dayNightBandsPlugin],
    data: {
      datasets: [
        {
          label: "dBA",
          data: [],
          borderColor: "#7ec8a3",
          backgroundColor: "rgba(126, 200, 163, 0.12)",
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: "limit",
          data: [],
          borderColor: "#ff2d95",
          borderDash: [],
          pointRadius: 0,
          borderWidth: 2.5,
          fill: false,
          // "before": úsek mezi body drží y levého bodu (hodnota platí od daného času dál).
          // Společně s dvojicí bodů na hranici den/noc z API vznikne správný schod.
          stepped: "before",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 450 },
      // Tooltip řídíme sami (graf / spektrogram / letadlo) — bez native mouseout.
      events: [],
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "time",
          time: {
            tooltipFormat: "dd. MM. yyyy HH:mm:ss",
            displayFormats: chartTimeFormats(24),
          },
          grid: { color: "rgba(232,240,236,0.06)" },
          ticks: {
            color: "#a8bab2",
            maxRotation: 0,
            autoSkipPadding: 16,
            callback(value) {
              if (typeof value !== "number") return "";
              const hours = Number($("rangeSelect")?.value || 6);
              return fmtAxisTime(value / 1000, { withDate: hours >= 48 });
            },
          },
          afterFit(axis) {
            if (chartSpecEnabled()) axis.height = 2;
          },
        },
        y: {
          grace: "12%",
          grid: { color: "rgba(232,240,236,0.06)" },
          ticks: {
            color: "#a8bab2",
            callback: (v) => `${v}`,
          },
          title: { display: true, text: "dBA", color: "#a8bab2" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const ts = items[0]?.parsed?.x;
              if (ts == null) return "";
              return fmtTime(ts / 1000);
            },
            label: (ctx) => {
              if (ctx.dataset.label === "limit") {
                // Čas bereme z naměřeného bodu — sparse limit + index-mode jinak lže.
                const pts = ctx.chart.tooltip?.dataPoints || [];
                const measured = pts.find((i) => i.dataset.label !== "limit");
                const tMs = measured?.parsed?.x ?? ctx.parsed.x;
                const lim = chartLimitYAt(tMs);
                if (lim == null || Number.isNaN(Number(lim))) return null;
                const tonal = state.display.tonalPenalty ? " (tón)" : "";
                return `limit ${Number(lim).toFixed(1)} dBA${tonal}`;
              }
              if (ctx.parsed.y == null || Number.isNaN(ctx.parsed.y)) return null;
              return `${ctx.parsed.y.toFixed(1)} dBA`;
            },
            afterBody: (items) => {
              const measured = items.find((i) => i.dataset.label !== "limit");
              if (!measured || measured.parsed.y == null) return [];
              const lim = chartLimitYAt(measured.parsed.x);
              if (lim == null || Number.isNaN(Number(lim))) return [];
              const delta = measured.parsed.y - Number(lim);
              const sign = delta >= 0 ? "+" : "−";
              return [`${sign}${Math.abs(delta).toFixed(1)} dBA od limitu`];
            },
          },
        },
      },
    },
  });
}


function renderAnalysis(analysis) {
  if (!analysis) {
    setAllText(".js-m-total", "—.—");
    setAllText(".js-m-lfi", "—.—");
    setAllText(".js-m-dom", "—");
    setAllText(".js-m-total-unit", "dB · bez A-vážení");
    setAllText(".js-m-lfi-unit", "dB · 20–200 Hz");
    setAllText(".js-m-dom-unit", "oktávové pásmo");
    return;
  }
  setAllText(".js-m-total", fmtDb(applyWindow(analysis.leq_total_db)));
  setAllText(".js-m-lfi", fmtDb(applyWindow(analysis.lfi_db)));
  setAllText(".js-m-dom", analysis.dominant_label || "—");

  const ratio =
    analysis.lfi_ratio != null
      ? ` · ${Math.round(analysis.lfi_ratio * 100)} % energie`
      : "";
  const lfiSrc = analysis.lfi_source === "esp" ? " · ESP filtr" : "";
  const lfiUnit = `dB · 20–200 Hz${ratio}${lfiSrc}`;
  const leqSrc =
    analysis.leq_source === "esp" ? "dB · LZeq (ESP)" : "dB · součet pásem";
  const domDb = applyWindow(analysis.dominant_db);
  const domUnit =
    analysis.dominant_db != null
      ? `${fmtDb(domDb)} dB · střed ${analysis.dominant_hz} Hz`
      : "oktávové pásmo";

  setAllText(".js-m-total-unit", leqSrc);
  setAllText(".js-m-lfi-unit", lfiUnit);
  setAllText(".js-m-dom-unit", domUnit);
}

function spectrumStats(bands) {
  const values = (bands || [])
    .map((b) => Number(b.value))
    .filter((v) => !Number.isNaN(v));
  const vmin = values.length ? Math.min(...values) : 20;
  const vmax = values.length ? Math.max(...values) : 60;
  const span = Math.max(8, vmax - vmin);
  return { vmin, vmax, span };
}

function spectrumBarsHtml(bands) {
  if (!bands || !bands.length) {
    return SPECTRUM_FALLBACK.map(
      (label) =>
        `<div class="s-band empty"><span class="s-label">${label}</span>` +
        `<div class="s-track"><div class="s-fill" style="width:0%"></div></div>` +
        `<span class="s-val">—</span></div>`
    ).join("");
  }
  const { vmin, vmax, span } = spectrumStats(bands);
  return bands
    .map((b) => {
      const v = Number(b.value);
      const pct = Number.isNaN(v)
        ? 0
        : Math.max(4, Math.min(100, ((v - vmin) / span) * 100));
      const hot = !Number.isNaN(v) && v >= vmax - 1.5;
      const lf = LF_BANDS.has(String(b.band));
      return (
        `<div class="s-band${hot ? " hot" : ""}${lf ? " lf" : ""}">` +
        `<span class="s-label">${b.label}</span>` +
        `<div class="s-track"><div class="s-fill" style="width:${pct}%"></div></div>` +
        `<span class="s-val">${fmtDb(v)}</span></div>`
      );
    })
    .join("");
}

function renderSpectrumBars(bands) {
  const root = document.querySelector(".js-spectrum-rows");
  if (!root) return;
  if (!bands || !bands.length) {
    if (!root.dataset.empty) {
      root.dataset.empty = "1";
      root.innerHTML = spectrumBarsHtml(null);
    }
    return;
  }
  delete root.dataset.empty;
  root.innerHTML = spectrumBarsHtml(mapBandsWindow(bands));
}

async function refreshLatest() {
  try {
    const data = await fetchJson("/api/v1/latest");
    state.lastLatest = data;
    applyLatestDisplay();
  } catch (err) {
    setConnectionStatus(false, "API nedostupné");
    console.error(err);
  }
}

/** Hourly ping — keeps met.no cache warm; UI je jen weather timeline. */
async function refreshWeather() {
  try {
    await fetchJson("/api/v1/weather");
  } catch (err) {
    console.error(err);
  }
}

function weatherSlotTitle(s) {
  const parts = [fmtAxisTime(s.t, { withDate: true })];
  if (s.description) parts.push(s.description);
  if (s.temperature_c != null) parts.push(`${Number(s.temperature_c).toFixed(1)} °C`);
  if (s.wind_speed_ms != null) {
    let w = `${Number(s.wind_speed_ms).toFixed(1)} m/s`;
    if (s.wind_from_direction_cardinal) w += ` ${s.wind_from_direction_cardinal}`;
    parts.push(w);
  }
  if (s.precipitation_1h_mm != null && Number(s.precipitation_1h_mm) > 0) {
    parts.push(`${Number(s.precipitation_1h_mm).toFixed(1)} mm`);
  }
  const skew = (s.skew_factors || []).map((x) => x.label).filter(Boolean);
  if (skew.length) parts.push(skew.join("; "));
  return parts.join(" · ");
}

function layoutChartUnderTimelines() {
  const chart = state.chart;
  if (!chart?.chartArea) return;
  const { left, right } = chart.chartArea;
  // Dokud Chart.js nedopočítá layout, necháme předchozí zarovnání.
  if (!(right > left)) return;
  const padL = `${Math.max(0, left)}px`;
  const plotW = `${right - left}px`;
  for (const id of ["weatherTimeline", "aircraftTimeline", "chartContextGuides"]) {
    const el = $(id);
    if (!el) continue;
    // Šířka = chartArea (ne padding) — left% u absolute slotů musí sedět na plot.
    el.style.marginLeft = padL;
    el.style.width = plotW;
    el.style.paddingLeft = "0";
    el.style.paddingRight = "0";
  }
  renderChartContextGuides();
}

function renderChartContextGuides() {
  const el = $("chartContextGuides");
  const chart = state.chart;
  if (!el || !chart?.scales?.x || !chart.chartArea) return;
  const x = chart.scales.x;
  const { left, right } = chart.chartArea;
  const width = right - left;
  if (!(width > 0)) {
    el.innerHTML = "";
    return;
  }
  const parts = [];
  const seen = new Set();
  const pushPct = (pct) => {
    if (pct < -1 || pct > 101) return;
    const key = pct.toFixed(1);
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(`<span class="chart-context-guide" style="left:${pct.toFixed(2)}%"></span>`);
  };

  // Se spektrogramem: stejné pozice jako vlastní osa pod stripem.
  if (chartSpecEnabled() && !$("chartSpecStrip")?.hidden) {
    for (let i = 0; i < 6; i++) pushPct((i / 5) * 100);
  } else {
    for (const tick of x.ticks || []) {
      const ms = tick.value;
      if (!Number.isFinite(ms)) continue;
      const px = x.getPixelForValue(ms);
      pushPct(((px - left) / width) * 100);
    }
    if (!parts.length) {
      for (let i = 0; i < 6; i++) pushPct((i / 5) * 100);
    }
  }
  el.innerHTML = parts.join("");
}

function layoutWeatherTimeline() {
  layoutChartUnderTimelines();
}

function layoutChartSpecStrip() {
  const chart = state.chart;
  if (!chart?.chartArea) return;
  const { left, right } = chart.chartArea;
  if (!(right > left)) return;
  const padL = `${Math.max(0, left)}px`;
  const plotW = `${right - left}px`;

  const strip = $("chartSpecStrip");
  if (strip) {
    strip.style.marginLeft = "0";
    strip.style.width = "100%";
  }
  const yEl = $("chartSpecYLabels");
  if (yEl) yEl.style.width = padL;

  const labels = $("chartAxisLabels");
  if (labels) {
    labels.style.marginLeft = padL;
    labels.style.width = plotW;
  }
}

function hideChartTooltip() {
  const chart = state.chart;
  state.chartTooltipKey = null;
  if (!chart?.tooltip) return;
  chart.setActiveElements([]);
  chart.tooltip.setActiveElements([], { x: 0, y: 0 });
  chart.update("none");
}

/** Nejbližší body datasetů k času → stejný tooltip jako při hoveru grafu. */
function showChartTooltipAt(tsSec) {
  const chart = state.chart;
  if (!chart?.tooltip) return;
  const targetMs = tsSec * 1000;
  const active = [];
  let anchor = null;
  for (let di = 0; di < chart.data.datasets.length; di++) {
    const ds = chart.data.datasets[di].data;
    if (!ds?.length) continue;
    let best;
    // Limit je schodová řada: platí poslední bod s časem ≤ kurzoru (ne nejbližší).
    if (chart.data.datasets[di].label === "limit") {
      best = steppedIndexAt(ds, targetMs);
    } else {
      best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < ds.length; i++) {
        const d = Math.abs(ds[i].x - targetMs);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
    if (best < 0) continue;
    const meta = chart.getDatasetMeta(di);
    if (meta.hidden || !meta.data[best]) continue;
    active.push({ datasetIndex: di, index: best });
    if (di === 0) anchor = meta.data[best];
  }
  if (!active.length || !anchor) {
    hideChartTooltip();
    return;
  }
  const key = active.map((a) => `${a.datasetIndex}:${a.index}`).join("|");
  if (state.chartTooltipKey === key) return;
  state.chartTooltipKey = key;
  chart.setActiveElements(active);
  chart.tooltip.setActiveElements(active, { x: anchor.x, y: anchor.y });
  chart.update("none");
}

function hideChartCrosshair() {
  state.hoverTs = null;
  const el = $("chartCrosshair");
  if (el) el.hidden = true;
  hideChartTooltip();
  hideSpecTooltip();
}

function nearestSpecColumn(tsSec) {
  const cols = state.chartSpectrogram?.columns;
  if (!cols?.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of cols) {
    const d = Math.abs(c.t - tsSec);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (!best) return null;
  const { t0, t1 } = state.chartRange;
  const maxDist = Math.max(90, (t1 - t0) * 0.03);
  if (bestDist > maxDist) return null;
  return best;
}

function hideSpecTooltip() {
  state.specTooltipColTs = null;
  const bars = $("chartSpecBars");
  if (bars) {
    bars.hidden = true;
    bars.innerHTML = "";
  }
}

/** Spektrum u crosshairu — dB + linky vlevo přes spektrogram, vedle Y stupnice. */
function showSpecTooltip(tsSec, _lineLeft) {
  const barsEl = $("chartSpecBars");
  const strip = $("chartSpecStrip");
  if (!barsEl || !chartSpecEnabled() || strip?.hidden) {
    hideSpecTooltip();
    return;
  }
  const col = nearestSpecColumn(tsSec);
  if (!col?.v?.length) {
    hideSpecTooltip();
    return;
  }
  if (state.specTooltipColTs === col.t && !barsEl.hidden) return;
  state.specTooltipColTs = col.t;

  const labels = state.chartSpectrogram?.labels || SPECTRUM_FALLBACK;
  const off = windowOffset();
  const bands = col.v.map((v, i) => ({
    band: SPECTRUM_BAND_IDS[i] || "",
    label: labels[i] || SPECTRUM_FALLBACK[i] || "",
    value: v == null || Number.isNaN(Number(v)) ? v : Number(v) - off,
  }));
  const { vmin, vmax, span } = spectrumStats(bands);
  const topFirst = [...bands].reverse();

  barsEl.innerHTML = topFirst
    .map((b) => {
      const v = Number(b.value);
      const pct = Number.isNaN(v)
        ? 0
        : Math.max(6, Math.min(100, ((v - vmin) / span) * 100));
      const hot = !Number.isNaN(v) && v >= vmax - 1.5;
      const lf = LF_BANDS.has(String(b.band));
      const cls = `chart-spec-bar${hot ? " is-hot" : ""}${lf ? " is-lf" : ""}`;
      const txt = Number.isNaN(v) ? "—" : fmtDb(v);
      return (
        `<div class="${cls}" style="--p:${pct.toFixed(1)}%">` +
        `<span class="chart-spec-bar-val">${txt}</span>` +
        `<span class="chart-spec-bar-track"><span class="chart-spec-bar-fill"></span></span>` +
        `</div>`
      );
    })
    .join("");
  barsEl.hidden = false;
}

function timeFromChartClientX(clientX) {
  const chart = state.chart;
  const canvas = $("chart");
  if (!chart?.scales?.x || !chart.chartArea || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  if (x < chart.chartArea.left || x > chart.chartArea.right) return null;
  const ms = chart.scales.x.getValueForPixel(x);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function showChartCrosshair(tsSec) {
  const el = $("chartCrosshair");
  const wrap = document.querySelector(".chart-wrap");
  const chart = state.chart;
  const canvas = $("chart");
  if (!el || !wrap || !chart?.chartArea || !canvas) return;
  state.hoverTs = tsSec;
  const wrapRect = wrap.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const xPix = chart.scales.x.getPixelForValue(tsSec * 1000);
  const left = canvasRect.left - wrapRect.left + xPix;
  const top = canvasRect.top - wrapRect.top + chart.chartArea.top;
  let bottom = canvasRect.top - wrapRect.top + chart.chartArea.bottom;
  if (chartSpecEnabled() && !$("chartSpecStrip")?.hidden) {
    const labels = $("chartAxisLabels");
    const endEl = labels && !labels.hidden ? labels : $("chartSpecStrip");
    if (endEl) bottom = endEl.getBoundingClientRect().bottom - wrapRect.top;
  }
  const rail = $("chartContextRail");
  if (rail) {
    bottom = Math.max(bottom, rail.getBoundingClientRect().bottom - wrapRect.top);
  }
  el.hidden = false;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.height = `${Math.max(0, bottom - top)}px`;
  el.title = fmtTime(tsSec);
  showChartTooltipAt(tsSec);
  showSpecTooltip(tsSec, left);
}

function renderChartAxisLabels() {
  const el = $("chartAxisLabels");
  if (!el) return;
  if (!chartSpecEnabled()) {
    el.innerHTML = "";
    return;
  }
  layoutChartSpecStrip();
  const { t0, t1 } = state.chartRange;
  const hours = Number($("rangeSelect")?.value || 6);
  const span = Math.max(1e-6, t1 - t0);
  const n = 6;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + (span * i) / (n - 1);
    const pct = (i / (n - 1)) * 100;
    parts.push(
      `<span style="left:${pct.toFixed(2)}%">${fmtAxisTime(t, { withDate: hours >= 48 })}</span>`
    );
  }
  el.innerHTML = parts.join("");
}

function drawChartSpectrogram() {
  const canvas = $("chartSpectrogram");
  const strip = $("chartSpecStrip");
  const wrap = $("chartSpecCanvasWrap");
  const yEl = $("chartSpecYLabels");
  if (!canvas || !strip) return;
  if (!chartSpecEnabled() || strip.hidden) return;

  layoutChartSpecStrip();
  const host = wrap || strip;
  const w = Math.max(40, Math.floor(host.clientWidth || 0));
  const h = CHART_SPEC_HEIGHT;
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  const data = state.chartSpectrogram;
  const cols = data?.columns;
  if (!cols?.length) {
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#a8bab2";
    ctx.font = "12px Sora, sans-serif";
    ctx.fillText("Spektrum…", 10, Math.round(h / 2));
    if (yEl) yEl.innerHTML = "";
    return;
  }

  const { t0, t1 } = state.chartRange;
  const span = Math.max(1e-6, t1 - t0);
  const labels = data.labels || [];
  const nBands = labels.length || (cols[0].v?.length ?? 0);
  if (!nBands) return;

  if (yEl) {
    // high freq nahoře (stejně jako heatmapa)
    yEl.innerHTML = [...labels]
      .reverse()
      .map((lab) => `<span>${lab}</span>`)
      .join("");
  }

  const vmin = (data.vmin ?? 20) - windowOffset();
  const vmax = Math.max(vmin + 8, (data.vmax ?? 60) - windowOffset());
  const vSpan = vmax - vmin;
  const rowH = h / nBands;

  ctx.fillStyle = "#0a1010";
  ctx.fillRect(0, 0, w, h);

  // Šířka sloupce podle hustoty v okně (min 1 px).
  const inView = cols.filter((c) => c.t >= t0 - span * 0.02 && c.t <= t1 + span * 0.02);
  const colW = Math.max(1, w / Math.max(1, inView.length));
  const off = windowOffset();

  for (const col of inView) {
    const x = ((col.t - t0) / span) * w;
    if (x < -colW || x > w + colW) continue;
    const vals = col.v || [];
    for (let b = 0; b < nBands; b++) {
      const row = nBands - 1 - b;
      const raw = vals[b] ?? data.vmin ?? 20;
      const shown = Number(raw) - off;
      const t = (shown - vmin) / vSpan;
      ctx.fillStyle = dbToColor(t);
      ctx.fillRect(
        Math.floor(x - colW / 2),
        Math.floor(row * rowH),
        Math.ceil(colW) + 1,
        Math.ceil(rowH) + 1
      );
    }
  }

  const edges = data.limit_change_edges || [];
  if (edges.length) {
    ctx.strokeStyle = "#ff2d95";
    ctx.lineWidth = 2;
    for (const edgeT of edges) {
      if (edgeT <= t0 || edgeT >= t1) continue;
      const x = Math.round(((edgeT - t0) / span) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
}

async function refreshChartSpectrogram() {
  if (!chartSpecEnabled()) {
    state.chartSpectrogram = null;
    drawChartSpectrogram();
    syncDisplayToggleUi();
    if (state.hoverTs == null) hideSpecTooltip();
    return;
  }
  if (state.chartPanning) return;
  const { hours, start } = selectedHistoryRange();
  const reqId = ++state.chartSpecReqId;
  try {
    let url = `/api/v1/spectrum/history?hours=${encodeURIComponent(hours)}&max_columns=480`;
    if (start != null) url += `&start=${encodeURIComponent(start)}`;
    const data = await fetchJson(url);
    if (reqId !== state.chartSpecReqId) return;
    state.chartSpectrogram = data;
    state.specTooltipColTs = null;
    drawChartSpectrogram();
    renderChartAxisLabels();
    syncDisplayToggleUi();
    if (state.hoverTs != null) {
      showChartCrosshair(state.hoverTs);
    }
  } catch (err) {
    if (reqId === state.chartSpecReqId) console.error(err);
  }
}

function setAircraftUiVisible(visible) {
  state.aircraftShowUi = !!visible;
  const timeline = $("aircraftTimeline");
  const legend = $("legendAircraft");
  if (timeline) timeline.hidden = !state.aircraftShowUi;
  if (legend) legend.hidden = !state.aircraftShowUi;
  if (!state.aircraftShowUi) closeAircraftPopup();
  layoutChartUnderTimelines();
}

function renderAircraftTimeline() {
  const el = $("aircraftTimeline");
  if (!el) return;
  if (!state.aircraftShowUi) {
    el.hidden = true;
    el.innerHTML = "";
    layoutChartUnderTimelines();
    return;
  }
  el.hidden = false;
  const { t0, t1 } = state.chartRange;
  const span = Math.max(1e-6, t1 - t0);
  const items = state.aircraftOverflights || [];
  layoutChartUnderTimelines();

  el.classList.toggle("is-empty", !items.length);
  if (!items.length) {
    el.innerHTML = "";
    el.title = "Žádné přelety v tomto rozsahu";
    return;
  }
  el.title = "";

  // mírný horizontální rozestup při shodném čase
  const sorted = [...items].sort((a, b) => a.t - b.t);
  const offsets = new Map();
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && Math.abs(sorted[i].t - sorted[i - 1].t) < 90) run += 1;
    else run = 0;
    offsets.set(sorted[i].id, run);
  }

  el.innerHTML = sorted
    .map((item) => {
      const pct = ((item.t - t0) / span) * 100;
      if (pct < -2 || pct > 102) return "";
      const nudge = (offsets.get(item.id) || 0) * 0.55;
      const left = Math.min(100, Math.max(0, pct + nudge));
      const active = state.aircraftPopupId === item.id ? " is-active" : "";
      const label = aircraftLabel(item).replace(/"/g, "&quot;");
      const tipParts = [label];
      const typ = (item.aircraft_type || "").trim();
      const route = aircraftRouteLabel(item);
      if (typ) tipParts.push(typ);
      if (route) tipParts.push(route);
      const tip = tipParts.join(" · ").replace(/"/g, "&quot;");
      return `<button type="button" class="aircraft-slot${active}" data-aircraft-id="${item.id}" style="left:${left.toFixed(2)}%" title="${tip}" aria-label="Přelet ${label}"><span class="mdi mdi-airplane" aria-hidden="true"></span></button>`;
    })
    .join("");
}

function renderWeatherTimeline() {
  const el = $("weatherTimeline");
  if (!el) return;
  const { t0, t1 } = state.chartRange;
  const span = Math.max(1e-6, t1 - t0);
  const samples = state.weatherTimeline || [];
  layoutChartUnderTimelines();

  if (!samples.length) {
    el.innerHTML = "";
    el.title = "Historie počasí zatím není (načte se z forecastu / po hodinách)";
    return;
  }
  el.title = "";
  el.innerHTML = samples
    .map((s) => {
      const pct = ((s.t - t0) / span) * 100;
      if (pct < -2 || pct > 102) return "";
      const skew = s.skew_factors || [];
      const high = skew.some((x) => x.level === "high");
      const warn = skew.length > 0;
      const cls = [
        "weather-slot",
        warn ? "is-skew" : "",
        high ? "is-skew-high" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const icon = s.icon_class || "mdi-weather-partly-cloudy";
      const temp =
        s.temperature_c != null ? `${Math.round(Number(s.temperature_c))}°` : "";
      let windHtml = "";
      if (s.wind_speed_ms != null) {
        const spd = Number(s.wind_speed_ms).toFixed(1);
        const deg =
          s.wind_from_direction_deg != null
            ? ` style="transform:rotate(${Number(s.wind_from_direction_deg)}deg)"`
            : "";
        windHtml = `<span class="weather-slot-wind"><span class="weather-slot-wind-arrow"${deg} aria-hidden="true">↑</span>${spd}</span>`;
      }
      let precipHtml = "";
      if (s.precipitation_1h_mm != null) {
        const mm = Number(s.precipitation_1h_mm).toFixed(1);
        precipHtml = `<span class="weather-slot-precip"><span class="mdi mdi-water weather-slot-precip-icon" aria-hidden="true"></span>${mm}</span>`;
      }
      const title = weatherSlotTitle(s).replace(/"/g, "&quot;");
      return `<span class="${cls}" style="left:${pct.toFixed(2)}%" title="${title}"><span class="mdi ${icon}" aria-hidden="true"></span><span class="weather-slot-temp">${temp}</span>${windHtml}${precipHtml}</span>`;
    })
    .join("");
}

/** Obnova počasí na celou hodinu (+ malý jitter). */
function scheduleWeatherRefresh() {
  const now = Date.now();
  const msToHour = 3600_000 - (now % 3600_000) + 2000 + Math.floor(Math.random() * 3000);
  setTimeout(() => {
    refreshWeather();
    setInterval(refreshWeather, 3600_000);
  }, msToHour);
}

async function refreshHistory() {
  if (state.chartPanning) return;
  const { hours, start } = selectedHistoryRange();
  const metric = $("metricSelect").value;
  const reqId = ++state.historyReqId;
  try {
    let url = `/api/v1/history?metric=${encodeURIComponent(metric)}&hours=${encodeURIComponent(hours)}`;
    if (start != null) url += `&start=${encodeURIComponent(start)}`;
    const data = await fetchJson(url);
    if (reqId !== state.historyReqId) return;
    state.lastHistory = data;
    applyHistoryDisplay({ refetchSpec: true });
  } catch (err) {
    if (reqId === state.historyReqId) console.error(err);
  }
}

/** Drag-pan časové osy — graf i mini-spektrogram. */
function bindChartPan() {
  const chartCanvas = $("chart");
  const specCanvas = $("chartSpectrogram");
  if (!chartCanvas) return;

  let pointerId = null;
  let activeEl = null;
  let startX = 0;
  let originT0 = 0;
  let originT1 = 0;
  let moved = false;
  let tipWasEnabled = true;

  const setDraggingClass = (on) => {
    chartCanvas.classList.toggle("is-dragging", on);
    specCanvas?.classList.toggle("is-dragging", on);
  };

  const endPan = (ev) => {
    if (pointerId == null || (ev && ev.pointerId !== pointerId)) return;
    const wasDragging = state.chartPanning;
    state.chartPanning = false;
    pointerId = null;
    setDraggingClass(false);
    try {
      if (activeEl && ev?.pointerId != null) activeEl.releasePointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
    activeEl = null;
    const chart = state.chart;
    if (chart?.options?.plugins?.tooltip) {
      chart.options.plugins.tooltip.enabled = tipWasEnabled;
    }
    if (!wasDragging || !moved) return;
    const now = Date.now() / 1000;
    const { t0, t1 } = state.chartRange;
    if (t1 >= now - 1.5) {
      setChartLive(true);
    } else {
      setChartLive(false);
      state.chartStart = t0;
    }
    refreshHistory();
  };

  const onDown = (ev, hitTest) => {
    if (ev.button != null && ev.button !== 0) return;
    const chart = state.chart;
    if (!chart?.chartArea) return;
    const el = ev.currentTarget;
    if (hitTest === "chartArea") {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const { left, right, top, bottom } = chart.chartArea;
      if (x < left || x > right || y < top || y > bottom) return;
    } else if (!chartSpecEnabled() || $("chartSpecStrip")?.hidden) {
      return;
    }

    pointerId = ev.pointerId;
    activeEl = el;
    startX = ev.clientX;
    originT0 = state.chartRange.t0;
    originT1 = state.chartRange.t1;
    moved = false;
    state.chartPanning = true;
    setDraggingClass(true);
    tipWasEnabled = chart.options.plugins?.tooltip?.enabled !== false;
    if (chart.options.plugins?.tooltip) chart.options.plugins.tooltip.enabled = false;
    el.setPointerCapture(ev.pointerId);
    hideChartCrosshair();
    closeAircraftPopup();
    ev.preventDefault();
  };

  const onMove = (ev) => {
    if (pointerId == null || ev.pointerId !== pointerId) return;
    const chart = state.chart;
    if (!chart?.chartArea) return;
    const width = chart.chartArea.right - chart.chartArea.left;
    if (width <= 0) return;
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 4) return;
    moved = true;
    const span = Math.max(1e-6, originT1 - originT0);
    const dt = -(dx / width) * span;
    const hours = Number($("rangeSelect")?.value || 6);
    const now = Date.now() / 1000;
    const earliest = now - CHART_MAX_LOOKBACK_S;
    let t0 = originT0 + dt;
    let t1 = t0 + span;
    if (t1 > now) {
      t1 = now;
      t0 = t1 - span;
    }
    if (t0 < earliest) {
      t0 = earliest;
      t1 = Math.min(t0 + span, now);
    }
    applyHistoryTimeRange(t0, t1, hours);
  };

  chartCanvas.addEventListener("pointerdown", (ev) => onDown(ev, "chartArea"));
  chartCanvas.addEventListener("pointermove", onMove);
  chartCanvas.addEventListener("pointerup", endPan);
  chartCanvas.addEventListener("pointercancel", endPan);

  if (specCanvas) {
    specCanvas.addEventListener("pointerdown", (ev) => onDown(ev, "full"));
    specCanvas.addEventListener("pointermove", onMove);
    specCanvas.addEventListener("pointerup", endPan);
    specCanvas.addEventListener("pointercancel", endPan);
  }
}

function bindChartCrosshair() {
  const stack = $("chartStack");
  if (!stack) return;

  stack.addEventListener("mousemove", (ev) => {
    if (state.chartPanning) return;
    const onSurface = ev.target.closest?.(
      "#chart, #chartSpectrogram, .chart-spec-strip, .chart-spec-canvas-wrap, .chart-axis-labels"
    );
    if (!onSurface) {
      hideChartCrosshair();
      return;
    }
    const ts = timeFromChartClientX(ev.clientX);
    if (ts == null) {
      hideChartCrosshair();
      return;
    }
    showChartCrosshair(ts);
  });
  stack.addEventListener("mouseleave", () => hideChartCrosshair());
}

function bind() {
  $("rangeSelect").addEventListener("change", () => {
    closeAircraftPopup();
    state.aircraftOverflights = [];
    state.weatherTimeline = [];
    // Při změně délky okna zachovat konec (živě / aktuální t1).
    if (!state.chartLive && state.chartRange.t1 > 0) {
      const hours = Number($("rangeSelect").value || 6);
      const span = hours * 3600;
      const now = Date.now() / 1000;
      let t1 = Math.min(state.chartRange.t1, now);
      let t0 = t1 - span;
      const earliest = now - CHART_MAX_LOOKBACK_S;
      if (t0 < earliest) {
        t0 = earliest;
        t1 = Math.min(t0 + span, now);
      }
      state.chartStart = t0;
      if (t1 >= now - 1.5) setChartLive(true);
    }
    const { t0, t1, hours } = selectedHistoryRange();
    applyHistoryTimeRange(t0, t1, hours);
    syncDisplayToggleUi();
    refreshHistory();
  });
  $("metricSelect").addEventListener("change", refreshHistory);
  $("chartLiveBtn")?.addEventListener("click", () => {
    setChartLive(true);
    const { t0, t1, hours } = selectedHistoryRange();
    applyHistoryTimeRange(t0, t1, hours);
    refreshHistory();
  });

  bindDisplayToggles();

  const aircraftRow = $("aircraftTimeline");
  aircraftRow?.addEventListener("click", (ev) => {
    const btn = ev.target.closest?.(".aircraft-slot");
    if (!btn || !aircraftRow.contains(btn)) return;
    ev.stopPropagation();
    const id = Number(btn.getAttribute("data-aircraft-id"));
    const item = (state.aircraftOverflights || []).find((a) => a.id === id);
    if (item) openAircraftPopup(item, btn);
  });
  aircraftRow?.addEventListener("pointerover", (ev) => {
    const btn = ev.target.closest?.(".aircraft-slot");
    if (!btn || !aircraftRow.contains(btn)) return;
    const id = Number(btn.getAttribute("data-aircraft-id"));
    const item = (state.aircraftOverflights || []).find((a) => a.id === id);
    if (item) showChartCrosshair(item.t);
  });
  aircraftRow?.addEventListener("pointerout", (ev) => {
    const btn = ev.target.closest?.(".aircraft-slot");
    if (!btn || !aircraftRow.contains(btn)) return;
    const related = ev.relatedTarget;
    if (related && (btn.contains(related) || related.closest?.(".aircraft-slot"))) return;
    hideChartCrosshair();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeAircraftPopup();
  });
  document.addEventListener("click", (ev) => {
    const popup = $("aircraftPopup");
    if (!popup || popup.hidden) return;
    if (popup.contains(ev.target)) return;
    if (ev.target.closest?.(".aircraft-slot")) return;
    closeAircraftPopup();
  });

  window.addEventListener("resize", () => {
    drawChartSpectrogram();
    renderChartAxisLabels();
    layoutChartSpecStrip();
    renderAircraftTimeline();
    renderWeatherTimeline();
    closeAircraftPopup();
    hideChartCrosshair();
  });

  bindChartPan();
  bindChartCrosshair();
}

initChart();
bind();
syncDisplayToggleUi();
setChartLive(true);
refreshLatest();
refreshHistory();
refreshWeather();
scheduleWeatherRefresh();
setInterval(refreshLatest, 2000);
setInterval(() => {
  if (state.chartLive && !state.chartPanning) refreshHistory();
}, 15000);

function bindDisplayToggles() {
  const LONG_MS = 520;
  document.querySelectorAll(".display-toggle").forEach((row) => {
    const btn = row.querySelector(".pill-switch");
    if (!btn) return;
    const kind = row.getAttribute("data-switch");
    let pressTimer = null;
    let longPress = false;
    let pointerId = null;

    const clearPress = () => {
      if (pressTimer != null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    const closeTip = () => row.classList.remove("is-tip-open");
    const openTip = () => {
      document.querySelectorAll(".display-toggle.is-tip-open").forEach((w) => {
        if (w !== row) w.classList.remove("is-tip-open");
      });
      row.classList.add("is-tip-open");
    };

    btn.addEventListener("keydown", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      const next = btn.getAttribute("aria-checked") !== "true";
      setDisplayToggle(kind, next);
    });

    btn.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      longPress = false;
      pointerId = ev.pointerId;
      clearPress();
      pressTimer = setTimeout(() => {
        longPress = true;
        openTip();
      }, LONG_MS);
      try {
        btn.setPointerCapture(ev.pointerId);
      } catch (_) {
        /* ignore */
      }
    });

    const endPress = (ev) => {
      if (pointerId != null && ev.pointerId !== pointerId) return;
      clearPress();
      try {
        if (pointerId != null) btn.releasePointerCapture(pointerId);
      } catch (_) {
        /* ignore */
      }
      pointerId = null;
      if (longPress) return;
      const next = btn.getAttribute("aria-checked") !== "true";
      setDisplayToggle(kind, next);
    };

    btn.addEventListener("pointerup", endPress);
    btn.addEventListener("pointercancel", () => {
      clearPress();
      pointerId = null;
      longPress = false;
    });

    // Long-press na titulku = info (bez přepnutí)
    const label = row.querySelector(".display-toggle-label");
    label?.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      clearPress();
      pressTimer = setTimeout(() => {
        openTip();
      }, LONG_MS);
    });
    label?.addEventListener("pointerup", clearPress);
    label?.addEventListener("pointerleave", clearPress);
    label?.addEventListener("pointercancel", clearPress);

    row.addEventListener("mouseleave", () => {
      if (!row.matches(":hover")) closeTip();
    });
  });

  document.addEventListener("pointerdown", (ev) => {
    const open = document.querySelector(".display-toggle.is-tip-open");
    if (!open) return;
    if (open.contains(ev.target)) return;
    open.classList.remove("is-tip-open");
  });
}
