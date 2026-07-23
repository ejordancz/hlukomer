const $ = (id) => document.getElementById(id);

const api = (path, options = {}) =>
  fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });

function setStatus(msg, isError = false) {
  const el = $("statusMsg");
  el.hidden = !msg;
  el.textContent = msg || "";
  el.classList.toggle("is-error", !!isError);
}

function showTools(loggedIn) {
  $("loginPanel").hidden = loggedIn;
  $("toolsPanel").hidden = !loggedIn;
  if (!loggedIn) {
    $("adminPassword").value = "";
    setStatus("");
    $("restoreInput").value = "";
  }
}

async function checkSession() {
  try {
    const res = await api("/api/admin/session");
    showTools(res.ok);
  } catch {
    showTools(false);
  }
}

$("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("loginError").hidden = true;
  const password = $("adminPassword").value;
  try {
    const res = await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    // Heslo ihned vymaž z DOM/paměti formuláře
    $("adminPassword").value = "";
    if (!res.ok) {
      $("loginError").hidden = false;
      return;
    }
    showTools(true);
  } catch {
    $("loginError").hidden = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST" });
  } finally {
    showTools(false);
  }
});

$("backupBtn").addEventListener("click", async () => {
  setStatus("Připravuji zálohu…");
  try {
    // Ověření session předem — samotné stažení jde přes <a download>,
    // aby prohlížeč streamoval na disk (ne do RAM jako u res.blob()).
    const probe = await api("/api/admin/session");
    if (!probe.ok) throw new Error("Neautorizováno — přihlaste se znovu.");
    const a = document.createElement("a");
    a.href = "/api/admin/backup";
    a.download = "hlukomer.db";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("Stažení zálohy zahájeno.");
  } catch (err) {
    setStatus(err?.message || "Stažení zálohy selhalo.", true);
  }
});

$("restoreInput").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  if (!confirm(`Nahradit databázi souborem „${file.name}“?`)) {
    ev.target.value = "";
    return;
  }
  setStatus("Obnovuji databázi…");
  try {
    const res = await api("/api/admin/restore", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail || "restore failed");
    }
    setStatus("Databáze obnovena.");
  } catch (err) {
    setStatus(err?.message || "Obnovení selhalo.", true);
  } finally {
    ev.target.value = "";
  }
});

checkSession();
