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

const SPEC_HEIGHT = 360;

const state = {
  threshold: 45,
  period: "day",
  chart: null,
  offlineChart: null,
  nightBands: [],
  offlineGaps: [],
  liveSpectrum: null,
  selectedTs: null,
  spectrogram: null,
  hoverCol: null,
  weatherTimeline: [],
  chartRange: { t0: 0, t1: 1 },
  aircraftOverflights: [],
  aircraftHits: [],
  aircraftPopupId: null,
};

function fmtDb(v) {
  if (v == null || Number.isNaN(v)) return "—.—";
  return Number(v).toFixed(1);
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(0)} %`;
}

/** Lidská délka intervalu (s → „2 h 15 min“). */
function fmtDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  let s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s} s`;
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  s %= 60;
  const parts = [];
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (m && d < 2) parts.push(`${m} min`);
  if (!d && !h && s) parts.push(`${s} s`);
  if (!parts.length) parts.push("0 s");
  return parts.join(" ");
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

function setLevelClass(el, value) {
  el.classList.remove("hot", "over");
  if (value == null) return;
  if (value >= state.threshold + 5) el.classList.add("over");
  else if (value >= state.threshold) el.classList.add("hot");
}

function updateOverLimit(laeq) {
  const el = $("mOverLimit");
  const sub = $("mOverLimitSub");
  const label = $("mOverLimitLabel");
  const periodLabel = state.period === "night" ? "noc" : "den";
  if (laeq == null || state.threshold == null) {
    el.textContent = "—.—";
    el.classList.remove("over-limit", "under-limit");
    label.textContent = "Od limitu";
    sub.textContent = "dB vs limit";
    return;
  }
  const delta = laeq - state.threshold;
  const over = delta >= 0;
  const sign = over ? "+" : "−";
  el.textContent = `${sign}${Math.abs(delta).toFixed(1)}`;
  el.classList.toggle("over-limit", over);
  el.classList.toggle("under-limit", !over);
  label.textContent = over ? "Nad limitem" : "Pod limitem";
  sub.textContent = `dB ${over ? "nad" : "pod"} ${state.threshold.toFixed(0)} dBA (${periodLabel})`;
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

/** Pásy offline / online na časové ose pod spektrogramem. */
const offlineBandsPlugin = {
  id: "offlineBands",
  beforeDatasetsDraw(chart) {
    const gaps = state.offlineGaps;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x;
    if (!chartArea || !x) return;

    const width = chartArea.right - chartArea.left;
    const height = chartArea.bottom - chartArea.top;

    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, width, height);
    ctx.clip();

    ctx.fillStyle = "rgba(126, 200, 163, 0.28)";
    ctx.fillRect(chartArea.left, chartArea.top, width, height);

    ctx.fillStyle = "rgba(232, 93, 76, 0.78)";
    for (const gap of gaps) {
      const x0 = x.getPixelForValue(gap.t0 * 1000);
      const x1 = x.getPixelForValue(gap.t1 * 1000);
      const left = Math.max(chartArea.left, Math.min(x0, x1));
      const right = Math.min(chartArea.right, Math.max(x0, x1));
      if (right - left < 0.5) continue;
      ctx.fillRect(left, chartArea.top, right - left, height);
    }
    ctx.restore();
  },
};

const AIRCRAFT_HIT_R = 14;

function drawAircraftIcon(ctx, x, y, active) {
  const s = active ? 11 : 9.5;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = active ? "#e8f0ec" : "#b8c9c0";
  ctx.strokeStyle = "rgba(2, 6, 14, 0.65)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.32, s * 0.15);
  ctx.lineTo(s * 0.9, s * 0.32);
  ctx.lineTo(s * 0.32, s * 0.42);
  ctx.lineTo(0, s * 0.95);
  ctx.lineTo(-s * 0.32, s * 0.42);
  ctx.lineTo(-s * 0.9, s * 0.32);
  ctx.lineTo(-s * 0.32, s * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** X pozice času v chartArea podle aktuální osy grafu. */
function aircraftPixelX(chart, tSec) {
  const { chartArea, scales } = chart;
  const xScale = scales?.x;
  if (!chartArea || !xScale) return null;
  const min = Number(xScale.min);
  const max = Number(xScale.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const tMs = tSec * 1000;
  if (tMs < min || tMs > max) return null;
  const pct = (tMs - min) / (max - min);
  return chartArea.left + pct * (chartArea.right - chartArea.left);
}

/** Y na křivce dBA v čase t (lineární interpolace), jinak null. */
function aircraftPixelYOnCurve(chart, tSec) {
  const yScale = chart.scales?.y;
  const data = chart.data?.datasets?.[0]?.data;
  if (!yScale || !data?.length) return null;
  const tMs = tSec * 1000;
  let prev = null;
  let next = null;
  for (const p of data) {
    if (p == null || p.x == null || p.y == null) continue;
    if (p.x <= tMs) prev = p;
    if (p.x >= tMs) {
      next = p;
      break;
    }
  }
  if (prev && next) {
    if (next.x === prev.x) return yScale.getPixelForValue(prev.y);
    const u = (tMs - prev.x) / (next.x - prev.x);
    const v = prev.y + (next.y - prev.y) * u;
    return yScale.getPixelForValue(v);
  }
  return null;
}

/** Markery přeletů: svislá čára v čase closest_ts + ikona. */
const aircraftMarkersPlugin = {
  id: "aircraftMarkers",
  afterDatasetsDraw(chart) {
    const items = state.aircraftOverflights || [];
    const { ctx, chartArea, scales } = chart;
    state.aircraftHits = [];
    if (!chartArea || !scales?.x || !items.length) return;

    for (const item of items) {
      if (item.t == null) continue;
      const px = aircraftPixelX(chart, item.t);
      if (px == null) continue;

      const onCurve = aircraftPixelYOnCurve(chart, item.t);
      const iconY =
        onCurve != null
          ? Math.min(chartArea.bottom - 12, Math.max(chartArea.top + 12, onCurve - 14))
          : chartArea.top + 14;
      const active = state.aircraftPopupId === item.id;

      ctx.save();
      ctx.beginPath();
      ctx.rect(
        chartArea.left,
        chartArea.top,
        chartArea.right - chartArea.left,
        chartArea.bottom - chartArea.top
      );
      ctx.clip();

      ctx.strokeStyle = active ? "rgba(232,240,236,0.55)" : "rgba(184,201,192,0.40)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px + 0.5, chartArea.top);
      ctx.lineTo(px + 0.5, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      if (onCurve != null) {
        ctx.fillStyle = active ? "#e8f0ec" : "rgba(184,201,192,0.9)";
        ctx.beginPath();
        ctx.arc(px, onCurve, active ? 3.2 : 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      drawAircraftIcon(ctx, px, iconY, active);
      state.aircraftHits.push({ id: item.id, x: px, y: iconY, item });
    }
  },
};

function aircraftLabel(item) {
  const cs = (item.callsign || "").trim();
  return cs || (item.icao24 || "—").toUpperCase();
}

function fmtKm(m) {
  if (m == null || Number.isNaN(m)) return "—";
  return `${(Number(m) / 1000).toFixed(1)} km`;
}

function fmtAltM(m) {
  if (m == null || Number.isNaN(m)) return "—";
  return `${Math.round(Number(m))} m`;
}

function fmtKmh(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  return `${Math.round(Number(ms) * 3.6)} km/h`;
}

function fmtTrack(deg) {
  if (deg == null || Number.isNaN(deg)) return "—";
  return `${Math.round(Number(deg) % 360)}°`;
}

function fmtVRate(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const v = Number(ms);
  if (Math.abs(v) < 0.5) return "rovně";
  const sign = v > 0 ? "↑" : "↓";
  return `${sign} ${Math.abs(v).toFixed(1)} m/s`;
}

function closeAircraftPopup() {
  const el = $("aircraftPopup");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
  state.aircraftPopupId = null;
  if (state.chart) state.chart.draw();
}

function openAircraftPopup(item, clientX, clientY) {
  const el = $("aircraftPopup");
  const wrap = el?.closest(".chart-wrap") || el?.parentElement;
  if (!el || !wrap || !item) return;

  state.aircraftPopupId = item.id;
  const country = item.origin_country || "—";
  el.innerHTML = `
    <div class="aircraft-popup-head">
      <div>
        <div class="aircraft-popup-title">${aircraftLabel(item)}</div>
        <div class="aircraft-popup-sub">${(item.icao24 || "").toUpperCase()} · ${country}</div>
      </div>
      <button type="button" class="aircraft-popup-close" id="aircraftPopupClose" aria-label="Zavřít">×</button>
    </div>
    <dl class="aircraft-popup-grid">
      <dt>Čas</dt><dd>${fmtTime(item.t)}</dd>
      <dt>Výška</dt><dd>${fmtAltM(item.altitude_m)}</dd>
      <dt>Vzdál.</dt><dd>${fmtKm(item.distance_m)}</dd>
      <dt>Rychlost</dt><dd>${fmtKmh(item.velocity_ms)}</dd>
      <dt>Směr</dt><dd>${fmtTrack(item.track_deg)}</dd>
      <dt>Stoupání</dt><dd>${fmtVRate(item.vertical_rate_ms)}</dd>
    </dl>
    <div class="aircraft-popup-foot">OpenSky Network</div>
  `;
  el.hidden = false;

  const wrapRect = wrap.getBoundingClientRect();
  const approxW = 220;
  const approxH = 210;
  let left = clientX - wrapRect.left + 12;
  let top = clientY - wrapRect.top + 12;
  left = Math.max(8, Math.min(left, wrapRect.width - approxW - 8));
  top = Math.max(8, Math.min(top, wrapRect.height - approxH - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  $("aircraftPopupClose")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeAircraftPopup();
  });
  if (state.chart) state.chart.draw();
}

function hitAircraftMarker(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  let best = null;
  let bestD = AIRCRAFT_HIT_R;
  for (const hit of state.aircraftHits || []) {
    const d = Math.hypot(hit.x - mx, hit.y - my);
    if (d <= bestD) {
      bestD = d;
      best = hit;
    }
  }
  return best;
}

/** Společný časový rozsah hlavní graf + offline timeline. */
function syncChartTimeRange(t0, t1, hours) {
  const min = t0 * 1000;
  const max = t1 * 1000;
  const formats = chartTimeFormats(hours);
  for (const chart of [state.chart, state.offlineChart]) {
    if (!chart) continue;
    chart.options.scales.x.min = min;
    chart.options.scales.x.max = max;
    chart.options.scales.x.time.displayFormats = formats;
  }
}

function initChart() {
  const ctx = $("chart").getContext("2d");
  state.chart = new Chart(ctx, {
    type: "line",
    plugins: [dayNightBandsPlugin, aircraftMarkersPlugin],
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
              const hours = Number($("rangeSelect")?.value || 24);
              return fmtAxisTime(value / 1000, { withDate: hours >= 48 });
            },
          },
        },
        y: {
          min: 0,
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
            label: (ctx) =>
              ctx.dataset.label === "limit"
                ? `limit ${ctx.parsed.y.toFixed(1)} dBA`
                : `${ctx.parsed.y.toFixed(1)} dBA`,
          },
        },
      },
    },
  });
}

function initOfflineChart() {
  const canvas = $("offlineChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  state.offlineChart = new Chart(ctx, {
    type: "line",
    plugins: [offlineBandsPlugin],
    data: {
      datasets: [
        {
          label: "offline",
          data: [],
          borderWidth: 0,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false, axis: "x" },
      layout: { padding: 0 },
      scales: {
        x: {
          type: "time",
          time: {
            tooltipFormat: "dd. MM. yyyy HH:mm:ss",
            displayFormats: chartTimeFormats(24),
          },
          display: false,
          grid: { display: false },
        },
        y: {
          min: 0,
          max: 1,
          display: false,
          grid: { display: false },
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
              const ts = ctx.parsed.x / 1000;
              const gap = state.offlineGaps.find((g) => ts >= g.t0 && ts <= g.t1);
              return gap
                ? `bez dat · ${fmtDuration(gap.duration_s)}`
                : "data přítomna";
            },
          },
        },
      },
    },
  });
}

function renderAnalysis(analysis) {
  if (!analysis) {
    $("mTotal").textContent = "—.—";
    $("mLfi").textContent = "—.—";
    $("mDom").textContent = "—";
    $("mDomSub").textContent = "oktávové pásmo";
    return;
  }
  $("mTotal").textContent = fmtDb(analysis.leq_total_db);
  $("mLfi").textContent = fmtDb(analysis.lfi_db);
  const ratio =
    analysis.lfi_ratio != null
      ? ` · ${Math.round(analysis.lfi_ratio * 100)} % energie`
      : "";
  const lfiSrc = analysis.lfi_source === "esp" ? " · ESP filtr" : "";
  $("mLfi").parentElement.querySelector(".derived-unit").textContent =
    `dB · 20–200 Hz${ratio}${lfiSrc}`;
  const leqSrc =
    analysis.leq_source === "esp" ? "dB · LZeq (ESP)" : "dB · součet pásem";
  $("mTotal").parentElement.querySelector(".derived-unit").textContent = leqSrc;
  $("mDom").textContent = analysis.dominant_label || "—";
  $("mDomSub").textContent =
    analysis.dominant_db != null
      ? `${fmtDb(analysis.dominant_db)} dB · střed ${analysis.dominant_hz} Hz`
      : "oktávové pásmo";
}

function renderSpectrumBars(bands, { locked } = {}) {
  const root = $("spectrumBars");
  if (!bands || !bands.length) {
    if (!root.dataset.empty) {
      root.dataset.empty = "1";
      root.innerHTML = SPECTRUM_FALLBACK.map(
        (label) =>
          `<div class="s-band empty"><span class="s-label">${label}</span>` +
          `<div class="s-track"><div class="s-fill" style="width:0%"></div></div>` +
          `<span class="s-val">—</span></div>`
      ).join("");
    }
    return;
  }
  delete root.dataset.empty;

  const values = bands.map((b) => Number(b.value)).filter((v) => !Number.isNaN(v));
  const vmin = values.length ? Math.min(...values) : 20;
  const vmax = values.length ? Math.max(...values) : 60;
  const span = Math.max(8, vmax - vmin);

  root.classList.toggle("locked", Boolean(locked));
  root.innerHTML = bands
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

function syncFftPanel() {
  if (state.selectedTs != null && state.selectedSpectrum) {
    renderSpectrumBars(state.selectedSpectrum.bands, { locked: true });
    $("fftHint").textContent = `1/3-oktáva + oktávy · ${fmtTime(state.selectedTs)}`;
    $("fftLiveBtn").hidden = false;
    return;
  }
  renderSpectrumBars(state.liveSpectrum?.bands, { locked: false });
  $("fftHint").textContent =
    "1/3-oktáva + oktávy · živě (klikni na spectrogram pro jiný čas)";
  $("fftLiveBtn").hidden = true;
}

async function refreshLatest() {
  try {
    const data = await fetchJson("/api/v1/latest");
    state.threshold = data.alert_threshold_dba ?? 45;
    state.period = data.alert_period ?? "day";

    const online = Boolean(data.online);
    $("onlineDot").className = `dot ${online ? "on" : "off"}`;
    $("onlineLabel").textContent = online ? "online" : "offline / bez dat";

    const live = data.metrics?.laeq_1s;
    if (live) {
      $("liveLevel").textContent = fmtDb(live.value);
      setLevelClass($("liveLevel"), live.value);
      const age = Math.max(0, Math.round(Date.now() / 1000 - live.ts));
      $("liveMeta").textContent =
        age < 5 ? "právě teď" : `naposledy před ${age} s`;
      updateOverLimit(live.value);
    } else {
      updateOverLimit(null);
    }

    state.liveSpectrum = data.spectrum || null;
    if (state.selectedTs == null) {
      renderAnalysis(data.analysis || data.spectrum);
    }
    syncFftPanel();
  } catch (err) {
    $("onlineDot").className = "dot off";
    $("onlineLabel").textContent = "API nedostupné";
    console.error(err);
  }
}

/** Svislé čáry na hranicích denního/nočního limitu (ALERT_*), ne astronomická noc. */
function drawSpectrogramLimitChanges(ctx, w, h, cols, edges) {
  if (!cols?.length || !edges?.length) return;
  const tMin = cols[0].t;
  const tMax = cols[cols.length - 1].t;
  if (tMax <= tMin) return;

  const toX = (t) => Math.max(0, Math.min(w, ((t - tMin) / (tMax - tMin)) * w));

  ctx.strokeStyle = "#ff2d95";
  ctx.lineWidth = 2.5;
  for (const t of edges) {
    if (t <= tMin || t >= tMax) continue;
    const x = Math.round(toX(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

function drawSpectrogram() {
  const canvas = $("spectrogram");
  const wrap = canvas.parentElement;
  const data = state.spectrogram;
  if (!data || !data.columns?.length) {
    const ctx = canvas.getContext("2d");
    const w = wrap.clientWidth || 600;
    canvas.width = w * devicePixelRatio;
    canvas.height = SPEC_HEIGHT * devicePixelRatio;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${SPEC_HEIGHT}px`;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(0, 0, w, SPEC_HEIGHT);
    ctx.fillStyle = "#a8bab2";
    ctx.font = "14px Sora, sans-serif";
    ctx.fillText("Čekám na historii spektra…", 16, Math.round(SPEC_HEIGHT / 2));
    $("specYLabels").innerHTML = "";
    $("specXLabels").innerHTML = "";
    $("specScale").innerHTML = "";
    return;
  }

  const cols = data.columns;
  const nBands = data.labels.length;
  const w = Math.max(320, wrap.clientWidth || 600);
  const h = SPEC_HEIGHT;
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  const vmin = data.vmin ?? 20;
  const vmax = Math.max(vmin + 8, data.vmax ?? 60);
  const span = vmax - vmin;
  const colW = w / cols.length;
  const rowH = h / nBands;

  ctx.fillStyle = "#0a1010";
  ctx.fillRect(0, 0, w, h);

  for (let c = 0; c < cols.length; c++) {
    const vals = cols[c].v;
    for (let b = 0; b < nBands; b++) {
      // low freq at bottom (index 0 → bottom)
      const row = nBands - 1 - b;
      const t = (vals[b] - vmin) / span;
      ctx.fillStyle = dbToColor(t);
      ctx.fillRect(
        Math.floor(c * colW),
        Math.floor(row * rowH),
        Math.ceil(colW) + 1,
        Math.ceil(rowH) + 1
      );
    }
  }

  drawSpectrogramLimitChanges(ctx, w, h, cols, data.limit_change_edges || []);

  // selection / hover marker
  const markCol =
    state.hoverCol != null
      ? state.hoverCol
      : state.selectedTs != null
        ? nearestCol(state.selectedTs)
        : null;
  if (markCol != null) {
    ctx.strokeStyle = "rgba(232,240,236,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(markCol * colW + colW / 2, 0);
    ctx.lineTo(markCol * colW + colW / 2, h);
    ctx.stroke();
  }

  $("specYLabels").innerHTML = [...data.labels]
    .reverse()
    .map((lab) => `<span>${lab}</span>`)
    .join("");

  const xLabels = [];
  const nTicks = Math.min(6, cols.length);
  const withDate = Number(data.hours) >= 24;
  for (let i = 0; i < nTicks; i++) {
    const idx = Math.round((i / Math.max(1, nTicks - 1)) * (cols.length - 1));
    const label = fmtAxisTime(cols[idx].t, { withDate });
    xLabels.push(
      `<span style="left:${(idx / Math.max(1, cols.length - 1)) * 100}%">${label}</span>`
    );
  }
  $("specXLabels").innerHTML = xLabels.join("");

  $("specScale").innerHTML =
    `<span>${fmtDb(vmax)}</span><span>dB</span><span>${fmtDb(vmin)}</span>`;

  state._specLayout = { w, h, colW, nBands, vmin, vmax };
}

function nearestCol(ts) {
  const cols = state.spectrogram?.columns;
  if (!cols?.length) return null;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < cols.length; i++) {
    const d = Math.abs(cols[i].t - ts);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function colFromEvent(ev) {
  const canvas = $("spectrogram");
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const cols = state.spectrogram?.columns;
  if (!cols?.length) return null;
  const idx = Math.max(0, Math.min(cols.length - 1, Math.floor((x / rect.width) * cols.length)));
  return idx;
}

async function selectSpectrogramCol(idx) {
  const col = state.spectrogram?.columns?.[idx];
  if (!col) return;
  state.selectedTs = col.t;
  state.selectedSpectrum = {
    bands: (state.spectrogram.labels || SPECTRUM_FALLBACK).map((label, i) => ({
      band: state.spectrogram.bands?.[i],
      label,
      value: col.v[i],
    })),
  };
  // refine from API if available
  try {
    const data = await fetchJson(`/api/v1/spectrum/at?ts=${col.t}`);
    if (data.spectrum) {
      state.selectedTs = data.spectrum.ts;
      state.selectedSpectrum = data.spectrum;
      renderAnalysis({
        leq_total_db: data.spectrum.leq_total_db,
        lfi_db: data.spectrum.lfi_db,
        lfi_ratio: data.spectrum.lfi_ratio,
        dominant_hz: data.spectrum.dominant_hz,
        dominant_label: data.spectrum.dominant_label,
        dominant_db: data.spectrum.dominant_db,
      });
    }
  } catch (_) {
    /* use column data */
  }
  syncFftPanel();
  drawSpectrogram();
}

function clearSpectrogramSelection() {
  state.selectedTs = null;
  state.selectedSpectrum = null;
  syncFftPanel();
  if (state.liveSpectrum) renderAnalysis(state.liveSpectrum);
  drawSpectrogram();
}

async function refreshSpectrogram() {
  const hours = $("rangeSelect").value;
  try {
    const data = await fetchJson(
      `/api/v1/spectrum/history?hours=${hours}&max_columns=480`
    );
    state.spectrogram = data;
    if (data.note) {
      $("specNote").textContent = data.note;
    }
    drawSpectrogram();
    renderOfflineStats(data.offline);
  } catch (err) {
    console.error(err);
  }
}

function renderOfflineStats(offline) {
  const totalEl = $("offlineTotal");
  const pctEl = $("offlinePct");
  const countEl = $("offlineCount");
  const onlineEl = $("offlineOnline");
  const gapsEl = $("offlineGaps");
  const hintEl = $("offlineHint");
  const expandBtn = $("offlineExpandBtn");
  if (!totalEl) return;

  const expanded = expandBtn?.getAttribute("aria-expanded") === "true";

  if (!offline) {
    state.offlineGaps = [];
    totalEl.textContent = "—";
    pctEl.textContent = "—";
    countEl.textContent = "—";
    onlineEl.textContent = "—";
    gapsEl.hidden = true;
    gapsEl.innerHTML = "";
    if (state.offlineChart) {
      state.offlineChart.data.datasets[0].data = [];
      state.offlineChart.update("none");
    }
    return;
  }

  const thr = offline.gap_threshold_s ?? 30;
  const hours = Number($("rangeSelect")?.value || 24);
  if (hintEl) {
    hintEl.textContent = `Výpadky ve vybraném rozsahu · mezera > ${thr} s · osa X jako hlavní graf`;
  }

  totalEl.textContent = fmtDuration(offline.offline_s);
  pctEl.textContent = fmtPct(offline.offline_pct);
  countEl.textContent =
    offline.gap_count != null ? String(offline.gap_count) : "—";
  onlineEl.textContent = fmtDuration(offline.online_s);

  const gaps = offline.gaps || [];
  state.offlineGaps = gaps;

  const t0 = offline.t0 ?? Date.now() / 1000 - hours * 3600;
  const t1 = offline.t1 ?? Date.now() / 1000;
  state.chartRange = { t0, t1 };
  syncChartTimeRange(t0, t1, hours);

  if (state.offlineChart) {
    // Vzorky po ose X kvůli tooltipu; pásy kreslí plugin
    const n = 160;
    const span = Math.max(1e-6, t1 - t0);
    const samples = [];
    for (let i = 0; i <= n; i++) {
      samples.push({ x: (t0 + (span * i) / n) * 1000, y: 0 });
    }
    state.offlineChart.data.datasets[0].data = samples;
    state.offlineChart.update("none");
  }
  if (state.chart) state.chart.update("none");

  if (!gaps.length) {
    gapsEl.innerHTML =
      `<li class="offline-gaps-empty">V tomto rozsahu nebyly žádné výpadky delší než ${thr} s.</li>`;
  } else {
    gapsEl.innerHTML = gaps
      .map((g) => {
        const a = fmtAxisTime(g.t0, { withDate: true });
        const b = fmtAxisTime(g.t1, { withDate: true });
        return `<li><span class="gap-when">${a} – ${b}</span><span class="gap-dur">${fmtDuration(g.duration_s)}</span></li>`;
      })
      .join("");
  }
  gapsEl.hidden = !expanded;
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

function layoutWeatherTimeline() {
  const el = $("weatherTimeline");
  const chart = state.chart;
  if (!el || !chart?.chartArea) return;
  const { left, right } = chart.chartArea;
  const width = chart.width || chart.canvas?.clientWidth || 0;
  el.style.marginLeft = "0";
  el.style.width = "100%";
  el.style.paddingLeft = `${Math.max(0, left)}px`;
  el.style.paddingRight = `${Math.max(0, width - right)}px`;
}

function renderWeatherTimeline() {
  const el = $("weatherTimeline");
  if (!el) return;
  const { t0, t1 } = state.chartRange;
  const span = Math.max(1e-6, t1 - t0);
  const samples = state.weatherTimeline || [];
  layoutWeatherTimeline();

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
  const hours = $("rangeSelect").value;
  const metric = $("metricSelect").value;
  try {
    const data = await fetchJson(
      `/api/v1/history?metric=${encodeURIComponent(metric)}&hours=${hours}`
    );
    state.threshold = data.threshold_dba ?? state.threshold;
    state.period = data.alert_period ?? state.period;
    state.nightBands = data.night_bands || [];
    state.weatherTimeline = data.weather_timeline || [];
    state.aircraftOverflights = data.aircraft_overflights || [];
    if (
      state.aircraftPopupId != null &&
      !state.aircraftOverflights.some((a) => a.id === state.aircraftPopupId)
    ) {
      closeAircraftPopup();
    }

    const points = (data.points || []).map((p) => ({
      x: p.t * 1000,
      y: p.v,
    }));
    state.chart.data.datasets[0].data = points;

    const limitPts = data.threshold_points || [];
    state.chart.data.datasets[1].data = limitPts.map((p) => ({
      x: p.t * 1000,
      y: p.v,
    }));

    const t1 = Date.now() / 1000;
    const t0 = t1 - Number(hours) * 3600;
    const off = state.spectrogram?.offline;
    if (off?.t0 != null && off?.t1 != null) {
      syncChartTimeRange(off.t0, off.t1, hours);
      state.chartRange = { t0: off.t0, t1: off.t1 };
    } else {
      syncChartTimeRange(t0, t1, hours);
      state.chartRange = { t0, t1 };
    }
    state.chart.update("none");
    renderWeatherTimeline();

    const s = data.stats || {};
    $("statAvg").textContent = s.avg != null ? `${fmtDb(s.avg)} dBA` : "—";
    $("statMin").textContent = s.min != null ? `${fmtDb(s.min)} dBA` : "—";
    $("statMax").textContent = s.max != null ? `${fmtDb(s.max)} dBA` : "—";
    $("statAbove").textContent = fmtPct(s.above_threshold_pct);
  } catch (err) {
    console.error(err);
  }
}

function bind() {
  $("rangeSelect").addEventListener("change", () => {
    state.selectedTs = null;
    state.selectedSpectrum = null;
    closeAircraftPopup();
    refreshHistory();
    refreshSpectrogram();
  });
  $("metricSelect").addEventListener("change", refreshHistory);
  $("fftLiveBtn").addEventListener("click", clearSpectrogramSelection);
  $("offlineExpandBtn")?.addEventListener("click", () => {
    const btn = $("offlineExpandBtn");
    const gapsEl = $("offlineGaps");
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("is-active", open);
    btn.textContent = open ? "Skrýt" : "Rozšířené";
    gapsEl.hidden = !open;
  });

  const mainChart = $("chart");
  mainChart?.addEventListener("click", (ev) => {
    const hit = hitAircraftMarker(mainChart, ev.clientX, ev.clientY);
    if (hit) {
      openAircraftPopup(hit.item, ev.clientX, ev.clientY);
      return;
    }
    closeAircraftPopup();
  });
  mainChart?.addEventListener("mousemove", (ev) => {
    const hit = hitAircraftMarker(mainChart, ev.clientX, ev.clientY);
    mainChart.style.cursor = hit ? "pointer" : "";
  });
  mainChart?.addEventListener("mouseleave", () => {
    mainChart.style.cursor = "";
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeAircraftPopup();
  });
  document.addEventListener("click", (ev) => {
    const popup = $("aircraftPopup");
    if (!popup || popup.hidden) return;
    if (popup.contains(ev.target)) return;
    if (mainChart && (ev.target === mainChart || mainChart.contains(ev.target))) return;
    closeAircraftPopup();
  });

  const canvas = $("spectrogram");
  canvas.addEventListener("click", (ev) => {
    const idx = colFromEvent(ev);
    if (idx != null) selectSpectrogramCol(idx);
  });
  canvas.addEventListener("mousemove", (ev) => {
    const idx = colFromEvent(ev);
    if (idx === state.hoverCol) return;
    state.hoverCol = idx;
    const cursor = $("specCursor");
    if (idx == null || !state.spectrogram?.columns?.length) {
      cursor.hidden = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const colW = rect.width / state.spectrogram.columns.length;
    cursor.hidden = false;
    cursor.style.left = `${idx * colW + colW / 2}px`;
    const col = state.spectrogram.columns[idx];
    cursor.title = fmtTime(col.t);
    drawSpectrogram();
  });
  canvas.addEventListener("mouseleave", () => {
    state.hoverCol = null;
    $("specCursor").hidden = true;
    drawSpectrogram();
  });

  window.addEventListener("resize", () => {
    drawSpectrogram();
    renderWeatherTimeline();
    closeAircraftPopup();
  });
}

initChart();
initOfflineChart();
bind();
refreshLatest();
refreshHistory();
refreshSpectrogram();
refreshWeather();
scheduleWeatherRefresh();
setInterval(refreshLatest, 2000);
setInterval(refreshHistory, 15000);
setInterval(refreshSpectrogram, 30000);
