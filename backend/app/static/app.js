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
/** High-res FFT 190–270 Hz — 81 × 1 Hz bin; kompaktní heatmapa. */
const FINE_SPEC_N_BINS = 81;
/** Výška jednoho 1 Hz řádku v heatmapě (px) — celé spektrum musí být vidět. */
const CHART_FINE_SPEC_ROW_H = 4;
/** Výška grafu překročení limitu (~1/4 spektrogramu). */
const CHART_EXCESS_HEIGHT = Math.round(CHART_SPEC_HEIGHT / 4);
/** Barva sloupců překročení + čtvereček v tooltipu. */
const CHART_EXCESS_COLOR = "#e85d4c";
/** Sloupce překročení vyřazené odstraněním šumu (filtr zapnutý). */
const CHART_EXCESS_SKIPPED_COLOR = "rgba(150, 162, 158, 0.42)";
/** Spektrogram pod hlavním grafem jen pro rozsah ≤ 48 h. */
const CHART_SPEC_MAX_HOURS = 48;

const CHART_DBA_COLOR = "#7ec8a3";
const CHART_DBA_FILL = "rgba(126, 200, 163, 0.12)";
/** Soft most přes vynechaný šum (segment.borderColor). */
const CHART_DBA_BRIDGE_COLOR = "rgba(126, 200, 163, 0.42)";
/** Napětí křivky dBA (monotone při denoise → bez overshootu přes mezery). */
const CHART_DBA_TENSION = 0.25;

/** Dominantní pásma, pro která se při filtru vyhodnocuje limit (Hz). */
const LIMIT_EVAL_HZ = new Set([25, 200, 250]);

/**
 * Detekce přechodných peaků (Odstranění šumu):
 * 1) širší ambient (medián ± okno) + MAD práh
 * 2) lokální spike vůči mediánu ±PEAK_LOCAL_HALF_S (chytí i mírnější jehly)
 * Souvislý úsek nad prahem delší než PEAK_MAX_RUN_S = trvalý hluk (ne peak).
 */
const PEAK_HALF_WINDOW_S = 30 * 60;
const PEAK_LOCAL_HALF_S = 6 * 60;
const PEAK_MARGIN_MIN_DB = 2.5;
const PEAK_LOCAL_MARGIN_DB = 2.0;
const PEAK_MAD_K = 2.0;
const PEAK_MAX_RUN_S = 8 * 60;
const PEAK_MIN_SAMPLES = 5;
const PEAK_DILATE_SAMPLES = 1;

const LS_WINDOW_CORR = "hlk.corr.window";
const LS_TONAL_CORR = "hlk.corr.tonal";
const LS_LIMIT_FREQ = "hlk.corr.limitFreq";
const LS_FINE_SPECTRUM = "hlk.corr.fineSpectrum";

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
  chartFineSpecReqId: 0,
  chartSpectrogram: null,
  chartFineSpectrogram: null,
  hoverTs: null,
  /** Poslední klíč hodnot v horním hover panelu (méně DOM update). */
  chartHoverKey: null,
  /** Čas sloupce spektrogramu u Y stupnice (méně překreslení). */
  specTooltipColTs: null,
  fineSpecTooltipColTs: null,
  /** Index frekvenčního binu pod kurzorem na fine spektrogramu (0 = nejnižší Hz). */
  fineSpecFocusBand: null,
  /**
   * WASD navigace nad spektrogramem:
   * skrytý OS kurzor + virtuální bod (clientX/Y), anchorMouse* pro detekci pohybu myši.
   */
  specKbdNav: null,
  /** Poslední pozice myši nad spektrogramem (pro start WASD). */
  specPointerLast: null,
  /** Hlavní graf: true = okno končí „teď“, start se posouvá s časem. */
  chartLive: true,
  /** Pevný začátek okna grafu (unix s), když chartLive=false. */
  chartStart: null,
  chartPanning: false,
  /** Display-only korekce (neovlivní API/DB). */
  display: {
    windowCorr: readLsBool(LS_WINDOW_CORR, true),
    tonalPenalty: readLsBool(LS_TONAL_CORR, false),
    /** Odstranění šumu: dominanta 25/200/250 Hz + filtr přechodných peaků. */
    limitFreqFilter: readLsBool(LS_LIMIT_FREQ, false),
    /** Jemné spektrum 190–270 Hz (beta, default vypnuto). */
    fineSpectrum: readLsBool(LS_FINE_SPECTRUM, false),
    windowDb: _displayCfg.windowDb,
    tonalDb: _displayCfg.tonalDb,
  },
  lastLatest: null,
  lastHistory: null,
  /** Cache peak-masky pro aktuální history points. */
  peakMask: null,
};

const CHART_MAX_LOOKBACK_S = 90 * 24 * 3600;
const CUSTOM_RANGE_MIN_S = 0.1 * 3600;
const CUSTOM_RANGE_MAX_S = CHART_MAX_LOOKBACK_S;

function isCustomRange() {
  return $("rangeSelect")?.value === "custom";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Části date/time inputů v lokálním čase. */
function toDateParts(tsSec) {
  const d = new Date(tsSec * 1000);
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

function fromDateAndTime(dateVal, timeVal) {
  if (!dateVal || !timeVal) return null;
  const t = new Date(`${dateVal}T${timeVal}`).getTime() / 1000;
  return Number.isFinite(t) ? t : null;
}

function readCustomRange() {
  const t0 = fromDateAndTime($("rangeFromDate")?.value, $("rangeFromTime")?.value);
  const t1 = fromDateAndTime($("rangeToDate")?.value, $("rangeToTime")?.value);
  if (t0 == null || t1 == null || t1 <= t0) return null;
  return { t0, t1 };
}

function syncCustomRangeInputs(t0, t1) {
  const fromDate = $("rangeFromDate");
  const fromTime = $("rangeFromTime");
  const toDate = $("rangeToDate");
  const toTime = $("rangeToTime");
  if (!fromDate || !fromTime || !toDate || !toTime) return;
  const a = toDateParts(t0);
  const b = toDateParts(t1);
  fromDate.value = a.date;
  fromTime.value = a.time;
  toDate.value = b.date;
  toTime.value = b.time;
}

function seedCustomRangeDefaults() {
  const now = Date.now() / 1000;
  syncCustomRangeInputs(now - 12 * 3600, now);
}

function setCustomRangeVisible(on) {
  const el = $("customRange");
  if (el) el.hidden = !on;
}

/** Délka okna v hodinách — preset select nebo vlastní OD/DO. */
function currentRangeHours() {
  if (isCustomRange()) {
    const custom = readCustomRange();
    if (custom) {
      return Math.min(
        CUSTOM_RANGE_MAX_S / 3600,
        Math.max(CUSTOM_RANGE_MIN_S / 3600, (custom.t1 - custom.t0) / 3600)
      );
    }
    return 12;
  }
  return Number($("rangeSelect")?.value || 6);
}

/** Aktuální časový rozsah hlavního grafu podle selectu (+ live / pan). */
function selectedHistoryRange() {
  const hours = currentRangeHours();
  const span = hours * 3600;
  const now = Date.now() / 1000;
  if (isCustomRange() && !state.chartLive && state.chartStart == null) {
    const custom = readCustomRange();
    if (custom) {
      let t0 = custom.t0;
      let t1 = Math.min(custom.t1, now);
      if (t1 - t0 < CUSTOM_RANGE_MIN_S) t0 = t1 - CUSTOM_RANGE_MIN_S;
      const earliest = now - CHART_MAX_LOOKBACK_S;
      if (t0 < earliest) {
        t0 = earliest;
        t1 = Math.min(Math.max(t1, t0 + CUSTOM_RANGE_MIN_S), now);
      }
      const h = Math.max(CUSTOM_RANGE_MIN_S / 3600, (t1 - t0) / 3600);
      return { t0, t1, hours: h, start: t0 };
    }
  }
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
  drawChartFineSpectrogram();
  drawChartExcess();
  renderChartAxisLabels();
  renderAircraftTimeline();
  renderWeatherTimeline();
  requestAnimationFrame(() => {
    layoutChartUnderTimelines();
    layoutChartSpecStrip();
    if (state.hoverTs != null) showChartCrosshair(state.hoverTs);
  });
}

function chartSpecEnabled(hours = currentRangeHours()) {
  return Number(hours) <= CHART_SPEC_MAX_HOURS + 1e-9;
}

function fineSpectrumVisible(hours = currentRangeHours()) {
  return chartSpecEnabled(hours) && !!state.display.fineSpectrum;
}

function fineSpecHeight(nBands) {
  const n = Math.max(1, Number(nBands) || FINE_SPEC_N_BINS);
  return Math.round(CHART_FINE_SPEC_ROW_H * n);
}

/** Band index (0 = nejnižší Hz) z clientY nad fine canvasem. */
function fineSpecBandAtClientY(clientY) {
  const canvas = $("chartFineSpectrogram");
  const data = state.chartFineSpectrogram;
  const n = data?.hz?.length || data?.labels?.length || 0;
  if (!canvas || !n) return null;
  const rect = canvas.getBoundingClientRect();
  if (!(rect.height > 0)) return null;
  const y = Math.min(rect.bottom, Math.max(rect.top, clientY));
  const rowFromTop = Math.min(
    n - 1,
    Math.max(0, Math.floor(((y - rect.top) / rect.height) * n))
  );
  return n - 1 - rowFromTop;
}

/** Client Y středu daného 1 Hz binu na fine canvasu. */
function fineSpecClientYForBand(band) {
  const canvas = $("chartFineSpectrogram");
  const data = state.chartFineSpectrogram;
  const n = data?.hz?.length || data?.labels?.length || 0;
  if (!canvas || !n) return null;
  const b = Math.min(n - 1, Math.max(0, band));
  const rect = canvas.getBoundingClientRect();
  const rowFromTop = n - 1 - b;
  return rect.top + ((rowFromTop + 0.5) / n) * rect.height;
}

function clearFineSpecUi() {
  state.fineSpecFocusBand = null;
  const yEl = $("chartFineSpecYLabels");
  if (yEl) {
    yEl.innerHTML = "";
    yEl.style.height = "";
  }
  const wrap = $("chartFineSpecCanvasWrap");
  if (wrap) wrap.style.height = "";
  hideFineSpecCursorReadout();
}

function syncChartSpecVisibility(hours) {
  const on = chartSpecEnabled(hours);
  const fineOn = fineSpectrumVisible(hours);
  const strip = $("chartSpecStrip");
  const fineStrip = $("chartFineSpecStrip");
  const labels = $("chartAxisLabels");
  const unavailable = $("chartSpecUnavailable");
  const stack = $("chartStack");
  if (strip) strip.hidden = !on;
  if (fineStrip) fineStrip.hidden = !fineOn;
  if (labels) labels.hidden = !on;
  if (unavailable) {
    unavailable.hidden = on;
    unavailable.textContent =
      `Spektrogram se zobrazuje pouze pro rozsah do ${CHART_SPEC_MAX_HOURS} hodin.`;
  }
  stack?.classList.toggle("has-spec", on);
  const chart = state.chart;
  if (chart?.options?.scales?.x?.ticks) {
    chart.options.scales.x.ticks.display = !on;
  }
  if (!fineOn) {
    state.chartFineSpectrogram = null;
    clearFineSpecUi();
  }
  if (!on) {
    hideChartCrosshair();
    state.chartSpectrogram = null;
    state.chartFineSpectrogram = null;
    const yEl = $("chartSpecYLabels");
    if (yEl) yEl.innerHTML = "";
    clearFineSpecUi();
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

function isLimitEvalHz(hz) {
  if (hz == null || Number.isNaN(Number(hz))) return false;
  const n = Number(hz);
  return LIMIT_EVAL_HZ.has(n) || LIMIT_EVAL_HZ.has(Math.round(n));
}

/** Dominantní Hz ze sloupce spektrogramu (max pásmo). */
function dominantHzFromSpecValues(values) {
  if (!values?.length) return null;
  const hzList = state.chartSpectrogram?.hz;
  let bestI = -1;
  let bestV = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (Number.isNaN(v)) continue;
    if (v > bestV) {
      bestV = v;
      bestI = i;
    }
  }
  if (bestI < 0) return null;
  if (hzList?.[bestI] != null) return Number(hzList[bestI]);
  // Fallback podle pořadí pásem (25, 31.5, …).
  const fallback = [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 500, 1000, 2000, 4000, 8000, 16000];
  return fallback[bestI] ?? null;
}

function dominantHzAtTime(tSec) {
  const col = nearestSpecColumn(tSec);
  if (!col?.v?.length) return null;
  return dominantHzFromSpecValues(col.v);
}

function medianSorted(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianOf(values) {
  if (!values?.length) return null;
  return medianSorted([...values].sort((a, b) => a - b));
}

function madOf(values, med) {
  if (!values?.length || med == null) return 0;
  const devs = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return medianSorted(devs) || 0;
}

function peakThresholdDb(med, mad) {
  return med + Math.max(PEAK_MARGIN_MIN_DB, PEAK_MAD_K * 1.4826 * mad);
}

function historyPointsCacheKey(points) {
  if (!points?.length) return "empty";
  const a = points[0];
  const b = points[points.length - 1];
  const mid = points[points.length >> 1];
  return `${points.length}:${a.t}:${a.v}:${mid?.t}:${mid?.v}:${b.t}:${b.v}:${windowOffset()}`;
}

/** Binární hledání prvního indexu s t >= target (points seřazené). */
function lowerBoundTs(points, target) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Medián / hodnoty v časovém okně kolem indexu i (s volitelným stride). */
function windowLevelsAround(points, levels, i, halfWinS, { maxSamples = 120, excludeI = false } = {}) {
  const t = points[i].t;
  const lo = lowerBoundTs(points, t - halfWinS);
  let hi = lowerBoundTs(points, t + halfWinS);
  while (hi < points.length && points[hi].t <= t + halfWinS) hi += 1;
  const span = hi - lo;
  if (span <= 0) return [];
  const step = Math.max(1, Math.ceil(span / maxSamples));
  const out = [];
  for (let j = lo; j < hi; j += step) {
    if (excludeI && j === i) continue;
    if (levels[j] != null) out.push(levels[j]);
  }
  return out;
}

/**
 * Postaví sadu časů přechodných peaků pro history points.
 * @returns {Set<number>}
 */
function buildPeakTimeSet(points) {
  const times = new Set();
  if (!points?.length) return times;

  const levels = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const v = points[i].v;
    levels[i] =
      v == null || Number.isNaN(Number(v)) ? null : applyWindow(Number(v));
  }

  const candidate = new Array(points.length).fill(false);

  for (let i = 0; i < points.length; i++) {
    const level = levels[i];
    if (level == null) continue;

    // Širší ambient (odolný vůči jednotlivým spike).
    const wide = windowLevelsAround(points, levels, i, PEAK_HALF_WINDOW_S, {
      maxSamples: 120,
    });
    if (wide.length >= PEAK_MIN_SAMPLES) {
      const med = medianOf(wide);
      if (med != null && level > peakThresholdDb(med, madOf(wide, med))) {
        candidate[i] = true;
      }
    }

    // Lokální jehla vůči blízkému okolí (chytí i peaky ~+2–3 dB).
    if (!candidate[i]) {
      const local = windowLevelsAround(points, levels, i, PEAK_LOCAL_HALF_S, {
        maxSamples: 40,
        excludeI: true,
      });
      if (local.length >= 3) {
        const medL = medianOf(local);
        if (medL != null && level > medL + PEAK_LOCAL_MARGIN_DB) {
          candidate[i] = true;
        }
      }
    }
  }

  // Souvislé úseky delší než PEAK_MAX_RUN_S = trvalý hluk, ne peak.
  const peakIdx = new Array(points.length).fill(false);
  let runStart = -1;
  const flushRun = (endExcl) => {
    if (runStart < 0) return;
    const dur = points[endExcl - 1].t - points[runStart].t;
    if (dur <= PEAK_MAX_RUN_S) {
      for (let j = runStart; j < endExcl; j++) {
        if (candidate[j]) peakIdx[j] = true;
      }
    }
    runStart = -1;
  };
  for (let i = 0; i < points.length; i++) {
    if (candidate[i]) {
      if (runStart < 0) runStart = i;
    } else {
      flushRun(i);
    }
  }
  flushRun(points.length);

  // Dilatace — zachytí ramena špičky.
  if (PEAK_DILATE_SAMPLES > 0) {
    const dilated = peakIdx.slice();
    for (let i = 0; i < points.length; i++) {
      if (!peakIdx[i]) continue;
      for (let d = 1; d <= PEAK_DILATE_SAMPLES; d++) {
        if (i - d >= 0) dilated[i - d] = true;
        if (i + d < points.length) dilated[i + d] = true;
      }
    }
    for (let i = 0; i < points.length; i++) peakIdx[i] = dilated[i];
  }

  for (let i = 0; i < points.length; i++) {
    if (peakIdx[i]) times.add(points[i].t);
  }

  return times;
}

function ensurePeakMask() {
  const points = state.lastHistory?.points;
  const key = historyPointsCacheKey(points);
  if (state.peakMask?.key === key) return state.peakMask;
  state.peakMask = { key, times: buildPeakTimeSet(points || []) };
  return state.peakMask;
}

/**
 * Naměřená řada bez přechodných peaků: šumové body se nevynechají,
 * ale nahradí ambientní lineární interpolací mezi okolními platnými body.
 * Hluchá místa tak zůstanou v čase a napojí se vodorovně/šikmo bez svislých skoků.
 */
function buildDenoisedMeasured(points, measuredData) {
  const n = measuredData?.length || 0;
  if (!n || !points?.length || points.length !== n) {
    return measuredData ? measuredData.slice() : [];
  }
  const peakTimes = ensurePeakMask().times;
  if (!peakTimes.size) {
    return measuredData.map((p) => ({ x: p.x, y: p.y }));
  }

  const isPeak = new Array(n);
  for (let i = 0; i < n; i++) {
    isPeak[i] = peakTimes.has(points[i].t);
  }

  const leftOk = new Array(n);
  let last = -1;
  for (let i = 0; i < n; i++) {
    leftOk[i] = last;
    const y = measuredData[i].y;
    if (!isPeak[i] && y != null && !Number.isNaN(Number(y))) last = i;
  }
  const rightOk = new Array(n);
  let next = -1;
  for (let i = n - 1; i >= 0; i--) {
    rightOk[i] = next;
    const y = measuredData[i].y;
    if (!isPeak[i] && y != null && !Number.isNaN(Number(y))) next = i;
  }

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const src = measuredData[i];
    if (!isPeak[i]) {
      out[i] = { x: src.x, y: src.y };
      continue;
    }
    const L = leftOk[i];
    const R = rightOk[i];
    let y;
    if (L >= 0 && R >= 0) {
      const xL = measuredData[L].x;
      const xR = measuredData[R].x;
      const yL = Number(measuredData[L].y);
      const yR = Number(measuredData[R].y);
      const span = xR - xL;
      const t = span > 0 ? (src.x - xL) / span : 0;
      y = yL + (yR - yL) * Math.min(1, Math.max(0, t));
    } else if (L >= 0) {
      y = measuredData[L].y;
    } else if (R >= 0) {
      y = measuredData[R].y;
    } else {
      y = src.y;
    }
    out[i] = { x: src.x, y, bridged: true };
  }
  return out;
}

/** Segment přes ambientní most (bridged) vs. naměřená data. */
function dbaSegmentIsBridge(ctx) {
  return !!(ctx?.p0?.raw?.bridged || ctx?.p1?.raw?.bridged);
}

function chartDatasetByLabel(label) {
  return state.chart?.data?.datasets?.find((d) => d.label === label) || null;
}

function isTransientPeakAt(tSec) {
  if (!state.display.limitFreqFilter) return false;
  const mask = ensurePeakMask();
  if (!mask.times.size) return false;
  if (mask.times.has(tSec)) return true;
  const points = state.lastHistory?.points;
  if (!points?.length) return false;
  const i = lowerBoundTs(points, tSec);
  const candidates = [];
  if (i < points.length) candidates.push(points[i]);
  if (i > 0) candidates.push(points[i - 1]);
  for (const p of candidates) {
    if (Math.abs(p.t - tSec) <= 1.5 && mask.times.has(p.t)) return true;
  }
  return false;
}

/** Live: peak vůči ambientu z recent history (stejný práh jako u grafu). */
function liveIsTransientPeak(level) {
  if (!state.display.limitFreqFilter || level == null || Number.isNaN(Number(level))) {
    return false;
  }
  const points = state.lastHistory?.points;
  if (!points?.length) return false;
  const now = Date.now() / 1000;
  const vals = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p.t < now - PEAK_HALF_WINDOW_S) break;
    if (p.v == null || Number.isNaN(Number(p.v))) continue;
    vals.push(applyWindow(Number(p.v)));
  }
  if (vals.length < PEAK_MIN_SAMPLES) return false;
  const med = medianOf(vals);
  if (med == null) return false;
  if (Number(level) > peakThresholdDb(med, madOf(vals, med))) return true;
  // Lokální práh vůči recent samples.
  const local = vals.slice(0, Math.min(vals.length, 20));
  const medL = medianOf(local);
  return medL != null && Number(level) > medL + PEAK_LOCAL_MARGIN_DB;
}

function liveDominantHzOk() {
  const analysis = state.lastLatest?.analysis || state.lastLatest?.spectrum;
  if (analysis?.dominant_hz != null) return isLimitEvalHz(analysis.dominant_hz);
  const bands = analysis?.bands || state.lastLatest?.spectrum?.bands;
  if (!bands?.length) return true;
  let bestHz = null;
  let bestV = -Infinity;
  for (const b of bands) {
    const v = Number(b.value);
    if (Number.isNaN(v)) continue;
    if (v > bestV) {
      bestV = v;
      bestHz = b.hz;
    }
  }
  if (bestHz == null) return true;
  return isLimitEvalHz(bestHz);
}

/**
 * Má se v daném okamžiku vyhodnocovat překročení limitu?
 * Filtr vypnutý → vždy ano.
 * Zapnutý → ne peak + (dominantní 25/200/250 Hz, pokud je spektrogram).
 * Bez spektrogramu (např. rozsah > 48 h) → frekvenční část se neaplikuje.
 * Bod bez blízkého spektra → frekvenčně nehodnotit.
 */
function shouldEvaluateLimitAt(tSec) {
  if (!state.display.limitFreqFilter) return true;
  if (isTransientPeakAt(tSec)) return false;
  const cols = state.chartSpectrogram?.columns;
  if (!cols?.length) return true;
  const hz = dominantHzAtTime(tSec);
  if (hz == null) return false;
  return isLimitEvalHz(hz);
}

function liveShouldEvaluateLimit(level = null) {
  if (!state.display.limitFreqFilter) return true;
  const shown =
    level != null
      ? level
      : state.lastLatest?.metrics?.laeq_1s != null
        ? applyWindow(state.lastLatest.metrics.laeq_1s.value)
        : null;
  if (liveIsTransientPeak(shown)) return false;
  return liveDominantHzOk();
}

function limitSkipLabel({ peak = false } = {}) {
  return peak ? "přechodný peak (šum)" : "mimo sledované frekvence";
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
  const sf = $("switchLimitFreq");
  const sFine = $("switchFineSpectrum");
  if (sw) sw.setAttribute("aria-checked", state.display.windowCorr ? "true" : "false");
  if (st) st.setAttribute("aria-checked", state.display.tonalPenalty ? "true" : "false");
  if (sf) sf.setAttribute("aria-checked", state.display.limitFreqFilter ? "true" : "false");
  if (sFine) sFine.setAttribute("aria-checked", state.display.fineSpectrum ? "true" : "false");

  document.querySelectorAll(".display-toggle").forEach((row) => {
    const kind = row.getAttribute("data-switch");
    let on = false;
    if (kind === "window") on = !!state.display.windowCorr;
    else if (kind === "tonal") on = !!state.display.tonalPenalty;
    else if (kind === "limitFreq") on = !!state.display.limitFreqFilter;
    else if (kind === "fineSpectrum") on = !!state.display.fineSpectrum;
    row.classList.toggle("is-on", on);
  });

  const fab = $("settingsFab");
  const anyActive =
    state.display.windowCorr ||
    state.display.tonalPenalty ||
    state.display.limitFreqFilter ||
    state.display.fineSpectrum;
  fab?.classList.toggle("has-active", !!anyActive);

  const wDb = state.display.windowDb;
  const tDb = state.display.tonalDb;
  const windowTip =
    `Odečte od naměřených hodnot ${wDb} dB. Zvuk přímo u zdi je silnější kvůli odrazu od skla a fasády. ` +
    `Tímto získáte reálnou hladinu hluku ve volném prostoru 2 metry před oknem.`;
  const tonalTip =
    `Sníží hygienické limity o ${tDb} dB. Zapněte, pokud hluk obsahuje výrazný otravný tón ` +
    `(např. hučení na jedné frekvenci z větrání či čerpadla).`;
  const limitFreqTip =
    "Ignoruje úseky, kde není dominantní pásmo 25, 200 nebo 250 Hz (typicky VZT), " +
    "a krátké peaky mimo běžný ambientní hluk. " +
    "V grafu nahradí šumové špičky ambientní spojnicí přes hluchá místa. " +
    "Šedé překročení se do statistiky nad limitem nezapočítá.";
  const fineTip =
    "Zobrazí spektrogram 190–270 Hz po 1 Hz (skutečná FFT / DFT). Sloupec ≈ 3 s. Experimentální — vyšší zátěž ESP.";
  const tipW = $("tipWindowCorr");
  const tipT = $("tipTonalCorr");
  const tipF = $("tipLimitFreq");
  const tipFine = $("tipFineSpectrum");
  const descW = $("descWindowCorr");
  const descT = $("descTonalCorr");
  const descF = $("descLimitFreq");
  const descFine = $("descFineSpectrum");
  if (tipW) tipW.textContent = windowTip;
  if (descW) descW.textContent = windowTip;
  if (tipT) tipT.textContent = tonalTip;
  if (descT) descT.textContent = tonalTip;
  if (tipF) tipF.textContent = limitFreqTip;
  if (descF) descF.textContent = limitFreqTip;
  if (tipFine) tipFine.textContent = fineTip;
  if (descFine) descFine.textContent = fineTip;
}

function setDisplayToggle(kind, on) {
  if (kind === "window") {
    state.display.windowCorr = !!on;
    writeLsBool(LS_WINDOW_CORR, state.display.windowCorr);
  } else if (kind === "tonal") {
    state.display.tonalPenalty = !!on;
    writeLsBool(LS_TONAL_CORR, state.display.tonalPenalty);
  } else if (kind === "limitFreq") {
    state.display.limitFreqFilter = !!on;
    writeLsBool(LS_LIMIT_FREQ, state.display.limitFreqFilter);
  } else if (kind === "fineSpectrum") {
    state.display.fineSpectrum = !!on;
    writeLsBool(LS_FINE_SPECTRUM, state.display.fineSpectrum);
  }
  syncDisplayToggleUi();
  applyLatestDisplay();
  if (kind === "fineSpectrum") {
    syncChartSpecVisibility();
    if (state.display.fineSpectrum && chartSpecEnabled()) {
      refreshChartSpectrogram();
    } else {
      state.chartFineSpectrogram = null;
      drawChartFineSpectrogram();
      applyHistoryDisplay({ refetchSpec: false });
    }
    return;
  }
  // Filtr frekvencí potřebuje spektrogram pro dominantu v historii.
  const needSpec = kind === "limitFreq" && state.display.limitFreqFilter;
  applyHistoryDisplay({ refetchSpec: needSpec });
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
    const evalOk = liveShouldEvaluateLimit(shown);
    document.querySelectorAll(".js-live-level").forEach((el) => {
      el.textContent = txt;
      setLevelClass(el, shown, lim, { evaluate: evalOk });
    });
    const age = Math.max(0, Math.round(Date.now() / 1000 - live.ts));
    setAllText(".js-live-meta", fmtAge(age));
    updateOverLimit(shown, lim, {
      evaluate: evalOk,
      peak: liveIsTransientPeak(shown),
    });
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
    return {
      avg: null,
      min: null,
      max: null,
      above_threshold_pct: null,
      avg_excess_db: null,
    };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let above = 0;
  let excessSum = 0;
  let n = 0;
  for (const p of points) {
    if (p.v == null || Number.isNaN(Number(p.v))) continue;
    const level = applyWindow(p.v);
    const lim = effectiveLimit(thresholdAtTime(limitPts, p.t));
    const over = level > lim;
    // Pod limitem, nebo po odstranění šumu (frekvence / peak).
    if (over && !shouldEvaluateLimitAt(p.t)) continue;
    sum += level;
    if (level < min) min = level;
    if (level > max) max = level;
    if (over) {
      above += 1;
      excessSum += level - lim;
    }
    n += 1;
  }
  if (!n) {
    return {
      avg: null,
      min: null,
      max: null,
      above_threshold_pct: null,
      avg_excess_db: null,
    };
  }
  return {
    avg: sum / n,
    min,
    max,
    above_threshold_pct: (100 * above) / n,
    avg_excess_db: above ? excessSum / above : 0,
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
  state.peakMask = null;
  setAircraftUiVisible(data.aircraft?.show_ui !== false);
  if (
    state.aircraftPopupId != null &&
    !state.aircraftOverflights.some((a) => a.id === state.aircraftPopupId)
  ) {
    closeAircraftPopup();
  }

  const rawPoints = data.points || [];
  const limitPts = data.threshold_points || [];

  const measuredData = rawPoints.map((p) => ({
    x: p.t * 1000,
    y: applyWindow(p.v),
  }));
  const filterOn = !!state.display.limitFreqFilter;
  const dbaDs = chartDatasetByLabel("dBA");
  const limitDs = chartDatasetByLabel("limit");
  const excessDs = chartDatasetByLabel("excess");

  if (dbaDs) {
    dbaDs.data = filterOn
      ? buildDenoisedMeasured(rawPoints, measuredData)
      : measuredData;
    dbaDs.tension = CHART_DBA_TENSION;
    // Monotone bez overshootu — mosty přes hluchá místa neudělají „zuby“.
    dbaDs.cubicInterpolationMode = filterOn ? "monotone" : "default";
  }
  // Neviditelná řada — data pro sloupcový graf překročení / hover panel.
  // Drží vždy surová naměřená data — i pro sloupcový graf překročení.
  if (excessDs) excessDs.data = measuredData;
  if (limitDs) {
    limitDs.data = limitPts.map((p) => ({
      x: p.t * 1000,
      y: effectiveLimit(p.v),
    }));
  }
  state.chartHoverKey = null;

  const range = selectedHistoryRange();
  if (state.chartLive && data.start != null) {
    state.chartStart = null;
  } else if (!state.chartLive && data.start != null) {
    state.chartStart = data.start;
  }
  applyHistoryTimeRange(range.t0, range.t1, range.hours);
  if (isCustomRange() && state.chartLive) {
    syncCustomRangeInputs(range.t0, range.t1);
  }

  const needRecompute =
    state.display.windowCorr ||
    state.display.tonalPenalty ||
    state.display.limitFreqFilter;
  const s = needRecompute
    ? computeDisplayStats(rawPoints, limitPts)
    : data.stats || {};
  $("statAvg").textContent = s.avg != null ? `${fmtDb(s.avg)} dBA` : "—";
  $("statMin").textContent = s.min != null ? `${fmtDb(s.min)} dBA` : "—";
  $("statMax").textContent = s.max != null ? `${fmtDb(s.max)} dBA` : "—";
  $("statAbove").textContent = fmtPct(s.above_threshold_pct);
  const avgEx = s.avg_excess_db;
  $("statAvgExcess").textContent =
    avgEx != null && !Number.isNaN(Number(avgEx))
      ? `+${fmtDb(avgEx)} dB`
      : "—";

  syncDisplayToggleUi();
  if (refetchSpec) {
    refreshChartSpectrogram();
  } else {
    drawChartSpectrogram();
    drawChartFineSpectrogram();
    drawChartExcess();
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

function setLevelClass(el, value, limit = null, { evaluate = true } = {}) {
  el.classList.remove("hot", "over", "is-uneval");
  if (value == null) return;
  if (!evaluate) {
    el.classList.add("is-uneval");
    return;
  }
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

function updateOverLimit(laeq, limit = null, { evaluate = true, peak = false } = {}) {
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
      el.classList.remove("over-limit", "under-limit", "is-uneval");
    });
    subs.forEach((el) => {
      el.textContent = "dB vs limit";
    });
    return;
  }

  if (!evaluate) {
    labels.forEach((el) => {
      el.textContent = "Od limitu";
    });
    values.forEach((el) => {
      el.textContent = "—.—";
      el.classList.remove("over-limit", "under-limit");
      el.classList.add("is-uneval");
    });
    subs.forEach((el) => {
      el.textContent = limitSkipLabel({ peak });
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
    el.classList.remove("is-uneval");
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
          borderColor: CHART_DBA_COLOR,
          backgroundColor: CHART_DBA_FILL,
          fill: true,
          tension: CHART_DBA_TENSION,
          pointRadius: 0,
          borderWidth: 2,
          segment: {
            borderColor: (ctx) =>
              dbaSegmentIsBridge(ctx) ? CHART_DBA_BRIDGE_COLOR : CHART_DBA_COLOR,
            borderDash: (ctx) => (dbaSegmentIsBridge(ctx) ? [5, 4] : undefined),
            borderWidth: (ctx) => (dbaSegmentIsBridge(ctx) ? 1.5 : 2),
          },
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
        {
          // Neviditelná řada — data pro sloupcový graf překročení / hover panel.
          label: "excess",
          data: [],
          borderColor: CHART_EXCESS_COLOR,
          backgroundColor: CHART_EXCESS_COLOR,
          pointRadius: 0,
          borderWidth: 0,
          showLine: false,
          fill: false,
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
              const hours = currentRangeHours();
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
        // Hodnoty u kurzoru jdou do #chartHoverPanel (fixed nahoře).
        tooltip: { enabled: false },
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
      const hot = !Number.isNaN(v) && v >= 1 && v >= vmax - 1.5;
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

  const fineStrip = $("chartFineSpecStrip");
  if (fineStrip) {
    fineStrip.style.marginLeft = "0";
    fineStrip.style.width = "100%";
  }
  const fineY = $("chartFineSpecYLabels");
  if (fineY) fineY.style.width = padL;

  const excess = $("chartExcessStrip");
  if (excess) {
    excess.style.marginLeft = "0";
    excess.style.width = "100%";
  }
  const excessY = $("chartExcessYLabels");
  if (excessY) excessY.style.width = padL;

  const labels = $("chartAxisLabels");
  if (labels) {
    labels.style.marginLeft = padL;
    labels.style.width = plotW;
  }
}

function nearestMeasuredAt(tsSec) {
  const ds = chartDatasetByLabel("dBA")?.data;
  if (!ds?.length) return null;
  const targetMs = tsSec * 1000;
  let best = null;
  let bestDist = Infinity;
  for (const p of ds) {
    if (p?.y == null || Number.isNaN(Number(p.y))) continue;
    const d = Math.abs(p.x - targetMs);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function hideChartHoverPanel() {
  state.chartHoverKey = null;
  const panel = $("chartHoverPanel");
  if (panel) panel.hidden = true;
}

/** Horní fixed panel: hladina, čas, limit, odchylka — u všech historických grafů. */
function showChartHoverPanel(tsSec) {
  const panel = $("chartHoverPanel");
  if (!panel) return;

  const measured = nearestMeasuredAt(tsSec);
  const tMs = measured?.x ?? tsSec * 1000;
  const level = measured?.y;
  const lim = chartLimitYAt(tMs);
  const tSec = tMs / 1000;
  const evaluate =
    level != null && lim != null ? shouldEvaluateLimitAt(tSec) : true;
  const peak = !evaluate && isTransientPeakAt(tSec);
  const tonal = !!state.display.tonalPenalty;

  let excessText = "—.—";
  let excessClass = "";
  let excessTitle = "Odchylka od limitu";
  if (level != null && lim != null && !Number.isNaN(Number(level)) && !Number.isNaN(Number(lim))) {
    if (!evaluate) {
      excessText = "—.—";
      excessClass = "is-uneval";
      excessTitle = limitSkipLabel({ peak });
    } else {
      const delta = Number(level) - Number(lim);
      const sign = delta >= 0 ? "+" : "−";
      excessText = `${sign}${Math.abs(delta).toFixed(1)}`;
      excessClass = delta >= 0 ? "is-over" : "is-under";
      excessTitle = delta >= 0 ? "Nad limitem" : "Pod limitem";
    }
  }

  const levelText =
    level != null && !Number.isNaN(Number(level)) ? Number(level).toFixed(1) : "—.—";
  const limitText =
    lim != null && !Number.isNaN(Number(lim)) ? Number(lim).toFixed(1) : "—.—";
  const timeText = fmtTime(tSec);
  const key = `${levelText}|${timeText}|${limitText}|${tonal}|${excessText}|${excessClass}|${excessTitle}`;
  if (state.chartHoverKey === key && !panel.hidden) return;
  state.chartHoverKey = key;

  const levelEl = $("hoverLevel");
  const timeEl = $("hoverTime");
  const limitEl = $("hoverLimit");
  const limitItem = $("hoverLimitItem");
  const excessEl = $("hoverExcess");
  const excessItem = $("hoverExcessItem");
  if (levelEl) levelEl.textContent = levelText;
  if (timeEl) timeEl.textContent = timeText;
  if (limitEl) limitEl.textContent = limitText;
  limitItem?.classList.toggle("is-tonal", tonal);
  if (limitItem) {
    limitItem.title = tonal ? "Hygienický limit (tónová korekce)" : "Hygienický limit";
  }
  if (excessEl) {
    excessEl.textContent = excessText;
    excessEl.classList.remove("is-over", "is-under", "is-uneval");
    if (excessClass) excessEl.classList.add(excessClass);
  }
  excessItem?.classList.toggle("is-uneval", excessClass === "is-uneval");
  if (excessItem) excessItem.title = excessTitle;
  panel.hidden = false;
}

function hideChartCrosshair() {
  exitSpecKbdNav({ restoreHover: false });
  state.hoverTs = null;
  state.fineSpecFocusBand = null;
  const el = $("chartCrosshair");
  if (el) el.hidden = true;
  hideChartHCrosshair();
  hideChartHoverPanel();
  hideSpecTooltip();
}

function hideChartHCrosshair() {
  const el = $("chartCrosshairH");
  if (el) el.hidden = true;
}

/** Vodorovná linka kříže v ploše aktuálního grafu. */
function showChartHCrosshair(plotRect, clientY) {
  const el = $("chartCrosshairH");
  const wrap = document.querySelector(".chart-wrap");
  if (!el || !wrap || !plotRect) {
    hideChartHCrosshair();
    return;
  }
  const wrapRect = wrap.getBoundingClientRect();
  const y = Math.min(plotRect.bottom, Math.max(plotRect.top, clientY));
  const left = plotRect.left - wrapRect.left;
  const width = Math.max(0, plotRect.right - plotRect.left);
  el.hidden = false;
  el.style.left = `${left}px`;
  el.style.width = `${width}px`;
  el.style.top = `${y - wrapRect.top}px`;
}

/**
 * Plocha grafu pod kurzorem (pro vodorovnou linku kříže).
 * @returns {{ id: string, plotRect: { left: number, right: number, top: number, bottom: number }, clientY: number } | null}
 */
function chartPlotHitAt(clientX, clientY) {
  const specs = [
    {
      id: "fine",
      stripId: "chartFineSpecStrip",
      canvasId: "chartFineSpectrogram",
      bodySel: ".chart-fine-spec-body",
      enabled: () => fineSpectrumVisible(),
    },
    {
      id: "main",
      stripId: "chartSpecStrip",
      canvasId: "chartSpectrogram",
      bodySel: ".chart-spec-body",
      enabled: () => chartSpecEnabled(),
    },
  ];
  for (const s of specs) {
    if (!s.enabled()) continue;
    const strip = $(s.stripId);
    const canvas = $(s.canvasId);
    if (!strip || strip.hidden || !canvas) continue;
    const body = strip.querySelector(s.bodySel) || strip;
    const bodyRect = body.getBoundingClientRect();
    if (
      clientX < bodyRect.left ||
      clientX > bodyRect.right ||
      clientY < bodyRect.top ||
      clientY > bodyRect.bottom
    ) {
      continue;
    }
    const rect = canvas.getBoundingClientRect();
    return {
      id: s.id,
      plotRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      clientY: Math.min(rect.bottom, Math.max(rect.top, clientY)),
    };
  }

  const excessStrip = $("chartExcessStrip");
  const excessCanvas = $("chartExcess");
  if (excessStrip && !excessStrip.hidden && excessCanvas) {
    const body = excessStrip.querySelector(".chart-excess-body") || excessStrip;
    const bodyRect = body.getBoundingClientRect();
    if (
      clientX >= bodyRect.left &&
      clientX <= bodyRect.right &&
      clientY >= bodyRect.top &&
      clientY <= bodyRect.bottom
    ) {
      const rect = excessCanvas.getBoundingClientRect();
      return {
        id: "excess",
        plotRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        clientY: Math.min(rect.bottom, Math.max(rect.top, clientY)),
      };
    }
  }

  const chart = state.chart;
  const canvas = $("chart");
  if (chart?.chartArea && canvas) {
    const rect = canvas.getBoundingClientRect();
    const ca = chart.chartArea;
    const plotRect = {
      left: rect.left + ca.left,
      right: rect.left + ca.right,
      top: rect.top + ca.top,
      bottom: rect.top + ca.bottom,
    };
    // Celý canvas včetně os — kříž zůstane i u okraje / Y stupnice Chart.js
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return {
        id: "chart",
        plotRect,
        clientY: Math.min(plotRect.bottom, Math.max(plotRect.top, clientY)),
      };
    }
  }
  return null;
}

/** Čas z X; při X mimo plot (Y stupnice) clamp na okraj chart area. */
function timeFromChartClientXClamped(clientX) {
  let ts = timeFromChartClientX(clientX);
  if (ts != null) return ts;
  const chart = state.chart;
  const canvas = $("chart");
  if (!chart?.chartArea || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const ca = chart.chartArea;
  const clamped = Math.min(rect.left + ca.right, Math.max(rect.left + ca.left, clientX));
  return timeFromChartClientX(clamped);
}

const SPEC_KBD_STEP_PX = 6;
const SPEC_KBD_MOUSE_EXIT_PX = 3;

function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

/** @returns {{ target: 'main'|'fine', canvas: HTMLCanvasElement, rect: DOMRect } | null} */
function spectrogramHitAt(clientX, clientY) {
  const candidates = [
    { id: "chartFineSpectrogram", stripId: "chartFineSpecStrip", target: "fine" },
    { id: "chartSpectrogram", stripId: "chartSpecStrip", target: "main" },
  ];
  for (const c of candidates) {
    if (c.target === "fine" && !fineSpectrumVisible()) continue;
    if (c.target === "main" && !chartSpecEnabled()) continue;
    const strip = $(c.stripId);
    const canvas = $(c.id);
    if (!strip || strip.hidden || !canvas) continue;
    const rect = canvas.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return { target: c.target, canvas, rect };
    }
  }
  return null;
}

function hideSpecPointerEl() {
  const el = $("chartSpecPointer");
  if (el) el.hidden = true;
  hideFineSpecCursorReadout();
  if (!state.specKbdNav?.active) {
    document.body.classList.remove("spec-pointer-hover");
  }
}

function showSpecPointerHover(clientX, clientY) {
  positionSpecPointer(clientX, clientY);
  if (!state.specKbdNav?.active) {
    document.body.classList.add("spec-pointer-hover");
  }
}

function positionSpecPointer(clientX, clientY) {
  const el = $("chartSpecPointer");
  const wrap = document.querySelector(".chart-wrap");
  if (!el || !wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  el.hidden = false;
  el.style.left = `${clientX - wrapRect.left}px`;
  el.style.top = `${clientY - wrapRect.top}px`;
}

/** Aplikuje virtuální bod spektrogramu (crosshair). */
function applySpecVirtualPointer(clientX, clientY, target) {
  const canvasId =
    target === "fine"
      ? "chartFineSpectrogram"
      : target === "main"
        ? "chartSpectrogram"
        : null;
  let hit = null;
  if (canvasId) {
    const canvas = $(canvasId);
    if (canvas) hit = { target, canvas, rect: canvas.getBoundingClientRect() };
  } else {
    hit = spectrogramHitAt(clientX, clientY);
  }
  if (!hit) return false;

  const x = Math.min(hit.rect.right, Math.max(hit.rect.left, clientX));
  const y = Math.min(hit.rect.bottom, Math.max(hit.rect.top, clientY));
  positionSpecPointer(x, y);

  const ts = timeFromChartClientXClamped(x);
  if (ts != null) {
    state.fineSpecFocusBand =
      hit.target === "fine" ? fineSpecBandAtClientY(y) : null;
    showChartCrosshair(ts);
    showChartHCrosshair(
      { left: hit.rect.left, right: hit.rect.right, top: hit.rect.top, bottom: hit.rect.bottom },
      y
    );
  } else {
    hideChartHoverPanel();
    hideChartHCrosshair();
  }
  return true;
}

function exitSpecKbdNav({ restoreHover = true } = {}) {
  if (!state.specKbdNav?.active) {
    hideSpecPointerEl();
    document.body.classList.remove("spec-kbd-nav");
    return;
  }
  state.specKbdNav = null;
  hideSpecPointerEl();
  document.body.classList.remove("spec-kbd-nav");
  if (!restoreHover) return;
}

function enterSpecKbdNav(clientX, clientY, target, anchorMouseX, anchorMouseY) {
  state.specKbdNav = {
    active: true,
    target,
    clientX,
    clientY,
    anchorMouseX,
    anchorMouseY,
  };
  document.body.classList.add("spec-kbd-nav");
  applySpecVirtualPointer(clientX, clientY, target);
}

function moveSpecKbdNav(dx, dy) {
  const nav = state.specKbdNav;
  if (!nav?.active) return;
  const canvas =
    nav.target === "fine" ? $("chartFineSpectrogram") : $("chartSpectrogram");
  if (!canvas) {
    exitSpecKbdNav({ restoreHover: false });
    return;
  }
  const rect = canvas.getBoundingClientRect();
  nav.clientX = Math.min(rect.right, Math.max(rect.left, nav.clientX + dx));

  if (nav.target === "fine" && dy !== 0) {
    // Po 1 Hz: jeden bin nahoru/dolů (ne pixelový skok přes 2 řádky).
    const n = state.chartFineSpectrogram?.hz?.length || FINE_SPEC_N_BINS;
    let band = fineSpecBandAtClientY(nav.clientY);
    if (band == null) band = Math.floor(n / 2);
    // W/↑ = výš na canvasu = vyšší Hz = vyšší index binu.
    band = Math.min(n - 1, Math.max(0, band + (dy < 0 ? 1 : -1)));
    const y = fineSpecClientYForBand(band);
    if (y != null) nav.clientY = y;
  } else {
    nav.clientY = Math.min(rect.bottom, Math.max(rect.top, nav.clientY + dy));
  }
  applySpecVirtualPointer(nav.clientX, nav.clientY, nav.target);
}

function bindSpecKeyboardNav() {
  document.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    let dx = 0;
    let dy = 0;
    if (key === "a" || key === "ArrowLeft") dx = -SPEC_KBD_STEP_PX;
    else if (key === "d" || key === "ArrowRight") dx = SPEC_KBD_STEP_PX;
    else if (key === "w" || key === "ArrowUp") dy = -SPEC_KBD_STEP_PX;
    else if (key === "s" || key === "ArrowDown") dy = SPEC_KBD_STEP_PX;
    else return;

    // Po změně rozsahu zůstává focus na <select> — šipky by měnily option
    // místo pohybu bodu. Nad spektrogramem (nebo v aktivní navigaci) přebíráme
    // klávesy i z selectu; INPUT/TEXTAREA necháme na psaní.
    const typing = isTypingTarget(ev.target);
    const overSpec = !!(state.specKbdNav?.active || state.specPointerLast);
    if (typing) {
      const tag = ev.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ev.target?.isContentEditable) {
        return;
      }
      if (tag === "SELECT" && !overSpec) return;
    }

    if (state.specKbdNav?.active) {
      ev.preventDefault();
      if (ev.target?.tagName === "SELECT") ev.target.blur();
      moveSpecKbdNav(dx, dy);
      return;
    }

    const last = state.specPointerLast;
    if (!last) return;
    const hit = spectrogramHitAt(last.clientX, last.clientY);
    if (!hit) return;

    ev.preventDefault();
    if (ev.target?.tagName === "SELECT") ev.target.blur();
    enterSpecKbdNav(
      last.clientX,
      last.clientY,
      hit.target,
      last.clientX,
      last.clientY
    );
    moveSpecKbdNav(dx, dy);
  });
}

function nearestSpecColumnFrom(data, tsSec, maxDistSec) {
  const cols = data?.columns;
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
  const maxDist =
    maxDistSec != null ? maxDistSec : Math.max(90, (t1 - t0) * 0.03);
  if (bestDist > maxDist) return null;
  return best;
}

function nearestSpecColumn(tsSec) {
  return nearestSpecColumnFrom(state.chartSpectrogram, tsSec);
}

/** Jemné spektrum: overlay jen když je u kurzoru reálný vzorek (ne snap přes celý rozsah). */
const FINE_SPEC_HOVER_MAX_DIST_S = 10;

function hideSpecTooltip() {
  state.specTooltipColTs = null;
  state.fineSpecTooltipColTs = null;
  const bars = $("chartSpecBars");
  if (bars) {
    bars.hidden = true;
    bars.innerHTML = "";
  }
  hideFineSpecCursorReadout();
}

function hideFineSpecCursorReadout() {
  const el = $("chartSpecPointerReadout");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

/** U kurzoru na fine spektrogramu: frekvence + dB. */
function updateFineSpecCursorReadout(tsSec, focusBand) {
  const el = $("chartSpecPointerReadout");
  if (!el) return;
  if (focusBand == null || !fineSpectrumVisible()) {
    hideFineSpecCursorReadout();
    return;
  }
  const data = state.chartFineSpectrogram;
  const n = data?.hz?.length || 0;
  if (!data || focusBand < 0 || focusBand >= n) {
    hideFineSpecCursorReadout();
    return;
  }
  const col = nearestSpecColumnFrom(data, tsSec, FINE_SPEC_HOVER_MAX_DIST_S);
  if (!col?.v?.length) {
    hideFineSpecCursorReadout();
    return;
  }
  const hz = Number(data.hz[focusBand]);
  const raw = col.v[focusBand];
  const v =
    raw == null || Number.isNaN(Number(raw)) ? null : Number(raw) - windowOffset();
  const hzTxt = Number.isFinite(hz) ? `${Math.round(hz)} Hz` : "—";
  const dbTxt = v == null || Number.isNaN(v) ? "—.—" : fmtDb(v);
  el.textContent = `${hzTxt} · ${dbTxt} dB`;
  el.hidden = false;
  state.fineSpecTooltipColTs = col.t;
}

/** Spektrum u crosshairu — dB + linky vlevo přes spektrogram, vedle Y stupnice. */
function showSpecTooltip(tsSec, _lineLeft) {
  const barsEl = $("chartSpecBars");
  const strip = $("chartSpecStrip");
  if (!chartSpecEnabled()) {
    hideSpecTooltip();
    return;
  }

  let any = false;
  if (barsEl && strip && !strip.hidden) {
    const col = nearestSpecColumnFrom(state.chartSpectrogram, tsSec);
    if (col?.v?.length) {
      if (!(state.specTooltipColTs === col.t && !barsEl.hidden)) {
        state.specTooltipColTs = col.t;
        const labels = state.chartSpectrogram?.labels || SPECTRUM_FALLBACK;
        fillSpecBars(barsEl, col, labels, SPECTRUM_BAND_IDS, LF_BANDS);
      }
      any = true;
    } else if (barsEl) {
      barsEl.hidden = true;
      barsEl.innerHTML = "";
      state.specTooltipColTs = null;
    }
  }

  if (state.fineSpecFocusBand != null) {
    updateFineSpecCursorReadout(tsSec, state.fineSpecFocusBand);
    any = true;
  } else {
    hideFineSpecCursorReadout();
  }

  if (!any) hideSpecTooltip();
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
  const excessStrip = $("chartExcessStrip");
  if (excessStrip && !excessStrip.hidden) {
    bottom = Math.max(bottom, excessStrip.getBoundingClientRect().bottom - wrapRect.top);
  }
  if (chartSpecEnabled() && !$("chartSpecStrip")?.hidden) {
    const labels = $("chartAxisLabels");
    const fineStrip = $("chartFineSpecStrip");
    let endEl = labels && !labels.hidden ? labels : $("chartSpecStrip");
    if (fineStrip && !fineStrip.hidden) {
      endEl = labels && !labels.hidden ? labels : fineStrip;
    }
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
  showChartHoverPanel(tsSec);
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
  const hours = currentRangeHours();
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

function fillSpecBars(barsEl, col, labels, bandIds, lfBands) {
  const off = windowOffset();
  const bands = col.v.map((v, i) => ({
    band: bandIds?.[i] || "",
    label: labels[i] || "",
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
      const hot = !Number.isNaN(v) && v >= 1 && v >= vmax - 1.5;
      const lf = lfBands ? lfBands.has(String(b.band)) : true;
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

function drawHeatmapSpectrogram({
  canvasId,
  stripId,
  wrapId,
  yElId,
  height,
  data,
  emptyText,
  yLabelFn,
  skipYLabels = false,
}) {
  const canvas = $(canvasId);
  const strip = $(stripId);
  const wrap = $(wrapId);
  const yEl = $(yElId);
  if (!canvas || !strip) return;
  if (!chartSpecEnabled() || strip.hidden) return;

  layoutChartSpecStrip();
  const host = wrap || strip;
  const w = Math.max(40, Math.floor(host.clientWidth || 0));
  const h = height;
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  const cols = data?.columns;
  if (!cols?.length) {
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#a8bab2";
    ctx.font = "12px Sora, sans-serif";
    ctx.fillText(emptyText, 10, Math.round(h / 2));
    if (yEl) yEl.innerHTML = "";
    return;
  }

  const { t0, t1 } = state.chartRange;
  const span = Math.max(1e-6, t1 - t0);
  const labels = data.labels || [];
  const hzList = data.hz || [];
  const nBands = labels.length || (cols[0].v?.length ?? 0);
  if (!nBands) return;

  if (yEl) {
    if (skipYLabels) {
      yEl.innerHTML = "";
    } else {
      yEl.innerHTML = [...labels]
        .map((lab, i) => {
          const hz = hzList[i];
          const text = yLabelFn ? yLabelFn(lab, hz) : lab;
          return `<span>${text || ""}</span>`;
        })
        .reverse()
        .join("");
    }
  }

  const vmin = (data.vmin ?? 20) - windowOffset();
  const vmax = Math.max(vmin + 8, (data.vmax ?? 60) - windowOffset());
  const vSpan = vmax - vmin;
  const rowH = h / nBands;

  ctx.fillStyle = "#0a1010";
  ctx.fillRect(0, 0, w, h);

  const inView = cols.filter((c) => c.t >= t0 - span * 0.02 && c.t <= t1 + span * 0.02);
  const colW = Math.max(1, w / Math.max(1, inView.length));
  const off = windowOffset();

  for (const col of inView) {
    const x = ((col.t - t0) / span) * w;
    if (x < -colW || x > w + colW) continue;
    const vals = col.v || [];
    for (let b = 0; b < nBands; b++) {
      const row = nBands - 1 - b;
      const y0 = row * rowH;
      const y1 = (row + 1) * rowH;
      const raw = vals[b] ?? data.vmin ?? 20;
      const shown = Number(raw) - off;
      const t = (shown - vmin) / vSpan;
      ctx.fillStyle = dbToColor(t);
      ctx.fillRect(
        Math.floor(x - colW / 2),
        Math.floor(y0),
        Math.ceil(colW) + 1,
        Math.max(1, Math.ceil(y1 - y0) + 1)
      );
    }
  }

  const edgesLim = data.limit_change_edges || [];
  if (edgesLim.length) {
    ctx.strokeStyle = "#ff2d95";
    ctx.lineWidth = 2;
    for (const edgeT of edgesLim) {
      if (edgeT <= t0 || edgeT >= t1) continue;
      const x = Math.round(((edgeT - t0) / span) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
}

function drawChartSpectrogram() {
  drawHeatmapSpectrogram({
    canvasId: "chartSpectrogram",
    stripId: "chartSpecStrip",
    wrapId: "chartSpecCanvasWrap",
    yElId: "chartSpecYLabels",
    height: CHART_SPEC_HEIGHT,
    data: state.chartSpectrogram,
    emptyText: "Spektrum…",
  });
}

function drawChartFineSpectrogram() {
  const data = state.chartFineSpectrogram;
  const strip = $("chartFineSpecStrip");
  if (strip?.hidden) return;
  const nBands = data?.labels?.length || data?.hz?.length || FINE_SPEC_N_BINS;
  const height = fineSpecHeight(nBands);
  const yEl = $("chartFineSpecYLabels");
  const wrap = $("chartFineSpecCanvasWrap");
  if (yEl) yEl.style.height = `${height}px`;
  if (wrap) wrap.style.height = `${height}px`;
  drawHeatmapSpectrogram({
    canvasId: "chartFineSpectrogram",
    stripId: "chartFineSpecStrip",
    wrapId: "chartFineSpecCanvasWrap",
    yElId: "chartFineSpecYLabels",
    height,
    data,
    emptyText: "High-res FFT…",
    // 81 × 1 Hz — každých 5 Hz (190, 195, … 270).
    yLabelFn: (lab, hz) => {
      const h = Number(hz);
      if (!Number.isFinite(h) || Math.round(h) % 5 !== 0) return "";
      return lab || `${Math.round(h)} Hz`;
    },
  });
}

/** Nice upper bound for excess Y scale (dB above limit). */
function niceExcessMax(rawMax) {
  const m = Math.max(1, Number(rawMax) || 0);
  if (m <= 2) return 2;
  if (m <= 5) return 5;
  if (m <= 10) return 10;
  return Math.ceil(m / 5) * 5;
}

/** Sloupcový graf překročení limitu (jen kladné Δ = naměřené − limit). */
function drawChartExcess() {
  const canvas = $("chartExcess");
  const strip = $("chartExcessStrip");
  const wrap = $("chartExcessCanvasWrap");
  const yEl = $("chartExcessYLabels");
  if (!canvas || !strip) return;

  layoutChartSpecStrip();
  const host = wrap || strip;
  const w = Math.max(40, Math.floor(host.clientWidth || 0));
  const h = CHART_EXCESS_HEIGHT;
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  ctx.fillStyle = "#0a1010";
  ctx.fillRect(0, 0, w, h);

  const pts = chartDatasetByLabel("excess")?.data;
  const { t0, t1 } = state.chartRange;
  const span = Math.max(1e-6, t1 - t0);
  if (!pts?.length) {
    if (yEl) yEl.innerHTML = "";
    return;
  }

  const inView = [];
  let maxEx = 0;
  let nPts = 0;
  for (const p of pts) {
    const tSec = p.x / 1000;
    if (tSec < t0 - span * 0.02 || tSec > t1 + span * 0.02) continue;
    nPts += 1;
    if (p.y == null || Number.isNaN(Number(p.y))) continue;
    const lim = chartLimitYAt(p.x);
    if (lim == null || Number.isNaN(Number(lim))) continue;
    const excess = Number(p.y) - Number(lim);
    if (excess <= 0) continue;
    const evaluate = shouldEvaluateLimitAt(tSec);
    inView.push({ t: tSec, excess, evaluate });
    if (excess > maxEx) maxEx = excess;
  }

  const yMax = niceExcessMax(maxEx);
  if (yEl) {
    yEl.innerHTML = `<span>${yMax}</span><span>0</span>`;
  }

  // Baseline
  ctx.strokeStyle = "rgba(232, 240, 236, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();

  if (!inView.length) return;

  // Šířka podle hustoty všech bodů v okně (ne jen překročení).
  const barW = Math.max(1, Math.min(6, w / Math.max(1, nPts)));
  for (const item of inView) {
    const x = ((item.t - t0) / span) * w;
    if (x < -barW || x > w + barW) continue;
    const bh = Math.max(1, (item.excess / yMax) * (h - 1));
    const top = h - bh;
    ctx.fillStyle = item.evaluate ? CHART_EXCESS_COLOR : CHART_EXCESS_SKIPPED_COLOR;
    ctx.fillRect(Math.floor(x - barW / 2), Math.floor(top), Math.ceil(barW), Math.ceil(bh));
  }
}

async function refreshChartSpectrogram() {
  if (!chartSpecEnabled()) {
    state.chartSpectrogram = null;
    state.chartFineSpectrogram = null;
    drawChartSpectrogram();
    drawChartFineSpectrogram();
    drawChartExcess();
    syncDisplayToggleUi();
    if (state.hoverTs == null) hideSpecTooltip();
    return;
  }
  if (state.chartPanning) return;
  const { hours, start } = selectedHistoryRange();
  const reqId = ++state.chartSpecReqId;
  const wantFine = !!state.display.fineSpectrum;
  const fineReqId = wantFine ? ++state.chartFineSpecReqId : state.chartFineSpecReqId;
  try {
    let url = `/api/v1/spectrum/history?hours=${encodeURIComponent(hours)}&max_columns=480`;
    if (start != null) url += `&start=${encodeURIComponent(start)}`;
    const finePromise = wantFine
      ? (() => {
          let fineUrl = `/api/v1/spectrum/fine/history?hours=${encodeURIComponent(hours)}&max_columns=480`;
          if (start != null) fineUrl += `&start=${encodeURIComponent(start)}`;
          return fetchJson(fineUrl).catch((err) => {
            console.error(err);
            return null;
          });
        })()
      : Promise.resolve(null);
    const [data, fineData] = await Promise.all([fetchJson(url), finePromise]);
    if (reqId !== state.chartSpecReqId) return;
    state.chartSpectrogram = data;
    if (wantFine && fineReqId === state.chartFineSpecReqId) {
      state.chartFineSpectrogram = fineData;
    } else if (!wantFine) {
      state.chartFineSpectrogram = null;
    }
    state.specTooltipColTs = null;
    state.fineSpecTooltipColTs = null;
    if (state.display.limitFreqFilter) {
      applyHistoryDisplay({ refetchSpec: false });
    } else {
      drawChartSpectrogram();
      drawChartFineSpectrogram();
      drawChartExcess();
      renderChartAxisLabels();
      syncDisplayToggleUi();
      if (state.hoverTs != null) {
        showChartCrosshair(state.hoverTs);
      }
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

/** Drag-pan časové osy — graf, překročení i spektrogram. */
function bindChartPan() {
  const chartCanvas = $("chart");
  const excessCanvas = $("chartExcess");
  const specCanvas = $("chartSpectrogram");
  const fineSpecCanvas = $("chartFineSpectrogram");
  if (!chartCanvas) return;

  let pointerId = null;
  let activeEl = null;
  let startX = 0;
  let originT0 = 0;
  let originT1 = 0;
  let moved = false;

  const setDraggingClass = (on) => {
    chartCanvas.classList.toggle("is-dragging", on);
    excessCanvas?.classList.toggle("is-dragging", on);
    specCanvas?.classList.toggle("is-dragging", on);
    fineSpecCanvas?.classList.toggle("is-dragging", on);
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
    if (!wasDragging || !moved) return;
    const now = Date.now() / 1000;
    const { t0, t1 } = state.chartRange;
    if (t1 >= now - 1.5) {
      setChartLive(true);
    } else {
      setChartLive(false);
      state.chartStart = t0;
    }
    if (isCustomRange()) syncCustomRangeInputs(t0, t1);
    refreshHistory();
  };

  const onDown = (ev, hitTest) => {
    if (ev.button != null && ev.button !== 0) return;
    if (state.specKbdNav?.active) exitSpecKbdNav({ restoreHover: false });
    const chart = state.chart;
    if (!chart?.chartArea) return;
    const el = ev.currentTarget;
    if (hitTest === "chartArea") {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const { left, right, top, bottom } = chart.chartArea;
      if (x < left || x > right || y < top || y > bottom) return;
    } else if (hitTest === "spec") {
      if (!chartSpecEnabled()) return;
      if ($("chartSpecStrip")?.hidden && $("chartFineSpecStrip")?.hidden) return;
    }

    pointerId = ev.pointerId;
    activeEl = el;
    startX = ev.clientX;
    originT0 = state.chartRange.t0;
    originT1 = state.chartRange.t1;
    moved = false;
    state.chartPanning = true;
    setDraggingClass(true);
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
    const hours = currentRangeHours();
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

  if (excessCanvas) {
    excessCanvas.addEventListener("pointerdown", (ev) => onDown(ev, "full"));
    excessCanvas.addEventListener("pointermove", onMove);
    excessCanvas.addEventListener("pointerup", endPan);
    excessCanvas.addEventListener("pointercancel", endPan);
  }

  if (specCanvas) {
    specCanvas.addEventListener("pointerdown", (ev) => onDown(ev, "spec"));
    specCanvas.addEventListener("pointermove", onMove);
    specCanvas.addEventListener("pointerup", endPan);
    specCanvas.addEventListener("pointercancel", endPan);
  }

  if (fineSpecCanvas) {
    fineSpecCanvas.addEventListener("pointerdown", (ev) => onDown(ev, "spec"));
    fineSpecCanvas.addEventListener("pointermove", onMove);
    fineSpecCanvas.addEventListener("pointerup", endPan);
    fineSpecCanvas.addEventListener("pointercancel", endPan);
  }
}

function bindChartCrosshair() {
  const stack = $("chartStack");
  if (!stack) return;

  stack.addEventListener("mousemove", (ev) => {
    if (state.chartPanning) return;

    if (state.specKbdNav?.active) {
      const nav = state.specKbdNav;
      const dx = ev.clientX - nav.anchorMouseX;
      const dy = ev.clientY - nav.anchorMouseY;
      if (Math.hypot(dx, dy) <= SPEC_KBD_MOUSE_EXIT_PX) return;
      exitSpecKbdNav({ restoreHover: false });
      // pokračovat běžným hoverem podle aktuální myši
    }

    const plot = chartPlotHitAt(ev.clientX, ev.clientY);
    const specHit = spectrogramHitAt(ev.clientX, ev.clientY);
    if (specHit) {
      state.specPointerLast = {
        clientX: ev.clientX,
        clientY: ev.clientY,
        target: specHit.target,
      };
      if (!state.specKbdNav?.active) {
        showSpecPointerHover(ev.clientX, ev.clientY);
      }
    } else {
      state.specPointerLast = null;
      if (!state.specKbdNav?.active) hideSpecPointerEl();
    }

    // Kříž vždy nad plochami grafů (canvas, Y stupnice, dB sloupce) i nad časovou osou
    const onSurface =
      !!plot ||
      !!ev.target.closest?.(
        "#chart, #chartExcess, #chartSpectrogram, #chartFineSpectrogram, .chart-excess-body, .chart-spec-body, .chart-fine-spec-body, .chart-excess-y, .chart-spec-y, .chart-spec-canvas-wrap, .chart-axis-labels"
      );
    if (!onSurface) {
      hideChartCrosshair();
      return;
    }
    const ts = timeFromChartClientXClamped(ev.clientX);
    if (ts == null) {
      hideChartCrosshair();
      return;
    }

    if (plot?.id === "fine") {
      state.fineSpecFocusBand = fineSpecBandAtClientY(plot.clientY);
    } else if (state.fineSpecFocusBand != null) {
      state.fineSpecFocusBand = null;
    }

    showChartCrosshair(ts);
    if (plot) showChartHCrosshair(plot.plotRect, plot.clientY);
    else hideChartHCrosshair();
  });
  stack.addEventListener("mouseleave", () => {
    state.specPointerLast = null;
    if (!state.specKbdNav?.active) hideSpecPointerEl();
    hideChartCrosshair();
  });
}

function applyCustomRangeFromInputs() {
  const custom = readCustomRange();
  if (!custom) return;
  const now = Date.now() / 1000;
  let { t0, t1 } = custom;
  if (t1 > now) t1 = now;
  if (t1 - t0 < CUSTOM_RANGE_MIN_S) t0 = t1 - CUSTOM_RANGE_MIN_S;
  if (t1 - t0 > CUSTOM_RANGE_MAX_S) t0 = t1 - CUSTOM_RANGE_MAX_S;
  const earliest = now - CHART_MAX_LOOKBACK_S;
  if (t0 < earliest) {
    t0 = earliest;
    t1 = Math.min(Math.max(t1, t0 + CUSTOM_RANGE_MIN_S), now);
  }
  syncCustomRangeInputs(t0, t1);
  // date/time inputy mají minutovou přesnost — tolerance ~2 min od „teď“
  if (t1 >= now - 120) {
    setChartLive(true);
  } else {
    setChartLive(false);
    state.chartStart = t0;
  }
  const hours = Math.max(CUSTOM_RANGE_MIN_S / 3600, (t1 - t0) / 3600);
  applyHistoryTimeRange(t0, t1, hours);
  syncDisplayToggleUi();
  refreshHistory();
}

function bind() {
  $("rangeSelect").addEventListener("change", () => {
    closeAircraftPopup();
    state.aircraftOverflights = [];
    state.weatherTimeline = [];
    if (isCustomRange()) {
      seedCustomRangeDefaults();
      setCustomRangeVisible(true);
      setChartLive(true);
    } else {
      setCustomRangeVisible(false);
      // Při změně délky okna zachovat konec (živě / aktuální t1).
      if (!state.chartLive && state.chartRange.t1 > 0) {
        const hours = currentRangeHours();
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
    }
    const { t0, t1, hours } = selectedHistoryRange();
    applyHistoryTimeRange(t0, t1, hours);
    syncDisplayToggleUi();
    refreshHistory();
  });
  $("rangeFromDate")?.addEventListener("change", applyCustomRangeFromInputs);
  $("rangeFromTime")?.addEventListener("change", applyCustomRangeFromInputs);
  $("rangeToDate")?.addEventListener("change", applyCustomRangeFromInputs);
  $("rangeToTime")?.addEventListener("change", applyCustomRangeFromInputs);
  for (const id of ["rangeFromDate", "rangeFromTime", "rangeToDate", "rangeToTime"]) {
    $(id)?.addEventListener("click", (ev) => {
      const el = ev.currentTarget;
      if (typeof el.showPicker === "function") {
        try {
          el.showPicker();
        } catch (_) {
          /* ignore — prohlížeč může vyžadovat přímý user gesture na ikoně */
        }
      }
    });
  }
  $("metricSelect").addEventListener("change", refreshHistory);
  $("chartLiveBtn")?.addEventListener("click", () => {
    setChartLive(true);
    const { t0, t1, hours } = selectedHistoryRange();
    if (isCustomRange()) syncCustomRangeInputs(t0, t1);
    applyHistoryTimeRange(t0, t1, hours);
    refreshHistory();
  });

  bindDisplayToggles();
  bindChartSpecKbdInfo();
  bindSettingsPanel();

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
    if (item) {
      hideChartHCrosshair();
      showChartCrosshair(item.t);
    }
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
    drawChartFineSpectrogram();
    drawChartExcess();
    renderChartAxisLabels();
    layoutChartSpecStrip();
    renderAircraftTimeline();
    renderWeatherTimeline();
    closeAircraftPopup();
    hideChartCrosshair();
  });

  bindChartPan();
  bindChartCrosshair();
  bindSpecKeyboardNav();
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

function isSettingsOpen() {
  const panel = $("settingsPanel");
  return !!(panel && !panel.hidden);
}

function setSettingsOpen(open) {
  const panel = $("settingsPanel");
  const backdrop = $("settingsBackdrop");
  const fab = $("settingsFab");
  if (!panel || !fab) return;
  const next = !!open;
  panel.hidden = !next;
  if (backdrop) backdrop.hidden = !next;
  fab.setAttribute("aria-expanded", next ? "true" : "false");
  fab.classList.toggle("is-open", next);
  if (!next) {
    document.querySelectorAll(".display-toggle.is-tip-open").forEach((w) => {
      w.classList.remove("is-tip-open");
    });
  }
}

function bindSettingsPanel() {
  const fab = $("settingsFab");
  const closeBtn = $("settingsClose");
  const backdrop = $("settingsBackdrop");
  if (!fab) return;

  fab.addEventListener("click", () => {
    setSettingsOpen(!isSettingsOpen());
  });
  closeBtn?.addEventListener("click", () => setSettingsOpen(false));
  backdrop?.addEventListener("click", () => setSettingsOpen(false));

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !isSettingsOpen()) return;
    setSettingsOpen(false);
    fab.focus();
  });
}

/** Info „i“ u fine spektrogramu — jen tip, ne přepínač. */
function bindChartSpecKbdInfo() {
  const wrap = $("chartSpecKbdInfo");
  const btn = $("chartSpecKbdInfoBtn");
  if (!wrap || !btn) return;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    wrap.classList.toggle("is-open");
  });
  document.addEventListener("click", (ev) => {
    if (!wrap.classList.contains("is-open")) return;
    if (wrap.contains(ev.target)) return;
    wrap.classList.remove("is-open");
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") wrap.classList.remove("is-open");
  });
}

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
