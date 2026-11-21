// Public trade binder: lists trades.json, lets a visitor pick cards and copy a
// message with their name and picks. Nothing is sent anywhere by this page.

const BUILD = document.querySelector('meta[name="build"]').content;
const PAGE = 120;
const KEY = "trade-picks";
const FINISH = { nonfoil: "", foil: "Foil", etched: "Etched" };
const COND = {
  mint: "M", near_mint: "NM", excellent: "EX", good: "GD", light_played: "LP", lightly_played: "LP",
  played: "PL", poor: "PO", moderately_played: "MP", heavily_played: "HP", damaged: "DMG",
};

let cards = [];
let byId = new Map();
let picks = {};
let shown = 0;
let priceDate = "";

const $ = (id) => document.getElementById(id);
const gbp = (n) => (n == null ? "—" : n.toLocaleString("en-GB", { style: "currency", currency: "GBP" }));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: picks last this visit */ }
}

function label(c) {
  const bits = [`${c.set} ${c.number}`];
  if (FINISH[c.finish]) bits.push(FINISH[c.finish]);
  if (c.condition && c.condition !== "near_mint") bits.push(COND[c.condition] || c.condition.replace(/_/g, " "));
  if (c.language && c.language !== "en") bits.push(c.language.toUpperCase());
  return bits.join(" · ");
}

function filtered() {
  const words = $("q").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = cards.filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
  const sort = $("sort").value;
  const price = (c) => c.cardmarket ?? c.tcgplayer ?? -1;
  if (sort === "cm") list = [...list].sort((a, b) => price(b) - price(a));
  if (sort === "cm_asc") list = [...list].sort((a, b) => (price(a) < 0) - (price(b) < 0) || price(a) - price(b));
  if (sort === "picked") list = [...list].sort((a, b) => (picks[b.id] ? 1 : 0) - (picks[a.id] ? 1 : 0));
  return list;
}

function row(c) {
  const n = picks[c.id] || 0;
  const img = c.image
    ? `<img class="card-open" src="${esc(c.image)}" alt="View ${esc(c.name)}" loading="lazy" decoding="async">`
    : `<div class="noimg"></div>`;
  return `<li><div class="trade-row${n ? " picked" : ""}" data-id="${esc(c.id)}">
    ${img}
    <div class="trade-main">
      <div class="row-title"><span class="name card-open" role="button" tabindex="0">${esc(c.name)}</span>${FINISH[c.finish] ? `<span class="badge badge-${c.finish}">${FINISH[c.finish]}</span>` : ""}</div>
      <div class="row-sub"><span>${esc(label(c))}</span><span class="dot">·</span><span>${c.qty} available</span></div>
    </div>
    <div class="trade-prices"><strong>${gbp(c.cardmarket)}</strong><br>TCG ${gbp(c.tcgplayer)}</div>
    ${stepper(c, n)}
  </div></li>`;
}

function stepper(c, n) {
  return `<div class="pick">
      <button type="button" data-step="-1" aria-label="One fewer ${esc(c.name)}" ${n ? "" : "disabled"}>−</button>
      <span class="count" aria-live="polite">${n}</span>
      <button type="button" data-step="1" aria-label="One more ${esc(c.name)}" ${n >= c.qty ? "disabled" : ""}>+</button>
    </div>`;
}

// ---------- card viewer: opens over the list, so closing it leaves you where you were ----------

let viewing = null;

function openViewer(c) {
  viewing = c;
  $("viewer-name").textContent = c.name;
  const img = $("viewer-img");
  img.src = c.imageLarge || c.image || "";
  img.alt = c.name;
  img.hidden = !img.src;
  $("viewer-facts").textContent = `${c.setName} · ${label(c)} · ${c.qty} available`;
  $("viewer-prices").innerHTML = `<strong>${gbp(c.cardmarket)}</strong> Cardmarket<br>${gbp(c.tcgplayer)} TCGplayer`;
  $("viewer-pick").outerHTML = stepper(c, picks[c.id] || 0).replace('<div class="pick">', '<div class="pick" id="viewer-pick">');
  const dialog = $("viewer");
  if (!dialog.open) dialog.showModal();
}

function setPick(c, n) {
  n = Math.max(0, Math.min(c.qty, n));
  if (n) picks[c.id] = n; else delete picks[c.id];
  save(KEY, picks);
  const rowEl = document.querySelector(`.trade-row[data-id="${CSS.escape(c.id)}"]`);
  if (rowEl) rowEl.outerHTML = row(c).replace(/^<li>|<\/li>$/g, "");
  if (viewing === c && $("viewer").open) openViewer(c);
  updateTray();
}

function render(append = false) {
  const list = filtered();
  if (!append) { shown = 0; $("list").innerHTML = ""; }
  const next = list.slice(shown, shown + PAGE);
  shown += next.length;
  $("list").insertAdjacentHTML("beforeend", next.map(row).join(""));
  if (!list.length) $("list").innerHTML = `<li class="empty">No cards match.</li>`;
  $("more").hidden = shown >= list.length;
  const copies = list.reduce((n, c) => n + c.qty, 0);
  const when = priceDate ? ` · prices from ${new Date(priceDate + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}` : "";
  $("summary").textContent = `${list.length.toLocaleString("en-GB")} cards (${copies.toLocaleString("en-GB")} copies)${when}`;
}

function totals() {
  let count = 0, cm = 0, tcg = 0;
  for (const [id, n] of Object.entries(picks)) {
    const c = byId.get(id);
    if (!c) continue;
    count += n;
    cm += n * (c.cardmarket ?? 0);
    tcg += n * (c.tcgplayer ?? 0);
  }
  return { count, cm, tcg };
}

function updateTray() {
  const t = totals();
  $("tray-summary").textContent = t.count
    ? `${t.count} card${t.count === 1 ? "" : "s"} picked · ${gbp(t.cm)} Cardmarket · ${gbp(t.tcg)} TCGplayer`
    : "Nothing picked yet.";
  $("copy").disabled = !t.count;
  $("clear").hidden = !t.count;
}

function message() {
  const who = $("who").value.trim() || "Someone";
  const lines = Object.entries(picks)
    .map(([id, n]) => [byId.get(id), n])
    .filter(([c]) => c)
    .sort(([a], [b]) => a.name.localeCompare(b.name))
    .map(([c, n]) => `• ${n}× ${c.name} (${label(c)}) – CM ${gbp(c.cardmarket)} / TCG ${gbp(c.tcgplayer)}`);
  const t = totals();
  return [
    `Hi! ${who} here. From your trade binder I'd like:`,
    ...lines,
    `Total: ${t.count} card${t.count === 1 ? "" : "s"} · CM ${gbp(t.cm)} · TCG ${gbp(t.tcg)}`,
  ].join("\n");
}

async function copy() {
  const text = message();
  const area = $("fallback");
  try {
    await navigator.clipboard.writeText(text);
    area.hidden = true;
    $("tray-summary").innerHTML = `<span class="copied">Copied!</span> Paste it into a message to me.`;
  } catch {
    // Some browsers block the clipboard: show the text to copy by hand.
    area.value = text;
    area.hidden = false;
    area.focus();
    area.select();
    $("tray-summary").textContent = "Select the text below and copy it.";
  }
}

$("list").addEventListener("click", (e) => {
  const rowEl = e.target.closest(".trade-row");
  if (!rowEl) return;
  const c = byId.get(rowEl.dataset.id);
  const btn = e.target.closest("button[data-step]");
  if (btn) setPick(c, (picks[c.id] || 0) + Number(btn.dataset.step));
  else if (e.target.closest(".card-open")) openViewer(c);
});
$("list").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".name.card-open")) {
    e.preventDefault();
    openViewer(byId.get(e.target.closest(".trade-row").dataset.id));
  }
});
$("viewer").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-step]");
  if (btn && viewing) setPick(viewing, (picks[viewing.id] || 0) + Number(btn.dataset.step));
  else if (e.target === $("viewer")) $("viewer").close();  // tap outside the card
});
$("viewer-close").addEventListener("click", () => $("viewer").close());
// The visitor's place (search, sort, rows loaded, scroll) is kept for this browser tab, so a
// reload, or coming back after opening something else, returns to the same spot.
const PLACE = "trade-place";
function savePlace() {
  try {
    sessionStorage.setItem(PLACE, JSON.stringify({ q: $("q").value, sort: $("sort").value, shown, y: window.scrollY }));
  } catch { /* storage unavailable: nothing to restore */ }
}
function restorePlace() {
  let place = null;
  try { place = JSON.parse(sessionStorage.getItem(PLACE)); } catch { /* none */ }
  if (!place) return render();
  $("q").value = place.q || "";
  $("sort").value = place.sort || "name";
  render();
  while (shown < (place.shown || 0) && !$("more").hidden) render(true);
  window.scrollTo(0, place.y || 0);
}
let placeTimer;
window.addEventListener("scroll", () => { clearTimeout(placeTimer); placeTimer = setTimeout(savePlace, 150); }, { passive: true });
window.addEventListener("pagehide", savePlace);

let timer;
$("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => render(), 150); });
$("sort").addEventListener("change", () => render());
$("more").addEventListener("click", () => render(true));
$("copy").addEventListener("click", copy);
$("clear").addEventListener("click", () => { picks = {}; save(KEY, picks); render(); updateTray(); $("fallback").hidden = true; });
$("who").value = load("trade-name", "");
$("who").addEventListener("change", () => save("trade-name", $("who").value.trim()));

fetch(`trades.json?v=${BUILD}`, { cache: "no-cache" })
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((data) => {
    cards = data.cards;
    byId = new Map(cards.map((c) => [c.id, c]));
    picks = Object.fromEntries(Object.entries(load(KEY, {})).filter(([id, n]) => byId.has(id) && n > 0)
      .map(([id, n]) => [id, Math.min(n, byId.get(id).qty)]));
    priceDate = data.priceDate || "";
    restorePlace();
    updateTray();
  })
  .catch(() => { $("summary").textContent = "Couldn't load the trade list. Please try again later."; });
