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
  nightBands: [],
  liveSpectrum: null,
  selectedTs: null,
  spectrogram: null,
  hoverCol: null,
};

function fmtDb(v) {
  if (v == null || Number.isNaN(v)) return "—.—";
  return Number(v).toFixed(1);
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(0)} %`;
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function setLevelClass(el, value) {
  el.classList.remove("hot", "over");
  if (value == null) return;
  if (value >= state.threshold + 5) el.classList.add("over");
  else if (value >= state.threshold) el.classList.add("hot");
}

function setHvacClass(el, score) {
  el.classList.remove("hvac-low", "hvac-mid", "hvac-high");
  if (score == null) return;
  if (score >= 65) el.classList.add("hvac-high");
  else if (score >= 40) el.classList.add("hvac-mid");
  else el.classList.add("hvac-low");
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
  if (!res.ok) throw new Error(`${res.status} ${url}`);
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
          borderColor: "rgba(240, 163, 90, 0.85)",
          borderDash: [6, 6],
          pointRadius: 0,
          borderWidth: 1.5,
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
          time: { tooltipFormat: "dd.MM. HH:mm:ss" },
          grid: { color: "rgba(232,240,236,0.06)" },
          ticks: { color: "#8fa399", maxRotation: 0 },
        },
        y: {
          grid: { color: "rgba(232,240,236,0.06)" },
          ticks: {
            color: "#8fa399",
            callback: (v) => `${v}`,
          },
          title: { display: true, text: "dBA", color: "#8fa399" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
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

function renderAnalysis(analysis) {
  if (!analysis) {
    $("mTotal").textContent = "—.—";
    $("mLfi").textContent = "—.—";
    $("mDom").textContent = "—";
    $("mDomSub").textContent = "oktávové pásmo";
    $("mHvac").textContent = "—";
    setHvacClass($("mHvac"), null);
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
  $("mHvac").textContent =
    analysis.hvac_score != null ? Number(analysis.hvac_score).toFixed(0) : "—";
  setHvacClass($("mHvac"), analysis.hvac_score);
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
    const periodLabel = state.period === "night" ? "noc" : "den";
    $("statLimit").textContent = `${state.threshold.toFixed(0)} dBA (${periodLabel})`;

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
    ctx.fillStyle = "#8fa399";
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
  for (let i = 0; i < nTicks; i++) {
    const idx = Math.round((i / Math.max(1, nTicks - 1)) * (cols.length - 1));
    const t = cols[idx].t;
    const d = new Date(t * 1000);
    const label = d.toLocaleString("cs-CZ", {
      hour: "2-digit",
      minute: "2-digit",
      ...(data.hours >= 24 ? { day: "2-digit", month: "2-digit" } : {}),
    });
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
        hvac_score: data.spectrum.hvac_score,
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
  } catch (err) {
    console.error(err);
  }
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
    state.chart.update("none");

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
    refreshHistory();
    refreshSpectrogram();
  });
  $("metricSelect").addEventListener("change", refreshHistory);
  $("fftLiveBtn").addEventListener("click", clearSpectrogramSelection);

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

  window.addEventListener("resize", () => drawSpectrogram());
}

initChart();
bind();
refreshLatest();
refreshHistory();
refreshSpectrogram();
setInterval(refreshLatest, 2000);
setInterval(refreshHistory, 15000);
setInterval(refreshSpectrogram, 30000);
