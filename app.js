// MTG Collection: decrypts data.enc in the browser and queries it with sql.js.
// The file format is documented in mtg/publish.py.

const MAGIC = new TextEncoder().encode("MTG1");
const STORE_KEY = "mtg-passphrase";
const PAGE_SIZE = 100;
const COLOURS = ["W", "U", "B", "R", "G"];
const COLOUR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colourless", M: "Multicolour" };
const FINISH_LABELS = { nonfoil: "Non-foil", foil: "Foil", etched: "Etched" };
const TYPE_LABELS = { binder: "Binders", deck: "Decks", list: "Lists" };
const BUILD = document.querySelector('meta[name="build"]').content;

let db = null;
let META = {};

// ---------- storage (may be unavailable, e.g. private browsing) ----------

function storeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not persisted */ }
}
function storeDel(key) {
  try { localStorage.removeItem(key); } catch { /* nothing stored */ }
}

// ---------- decrypt + open ----------

async function fetchEncrypted() {
  const resp = await fetch(`data.enc?v=${BUILD}`, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`Couldn't download the collection (HTTP ${resp.status}).`);
  return resp.arrayBuffer();
}

// The key derived at unlock; history files share data.enc's salt, so it's reused.
let KEY = null;

async function decrypt(buf, passphrase) {
  const bytes = new Uint8Array(buf);
  if (!MAGIC.every((b, i) => bytes[i] === b)) throw new Error("The collection file is damaged.");
  const salt = bytes.slice(4, 20);
  const iv = bytes.slice(20, 32);
  const iterations = new DataView(buf).getUint32(32);
  const saltHex = [...salt].map((b) => b.toString(16).padStart(2, "0")).join("");
  let key = KEY && KEY.salt === saltHex ? KEY.key : null;
  if (!key) {
    if (passphrase == null) throw new Error("This page is out of date; reload it to see the latest prices.");
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
  }
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: MAGIC }, key, bytes.slice(36));
  } catch {
    throw new WrongPassphrase();
  }
  KEY = { salt: saltHex, key };
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- price history (one encrypted file per group of cards) ----------

const historyCache = new Map();

function loadHistory(scryfallId) {
  const shard = scryfallId.slice(0, 2).toLowerCase();
  if (!historyCache.has(shard)) {
    const promise = fetch(`history/${shard}.enc?v=${BUILD}`, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`Couldn't download price history (HTTP ${r.status}).`);
        return r.arrayBuffer();
      })
      .then((buf) => decrypt(buf, null))
      .then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
    promise.catch(() => historyCache.delete(shard));
    historyCache.set(shard, promise);
  }
  return historyCache.get(shard).then((h) => ({ days: h.days, series: h.cards[scryfallId] || {} }));
}

class WrongPassphrase extends Error {
  constructor() { super("That passphrase didn't work."); }
}

async function openDatabase(passphrase) {
  const [buf, SQL] = await Promise.all([
    fetchEncrypted(),
    initSqlJs({ locateFile: (f) => `vendor/${f}` }),
  ]);
  return new SQL.Database(await decrypt(buf, passphrase));
}

// ---------- query helpers ----------

function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function one(sql, params = {}) {
  return all(sql, params)[0];
}

// ---------- formatting ----------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => Number(n || 0).toLocaleString("en-GB");
const gbp = (n) => (n == null ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP" }));
const date = (s) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const titleCase = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function pips(colours) {
  if (!colours) return `<span class="pip pip-C" title="Colourless"></span>`;
  return [...colours].map((c) => `<span class="pip pip-${c}" title="${COLOUR_NAMES[c]}"></span>`).join("");
}

function finishBadge(finish) {
  return finish === "nonfoil" ? "" : `<span class="badge badge-${finish}">${FINISH_LABELS[finish]}</span>`;
}

function proxyBadge(h) {
  return h.proxy ? `<span class="badge badge-removed">Proxy</span>` : "";
}

// ---------- prices ----------

// Copies flagged as proxies in ManaBox get no price, so they never count towards values.
const PRICE_JOIN = "LEFT JOIN prices p ON p.scryfall_id = h.scryfall_id AND p.finish = h.finish AND h.proxy = 0";
const PRICED_FROM = `FROM holdings h LEFT JOIN cards c ON c.scryfall_id = h.scryfall_id ${PRICE_JOIN}`;
// The change shown in lists: our own 7-day change once a week of daily
// snapshots exists, otherwise Cardmarket's 7-day vs 30-day sale average.
const CHANGE_SQL = "COALESCE(p.change_7d_pct, p.momentum_pct)";

const eurToGbp = (eur) => (eur == null || !META.eur_gbp ? null : eur * Number(META.eur_gbp));
const usdToGbp = (usd) => (usd == null || !META.eur_gbp ? null : (usd / Number(META.eur_usd)) * Number(META.eur_gbp));
const eur = (n) => (n == null ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "EUR" }));
const usd = (n) => (n == null ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "USD" }));

function delta(pct, suffix = "") {
  if (pct == null) return "";
  const rounded = Math.abs(pct) < 0.05 ? 0 : pct;
  const dir = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const arrow = { up: "▲", down: "▼", flat: "■" }[dir];
  const text = `${rounded > 0 ? "+" : ""}${rounded.toFixed(Math.abs(rounded) >= 10 ? 0 : 1)}%`;
  return `<span class="delta ${dir}">${arrow} ${text}${suffix ? `<span class="delta-label"> ${suffix}</span>` : ""}</span>`;
}

function rowChange(h) {
  // Flagged prices still show (and sort by) their change, with a marker to check them.
  const warn = h.price_warning ? `<span class="warn" title="${esc(h.price_warning)}">⚠</span> ` : "";
  if (h.change_7d_pct != null) return warn + delta(h.change_7d_pct, "7d");
  return warn + delta(h.momentum_pct, "vs 30d avg");
}

function locationLink(type, name) {
  const params = new URLSearchParams({ loc: `${type}|${name}` });
  return `<a href="#/collection?${params}">${esc(name)}</a>`;
}

// ---------- routing ----------

function parseHash() {
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(query || "") };
}

function setParams(params) {
  const q = params.toString();
  history.replaceState(null, "", `#/collection${q ? "?" + q : ""}`);
}

function render() {
  if (!db) return;
  const { parts, params } = parseHash();
  const view = parts[0] || "dashboard";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === view));
  const app = document.getElementById("app");
  charts.length = 0;
  if (view === "card" && parts[1]) {
    app.innerHTML = cardView(decodeURIComponent(parts[1]));
    hydrateHistory();
  } else if (view === "dashboard") {
    app.innerHTML = dashboardView(params);
    hydrateDashboard(params);
  } else if (view === "locations") app.innerHTML = locationsView();
  else if (view === "imports") app.innerHTML = importsView();
  else {
    app.innerHTML = collectionShell(params);
    bindCollection();
    runSearch(params, false);
  }
  window.scrollTo(0, 0);
}

// ---------- collection ----------

function collectionShell(params) {
  const sets = all(
    `SELECT set_code, MAX(set_name) AS set_name FROM holdings WHERE status = 'active'
     GROUP BY set_code ORDER BY set_name`,
  );
  const locs = all(`SELECT location_type, location FROM locations ORDER BY location_type, location COLLATE NOCASE`);
  const byType = {};
  for (const l of locs) (byType[l.location_type] ||= []).push(l.location);
  const sel = (name, value) => (params.get(name) === value ? " selected" : "");
  const chosen = new Set((params.get("c") || "").split(""));

  return `
  <section class="filters" id="filters">
    <input type="search" id="f-q" placeholder="Search card name" value="${esc(params.get("q") || "")}" autocomplete="off" autocorrect="off" spellcheck="false">
    <div class="filter-grid">
      <label>Location
        <select id="f-loc"><option value="">All locations</option>
          ${Object.entries(byType)
            .map(
              ([type, names]) =>
                `<optgroup label="${esc(TYPE_LABELS[type] || titleCase(type))}">${names
                  .map((n) => `<option value="${esc(type + "|" + n)}"${sel("loc", type + "|" + n)}>${esc(n)}</option>`)
                  .join("")}</optgroup>`,
            )
            .join("")}
        </select>
      </label>
      <label>Set
        <select id="f-set"><option value="">All sets</option>
          ${sets.map((s) => `<option value="${esc(s.set_code)}"${sel("set", s.set_code)}>${esc(s.set_name)} (${esc(s.set_code)})</option>`).join("")}
        </select>
      </label>
      <label>Finish
        <select id="f-finish"><option value="">Any finish</option>
          ${Object.entries(FINISH_LABELS).map(([k, v]) => `<option value="${k}"${sel("finish", k)}>${v}</option>`).join("")}
        </select>
      </label>
      <label>Rarity
        <select id="f-rarity"><option value="">Any rarity</option>
          ${["common", "uncommon", "rare", "mythic", "special"].map((r) => `<option value="${r}"${sel("rarity", r)}>${titleCase(r)}</option>`).join("")}
        </select>
      </label>
      <label>Value
        <select id="f-min"><option value="">Any value</option>
          ${[0.5, 1, 5, 10, 25, 50, 100].map((v) => `<option value="${v}"${sel("min", String(v))}>${gbp(v)}+</option>`).join("")}
        </select>
      </label>
      <label>Sort
        <select id="f-sort">
          <option value="name"${sel("sort", "name")}>Name</option>
          <option value="value"${sel("sort", "value")}>Highest value</option>
          <option value="value_asc"${sel("sort", "value_asc")}>Lowest value</option>
          <option value="rising"${sel("sort", "rising")}>Price change: biggest rise</option>
          <option value="falling"${sel("sort", "falling")}>Price change: biggest fall</option>
          <option value="set"${sel("sort", "set")}>Set</option>
          <option value="qty"${sel("sort", "qty")}>Quantity</option>
          <option value="added"${sel("sort", "added")}>Recently added</option>
        </select>
      </label>
    </div>
    <div class="colour-row">
      <div class="chips" role="group" aria-label="Colours">
        ${[...COLOURS, "C", "M"]
          .map(
            (c) => `<button type="button" class="chip${chosen.has(c) ? " on" : ""}" data-colour="${c}" aria-pressed="${chosen.has(c)}" title="${COLOUR_NAMES[c]}">
              ${c === "M" ? `<span class="pip pip-M"></span>` : `<span class="pip pip-${c}"></span>`}<span class="chip-label">${COLOUR_NAMES[c]}</span></button>`,
          )
          .join("")}
      </div>
      <label class="inline">Match
        <select id="f-cmode">
          <option value="colors"${sel("cmode", "colors")}>Card colour</option>
          <option value="identity"${sel("cmode", "identity")}>Colour identity</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" id="f-removed"${params.get("removed") ? " checked" : ""}> Include removed</label>
      <button type="button" class="link-btn" id="f-clear">Clear filters</button>
    </div>
  </section>
  <p class="summary" id="summary"></p>
  <ul class="results" id="results"></ul>
  <div class="more"><button type="button" id="more" hidden>Show more</button></div>`;
}

function readFilters() {
  const p = new URLSearchParams();
  const val = (id) => document.getElementById(id).value.trim();
  const q = val("f-q");
  if (q) p.set("q", q);
  for (const [id, key] of [["f-loc", "loc"], ["f-set", "set"], ["f-finish", "finish"], ["f-rarity", "rarity"], ["f-min", "min"]]) {
    if (val(id)) p.set(key, val(id));
  }
  if (val("f-sort") !== "name") p.set("sort", val("f-sort"));
  const colours = [...document.querySelectorAll(".chip.on")].map((b) => b.dataset.colour).join("");
  if (colours) p.set("c", colours);
  if (val("f-cmode") !== "colors") p.set("cmode", val("f-cmode"));
  if (document.getElementById("f-removed").checked) p.set("removed", "1");
  return p;
}

let searchTimer = null;
function bindCollection() {
  const update = () => {
    const p = readFilters();
    setParams(p);
    runSearch(p, false);
  };
  document.getElementById("f-q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(update, 150);
  });
  document.querySelectorAll("#filters select, #f-removed").forEach((el) => el.addEventListener("change", update));
  document.querySelectorAll(".chip").forEach((b) =>
    b.addEventListener("click", () => {
      const on = !b.classList.contains("on");
      // Colourless can't combine with colours; multicolour can.
      if (on && b.dataset.colour === "C") document.querySelectorAll(".chip.on").forEach((x) => x.classList.remove("on"));
      if (on && b.dataset.colour !== "C") document.querySelector('.chip[data-colour="C"]').classList.remove("on");
      b.classList.toggle("on", on);
      document.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", x.classList.contains("on")));
      update();
    }),
  );
  document.getElementById("f-clear").addEventListener("click", () => {
    history.replaceState(null, "", "#/collection");
    render();
  });
  document.getElementById("more").addEventListener("click", () => runSearch(readFilters(), true));
}

function buildWhere(params) {
  const where = [];
  const bind = {};
  if (!params.get("removed")) where.push("h.status = 'active'");
  const q = params.get("q");
  if (q) {
    q.split(/\s+/).forEach((word, i) => {
      where.push(`h.name LIKE $q${i}`);
      bind[`$q${i}`] = `%${word}%`;
    });
  }
  const loc = params.get("loc");
  if (loc) {
    const i = loc.indexOf("|");
    where.push("h.location_type = $ltype AND h.location = $lname");
    bind.$ltype = loc.slice(0, i);
    bind.$lname = loc.slice(i + 1);
  }
  for (const [key, col] of [["set", "h.set_code"], ["finish", "h.finish"], ["rarity", "h.rarity"]]) {
    if (params.get(key)) {
      where.push(`${col} = $${key}`);
      bind[`$${key}`] = params.get(key);
    }
  }
  const min = Number(params.get("min"));
  if (min > 0) {
    where.push("p.value_gbp >= $min");
    bind.$min = min;
  }
  const sort = params.get("sort");
  if (sort === "rising" || sort === "falling") {
    where.push(`p.value_gbp >= 1 AND ${CHANGE_SQL} IS NOT NULL`);
  }
  const colours = (params.get("c") || "").replace(/[^WUBRGCM]/g, "");
  const col = params.get("cmode") === "identity" ? "c.color_identity" : "c.colors";
  if (colours.includes("C")) where.push(`${col} = ''`);
  for (const c of colours.replace(/[CM]/g, "")) where.push(`instr(${col}, '${c}') > 0`);
  if (colours.includes("M")) where.push(`length(${col}) >= 2`);
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", bind };
}

const SORTS = {
  name: "h.name COLLATE NOCASE, h.set_code, h.collector_number",
  value: "p.value_gbp IS NULL, p.value_gbp DESC, h.name COLLATE NOCASE",
  value_asc: "p.value_gbp IS NULL, p.value_gbp ASC, h.name COLLATE NOCASE",
  rising: `${CHANGE_SQL} DESC, p.value_gbp DESC`,
  falling: `${CHANGE_SQL} ASC, p.value_gbp DESC`,
  set: "h.set_name COLLATE NOCASE, CAST(h.collector_number AS INTEGER), h.collector_number",
  qty: "h.quantity DESC, h.name COLLATE NOCASE",
  added: "h.added DESC, h.name COLLATE NOCASE",
};

let shown = 0;
function runSearch(params, append) {
  const { sql, bind } = buildWhere(params);
  const from = PRICED_FROM;
  if (!append) {
    shown = 0;
    const t = one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(h.quantity), 0) AS copies, COUNT(DISTINCT h.scryfall_id) AS printings,
              SUM(h.quantity * p.value_gbp) AS value ${from} ${sql}`,
      bind,
    );
    document.getElementById("summary").innerHTML =
      `<strong>${gbp(t.value)}</strong> · ${num(t.copies)} ${t.copies === 1 ? "copy" : "copies"} · ${num(t.printings)} printings · ${num(t.n)} entries` +
      (META.price_date ? `<span class="muted"> · prices ${date(META.price_date)}</span>` : "") +
      (["rising", "falling"].includes(params.get("sort"))
        ? `<br><span class="muted small">Sorted by the 7-day change in Cardmarket's trend price (or the 7-day vs 30-day sale average where there's no history). Cards under £1 are left out, as tiny prices swing wildly. ⚠ marks a trend price that contradicts the current listings: check it before relying on it.</span>`
        : "");
    document.getElementById("results").innerHTML = "";
    document.getElementById("summary").dataset.total = t.n;
  }
  const rows = all(
    `SELECT h.*, c.colors, c.type_line, c.image_small, p.value_gbp, p.momentum_pct, p.change_7d_pct, p.price_warning ${from} ${sql}
     ORDER BY ${SORTS[params.get("sort")] || SORTS.name} LIMIT ${PAGE_SIZE} OFFSET ${shown}`,
    bind,
  );
  shown += rows.length;
  document.getElementById("results").insertAdjacentHTML("beforeend", rows.map(resultRow).join(""));
  const total = Number(document.getElementById("summary").dataset.total);
  document.getElementById("more").hidden = shown >= total;
  if (!append && total === 0) {
    document.getElementById("results").innerHTML = `<li class="empty">No cards match these filters.</li>`;
  }
}

function resultRow(h) {
  const img = h.image_small
    ? `<img src="${esc(h.image_small)}" alt="" loading="lazy" decoding="async">`
    : `<div class="noimg"></div>`;
  return `<li class="${h.status === "removed" ? "removed" : ""}">
    <a href="#/card/${encodeURIComponent(h.scryfall_id)}" class="row">
      ${img}
      <div class="row-main">
        <div class="row-title"><span class="name">${esc(h.name)}</span>${finishBadge(h.finish)}${proxyBadge(h)}${h.status === "removed" ? `<span class="badge badge-removed">Removed</span>` : ""}</div>
        <div class="row-sub">${pips(h.colors)}<span>${esc(h.set_code)} #${esc(h.collector_number)}</span><span class="dot">·</span><span>${esc(h.location)}</span></div>
      </div>
      <div class="qty">×${h.quantity}</div>
      <div class="price">
        <div class="price-value">${h.value_gbp == null ? `<span class="muted">—</span>` : gbp(h.value_gbp)}</div>
        <div class="price-change">${h.value_gbp == null ? "" : rowChange(h)}</div>
      </div>
    </a></li>`;
}

// ---------- card ----------

function cardView(id) {
  const c = one(`SELECT * FROM cards WHERE scryfall_id = $id`, { $id: id });
  const copies = all(
    `SELECT h.*, p.value_gbp FROM holdings h ${PRICE_JOIN}
     WHERE h.scryfall_id = $id
     ORDER BY h.status, h.location_type, h.location, h.finish`,
    { $id: id },
  );
  const markets = all(
    `SELECT * FROM prices WHERE scryfall_id = $id ORDER BY CASE finish WHEN 'nonfoil' THEN 0 WHEN 'foil' THEN 1 ELSE 2 END`,
    { $id: id },
  );
  if (!copies.length) return `<p class="empty">Card not found.</p>`;
  const h = copies[0];
  const active = copies.filter((x) => x.status === "active").reduce((n, x) => n + x.quantity, 0);
  const scryfallUrl = `https://scryfall.com/card/${encodeURIComponent(h.set_code.toLowerCase())}/${encodeURIComponent(h.collector_number)}`;
  return `
  <p><a href="javascript:history.back()" class="back">← Back</a></p>
  <section class="card-detail">
    <div class="card-image">${c && c.image_normal ? `<img src="${esc(c.image_normal)}" alt="${esc(h.name)}">` : `<div class="noimg big"></div>`}</div>
    <div class="card-info">
      <h1>${esc(c?.name || h.name)}</h1>
      ${c ? `<p class="type">${esc(c.type_line)} ${pips(c.colors)}</p>` : `<p class="muted">Scryfall details not loaded yet.</p>`}
      <dl class="facts">
        <dt>Set</dt><dd>${esc(h.set_name)} (${esc(h.set_code)}) #${esc(h.collector_number)}</dd>
        <dt>Rarity</dt><dd>${esc(titleCase(h.rarity))}</dd>
        ${c ? `<dt>Colour identity</dt><dd>${pips(c.color_identity)}</dd>` : ""}
        <dt>You own</dt><dd>${num(active)} ${active === 1 ? "copy" : "copies"}${ownedValue(copies)}</dd>
      </dl>
      ${researchLinks(h, scryfallUrl, c?.cardmarket_url)}
    </div>
  </section>
  ${markets.length ? markets.map((m) => marketPanel(m, markets.length > 1)).join("") : `<h2>Market price</h2><p class="muted">No market price is available for this card.</p>`}
  <h2>Your copies</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Location</th><th>Finish</th><th>Condition</th><th>Lang</th><th class="r">Qty</th><th class="r">Value</th><th class="r">Purchase price</th><th>Added</th></tr></thead>
    <tbody>${copies
      .map(
        (x) => `<tr class="${x.status === "removed" ? "removed" : ""}">
        <td>${locationLink(x.location_type, x.location)} ${proxyBadge(x)}${x.status === "removed" ? ` <span class="badge badge-removed">Removed ${date(x.removed_on)}</span>` : ""}</td>
        <td>${FINISH_LABELS[x.finish]}</td><td>${esc(titleCase(x.condition))}</td><td>${esc(x.language.toUpperCase())}</td>
        <td class="r">${x.quantity}</td><td class="r">${x.value_gbp == null ? "—" : gbp(x.quantity * x.value_gbp)}</td><td class="r">${x.purchase_currency === "GBP" || x.purchase_price == null ? gbp(x.purchase_price) : esc(`${x.purchase_price} ${x.purchase_currency}`)}</td>
        <td>${date(x.added)}</td></tr>`,
      )
      .join("")}</tbody>
  </table></div>
  <p class="muted small">Purchase prices come from ManaBox and may not be accurate.</p>`;
}

function researchLinks(h, scryfallUrl, cardmarketUrl) {
  const q = encodeURIComponent(h.name);
  const ebay = encodeURIComponent(`${h.name} ${h.set_name}`);
  const link = (href, label) => `<a href="${href}" target="_blank" rel="noopener">${label} ↗</a>`;
  return `<div class="links">
    ${link(scryfallUrl, "Scryfall")}
    ${link(cardmarketUrl || `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${q}`, "Cardmarket")}
    ${link(`https://www.ebay.co.uk/sch/i.html?_nkw=${ebay}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1`, "eBay UK sold")}
    ${link(`https://www.ebay.co.uk/sch/i.html?_nkw=${ebay}&LH_PrefLoc=1`, "eBay UK for sale")}
    ${link(`https://www.tcgplayer.com/search/magic/product?q=${q}`, "TCGplayer")}
  </div>`;
}

function salesTile(m) {
  if (m.finish === "etched" || m.tracked_days == null) {
    return `<div class="tile"><div class="tile-label">Days with sales</div><div class="tile-value muted">—</div><div class="tile-sub">No Cardmarket data</div></div>`;
  }
  const share = m.sales_days / m.tracked_days;
  const level = m.tracked_days < 7 ? "Builds up over 30 days" : share >= 0.8 ? "Sells most days" : share >= 0.4 ? "Sells regularly" : share > 0 ? "Sells occasionally" : "No recent sales";
  return `<div class="tile"><div class="tile-label">Days with sales</div>
    <div class="tile-value">${m.sales_days} <span class="tile-of">of ${m.tracked_days}</span></div>
    <div class="tile-sub">${level}</div></div>`;
}

function spreadTile(m) {
  const pct = m.cm_low != null && m.cm_avg7 ? ((m.cm_low - m.cm_avg7) / m.cm_avg7) * 100 : null;
  return `<div class="tile"><div class="tile-label">Cheapest listing vs 7-day avg</div>
    <div class="tile-value">${pct == null ? `<span class="muted">—</span>` : `${pct > 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`}</div>
    <div class="tile-sub">${pct == null ? "Not enough data" : pct < -15 ? "Listed well below recent sales" : pct > 15 ? "Listed above recent sales" : "In line with recent sales"}</div></div>`;
}

function ownedValue(copies) {
  const total = copies.filter((x) => x.status === "active" && x.value_gbp != null).reduce((n, x) => n + x.quantity * x.value_gbp, 0);
  return total ? ` · worth ${gbp(total)}` : "";
}

function changeTile(label, pct, since) {
  const body = pct == null
    ? `<div class="tile-value muted">—</div><div class="tile-sub">${since ? "No comparable price" : "Builds up from daily prices"}</div>`
    : `<div class="tile-value">${delta(pct)}</div><div class="tile-sub">since ${date(since)}</div>`;
  return `<div class="tile"><div class="tile-label">${label}</div>${body}</div>`;
}

function marketPanel(m, showFinish) {
  const rows = [
    ["Lowest listing", m.cm_low, "Cheapest copy currently for sale on Cardmarket"],
    ["Avg sale, last day", m.cm_avg1, "Average price of copies sold yesterday"],
    ["Avg sale, last 7 days", m.cm_avg7, "Average price of copies sold over the last week"],
    ["Avg sale, last 30 days", m.cm_avg30, "Average price of copies sold over the last month"],
    ["Trend price", m.cm_trend, "Cardmarket's smoothed estimate of the current market price"],
    ["Avg sell price", m.cm_avg, "Cardmarket's overall average sell price"],
  ];
  const hasCm = rows.some((r) => r[1] != null);
  return `
  <h2>Market price${showFinish ? ` · ${FINISH_LABELS[m.finish]}` : ""}</h2>
  ${m.price_warning ? `<p class="warn-box">⚠ ${esc(m.price_warning)} Check the Cardmarket listings before relying on this price.</p>` : ""}
  <div class="tiles">
    <div class="tile tile-main">
      <div class="tile-label">Value per copy</div>
      <div class="tile-value">${m.value_gbp == null ? "—" : gbp(m.value_gbp)}</div>
      <div class="tile-sub">${esc(m.value_source || "No price")}${m.value_eur != null ? ` · ${eur(m.value_eur)}` : ""}</div>
    </div>
    <div class="tile">
      <div class="tile-label">7-day vs 30-day avg</div>
      <div class="tile-value">${m.momentum_pct == null ? `<span class="muted">—</span>` : delta(m.momentum_pct)}</div>
      <div class="tile-sub">${m.momentum_pct == null ? "Not enough sales" : `${gbp(eurToGbp(m.cm_avg30))} → ${gbp(eurToGbp(m.cm_avg7))}`}</div>
    </div>
    ${changeTile("1 day", m.change_1d_pct, META.change_1d_date)}
    ${changeTile("7 days", m.change_7d_pct, META.change_7d_date)}
    ${changeTile("30 days", m.change_30d_pct, META.change_30d_date)}
    ${changeTile("90 days", m.change_90d_pct, META.change_90d_date)}
    ${salesTile(m)}
    ${spreadTile(m)}
  </div>
  <div class="table-wrap"><table class="market">
    <thead><tr><th>Cardmarket${m.finish === "foil" ? " (foil)" : ""} · sellers across Europe, UK included</th><th class="r">£ (converted)</th><th class="r">€</th></tr></thead>
    <tbody>
      ${hasCm
        ? rows.map(([label, v, hint]) => `<tr><td>${label}<div class="hint">${hint}</div></td><td class="r">${gbp(eurToGbp(v))}</td><td class="r">${eur(v)}</td></tr>`).join("")
        : `<tr><td colspan="3" class="muted">${m.finish === "etched" ? "Cardmarket lists etched cards separately; Scryfall's price is used instead." : "Cardmarket has no price data for this card."}</td></tr>`}
    </tbody>
    <thead><tr><th>Other sources</th><th class="r">£ (converted)</th><th class="r">Original</th></tr></thead>
    <tbody>
      <tr><td>Scryfall (Cardmarket price)</td><td class="r">${gbp(eurToGbp(m.sf_eur))}</td><td class="r">${eur(m.sf_eur)}</td></tr>
      <tr><td>TCGplayer market (US)<div class="hint">US market, converted from USD</div></td><td class="r">${gbp(usdToGbp(m.sf_usd))}</td><td class="r">${usd(m.sf_usd)}</td></tr>
    </tbody>
  </table></div>
  <section class="history-panel" data-sid="${esc(m.scryfall_id)}" data-finish="${esc(m.finish)}">
    <div class="panel-head">
      <h3>Price history</h3>
      <div class="seg" role="group" aria-label="Period">
        ${[["30", "30 days"], ["90", "90 days"], ["all", "All"]].map(([v, l]) => `<button type="button" data-range="${v}" aria-pressed="${v === "90"}">${l}</button>`).join("")}
      </div>
    </div>
    <div class="history-chart"><p class="muted small">Loading price history…</p></div>
  </section>
  <p class="muted small">Price changes and history use Cardmarket's trend price (TCGplayer's for cards Cardmarket doesn't cover);
    history before ${date(META.first_real_price_date || META.price_date)} comes from MTGJSON. Short-lived spikes over 10× a card's usual
    price (two weeks or less, and already over) are left out as bad data.<br>Prices from ${date(META.price_date)}${META.eur_gbp ? ` · €1 = ${gbp(Number(META.eur_gbp))} (ECB, ${date(META.ecb_date)})` : ""}.
    The £ column is the same Europe-wide price converted at the ECB rate, not a UK seller price: Cardmarket's price guide
    mixes sellers from every country, condition and language. To see UK sellers only, open the Cardmarket link above and
    filter by seller country, or use the eBay UK links. Cardmarket doesn't publish how many copies sold;
    "days with sales" counts the days that had at least one sale.</p>`;
}

function sliceDays(days, range) {
  if (range === "all" || !days.length) return 0;
  const cutoff = Date.parse(days[days.length - 1] + "T00:00:00Z") - Number(range) * 86400000;
  const start = days.findIndex((d) => Date.parse(d + "T00:00:00Z") >= cutoff);
  return Math.max(0, start);
}

function hydrateHistory() {
  const rate = Number(META.eur_gbp) || null;
  document.querySelectorAll(".history-panel").forEach((panel) => {
    const target = panel.querySelector(".history-chart");
    loadHistory(panel.dataset.sid)
      .then(({ days, series }) => {
        const s = series[panel.dataset.finish];
        if (!s || !rate) {
          target.innerHTML = `<p class="muted small">No price history for this card.</p>`;
          return;
        }
        const toGbp = (arr) => arr.map((v) => (v == null ? null : v * rate));
        const draw = (range) => {
          const start = sliceDays(days, range);
          panel.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.range === range));
          lineChart(target, {
            days: days.slice(start),
            series: [
              { name: "Trend price", slot: 1, values: toGbp(s.t).slice(start) },
              { name: "7-day avg sale", slot: 2, values: toGbp(s.a).slice(start) },
            ],
            label: "Price history",
          });
        };
        panel.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => draw(b.dataset.range)));
        draw("90");
      })
      .catch((err) => { target.innerHTML = `<p class="muted small">${esc(err.message)}</p>`; });
  });
}

// ---------- dashboard ----------

const WINDOWS = { 7: "7 days", 30: "30 days", 90: "90 days" };

function dashboardWindow(params) {
  return WINDOWS[params.get("w")] ? params.get("w") : "30";
}

function valueChange(days) {
  const rows = all(`SELECT day, value_gbp FROM value_history ORDER BY day`);
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const cutoff = new Date(Date.parse(last.day + "T00:00:00Z") - days * 86400000).toISOString().slice(0, 10);
  const base = [...rows].reverse().find((r) => r.day <= cutoff);
  if (!base || !base.value_gbp) return null;
  return { since: base.day, gbp: last.value_gbp - base.value_gbp, pct: ((last.value_gbp - base.value_gbp) / base.value_gbp) * 100 };
}

function moversSql(w, order) {
  return `SELECT h.scryfall_id, h.finish, MAX(h.name) AS name, MAX(h.set_code) AS set_code, SUM(h.quantity) AS qty,
      p.value_gbp, p.price_warning, p.change_${w}d_pct AS pct,
      SUM(h.quantity) * p.trend_eur * $rate * p.change_${w}d_pct / (100 + p.change_${w}d_pct) AS change_gbp
    FROM holdings h ${PRICE_JOIN}
    WHERE h.status = 'active' AND p.change_${w}d_pct IS NOT NULL AND p.change_${w}d_pct > -100
    GROUP BY h.scryfall_id, h.finish
    ORDER BY change_gbp ${order} LIMIT 10`;
}

function moverRow(r) {
  const sign = r.change_gbp > 0 ? "+" : r.change_gbp < 0 ? "−" : "";
  return `<li><a href="#/card/${encodeURIComponent(r.scryfall_id)}" class="mover">
    <span class="mover-name"><span class="mover-title">${esc(r.name)} ${finishBadge(r.finish)}</span><span class="mover-sub">${esc(r.set_code)}${r.qty > 1 ? ` · ×${r.qty}` : ""} · ${gbp(r.value_gbp)} each</span></span>
    <span class="mover-change"><strong>${sign}${gbp(Math.abs(r.change_gbp))}</strong><span>${r.price_warning ? `<span class="warn" title="${esc(r.price_warning)}">⚠</span> ` : ""}${delta(r.pct)}</span></span>
  </a></li>`;
}

function dashboardView(params) {
  const w = dashboardWindow(params);
  const rate = Number(META.eur_gbp) || 0;
  const totals = one(`SELECT SUM(h.quantity * p.value_gbp) AS value, SUM(h.quantity) AS copies,
      SUM(CASE WHEN p.value_gbp IS NOT NULL THEN h.quantity ELSE 0 END) AS priced
    FROM holdings h ${PRICE_JOIN} WHERE h.status = 'active' AND h.proxy = 0`);
  const cost = one(`SELECT SUM(h.quantity * h.purchase_price) AS cost, SUM(h.quantity * p.value_gbp) AS value, SUM(h.quantity) AS copies
    FROM holdings h ${PRICE_JOIN}
    WHERE h.status = 'active' AND h.proxy = 0 AND h.purchase_price IS NOT NULL AND h.purchase_currency = 'GBP' AND p.value_gbp IS NOT NULL`);
  const change = valueChange(Number(w));
  const gainers = all(moversSql(w, "DESC"), { $rate: rate }).filter((r) => r.change_gbp > 0);
  const losers = all(moversSql(w, "ASC"), { $rate: rate }).filter((r) => r.change_gbp < 0);
  const locs = all(`SELECT * FROM locations WHERE value_gbp > 0 ORDER BY value_gbp DESC`);
  const maxLoc = Math.max(...locs.map((l) => l.value_gbp), 1);
  const vsCost = cost.cost ? cost.value - cost.cost : null;
  const pnl = (n) => `${n >= 0 ? "+" : "−"}${gbp(Math.abs(n))}`;
  const purchaseRows = (order) => all(`SELECT h.scryfall_id, h.finish, MAX(h.name) AS name, MAX(h.set_code) AS set_code, SUM(h.quantity) AS qty,
      SUM(h.quantity * h.purchase_price) AS cost, SUM(h.quantity * p.value_gbp) AS value
    FROM holdings h ${PRICE_JOIN}
    WHERE h.status = 'active' AND h.proxy = 0 AND h.purchase_price IS NOT NULL AND h.purchase_currency = 'GBP' AND p.value_gbp IS NOT NULL
    GROUP BY h.scryfall_id, h.finish ORDER BY value - cost ${order} LIMIT 5`);

  return `
  <div class="dash-head">
    <h1>Dashboard</h1>
    <div class="seg" role="group" aria-label="Period">
      ${Object.entries(WINDOWS).map(([v, l]) => `<a href="#/dashboard?w=${v}" role="button" aria-pressed="${v === w}">${l}</a>`).join("")}
    </div>
  </div>

  <div class="tiles dash-tiles">
    <div class="tile tile-main">
      <div class="tile-label">Collection value</div>
      <div class="tile-value hero">${gbp(totals.value)}</div>
      <div class="tile-sub">${change ? `${delta(change.pct)} ${pnl(change.gbp)} since ${date(change.since)}` : "Change builds up from daily prices"}</div>
    </div>
    <div class="tile">
      <div class="tile-label">Copies</div>
      <div class="tile-value">${num(totals.copies)}</div>
      <div class="tile-sub">${num(totals.priced)} with a price</div>
    </div>
    <div class="tile">
      <div class="tile-label">Paid (ManaBox)</div>
      <div class="tile-value">${gbp(cost.cost)}</div>
      <div class="tile-sub">for ${num(cost.copies)} copies with a purchase price</div>
    </div>
    <div class="tile">
      <div class="tile-label">Worth now vs paid</div>
      <div class="tile-value">${vsCost == null ? "—" : pnl(vsCost)}</div>
      <div class="tile-sub">${vsCost == null ? "" : `${delta((vsCost / cost.cost) * 100)} on the same copies`}</div>
    </div>
  </div>

  <section class="card-section">
    <h2>Collection value over time</h2>
    <div id="value-chart"></div>
    <p class="muted small">Today's cards (proxies excluded) priced on Cardmarket's trend price each day, at today's exchange rate,
      so it can differ a little from the total above, which uses 7-day average sale prices. Before 7 Oct 2026 the prices come from MTGJSON.
      Short-lived spikes over 10× a card's usual price are left out.</p>
  </section>

  <div class="dash-cols">
    <section class="card-section">
      <h2>Biggest gainers · ${WINDOWS[w]}</h2>
      ${gainers.length ? `<ol class="movers">${gainers.map(moverRow).join("")}</ol>` : `<p class="muted">No rises in this period.</p>`}
    </section>
    <section class="card-section">
      <h2>Biggest losers · ${WINDOWS[w]}</h2>
      ${losers.length ? `<ol class="movers">${losers.map(moverRow).join("")}</ol>` : `<p class="muted">No falls in this period.</p>`}
    </section>
  </div>
  <p class="muted small">Ranked by the change in value of the copies you own (trend price × quantity). ⚠ marks a trend price that contradicts the current listings.</p>

  <section class="card-section">
    <h2>Value by location</h2>
    <ul class="bars">${locs.map((l) => `<li><a href="#/collection?${new URLSearchParams({ loc: `${l.location_type}|${l.location}`, sort: "value" })}">
      <span class="bar-label">${esc(l.location)} <span class="muted small">${num(l.copies)} copies</span></span>
      <span class="bar-track"><span class="bar-fill" style="width:${((l.value_gbp / maxLoc) * 100).toFixed(1)}%"></span></span>
      <span class="bar-value">${gbp(l.value_gbp)}</span></a></li>`).join("")}</ul>
  </section>

  <div class="dash-cols">
    <section class="card-section">
      <h2>Most up on what you paid</h2>
      <ol class="movers">${purchaseRows("DESC").map((r) => paidRow(r)).join("")}</ol>
    </section>
    <section class="card-section">
      <h2>Most down on what you paid</h2>
      <ol class="movers">${purchaseRows("ASC").map((r) => paidRow(r)).join("")}</ol>
    </section>
  </div>
  <p class="muted small">Purchase prices come from ManaBox and may not be accurate; correct them in ManaBox and re-import.</p>`;
}

function paidRow(r) {
  const diff = r.value - r.cost;
  return `<li><a href="#/card/${encodeURIComponent(r.scryfall_id)}" class="mover">
    <span class="mover-name"><span class="mover-title">${esc(r.name)} ${finishBadge(r.finish)}</span><span class="mover-sub">${esc(r.set_code)}${r.qty > 1 ? ` · ×${r.qty}` : ""} · paid ${gbp(r.cost)}</span></span>
    <span class="mover-change"><strong>${diff >= 0 ? "+" : "−"}${gbp(Math.abs(diff))}</strong><span class="muted small">worth ${gbp(r.value)}</span></span>
  </a></li>`;
}

function hydrateDashboard(params) {
  const rows = all(`SELECT day, value_gbp FROM value_history ORDER BY day`);
  const days = rows.map((r) => r.day);
  const start = sliceDays(days, dashboardWindow(params));
  const host = document.getElementById("value-chart");
  if (host) {
    lineChart(host, {
      days: days.slice(start),
      series: [{ name: "Collection value", slot: 1, values: rows.slice(start).map((r) => r.value_gbp) }],
      format: (v) => (v >= 1000 ? `£${(v / 1000).toLocaleString("en-GB", { maximumFractionDigits: 1 })}k` : gbp(v)),
      height: 240,
      label: "Collection value over time",
    });
  }
}

// ---------- locations ----------

function locationsView() {
  const locs = all(`SELECT * FROM locations ORDER BY location_type, value_gbp DESC`);
  const total = locs.reduce((n, l) => n + l.copies, 0);
  const totalValue = locs.reduce((n, l) => n + (l.value_gbp || 0), 0);
  const groups = {};
  for (const l of locs) (groups[l.location_type] ||= []).push(l);
  const order = ["binder", "deck", "list", ...Object.keys(groups).filter((t) => !TYPE_LABELS[t])];
  return `
  <h1>Locations</h1>
  <p class="summary"><strong>${gbp(totalValue)}</strong> · ${num(locs.length)} locations · ${num(total)} copies</p>
  ${order
    .filter((t) => groups[t])
    .map(
      (t) => `<h2>${esc(TYPE_LABELS[t] || titleCase(t))}</h2>
      <ul class="loc-list">${groups[t]
        .map(
          (l) => `<li><a href="#/collection?${new URLSearchParams({ loc: `${l.location_type}|${l.location}` })}">
            <span class="loc-name">${esc(l.location)}<span class="loc-copies">${num(l.copies)} copies</span></span>
            <span class="loc-value">${gbp(l.value_gbp || 0)}</span></a></li>`,
        )
        .join("")}</ul>`,
    )
    .join("")}`;
}

// ---------- imports ----------

function importsView() {
  const imports = all(`SELECT * FROM imports ORDER BY imported_at DESC`);
  const unmatched = all(`SELECT * FROM unmatched ORDER BY set_code, collector_number`);
  const removed = all(
    `SELECT * FROM holdings WHERE status = 'removed' ORDER BY removed_on DESC, name COLLATE NOCASE LIMIT 200`,
  );
  const built = one(`SELECT value FROM meta WHERE key = 'built_at'`)?.value;
  return `
  <h1>Imports</h1>
  <p class="summary">Data built ${built ? new Date(built).toLocaleString("en-GB") : "—"} · prices ${META.price_date ? date(META.price_date) : "not fetched yet"}</p>
  <div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Source</th><th class="r">Copies</th><th class="r">Added</th><th class="r">Updated</th><th class="r">Restored</th><th class="r">Removed</th></tr></thead>
    <tbody>${imports
      .map(
        (i) => `<tr><td>${new Date(i.imported_at).toLocaleString("en-GB")}</td><td>${esc(i.file)}</td>
        <td class="r">${num(i.copies)}</td><td class="r">${num(i.added)}</td><td class="r">${num(i.updated)}</td>
        <td class="r">${num(i.restored)}</td><td class="r">${num(i.removed)}</td></tr>`,
      )
      .join("") || `<tr><td colspan="7" class="empty">No imports yet.</td></tr>`}</tbody>
  </table></div>

  <h2>Cards Scryfall couldn't match (${unmatched.length})</h2>
  ${
    unmatched.length
      ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Set</th><th>Number</th></tr></thead><tbody>${unmatched
          .map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.set_code)}</td><td>${esc(u.collector_number)}</td></tr>`)
          .join("")}</tbody></table></div>`
      : `<p class="muted">Every card was matched.</p>`
  }

  <h2>Recently removed (${removed.length}${removed.length === 200 ? "+" : ""})</h2>
  ${
    removed.length
      ? `<ul class="results">${removed.map((h) => resultRow({ ...h, colors: null })).join("")}</ul>`
      : `<p class="muted">Nothing has been removed.</p>`
  }`;
}

// ---------- start-up ----------

async function unlock(passphrase, remember) {
  db = await openDatabase(passphrase);
  META = Object.fromEntries(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
  if (remember) storeSet(STORE_KEY, passphrase);
  document.querySelector(".topbar").hidden = false;
  if (!location.hash) history.replaceState(null, "", "#/dashboard");
  render();
}

function showUnlock(message = "") {
  document.getElementById("unlock-error").textContent = message;
  document.getElementById("unlock").hidden = false;
}

document.getElementById("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("unlock-btn");
  btn.disabled = true;
  btn.textContent = "Unlocking…";
  try {
    await unlock(document.getElementById("passphrase").value, document.getElementById("remember").checked);
  } catch (err) {
    showUnlock(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Unlock";
  }
});

document.getElementById("lock-btn").addEventListener("click", () => {
  storeDel(STORE_KEY);
  location.hash = "";
  location.reload();
});

window.addEventListener("hashchange", render);

// Home-screen apps on iPad have no pull-to-refresh, so reload after the app
// has been in the background for a while to pick up the latest data.
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (db && hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) location.reload();
});

const saved = storeGet(STORE_KEY);
if (saved) {
  document.getElementById("unlock").hidden = true;
  unlock(saved, true).catch((err) => {
    if (err instanceof WrongPassphrase) storeDel(STORE_KEY);
    showUnlock(err instanceof WrongPassphrase ? "Your saved passphrase no longer works. Enter it again." : err.message);
  });
}

// ---------- line chart (inline SVG) ----------
// series: [{ name, slot: 1|2, values: [number|null] }] aligned with days (ISO dates).
// A crosshair snaps to the nearest day; the readout lists every series there.

const charts = [];
const shortDate = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function lineChart(host, { days, series, format = gbp, tipFormat = gbp, height = 220, label = "Price history" }) {
  const draw = () => {
    host.replaceChildren();
    const shown = series.filter((s) => s.values.some((v) => v != null));
    if (!shown.length || !days.length) {
      host.innerHTML = `<p class="muted small">No price history for this period.</p>`;
      return;
    }
    if (shown.length > 1) {
      const legend = document.createElement("div");
      legend.className = "legend";
      for (const s of shown) {
        const item = document.createElement("span");
        const key = document.createElement("span");
        key.className = `key key-${s.slot}`;
        item.append(key, document.createTextNode(s.name));
        legend.append(item);
      }
      host.append(legend);
    }

    const wrap = document.createElement("div");
    wrap.className = "chart-wrap";
    host.append(wrap);
    const width = Math.max(280, host.clientWidth || 600);
    const M = { top: 10, right: 12, bottom: 24, left: 56 };
    const W = width - M.left - M.right;
    const H = height - M.top - M.bottom;
    const times = days.map((d) => Date.parse(d + "T00:00:00Z"));
    const t0 = times[0];
    const t1 = times[times.length - 1];
    const values = shown.flatMap((s) => s.values.filter((v) => v != null));
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi - lo < Math.max(hi * 0.02, 0.01)) { lo = lo * 0.95; hi = hi * 1.05 + 0.01; }
    const ticks = niceTicks(Math.max(0, lo - (hi - lo) * 0.08), hi + (hi - lo) * 0.08, 4);
    lo = ticks[0];
    hi = ticks[ticks.length - 1];
    const x = (t) => M.left + (t1 === t0 ? W / 2 : ((t - t0) / (t1 - t0)) * W);
    const y = (v) => M.top + H - ((v - lo) / (hi - lo)) * H;

    const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
    const grid = svgEl("g", { class: "grid" });
    for (const t of ticks) {
      grid.append(svgEl("line", { x1: M.left, x2: M.left + W, y1: y(t), y2: y(t) }));
      const text = svgEl("text", { x: M.left - 8, y: y(t) + 4, "text-anchor": "end" });
      text.textContent = format(t);
      grid.append(text);
    }
    const labelCount = Math.min(days.length, Math.max(2, Math.floor(W / 90)));
    for (let k = 0; k < labelCount; k++) {
      const i = labelCount === 1 ? 0 : Math.round((k * (days.length - 1)) / (labelCount - 1));
      const text = svgEl("text", { x: x(times[i]), y: height - 6, "text-anchor": k === 0 ? "start" : k === labelCount - 1 ? "end" : "middle" });
      text.textContent = shortDate(days[i]);
      grid.append(text);
    }
    svg.append(grid);

    for (const s of shown) {
      let d = "";
      let pen = false;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      svg.append(svgEl("path", { d, class: `line line-${s.slot}` }));
      // Points with no neighbour (e.g. the first day of our own 7-day averages) need a marker to be visible.
      s.values.forEach((v, i) => {
        if (v != null && s.values[i - 1] == null && s.values[i + 1] == null) {
          svg.append(svgEl("circle", { cx: x(times[i]), cy: y(v), r: 4, class: `dot dot-${s.slot}` }));
        }
      });
    }

    const cross = svgEl("line", { y1: M.top, y2: M.top + H, class: "crosshair", visibility: "hidden" });
    const marks = shown.map((s) => svgEl("circle", { r: 4.5, class: `dot dot-${s.slot} hover-dot`, visibility: "hidden" }));
    const hit = svgEl("rect", { x: M.left, y: M.top, width: W, height: H, class: "hit", tabindex: 0, "aria-label": `${label}: use left and right arrow keys to read values` });
    svg.append(cross, ...marks, hit);
    wrap.append(svg);

    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    wrap.append(tip);

    let current = days.length - 1;
    const show = (i) => {
      current = Math.max(0, Math.min(days.length - 1, i));
      const cx = x(times[current]);
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      tip.replaceChildren();
      const head = document.createElement("div");
      head.className = "tip-date";
      head.textContent = new Date(days[current] + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
      tip.append(head);
      shown.forEach((s, k) => {
        const v = s.values[current];
        marks[k].setAttribute("visibility", v == null ? "hidden" : "visible");
        if (v != null) { marks[k].setAttribute("cx", cx); marks[k].setAttribute("cy", y(v)); }
        const row = document.createElement("div");
        row.className = "tip-row";
        const key = document.createElement("span");
        key.className = `key key-${s.slot}`;
        const strong = document.createElement("strong");
        strong.textContent = v == null ? "—" : tipFormat(v);
        const name = document.createElement("span");
        name.className = "tip-name";
        name.textContent = s.name;
        row.append(key, strong, name);
        tip.append(row);
      });
      tip.hidden = false;
      const left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
      tip.style.left = `${left}px`;
    };
    const hide = () => {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      marks.forEach((m) => m.setAttribute("visibility", "hidden"));
    };
    const nearest = (clientX) => {
      const t = t0 + ((clientX - svg.getBoundingClientRect().left - M.left) / W) * (t1 - t0);
      let best = 0;
      times.forEach((tt, i) => { if (Math.abs(tt - t) < Math.abs(times[best] - t)) best = i; });
      return best;
    };
    svg.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
    svg.addEventListener("pointerdown", (e) => show(nearest(e.clientX)));
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
    hit.addEventListener("focus", () => show(current));
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        show(current + (e.key === "ArrowLeft" ? -1 : 1));
      } else if (e.key === "Escape") hide();
    });

    const table = document.createElement("details");
    table.className = "chart-table";
    table.innerHTML = `<summary>Show as table</summary><div class="table-wrap"><table>
      <thead><tr><th>Date</th>${shown.map((s) => `<th class="r">${esc(s.name)}</th>`).join("")}</tr></thead>
      <tbody>${days.map((d, i) => [d, i]).reverse().map(([d, i]) =>
        `<tr><td>${esc(shortDate(d))}</td>${shown.map((s) => `<td class="r">${s.values[i] == null ? "—" : esc(tipFormat(s.values[i]))}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
    host.append(table);
  };
  draw();
  charts.push({ host, draw });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const c of charts) if (c.host.isConnected) c.draw();
  }, 150);
});
