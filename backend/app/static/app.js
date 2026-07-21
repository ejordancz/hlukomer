const $ = (id) => document.getElementById(id);

const state = {
  threshold: 45,
  period: "day",
  chart: null,
};

function fmtDb(v) {
  if (v == null || Number.isNaN(v)) return "—.—";
  return Number(v).toFixed(1);
}

function fmtPct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(0)} %`;
}

function setLevelClass(el, value) {
  el.classList.remove("hot", "over");
  if (value == null) return;
  if (value >= state.threshold + 5) el.classList.add("over");
  else if (value >= state.threshold) el.classList.add("hot");
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function initChart() {
  const ctx = $("chart").getContext("2d");
  state.chart = new Chart(ctx, {
    type: "line",
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
          stepped: "after",
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

async function refreshLatest() {
  try {
    const data = await fetchJson("/api/v1/latest");
    state.threshold = data.alert_threshold_dba ?? 45;
    state.period = data.alert_period ?? "day";
    const periodLabel = state.period === "night" ? "noc" : "den";
    $("mLimit").textContent = `${state.threshold.toFixed(0)} dBA (${periodLabel})`;

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
    }

    $("mLaeq").textContent = fmtDb(data.metrics?.laeq_1min?.value);
    $("mLamax").textContent = fmtDb(data.metrics?.lamax_1min?.value);
    $("mLamin").textContent = fmtDb(data.metrics?.lamin_1min?.value);
  } catch (err) {
    $("onlineDot").className = "dot off";
    $("onlineLabel").textContent = "API nedostupné";
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
  $("rangeSelect").addEventListener("change", refreshHistory);
  $("metricSelect").addEventListener("change", refreshHistory);
}

initChart();
bind();
refreshLatest();
refreshHistory();
setInterval(refreshLatest, 2000);
setInterval(refreshHistory, 15000);
