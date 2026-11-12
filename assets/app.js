/* NYS Assembly Expenditures explorer — vanilla JS, no dependencies. */
(function () {
  "use strict";

  const app = document.getElementById("app");
  const PAGE_SIZE = 50;
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let DB = null;      // currently selected period
  let PREV = null;    // the period before it, for comparisons (or null)
  let PERIODS = [];   // manifest, newest first
  const DBS = {};     // period id -> indexed data

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
    for (const [k, v] of Object.entries(params || {})) if (v !== "" && v != null) clean[k] = v;
    if (!explicitP && DB && PERIODS.length && DB.id !== PERIODS[0].id) clean.p = DB.id;
    if (clean.p && PERIODS.length && clean.p === PERIODS[0].id) delete clean.p;
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
    const bundled = window.__EXPENDITURE_PERIODS__;
    PERIODS = bundled ? bundled.manifest : await (await fetch("data/periods.json")).json();
    await Promise.all(PERIODS.map(async (pm) => {
      const raw = bundled ? bundled.data[pm.id] : await (await fetch(pm.file)).json();
      DBS[pm.id] = indexPeriod(pm.id, raw);
    }));
  }

  function selectPeriod(id) {
    const i = Math.max(0, PERIODS.findIndex((pm) => pm.id === id));
    DB = DBS[PERIODS[i].id];
    PREV = PERIODS[i + 1] ? DBS[PERIODS[i + 1].id] : null;
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
      byType: {}, actual: 0, allocated: 0, count: 0, staff: new Set(),
    }));
    for (const r of records) {
      const s = unitStats[r.u];
      const code = types[r.t].code;
      s.byType[code] = (s.byType[code] || 0) + r.amt;
      if (r.allocated) s.allocated += r.amt; else s.actual += r.amt;
      s.count++;
      if (code === "PERSSERV") s.staff.add(r.p);
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
    const out = Object.fromEntries(db.types.map((t) => [t.code, 0]));
    for (const r of db.records) out[db.types[r.t].code] += r.amt;
    return out;
  }

  /* ---------- views ---------- */
  function viewOverview() {
    const { meta, records, unitStats, types, payees, descs } = DB;
    const totalBy = totalsByType(DB);
    const prevBy = PREV ? totalsByType(PREV) : null;
    const vs = (code) => prevBy ? changeText(change(totalBy[code], prevBy[code])) : "";
    const staffAll = new Set(records.filter((r) => types[r.t].code === "PERSSERV").map((r) => r.p));

    const byMonth = sumBy(records.filter((r) => r.month && !r.allocated), (r) => r.month).sort((a, b) => a.key.localeCompare(b.key));
    const maxMonth = Math.max(...byMonth.map((m) => m.total)) || 1;

    const topMembers = DB.members.slice(0, 10).map((s) => ({ label: s.name, value: s.actual, href: `#/unit/${s.id}` }));
    const topOffices = unitStats.filter((s) => s.kind === "office").sort((a, b) => b.actual - a.actual).slice(0, 10)
      .map((s) => ({ label: s.name, value: s.actual, href: `#/unit/${s.id}` }));
    const mo = records.filter((r) => types[r.t].code === "M & O");
    const topVendors = sumBy(mo, (r) => r.p).sort((a, b) => b.total - a.total).slice(0, 10)
      .map((x) => ({ label: payees[x.key] || "(no payee listed)", value: x.total, href: buildHash("records", { payee: payees[x.key], type: "M & O" }) }));
    const topDescs = sumBy(mo, (r) => r.d).sort((a, b) => b.total - a.total).slice(0, 10)
      .map((x) => ({ label: titleCase(descs[x.key]), value: x.total, href: buildHash("records", { q: `"${descs[x.key].toLowerCase()}"`, type: "M & O" }) }));

    const typeBars = types.map((t) => ({ label: t.label, value: totalBy[t.code], alt: t.allocated, href: buildHash("records", { type: t.code }) }))
      .sort((a, b) => b.value - a.value);

    return `
      <h1>Where the Assembly's money went</h1>
      <p class="lede">Every line of the New York State Assembly Expenditure Report for ${fmtDate(meta.period.start)} – ${fmtDate(meta.period.end)}:
        ${int.format(meta.rowCount)} records across ${meta.members} member offices and ${meta.offices} central offices and committees.</p>
      <div class="grid kpis">
        ${kpi("Actual spending", compact(meta.totalActual), PREV ? changeText(change(meta.totalActual, PREV.meta.totalActual)) : "Payroll + M&amp;O + travel")}
        ${kpi("Payroll", compact(totalBy["PERSSERV"]), `${int.format(staffAll.size)} people paid${PREV ? "<br>" + vs("PERSSERV") : ""}`)}
        ${kpi("Maintenance &amp; operations", compact(totalBy["M & O"]), PREV ? vs("M & O") : "Rent, utilities, services")}
        ${kpi("Travel", compact(totalBy["TRAVEL"]), PREV ? vs("TRAVEL") : "Reimbursed to members &amp; staff")}
        ${kpi("Allocated costs", compact(meta.totalAllocated), "Informational only — see About")}
      </div>
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
    const state = { q: params.q || "", kind: params.kind || "", sort: params.sort || "actual", dir: params.dir || "desc" };
    const tokens = tokenize(state.q);
    let list = DB.unitStats.filter((s) => (!state.kind || s.kind === state.kind) && matchesTokens(s.name.toLowerCase(), tokens));
    const val = {
      name: (s) => s.name, actual: (s) => s.actual, ps: (s) => s.byType["PERSSERV"] || 0, mo: (s) => s.byType["M & O"] || 0,
      travel: (s) => s.byType["TRAVEL"] || 0, allocated: (s) => s.allocated, staff: (s) => s.staffCount,
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
      <p class="lede">Each Assembly member's office and each central office, committee, and task force in the report. Click a name for its full breakdown.</p>
      <div class="filters">
        <label class="wide">Filter by name<input type="search" id="uq" value="${esc(state.q)}" placeholder="e.g. Thiele, Ways and Means, minority"></label>
        <label>Show<select id="ukind">
          <option value="">Members and offices</option>
          <option value="member"${state.kind === "member" ? " selected" : ""}>Members only</option>
          <option value="office"${state.kind === "office" ? " selected" : ""}>Offices only</option>
        </select></label>
      </div>
      <div class="toolbar"><span class="summary"><strong>${int.format(list.length)}</strong> shown · actual spending <strong>${money0(total)}</strong></span>
        <button id="uexport">Export CSV</button></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th scope="col">#</th>
          ${sortHeader("Name", "name", state)}
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
          <td>${kindChip(s.kind)}</td>
          <td class="num">${money0(s.byType["PERSSERV"] || 0)}</td>
          <td class="num">${money0(s.byType["M & O"] || 0)}</td>
          <td class="num">${money0(s.byType["TRAVEL"] || 0)}</td>
          <td class="num"><strong>${money0(s.actual)}</strong></td>
          <td class="num">${money0(s.allocated)}</td>
          <td class="num">${s.staffCount}</td>
          ${PREV ? (() => { const c = change(s.actual, prevUnit(s) && prevUnit(s).actual); return `<td class="num${c && c.diff < 0 ? " neg" : ""}" title="${c ? esc(changeText(c)) : "Not in prior period"}">${changeText(c, true)}</td>`; })() : ""}
        </tr>`).join("") : `<tr><td colspan="10" class="empty">No members or offices match.</td></tr>`}</tbody>
      </table></div>`;
    app.innerHTML = html;

    const update = (patch) => go("units", { ...state, ...patch }, true);
    const uq = app.querySelector("#uq");
    let timer;
    uq.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { update({ q: uq.value }); focusEnd("#uq"); }, 200); });
    app.querySelector("#ukind").addEventListener("change", (e) => update({ kind: e.target.value }));
    wireSortHeaders(app, state, update, { name: "asc" });
    app.querySelector("#uexport").addEventListener("click", () => downloadCSV("assembly-units.csv",
      ["Period", "Name", "Type", "Payroll", "M&O", "Travel", "Actual total", "Allocated", "People paid"],
      list.map((s) => [periodName(DB), s.name, s.kind, (s.byType["PERSSERV"] || 0).toFixed(2), (s.byType["M & O"] || 0).toFixed(2), (s.byType["TRAVEL"] || 0).toFixed(2), s.actual.toFixed(2), s.allocated.toFixed(2), s.staffCount])));
    return null;
  }

  function viewUnit(id) {
    const s = DB.unitStats[Number(id)];
    if (!s) return `<p class="empty">That member or office wasn't found. <a href="${buildHash("units", {})}">Back to the list</a>.</p>`;
    const { types, payees, descs, meta } = DB;
    const recs = DB.records.filter((r) => r.u === s.id);
    const code = (r) => types[r.t].code;
    const staffRows = recs.filter((r) => code(r) === "PERSSERV").sort((a, b) => b.amt - a.amt);
    const mo = recs.filter((r) => code(r) === "M & O");
    const travel = recs.filter((r) => code(r) === "TRAVEL").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const vendors = sumBy(mo, (r) => r.p).sort((a, b) => b.total - a.total);
    const moDescs = sumBy(mo, (r) => r.d).sort((a, b) => b.total - a.total).slice(0, 10);
    const allocated = types.filter((t) => t.allocated).map((t) => ({ label: t.label, value: s.byType[t.code] || 0, alt: true }));

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
      <h1>${esc(s.name)} ${kindChip(s.kind)}</h1>
      <p class="lede">${rankNote || "Central office, committee, or task force."}</p>
      <div class="grid kpis">
        ${kpi("Actual spending", money0(s.actual), ps ? changeText(change(s.actual, ps.actual)) : (PREV ? "Not in prior period" : ""))}
        ${kpi("Payroll", money0(s.byType["PERSSERV"] || 0), `${s.staffCount} ${s.staffCount === 1 ? "person" : "people"} paid${vsPrev(s.byType["PERSSERV"] || 0, ps && (ps.byType["PERSSERV"] || 0))}`)}
        ${kpi("Maintenance &amp; operations", money0(s.byType["M & O"] || 0), `${vendors.length} payees${vsPrev(s.byType["M & O"] || 0, ps && (ps.byType["M & O"] || 0))}`)}
        ${kpi("Travel", money0(s.byType["TRAVEL"] || 0), `${travel.length} reimbursements${vsPrev(s.byType["TRAVEL"] || 0, ps && (ps.byType["TRAVEL"] || 0))}`)}
        ${kpi("Allocated", money0(s.allocated), "Informational only")}
      </div>

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
        <div class="card-head"><h2>Travel</h2><span class="summary">${money(s.byType["TRAVEL"] || 0)}</span></div>
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
    const others = PERIODS.filter((pm) => pm.id !== DB.id).map((pm) => ({ pm, u: DBS[pm.id].byName.get(s.name) })).filter((x) => x.u);
    if (!others.length) return "";
    return `<p class="summary">Also in: ${others.map((x) => `<a href="${buildHash("unit/" + x.u.id, { p: x.pm.id === PERIODS[0].id ? "" : x.pm.id })}">${esc(periodName(DBS[x.pm.id]))}</a>`).join(" · ")}</p>`;
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
    const ps = DB.typeIndex["PERSSERV"];
    const agg = new Map();
    for (const r of DB.records) {
      if (r.allocated) continue;
      const isPayroll = r.t === ps;
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
      <p class="lede">Everyone the Assembly paid this period — vendors for operations, people on payroll, and travel reimbursements — combined across all members and offices. Allocated costs are excluded.</p>
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

  function viewAbout() {
    const { meta, types } = DB;
    return `<div class="about">
      <h1>About the data</h1>
      <p class="lede">This site presents the New York State Assembly's semi-annual Expenditure Reports. Every line in each original file is included; nothing is added or removed. Use the period menu at the top to switch reports.</p>
      <section class="card"><h2>Reports included</h2><div class="table-wrap"><table>
        <thead><tr><th>Period</th><th>Source file</th><th class="num">Lines</th><th class="num">Actual spending</th><th class="num">Allocated</th></tr></thead>
        <tbody>${PERIODS.map((pm) => `<tr><td>${fmtDate(pm.start)} – ${fmtDate(pm.end)}</td><td class="mono">${esc(pm.sourceFile)}</td><td class="num">${int.format(pm.rowCount)}</td><td class="num">${money(pm.totalActual)}</td><td class="num">${money(pm.totalAllocated)}</td></tr>`).join("")}</tbody>
      </table></div></section>
      <div class="callout"><strong>Allocated costs are not actual spending.</strong> Mail, telephone, and supplies lines are each office's share of costs paid centrally in Albany. The Assembly's report states these are shown for informational purposes only and do not reflect actual expenditures, so this site keeps them separate from "actual" totals.</div>
      <section class="card"><h2>Expense types (${esc(periodName(DB))})</h2><dl class="glossary">
        ${types.map((t) => `<dt>${esc(t.code)}</dt><dd>${esc(t.label)} — ${int.format(meta.typeCounts[t.code] || 0)} lines${t.allocated ? " (allocated, informational)" : ""}</dd>`).join("")}
      </dl></section>
      <section class="card"><h2>Pay status codes</h2><p>Shown on payroll lines; reflects each employee's payroll type as of the end of the period.</p><dl class="glossary">
        ${Object.entries(meta.statusLabels).map(([c, l]) => `<dt>${esc(c)}</dt><dd>${esc(l)}</dd>`).join("")}
      </dl></section>
      <section class="card"><h2>Notes on how the data was prepared</h2><ul>
        <li><strong>Members vs. offices.</strong> A unit is treated as a member office when it contains a "MEMBER OF ASSEMBLY" payroll line (${meta.members} in ${esc(periodName(DB))}). All others (${meta.offices}) are central offices, committees, and task forces.</li>
        <li><strong>Voucher dates</strong> in the source have no year (e.g. "9-Oct"); the year is taken from the report period (for an October–March report, October–December fall in the first year and January–March in the second).</li>
        <li><strong>Period comparisons</strong> match members and offices by their name as printed in each report. A member who joined or left between periods has no comparison.</li>
        <li><strong>Payroll lines</strong> have no voucher date; they carry service dates instead, so they don't appear in the by-month chart or month filter.</li>
        <li><strong>Negative amounts</strong> (${int.format(DB.records.filter((r) => r.amt < 0).length)} lines) are refunds or adjustments and are included in totals as reported.</li>
        <li><strong>Names are truncated</strong> to 40 characters in the source (e.g. "LEGISLATIVE TASK FORCE ON REAPPORTIONMEN"); they're shown as published.</li>
        <li><strong>"CHARGEBACK"</strong> payees are charges between the Assembly and other state entities.</li>
        <li>"Actual spending" for a member office includes the member's own salary, staff payroll, M&amp;O, and travel.</li>
      </ul></section>
      <section class="card"><h2>Source</h2><p>Expenditure reports are published by the Assembly at <a href="${esc(meta.sourceUrl)}" target="_blank" rel="noopener">assembly.ny.gov/expenditure</a>. This is an independent presentation of those public records and is not affiliated with or endorsed by the New York State Assembly.</p></section>
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
    const tab = { overview: "overview", units: "units", unit: "units", records: "records", payees: "payees", about: "about" }[view] || "overview";
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  }
  let lastView = "";
  function render() {
    if (!PERIODS.length) return;
    const { view, arg, params } = parseHash();
    const before = DB && DB.id;
    selectPeriod(params.p || PERIODS[0].id);
    syncPeriodUI();
    if (before && before !== DB.id) lastView = "";
    setActiveTab(view);
    let html;
    switch (view) {
      case "units": html = viewUnits(params); break;
      case "unit": html = viewUnit(arg); break;
      case "records": html = viewRecords(params); break;
      case "payees": html = viewPayees(params); break;
      case "about": html = viewAbout(); break;
      default: html = viewOverview();
    }
    if (html != null) app.innerHTML = html;
    const key = view + (arg || "");
    if (key !== lastView) { window.scrollTo(0, 0); lastView = key; }
    if (view === "records") document.getElementById("globalSearchInput").value = params.q || "";
  }

  function syncPeriodUI() {
    const sel = document.getElementById("periodSelect");
    if (!sel.options.length) {
      sel.innerHTML = PERIODS.map((pm) => `<option value="${esc(pm.id)}">${esc(periodName(DBS[pm.id]))}</option>`).join("");
      sel.addEventListener("change", () => {
        const { view, arg, params } = parseHash();
        // Unit ids differ between periods: carry the unit across by name.
        if (view === "unit") {
          const cur = DB.unitStats[Number(arg)];
          const target = cur && DBS[sel.value].byName.get(cur.name);
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
