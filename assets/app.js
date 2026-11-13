/* NY Legislature Expenditures explorer (Assembly + Senate) — vanilla JS, no dependencies. */
(function () {
  "use strict";

  const app = document.getElementById("app");
  const PAGE_SIZE = 50;
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let DB = null;      // currently selected period
  let PREV = null;    // the period before it, for comparisons (or null)
  let PERIODS = [];   // manifest, newest first
  const DBS = {};     // period id -> indexed data
  let CHAMBERS = [];   // [{id, name, title, abbr, sourceUrl, memberRule, districts, periods}]
  let CH = null;       // current chamber
  const DIST = {};     // chamber id -> districts
  const DIST_BY_UNIT = {}; // chamber id -> Map(report unit name -> district)
  let DISTRICTS = [];  // districts of the current chamber
  let DISTRICT_BY_UNIT = new Map();
  const dbFor = (periodId, chamberId) => DBS[(chamberId || CH.id) + "/" + periodId];

  /* ---------- formatting helpers ---------- */
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
  const int = new Intl.NumberFormat("en-US");
  const money = (n) => usd2.format(n);
  const money0 = (n) => usd0.format(n);
  const compact = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return "$" + (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
    if (a >= 1e3) return "$" + (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
    return money0(n);
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
  };
  const monthLabel = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return `${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`;
  };
  const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Of|And|The|For|On|To|In)\b/g, (w) => w.toLowerCase()).replace(/^./, (c) => c.toUpperCase());

  /* ---------- search ---------- */
  function tokenize(q) {
    const out = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(q || ""))) out.push((m[1] || m[2]).toLowerCase());
    return out.filter(Boolean);
  }
  function matchesTokens(text, tokens) {
    for (const t of tokens) if (text.indexOf(t) === -1) return false;
    return true;
  }
  function highlight(str, tokens) {
    const safe = esc(str);
    if (!tokens.length) return safe;
    const pattern = tokens.map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return safe.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
  }

  /* ---------- routing / state ---------- */
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, qs] = h.split("?");
    const parts = (path || "").split("/").filter(Boolean);
    const params = Object.fromEntries(new URLSearchParams(qs || ""));
    return { view: parts[0] || "overview", arg: parts[1], params };
  }
  function buildHash(view, params) {
    const clean = {};
    const explicitP = !!params && Object.prototype.hasOwnProperty.call(params, "p");
    const explicitC = !!params && Object.prototype.hasOwnProperty.call(params, "c");
    for (const [k, v] of Object.entries(params || {})) if (v !== "" && v != null) clean[k] = v;
    if (!explicitP && DB && PERIODS.length && DB.id !== PERIODS[0].id) clean.p = DB.id;
    if (clean.p && PERIODS.length && clean.p === PERIODS[0].id) delete clean.p;
    if (!explicitC && CH && CHAMBERS.length && CH.id !== CHAMBERS[0].id) clean.c = CH.id;
    if (clean.c && CHAMBERS.length && clean.c === CHAMBERS[0].id) delete clean.c;
    const qs = new URLSearchParams(clean).toString();
    return `#/${view}${qs ? "?" + qs : ""}`;
  }
  function go(view, params, replace) {
    const h = buildHash(view, params);
    if (replace) history.replaceState(null, "", h);
    else location.hash = h;
    if (replace) render();
  }

  /* ---------- data load & indexing ---------- */
  async function load() {
    const bundled = window.__EXPENDITURE_BUNDLE__;
    CHAMBERS = bundled ? bundled.chambers : await (await fetch("data/chambers.json")).json();
    await Promise.all(CHAMBERS.map(async (ch) => {
      await Promise.all(ch.periods.map(async (pm) => {
        const raw = bundled ? bundled.data[pm.file] : await (await fetch(pm.file)).json();
        DBS[ch.id + "/" + pm.id] = indexPeriod(pm.id, raw);
      }));
      try {
        DIST[ch.id] = bundled ? bundled.data[ch.districts] || [] : await (await fetch(ch.districts)).json();
      } catch (e) { DIST[ch.id] = []; }
      DIST_BY_UNIT[ch.id] = new Map(DIST[ch.id].filter((d) => d.unitName).map((d) => [d.unitName, d]));
    }));
  }

  function selectChamber(id) {
    CH = CHAMBERS.find((c) => c.id === id) || CHAMBERS[0];
    PERIODS = CH.periods;
    DISTRICTS = DIST[CH.id] || [];
    DISTRICT_BY_UNIT = DIST_BY_UNIT[CH.id] || new Map();
  }

  function selectPeriod(id) {
    const i = Math.max(0, PERIODS.findIndex((pm) => pm.id === id));
    DB = dbFor(PERIODS[i].id);
    PREV = PERIODS[i + 1] ? dbFor(PERIODS[i + 1].id) : null;
  }

  function indexPeriod(id, raw) {
    const { meta, units, types, payees, descs, rows } = raw;

    const records = rows.map((r, i) => {
      const [u, t, date, voucher, p, svc, d, st, amt] = r;
      const unit = units[u], type = types[t];
      return {
        i, u, t, date, voucher, p, svc, d, st, amt,
        month: date ? date.slice(0, 7) : "",
        allocated: type.allocated,
        text: [unit.name, type.code, type.label, payees[p], descs[d], voucher, svc, date].join(" | ").toLowerCase(),
      };
    });

    const unitStats = units.map((unit, id) => ({
      id, name: unit.name, kind: unit.kind,
      byType: {}, byCode: {}, actual: 0, allocated: 0, count: 0, staff: new Set(),
    }));
    for (const r of records) {
      const s = unitStats[r.u];
      const code = types[r.t].code;
      const group = types[r.t].group;
      s.byType[group] = (s.byType[group] || 0) + r.amt; // ps / mo / travel / allocated
      s.byCode[code] = (s.byCode[code] || 0) + r.amt;
      if (r.allocated) s.allocated += r.amt; else s.actual += r.amt;
      s.count++;
      if (group === "ps") s.staff.add(r.p);
    }
    unitStats.forEach((s) => { s.staffCount = s.staff.size; });

    const members = unitStats.filter((s) => s.kind === "member").sort((a, b) => b.actual - a.actual);
    members.forEach((s, i) => { s.rank = i + 1; });
    const sortedActual = members.map((s) => s.actual).sort((a, b) => a - b);
    const mid = Math.floor(sortedActual.length / 2);
    const memberMedian = sortedActual.length % 2 ? sortedActual[mid] : (sortedActual[mid - 1] + sortedActual[mid]) / 2;

    const months = [...new Set(records.map((r) => r.month).filter(Boolean))].sort();
    const statuses = [...new Set(records.map((r) => r.st).filter(Boolean))].sort();
    const typeIndex = Object.fromEntries(types.map((t, i) => [t.code, i]));

    const byName = new Map(unitStats.map((s) => [s.name, s]));
    return { id, meta, units, types, payees, descs, records, unitStats, members, memberMedian, months, statuses, typeIndex, byName };
  }

  /* ---------- period comparison helpers ---------- */
  function periodName(db) { return `${fmtShort(db.meta.period.start)} – ${fmtShort(db.meta.period.end)}`; }
  function fmtShort(iso) { const [y, m] = iso.split("-").map(Number); return `${MONTH_NAMES[m - 1]} ${y}`; }
  function change(cur, prev) {
    if (prev == null) return null;
    return { diff: cur - prev, pct: prev ? (cur - prev) / Math.abs(prev) * 100 : null };
  }
  function changeText(c, short) {
    if (!c) return short ? "—" : "";
    const sign = c.diff > 0 ? "+" : c.diff < 0 ? "−" : "";
    const pct = c.pct == null ? "" : ` (${sign}${Math.abs(c.pct).toFixed(1)}%)`;
    return short ? `${sign}${Math.abs(c.pct || 0).toFixed(1)}%` : `${sign}${compact(Math.abs(c.diff))}${pct} vs ${PREV ? periodName(PREV) : "prior"}`;
  }
  function prevUnit(s) { return PREV ? PREV.byName.get(s.name) || null : null; }

  /* ---------- shared UI pieces ---------- */
  function kpi(label, value, note) {
    return `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ""}</div>`;
  }
  function bars(items, opts = {}) {
    if (!items.length) return `<p class="empty">Nothing to show.</p>`;
    const max = Math.max(...items.map((x) => Math.abs(x.value))) || 1;
    return `<ul class="bars">${items.map((x) => `
      <li title="${esc(x.label)}: ${money(x.value)}">
        <span class="name">${x.href ? `<a href="${x.href}">${esc(x.label)}</a>` : esc(x.label)}</span>
        <span class="track"><span class="fill${x.alt ? " alt" : ""}" style="width:${(Math.abs(x.value) / max * 100).toFixed(1)}%"></span></span>
        <span class="amt">${opts.compact ? compact(x.value) : money0(x.value)}</span>
      </li>`).join("")}</ul>`;
  }
  function unitHref(id) { return buildHash("unit/" + id, {}); }
  function unitLink(id) {
    const u = DB.units[id];
    return `<a href="${unitHref(id)}">${esc(u.name)}</a>`;
  }
  function districtChip(s) {
    const d = DISTRICT_BY_UNIT.get(s.name);
    if (!d) return "";
    return ` <a class="chip muted" href="${buildHash("district/" + d.district, {})}" title="District profile">${CH.abbr} ${d.district}${d.party ? " · " + esc(d.party) : ""}</a>`;
  }
  function kindChip(kind) {
    return kind === "member" ? `<span class="chip">Member</span>` : `<span class="chip muted">Office</span>`;
  }
  function typeLabel(t) { return DB.types[t].label; }
  function sumBy(records, keyFn) {
    const m = new Map();
    for (const r of records) {
      const k = keyFn(r);
      const cur = m.get(k) || { key: k, total: 0, count: 0 };
      cur.total += r.amt; cur.count++;
      m.set(k, cur);
    }
    return [...m.values()];
  }
  function sortHeader(label, key, state, cls = "") {
    const active = state.sort === key;
    return `<th class="sortable ${cls}${active ? " sorted" + (state.dir === "asc" ? " asc" : "") : ""}" data-sort="${key}" scope="col">${label}</th>`;
  }
  function wireSortHeaders(root, state, onChange, defaultDir = {}) {
    root.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.sort;
      const dir = state.sort === key ? (state.dir === "asc" ? "desc" : "asc") : (defaultDir[key] || "desc");
      onChange({ sort: key, dir });
    }));
  }
  function downloadCSV(filename, header, rows) {
    const q = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...rows].map((r) => r.map(q).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function totalsByType(db) {
    // keyed by expense-type code and by group (ps / mo / travel / allocated)
    const out = Object.fromEntries(db.types.map((t) => [t.code, 0]));
    for (const g of ["ps", "mo", "travel", "allocated"]) out[g] = 0;
    for (const r of db.records) { out[db.types[r.t].code] += r.amt; out[db.types[r.t].group] += r.amt; }
    return out;
  }
  function moCode() { const t = DB.types.find((x) => x.group === "mo"); return t ? t.code : ""; }

  /* ---------- views ---------- */
  function viewOverview() {
    const { meta, records, unitStats, types, payees, descs } = DB;
    const totalBy = totalsByType(DB);
    const prevBy = PREV ? totalsByType(PREV) : null;
    const vs = (code) => prevBy ? changeText(change(totalBy[code], prevBy[code])) : "";
    const staffAll = new Set(records.filter((r) => types[r.t].group === "ps").map((r) => r.p));

    const byMonth = sumBy(records.filter((r) => r.month && !r.allocated), (r) => r.month).sort((a, b) => a.key.localeCompare(b.key));
    const maxMonth = Math.max(...byMonth.map((m) => m.total)) || 1;

    const topMembers = DB.members.slice(0, 10).map((s) => ({ label: s.name, value: s.actual, href: `#/unit/${s.id}` }));
    const topOffices = unitStats.filter((s) => s.kind === "office").sort((a, b) => b.actual - a.actual).slice(0, 10)
      .map((s) => ({ label: s.name, value: s.actual, href: `#/unit/${s.id}` }));
    const mo = records.filter((r) => types[r.t].group === "mo");
    const topVendors = sumBy(mo, (r) => r.p).sort((a, b) => b.total - a.total).slice(0, 10)
      .map((x) => ({ label: payees[x.key] || "(no payee listed)", value: x.total, href: buildHash("records", { payee: payees[x.key], type: moCode() }) }));
    const topDescs = sumBy(mo, (r) => r.d).sort((a, b) => b.total - a.total).slice(0, 10)
      .map((x) => ({ label: titleCase(descs[x.key]), value: x.total, href: buildHash("records", { q: `"${descs[x.key].toLowerCase()}"`, type: moCode() }) }));

    const typeBars = types.map((t) => ({ label: t.label, value: totalBy[t.code], alt: t.allocated, href: buildHash("records", { type: t.code }) }))
      .sort((a, b) => b.value - a.value);

    return `
      <h1>Where the ${esc(CH.name)}'s money went</h1>
      <p class="lede">Every line of the ${esc(CH.title)} Expenditure Report for ${fmtDate(meta.period.start)} – ${fmtDate(meta.period.end)}:
        ${int.format(meta.rowCount)} records across ${meta.members} member offices and ${meta.offices} central offices and committees.</p>
      <div class="grid kpis">
        ${kpi("Actual spending", compact(meta.totalActual), PREV ? changeText(change(meta.totalActual, PREV.meta.totalActual)) : "Payroll + M&amp;O + travel")}
        ${kpi("Payroll", compact(totalBy.ps), `${int.format(staffAll.size)} people paid${PREV ? "<br>" + vs("ps") : ""}`)}
        ${kpi("Maintenance &amp; operations", compact(totalBy.mo), PREV ? vs("mo") : "Rent, utilities, services")}
        ${kpi("Travel", compact(totalBy.travel), PREV ? vs("travel") : "Reimbursed to members &amp; staff")}
        ${kpi("Allocated costs", compact(meta.totalAllocated), "Informational only — see About")}
      </div>
      ${chambersCard()}
      <div class="grid two">
        <section class="card"><div class="card-head"><h2>By expense type</h2><span class="summary">grey = allocated</span></div>${bars(typeBars)}</section>
        <section class="card"><div class="card-head"><h2>Vouchered spending by month</h2><span class="summary">M&amp;O + travel</span></div>
          <div class="cols">${byMonth.map((m) => `
            <a class="col" href="${buildHash("records", { month: m.key })}" title="${monthLabel(m.key)}: ${money(m.total)}">
              <span class="colval">${compact(m.total)}</span>
              <span class="colbar" style="height:${(m.total / maxMonth * 100).toFixed(1)}%"></span>
              <span class="collabel">${monthLabel(m.key)}</span>
            </a>`).join("")}</div>
          <p class="summary">Payroll has no voucher date, so it isn't shown by month.</p>
        </section>
        <section class="card"><div class="card-head"><h2>Highest-spending member offices</h2><a href="${buildHash("units", { kind: "member" })}">All ${DB.members.length} →</a></div>${bars(topMembers)}
          <p class="summary">Median member office: <strong>${money0(DB.memberMedian)}</strong>${PREV ? ` · ${periodName(PREV)}: ${money0(PREV.memberMedian)}` : ""}</p></section>
        <section class="card"><div class="card-head"><h2>Largest central offices &amp; committees</h2><a href="${buildHash("units", { kind: "office" })}">All offices →</a></div>${bars(topOffices)}</section>
        <section class="card"><div class="card-head"><h2>Top vendors (M&amp;O)</h2><a href="${buildHash("payees", { group: "vendor" })}">All payees →</a></div>${bars(topVendors)}</section>
        <section class="card"><div class="card-head"><h2>What M&amp;O money bought</h2></div>${bars(topDescs)}</section>
        ${PREV ? moversCard() : ""}
      </div>`;
  }

  function chambersCard() {
    if (CHAMBERS.length < 2) return "";
    const rows = CHAMBERS.map((c) => {
      const db = dbFor(DB.id, c.id);
      if (!db) return null;
      const t = totalsByType(db);
      return { c, db, t };
    }).filter(Boolean);
    const max = Math.max(1, ...rows.map((r) => r.db.meta.totalActual));
    const total = rows.reduce((a, r) => a + r.db.meta.totalActual, 0);
    return `<section class="card chambers"><div class="card-head"><h2>Both chambers, ${esc(periodName(DB))}</h2><span class="summary">Legislature total <strong>${money0(total)}</strong> actual spending</span></div>
      ${rows.map((r) => `<div class="chamber-row${r.c.id === CH.id ? " me" : ""}">
        <a class="chamber-name" href="${buildHash("", { c: r.c.id })}">${esc(r.c.name)}</a>
        <div class="stack" style="width:${(r.db.meta.totalActual / max * 100).toFixed(1)}%">
          <span class="seg-ps" style="flex:${Math.max(r.t.ps, 0)}" title="Payroll ${money(r.t.ps)}"></span>
          <span class="seg-mo" style="flex:${Math.max(r.t.mo, 0)}" title="M&amp;O ${money(r.t.mo)}"></span>
          <span class="seg-tr" style="flex:${Math.max(r.t.travel, 0)}" title="Travel ${money(r.t.travel)}"></span></div>
        <span class="chamber-amt">${money0(r.db.meta.totalActual)}</span>
        <span class="chamber-meta">${r.db.meta.members} member offices · median ${money0(r.db.memberMedian)}</span>
      </div>`).join("")}
      <div class="legend"><span><i class="seg-ps"></i>Payroll</span><span><i class="seg-mo"></i>M&amp;O</span><span><i class="seg-tr"></i>Travel</span></div>
    </section>`;
  }

  function moversCard() {
    const rows = DB.members.map((s) => ({ s, p: prevUnit(s) })).filter((x) => x.p)
      .map((x) => ({ ...x, d: x.s.actual - x.p.actual }));
    const up = rows.slice().sort((a, b) => b.d - a.d).slice(0, 5);
    const down = rows.slice().sort((a, b) => a.d - b.d).slice(0, 5);
    const li = (x) => `<li><span class="name"><a href="${unitHref(x.s.id)}">${esc(x.s.name)}</a></span><span class="amt">${x.d >= 0 ? "+" : "−"}${money0(Math.abs(x.d))}</span></li>`;
    return `<section class="card"><div class="card-head"><h2>Biggest changes vs ${esc(periodName(PREV))}</h2><span class="summary">member offices</span></div>
      <div class="grid two movers"><div><h3>Increased most</h3><ul class="bars plain">${up.map(li).join("")}</ul></div>
      <div><h3>Decreased most</h3><ul class="bars plain">${down.map(li).join("")}</ul></div></div></section>`;
  }

  function viewUnits(params) {
    const state = { q: params.q || "", kind: params.kind || "", party: params.party || "", sort: params.sort || "actual", dir: params.dir || "desc" };
    const tokens = tokenize(state.q);
    const dist = (s) => DISTRICT_BY_UNIT.get(s.name);
    let list = DB.unitStats.filter((s) => (!state.kind || s.kind === state.kind) && matchesTokens(s.name.toLowerCase(), tokens)
      && (!state.party || (dist(s) && dist(s).party === state.party)));
    const val = {
      name: (s) => s.name, district: (s) => (dist(s) ? dist(s).district : 999), actual: (s) => s.actual, ps: (s) => s.byType.ps || 0, mo: (s) => s.byType.mo || 0,
      travel: (s) => s.byType.travel || 0, allocated: (s) => s.allocated, staff: (s) => s.staffCount,
      change: (s) => { const p = prevUnit(s); return p ? s.actual - p.actual : -Infinity; },
    }[state.sort] || ((s) => s.actual);
    list.sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return state.dir === "asc" ? c : -c;
    });
    const total = list.reduce((a, s) => a + s.actual, 0);

    const html = `
      <h1>Members &amp; Offices</h1>
      <p class="lede">Each ${esc(CH.name)} member's office and each central office, committee, and task force in the report. Click a name for its full breakdown.</p>
      <div class="filters">
        <label class="wide">Filter by name<input type="search" id="uq" value="${esc(state.q)}" placeholder="e.g. Thiele, Ways and Means, minority"></label>
        <label>Show<select id="ukind">
          <option value="">Members and offices</option>
          <option value="member"${state.kind === "member" ? " selected" : ""}>Members only</option>
          <option value="office"${state.kind === "office" ? " selected" : ""}>Offices only</option>
        </select></label>
        ${DISTRICTS.length ? `<label>Party<select id="uparty"><option value="">Any</option>${[...new Set(DISTRICTS.map((d) => d.party).filter(Boolean))].sort().map((p) => `<option${p === state.party ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="toolbar"><span class="summary"><strong>${int.format(list.length)}</strong> shown · actual spending <strong>${money0(total)}</strong></span>
        <button id="uexport">Export CSV</button></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th scope="col">#</th>
          ${sortHeader("Name", "name", state)}
          ${sortHeader("District", "district", state)}
          <th scope="col">Type</th>
          ${sortHeader("Payroll", "ps", state, "num")}
          ${sortHeader("M&amp;O", "mo", state, "num")}
          ${sortHeader("Travel", "travel", state, "num")}
          ${sortHeader("Actual total", "actual", state, "num")}
          ${sortHeader("Allocated", "allocated", state, "num")}
          ${sortHeader("People paid", "staff", state, "num")}
          ${PREV ? sortHeader("vs prior", "change", state, "num") : ""}
        </tr></thead>
        <tbody>${list.length ? list.map((s, i) => `<tr>
          <td class="num">${i + 1}</td>
          <td><a href="${unitHref(s.id)}">${highlight(s.name, tokens)}</a></td>
          <td class="nowrap">${dist(s) ? `${CH.abbr} ${dist(s).district}` : ""}</td>
          <td>${kindChip(s.kind)}</td>
          <td class="num">${money0(s.byType.ps || 0)}</td>
          <td class="num">${money0(s.byType.mo || 0)}</td>
          <td class="num">${money0(s.byType.travel || 0)}</td>
          <td class="num"><strong>${money0(s.actual)}</strong></td>
          <td class="num">${money0(s.allocated)}</td>
          <td class="num">${s.staffCount}</td>
          ${PREV ? (() => { const c = change(s.actual, prevUnit(s) && prevUnit(s).actual); return `<td class="num${c && c.diff < 0 ? " neg" : ""}" title="${c ? esc(changeText(c)) : "Not in prior period"}">${changeText(c, true)}</td>`; })() : ""}
        </tr>`).join("") : `<tr><td colspan="11" class="empty">No members or offices match.</td></tr>`}</tbody>
      </table></div>`;
    app.innerHTML = html;

    const update = (patch) => go("units", { ...state, ...patch }, true);
    const uq = app.querySelector("#uq");
    let timer;
    uq.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { update({ q: uq.value }); focusEnd("#uq"); }, 200); });
    app.querySelector("#ukind").addEventListener("change", (e) => update({ kind: e.target.value }));
    const up = app.querySelector("#uparty");
    if (up) up.addEventListener("change", (e) => update({ party: e.target.value }));
    wireSortHeaders(app, state, update, { name: "asc", district: "asc" });
    app.querySelector("#uexport").addEventListener("click", () => downloadCSV("assembly-units.csv",
      ["Period", "Name", "District", "Party", "Type", "Payroll", "M&O", "Travel", "Actual total", "Allocated", "People paid"],
      list.map((s) => [periodName(DB), s.name, dist(s) ? dist(s).district : "", dist(s) ? dist(s).party : "", s.kind, (s.byType.ps || 0).toFixed(2), (s.byType.mo || 0).toFixed(2), (s.byType.travel || 0).toFixed(2), s.actual.toFixed(2), s.allocated.toFixed(2), s.staffCount])));
    return null;
  }

  function viewUnit(id) {
    const s = DB.unitStats[Number(id)];
    if (!s) return `<p class="empty">That member or office wasn't found. <a href="${buildHash("units", {})}">Back to the list</a>.</p>`;
    const { types, payees, descs, meta } = DB;
    const recs = DB.records.filter((r) => r.u === s.id);
    const code = (r) => types[r.t].group;
    const staffRows = recs.filter((r) => code(r) === "ps").sort((a, b) => b.amt - a.amt);
    const mo = recs.filter((r) => code(r) === "mo");
    const travel = recs.filter((r) => code(r) === "travel").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const vendors = sumBy(mo, (r) => r.p).sort((a, b) => b.total - a.total);
    const moDescs = sumBy(mo, (r) => r.d).sort((a, b) => b.total - a.total).slice(0, 10);
    const allocated = types.filter((t) => t.allocated).map((t) => ({ label: t.label, value: s.byCode[t.code] || 0, alt: true }));

    const ps = prevUnit(s);
    const vsPrev = (cur, prevVal) => ps ? `<br>${changeText(change(cur, prevVal))}` : "";
    let rankNote = "";
    if (s.kind === "member") {
      const diff = s.actual - DB.memberMedian;
      rankNote = `Ranks <strong>#${s.rank}</strong> of ${DB.members.length} member offices for ${esc(periodName(DB))} · ${diff >= 0 ? "" : "−"}${money0(Math.abs(diff))} ${diff >= 0 ? "above" : "below"} the median (${money0(DB.memberMedian)}).${ps && ps.rank ? ` Ranked #${ps.rank} in ${esc(periodName(PREV))}.` : ""}`;
    }

    const statusName = (c) => meta.statusLabels[c] || c;
    return `
      <div class="crumbs"><a href="${buildHash("units", { kind: s.kind })}">← ${s.kind === "member" ? "Members" : "Offices"}</a></div>
      <div class="title-row"><h1>${esc(s.name)} ${kindChip(s.kind)}${districtChip(s)}</h1>
        <a class="btn" href="${buildHash("compare", { u: s.kind === "member" ? [s.name, DB.members[Math.floor(DB.members.length / 2)].name].filter((v, i, a) => a.indexOf(v) === i).join("|") : s.name })}">Compare…</a></div>
      <p class="lede">${rankNote || "Central office, committee, or task force."}</p>
      <div class="grid kpis">
        ${kpi("Actual spending", money0(s.actual), ps ? changeText(change(s.actual, ps.actual)) : (PREV ? "Not in prior period" : ""))}
        ${kpi("Payroll", money0(s.byType.ps || 0), `${s.staffCount} ${s.staffCount === 1 ? "person" : "people"} paid${vsPrev(s.byType.ps || 0, ps && (ps.byType.ps || 0))}`)}
        ${kpi("Maintenance &amp; operations", money0(s.byType.mo || 0), `${vendors.length} payees${vsPrev(s.byType.mo || 0, ps && (ps.byType.mo || 0))}`)}
        ${kpi("Travel", money0(s.byType.travel || 0), `${travel.length} reimbursements${vsPrev(s.byType.travel || 0, ps && (ps.byType.travel || 0))}`)}
        ${kpi("Allocated", money0(s.allocated), "Informational only")}
      </div>

      <section class="card"><div class="card-head"><h2>M&amp;O + travel by month</h2><span class="summary">by voucher date · click a month for its records</span></div>
        ${columns(monthlyFor(DB, s.id).map((m) => ({ ...m, href: buildHash("records", { unit: s.id, month: m.key }) })))}</section>

      <section class="card">
        <div class="card-head"><h2>Payroll</h2><span class="summary">${staffRows.length} lines</span></div>
        ${staffRows.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Title / description</th><th>Service dates</th><th>Pay status</th><th class="num">Amount</th></tr></thead>
          <tbody>${staffRows.map((r) => `<tr>
            <td><a href="${buildHash("records", { payee: payees[r.p] })}">${esc(payees[r.p])}</a></td>
            <td>${esc(titleCase(descs[r.d]))}</td>
            <td class="nowrap mono">${esc(r.svc)}</td>
            <td>${r.st ? `<span class="chip muted" title="${esc(statusName(r.st))}">${esc(r.st)} · ${esc(statusName(r.st).split(" (")[0])}</span>` : ""}</td>
            <td class="num${r.amt < 0 ? " neg" : ""}">${money(r.amt)}</td></tr>`).join("")}</tbody>
        </table></div>` : `<p class="empty">No payroll lines.</p>`}
      </section>

      <div class="grid two">
        <section class="card"><div class="card-head"><h2>M&amp;O payees</h2></div>
          ${bars(vendors.slice(0, 12).map((v) => ({ label: payees[v.key] || "(no payee listed)", value: v.total, href: buildHash("records", { unit: s.id, payee: payees[v.key] }) })))}</section>
        <section class="card"><div class="card-head"><h2>M&amp;O by purpose</h2></div>
          ${bars(moDescs.map((v) => ({ label: titleCase(descs[v.key]), value: v.total })))}</section>
      </div>

      <section class="card">
        <div class="card-head"><h2>Travel</h2><span class="summary">${money(s.byType.travel || 0)}</span></div>
        ${travel.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Voucher date</th><th>Payee</th><th>Purpose</th><th>Voucher</th><th class="num">Amount</th></tr></thead>
          <tbody>${travel.map((r) => `<tr><td class="nowrap">${fmtDate(r.date)}</td><td>${esc(payees[r.p])}</td><td>${esc(titleCase(descs[r.d]))}</td><td class="mono">${esc(r.voucher)}</td><td class="num${r.amt < 0 ? " neg" : ""}">${money(r.amt)}</td></tr>`).join("")}</tbody>
        </table></div>` : `<p class="empty">No travel reimbursements.</p>`}
      </section>

      <section class="card"><div class="card-head"><h2>Allocated operational costs</h2><span class="summary">shares of centrally paid costs</span></div>${bars(allocated)}</section>

      ${otherPeriodLinks(s)}
      <p><a class="btn" href="${buildHash("records", { unit: s.id })}">See all ${int.format(recs.length)} records for this ${s.kind === "member" ? "member" : "office"} →</a></p>`;
  }

  function otherPeriodLinks(s) {
    const others = PERIODS.filter((pm) => pm.id !== DB.id).map((pm) => ({ pm, u: dbFor(pm.id).byName.get(s.name) })).filter((x) => x.u);
    if (!others.length) return "";
    return `<p class="summary">Also in: ${others.map((x) => `<a href="${buildHash("unit/" + x.u.id, { p: x.pm.id === PERIODS[0].id ? "" : x.pm.id })}">${esc(periodName(dbFor(x.pm.id)))}</a>`).join(" · ")}</p>`;
  }

  function filterRecords(state) {
    const tokens = tokenize(state.q);
    const typeIdx = state.type ? DB.typeIndex[state.type] : null;
    const unit = state.unit !== "" && state.unit != null ? Number(state.unit) : null;
    const min = state.min !== "" && state.min != null ? Number(state.min) : null;
    const max = state.max !== "" && state.max != null ? Number(state.max) : null;
    const payee = state.payee || "";
    return DB.records.filter((r) => {
      if (typeIdx != null && r.t !== typeIdx) return false;
      if (unit != null && r.u !== unit) return false;
      if (state.kind && DB.units[r.u].kind !== state.kind) return false;
      if (state.status && r.st !== state.status) return false;
      if (state.month && r.month !== state.month) return false;
      if (min != null && r.amt < min) return false;
      if (max != null && r.amt > max) return false;
      if (payee && DB.payees[r.p] !== payee) return false;
      if (tokens.length && !matchesTokens(r.text, tokens)) return false;
      return true;
    });
  }

  function viewRecords(params) {
    const state = {
      q: params.q || "", type: params.type || "", kind: params.kind || "", status: params.status || "", month: params.month || "",
      min: params.min || "", max: params.max || "", unit: params.unit || "", payee: params.payee || "",
      sort: params.sort || "amount", dir: params.dir || "desc", page: Math.max(1, Number(params.page) || 1),
    };
    const tokens = tokenize(state.q);
    const list = filterRecords(state);
    const { units, payees, descs, types, meta } = DB;
    const key = {
      amount: (r) => r.amt, date: (r) => r.date || "", unit: (r) => units[r.u].name, payee: (r) => payees[r.p],
      desc: (r) => descs[r.d], type: (r) => types[r.t].code,
    }[state.sort] || ((r) => r.amt);
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return state.dir === "asc" ? c : -c;
    });
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(state.page, pages);
    const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    let actual = 0, alloc = 0;
    for (const r of list) { if (r.allocated) alloc += r.amt; else actual += r.amt; }

    const opt = (v, label, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(label)}</option>`;
    const unitOptions = DB.unitStats.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => opt(s.id, s.name, state.unit)).join("");
    const active = [];
    if (state.payee) active.push(`<span class="chip">Payee: ${esc(state.payee)} <a href="${buildHash("records", { ...state, payee: "", page: "" })}" aria-label="Remove payee filter">✕</a></span>`);

    app.innerHTML = `
      <h1>All Records</h1>
      <p class="lede">Search all ${int.format(meta.rowCount)} lines. Words are matched across member/office, payee, description, voucher number, and dates. Use quotes for exact phrases, e.g. <code>"office rental"</code>.</p>
      <div class="filters">
        <label class="wide">Search<input type="search" id="rq" value="${esc(state.q)}" placeholder="e.g. verizon, chief of staff, bolton landing"></label>
        <label>Member / office<select id="runit"><option value="">All</option>${unitOptions}</select></label>
        <label>Expense type<select id="rtype"><option value="">All types</option>${types.map((t) => opt(t.code, t.label, state.type)).join("")}</select></label>
        <label>Members or offices<select id="rkind">${opt("", "Both", state.kind)}${opt("member", "Members only", state.kind)}${opt("office", "Offices only", state.kind)}</select></label>
        <label>Voucher month<select id="rmonth"><option value="">Any month</option>${DB.months.map((m) => opt(m, monthLabel(m), state.month)).join("")}</select></label>
        <label>Pay status<select id="rstatus"><option value="">Any</option>${DB.statuses.map((c) => opt(c, `${c} · ${meta.statusLabels[c] ? meta.statusLabels[c].split(" (")[0] : c}`, state.status)).join("")}</select></label>
        <label>Min $<input type="number" id="rmin" value="${esc(state.min)}" step="any" inputmode="decimal"></label>
        <label>Max $<input type="number" id="rmax" value="${esc(state.max)}" step="any" inputmode="decimal"></label>
      </div>
      <div class="toolbar">
        <span class="summary"><strong>${int.format(list.length)}</strong> records · actual <strong>${money(actual)}</strong>${alloc ? ` · allocated <strong>${money(alloc)}</strong>` : ""}</span>
        <span class="chips">${active.join("")}<button id="rreset">Clear filters</button><button id="rexport" class="primary"${list.length ? "" : " disabled"}>Export ${int.format(list.length)} as CSV</button></span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${sortHeader("Date", "date", state)}
          ${sortHeader("Member / office", "unit", state)}
          ${sortHeader("Type", "type", state)}
          ${sortHeader("Payee", "payee", state)}
          ${sortHeader("Description", "desc", state)}
          <th>Service dates</th><th>Status</th><th>Voucher</th>
          ${sortHeader("Amount", "amount", state, "num")}
        </tr></thead>
        <tbody>${slice.length ? slice.map((r) => `<tr>
          <td class="nowrap">${r.date ? fmtDate(r.date) : "—"}</td>
          <td><a href="${unitHref(r.u)}">${highlight(units[r.u].name, tokens)}</a></td>
          <td class="nowrap">${esc(types[r.t].code)}</td>
          <td>${highlight(payees[r.p], tokens)}</td>
          <td>${highlight(descs[r.d], tokens)}</td>
          <td class="nowrap mono">${highlight(r.svc, tokens)}</td>
          <td>${r.st ? `<span title="${esc(meta.statusLabels[r.st] || r.st)}">${esc(r.st)}</span>` : ""}</td>
          <td class="mono">${highlight(r.voucher, tokens)}</td>
          <td class="num${r.amt < 0 ? " neg" : ""}">${money(r.amt)}</td>
        </tr>`).join("") : `<tr><td colspan="9" class="empty">No records match these filters.</td></tr>`}</tbody>
      </table></div>
      <div class="pager">
        <button id="rprev"${page <= 1 ? " disabled" : ""}>← Prev</button>
        <span>Page ${page} of ${int.format(pages)}</span>
        <button id="rnext"${page >= pages ? " disabled" : ""}>Next →</button>
      </div>`;

    const update = (patch) => go("records", { ...state, page: "", ...patch }, true);
    const rq = app.querySelector("#rq");
    let timer;
    rq.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { update({ q: rq.value }); focusEnd("#rq"); }, 250); });
    [["#runit", "unit"], ["#rtype", "type"], ["#rkind", "kind"], ["#rmonth", "month"], ["#rstatus", "status"]].forEach(([sel, k]) =>
      app.querySelector(sel).addEventListener("change", (e) => update({ [k]: e.target.value })));
    [["#rmin", "min"], ["#rmax", "max"]].forEach(([sel, k]) => app.querySelector(sel).addEventListener("change", (e) => update({ [k]: e.target.value })));
    wireSortHeaders(app, state, update, { unit: "asc", payee: "asc", desc: "asc", type: "asc", date: "asc" });
    app.querySelector("#rreset").addEventListener("click", () => go("records", {}, true));
    app.querySelector("#rprev").addEventListener("click", () => { update({ page: page - 1 }); window.scrollTo(0, 0); });
    app.querySelector("#rnext").addEventListener("click", () => { update({ page: page + 1 }); window.scrollTo(0, 0); });
    app.querySelector("#rexport").addEventListener("click", () => downloadCSV("assembly-expenditures-filtered.csv",
      ["Period", "Voucher date", "Member/office", "Unit kind", "Expense type", "Payee", "Service dates", "Description", "Pay status", "Voucher", "Amount", "Allocated (informational)"],
      list.map((r) => [periodName(DB), r.date, units[r.u].name, units[r.u].kind, types[r.t].code, payees[r.p], r.svc, descs[r.d], r.st, r.voucher, r.amt.toFixed(2), r.allocated ? "yes" : "no"])));
    return null;
  }

  function viewPayees(params) {
    const state = { q: params.q || "", group: params.group || "", sort: params.sort || "total", dir: params.dir || "desc", page: Math.max(1, Number(params.page) || 1) };
    const tokens = tokenize(state.q);
    const isPs = (r) => DB.types[r.t].group === "ps";
    const agg = new Map();
    for (const r of DB.records) {
      if (r.allocated) continue;
      const isPayroll = isPs(r);
      if (state.group === "vendor" && isPayroll) continue;
      if (state.group === "person" && !isPayroll) continue;
      let a = agg.get(r.p);
      if (!a) { a = { p: r.p, total: 0, count: 0, units: new Set(), payroll: 0 }; agg.set(r.p, a); }
      a.total += r.amt; a.count++; a.units.add(r.u); if (isPayroll) a.payroll += r.amt;
    }
    let list = [...agg.values()].filter((a) => matchesTokens((DB.payees[a.p] || "").toLowerCase(), tokens));
    const key = { name: (a) => DB.payees[a.p], total: (a) => a.total, count: (a) => a.count, units: (a) => a.units.size }[state.sort] || ((a) => a.total);
    list.sort((a, b) => { const x = key(a), y = key(b); const c = typeof x === "string" ? x.localeCompare(y) : x - y; return state.dir === "asc" ? c : -c; });
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(state.page, pages);
    const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const opt = (v, label) => `<option value="${v}"${state.group === v ? " selected" : ""}>${label}</option>`;

    app.innerHTML = `
      <h1>Payees</h1>
      <p class="lede">Everyone the ${esc(CH.name)} paid this period — vendors for operations, people on payroll, and travel reimbursements — combined across all members and offices. Allocated costs are excluded.</p>
      <div class="filters">
        <label class="wide">Search payees<input type="search" id="pq" value="${esc(state.q)}" placeholder="e.g. national grid, smith"></label>
        <label>Show<select id="pgroup">${opt("", "All payments")}${opt("vendor", "Vendors &amp; travel (no payroll)")}${opt("person", "Payroll only")}</select></label>
      </div>
      <div class="toolbar"><span class="summary"><strong>${int.format(list.length)}</strong> payees</span></div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${sortHeader("Payee", "name", state)}
          ${sortHeader("Lines", "count", state, "num")}
          ${sortHeader("Members / offices", "units", state, "num")}
          ${sortHeader("Total paid", "total", state, "num")}
        </tr></thead>
        <tbody>${slice.length ? slice.map((a) => `<tr>
          <td><a href="${buildHash("records", { payee: DB.payees[a.p] })}">${highlight(DB.payees[a.p] || "(no payee listed)", tokens)}</a></td>
          <td class="num">${int.format(a.count)}</td>
          <td class="num" title="${esc([...a.units].slice(0, 8).map((u) => DB.units[u].name).join("; "))}${a.units.size > 8 ? "; …" : ""}">${a.units.size}</td>
          <td class="num${a.total < 0 ? " neg" : ""}">${money(a.total)}</td>
        </tr>`).join("") : `<tr><td colspan="4" class="empty">No payees match.</td></tr>`}</tbody>
      </table></div>
      <div class="pager">
        <button id="pprev"${page <= 1 ? " disabled" : ""}>← Prev</button>
        <span>Page ${page} of ${int.format(pages)}</span>
        <button id="pnext"${page >= pages ? " disabled" : ""}>Next →</button>
      </div>`;

    const update = (patch) => go("payees", { ...state, page: "", ...patch }, true);
    const pq = app.querySelector("#pq");
    let timer;
    pq.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { update({ q: pq.value }); focusEnd("#pq"); }, 200); });
    app.querySelector("#pgroup").addEventListener("change", (e) => update({ group: e.target.value }));
    wireSortHeaders(app, state, update, { name: "asc" });
    app.querySelector("#pprev").addEventListener("click", () => { update({ page: page - 1 }); window.scrollTo(0, 0); });
    app.querySelector("#pnext").addEventListener("click", () => { update({ page: page + 1 }); window.scrollTo(0, 0); });
    return null;
  }

  function monthlyFor(db, unitId) {
    const m = Object.fromEntries(db.months.map((k) => [k, 0]));
    for (const r of db.records) if (r.u === unitId && r.month && !r.allocated) m[r.month] += r.amt;
    return db.months.map((k) => ({ key: k, total: m[k] }));
  }
  function columns(series, opts = {}) {
    const max = opts.max || Math.max(...series.map((x) => x.total), 1);
    return `<div class="cols${opts.small ? " small" : ""}">${series.map((m) => `
      <a class="col" ${m.href ? `href="${m.href}"` : ""} title="${monthLabel(m.key)}: ${money(m.total)}">
        <span class="colval">${m.total ? compact(m.total) : "—"}</span>
        <span class="colbar" style="height:${(Math.max(m.total, 0) / max * 100).toFixed(1)}%"></span>
        <span class="collabel">${monthLabel(m.key)}</span>
      </a>`).join("")}</div>`;
  }

  /* Compare: units are identified by name so a comparison survives switching periods. */
  const MAX_COMPARE = 4;
  function compareNames(params) {
    return (params.u || "").split("|").map((x) => x.trim()).filter(Boolean).slice(0, MAX_COMPARE);
  }
  function viewCompare(params) {
    const names = compareNames(params);
    const picked = names.map((n) => DB.byName.get(n)).filter(Boolean);
    const missing = names.filter((n) => !DB.byName.get(n));
    const setNames = (list) => go("compare", { u: list.join("|") }, true);
    const options = DB.unitStats.slice().sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "member" ? -1 : 1))
      .filter((s) => !names.includes(s.name))
      .map((s) => `<option value="${esc(s.name)}">${esc(s.name)}${s.kind === "office" ? " (office)" : ""}</option>`).join("");

    const metric = (label, fn, fmt = money0, best = "max") => {
      const vals = picked.map(fn);
      const nums = vals.filter((v) => typeof v === "number");
      const hi = nums.length > 1 ? (best === "min" ? Math.min(...nums) : Math.max(...nums)) : null;
      return `<tr><th scope="row">${label}</th>${vals.map((v) => `<td class="num${v === hi ? " hi" : ""}">${v == null ? "—" : fmt(v)}</td>`).join("")}</tr>`;
    };
    const ps = (s) => prevUnit(s);
    const typeVal = (code) => (s) => s.byType[code] || 0;

    let body = "";
    if (picked.length) {
      const maxActual = Math.max(...picked.map((s) => s.actual), 1);
      body = `
      <div class="table-wrap"><table class="compare">
        <thead><tr><th></th>${picked.map((s) => `<th scope="col"><a href="${unitHref(s.id)}">${esc(s.name)}</a> ${kindChip(s.kind)}
          <button class="link remove" data-name="${esc(s.name)}" aria-label="Remove ${esc(s.name)}">✕</button></th>`).join("")}</tr></thead>
        <tbody>
          ${metric("Actual spending", (s) => s.actual)}
          ${metric("Payroll", typeVal("ps"))}
          ${metric("Maintenance &amp; operations", typeVal("mo"))}
          ${metric("Travel", typeVal("travel"))}
          ${metric("Allocated (informational)", (s) => s.allocated)}
          ${metric("People paid", (s) => s.staffCount, (v) => int.format(v))}
          ${metric("Rank among members", (s) => (s.kind === "member" ? s.rank : null), (v) => `#${v} of ${DB.members.length}`, "min")}
          ${metric("vs member median", (s) => (s.kind === "member" ? s.actual - DB.memberMedian : null), (v) => `${v >= 0 ? "+" : "−"}${money0(Math.abs(v))}`)}
          ${PREV ? `<tr><th scope="row">Change vs ${esc(periodName(PREV))}</th>${picked.map((s) => { const c = ps(s) ? change(s.actual, ps(s).actual) : null; return `<td class="num${c && c.diff < 0 ? " neg" : ""}">${c ? `${c.diff >= 0 ? "+" : "−"}${money0(Math.abs(c.diff))} (${changeText(c, true)})` : "—"}</td>`; }).join("")}</tr>` : ""}
        </tbody>
      </table></div>

      <section class="card"><div class="card-head"><h2>Spending mix</h2><span class="summary">bar length = share of the largest office's actual spending</span></div>
        ${picked.map((s) => {
          const seg = [["ps", "Payroll", "seg-ps"], ["mo", "M&O", "seg-mo"], ["travel", "Travel", "seg-tr"]];
          return `<div class="stack-row"><div class="stack-name"><a href="${unitHref(s.id)}">${esc(s.name)}</a><span>${money0(s.actual)}</span></div>
            <div class="stack" style="width:${(Math.max(s.actual, 0) / maxActual * 100).toFixed(1)}%">${seg.map(([code, label, cls]) => {
              const v = Math.max(s.byType[code] || 0, 0);
              return v ? `<span class="${cls}" style="flex:${v}" title="${label}: ${money(v)} (${(v / s.actual * 100).toFixed(0)}%)"></span>` : "";
            }).join("")}</div></div>`;
        }).join("")}
        <div class="legend"><span><i class="seg-ps"></i>Payroll</span><span><i class="seg-mo"></i>M&amp;O</span><span><i class="seg-tr"></i>Travel</span></div>
      </section>

      <section class="card"><div class="card-head"><h2>M&amp;O + travel by month</h2><span class="summary">same scale for all</span></div>
        <div class="grid compare-months">${(() => {
          const series = picked.map((s) => monthlyFor(DB, s.id));
          const shared = Math.max(1, ...series.flat().map((m) => m.total));
          return picked.map((s, i) => `<div><h3 class="mini">${esc(s.name)}</h3>${columns(series[i], { small: true, max: shared })}</div>`).join("");
        })()}</div>
      </section>

      <section class="card"><div class="card-head"><h2>Top M&amp;O purposes</h2></div>
        <div class="grid compare-months">${picked.map((s) => {
          const mo = DB.records.filter((r) => r.u === s.id && DB.types[r.t].group === "mo");
          const top = sumBy(mo, (r) => r.d).sort((a, b) => b.total - a.total).slice(0, 6);
          return `<div><h3 class="mini">${esc(s.name)}</h3>${bars(top.map((v) => ({ label: titleCase(DB.descs[v.key]), value: v.total })))}</div>`;
        }).join("")}</div>
      </section>`;
    } else {
      body = `<p class="empty">Pick up to ${MAX_COMPARE} members or offices above to compare them side by side.</p>`;
    }

    app.innerHTML = `
      <h1>Compare</h1>
      <p class="lede">Put up to ${MAX_COMPARE} members or offices side by side for ${esc(periodName(DB))}. The comparison stays put when you switch report periods; the highest value in each row (best rank) is highlighted.</p>
      <div class="filters">
        <label class="wide">Add a member or office
          <select id="cadd"${picked.length >= MAX_COMPARE ? " disabled" : ""}><option value="">${picked.length >= MAX_COMPARE ? `Limit of ${MAX_COMPARE} reached` : "Choose…"}</option>${options}</select></label>
        <label>Quick start<select id="cquick"><option value="">Choose…</option>
          <option value="top">Top 4 member offices</option><option value="median">Top, median &amp; lowest members</option></select></label>
      </div>
      ${missing.length ? `<p class="callout">Not in ${esc(periodName(DB))}: ${missing.map(esc).join(", ")}.</p>` : ""}
      ${picked.length ? `<div class="toolbar"><span></span><button id="cclear">Clear all</button></div>` : ""}
      ${body}`;

    app.querySelector("#cadd").addEventListener("change", (e) => { if (e.target.value) setNames([...names, e.target.value]); });
    app.querySelector("#cquick").addEventListener("change", (e) => {
      const m = DB.members;
      if (e.target.value === "top") setNames(m.slice(0, 4).map((s) => s.name));
      if (e.target.value === "median") setNames([m[0], m[Math.floor(m.length / 2)], m[m.length - 1]].map((s) => s.name));
    });
    const clr = app.querySelector("#cclear");
    if (clr) clr.addEventListener("click", () => setNames([]));
    app.querySelectorAll(".remove").forEach((b) => b.addEventListener("click", () => setNames(names.filter((n) => n !== b.dataset.name))));
    return null;
  }

  /* ---------- district map (plain SVG, no map library) ---------- */
  const MAP_METRICS = {
    actual: { label: "Actual spending", get: (s) => s.actual },
    ps: { label: "Payroll", get: (s) => s.byType.ps || 0 },
    mo: { label: "Maintenance & operations", get: (s) => s.byType.mo || 0 },
    travel: { label: "Travel", get: (s) => s.byType.travel || 0 },
    staff: { label: "People paid", get: (s) => s.staffCount, fmt: (v) => int.format(v) },
    change: { label: "Change vs prior period", get: (s) => { const p = prevUnit(s); return p ? s.actual - p.actual : null; }, diverging: true },
  };
  const SEQ = ["var(--seq-0)", "var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)"];
  const DIV = ["var(--div-0)", "var(--div-1)", "var(--div-2)", "var(--div-3)", "var(--div-4)"]; // decrease … increase
  const NYC_BOX = [-74.27, 40.49, -73.69, 40.92];

  function ringsOf(geom) {
    if (!geom) return [];
    if (geom.type === "Polygon") return geom.coordinates;
    if (geom.type === "MultiPolygon") return geom.coordinates.flat();
    return [];
  }
  function makeProjection(box, width) {
    const [x0, y0, x1, y1] = box;
    const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);
    const scale = width / ((x1 - x0) * k);
    const height = (y1 - y0) * scale;
    return { width, height, pt: ([lon, lat]) => [((lon - x0) * k * scale).toFixed(1), ((y1 - lat) * scale).toFixed(1)] };
  }
  function pathFor(geom, proj) {
    return ringsOf(geom).map((ring) => "M" + ring.map((c) => proj.pt(c).join(",")).join("L") + "Z").join("");
  }
  function bboxOf(features, filter) {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of features) {
      for (const ring of ringsOf(f.geometry)) for (const [x, y] of ring) {
        if (filter && !filter(x, y)) continue;
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
      }
    }
    return b;
  }
  function inBox(f, box) {
    // A district belongs in the NYC panel when its bounding box sits inside the city box.
    const b = bboxOf([f]);
    return b[0] >= box[0] - 0.02 && b[2] <= box[2] + 0.02 && b[1] >= box[1] - 0.02 && b[3] <= box[3] + 0.02;
  }
  function binsFor(values, diverging) {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return { color: () => "var(--map-none)", breaks: [] };
    if (diverging) {
      const m = Math.max(...v.map(Math.abs)) || 1;
      const breaks = [-m * 0.5, -m * 0.1, m * 0.1, m * 0.5];
      return { breaks, colors: DIV, color: (x) => x == null ? "var(--map-none)" : DIV[breaks.filter((b) => x > b).length] };
    }
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    const breaks = [q(0.2), q(0.4), q(0.6), q(0.8)];
    return { breaks, colors: SEQ, color: (x) => x == null ? "var(--map-none)" : SEQ[breaks.filter((b) => x >= b).length] };
  }

  function viewMap(params) {
    if (!DISTRICTS.length) return `<h1>District map</h1><p class="empty">District boundaries aren't available.</p>`;
    const metricKey = MAP_METRICS[params.m] && (params.m !== "change" || PREV) ? params.m : "actual";
    const metric = MAP_METRICS[metricKey];
    const party = params.party || "";
    const fmt = metric.fmt || money0;

    const rows = DISTRICTS.map((d) => {
      const s = d.unitName ? DB.byName.get(d.unitName) : null;
      const value = s ? metric.get(s) : null;
      return { d, s, value, dim: party && d.party !== party };
    });
    const scale = binsFor(rows.filter((r) => !r.dim).map((r) => r.value), metric.diverging);
    const nycFeatures = new Set(DISTRICTS.filter((d) => inBox(d, NYC_BOX)).map((d) => d.district));

    const panel = (features, box, width, id) => {
      const proj = makeProjection(box, width);
      return `<svg class="map" id="${id}" viewBox="0 0 ${width} ${proj.height.toFixed(0)}" role="img" aria-label="${esc(metric.label)} by ${esc(CH.name)} district">
        ${features.map((r) => `<path d="${pathFor(r.d.geometry, proj)}" fill="${r.dim ? "var(--surface)" : scale.color(r.value)}"
          class="district${r.dim ? " dim" : ""}" data-d="${r.d.district}" tabindex="0" aria-label="District ${r.d.district}, ${esc(r.d.member)}"></path>`).join("")}
      </svg>`;
    };
    const stateBox = bboxOf(DISTRICTS.map((d) => ({ geometry: d.geometry })));
    const stateRows = rows;
    const nycRows = rows.filter((r) => nycFeatures.has(r.d.district));

    const legend = scale.breaks.length ? `<div class="map-legend">
      ${scale.colors.map((c, i) => {
        const lo = i === 0 ? null : scale.breaks[i - 1], hi = i === scale.colors.length - 1 ? null : scale.breaks[i];
        const f = (v) => metric.diverging ? `${v >= 0 ? "+" : "−"}${compact(Math.abs(v))}` : (metric.fmt ? metric.fmt(Math.round(v)) : compact(v));
        const label = lo == null ? `under ${f(hi)}` : hi == null ? `${f(lo)}+` : `${f(lo)} – ${f(hi)}`;
        return `<span><i style="background:${c}"></i>${label}</span>`;
      }).join("")}
      <span><i style="background:var(--map-none)"></i>No data this period</span></div>` : "";

    const metricOpts = Object.entries(MAP_METRICS).filter(([k]) => k !== "change" || PREV)
      .map(([k, m]) => `<option value="${k}"${k === metricKey ? " selected" : ""}>${esc(m.label)}</option>`).join("");
    const parties = [...new Set(DISTRICTS.map((d) => d.party).filter(Boolean))].sort();

    const ranked = rows.filter((r) => r.value != null && !r.dim).sort((a, b) => b.value - a.value);
    const listItem = (r) => `<li><span class="name"><a href="${buildHash("district/" + r.d.district, {})}">${CH.abbr} ${r.d.district} · ${esc(r.d.member)}</a></span><span class="amt">${metric.diverging ? `${r.value >= 0 ? "+" : "−"}${money0(Math.abs(r.value))}` : fmt(r.value)}</span></li>`;

    app.innerHTML = `
      <h1>District map</h1>
      <p class="lede">Each member office's spending for ${esc(periodName(DB))}, shown on its ${esc(CH.name)} district. Hover or tap a district for details; click it for the district's full profile.</p>
      <div class="filters">
        <label>Color districts by<select id="mmetric">${metricOpts}</select></label>
        <label>Party<select id="mparty"><option value="">All members</option>${parties.map((p) => `<option${p === party ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
      </div>
      <div class="map-layout">
        <section class="card map-card"><div class="card-head"><h2>New York State</h2></div>${panel(stateRows, stateBox, 640, "mapState")}</section>
        <section class="card map-card"><div class="card-head"><h2>New York City</h2><span class="summary">zoomed in</span></div>${panel(nycRows, NYC_BOX, 420, "mapNyc")}</section>
      </div>
      ${legend}
      <div class="map-tip" id="mapTip" hidden></div>
      <div class="grid two">
        <section class="card"><div class="card-head"><h2>Highest: ${esc(metric.label.toLowerCase())}</h2></div><ul class="bars plain">${ranked.slice(0, 8).map(listItem).join("")}</ul></section>
        <section class="card"><div class="card-head"><h2>Lowest: ${esc(metric.label.toLowerCase())}</h2></div><ul class="bars plain">${ranked.slice(-8).reverse().map(listItem).join("")}</ul></section>
      </div>
      <p class="summary">Districts are the 2024 lines. Member names and party come from the New York State GIS district layer (as listed on the date it was published). A district shows no data when its current member wasn't in the selected report, e.g. a member elected after that period. Party colors are deliberately not used for spending.</p>`;

    const byDistrict = new Map(rows.map((r) => [String(r.d.district), r]));
    const tip = app.querySelector("#mapTip");
    const show = (el, x, y) => {
      const r = byDistrict.get(el.dataset.d);
      if (!r) return;
      const val = r.value == null ? "No data this period" : metric.diverging ? `${r.value >= 0 ? "+" : "−"}${money(Math.abs(r.value))}` : (metric.fmt ? metric.fmt(r.value) : money(r.value));
      tip.innerHTML = `<strong>${esc(CH.name)} District ${r.d.district}</strong><br>${esc(r.d.member)}${r.d.party ? ` · ${esc(r.d.party)}` : ""}<br>${esc(metric.label)}: <strong>${val}</strong>${r.s && r.s.rank ? `<br>Rank #${r.s.rank} of ${DB.members.length}` : ""}`;
      tip.hidden = false;
      const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - w - 8, x + pad) + "px";
      tip.style.top = Math.max(8, y - h - pad) + "px";
    };
    app.querySelectorAll("path.district").forEach((el) => {
      el.addEventListener("mousemove", (e) => show(el, e.clientX, e.clientY));
      el.addEventListener("mouseleave", () => { tip.hidden = true; });
      el.addEventListener("focus", () => { const b = el.getBoundingClientRect(); show(el, b.left + b.width / 2, b.top); });
      el.addEventListener("blur", () => { tip.hidden = true; });
      const open = () => { location.hash = buildHash("district/" + el.dataset.d, {}); };
      el.addEventListener("click", (e) => {
        // On touch screens the first tap shows details, the second opens the member page.
        if (window.matchMedia("(hover: none)").matches && tip.dataset.d !== el.dataset.d) {
          const b = el.getBoundingClientRect(); show(el, b.left + b.width / 2, b.top); tip.dataset.d = el.dataset.d; return;
        }
        open();
      });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    });
    const update = (patch) => go("map", { m: metricKey === "actual" ? "" : metricKey, party, ...patch }, true);
    app.querySelector("#mmetric").addEventListener("change", (e) => update({ m: e.target.value === "actual" ? "" : e.target.value }));
    app.querySelector("#mparty").addEventListener("change", (e) => update({ party: e.target.value }));
    return null;
  }

  /* ---------- district profile ---------- */
  const NEIGHBORS = new Map(); // district -> [district]
  function bboxCache(d) { return d._bb || (d._bb = bboxOf([d])); }
  function neighborsOf(d) {
    if (NEIGHBORS.has(d.district)) return NEIGHBORS.get(d.district);
    // Districts touch when any boundary point lies within ~150 m of the other's boundary.
    const tol = 0.0018, tol2 = tol * tol;
    const mine = ringsOf(d.geometry).flat();
    const bb = bboxCache(d);
    const out = [];
    for (const o of DISTRICTS) {
      if (o === d) continue;
      const ob = bboxCache(o);
      if (ob[0] > bb[2] + tol || ob[2] < bb[0] - tol || ob[1] > bb[3] + tol || ob[3] < bb[1] - tol) continue;
      const theirs = ringsOf(o.geometry).flat().filter(([x, y]) => x >= bb[0] - tol && x <= bb[2] + tol && y >= bb[1] - tol && y <= bb[3] + tol);
      let touch = false;
      outer: for (const [x1, y1] of theirs) {
        for (const [x2, y2] of mine) { const dx = x1 - x2, dy = y1 - y2; if (dx * dx + dy * dy < tol2) { touch = true; break outer; } }
      }
      if (touch) out.push(o);
    }
    NEIGHBORS.set(d.district, out);
    return out;
  }
  function percentile(value, values) {
    const v = values.filter((x) => x != null);
    if (!v.length || value == null) return null;
    return Math.round(v.filter((x) => x < value).length / v.length * 100);
  }

  function viewDistrict(arg) {
    const num = Number(arg);
    const d = DISTRICTS.find((x) => x.district === num);
    if (!d) return `<p class="empty">District not found. <a href="${buildHash("map", {})}">Back to the map</a>.</p>`;
    const s = d.unitName ? DB.byName.get(d.unitName) : null;
    const nbrs = neighborsOf(d).slice().sort((a, b) => a.district - b.district);
    const unitOf = (x) => (x.unitName ? DB.byName.get(x.unitName) : null);
    const idx = DISTRICTS.findIndex((x) => x === d);
    const prevD = DISTRICTS[(idx - 1 + DISTRICTS.length) % DISTRICTS.length], nextD = DISTRICTS[(idx + 1) % DISTRICTS.length];
    const dHref = (x) => buildHash("district/" + x.district, {});

    // Locator: zoom to the district and its neighbors; neighbors shaded by actual spending.
    const focus = [d, ...nbrs];
    const fb = bboxOf(focus.map((x) => ({ geometry: x.geometry })));
    const padX = (fb[2] - fb[0]) * 0.06, padY = (fb[3] - fb[1]) * 0.06;
    const box = [fb[0] - padX, fb[1] - padY, fb[2] + padX, fb[3] + padY];
    const proj = makeProjection(box, 560);
    const scale = binsFor(DISTRICTS.map((x) => (unitOf(x) ? unitOf(x).actual : null)), false);
    const zoomSvg = `<svg class="map" id="mapZoom" viewBox="0 0 560 ${proj.height.toFixed(0)}" role="img" aria-label="District ${d.district} and neighboring districts">
      ${focus.map((x) => { const u = unitOf(x); return `<path d="${pathFor(x.geometry, proj)}" class="district${x === d ? " focus" : ""}" data-d="${x.district}"
        fill="${scale.color(u ? u.actual : null)}" tabindex="0" aria-label="District ${x.district}"></path>`; }).join("")}
      ${focus.map((x) => { const b = bboxCache(x); const [cx, cy] = proj.pt([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]); return `<text x="${cx}" y="${cy}" class="dlabel${x === d ? " focus" : ""}">${x.district}</text>`; }).join("")}
    </svg>`;
    const stateBox = bboxOf(DISTRICTS.map((x) => ({ geometry: x.geometry })));
    const sp = makeProjection(stateBox, 220);
    const fbPx = [sp.pt([fb[0], fb[3]]), sp.pt([fb[2], fb[1]])].map((a) => a.map(Number));
    const locator = `<svg class="map locator" viewBox="0 0 220 ${sp.height.toFixed(0)}" aria-hidden="true">
      ${DISTRICTS.map((x) => `<path d="${pathFor(x.geometry, sp)}" fill="${x === d ? "var(--accent)" : "var(--border)"}"></path>`).join("")}
      <rect x="${fbPx[0][0] - 3}" y="${fbPx[0][1] - 3}" width="${Math.max(6, fbPx[1][0] - fbPx[0][0] + 6)}" height="${Math.max(6, fbPx[1][1] - fbPx[0][1] + 6)}" class="locbox"></rect>
    </svg>`;

    const picker = `<select id="dpick" aria-label="Choose a district">${DISTRICTS.map((x) => `<option value="${x.district}"${x === d ? " selected" : ""}>${CH.abbr} ${x.district} · ${esc(x.member)}</option>`).join("")}</select>`;
    const head = `
      <div class="crumbs"><a href="${buildHash("map", {})}">← District map</a></div>
      <div class="title-row district-head">
        <div><h1>${esc(CH.name)} District ${d.district}</h1>
          <p class="lede">${esc(d.member)}${d.party ? ` · ${esc(d.party)}` : ""}${s ? ` · <a href="${unitHref(s.id)}">member office page →</a>` : ""}</p></div>
        <div class="dnav"><a class="btn" href="${dHref(prevD)}" aria-label="Previous district">← ${CH.abbr} ${prevD.district}</a>${picker}<a class="btn" href="${dHref(nextD)}" aria-label="Next district">${CH.abbr} ${nextD.district} →</a></div>
      </div>`;

    if (!s) {
      return `${head}<div class="map-layout"><section class="card">${zoomSvg}</section><section class="card">${locator}
        <p class="empty">${/^vacant$/i.test(d.member) ? `The state's district layer lists this seat as vacant, so there's no member office to show.` : `No spending data for this district's member in ${esc(periodName(DB))}. Their office may not appear in this report (for example, a member who took office after it). Try the other report period in the header.`}</p></section></div>`;
    }

    const members = DB.members;
    const metrics = [
      ["Actual spending", (u) => u.actual, money0],
      ["Payroll", (u) => u.byType.ps || 0, money0],
      ["Maintenance & operations", (u) => u.byType.mo || 0, money0],
      ["Travel", (u) => u.byType.travel || 0, money0],
      ["People paid", (u) => u.staffCount, (v) => int.format(v)],
    ];
    const gauges = metrics.map(([label, fn, fmt]) => {
      const v = fn(s), pct = percentile(v, members.map(fn));
      const med = (() => { const a = members.map(fn).sort((x, y) => x - y), m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; })();
      return `<div class="gauge"><div class="gauge-top"><span>${esc(label)}</span><strong>${fmt(v)}</strong></div>
        <div class="gauge-track" title="Higher than ${pct}% of member offices"><span class="gauge-med" style="left:50%"></span><span class="gauge-dot" style="left:${pct}%"></span></div>
        <div class="gauge-foot"><span>Higher than <b>${pct}%</b> of members</span><span>median ${fmt(med)}</span></div></div>`;
    }).join("");

    const ps = prevUnit(s);
    const periodsBars = PERIODS.slice().reverse().map((pm) => { const u = dbFor(pm.id).byName.get(s.name); return { key: pm.id, label: periodName(dbFor(pm.id)), total: u ? u.actual : 0, cur: pm.id === DB.id }; });
    const maxP = Math.max(1, ...periodsBars.map((x) => x.total));

    const nbrRows = [d, ...nbrs].map((x) => ({ x, u: unitOf(x) })).filter((r) => r.u).sort((a, b) => b.u.actual - a.u.actual);
    const maxN = Math.max(1, ...nbrRows.map((r) => r.u.actual));
    const mo = DB.records.filter((r) => r.u === s.id && DB.types[r.t].group === "mo");
    const topMo = sumBy(mo, (r) => r.d).sort((a, b) => b.total - a.total).slice(0, 6);
    const seg = [["ps", "Payroll", "seg-ps"], ["mo", "M&O", "seg-mo"], ["travel", "Travel", "seg-tr"]];
    const compareHref = buildHash("compare", { u: [s, ...nbrRows.filter((r) => r.x !== d).slice(0, 3).map((r) => r.u)].map((u) => u.name).join("|") });

    app.innerHTML = `${head}
      <div class="map-layout">
        <section class="card"><div class="card-head"><h2>District ${d.district} and its neighbors</h2><span class="summary">shaded by actual spending · click a neighbor</span></div>${zoomSvg}</section>
        <div>
          <section class="card"><div class="card-head"><h2>Where it is</h2></div>${locator}</section>
          <section class="card"><div class="card-head"><h2>How it ranks</h2><span class="summary">#${s.rank} of ${members.length}</span></div>${gauges}</section>
        </div>
      </div>
      <div class="grid two">
        <section class="card"><div class="card-head"><h2>Where the money went</h2><span class="summary">${money0(s.actual)}</span></div>
          <div class="stack big">${seg.map(([code, label, cls]) => { const v = Math.max(s.byType[code] || 0, 0); return v ? `<span class="${cls}" style="flex:${v}" title="${label}: ${money(v)}"></span>` : ""; }).join("")}</div>
          <div class="legend">${seg.map(([code, label, cls]) => `<span><i class="${cls}"></i>${label} ${money0(s.byType[code] || 0)} (${((s.byType[code] || 0) / s.actual * 100).toFixed(0)}%)</span>`).join("")}</div>
          <h3 class="mini" style="margin-top:14px">Top operating expenses</h3>${bars(topMo.map((v) => ({ label: titleCase(DB.descs[v.key]), value: v.total })))}</section>
        <section class="card"><div class="card-head"><h2>Compared with neighboring districts</h2><a href="${compareHref}">Compare side by side →</a></div>
          <ul class="bars">${nbrRows.map((r) => `<li class="${r.x === d ? "me" : ""}"><span class="name"><a href="${dHref(r.x)}">${CH.abbr} ${r.x.district} · ${esc(r.x.member)}</a></span><span class="amt">${money0(r.u.actual)}</span>
            <span class="track"><span class="fill${r.x === d ? "" : " alt"}" style="width:${(r.u.actual / maxN * 100).toFixed(1)}%"></span></span></li>`).join("")}</ul></section>
        <section class="card"><div class="card-head"><h2>Across report periods</h2>${ps ? `<span class="summary">${changeText(change(s.actual, ps.actual))}</span>` : ""}</div>
          <div class="cols">${periodsBars.map((m) => `<a class="col" href="${buildHash("district/" + d.district, { p: m.key === PERIODS[0].id ? "" : m.key })}" title="${esc(m.label)}: ${money(m.total)}">
            <span class="colval">${m.total ? compact(m.total) : "—"}</span><span class="colbar${m.cur ? "" : " dimbar"}" style="height:${(m.total / maxP * 100).toFixed(1)}%"></span><span class="collabel">${esc(m.label)}</span></a>`).join("")}</div></section>
        <section class="card"><div class="card-head"><h2>M&amp;O + travel by month</h2><span class="summary">click a month for its records</span></div>
          ${columns(monthlyFor(DB, s.id).map((m) => ({ ...m, href: buildHash("records", { unit: s.id, month: m.key }) })))}</section>
      </div>
      <p class="summary">Neighbors are districts that share a boundary. Use ← → on your keyboard to step through districts.</p>`;

    app.querySelector("#dpick").addEventListener("change", (e) => { location.hash = buildHash("district/" + e.target.value, {}); });
    app.querySelectorAll("#mapZoom path.district").forEach((el) => {
      const go2 = () => { if (Number(el.dataset.d) !== d.district) location.hash = buildHash("district/" + el.dataset.d, {}); };
      el.addEventListener("click", go2);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") go2(); });
      const x = DISTRICTS.find((q) => String(q.district) === el.dataset.d), u = unitOf(x);
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = `${CH.abbr} ${x.district} · ${x.member}${u ? ` · ${money0(u.actual)}` : ""}`;
      el.appendChild(t);
    });
    return null;
  }
  document.addEventListener("keydown", (e) => {
    if (parseHash().view !== "district" || /input|select|textarea/i.test((e.target.tagName || ""))) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const a = app.querySelector(`.dnav a[aria-label="${e.key === "ArrowLeft" ? "Previous" : "Next"} district"]`);
    if (a) location.hash = a.getAttribute("href");
  });

  function viewAbout() {
    const { meta, types } = DB;
    const isA = CH.id === "assembly";
    const gisLayer = isA ? "NYS_Assembly_Districts" : "NYS_Senate_Districts";
    const allocatedNote = isA
      ? `Mail, telephone, and supplies lines are each office's share of costs paid centrally in Albany. The Assembly's report states these are shown for informational purposes only and do not reflect actual expenditures.`
      : `"Allocated operational expenses" are each office's share of postage and supplies. The Senate's report notes they are allocated back to offices after the fact, that the original vouchers appear under the central offices (Post Office and Senate Supply), and that the amounts are for informational purposes only.`;
    return `<div class="about">
      <h1>About the data</h1>
      <p class="lede">This site presents the semi-annual Expenditure Reports of the New York State Assembly and the New York State Senate. Every line in each original file is included; nothing is added or removed. Use the chamber buttons and period menu at the top to switch. You're viewing the <strong>${esc(CH.name)}</strong>.</p>
      <section class="card"><h2>Reports included</h2><div class="table-wrap"><table>
        <thead><tr><th>Chamber</th><th>Period</th><th>Source file</th><th class="num">Lines</th><th class="num">Actual spending</th><th class="num">Allocated</th></tr></thead>
        <tbody>${CHAMBERS.map((c) => c.periods.map((pm) => `<tr><td>${esc(c.name)}</td><td>${fmtDate(pm.start)} – ${fmtDate(pm.end)}</td><td class="mono">${esc(pm.sourceFile)}</td><td class="num">${int.format(pm.rowCount)}</td><td class="num">${money(pm.totalActual)}</td><td class="num">${money(pm.totalAllocated)}</td></tr>`).join("")).join("")}</tbody>
      </table></div></section>
      <div class="callout"><strong>Allocated costs are not actual spending.</strong> ${allocatedNote} This site keeps them separate from "actual" totals.</div>
      <section class="card"><h2>${esc(CH.name)} expense types (${esc(periodName(DB))})</h2><dl class="glossary">
        ${types.map((t) => `<dt>${esc(t.code)}</dt><dd>${esc(t.label)} — ${int.format(meta.typeCounts[t.code] || 0)} lines${t.allocated ? " (allocated, informational)" : ""}</dd>`).join("")}
      </dl></section>
      <section class="card"><h2>${esc(CH.name)} pay status codes</h2><p>Shown on payroll lines${isA ? "; reflects each employee's payroll type as of the end of the period" : ""}.</p><dl class="glossary">
        ${Object.entries(meta.statusLabels).map(([c, l]) => `<dt>${esc(c)}</dt><dd>${esc(l)}</dd>`).join("")}
      </dl></section>
      <section class="card"><h2>Notes on how the data was prepared</h2><ul>
        <li><strong>Members vs. offices.</strong> A member office is ${esc(CH.memberRule)} (${meta.members} in this ${esc(CH.name)} report, including members who joined or left during the period). All others (${meta.offices}) are central offices, committees, and programs.</li>
        <li><strong>Actual spending</strong> is payroll + maintenance &amp; operations + travel${isA ? "" : " (member and staff travel combined)"}. For a member office it includes the member's own salary.</li>
        ${isA ? `<li><strong>Voucher dates</strong> in the Assembly source have no year (e.g. "9-Oct"); the year is taken from the report period.</li>
        <li><strong>Names are truncated</strong> to 40 characters in the Assembly source (e.g. "LEGISLATIVE TASK FORCE ON REAPPORTIONMEN"); they're shown as published.</li>
        <li><strong>"CHARGEBACK"</strong> payees are charges between the Assembly and other state entities.</li>`
        : `<li><strong>Dates and vouchers.</strong> The Senate file gives a check date for each non-payroll line; the voucher number is taken from the end of its description ("… - VOUCHER# 79534").</li>
        <li><strong>Pay types</strong> (RA, SA, TE, VA) are shown as published; the Senate report doesn't define them.</li>
        <li><strong>Vacant district offices</strong> (e.g. "47TH SENATORIAL DISTRICT") appear as their own offices, as in the report.</li>`}
        <li><strong>Period comparisons</strong> match members and offices by their name as printed in each report. A member who joined or left between periods has no comparison.</li>
        <li><strong>Payroll lines</strong> have no voucher date; they carry service dates instead, so they don't appear in the by-month charts or month filter.</li>
        <li><strong>Negative amounts</strong> (${int.format(DB.records.filter((r) => r.amt < 0).length)} lines here) are refunds or adjustments and are included in totals as reported.</li>
        <li><strong>District map.</strong> Boundaries are the 2024 ${esc(CH.name)} district lines from the New York State GIS "${gisLayer}" layer, which also supplies each district's member name and party. Those names are matched to the reports by last name${isA ? ` (two by hand: AD 20 "Ari Brown" = BROWN, ERIC G.; AD 59 "Jaime R. Williams" = RIVAS-WILLIAMS, JAIME)` : ""}. Because the layer lists current members, a member who left before it was published (or joined after a report period) has no district shading for that period.${isA ? "" : " The layer lists Senate District 12 as vacant."}</li>
      </ul></section>
      <section class="card"><h2>Sources</h2><ul>
        <li>Assembly expenditure reports: <a href="https://assembly.ny.gov/expenditure/" target="_blank" rel="noopener">assembly.ny.gov/expenditure</a></li>
        <li>Senate expenditure reports: <a href="https://www.nysenate.gov/open-data" target="_blank" rel="noopener">nysenate.gov/open-data</a></li>
        <li>District boundaries, member names and party: NYS ITS Geospatial Services — <a href="https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Assembly_Districts/MapServer" target="_blank" rel="noopener">Assembly Districts</a>, <a href="https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Senate_Districts/MapServer" target="_blank" rel="noopener">Senate Districts</a></li>
      </ul><p>This is an independent presentation of public records and is not affiliated with or endorsed by the New York State Assembly or Senate.</p></section>
    </div>`;
  }


  /* ---------- render loop ---------- */
  function focusEnd(sel) {
    const el = app.querySelector(sel);
    if (!el) return;
    el.focus();
    const v = el.value; el.value = ""; el.value = v;
  }
  function setActiveTab(view) {
    const tab = { overview: "overview", units: "units", unit: "units", records: "records", payees: "payees", about: "about", compare: "compare", map: "map", district: "map" }[view] || "overview";
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  }
  let lastView = "";
  function render() {
    if (!CHAMBERS.length) return;
    const { view, arg, params } = parseHash();
    const before = DB && CH ? CH.id + DB.id : "";
    selectChamber(params.c || CHAMBERS[0].id);
    selectPeriod(params.p || PERIODS[0].id);
    syncPeriodUI();
    if (before && before !== CH.id + DB.id) lastView = "";
    setActiveTab(view);
    let html;
    switch (view) {
      case "units": html = viewUnits(params); break;
      case "unit": html = viewUnit(arg); break;
      case "records": html = viewRecords(params); break;
      case "payees": html = viewPayees(params); break;
      case "about": html = viewAbout(); break;
      case "compare": html = viewCompare(params); break;
      case "map": html = viewMap(params); break;
      case "district": html = viewDistrict(arg); break;
      default: html = viewOverview();
    }
    if (html != null) app.innerHTML = html;
    const key = view + (arg || "");
    if (key !== lastView) { window.scrollTo(0, 0); lastView = key; }
    if (view === "records") document.getElementById("globalSearchInput").value = params.q || "";
  }

  function syncPeriodUI() {
    const sel = document.getElementById("periodSelect");
    if (sel.dataset.chamber !== CH.id) {
      sel.innerHTML = PERIODS.map((pm) => `<option value="${esc(pm.id)}">${esc(periodName(dbFor(pm.id)))}</option>`).join("");
      sel.dataset.chamber = CH.id;
    }
    if (!sel.dataset.wired) {
      sel.dataset.wired = "1";
      sel.addEventListener("change", () => {
        const { view, arg, params } = parseHash();
        // Unit ids differ between periods: carry the unit across by name.
        if (view === "unit") {
          const cur = DB.unitStats[Number(arg)];
          const target = cur && dbFor(sel.value).byName.get(cur.name);
          if (target) { location.hash = buildHash("unit/" + target.id, { p: sel.value }); return; }
          location.hash = buildHash("units", { p: sel.value }); return;
        }
        const keep = { ...params, p: sel.value, page: "" };
        if (view === "records") delete keep.unit;
        location.hash = buildHash(view === "overview" ? "" : view, keep);
      });
    }
    sel.value = DB.id;
    document.getElementById("sourceFile").textContent = DB.meta.sourceFile;
    const sw = document.getElementById("chamberSwitch");
    if (!sw.dataset.wired) {
      sw.dataset.wired = "1";
      sw.innerHTML = CHAMBERS.map((c) => `<button type="button" data-c="${esc(c.id)}">${esc(c.name)}</button>`).join("");
      sw.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-c]");
        if (!b || b.dataset.c === CH.id) return;
        const { view, params } = parseHash();
        // Offices, districts and comparisons belong to one chamber; keep the view, drop the specifics.
        const nextView = { unit: "units", district: "map", compare: "compare" }[view] || (view === "overview" ? "" : view);
        const keep = view === "records" ? { q: params.q || "", type: "", month: params.month || "" } : view === "map" ? { m: params.m || "" } : {};
        location.hash = buildHash(nextView, { ...keep, c: b.dataset.c, p: params.p || "" });
      });
    }
    sw.querySelectorAll("button").forEach((b) => { b.classList.toggle("on", b.dataset.c === CH.id); b.setAttribute("aria-pressed", b.dataset.c === CH.id); });
    document.title = `NY ${CH.name} Expenditures · ${periodName(DB)}`;
    // Keep the chamber and period when moving between tabs.
    const tabView = { overview: "", units: "units", records: "records", map: "map", compare: "compare", payees: "payees", about: "about" };
    document.querySelectorAll(".tabs a[data-tab]").forEach((a) => { a.href = buildHash(tabView[a.dataset.tab] ?? a.dataset.tab, {}); });
    const brand = document.querySelector(".brand-title");
    if (brand) brand.href = buildHash("", {});
  }

  document.getElementById("globalSearch").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("globalSearchInput").value.trim();
    go("records", { q });
  });
  window.addEventListener("hashchange", render);

  load().then(() => {
    render();
  }).catch((err) => {
    console.error(err);
    app.innerHTML = `<p class="empty">Couldn't load the data file. If you opened index.html directly from disk, run a local server instead (see README).</p>`;
  });
})();
