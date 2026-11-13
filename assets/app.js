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
  const BALLOTPEDIA = {}; // chamber id -> {office name: profile url}
  const CAMPAIGN = {};
  const MAKEUP = {};
  const DONATIONS = {};
  const DEMOG = {}; // chamber id -> Census ACS 2020-24 by district
  const ENROLL = {}; // chamber id -> State Board of Elections enrollment (registered voters) by district
  const PUBFIN = {}; // chamber id -> Public Campaign Finance Program participants by district (2026)
  let VENDOR_DONORS = null; // chamber id -> donations in depth by district (2025-26) // chamber id -> party makeup now and after the Nov 3, 2026 count // chamber id -> campaign finance by district (State Board of Elections, 2025-26)
  let BUDGET = null; // Legislature appropriations from the FY 2027 Executive Budget
  const MEMBERS = {};     // chamber id -> {office name: {district, contact, roles, offices, assumedOffice, election}}
  let ELECTION_SOURCES = {};
  const dbFor = (periodId, chamberId) => DBS[(chamberId || CH.id) + "/" + periodId];

  /* ---------- icons: one stroke family, drawn inline ---------- */
  const svg = (d, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
  const I = {
    r: svg("M5 12h14M13 6l6 6-6 6"),
    l: svg("M19 12H5M11 6l-6 6 6 6"),
    ext: svg("M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"),
    up: svg("M12 19V5M6 11l6-6 6 6", "tiny"),
    down: svg("M12 5v14M6 13l6 6 6-6", "tiny"),
    x: svg("M6 6l12 12M18 6L6 18", "tiny"),
  };

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
    await loadElectionSources(bundled);
    await loadBudget(bundled);
    try { VENDOR_DONORS = bundled ? bundled.data["data/vendor_donors.json"] || null : await (await fetch("data/vendor_donors.json")).json(); } catch (e) { VENDOR_DONORS = null; }
    await Promise.all(CHAMBERS.map(async (ch) => {
      await Promise.all(ch.periods.map(async (pm) => {
        const raw = bundled ? bundled.data[pm.file] : await (await fetch(pm.file)).json();
        const db = indexPeriod(pm.id, raw);
        if (pm.travel) {
          try {
            const t = bundled ? bundled.data[pm.travel] : await (await fetch(pm.travel)).json();
            db.travel = { categories: t.categories, byUnit: new Map() };
            for (const trip of t.trips) {
              const [u, check, begin, end, dest, purpose, amounts, total] = trip;
              if (!db.travel.byUnit.has(u)) db.travel.byUnit.set(u, []);
              db.travel.byUnit.get(u).push({ check, begin, end, dest, purpose, amounts, total });
            }
          } catch (e) { /* trips are optional */ }
        }
        DBS[ch.id + "/" + pm.id] = db;
      }));
      try {
        DIST[ch.id] = bundled ? bundled.data[ch.districts] || [] : await (await fetch(ch.districts)).json();
      } catch (e) { DIST[ch.id] = []; }
      DIST_BY_UNIT[ch.id] = new Map(DIST[ch.id].filter((d) => d.unitName).map((d) => [d.unitName, d]));
      try {
        const mFile = `data/${ch.id}/members.json`;
        MEMBERS[ch.id] = bundled ? bundled.data[mFile] || {} : await (await fetch(mFile)).json();
      } catch (e) { MEMBERS[ch.id] = {}; }
      try {
        const bpFile = `data/${ch.id}/ballotpedia.json`;
        BALLOTPEDIA[ch.id] = bundled ? bundled.data[bpFile] || {} : await (await fetch(bpFile)).json();
      } catch (e) { BALLOTPEDIA[ch.id] = {}; }
      try {
        const dmFile = `data/${ch.id}/demographics.json`;
        DEMOG[ch.id] = bundled ? bundled.data[dmFile] || null : await (await fetch(dmFile)).json();
      } catch (e) { DEMOG[ch.id] = null; }
      try {
        const dnFile = `data/${ch.id}/donations.json`;
        DONATIONS[ch.id] = bundled ? bundled.data[dnFile] || null : await (await fetch(dnFile)).json();
      } catch (e) { DONATIONS[ch.id] = null; }
      try {
        const mkFile = `data/${ch.id}/makeup.json`;
        MAKEUP[ch.id] = bundled ? bundled.data[mkFile] || null : await (await fetch(mkFile)).json();
      } catch (e) { MAKEUP[ch.id] = null; }
      try {
        const cfFile = `data/${ch.id}/campaign_finance.json`;
        CAMPAIGN[ch.id] = bundled ? bundled.data[cfFile] || null : await (await fetch(cfFile)).json();
      } catch (e) { CAMPAIGN[ch.id] = null; }
      try {
        const enFile = `data/${ch.id}/enrollment.json`;
        ENROLL[ch.id] = bundled ? bundled.data[enFile] || null : await (await fetch(enFile)).json();
      } catch (e) { ENROLL[ch.id] = null; }
      try {
        const pfFile = `data/${ch.id}/public_financing.json`;
        PUBFIN[ch.id] = bundled ? bundled.data[pfFile] || null : await (await fetch(pfFile)).json();
      } catch (e) { PUBFIN[ch.id] = null; }
    }));
  }

  async function loadBudget(bundled) {
    try { BUDGET = bundled ? bundled.data["data/budget/legislature.json"] || null : await (await fetch("data/budget/legislature.json")).json(); } catch (e) { BUDGET = null; }
  }
  async function loadElectionSources(bundled) {
    try { ELECTION_SOURCES = bundled ? bundled.data["data/election_sources.json"] || {} : await (await fetch("data/election_sources.json")).json(); } catch (e) { ELECTION_SOURCES = {}; }
  }

  /* Senate biweekly payroll history: loaded the first time a view needs it. */
  const PAYROLL = {};
  let payrollLoading = null;
  function payroll() {
    if (CH.id !== "senate") return null;
    if (PAYROLL.senate !== undefined) return PAYROLL.senate;
    if (!payrollLoading) payrollLoading = (async () => {
      try {
        const b = window.__EXPENDITURE_BUNDLE__;
        const raw = b ? b.data["data/senate/payroll.json"] : await (await fetch("data/senate/payroll.json")).json();
        PAYROLL.senate = raw ? { ...raw, last: raw.reports.length - 1 } : null;
      } catch (e) { PAYROLL.senate = null; }
      payrollLoading = null;
      render();
    })();
    return undefined;
  }
  function rateText(rate, type, short) {
    if (type === "TE") return `${money(rate)}/hr`;
    return short ? `${money0(rate * 26)}/yr` : `${money(rate)} biweekly · ${money0(rate * 26)}/yr`;
  }
  function payNow(pr, name, office) {
    const segs = pr && pr.people[name];
    if (!segs) return null;
    const cur = segs.filter((g) => g[5] === pr.last);
    if (!cur.length) return { gone: segs[segs.length - 1] };
    return { seg: cur.find((g) => pr.offices[g[0]] === office) || cur[0] };
  }
  function fmtRepDay(pr, i) { return fmtDay(pr.reports[i][0]); }

  /* Salaried payroll summed over every biweekly report, by check-date year. */
  function payrollYearsCard(pr) {
    if (!pr || !pr.years) return "";
    const ys = Object.entries(pr.years);
    const full = (v) => v.reports >= 25;
    const max = Math.max(1, ...ys.map(([, v]) => v.salary));
    const last = ys[ys.length - 1], prevFull = ys.filter(([, v]) => full(v)).slice(-2);
    const chg = prevFull.length === 2 ? (prevFull[1][1].salary / prevFull[0][1].salary - 1) * 100 : null;
    return `<section class="card"><div class="card-head"><h2>Senate payroll by year</h2><span class="summary">every biweekly payroll report, summed by check date${chg != null ? ` · ${prevFull[1][0]} was ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% on ${prevFull[0][0]}` : ""}</span></div>
      <div class="cols">${ys.map(([y, v]) => `<div class="col${full(v) ? "" : " partial"}" title="${y}: ${money(v.salary)} salaried payroll on ${v.reports} reports" role="img" aria-label="${y}: ${money0(v.salary)} salaried payroll, ${v.reports} reports${full(v) ? "" : ", partial year"}">
        <span class="colval">${compact(v.salary)}</span><span class="colbar${full(v) ? "" : " dimbar"}" style="height:${(v.salary / max * 100).toFixed(1)}%"></span><span class="collabel">${y}${full(v) ? "" : "*"}</span></div>`).join("")}</div>
      <details class="yeartable"><summary>Year-by-year table</summary><div class="table-wrap"><table>
        <caption class="sr-only">Senate payroll by year from biweekly payroll reports</caption>
        <thead><tr><th scope="col">Year</th><th scope="col" class="num">Reports</th><th scope="col" class="num">Salaried payroll</th><th scope="col" class="num">Regular annual</th><th scope="col" class="num">Special annual</th><th scope="col" class="num">People paid</th><th scope="col" class="num">Hourly staff</th><th scope="col" class="num">Median hourly rate</th></tr></thead>
        <tbody>${ys.slice().reverse().map(([y, v]) => `<tr><th scope="row">${y}${full(v) ? "" : "*"}</th><td class="num">${v.reports}</td><td class="num"><strong>${money0(v.salary)}</strong></td><td class="num">${money0(v.ra)} <span class="summary">· ${int.format(v.ra_people)}</span></td><td class="num">${money0(v.sa)} <span class="summary">· ${int.format(v.sa_people)}</span></td><td class="num">${int.format(v.people)}</td><td class="num">${int.format(v.te_people)}</td><td class="num">${v.te_median_rate != null ? money(v.te_median_rate) : "—"}</td></tr>`).join("")}</tbody></table></div></details>
      <p class="summary">Salaried payroll is the sum of every Regular Annual and Special Annual employee's biweekly rate on each report, so it's payroll at listed rates, not checks cashed. Temporary staff are paid by the hour and the reports give no hours, so they're counted rather than summed. Members' own salaries aren't in these reports. * Partial year: ${ys.filter(([, v]) => !full(v)).map(([y, v]) => `${y} (${v.reports} reports${y === last[0] ? ", through " + esc(fmtRepDay(pr, pr.last)) : ""})`).join(", ")}; a few reports are also missing from the Senate's archive. Pay types: <abbr title="Appointed for at least 1,820 hours a year (35 hours a week) and expected to be on the payroll year round">RA</abbr> regular annual, <abbr title="Appointed for fewer than 1,820 hours, or for less than a full year">SA</abbr> special annual, <abbr title="Irregular schedule, paid an hourly wage">TE</abbr> temporary (hourly).</p>
    </section>`;
  }
  function officeYearsCard(pr, officeName) {
    if (!pr || !pr.officeYears) return "";
    const oi = pr.offices.indexOf(officeName);
    const ys = oi >= 0 ? Object.entries(pr.officeYears[String(oi)] || {}).sort() : [];
    if (ys.length < 2) return "";
    const max = Math.max(1, ...ys.map(([, v]) => v[0]));
    return `<section class="card"><div class="card-head"><h2>Staff payroll by year</h2><span class="summary">salaried staff at listed biweekly rates, from every Senate payroll report · by check date</span></div>
      <div class="cols small">${ys.map(([y, v]) => { const part = (pr.years[y] || {}).reports < 25; return `<div class="col${part ? " partial" : ""}" title="${y}: ${money(v[0])}, ${v[1]} people" role="img" aria-label="${y}: ${money0(v[0])} for ${v[1]} salaried staff${part ? ", partial year" : ""}">
        <span class="colval">${compact(v[0])}</span><span class="colbar${part ? " dimbar" : ""}" style="height:${(v[0] / max * 100).toFixed(1)}%"></span><span class="collabel">${y}${part ? "*" : ""}</span></div>`; }).join("")}</div>
      <p class="summary">* partial year. Hourly staff and the senator's own salary aren't included.</p></section>`;
  }

  /* ---------- Descriptive statistics, both chambers side by side ---------- */
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function describe(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const n = v.length;
    if (!n) return null;
    const sum = v.reduce((a, b) => a + b, 0), mean = sum / n;
    const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return { n, sum, mean, sd, cv: mean ? sd / mean : 0, min: v[0], p10: quantile(v, .1), p25: quantile(v, .25), median: quantile(v, .5), p75: quantile(v, .75), p90: quantile(v, .9), max: v[n - 1] };
  }
  /* Party makeup of each chamber, drawn as a semicircular floor plan: now, and after the Nov 3, 2026 unofficial count. */
  function hemicycle(cells, rows, majority, label, center) {
    // Seats sit on concentric arcs; each arc gets seats in proportion to its length, then every seat
    // is ordered by angle so parties fill the chamber left to right, as on a real floor plan.
    const W = 300, H = 166, cx = W / 2, cy = 152, r0 = 58, r1 = 140;
    const radii = Array.from({ length: rows }, (_, i) => r0 + (r1 - r0) * (rows === 1 ? 0 : i / (rows - 1)));
    const total = radii.reduce((a, b) => a + b, 0);
    let counts = radii.map((r) => Math.floor(cells.length * r / total));
    let left = cells.length - counts.reduce((a, b) => a + b, 0);
    for (let i = rows - 1; left > 0; i = (i - 1 + rows) % rows, left--) counts[i]++;
    const pts = [];
    radii.forEach((r, i) => { const n = counts[i]; for (let j = 0; j < n; j++) { const a = Math.PI - (n === 1 ? Math.PI / 2 : (j / (n - 1)) * Math.PI); pts.push({ a, x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) }); } });
    pts.sort((p, q) => q.a - p.a || p.y - q.y);
    const rad = Math.min(5.6, (r1 - r0) / rows * 0.42, Math.PI * r0 / (counts[0] || 1) * 0.42);
    return `<figure class="hemi"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
      ${pts.map((pt, i) => { const c = cells[i]; return `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${rad.toFixed(2)}" class="seat p${c.k[0]}${c.k.endsWith("?") ? " close" : ""}"><title>${esc(c.t)}</title></circle>`; }).join("")}
      <text x="${cx}" y="${cy - 18}" class="hemi-big">${esc(center[0])}</text><text x="${cx}" y="${cy - 2}" class="hemi-small">${esc(center[1])}</text>
    </svg><figcaption>${esc(label.split(":")[0])}</figcaption></figure>`;
  }
  function makeupCard() {
    const chs = CHAMBERS.filter((c) => MAKEUP[c.id]);
    if (!chs.length) return "";
    const PN = { D: "Democratic", R: "Republican", O: "Other", V: "Vacant" };
    const order = { D: 0, "D?": 1, O: 2, V: 3, "R?": 4, R: 5 };
    const describeSeats = (cells) => { const counts = {}; for (const c of cells) counts[c.k] = (counts[c.k] || 0) + 1; return Object.keys(order).filter((k) => counts[k]).map((k) => `${counts[k]} ${k.endsWith("?") ? PN[k[0]] + " leading, not yet decided" : PN[k]}`).join(", "); };
    return `<section class="card makeup"><div class="card-head"><h2>Party makeup, now and after the election</h2><span class="summary">one dot per seat · after = leader in the State Board's unofficial count, ${esc(MAKEUP[chs[0].id].asOf)}</span></div>
      <div class="makeup-grid">${chs.map((c) => {
        const m = MAKEUP[c.id];
        const now = m.districts.map((r) => ({ k: r[1], t: `${c.abbr} ${r[0]}: ${PN[r[1]]}` })).sort((a, b) => order[a.k] - order[b.k]);
        const after = m.districts.map((r) => ({ k: r[3] ? r[2] : r[2] + "?", t: `${c.abbr} ${r[0]}: ${r[5]} (${PN[r[2]] || r[2]})${r[3] ? "" : `, leads by ${r[4]} pts, not yet decided`}${r[1] !== r[2] && r[1] !== "V" ? ", would change party" : ""}` })).sort((a, b) => order[a.k] - order[b.k]);
        const cnt = (arr, k) => arr.filter((x) => x.k === k).length;
        const flips = m.districts.filter((r) => r[1] !== r[2] && "DR".includes(r[1]));
        const toD = flips.filter((r) => r[2] === "D").length, toR = flips.filter((r) => r[2] === "R").length;
        const rows = c.id === "assembly" ? 8 : 5;
        const dNow = cnt(now, "D"), rNow = cnt(now, "R"), dA = cnt(after, "D") + cnt(after, "D?"), rA = cnt(after, "R") + cnt(after, "R?");
        return `<div class="makeupchamber"><h3>${esc(c.title || c.name)} <span class="summary">${m.seats} seats · ${m.majority} for a majority</span></h3>
          <div class="hemis">
            ${hemicycle(now, rows, m.majority, `Now, 2025–26: ${describeSeats(now)}. ${m.majority} seats make a majority.`, [`${dNow}–${rNow}`, "D–R"])}
            ${hemicycle(after, rows, m.majority, `After Nov 3, unofficial: ${describeSeats(after)}. ${m.majority} seats make a majority.`, [`${dA}–${rA}`, "D–R incl. leading"])}
          </div>
          <p class="makeup-sum"><span class="pd">Democrats ${dNow} → ${cnt(after, "D")}${cnt(after, "D?") ? ` + ${cnt(after, "D?")} leading` : ""}</span> · <span class="pr">Republicans ${rNow} → ${cnt(after, "R")}${cnt(after, "R?") ? ` + ${cnt(after, "R?")} leading` : ""}</span>${cnt(now, "V") ? ` · ${cnt(now, "V")} vacant now` : ""} · ${flips.length} seats change party (${toD} to D, ${toR} to R)</p></div>`;
      }).join("")}</div>
      <div class="legend"><span><svg class="lg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" class="seat pD"/></svg>Democratic</span><span><svg class="lg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" class="seat pR"/></svg>Republican</span><span><svg class="lg" viewBox="0 0 24 12" aria-hidden="true"><circle cx="6" cy="6" r="4.4" class="seat pD close"/><circle cx="18" cy="6" r="4.4" class="seat pR close"/></svg>Leading, not yet decided</span><span><svg class="lg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" class="seat pV"/></svg>Vacant</span></div>
      <p class="summary">Party is the first ballot line of the member or leading candidate (most also ran on the Working Families or Conservative line). "Not yet decided" uses the same rule as the member pages: a lead under 2 points of ballots cast, or under 5 points while election districts are still out. Unofficial until certified. Hover a seat for its district.</p>
    </section>`;
  }

  function viewStats() {
    const sets = CHAMBERS.map((c) => {
      const pm = c.periods.find((x) => x.id === DB.id) || c.periods[0];
      return { c, db: dbFor(pm.id, c.id) };
    }).filter((x) => x.db);
    const metrics = [
      ["Actual spending per member office", (db) => db.members.map((s) => s.actual), money0],
      ["Cost per month per member office", (db) => db.members.map((s) => s.perMonth), money0],
      ["Office cost per resident", (db) => db.members.map((s) => { const d = (DIST_BY_UNIT[db.meta.chamber] || new Map()).get(s.name); const g = d && demog(d.district, db.meta.chamber); return g && g.pop ? s.actual / g.pop : NaN; }), (v) => money(v)],
      ["Registered voters per district", (db) => db.members.map((s) => { const d = (DIST_BY_UNIT[db.meta.chamber] || new Map()).get(s.name); const e = d && enroll(d.district, db.meta.chamber); return e ? e.total : NaN; }), (v) => int.format(Math.round(v))],
      ["Office cost per registered voter", (db) => db.members.map((s) => { const d = (DIST_BY_UNIT[db.meta.chamber] || new Map()).get(s.name); const e = d && enroll(d.district, db.meta.chamber); return e && e.total ? s.actual / e.total : NaN; }), (v) => money(v)],
      ["Payroll per member office", (db) => db.members.map((s) => s.byType.ps || 0), money0],
      ["Maintenance & operations per member office", (db) => db.members.map((s) => s.byType.mo || 0), money0],
      ["Travel per member office", (db) => db.members.map((s) => s.byType.travel || 0), money0],
      ["Allocated costs per member office", (db) => db.members.map((s) => s.allocated || 0), money0],
      ["People paid per member office", (db) => db.members.map((s) => s.staffCount), (x) => int.format(Math.round(x))],
      ["Annualized pay, member-office staff", (db) => db.salaries.filter((x) => db.unitStats[x.u] && db.unitStats[x.u].kind === "member" && !/^MEMBER( OF ASSEMBLY)?$/.test(x.titles)).map((x) => x.annual), money0],
      ["Annualized pay, central-office staff", (db) => db.salaries.filter((x) => db.unitStats[x.u] && db.unitStats[x.u].kind === "office").map((x) => x.annual), money0],
      ["Actual spending per central office", (db) => db.unitStats.filter((s) => s.kind === "office").map((s) => s.actual), money0],
    ];
    const cols = [["n", "N", (v) => int.format(v)], ["mean", "Mean"], ["median", "Median"], ["sd", "Std. dev."], ["min", "Min"], ["p25", "25th pct"], ["p75", "75th pct"], ["p90", "90th pct"], ["max", "Max"]];
    const box = (rows, fmt) => {
      const lo = Math.min(...rows.map((r) => r.d.min)), hi = Math.max(...rows.map((r) => r.d.max)) || 1;
      const x = (v) => ((v - lo) / (hi - lo || 1) * 100).toFixed(2);
      return `<div class="boxes" aria-hidden="true">${rows.map((r) => `<div class="boxrow"><span class="boxlab">${esc(r.c.name)}</span><div class="boxtrack">
        <span class="whisk" style="left:${x(r.d.p10)}%;width:${(x(r.d.p90) - x(r.d.p10)).toFixed(2)}%"></span>
        <span class="iqr ${r.c.id}" style="left:${x(r.d.p25)}%;width:${Math.max(.6, x(r.d.p75) - x(r.d.p25)).toFixed(2)}%"></span>
        <span class="med" style="left:${x(r.d.median)}%"></span><span class="mean" style="left:${x(r.d.mean)}%"></span></div></div>`).join("")}
        <div class="boxscale"><span>${fmt(lo)}</span><span>${fmt(hi)}</span></div></div>`;
    };
    const head = sets.map((x) => { const t = x.db.meta; return `<div class="statchamber"><h2>${esc(x.c.name)}</h2><p class="summary">${esc(periodName(x.db))}${x.db.id !== DB.id ? " (latest report)" : ""}</p>
      <dl class="statgrid"><div><dt>Actual spending</dt><dd>${money0(t.totalActual)}</dd></div><div><dt>Per month</dt><dd>${money0(t.totalActual / x.db.periodMonths)}</dd></div>
      <div><dt>Member offices</dt><dd>${int.format(t.members)}</dd></div><div><dt>Central offices</dt><dd>${int.format(t.offices)}</dd></div>
      <div><dt>People paid</dt><dd>${int.format(new Set(x.db.records.filter((r) => x.db.types[r.t].group === "ps").map((r) => r.p)).size)}</dd></div>
      <div><dt>Report lines</dt><dd>${int.format(t.rowCount)}</dd></div>
      <div><dt>Member offices' share</dt><dd>${(x.db.members.reduce((a, s) => a + s.actual, 0) / t.totalActual * 100).toFixed(1)}%</dd></div>
      <div><dt>Top 10% of member offices</dt><dd>${(() => { const a = x.db.members.map((s) => s.actual).sort((p, q) => q - p); const k = Math.max(1, Math.round(a.length / 10)); return (a.slice(0, k).reduce((p, q) => p + q, 0) / a.reduce((p, q) => p + q, 0) * 100).toFixed(1) + "% of member spending"; })()}</dd></div></dl></div>`; }).join("");
    return `<h1>Statistics</h1>
      <p class="lede">Descriptive statistics for the ${sets.map((x) => esc(x.c.name)).join(" and ")}, side by side, for ${esc(periodName(DB))}. Member offices are compared with member offices, so the figures are per office, not per chamber.</p>
      <div class="grid two statheads">${head}</div>
      ${makeupCard()}
      ${metrics.map(([label, get, fmt]) => {
        const rows = sets.map((x) => ({ c: x.c, d: describe(get(x.db)) })).filter((r) => r.d);
        if (!rows.length) return "";
        return `<section class="card stat"><div class="card-head"><h2>${esc(label)}</h2><span class="summary">box = middle half (25th–75th percentile) · line = median · dot = mean · whiskers = 10th–90th</span></div>
          ${box(rows, fmt)}
          <div class="table-wrap"><table><caption class="sr-only">${esc(label)}: descriptive statistics by chamber</caption>
            <thead><tr><th scope="col">Chamber</th>${cols.map(([, l]) => `<th scope="col" class="num">${l}</th>`).join("")}</tr></thead>
            <tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.c.name)}</th>${cols.map(([k, , f]) => `<td class="num">${(f || fmt)(r.d[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
      }).join("")}
      <p class="summary">Std. dev. is the sample standard deviation. Percentiles are interpolated. Annualized pay uses the same method as the Salaries page and leaves out members' own salaries. Pick another report period in the header to recompute; a period only one chamber reported shows that chamber's figures next to the other chamber's latest report.</p>`;
  }

  /* ---------- Senate biweekly payroll ---------- */
  function viewPayroll(params) {
    if (CH.id !== "senate") {
      return `<h1>Payroll</h1><p class="lede">The Senate publishes a payroll report every two weeks, with each employee's office, title, pay type and rate. The Assembly doesn't publish one; its staff pay is in the six-month expenditure reports, on the Salaries page.</p>
        <p><a class="btn" href="${buildHash("payroll", { c: "senate", p: "" })}">Open the Senate payroll ${I.r}</a> <a class="btn" href="${buildHash("salaries", {})}">Assembly salaries ${I.r}</a></p>`;
    }
    const pr = payroll();
    if (pr === undefined) return `<h1>Senate payroll</h1><p class="empty">Loading 416 biweekly payroll reports…</p>`;
    if (!pr) return `<h1>Senate payroll</h1><p class="empty">The payroll history couldn't be loaded.</p>`;
    const q = (params.q || "").trim().toLowerCase();
    const cur = [];
    for (const [name, segs] of Object.entries(pr.people)) for (const g of segs) if (g[5] === pr.last) cur.push({ name, g });
    const sal = cur.filter((x) => x.g[3] !== "TE"), te = cur.filter((x) => x.g[3] === "TE");
    const annual = sal.map((x) => x.g[2] * 26);
    const byOffice = new Map();
    for (const x of sal) { const o = pr.offices[x.g[0]]; const v = byOffice.get(o) || { n: 0, amt: 0 }; v.n++; v.amt += x.g[2] * 26; byOffice.set(o, v); }
    const topOff = [...byOffice.entries()].sort((a, b) => b[1].amt - a[1].amt).slice(0, 12);
    const maxO = Math.max(1, ...topOff.map(([, v]) => v.amt));
    const top = sal.slice().sort((a, b) => b.g[2] - a.g[2]).slice(0, 15);
    const d = describe(annual);
    const found = q ? Object.keys(pr.people).filter((n) => n.toLowerCase().includes(q)).slice(0, 40) : [];
    const rep = pr.reports[pr.last];
    return `<h1>Senate payroll</h1>
      <p class="lede">Every biweekly payroll report the Senate has published as a spreadsheet: ${int.format(pr.reports.length)} reports from ${esc(fmtRepDay(pr, 0))} to ${esc(fmtRepDay(pr, pr.last))}, ${int.format(Object.keys(pr.people).length)} people. The latest covers the pay period ending ${esc(fmtDay(rep[0]))}${rep[1] ? `, paid ${esc(fmtDay(rep[1]))}` : ""}.</p>
      <form class="filters" id="paySearch" role="search" aria-label="Find a person in the Senate payroll"><label class="wide">Find a person<input type="search" id="payq" value="${esc(params.q || "")}" placeholder="Last name, first name" autocomplete="off"></label></form>
      ${q ? `<section class="card"><div class="card-head"><h2>${int.format(found.length)}${found.length === 40 ? "+" : ""} matching ${found.length === 1 ? "person" : "people"}</h2></div>${found.length ? `<ul class="plainlist cols3">${found.map((n) => { const segs = pr.people[n], g = segs[segs.length - 1]; return `<li><a href="${buildHash("person", { name: n })}">${esc(n)}</a> <span class="summary">· ${esc(titleCase(pr.titles[g[1]]))}, ${esc(fmtRepDay(pr, segs[0][4]).slice(-4))}–${g[5] === pr.last ? "now" : esc(fmtRepDay(pr, g[5]).slice(-4))}</span></li>`; }).join("")}</ul>` : `<p class="empty">No one by that name.</p>`}</section>` : ""}
      <div class="grid kpis">
        ${kpi("On the latest report", int.format(cur.length), `${int.format(sal.length)} salaried · ${int.format(te.length)} hourly`)}
        ${kpi("Salaried payroll, yearly rate", compact(annual.reduce((a, b) => a + b, 0)), "latest biweekly rates × 26")}
        ${kpi("Median salary", d ? money0(d.median) : "—", d ? `middle half ${money0(d.p25)}–${money0(d.p75)}` : "")}
        ${kpi("Median hourly rate", te.length ? money(median(te.map((x) => x.g[2]))) : "—", `${int.format(te.length)} temporary staff`)}
      </div>
      ${payrollYearsCard(pr)}
      <div class="grid two">
        <section class="card"><div class="card-head"><h2>Largest offices by salaried payroll</h2><span class="summary">latest report, yearly rate</span></div>
          <ul class="bars">${topOff.map(([o, v]) => { const u = DB.byName.get(o); return `<li><span class="name">${u ? `<a href="${unitHref(u.id)}">${esc(o)}</a>` : esc(o)} <span class="summary">· ${v.n}</span></span><span class="amt">${money0(v.amt)}</span><span class="track"><span class="fill" style="width:${(v.amt / maxO * 100).toFixed(1)}%"></span></span></li>`; }).join("")}</ul></section>
        <section class="card"><div class="card-head"><h2>Highest salaries now</h2><span class="summary">latest report, biweekly rate × 26</span></div>
          <div class="table-wrap"><table><thead><tr><th scope="col">Name</th><th scope="col">Title / office</th><th scope="col" class="num">Yearly rate</th></tr></thead>
          <tbody>${top.map((x) => `<tr><td><a href="${buildHash("person", { name: x.name })}">${esc(x.name)}</a></td><td>${esc(titleCase(pr.titles[x.g[1]]))}<br><span class="summary">${esc(titleCase(pr.offices[x.g[0]]))}</span></td><td class="num">${money0(x.g[2] * 26)}</td></tr>`).join("")}</tbody></table></div></section>
      </div>
      <p class="summary">Source: <a href="https://www.nysenate.gov/open-data" target="_blank" rel="noopener">NY Senate biweekly payroll reports</a>, issued by the Secretary of the Senate. Members' own salaries aren't in these reports; see each senator's page. Pay types: RA regular annual (at least 1,820 hours a year), SA special annual (fewer hours or part of a year), TE temporary (hourly).</p>`;
  }

  function viewPerson(params) {
    const name = params.name || "";
    const pr = payroll();
    if (pr === undefined) return `<p class="empty">Loading Senate payroll history…</p>`;
    if (pr === null) return `<h1>Pay history</h1><p class="empty">Payroll history is only available for the Senate.</p>`;
    const segs = (pr.people[name] || []).slice().reverse();
    const first = segs.length ? segs[segs.length - 1] : null, lastSeg = segs[0];
    return `<a class="back" href="${buildHash("salaries", {})}">${I.l} Salaries</a>
      <h1>${esc(name)}</h1>
      <p class="lede">${segs.length ? `On ${int.format(segs.reduce((a, g) => a + g[6], 0))} of the Senate's ${int.format(pr.reports.length)} published biweekly payroll reports, from ${esc(fmtRepDay(pr, first[4]))} to ${esc(fmtRepDay(pr, lastSeg[5]))}${lastSeg[5] === pr.last ? " (the latest report)" : ""}.` : "Not found in the Senate's published payroll reports."}</p>
      ${segs.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Office</th><th>Title</th><th>Pay type</th><th class="num">Rate</th><th>From</th><th>To</th><th class="num">Reports</th></tr></thead>
        <tbody>${segs.map((g) => { const u = DB.byName.get(pr.offices[g[0]]); return `<tr>
          <td>${u ? `<a href="${unitHref(u.id)}">${esc(pr.offices[g[0]])}</a>` : esc(pr.offices[g[0]])}</td>
          <td>${esc(titleCase(pr.titles[g[1]]))}</td>
          <td><span class="chip muted" title="${esc({ RA: "Regular Annual: appointed for at least 1,820 hours a year", SA: "Special Annual: fewer hours, or less than a full year", TE: "Temporary: irregular schedule, paid hourly" }[g[3]] || g[3])}">${esc(g[3])}</span></td>
          <td class="num nowrap">${rateText(g[2], g[3])}</td>
          <td class="nowrap">${esc(fmtRepDay(pr, g[4]))}</td><td class="nowrap">${esc(fmtRepDay(pr, g[5]))}</td>
          <td class="num">${int.format(g[6])}</td></tr>`; }).join("")}</tbody></table></div>
        <p class="summary">Each row is a run of payroll reports with the same office, title, pay type and rate; dates are the end of the first and last pay period in the run. RA and SA rates are biweekly (×26 for a yearly figure); TE is an hourly rate. Source: <a href="https://www.nysenate.gov/open-data" target="_blank" rel="noopener">NY Senate biweekly payroll reports</a>, ${esc(fmtRepDay(pr, 0))} to ${esc(fmtRepDay(pr, pr.last))}.</p>` : ""}`;
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

    const salaries = (raw.salaries || []).map(([u, p, titles, from, to, days, paid, annual, status, basis]) => ({ u, p, titles, from, to, days, paid, annual, status, basis: basis || "svc" }));
    const salaryByKey = new Map(salaries.map((x) => [x.u + "|" + x.p, x]));
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

    // Months of the report period each office was active. A member office counts the days
    // covered by the member's own salary line (joiners and leavers); everything else gets the
    // full period. Per-month cost = actual spending / months active.
    const periodDays = (Date.parse(meta.period.end) - Date.parse(meta.period.start)) / 864e5 + 1;
    const periodMonths = Math.round(periodDays / 30.44);
    const memberDays = new Map();
    for (const x of salaries) if (/^MEMBER( OF ASSEMBLY)?$/.test(x.titles)) memberDays.set(x.u, Math.max(memberDays.get(x.u) || 0, x.days));
    unitStats.forEach((s) => {
      const d = memberDays.get(s.id);
      s.months = d ? Math.min(periodMonths, Math.max(0.5, Math.round(d / 30.44 * 2) / 2)) : periodMonths;
      s.partial = s.months < periodMonths;
      s.perMonth = s.actual / s.months;
    });
    const members = unitStats.filter((s) => s.kind === "member").sort((a, b) => b.actual - a.actual);
    members.forEach((s, i) => { s.rank = i + 1; });
    const sortedActual = members.map((s) => s.actual).sort((a, b) => a - b);
    const mid = Math.floor(sortedActual.length / 2);
    const memberMedian = sortedActual.length % 2 ? sortedActual[mid] : (sortedActual[mid - 1] + sortedActual[mid]) / 2;

    const months = [...new Set(records.map((r) => r.month).filter(Boolean))].sort();
    const statuses = [...new Set(records.map((r) => r.st).filter(Boolean))].sort();
    const typeIndex = Object.fromEntries(types.map((t, i) => [t.code, i]));

    const byName = new Map(unitStats.map((s) => [s.name, s]));
    const memberMonthlyMedian = (() => { const a = members.map((s) => s.perMonth).sort((x, y) => x - y), m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; })();
    return { id, meta, units, types, payees, descs, records, unitStats, members, memberMedian, memberMonthlyMedian, periodMonths, months, statuses, typeIndex, byName, salaries, salaryByKey };
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
  function displayName(s) {
    // "STIRPE, ALBERT A. JR." / "SENATOR JOSEPH P. ADDABBO, JR." -> "Albert A. Stirpe Jr." / "Joseph P. Addabbo Jr."
    let n = s.name.replace(/^(SENATOR|SEN)\s+/, "");
    if (CH.id === "assembly" && n.includes(",")) {
      const [last, rest] = n.split(/,(.*)/s);
      const sfx = (rest.match(/\b(JR|SR|II|III|IV)\.?\s*$/) || [""])[0];
      n = `${rest.replace(sfx, "").trim()} ${last.trim()}${sfx ? " " + sfx.trim() : ""}`;
    }
    return titleCase(n.replace(/,\s*(JR|SR)/, " $1"));
  }
  function ballotpediaLink(s) {
    if (s.kind !== "member") return "";
    const url = (BALLOTPEDIA[CH.id] || {})[s.name];
    const href = url || `https://ballotpedia.org/wiki/index.php?search=${encodeURIComponent(displayName(s))}`;
    return `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener" title="${url ? "Ballotpedia profile" : "Not on Ballotpedia's current-members list; opens a Ballotpedia search"}">${url ? "Ballotpedia profile" : "Search Ballotpedia"} ${I.ext}</a>`;
  }
  const ELECTION_LABEL = {
    retiring: ["Not seeking re-election", "change"], other_office: ["Ran for another office", "change"],
    lost_primary: ["Lost June primary", "change"], lost_general: ["Lost Nov 3 (unofficial)", "change"],
    trailing: ["Trailing — not yet decided", "maybe"], leading_close: ["Leading — too close to call", "maybe"],
    held: ["Re-elected (unofficial)", "same"], not_on_ballot: ["Not on the Nov 3 ballot", "change"],
  };
  function memberInfo(s) { return s && s.kind === "member" ? (MEMBERS[CH.id] || {})[s.name] || {} : {}; }
  function electionState(s) {
    const e = memberInfo(s).election;
    if (s.kind !== "member") return null;
    if (!e) return { label: "Ran for re-election · no reported loss", cls: "same", e: null };
    const [label, cls] = ELECTION_LABEL[e.status] || [e.status, "maybe"];
    return { label, cls, e };
  }
  function electionChip(s, short) {
    const st = electionState(s);
    if (!st) return "";
    const text = short ? { change: "New member in 2027", maybe: "Not yet called", same: "Returning" }[st.cls] : st.label;
    return `<span class="echip ${st.cls}" title="${esc(st.e ? st.e.note : "Not among the losses or departures reported in our sources (unofficial results)")}">${esc(text)}</span>`;
  }
  function successorLabel(e) {
    if (e.status === "trailing") return "Leading";
    if (e.sources.includes("boe") && e.status !== "lost_primary") return e.status === "lost_general" ? "Winner by the State Board count" : "Leading in the State Board count";
    if (e.sources.includes("gt")) return "Incoming member (per Greenberg Traurig)";
    if (e.status === "lost_primary") return "Primary winner";
    return "Reported winner";
  }
  function boeResult(m) {
    const b = m.boe;
    if (!b) return "";
    const src = ELECTION_SOURCES.boe || {};
    const [rep, eds] = b.reporting;
    return `<table class="mini-results"><tbody>${b.cands.map(([n, pty, v], i) => `<tr class="${i === b.incumbent ? "inc" : ""}">
        <td>${esc(n)}${i === b.incumbent ? ' <span class="summary">(incumbent)</span>' : ""}<br><span class="summary">${esc(pty)}</span></td>
        <td class="num">${int.format(v)}</td><td class="num">${b.total ? (v / b.total * 100).toFixed(1) : "0.0"}%</td></tr>`).join("")}</tbody></table>
      <p class="summary">Unofficial count from the <a href="${esc(src.url || "https://nyenr.elections.ny.gov/")}" target="_blank" rel="noopener">NYS Board of Elections</a> as of ${esc(b.asOf)} · ${rep === null ? "" : `${int.format(rep)} of ${int.format(eds)} election districts reporting · `}${int.format(b.total)} ballots incl. blanks. Certification follows within about 25 days of the election.</p>`;
  }
  function fmtLooseDate(t) {
    // "January 1, 2023" or "2011"
    return t || "";
  }
  /* Campaign finance for every registered candidate in a district, 2025-26. */
  function pfNote(district, rows) {
    const list = pubfin(district);
    const pf = PUBFIN[CH.id];
    if (!pf) return "";
    const ids = new Set(rows.map((c) => c.filerId));
    const extra = list.filter((p) => !p.filerId || !ids.has(p.filerId));
    const inProg = rows.filter((c) => pfFor(district, c)).length;
    const total = list.reduce((a, p) => a + p.received, 0);
    return `<p class="pfline"><strong>Public financing:</strong> ${list.length ? `${list.length} ${list.length === 1 ? "candidate" : "candidates"} here registered for New York's 2026 public matching-funds program${total ? `, receiving ${money0(total)} in all` : ""}${rows.length ? ` (${inProg} of the ${rows.length} listed above)` : ""}.` : "no candidate here registered for New York's 2026 public matching-funds program."}${extra.length ? ` Also in the program: ${extra.map((p) => `${esc(p.name)}${p.received ? ` (${money0(p.received)})` : ""}`).join(", ")}.` : ""} <span class="summary">As listed by the State Board on ${esc(fmtDay(pf.retrieved))}; status by election: ${list.map((p) => `${esc(p.name)} — ${esc(pfStatus(p))}`).join("; ") || "none"}.</span></p>`;
  }
  function campaignCard(district, memberName) {
    const cf = CAMPAIGN[CH.id];
    if (!cf || district == null) return "";
    const rows = (cf.districts[String(district)] || []).slice();
    const surname = (memberName || "").toLowerCase();
    const isMember = (c) => surname && c.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2).some((w) => surname.includes(w)) ;
    const total = (c) => Object.values(c.raised).reduce((a, b) => a + b, 0);
    const linked = rows.filter((c) => c.committees.length);
    const unlinked = rows.filter((c) => !c.committees.length);
    const max = Math.max(1, ...linked.map(total));
    const asOf = cf.asOf ? fmtDay(cf.asOf) : "";
    return `<section class="card campaign"><div class="card-head"><h2>Campaign money in ${CH.abbr} ${esc(String(district))}, 2025–26</h2><span class="summary">raised and spent by each candidate's committees · State Board of Elections${asOf ? `, as of ${esc(asOf)}` : ""}</span></div>
      ${linked.length ? `<div class="table-wrap"><table class="cf-table">
        <caption class="sr-only">Money raised and spent by candidates in ${CH.abbr} ${esc(String(district))}</caption>
        <thead><tr><th scope="col">Candidate</th><th scope="col" class="num">Raised</th><th scope="col">Where it came from</th><th scope="col" class="num" title="Itemized contributions from individuals of $250 or less">Gifts ≤ $250</th><th scope="col" class="num">Spent</th><th scope="col" class="num" title="Public matching funds received from the Public Campaign Finance Board for 2026">Public funds</th></tr></thead>
        <tbody>${linked.map((c) => { const t = total(c); const parts = [["A", "Individuals", "cf-a"], ["B", "Corporations", "cf-b"], ["C", "PACs, unions & other", "cf-c"], ["D", "In-kind", "cf-d"], ["G", "Transfers in", "cf-g"]]; return `<tr${isMember(c) ? ' class="inc"' : ""}>
          <th scope="row"><span class="cf-name">${esc(c.name)}</span>${isMember(c) ? ' <span class="summary">(member)</span>' : ""}${pfBadge(pfFor(district, c))}<br><span class="summary">${c.committees.map((x) => esc(x[1])).join(" · ")}</span></th>
          <td class="num"><strong>${money0(t)}</strong></td>
          <td><div class="stack cf-stack" style="width:${Math.max(2, t / max * 100).toFixed(1)}%" role="img" aria-label="${esc(parts.filter(([k]) => c.raised[k] > 0).map(([k, l]) => `${l} ${money0(c.raised[k])}`).join(", ") || "nothing reported")}">${parts.map(([k, l, cls]) => c.raised[k] > 0 ? `<span class="${cls}" style="flex:${c.raised[k]}" title="${l}: ${money(c.raised[k])}"></span>` : "").join("")}</div></td>
          <td class="num">${c.small[0] ? int.format(c.small[0]) : "—"}</td>
          <td class="num">${money0(c.spent)}</td>
          <td class="num">${(() => { const p = pfFor(district, c); return p ? (p.received ? money0(p.received) : "$0") : `<span class="summary">not in program</span>`; })()}</td></tr>`; }).join("")}</tbody></table></div>
        <div class="legend"><span><i class="cf-a"></i>Individuals</span><span><i class="cf-b"></i>Corporations</span><span><i class="cf-c"></i>PACs, unions &amp; other</span><span><i class="cf-d"></i>In-kind</span><span><i class="cf-g"></i>Transfers in</span></div>` : `<p class="summary">No 2025–26 contributions found for a committee we could link to a candidate in this district.</p>`}
      ${DONATIONS[CH.id] && DONATIONS[CH.id].districts[String(district)] ? `<p><a class="btn" href="${buildHash("donations/" + district, {})}">Donations in depth: donors, where they live, biggest organizational donors ${I.r}</a></p>` : ""}
      ${unlinked.length ? `<p class="summary">Also registered here, with no linked committee activity: ${unlinked.map((c) => esc(c.name)).join(", ")}.</p>` : ""}
      ${pfNote(district, rows)}
      <p class="summary">Itemized contributions and expenditures filed with the <a href="https://publicreporting.elections.ny.gov/" target="_blank" rel="noopener">NYS Board of Elections</a> for 2025 and 2026 (<a href="https://data.ny.gov/d/4j2b-6a2j" target="_blank" rel="noopener">data.ny.gov</a>). Committees are linked to candidates by name, so each committee is listed. Raised counts monetary and in-kind contributions plus transfers from other committees; public matching funds are shown separately, from the State Board's <a href="https://publicreporting.elections.ny.gov/PCFBCandidateRegList/PCFBCandidateRegList" target="_blank" rel="noopener">Public Campaign Finance candidate list</a>.</p>
    </section>`;
  }
  /* ---------- Donations in depth ---------- */
  const DN_GEO = [["inDistrict", "In the district", "g-in"], ["restOfNy", "Elsewhere in New York", "g-ny"], ["outOfState", "Out of state", "g-out"], ["unknown", "Address unclear", "g-unk"]];
  function dnTotals(c) {
    const orgs = Object.values(c.types).reduce((a, b) => a + b, 0);
    const smallDonors = c.sizes[0][0] + c.sizes[1][0];
    return { monetary: orgs, individuals: c.individuals, smallShare: c.donors ? smallDonors / c.donors : 0, inShareAmt: c.individuals ? c.inDistrict[1] / c.individuals : 0, inShareDonors: c.donors ? c.inDistrict[0] / c.donors : 0, outShareAmt: c.individuals ? c.outOfState[1] / c.individuals : 0 };
  }
  const pctf = (x) => (x * 100).toFixed(0) + "%";
  function viewDonations(params) {
    const dn = DONATIONS[CH.id];
    if (!dn) return `<h1>Donations</h1><p class="empty">Donation details aren't available.</p>`;
    const state = { sort: params.sort || "monetary", dir: params.dir || "desc" };
    const rows = [];
    for (const [d, cands] of Object.entries(dn.districts)) {
      const dist = DISTRICTS.find((x) => String(x.district) === d);
      const tot = cands.reduce((a, c) => { const t = dnTotals(c); a.monetary += t.monetary; a.individuals += c.individuals; a.donors += c.donors; a.inAmt += c.inDistrict[1]; a.outAmt += c.outOfState[1]; a.small += c.sizes[0][0] + c.sizes[1][0]; return a; }, { monetary: 0, individuals: 0, donors: 0, inAmt: 0, outAmt: 0, small: 0 });
      const pfl = pubfin(d);
      rows.push({ d: Number(d), member: dist ? dist.member : "", cands: cands.length, pfCands: pfl.length, pfFunds: pfl.reduce((a, p) => a + p.received, 0), ...tot, inShare: tot.individuals ? tot.inAmt / tot.individuals : 0, outShare: tot.individuals ? tot.outAmt / tot.individuals : 0, smallShare: tot.donors ? tot.small / tot.donors : 0, orgShare: tot.monetary ? 1 - tot.individuals / tot.monetary : 0 });
    }
    const key = { district: (r) => r.d, monetary: (r) => r.monetary, donors: (r) => r.donors, inShare: (r) => r.inShare, outShare: (r) => r.outShare, smallShare: (r) => r.smallShare, orgShare: (r) => r.orgShare, cands: (r) => r.cands, pf: (r) => r.pfFunds }[state.sort] || ((r) => r.monetary);
    rows.sort((a, b) => (key(a) - key(b)) * (state.dir === "asc" ? 1 : -1));
    const all = rows.reduce((a, r) => { a.m += r.monetary; a.i += r.individuals; a.in += r.inAmt; a.out += r.outAmt; a.dn += r.donors; return a; }, { m: 0, i: 0, in: 0, out: 0, dn: 0 });
    const maxM = Math.max(1, ...rows.map((r) => r.monetary));
    setTimeout(() => wireSortHeaders(app, state, (st) => go("donations", { sort: st.sort, dir: st.dir }, true), { district: "asc" }), 0);
    return `<h1>Donations by district</h1>
      <p class="lede">Itemized monetary contributions to ${esc(CH.name)} candidates in 2025 and 2026, district by district: who gave, from where, and how much. Open a district for each candidate's donors, money by month and biggest organizational donors.</p>
      <div class="grid kpis">
        ${kpi("Itemized contributions", compact(all.m), `${rows.length} districts with reported money`)}
        ${kpi("From individuals", pctf(all.m ? all.i / all.m : 0), `${int.format(all.dn)} donor–candidate pairs`)}
        ${kpi("Individual money from inside the district", pctf(all.i ? all.in / all.i : 0), "estimated from donor ZIP codes")}
        ${kpi("Individual money from out of state", pctf(all.i ? all.out / all.i : 0), "")}
        ${PUBFIN[CH.id] ? (() => { const L = Object.values(PUBFIN[CH.id].districts).flat(); return kpi("Public matching funds", compact(L.reduce((a, p) => a + p.received, 0)), `${L.length} candidates registered for the 2026 program`); })() : ""}
      </div>
      ${VENDOR_DONORS && VENDOR_DONORS.matches.length ? `<p><a class="btn" href="${buildHash("vendors", {})}">Vendors the Legislature pays that also donated (${VENDOR_DONORS.matches.length}) ${I.r}</a></p>` : ""}
      <div class="table-wrap"><table>
        <caption class="sr-only">Donations by ${esc(CH.name)} district, sortable</caption>
        <thead><tr>${sortHeader("District", "district", state)}<th scope="col">Member now</th>${sortHeader("Candidates", "cands", state, "num")}${sortHeader("Contributions", "monetary", state, "num")}${sortHeader("Donors", "donors", state, "num")}${sortHeader("From organizations", "orgShare", state, "num")}${sortHeader("In-district $", "inShare", state, "num")}${sortHeader("Out-of-state $", "outShare", state, "num")}${sortHeader("Donors ≤ $250", "smallShare", state, "num")}${sortHeader("Public funds", "pf", state, "num")}</tr></thead>
        <tbody>${rows.map((r) => `<tr><td><a href="${buildHash("donations/" + r.d, {})}">${CH.abbr} ${r.d}</a></td><td>${esc(r.member)}</td><td class="num">${r.cands}</td>
          <td class="num"><span class="inlinebar"><span style="width:${(r.monetary / maxM * 100).toFixed(1)}%"></span></span>${money0(r.monetary)}</td><td class="num">${int.format(r.donors)}</td>
          <td class="num">${pctf(r.orgShare)}</td><td class="num">${pctf(r.inShare)}</td><td class="num">${pctf(r.outShare)}</td><td class="num">${pctf(r.smallShare)}</td><td class="num">${r.pfFunds ? money0(r.pfFunds) : "—"}${r.pfCands ? `<br><span class="summary">${r.pfCands} in program</span>` : ""}</td></tr>`).join("")}</tbody></table></div>
      <p class="summary">${donationsNote(dn)}</p>`;
  }
  function donationsNote(dn) {
    return `Source: itemized monetary contributions (schedules A–C) filed with the <a href="https://publicreporting.elections.ny.gov/" target="_blank" rel="noopener">NYS Board of Elections</a> for 2025–26, from <a href="https://data.ny.gov/d/e9ss-239a" target="_blank" rel="noopener">data.ny.gov</a>, as of ${esc(fmtDay(dn.asOf))}. Committees are linked to candidates by name (see each district page). A donor is one name and ZIP code; "in the district" places the donor's ZIP code at its Census center point, so it's an estimate where ZIPs cross district lines. Shares of "$" are of money from individuals. Donor names aren't shown; organizations are. Unitemized contributions, transfers, in-kind gifts and public matching funds aren't included.`;
  }
  function viewDonationDistrict(arg) {
    const dn = DONATIONS[CH.id];
    const d = String(Number(arg));
    const cands = dn && dn.districts[d];
    const dist = DISTRICTS.find((x) => String(x.district) === d);
    const head = `<a class="back" href="${buildHash("donations", {})}">${I.l} Donations by district</a>
      <h1>Donations in ${esc(CH.name)} District ${esc(d)}</h1>
      <p class="lede">${dist ? `Represented now by ${esc(dist.member)}. ` : ""}Itemized monetary contributions to each candidate's committees in 2025 and 2026. <a href="${dist ? buildHash("district/" + d, {}) : "#"}">District spending and results ${I.r}</a></p>`;
    if (!cands) return head + `<p class="empty">No itemized contributions found for a committee linked to a candidate here.</p>`;
    const months = [...new Set(cands.flatMap((c) => Object.keys(c.months)))].sort();
    const maxMonth = Math.max(1, ...cands.flatMap((c) => Object.values(c.months)));
    const maxSize = Math.max(1, ...cands.flatMap((c) => c.sizes.map((x) => x[0])));
    return head + cands.map((c) => {
      const t = dnTotals(c);
      const geoTot = DN_GEO.reduce((a, [k]) => a + c[k][1], 0) || 1;
      const typeTot = Object.values(c.types).reduce((a, b) => a + b, 0) || 1;
      return `<section class="card dn"><div class="card-head"><h2>${esc(c.name)}${pfBadge(pfFor(d, c))}</h2><span class="summary">${money0(t.monetary)} in itemized contributions${(() => { const p = pfFor(d, c); return p && p.received ? ` · ${money0(p.received)} in public matching funds` : ""; })()}</span></div>
        <div class="grid kpis small">
          ${kpi("Individual donors", int.format(c.donors), `${int.format(c.repeat)} gave more than once · ${int.format(c.gifts)} gifts`)}
          ${kpi("From individuals", money0(c.individuals), pctf(t.monetary ? c.individuals / t.monetary : 0) + " of contributions")}
          ${kpi("Donors in the district", pctf(t.inShareDonors), `${pctf(t.inShareAmt)} of individual money`)}
          ${kpi("Donors giving $250 or less", pctf(t.smallShare), `average ${c.donors ? money0(c.individuals / c.donors) : "—"} per donor`)}
        </div>
        <div class="grid two">
          <div><h3 class="mini">Where individual money came from</h3>
            <div class="stack big" role="img" aria-label="${esc(DN_GEO.filter(([k]) => c[k][1] > 0).map(([k, l]) => `${l}: ${money0(c[k][1])} from ${c[k][0]} donors`).join("; "))}">${DN_GEO.map(([k, l, cls]) => c[k][1] > 0 ? `<span class="${cls}" style="flex:${c[k][1]}" title="${l}: ${money(c[k][1])}, ${c[k][0]} donors"></span>` : "").join("")}</div>
            <div class="legend">${DN_GEO.filter(([k]) => c[k][0]).map(([k, l, cls]) => `<span><i class="${cls}"></i>${l} ${pctf(c[k][1] / geoTot)} · ${int.format(c[k][0])}</span>`).join("")}</div>
            <h3 class="mini" style="margin-top:14px">Donors by how much they gave in total</h3>
            <ul class="bars sizes">${dn.buckets.map((b, i) => `<li><span class="name">${esc(b)}</span><span class="amt">${int.format(c.sizes[i][0])} ${c.sizes[i][0] === 1 ? "donor" : "donors"} · ${money0(c.sizes[i][1])}</span><span class="track"><span class="fill" style="width:${(c.sizes[i][0] / maxSize * 100).toFixed(1)}%"></span></span></li>`).join("")}</ul>
          </div>
          <div><h3 class="mini">Who gave</h3>
            <ul class="bars">${Object.entries(c.types).slice(0, 7).map(([k, v]) => `<li><span class="name">${esc(k === "Not specified" ? "Type not specified" : k)}</span><span class="amt">${money0(v)} · ${pctf(v / typeTot)}</span><span class="track"><span class="fill alt" style="width:${(v / typeTot * 100).toFixed(1)}%"></span></span></li>`).join("")}</ul>
            ${c.topOrgs.length ? `<h3 class="mini" style="margin-top:14px">Biggest organizational donors</h3><table class="mini-results"><tbody>${c.topOrgs.slice(0, 8).map((o) => `<tr><td>${esc(o[0])}<br><span class="summary">${esc(o[1])}${o[3] > 1 ? ` · ${o[3]} gifts` : ""}</span></td><td class="num">${money0(o[2])}</td></tr>`).join("")}</tbody></table>` : `<p class="summary">No contributions from organizations.</p>`}
          </div>
        </div>
        ${months.length > 1 ? `<h3 class="mini" style="margin-top:14px">Contributions by month</h3><div class="cols small">${months.map((m) => { const v = c.months[m] || 0; return `<div class="col" role="img" aria-label="${monthLabel(m)}: ${money0(v)}" title="${monthLabel(m)}: ${money(v)}"><span class="colval">${v ? compact(v) : ""}</span><span class="colbar" style="height:${(v / maxMonth * 100).toFixed(1)}%"></span><span class="collabel">${monthLabel(m)}</span></div>`; }).join("")}</div>` : ""}
      </section>`;
    }).join("") + `<p class="summary">${donationsNote(dn)}</p>`;
  }

  /* ---------- Scorecard: how each member office did, on measures the site can verify ---------- */
  const SC_MEASURES = [
    { key: "cost", label: "Cost per month", better: "low", fmt: (v) => money0(v), help: "Actual spending per month the office was active (lower ranks higher)" },
    { key: "retention", label: "Staff retention", better: "high", fmt: (v) => pctf(v), help: "Share of the previous report's staff still paid by the office in this report" },
    { key: "margin", label: "2026 margin", better: "high", fmt: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} pts`, help: "Member's lead (or deficit) over the nearest opponent in the State Board's unofficial count; unopposed and non-running members aren't ranked" },
    { key: "reach", label: "Donors in district", better: "high", fmt: (v) => pctf(v), help: "Share of the member's 2025–26 individual donors whose ZIP code falls in the district (estimate)" },
    { key: "small", label: "Small donors", better: "high", fmt: (v) => pctf(v), help: "Share of the member's individual donors who gave $250 or less in total" },
  ];
  function scorecardRows() {
    const dn = DONATIONS[CH.id];
    const rows = DB.members.map((s) => {
      const m = memberInfo(s), dist = DISTRICT_BY_UNIT.get(s.name);
      const r = { s, district: dist ? dist.district : null, party: dist ? (dist.party || "").charAt(0) : "", values: {} };
      r.values.cost = s.perMonth;
      const ps = prevUnit(s);
      if (ps && ps.staff.size) {
        const now = new Set([...s.staff].map((p) => DB.payees[p]));
        const before = [...ps.staff].map((p) => PREV.payees[p]);
        r.values.retention = before.filter((n) => now.has(n)).length / before.length;
      }
      if (m.boe && m.boe.incumbent != null && m.boe.cands.length > 1 && m.boe.total) {
        const c = m.boe.cands, i = m.boe.incumbent;
        const best = Math.max(...c.filter((_, j) => j !== i).map((x) => x[2]));
        r.values.margin = (c[i][2] - best) / m.boe.total * 100;
      }
      const cands = dn && r.district != null ? dn.districts[String(r.district)] || [] : [];
      const sur = displayName(s).toLowerCase();
      const mine = cands.find((c) => c.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2).some((w) => sur.includes(w)));
      if (mine && mine.donors >= 10) {
        r.values.reach = mine.inDistrict[0] / mine.donors;
        r.values.small = (mine.sizes[0][0] + mine.sizes[1][0]) / mine.donors;
        r.donors = mine.donors;
      }
      return r;
    });
    return rows;
  }
  function percentileRanks(rows, groupOf) {
    for (const m of SC_MEASURES) {
      const groups = new Map();
      for (const r of rows) if (r.values[m.key] != null) { const g = groupOf(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
      for (const list of groups.values()) {
        // Ties share a rank and a percentile (average position), so equal values score equally.
        const val = (r) => r.values[m.key] * (m.better === "low" ? -1 : 1);
        for (const r of list) {
          const better = list.filter((o) => val(o) > val(r) + 1e-9).length, same = list.filter((o) => Math.abs(val(o) - val(r)) <= 1e-9).length;
          r.pct = r.pct || {}; r.rank = r.rank || {}; r.of = r.of || {};
          r.rank[m.key] = better + 1; r.of[m.key] = list.length;
          r.pct[m.key] = list.length > 1 ? 1 - (better + (same - 1) / 2) / (list.length - 1) : 1;
        }
      }
    }
    for (const r of rows) { const v = SC_MEASURES.map((m) => r.pct && r.pct[m.key]).filter((x) => x != null); r.index = v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length * 100 : null; r.nMeasures = v.length; }
  }
  function viewScorecard(params) {
    const state = { sort: params.sort || "index", dir: params.dir || "desc", within: params.within || "party", party: params.party || "" };
    let rows = scorecardRows();
    percentileRanks(rows, (r) => state.within === "party" ? r.party : "all");
    if (state.party) rows = rows.filter((r) => r.party === state.party);
    const key = state.sort === "index" ? (r) => r.index : state.sort === "name" ? (r) => displayName(r.s) : state.sort === "district" ? (r) => r.district : (r) => (r.values[state.sort]);
    rows.sort((a, b) => { const x = key(a), y = key(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; const c = typeof x === "string" ? x.localeCompare(y) : x - y; return state.dir === "asc" ? c : -c; });
    setTimeout(() => {
      wireSortHeaders(app, state, (st) => go("scorecard", { ...state, sort: st.sort, dir: st.dir }, true), { name: "asc", district: "asc", cost: "asc" });
      const w = app.querySelector("#scWithin"), pf = app.querySelector("#scParty");
      if (w) w.addEventListener("change", () => go("scorecard", { ...state, within: w.value }, true));
      if (pf) pf.addEventListener("change", () => go("scorecard", { ...state, party: pf.value }, true));
    }, 0);
    const cell = (r, m) => {
      const v = r.values[m.key];
      if (v == null) return `<td class="num summary">—</td>`;
      const pc = r.pct[m.key];
      return `<td class="num"><span class="scval">${m.fmt(v)}</span><span class="scrank" title="Rank ${r.rank[m.key]} of ${r.of[m.key]}${state.within === "party" ? " in party" : ""}"><span class="scbar"><span style="width:${(pc * 100).toFixed(0)}%"></span></span>#${r.rank[m.key]}</span></td>`;
    };
    return `<h1>Scorecard</h1>
      <p class="lede">How each ${esc(CH.name)} member office did in ${esc(periodName(DB))} on measures this site can check against public records. Each column ranks offices${state.within === "party" ? " within their party" : " across the chamber"}; the index averages the percentile ranks.</p>
      <div class="filters">
        <label>Rank against<select id="scWithin"><option value="party"${state.within === "party" ? " selected" : ""}>Own party (default)</option><option value="chamber"${state.within === "chamber" ? " selected" : ""}>Whole chamber</option></select></label>
        <label>Party<select id="scParty"><option value="">Both</option><option value="D"${state.party === "D" ? " selected" : ""}>Democrats</option><option value="R"${state.party === "R" ? " selected" : ""}>Republicans</option></select></label>
      </div>
      <div class="table-wrap"><table class="scorecard">
        <caption class="sr-only">${esc(CH.name)} member office scorecard, sortable</caption>
        <thead><tr>${sortHeader("Member", "name", state)}${sortHeader(CH.abbr, "district", state, "num")}${SC_MEASURES.map((m) => sortHeader(`<abbr title="${esc(m.help)}">${esc(m.label)}</abbr>`, m.key, state, "num")).join("")}${sortHeader(`<abbr title="Average of the percentile ranks the office has (at least three of five). 100 = best on every measure.">Index</abbr>`, "index", state, "num")}</tr></thead>
        <tbody>${rows.map((r) => `<tr><td><a href="${unitHref(r.s.id)}">${esc(displayName(r.s))}</a> <span class="ptag p${r.party}">${esc(r.party)}</span></td><td class="num">${r.district ?? ""}</td>${SC_MEASURES.map((m) => cell(r, m)).join("")}<td class="num">${r.index != null ? `<strong>${r.index.toFixed(0)}</strong><span class="summary"> /${r.nMeasures}</span>` : `<span class="summary">—</span>`}</td></tr>`).join("")}</tbody></table></div>
      <section class="card"><div class="card-head"><h2>How to read this</h2></div>
        <ul class="plainlist">${SC_MEASURES.map((m) => `<li><strong>${esc(m.label)}.</strong> ${esc(m.help)}.</li>`).join("")}
          <li><strong>Index.</strong> The average of an office's percentile ranks (0 = last, 100 = first) on the measures it has, shown only when it has at least three; "/n" is how many. Every measure counts equally; that weighting is a choice, so the columns matter more than the index.</li>
          <li><strong>Why rank within party.</strong> The majority conference sets office budgets, and minority-party offices get smaller ones, so cost per month (and, once added, bills passed) mostly reflects party. Ranking within party compares like with like; switch to "whole chamber" to see the raw order.</li>
          <li><strong>Not yet here: lawmaking.</strong> Bills introduced, moved out of committee, passed and signed into law come from the Senate's Open Legislation service, which needs an API key; they'll be added as columns when it's connected. Majority-party members pass far more bills, which is why ranking within party is offered.</li></ul>
        <p class="summary">None of these measures says whether an office served its district well; they're checkable facts about cost, staffing, elections and fundraising. Members who left mid-period or have little data are ranked on what exists. Sources: the ${esc(CH.name)} expenditure reports, the State Board of Elections unofficial count, and campaign finance filings (see About the Data).</p></section>`;
  }

  function demog(district, chId) { const d = DEMOG[chId || CH.id]; return d && district != null ? d.districts[String(district)] || null : null; }
  function perResident(s) { const d = DISTRICT_BY_UNIT.get(s.name); const g = d && demog(d.district); return g && g.pop ? s.actual / g.pop : null; }
  function enroll(district, chId) { const e = ENROLL[chId || CH.id]; return e && district != null ? e.districts[String(district)] || null : null; }
  function turnout(e) { return e && e.votes2026 && e.total ? e.votes2026[0] / e.total : null; }
  function enrollFor(s) { const d = DISTRICT_BY_UNIT.get(s.name); return d ? enroll(d.district) : null; }
  const EN_PARTY = [["Democratic", "en-d"], ["Republican", "en-r"], ["Conservative", "en-c"], ["Working Families", "en-w"], ["Other parties", "en-o"], ["No party", "en-b"]];
  function votersCard(district, s) {
    const e = enroll(district);
    if (!e) return "";
    const en = ENROLL[CH.id];
    const act = e.party.reduce((a, b) => a + b, 0) || 1;
    const t = turnout(e);
    const partial = e.votes2026 && e.votes2026[1] < e.votes2026[2];
    const per = s ? s.actual / e.total : null;
    const lead = e.party.slice(0, 5).reduce((b, v, i) => v > e.party[b] ? i : b, 0);
    return `<section class="card voters"><div class="card-head"><h2>Registered voters</h2><span class="summary">State Board of Elections enrollment, as of ${esc(fmtDay(en.asOf))}</span></div>
      <div class="grid kpis small">
        ${kpi("Registered voters", int.format(e.total), `${int.format(e.active)} active · ${int.format(e.inactive)} inactive`)}
        ${kpi("Largest party enrollment", `${esc(EN_PARTY[lead][0])} ${pctf(e.party[lead] / act)}`, `${pctf(e.party[5] / act)} enrolled in no party`)}
        ${t != null ? kpi("Votes cast for this seat, 2026", pctf(t), `${int.format(e.votes2026[0])} votes ÷ registered voters${partial ? ` · ${e.votes2026[1]} of ${e.votes2026[2]} election districts in` : ""}`) : ""}
        ${per != null ? kpi("Office cost per registered voter", money(per), `${esc(periodName(DB))}`) : ""}
      </div>
      <h3 class="mini">Active voters by party enrollment</h3>
      <div class="stack big" role="img" aria-label="${esc(EN_PARTY.map(([l], i) => `${l} ${int.format(e.party[i])}`).join(", "))}">${EN_PARTY.map(([l, cls], i) => e.party[i] ? `<span class="${cls}" style="flex:${e.party[i]}" title="${l}: ${int.format(e.party[i])} (${pctf(e.party[i] / act)})"></span>` : "").join("")}</div>
      <div class="legend">${EN_PARTY.map(([l, cls], i) => `<span><i class="${cls}"></i>${l} ${pctf(e.party[i] / act)}</span>`).join("")}</div>
      <p class="summary">Enrollment counts from the <a href="${esc(en.source)}" target="_blank" rel="noopener">NYS Board of Elections</a>. Inactive voters are still registered and can vote; they're marked inactive after mail to them is returned. Votes cast come from the State Board's unofficial 2026 general election count for this seat and include every candidate; blank ballots aren't counted.</p>
    </section>`;
  }
  function pubfin(district, chId) { const p = PUBFIN[chId || CH.id]; return p && district != null ? p.districts[String(district)] || [] : []; }
  function pfFor(district, cand, chId) { return cand && cand.filerId ? pubfin(district, chId).find((p) => p.filerId === cand.filerId) || null : null; }
  function pfStatus(p) { const e = Object.entries(p.elections); return e.map(([k, v]) => `${k}: ${v.status}${v.terminated ? `, left ${fmtDay(v.terminated)}` : ""}`).join(" · "); }
  function pfBadge(p) { return p ? ` <span class="pfbadge" title="In New York's public campaign finance program${p.certified ? ` · certified ${fmtDay(p.certified)}` : ""} · ${esc(pfStatus(p))}">Public financing</span>` : ""; }
  function povertyRate(g) { return g && g.poverty[1] ? g.poverty[0] / g.poverty[1] : null; }
  function demogCard(district, s) {
    const g = demog(district);
    if (!g) return "";
    const pr = povertyRate(g);
    const per = s ? s.actual / g.pop : null;
    const all = Object.values(DEMOG[CH.id].districts).map((x) => x.income).filter((x) => x != null).sort((a, b) => a - b);
    const incRank = g.income != null ? all.filter((x) => x < g.income).length : null;
    return `<section class="card"><div class="card-head"><h2>The district</h2><span class="summary">Census Bureau, American Community Survey 2020–24 (5-year estimates)</span></div>
      <div class="grid kpis small">
        ${kpi("Residents", int.format(g.pop), g.popMoe ? `± ${int.format(g.popMoe)}` : "")}
        ${kpi("Median household income", g.income != null ? money0(g.income) : "—", incRank != null ? `higher than ${pctf(incRank / Math.max(1, all.length - 1))} of ${esc(CH.name)} districts` : "")}
        ${kpi("Below the poverty line", pr != null ? (pr * 100).toFixed(1) + "%" : "—", "of residents whose status is known")}
        ${per != null ? kpi("Office cost per resident", money(per), `${esc(periodName(DB))} · ${money(per / DB.periodMonths * 12)} a year`) : ""}
      </div></section>`;
  }
  function officialLink(s) {
    const u = memberInfo(s).profileUrl;
    const d = DISTRICT_BY_UNIT.get(s.name);
    const href = u || (CH.id === "senate" ? "https://www.nysenate.gov/senators-committees" : "https://nyassembly.gov/mem/");
    return s.kind === "member" ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener" title="${u ? "Official page, with portrait, bio and contact details" : "Official member directory"}">${u ? "Official page" : "Member directory"} ${I.ext}</a>` : "";
  }

  /* ---------- Find my legislators: address -> both districts ---------- */
  function pointInGeom(lon, lat, geom) {
    const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
    for (const poly of polys) {
      let hit = false;
      for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) hit = !hit;
      }
      if (hit) return true;
    }
    return false;
  }
  function districtAt(chId, lon, lat) { return (DIST[chId] || []).find((d) => d.geometry && pointInGeom(lon, lat, d.geometry)) || null; }
  function viewFind(params) {
    const lon = Number(params.x), lat = Number(params.y);
    const has = Number.isFinite(lon) && Number.isFinite(lat) && params.x;
    setTimeout(() => {
      const f = app.querySelector("#findForm"), inp = app.querySelector("#findAddr"), st = app.querySelector("#findStatus"), geo = app.querySelector("#findGeo");
      if (!f) return;
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const q = inp.value.trim();
        if (!q) return;
        st.textContent = "Looking up the address…";
        try {
          const url = "https://gisservices.its.ny.gov/arcgis/rest/services/Locators/Street_and_Address_Composite/GeocodeServer/findAddressCandidates?" + new URLSearchParams({ SingleLine: q, outSR: "4326", maxLocations: "1", f: "json" });
          const r = await (await fetch(url)).json();
          const c = r.candidates && r.candidates[0];
          if (!c || c.score < 80) { st.textContent = "That address wasn't found in New York State. Try adding the town and ZIP code."; return; }
          go("find", { a: c.address, x: c.location.x.toFixed(6), y: c.location.y.toFixed(6) });
        } catch (err) { st.textContent = "The state's address lookup didn't respond. Try again, or use your location."; }
      });
      if (geo) geo.addEventListener("click", () => {
        if (!navigator.geolocation) { st.textContent = "This browser can't share your location."; return; }
        st.textContent = "Finding your location…";
        navigator.geolocation.getCurrentPosition((pos) => go("find", { a: "Your location", x: pos.coords.longitude.toFixed(6), y: pos.coords.latitude.toFixed(6) }),
          () => { st.textContent = "Location wasn't shared. Enter an address instead."; }, { timeout: 10000 });
      });
    }, 0);
    const results = has ? CHAMBERS.map((c) => {
      const d = districtAt(c.id, lon, lat);
      if (!d) return `<section class="card"><h2>${esc(c.name)}</h2><p class="empty">This point isn't inside a New York ${esc(c.name)} district.</p></section>`;
      const db = dbFor(c.periods[0].id, c.id), u = d.unitName && db.byName.get(d.unitName);
      const m = (MEMBERS[c.id] || {})[d.unitName] || {}, g = demog(d.district, c.id);
      const e = m.election;
      const chq = { c: c.id, p: "" };
      return `<section class="card findcard"><div class="card-head"><h2>${esc(c.title || c.name)} District ${d.district}</h2>${d.party ? `<span class="ptag p${d.party.charAt(0)}">${esc(d.party.charAt(0))}</span>` : ""}</div>
        <p class="findname">${d.member ? esc(d.member) : "Vacant"}</p>
        ${m.contact && m.contact.districtOffice ? `<p class="summary">District office: ${esc(m.contact.districtOffice)}${m.contact.districtPhone ? ` · ${esc(m.contact.districtPhone)}` : ""}</p>` : ""}
        <div class="grid kpis small">
          ${u ? kpi("Office spending", money0(u.actual), `${esc(periodName(db))} · ${money0(u.perMonth)} a month`) : ""}
          ${u && g && g.pop ? kpi("Cost per resident", money(u.actual / g.pop), `${int.format(g.pop)} residents`) : ""}
          ${(() => { const en = enroll(d.district, c.id); return en ? kpi("Registered voters", int.format(en.total), `as of ${fmtDay(ENROLL[c.id].asOf)}`) : ""; })()}
          ${e ? kpi("2026 election", esc((ELECTION_LABEL[e.status] || [e.status])[0]), e.successor ? `${esc(e.successor)}` : "") : ""}
        </div>
        <p class="findlinks">${u ? `<a class="btn" href="${buildHash("unit/" + u.id, chq)}">Office spending &amp; staff ${I.r}</a>` : ""}
          <a class="btn" href="${buildHash("district/" + d.district, chq)}">District map &amp; results ${I.r}</a>
          ${DONATIONS[c.id] && DONATIONS[c.id].districts[String(d.district)] ? `<a class="btn" href="${buildHash("donations/" + d.district, chq)}">Campaign donations ${I.r}</a>` : ""}
          ${m.profileUrl ? `<a class="btn" href="${esc(m.profileUrl)}" target="_blank" rel="noopener">Official page ${I.ext}</a>` : ""}</p>
      </section>`;
    }).join("") : "";
    return `<h1>Find your legislators</h1>
      <p class="lede">Enter a New York address to see your Assembly member and State Senator, what their offices spend, how their 2026 races went, and who funds their campaigns.</p>
      <form class="filters findform" id="findForm" role="search" aria-label="Find legislators by address">
        <label class="wide">Street address, town and ZIP<input type="search" id="findAddr" autocomplete="street-address" placeholder="e.g. 200 Howell Ave, Riverhead NY 11901" value="${esc(params.a && params.a !== "Your location" ? params.a : "")}"></label>
        <div class="findbtns"><button class="primary" type="submit">Find</button><button type="button" id="findGeo">Use my location</button></div>
      </form>
      <p class="summary" id="findStatus" role="status" aria-live="polite">${has ? `Showing districts for <strong>${esc(params.a || "that point")}</strong>.` : "Addresses are looked up with the state's geocoding service (NYS ITS GIS); nothing is stored."}</p>
      <div class="grid two">${results}</div>`;
  }

  /* ---------- Vendors that also donate ---------- */
  function viewVendors() {
    const v = VENDOR_DONORS;
    if (!v) return `<h1>Vendors that also donate</h1><p class="empty">Not available.</p>`;
    const own = v.matches.filter((m) => m.ownOffice).length;
    return `<h1>Vendors that also donate</h1>
      <p class="lede">Businesses the Assembly and Senate paid (from every expenditure report on this site) that also gave to an Assembly or Senate candidate in 2025–26. ${v.matches.length} match by name; for ${own}, the member whose office paid the vendor is one of the candidates it gave to.</p>
      <div class="callout"><strong>What this does and doesn't show.</strong> Vendors may legally contribute to campaigns, and a match isn't evidence of wrongdoing. Names are matched only when they're the same after ignoring case, punctuation and suffixes like "Inc" or "LLC", or when the donor is the vendor's own PAC, so some real links are missed. Check any match against the expenditure records and the <a href="https://publicreporting.elections.ny.gov/" target="_blank" rel="noopener">State Board of Elections filings</a>.</div>
      ${v.matches.map((m) => { const paid = m.paid.assembly + m.paid.senate; return `<section class="card vd${m.ownOffice ? " own" : ""}"><div class="card-head"><h2>${esc(titleCase(m.vendor))}</h2><span class="summary">${m.ownOffice ? `<span class="echip maybe">Gave to a member whose office paid it</span> ` : ""}matched by ${esc(m.how)}</span></div>
        <div class="grid two">
          <div><h3 class="mini">Paid by the Legislature: ${money0(paid)}</h3><ul class="plainlist">${m.offices.map(([c, o, a]) => { const db = dbFor(CHAMBERS.find((x) => x.id === c).periods[0].id, c); const u = db && db.byName.get(o); return `<li>${u ? `<a href="${buildHash("records", { c, p: "", q: `"${m.vendor.toLowerCase()}"` })}">${esc(o)}</a>` : esc(o)} <span class="summary">(${esc(c === "senate" ? "Senate" : "Assembly")})</span> · ${money0(a)}</li>`; }).join("")}</ul></div>
          <div><h3 class="mini">Gave to candidates: ${money0(m.donated)} in ${m.gifts} ${m.gifts === 1 ? "gift" : "gifts"}</h3><ul class="plainlist">${m.recipients.map(([c, d, name, a, isOwn]) => `<li><a href="${buildHash("donations/" + d, { c, p: "" })}">${esc(name)}</a> <span class="summary">(${c === "senate" ? "SD" : "AD"} ${d})</span> · ${money0(a)}${isOwn ? ` <span class="echip maybe">own office paid this vendor</span>` : ""}</li>`).join("")}</ul>
            <p class="summary">As listed by the donor: ${m.donors.map(esc).join("; ")}</p></div>
        </div></section>`; }).join("")}
      <p class="summary">Vendors: payees on maintenance, operations and travel lines in the Assembly and Senate expenditure reports on this site. Donors: organizations giving to 2025–26 Assembly and Senate candidates' committees (State Board of Elections, data.ny.gov, as of ${esc(fmtDay(v.asOf))}).</p>`;
  }

  function focusHref(district) {
    return `https://nysfocus.com/interactives/2026-election-results/${CH.id === "senate" ? "state-senate" : "assembly"}/district-${district}/`;
  }

  /* State budget appropriations vs. what the expenditure reports show for the same fiscal year. */
  function budgetCard() {
    const b = BUDGET && BUDGET.chambers[CH.id];
    if (!b) return "";
    const [fyStart, fyEnd] = BUDGET.fiscalYears.appropriated;
    const pms = CH.periods.filter((pm) => pm.start >= fyStart && pm.end <= fyEnd);
    if (pms.length < 2) return "";
    const skip = new Set(b.separateOffices || []);
    const spent = { ps: 0, mo: 0, travel: 0 };
    for (const pm of pms) for (const u of dbFor(pm.id).unitStats) if (!skip.has(u.name)) for (const g of ["ps", "mo", "travel"]) spent[g] += u.byType[g] || 0;
    const appr = { ps: 0, mo: 0, travel: 0 }, req = { ps: 0, mo: 0, travel: 0 };
    for (const [, g, a, r] of b.lines) { appr[g] += a; req[g] += r; }
    const rows = [["ps", "Payroll (personal service)"], ["mo", "Operations (supplies, contracts, equipment)"], ["travel", "Travel"]];
    const tot = (o) => o.ps + o.mo + o.travel;
    const pct = (a, x) => (a ? (x / a * 100).toFixed(0) + "%" : "—");
    const bar = (a, x) => `<span class="track"><span class="fill" style="width:${Math.min(100, a ? x / a * 100 : 0).toFixed(1)}%"></span></span>`;
    const mem = b.lines[0];
    return `<section class="card budget"><div class="card-head"><h2>Budget vs. spending, fiscal year 2025–26</h2><span class="summary">State appropriation for the ${esc(CH.name)} compared with what its two expenditure reports show for Apr 2025 – Mar 2026</span></div>
      <div class="table-wrap"><table>
        <caption class="sr-only">${esc(CH.name)} appropriations and reported spending, fiscal year 2025–26</caption>
        <thead><tr><th scope="col">Category</th><th scope="col" class="num">Appropriated 2025–26</th><th scope="col" class="num">Reported spent</th><th scope="col">Share used</th><th scope="col" class="num">Requested 2026–27</th></tr></thead>
        <tbody>${rows.map(([g, l]) => `<tr><th scope="row">${l}</th><td class="num">${money0(appr[g])}</td><td class="num">${money0(spent[g])}</td><td class="share">${bar(appr[g], spent[g])}<span>${pct(appr[g], spent[g])}</span></td><td class="num">${money0(req[g])}</td></tr>`).join("")}
          <tr class="total"><th scope="row">Total</th><td class="num"><strong>${money0(tot(appr))}</strong></td><td class="num"><strong>${money0(tot(spent))}</strong></td><td class="share">${bar(tot(appr), tot(spent))}<span>${pct(tot(appr), tot(spent))}</span></td><td class="num"><strong>${money0(tot(req))}</strong></td></tr></tbody>
      </table></div>
      <p class="summary">Appropriations from the <a href="${esc(BUDGET.url)}" target="_blank" rel="noopener">FY 2027 Executive Budget presentation for the Legislature</a> (NYS Division of the Budget). They include ${esc(mem[0].toLowerCase())}: ${money0(mem[2])}, exactly ${CH.id === "senate" ? 63 : 150} × $142,000. An appropriation is a spending ceiling, not a bill, and the reports don't line up with it exactly: payroll is paid in arrears (April checks pay for March work), bills from one year are often paid in the next, and unspent appropriations from earlier years can be reappropriated, so a line can show more than 100%. ${esc(BUDGET.separateNote)}${b.related ? " " + b.related.map((r) => typeof r[1] === "number" ? `${esc(r[0])} has its own appropriation (${money0(r[1])} in 2025–26).` : `The ${esc(r[0])} is ${esc(r[1])}.`).join(" ") : ""}</p>
    </section>`;
  }

  function profileCard(s) {
    if (s.kind !== "member") return "";
    const m = memberInfo(s);
    const st = electionState(s);
    const c = m.contact || {};
    const special = m.assumedOffice && /\d{4}$/.test(m.assumedOffice) && Date.parse(m.assumedOffice) > Date.parse("2025-01-02");
    const srcs = st && st.e ? st.e.sources.map((k) => ELECTION_SOURCES[k]).filter(Boolean) : [];
    // Stipends / leadership pay lines paid to the member this period
    const own = DB.records.filter((r) => r.u === s.id && DB.types[r.t].group === "ps");
    const memberPayee = (own.find((r) => /^MEMBER( OF ASSEMBLY)?$/.test(DB.descs[r.d])) || {}).p;
    const stipends = own.filter((r) => r.p === memberPayee && !/^MEMBER( OF ASSEMBLY)?$/.test(DB.descs[r.d]));
    // Staff also paid by other offices this period
    const staff = new Set(own.map((r) => r.p).filter((p) => p !== memberPayee));
    const elsewhere = new Map();
    for (const r of DB.records) {
      if (r.u === s.id || !staff.has(r.p) || DB.types[r.t].group !== "ps") continue;
      const x = elsewhere.get(r.u) || { people: new Set(), amt: 0 };
      x.people.add(r.p); x.amt += r.amt; elsewhere.set(r.u, x);
    }
    const linked = (m.offices || []).map((n) => DB.byName.get(n)).filter(Boolean);
    const roles = m.roles || [];
    const roleGroups = ["leadership", "committee", "caucus"].map((k) => roles.filter((r) => r.kind === k)).filter((g) => g.length);
    return `<section class="card profile">
      <div class="profile-grid">
        <div>
          <h2 class="mini">Term of office</h2>
          <p>Current term: <strong>Jan 1, 2025 – Dec 31, 2026</strong> (two-year term; all ${esc(CH.name)} seats were on the Nov 3, 2026 ballot for the term starting Jan 1, 2027).</p>
          ${m.assumedOffice ? `<p class="summary">${special ? `Took office ${esc(m.assumedOffice)} (special election), serving the rest of the term.` : `In current district since ${esc(m.assumedOffice)}`} <span title="Ballotpedia's 'assumed office' date for the current district number; members who served before the 2022 redistricting can show a later date">(Ballotpedia)</span></p>` : ""}
        </div>
        <div>
          <h2 class="mini">2026 election</h2>
          ${st ? `<p>${electionChip(s)} ${st.cls === "change" ? `<span class="echip change soft">New member in Jan 2027</span>` : ""}</p>
          ${st.e ? `${(() => { const parts = [st.e.note ? esc(st.e.note) : "", st.e.successor ? `${successorLabel(st.e)}: <strong>${esc(st.e.successor)}</strong>${st.e.successorParty ? ` (${esc(st.e.successorParty)})` : ""}` : st.cls === "change" ? "Successor not yet reported in our sources" : ""].filter(Boolean); return parts.length ? `<p>${parts.join(". ")}.</p>` : ""; })()}
            ${boeResult(m)}
            ${m.district ? `<p class="summary"><a href="${focusHref(m.district)}" target="_blank" rel="noopener">Precinct-by-precinct results map ${I.ext}</a> (New York Focus)</p>` : ""}
            <p class="summary">Sources: ${srcs.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title.split(":")[0])}</a> (${esc(x.as_of)})`).join(" · ")}. Results are unofficial until certified.</p>`
          : `${boeResult(m)}<p class="summary">Not among the departures or losses reported in our sources (City &amp; State, Greenberg Traurig, Wikipedia). Results are unofficial until certified.</p>`}` : ""}
        </div>
        <div>
          <h2 class="mini">Offices</h2>
          ${c.districtOffice ? `<p><strong>District office</strong><br>${esc(c.districtOffice)}${c.districtPhone ? `<br>${esc(c.districtPhone)}` : ""}</p>` : ""}
          ${c.albanyPhone || c.email ? `<p><strong>Albany</strong>${c.albanyPhone ? `<br>${esc(c.albanyPhone)}` : ""}${c.email ? `<br><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""}</p>` : `<p class="summary">No contact details in the state's district layer.</p>`}
        </div>
      </div>
      ${roleGroups.length || linked.length || stipends.length || elsewhere.size ? `<div class="profile-grid">
        ${roleGroups.length ? `<div><h2 class="mini">Current posts</h2><ul class="plainlist">${roleGroups.flat().map((r) => `<li><span class="echip ${r.kind === "leadership" ? "lead" : "post"}">${r.kind === "leadership" ? "Leadership" : r.kind === "caucus" ? "Caucus / task force" : "Committee"}</span> ${esc(r.role)}</li>`).join("")}</ul></div>` : ""}
        ${linked.length || stipends.length ? `<div>
          ${linked.length ? `<h2 class="mini">Central offices tied to these posts</h2><ul class="plainlist">${linked.map((u) => `<li><a href="${unitHref(u.id)}">${esc(u.name)}</a> · ${money0(u.actual)}${u.staffCount ? ` · ${u.staffCount} people paid` : ""}</li>`).join("")}</ul>` : ""}
          ${stipends.length ? `<h2 class="mini">Leadership / committee pay this period</h2><ul class="plainlist">${stipends.map((r) => `<li>${esc(titleCase(DB.descs[r.d]))} · <strong>${money(r.amt)}</strong></li>`).join("")}</ul>` : ""}
        </div>` : ""}
        ${elsewhere.size ? `<div><h2 class="mini">Staff also paid by other offices</h2><ul class="plainlist">${[...elsewhere.entries()].sort((a, b) => b[1].amt - a[1].amt).slice(0, 8).map(([u, x]) => `<li><a href="${unitHref(u)}">${esc(DB.units[u].name)}</a> · ${x.people.size} ${x.people.size === 1 ? "person" : "people"} · ${money0(x.amt)}</li>`).join("")}</ul></div>` : ""}
      </div>` : ""}
      <p class="summary">Posts are current (2025–2026 session) from nyassembly.gov and Wikipedia; offices and contacts from the state's district data. The central offices listed are the ones these posts direct (e.g. a committee's own office).</p>
    </section>`;
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
    return `<th class="sortable ${cls}${active ? " sorted" + (state.dir === "asc" ? " asc" : "") : ""}" data-sort="${key}" scope="col"${active ? ` aria-sort="${state.dir === "asc" ? "ascending" : "descending"}"` : ""}><button type="button" class="th-sort">${label}<span class="sr-only">${active ? `, sorted ${state.dir === "asc" ? "ascending" : "descending"}` : ", sortable"}</span></button></th>`;
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

    const chg = PREV ? change(meta.totalActual, PREV.meta.totalActual) : null;
    return `
      <section class="hero">
        <div class="hero-text">
        <h1>The ${esc(CH.name)} spent <span class="hero-num">${compact(meta.totalActual)}</span> in ${esc(periodName(DB))}</h1>
        <p class="hero-sub">That's about <strong>${compact(meta.totalActual / DB.periodMonths)} a month</strong> on payroll, operations and travel${chg ? `, <span class="${chg.diff >= 0 ? "up" : "down"}">${chg.diff >= 0 ? I.up : I.down}${Math.abs(chg.pct).toFixed(1)}% ${chg.diff >= 0 ? "more" : "less"}</span> than ${esc(periodName(PREV))}` : ""}. Every one of the report's ${int.format(meta.rowCount)} lines is here, across ${meta.members} member offices and ${meta.offices} central offices and committees.</p>
        <p class="hero-find"><a href="${buildHash("find", {})}">Find your own Assembly member and Senator by address ${I.r}</a></p>
        <form class="hero-search" id="heroSearch" role="search" aria-label="Search this report"><input type="search" id="heroSearchInput" placeholder="Search a member, staffer, vendor or expense…" aria-label="Search this report"><button class="primary" type="submit">Search</button></form>
        </div>
        ${heroMap()}
      </section>
      <div class="grid kpis">
        ${kpi("Payroll", compact(totalBy.ps), `${int.format(staffAll.size)} people paid${DB.meta.payWindow ? `<br>for work ${esc(fmtShortDay(DB.meta.payWindow[0]))} – ${esc(fmtShortDay(DB.meta.payWindow[1]))}` : ""}${PREV ? "<br>" + vs("ps") : ""}`)}
        ${kpi("Maintenance &amp; operations", compact(totalBy.mo), PREV ? vs("mo") : "Rent, utilities, services")}
        ${kpi("Travel", compact(totalBy.travel), PREV ? vs("travel") : "Reimbursed to members &amp; staff")}
        ${kpi("Allocated costs", compact(meta.totalAllocated), "Informational only — see About")}
      </div>
      ${chambersCard()}
      ${makeupCard()}
      ${periodsCard()}
      ${budgetCard()}
      ${CH.id === "senate" ? (() => { const pr = payroll(); return pr ? payrollYearsCard(pr).replace("<h2>Senate payroll by year</h2>", `<h2><a href="${buildHash("payroll", {})}">Senate payroll by year</a></h2>`) : ""; })() : ""}
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
        <section class="card"><div class="card-head"><h2>Highest-spending member offices</h2><a href="${buildHash("units", { kind: "member" })}">All ${DB.members.length} ${I.r}</a></div>${bars(topMembers)}
          <p class="summary">Median member office: <strong>${money0(DB.memberMedian)}</strong>${PREV ? ` · ${periodName(PREV)}: ${money0(PREV.memberMedian)}` : ""}</p></section>
        <section class="card"><div class="card-head"><h2>Largest central offices &amp; committees</h2><a href="${buildHash("units", { kind: "office" })}">All offices ${I.r}</a></div>${bars(topOffices)}</section>
        <section class="card"><div class="card-head"><h2>Top vendors (M&amp;O)</h2><a href="${buildHash("payees", { group: "vendor" })}">All payees ${I.r}</a></div>${bars(topVendors)}</section>
        <section class="card"><div class="card-head"><h2>What M&amp;O money bought</h2></div>${bars(topDescs)}</section>
        ${travelCard()}
        ${PREV ? moversCard() : ""}
      </div>`;
  }

  // IRS business mileage rates (the State reimburses personal-car mileage at the IRS rate).
  // 2025: 70¢; Jan 1 2026: 72.5¢; Jul 1 2026: 76¢. Applied by the trip's start date, which is
  // what the Senate's amounts fit: ~95% of trips divide into whole miles this way.
  const IRS_RATES = [["2026-07-01", 0.76], ["2026-01-01", 0.725], ["2025-01-01", 0.70], ["2024-01-01", 0.67]];
  function irsRate(iso) { const r = IRS_RATES.find(([from]) => (iso || "") >= from); return r ? r[1] : null; }
  function tripMiles(t) {
    const i = DB.travel.categories.indexOf("Personal Car Mileage");
    const rate = irsRate(t.begin || t.check);
    return i >= 0 && t.amounts[i] && rate ? t.amounts[i] / rate : 0;
  }
  function tripsSummary(trips) {
    const cats = DB.travel.categories.map((c, i) => ({ label: c, value: trips.reduce((a, t) => a + t.amounts[i], 0) })).filter((x) => x.value);
    const dest = sumBy(trips.map((t) => ({ dest: t.dest, amt: t.total })), (t) => t.dest).sort((a, b) => b.total - a.total);
    const days = trips.reduce((a, t) => a + (t.begin && t.end ? Math.round((Date.parse(t.end) - Date.parse(t.begin)) / 864e5) + 1 : 0), 0);
    const miles = trips.reduce((a, t) => a + tripMiles(t), 0);
    return { cats: cats.sort((a, b) => b.value - a.value), dest, days, miles };
  }
  function travelCard() {
    if (!DB.travel) return "";
    const all = [...DB.travel.byUnit.values()].flat();
    if (!all.length) return "";
    const { cats, dest, days, miles } = tripsSummary(all);
    return `<section class="card"><div class="card-head"><h2>Senator travel: what it paid for</h2><span class="summary">${int.format(all.length)} trips · ${int.format(days)} travel days · ≈${int.format(Math.round(miles))} miles driven</span></div>
      ${bars(cats.map((c) => ({ label: c.label, value: c.value })))}
      <h3 class="mini" style="margin-top:12px">Most common destinations</h3>
      <ul class="bars plain">${dest.slice(0, 6).map((d) => `<li><span class="name">${esc(d.key)} · ${d.count} trips</span><span class="amt">${money0(d.total)}</span></li>`).join("")}</ul>
      <p class="summary">Miles are recovered from mileage reimbursements at the IRS rate on each trip's start date. <a href="${buildHash("about", {})}">Travel rules on the About page ${I.r}</a></p>
    </section>`;
  }

  function heroMap() {
    if (!DISTRICTS.length) return "";
    const box = bboxOf(DISTRICTS.map((d) => ({ geometry: d.geometry })));
    const proj = makeProjection(box, 300);
    const vals = DISTRICTS.map((d) => { const u = d.unitName && DB.byName.get(d.unitName); return u ? u.actual : null; });
    const scale = binsFor(vals, false);
    return `<a class="hero-map" href="${buildHash("map", {})}" aria-label="Open the district map">
      <svg viewBox="0 0 300 ${proj.height.toFixed(0)}" aria-hidden="true">${DISTRICTS.map((d, i) => `<path d="${pathFor(d.geometry, proj)}" fill="${scale.color(vals[i])}"></path>`).join("")}</svg>
      <span>Member office spending by district ${I.r}</span></a>`;
  }

  function periodsCard() {
    const ps = (CH.periods || []).slice().sort((a, b) => a.end.localeCompare(b.end));
    if (ps.length < 3) return "";
    const max = Math.max(1, ...ps.map((p) => p.totalActual));
    const lab = (p) => { const s = new Date(p.start + "T12:00:00"), e = new Date(p.end + "T12:00:00"); const m = (d) => d.toLocaleDateString("en-US", { month: "short" }); return `${m(s)}–${m(e)} ’${String(e.getFullYear()).slice(2)}`; };
    const first = ps[0], last = ps[ps.length - 1];
    const chg = first.totalActual ? (last.totalActual / first.totalActual - 1) * 100 : 0;
    return `<section class="card"><div class="card-head"><h2>Every ${esc(CH.name)} report on file</h2><span class="summary">actual spending per six-month report · ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% from ${esc(lab(first))} to ${esc(lab(last))} · click a report to open it</span></div>
      <div class="cols">${ps.map((p) => `<a class="col${p.id === DB.id ? " me" : ""}" href="${buildHash("", { p: p.id })}" title="${esc(lab(p))}: ${money(p.totalActual)} actual, ${int.format(p.rowCount)} lines" aria-label="${esc(lab(p))}: ${money(p.totalActual)} actual spending${p.id === DB.id ? " (showing)" : ""}"${p.id === DB.id ? ' aria-current="page"' : ""}>
        <span class="colval">${compact(p.totalActual)}</span>
        <span class="colbar" style="height:${(p.totalActual / max * 100).toFixed(1)}%"></span>
        <span class="collabel">${esc(lab(p))}</span></a>`).join("")}</div></section>`;
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
        <span class="chamber-meta">${money0(r.db.meta.totalActual / r.db.periodMonths)} a month · ${r.db.meta.members} member offices · median member office ${money0(r.db.memberMonthlyMedian)} a month</span>
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
    const state = { q: params.q || "", kind: params.kind || "", party: params.party || "", seat: params.seat || "", sort: params.sort || "actual", dir: params.dir || "desc" };
    const tokens = tokenize(state.q);
    const dist = (s) => DISTRICT_BY_UNIT.get(s.name);
    let list = DB.unitStats.filter((s) => (!state.kind || s.kind === state.kind) && matchesTokens(s.name.toLowerCase(), tokens)
      && (!state.party || (dist(s) && dist(s).party === state.party))
      && (!state.seat || (electionState(s) && electionState(s).cls === state.seat)));
    const val = {
      name: (s) => s.name, district: (s) => (dist(s) ? dist(s).district : 999), actual: (s) => s.actual, ps: (s) => s.byType.ps || 0, mo: (s) => s.byType.mo || 0,
      travel: (s) => s.byType.travel || 0, allocated: (s) => s.allocated, staff: (s) => s.staffCount,
      change: (s) => { const p = prevUnit(s); return p ? s.actual - p.actual : -Infinity; },
      month: (s) => s.perMonth,
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
        <label>2026 election<select id="useat"><option value="">Any</option><option value="change"${state.seat === "change" ? " selected" : ""}>New member in 2027</option><option value="maybe"${state.seat === "maybe" ? " selected" : ""}>Not yet called</option><option value="same"${state.seat === "same" ? " selected" : ""}>Returning</option></select></label>
        ${DISTRICTS.length ? `<label>Party<select id="uparty"><option value="">Any</option>${[...new Set(DISTRICTS.map((d) => d.party).filter(Boolean))].sort().map((p) => `<option${p === state.party ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="toolbar"><span class="summary"><strong>${int.format(list.length)}</strong> shown · actual spending <strong>${money0(total)}</strong> · <strong>${money0(total / DB.periodMonths)}</strong> a month · * active part of the period, per month uses months active</span>
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
          ${sortHeader("Per month", "month", state, "num")}
          ${sortHeader("Allocated", "allocated", state, "num")}
          ${sortHeader("People paid", "staff", state, "num")}
          ${PREV ? sortHeader("vs prior", "change", state, "num") : ""}
        </tr></thead>
        <tbody>${list.length ? list.map((s, i) => `<tr>
          <td class="num">${i + 1}</td>
          <td class="namecell"><a href="${unitHref(s.id)}">${highlight(s.name, tokens)}</a></td>
          <td class="nowrap">${dist(s) ? `${CH.abbr} ${dist(s).district}` : ""}</td>
          <td>${kindChip(s.kind)} ${electionChip(s, true)}</td>
          <td class="num">${money0(s.byType.ps || 0)}</td>
          <td class="num">${money0(s.byType.mo || 0)}</td>
          <td class="num">${money0(s.byType.travel || 0)}</td>
          <td class="num"><strong>${money0(s.actual)}</strong></td>
          <td class="num" title="${s.partial ? `Active about ${s.months} of ${DB.periodMonths} months` : `${DB.periodMonths}-month report period`}">${money0(s.perMonth)}${s.partial ? "*" : ""}</td>
          <td class="num">${money0(s.allocated)}</td>
          <td class="num">${s.staffCount}</td>
          ${PREV ? (() => { const c = change(s.actual, prevUnit(s) && prevUnit(s).actual); return `<td class="num${c && c.diff < 0 ? " neg" : ""}" title="${c ? esc(changeText(c)) : "Not in prior period"}">${changeText(c, true)}</td>`; })() : ""}
        </tr>`).join("") : `<tr><td colspan="12" class="empty">No members or offices match.</td></tr>`}</tbody>
      </table></div>`;
    app.innerHTML = html;

    const update = (patch) => go("units", { ...state, ...patch }, true);
    const uq = app.querySelector("#uq");
    let timer;
    uq.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { update({ q: uq.value }); focusEnd("#uq"); }, 200); });
    app.querySelector("#ukind").addEventListener("change", (e) => update({ kind: e.target.value }));
    app.querySelector("#useat").addEventListener("change", (e) => update({ seat: e.target.value, kind: e.target.value ? "member" : state.kind }));
    const up = app.querySelector("#uparty");
    if (up) up.addEventListener("change", (e) => update({ party: e.target.value }));
    wireSortHeaders(app, state, update, { name: "asc", district: "asc" });
    app.querySelector("#uexport").addEventListener("click", () => downloadCSV("assembly-units.csv",
      ["Period", "Name", "District", "Party", "Type", "2026 election", "Months active", "Per month", "Payroll", "M&O", "Travel", "Actual total", "Allocated", "People paid"],
      list.map((s) => [periodName(DB), s.name, dist(s) ? dist(s).district : "", dist(s) ? dist(s).party : "", s.kind, electionState(s) ? electionState(s).label : "", s.months, s.perMonth.toFixed(2), (s.byType.ps || 0).toFixed(2), (s.byType.mo || 0).toFixed(2), (s.byType.travel || 0).toFixed(2), s.actual.toFixed(2), s.allocated.toFixed(2), s.staffCount])));
    return null;
  }

  function viewUnit(id) {
    const s = DB.unitStats[Number(id)];
    if (!s) return `<p class="empty">That member or office wasn't found. <a href="${buildHash("units", {})}">Back to the list</a>.</p>`;
    const { types, payees, descs, meta } = DB;
    const recs = DB.records.filter((r) => r.u === s.id);
    const code = (r) => types[r.t].group;
    const seenSal = new Set();
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
      <div class="crumbs"><a href="${buildHash("units", { kind: s.kind })}">${I.l} ${s.kind === "member" ? "Members" : "Offices"}</a></div>
      <div class="title-row"><h1>${esc(s.name)} ${kindChip(s.kind)}${districtChip(s)}</h1>
        <div class="title-actions">${officialLink(s)}${ballotpediaLink(s)}<a class="btn" href="${buildHash("compare", { u: s.kind === "member" ? [s.name, DB.members[Math.floor(DB.members.length / 2)].name].filter((v, i, a) => a.indexOf(v) === i).join("|") : s.name })}">Compare…</a></div></div>
      <p class="lede">${rankNote || "Central office, committee, or task force."}</p>
      ${profileCard(s)}
      ${s.kind === "member" && memberInfo(s).district ? demogCard(memberInfo(s).district, s) + votersCard(memberInfo(s).district, s) : ""}
      ${s.kind === "member" && memberInfo(s).district ? campaignCard(memberInfo(s).district, displayName(s)) : ""}
      ${CH.id === "senate" ? officeYearsCard(payroll(), s.name) : ""}
      <div class="grid kpis">
        ${kpi("Actual spending", money0(s.actual), ps ? changeText(change(s.actual, ps.actual)) : (PREV ? "Not in prior period" : ""))}
        ${kpi("Per month", money0(s.perMonth), s.partial ? `active ≈${s.months} of ${DB.periodMonths} months` : `${DB.periodMonths}-month period${s.kind === "member" ? ` · member median ${money0(DB.memberMonthlyMedian)}` : ""}`)}
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
          <thead><tr><th>Name</th><th>Title / description</th><th>Service dates</th><th>Pay status</th><th class="num">Amount</th><th class="num" title="This person's regular pay in this office, scaled to a full year">Annualized</th></tr></thead>
          <tbody>${staffRows.map((r) => { const sal = DB.salaryByKey.get(s.id + "|" + r.p); const showSal = sal && !seenSal.has(r.p) && (seenSal.add(r.p), true); return `<tr>
            <td><a href="${buildHash("records", { payee: payees[r.p] })}">${esc(payees[r.p])}</a></td>
            <td>${esc(titleCase(descs[r.d]))}</td>
            <td class="nowrap mono">${esc(r.svc)}</td>
            <td>${r.st ? `<span class="chip muted" title="${esc(statusName(r.st))}">${esc(r.st)}${/as published/.test(statusName(r.st)) ? "" : ` · ${esc(statusName(r.st).split(" (")[0])}`}</span>` : ""}</td>
            <td class="num${r.amt < 0 ? " neg" : ""}">${money(r.amt)}</td>
            <td class="num">${showSal ? `<a href="${buildHash("salaries", { q: `"${payees[r.p].toLowerCase()}"` })}" title="${esc(salaryTip(sal))}">${money0(sal.annual)}</a>` : ""}</td></tr>`; }).join("")}</tbody>
        </table></div>
        <p class="summary">Annualized = a person's regular pay in this office divided by the days it covers, scaled to a year of 26 biweekly pay periods. One-time payments (lump sums, deferrals, stipends) aren't annualized. ${payWindowNote(DB)} <a href="${buildHash("salaries", {})}">All salaries ${I.r}</a></p>` : `<p class="empty">No payroll lines.</p>`}
      </section>

      <div class="grid two">
        <section class="card"><div class="card-head"><h2>M&amp;O payees</h2></div>
          ${bars(vendors.slice(0, 12).map((v) => ({ label: payees[v.key] || "(no payee listed)", value: v.total, href: buildHash("records", { unit: s.id, payee: payees[v.key] }) })))}</section>
        <section class="card"><div class="card-head"><h2>M&amp;O by purpose</h2></div>
          ${bars(moDescs.map((v) => ({ label: titleCase(descs[v.key]), value: v.total })))}</section>
      </div>

      ${unitTrips(s)}
      <section class="card">
        <div class="card-head"><h2>Travel</h2><span class="summary">${money(s.byType.travel || 0)}</span></div>
        ${travel.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Voucher date</th><th>Payee</th><th>Purpose</th><th>Voucher</th><th class="num">Amount</th></tr></thead>
          <tbody>${travel.map((r) => `<tr><td class="nowrap">${fmtDate(r.date)}</td><td>${esc(payees[r.p])}</td><td>${esc(titleCase(descs[r.d]))}</td><td class="mono">${esc(r.voucher)}</td><td class="num${r.amt < 0 ? " neg" : ""}">${money(r.amt)}</td></tr>`).join("")}</tbody>
        </table></div>` : `<p class="empty">No travel reimbursements.</p>`}
      </section>

      <section class="card"><div class="card-head"><h2>Allocated operational costs</h2><span class="summary">shares of centrally paid costs</span></div>${bars(allocated)}</section>

      ${otherPeriodLinks(s)}
      <p><a class="btn" href="${buildHash("records", { unit: s.id })}">See all ${int.format(recs.length)} records for this ${s.kind === "member" ? "member" : "office"} ${I.r}</a></p>`;
  }

  function unitTrips(s) {
    const trips = DB.travel && DB.travel.byUnit.get(s.id);
    if (!trips || !trips.length) return "";
    const { cats, dest, days, miles } = tripsSummary(trips);
    const cols = DB.travel.categories.map((c, i) => ({ c, i })).filter(({ i }) => trips.some((t) => t.amounts[i]));
    const hasMiles = miles > 0;
    const sorted = trips.slice().sort((a, b) => (a.begin || "").localeCompare(b.begin || ""));
    return `<section class="card"><div class="card-head"><h2>Member trips</h2><span class="summary">${trips.length} trips · ${int.format(days)} travel days${hasMiles ? ` · ≈${int.format(Math.round(miles))} miles` : ""} · ${money(trips.reduce((a, t) => a + t.total, 0))}</span></div>
      <div class="grid two">
        <div><h2 class="mini">What it paid for</h2>${bars(cats.map((c) => ({ label: c.label, value: c.value })))}</div>
        <div><h2 class="mini">Destinations</h2><ul class="bars plain">${dest.slice(0, 8).map((d) => `<li><span class="name">${esc(d.key)} · ${d.count} ${d.count === 1 ? "trip" : "trips"}</span><span class="amt">${money0(d.total)}</span></li>`).join("")}</ul></div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table>
        <thead><tr><th>Travel dates</th><th>Destination</th><th>Purpose</th>${cols.map(({ c }) => `<th class="num">${esc(c)}</th>`).join("")}${hasMiles ? `<th class="num" title="Mileage reimbursement ÷ IRS rate on the trip's start date">≈ Miles</th>` : ""}<th class="num">Total</th></tr></thead>
        <tbody>${sorted.map((t) => `<tr><td class="nowrap">${fmtDate(t.begin)}${t.end && t.end !== t.begin ? ` – ${fmtDate(t.end)}` : ""}</td><td>${esc(t.dest)}</td><td>${esc(titleCase(t.purpose))}</td>
          ${cols.map(({ i }) => `<td class="num">${t.amounts[i] ? money(t.amounts[i]) : ""}</td>`).join("")}${hasMiles ? `<td class="num">${tripMiles(t) ? int.format(Math.round(tripMiles(t))) : ""}</td>` : ""}<td class="num"><strong>${money(t.total)}</strong></td></tr>`).join("")}</tbody>
      </table></div>
      <p class="summary">From the Senate's member travel detail file; each trip is matched to its voucher in the expenditure report by check date and amount. Miles are recovered from the mileage reimbursement at the IRS rate in effect on the trip's start date. <a href="${buildHash("about", {})}">Travel rules on the About page ${I.r}</a></p>
    </section>`;
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
    if (state.payee) active.push(`<span class="chip">Payee: ${esc(state.payee)} <a href="${buildHash("records", { ...state, payee: "", page: "" })}" aria-label="Remove payee filter">${I.x}</a></span>`);

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
        <button id="rprev"${page <= 1 ? " disabled" : ""}>${I.l} Prev</button>
        <span>Page ${page} of ${int.format(pages)}</span>
        <button id="rnext"${page >= pages ? " disabled" : ""}>Next ${I.r}</button>
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

  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y), m = Math.floor(a.length / 2);
    return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : 0;
  }
  function salaryTip(sal) {
    return sal.basis === "lump"
      ? `Senate member line: the report gives only a check date and one amount. ${money(sal.paid)} is ≈ ${(sal.days / 14).toFixed(1)} biweekly checks at the ${money0(sal.annual)} base salary set in law.`
      : `${int.format(sal.days)} days of regular pay (${money(sal.paid)}) scaled to 364 days`;
  }
  function payWindowNote(db) {
    const w = db.meta.payWindow;
    if (!w) return "";
    return `Payroll is paid in arrears: most pay lines in this ${esc(periodName(db))} report cover work from <strong>${esc(fmtDay(w[0]))}</strong> to <strong>${esc(fmtDay(w[1]))}</strong>, as the report lists them.`;
  }
  function fmtShortDay(iso) { return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }).replace(/, (\d\d)$/, " ’$1"); }
  function fmtDay(iso) { return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }

  function viewSalaries(params) {
    const state = { q: params.q || "", kind: params.kind || "", min: params.min || "", sort: params.sort || "annual", dir: params.dir || "desc", page: Math.max(1, Number(params.page) || 1) };
    const tokens = tokenize(state.q);
    const { units, payees } = DB;
    const all = DB.salaries;
    let list = all.filter((x) => (!state.kind || units[x.u].kind === state.kind)
      && (!state.min || x.annual >= Number(state.min))
      && matchesTokens(`${payees[x.p]} | ${x.titles} | ${units[x.u].name}`.toLowerCase(), tokens));
    const key = { name: (x) => payees[x.p], title: (x) => x.titles, office: (x) => units[x.u].name, annual: (x) => x.annual, paid: (x) => x.paid, days: (x) => x.days }[state.sort] || ((x) => x.annual);
    list.sort((a, b) => { const x = key(a), y = key(b); const c = typeof x === "string" ? x.localeCompare(y) : x - y; return state.dir === "asc" ? c : -c; });
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(state.page, pages);
    const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    // Most common titles, with the spread of annualized pay (members' own salaries excluded).
    const byTitle = new Map();
    for (const x of list) {
      if (/^MEMBER( OF ASSEMBLY)?$/.test(x.titles)) continue;
      const t = x.titles.split(" → ").pop();
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(x.annual);
    }
    const titles = [...byTitle.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 12);
    const tmax = Math.max(1, ...titles.map(([, v]) => Math.max(...v)));

    const staff = list.filter((x) => !/^MEMBER( OF ASSEMBLY)?$/.test(x.titles));
    const pr = CH.id === "senate" ? payroll() : null;
    const nowCell = (pr, name, office) => {
      if (pr === undefined) return `<td class="num summary">…</td>`;
      const n = payNow(pr, name, office);
      const link = `<a href="${buildHash("person", { name })}" title="Pay history across every Senate payroll report">`;
      if (!n) return `<td class="num summary">—</td>`;
      if (n.gone) return `<td class="num summary">${link}left</a></td>`;
      return `<td class="num nowrap">${link}${rateText(n.seg[2], n.seg[3], true)}</a>${pr.offices[n.seg[0]] !== office ? `<br><span class="summary">now ${esc(titleCase(pr.offices[n.seg[0]]))}</span>` : ""}</td>`;
    };
    app.innerHTML = `
      <h1>Salaries</h1>
      <p class="lede">Every person on the ${esc(CH.name)} payroll in ${esc(periodName(DB))}, with their regular pay normalized to a yearly rate so part-period and full-period employees can be compared.</p>
      <div class="callout"><strong>How it's calculated.</strong> For each person in each office, regular pay lines are added up and divided by the days their service dates cover, then scaled to 364 days (26 biweekly pay periods). A member paid $70,999.98 for 182 days annualizes to $142,000, the legislative base salary. One-time payments (lump-sum vacation, deferral payments, stipends, allowances, back pay) and stints under one pay period are left out. ${CH.id === "senate" ? "Senators' own MEMBER lines are different: the Senate reports them with only a check date and one amount for the whole report (usually $71,000, 13 checks; $65,538, 12 checks, in the report ending March 2025). Their rate is the base salary set in law, and the amount is shown as a number of biweekly checks at that rate. Leadership stipends (Temporary President, Minority Leader and so on) are paid in uneven lumps and are shown as reported on each senator's page, not annualized." : ""} New York's base legislator salary is $142,000 (<a href="https://www.ncsl.org/about-state-legislatures/2025-legislator-compensation" target="_blank" rel="noopener">NCSL, 2025</a>). It's an estimate of a yearly rate, not a reported salary.</div>
      <p class="summary paywin">${payWindowNote(DB)}</p>
      ${CH.id === "senate" && pr ? payrollYearsCard(pr) : ""}
      <div class="grid kpis">
        ${kpi("People annualized", int.format(list.length), `of ${int.format(all.length)} in this report`)}
        ${kpi("Median staff rate", money0(median(staff.map((x) => x.annual))), "excluding members")}
        ${kpi("Staff at $100K+", int.format(staff.filter((x) => x.annual >= 100000).length), "annualized")}
        ${kpi("Highest rate", staff.length ? money0(Math.max(...staff.map((x) => x.annual))) : "—", "excluding members")}
      </div>
      ${titles.length ? `<section class="card"><div class="card-head"><h2>Annualized pay by title</h2><span class="summary">most common titles · bar = lowest to highest, dot = median</span></div>
        <div class="ranges">${titles.map(([t, v]) => { const lo = Math.min(...v), hi = Math.max(...v), md = median(v); return `<div class="range-row">
          <a class="range-name" href="${buildHash("salaries", { q: `"${t.toLowerCase()}"` })}">${esc(titleCase(t))} <span class="summary">· ${v.length}</span></a>
          <div class="range-track"><span class="range-bar" style="left:${(lo / tmax * 100).toFixed(1)}%;width:${Math.max(0.5, (hi - lo) / tmax * 100).toFixed(1)}%"></span><span class="range-med" style="left:${(md / tmax * 100).toFixed(1)}%" title="median ${money0(md)}"></span></div>
          <span class="range-val">${money0(md)}</span></div>`; }).join("")}</div></section>` : ""}
      <div class="filters">
        <label class="wide">Search name, title or office<input type="search" id="sq" value="${esc(state.q)}" placeholder="e.g. chief of staff, counsel, Heastie"></label>
        <label>Office type<select id="skind"><option value="">All offices</option><option value="member"${state.kind === "member" ? " selected" : ""}>Member offices</option><option value="office"${state.kind === "office" ? " selected" : ""}>Central offices</option></select></label>
        <label>Annualized at least $<input type="number" id="smin" value="${esc(state.min)}" step="1000" inputmode="numeric"></label>
      </div>
      <div class="toolbar"><span class="summary"><strong>${int.format(list.length)}</strong> people · median <strong>${money0(median(list.map((x) => x.annual)))}</strong></span>
        <button id="sexport" class="primary"${list.length ? "" : " disabled"}>Export ${int.format(list.length)} as CSV</button></div>
      <div class="table-wrap"><table>
        <thead><tr>${sortHeader("Name", "name", state)}${sortHeader("Title", "title", state)}${sortHeader("Office", "office", state)}<th>Covered</th>${sortHeader("Days", "days", state, "num")}${sortHeader("Regular pay", "paid", state, "num")}${sortHeader("Annualized", "annual", state, "num")}${CH.id === "senate" ? `<th class="num" title="Rate on the Senate's latest biweekly payroll report">Rate now</th>` : ""}</tr></thead>
        <tbody>${slice.length ? slice.map((x) => `<tr>
          <td><a href="${buildHash("records", { payee: payees[x.p] })}">${highlight(payees[x.p], tokens)}</a></td>
          <td>${highlight(titleCase(x.titles), tokens)}</td>
          <td><a href="${unitHref(x.u)}">${highlight(units[x.u].name, tokens)}</a></td>
          <td class="nowrap mono">${x.basis === "lump" ? `check ${esc(x.to)}` : `${esc(x.from)} – ${esc(x.to)}`}</td>
          <td class="num"${x.basis === "lump" ? ` title="${esc(salaryTip(x))}"` : ""}>${x.basis === "lump" ? "≈" : ""}${int.format(x.days)}</td>
          <td class="num">${money(x.paid)}</td>
          <td class="num"><strong>${money0(x.annual)}</strong></td>${CH.id === "senate" ? nowCell(pr, payees[x.p], units[x.u].name) : ""}</tr>`).join("") : `<tr><td colspan="8" class="empty">No one matches.</td></tr>`}</tbody>
      </table></div>
      <div class="pager"><button id="sprev"${page <= 1 ? " disabled" : ""}>${I.l} Prev</button><span>Page ${page} of ${int.format(pages)}</span><button id="snext"${page >= pages ? " disabled" : ""}>Next ${I.r}</button></div>`;

    const update = (patch) => go("salaries", { ...state, page: "", ...patch }, true);
    const sq = app.querySelector("#sq");
    let timer;
    sq.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { update({ q: sq.value }); focusEnd("#sq"); }, 220); });
    app.querySelector("#skind").addEventListener("change", (e) => update({ kind: e.target.value }));
    app.querySelector("#smin").addEventListener("change", (e) => update({ min: e.target.value }));
    wireSortHeaders(app, state, update, { name: "asc", title: "asc", office: "asc" });
    app.querySelector("#sprev").addEventListener("click", () => { update({ page: page - 1 }); window.scrollTo(0, 0); });
    app.querySelector("#snext").addEventListener("click", () => { update({ page: page + 1 }); window.scrollTo(0, 0); });
    app.querySelector("#sexport").addEventListener("click", () => downloadCSV(`${CH.id}-salaries-annualized.csv`,
      ["Chamber", "Period", "Name", "Title(s)", "Office", "From", "To", "Days covered", "Regular pay", "Annualized"],
      list.map((x) => [CH.name, periodName(DB), payees[x.p], x.titles, units[x.u].name, x.from, x.to, x.days, x.paid.toFixed(2), x.annual.toFixed(2)])));
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
      ${VENDOR_DONORS && VENDOR_DONORS.matches.length ? `<p><a class="btn" href="${buildHash("vendors", {})}">Vendors that also donated to legislative campaigns (${VENDOR_DONORS.matches.length}) ${I.r}</a></p>` : ""}
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
        <button id="pprev"${page <= 1 ? " disabled" : ""}>${I.l} Prev</button>
        <span>Page ${page} of ${int.format(pages)}</span>
        <button id="pnext"${page >= pages ? " disabled" : ""}>Next ${I.r}</button>
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
      <a class="col" ${m.href ? `href="${m.href}"` : ""} title="${monthLabel(m.key)}: ${money(m.total)}" aria-label="${monthLabel(m.key)}: ${money(m.total)}">
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
          <button class="link remove" data-name="${esc(s.name)}" aria-label="Remove ${esc(s.name)}">${I.x}</button></th>`).join("")}</tr></thead>
        <tbody>
          ${metric("Actual spending", (s) => s.actual)}
          ${metric("Per month", (s) => s.perMonth)}
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
          return picked.map((s, i) => `<div><h2 class="mini">${esc(s.name)}</h2>${columns(series[i], { small: true, max: shared })}</div>`).join("");
        })()}</div>
      </section>

      <section class="card"><div class="card-head"><h2>Top M&amp;O purposes</h2></div>
        <div class="grid compare-months">${picked.map((s) => {
          const mo = DB.records.filter((r) => r.u === s.id && DB.types[r.t].group === "mo");
          const top = sumBy(mo, (r) => r.d).sort((a, b) => b.total - a.total).slice(0, 6);
          return `<div><h2 class="mini">${esc(s.name)}</h2>${bars(top.map((v) => ({ label: titleCase(DB.descs[v.key]), value: v.total })))}</div>`;
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
    month: { label: "Cost per month", get: (s) => s.perMonth },
    ps: { label: "Payroll", get: (s) => s.byType.ps || 0 },
    mo: { label: "Maintenance & operations", get: (s) => s.byType.mo || 0 },
    travel: { label: "Travel", get: (s) => s.byType.travel || 0 },
    staff: { label: "People paid", get: (s) => s.staffCount, fmt: (v) => int.format(v) },
    resident: { label: "Office cost per resident", get: (s) => perResident(s), fmt: (v) => money(v) },
    income: { label: "Median household income", get: (s) => { const d = DISTRICT_BY_UNIT.get(s.name); const g = d && demog(d.district); return g ? g.income : null; } },
    poverty: { label: "Poverty rate", get: (s) => { const d = DISTRICT_BY_UNIT.get(s.name); return povertyRate(d && demog(d.district)); }, fmt: (v) => (v * 100).toFixed(1) + "%" },
    voters: { label: "Registered voters", get: (s) => { const e = enrollFor(s); return e ? e.total : null; }, fmt: (v) => int.format(v) },
    voter: { label: "Office cost per registered voter", get: (s) => { const e = enrollFor(s); return e && e.total ? s.actual / e.total : null; }, fmt: (v) => money(v) },
    turnout: { label: "2026 votes cast ÷ registered", get: (s) => turnout(enrollFor(s)), fmt: (v) => (v * 100).toFixed(1) + "%" },
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
      return `<svg class="map" id="${id}" viewBox="0 0 ${width} ${proj.height.toFixed(0)}" role="group" aria-label="${esc(metric.label)} by ${esc(CH.name)} district">
        ${features.map((r) => `<path d="${pathFor(r.d.geometry, proj)}" fill="${r.dim ? "var(--surface)" : scale.color(r.value)}"
          class="district${r.dim ? " dim" : ""}" data-d="${r.d.district}" role="link" tabindex="0" aria-label="District ${r.d.district}, ${esc(r.d.member)}"></path>`).join("")}
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
    const zoomSvg = `<svg class="map" id="mapZoom" viewBox="0 0 560 ${proj.height.toFixed(0)}" role="group" aria-label="District ${d.district} and neighboring districts">
      ${focus.map((x) => { const u = unitOf(x); return `<path d="${pathFor(x.geometry, proj)}" class="district${x === d ? " focus" : ""}" data-d="${x.district}"
        fill="${scale.color(u ? u.actual : null)}" role="link" tabindex="0" aria-label="District ${x.district}"></path>`; }).join("")}
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
      <div class="crumbs"><a href="${buildHash("map", {})}">${I.l} District map</a></div>
      <div class="title-row district-head">
        <div><h1>${esc(CH.name)} District ${d.district} ${s ? electionChip(s, true) : ""}</h1>
          <p class="lede">${esc(d.member)}${d.party ? ` · ${esc(d.party)}` : ""}${s ? ` · <a href="${unitHref(s.id)}">member office page ${I.r}</a>` : ""}${s && (BALLOTPEDIA[CH.id] || {})[s.name] ? ` · <a href="${esc(BALLOTPEDIA[CH.id][s.name])}" target="_blank" rel="noopener">Ballotpedia ${I.ext}</a>` : ""}</p></div>
        <div class="dnav"><a class="btn" href="${dHref(prevD)}" aria-label="Previous district">${I.l} ${CH.abbr} ${prevD.district}</a>${picker}<a class="btn" href="${dHref(nextD)}" aria-label="Next district">${CH.abbr} ${nextD.district} ${I.r}</a></div>
      </div>`;

    if (!s) {
      return `${head}<div class="map-layout"><section class="card">${zoomSvg}</section><section class="card">${locator}
        <p class="empty">${/^vacant$/i.test(d.member) ? `The state's district layer lists this seat as vacant, so there's no member office to show.` : `No spending data for this district's member in ${esc(periodName(DB))}. Their office may not appear in this report (for example, a member who took office after it). Try the other report period in the header.`}</p></section></div>`;
    }

    const members = DB.members;
    const metrics = [
      ["Actual spending", (u) => u.actual, money0],
      ["Cost per month", (u) => u.perMonth, money0],
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
        <section class="card"><div class="card-head"><h2>Compared with neighboring districts</h2><a href="${compareHref}">Compare side by side ${I.r}</a></div>
          <ul class="bars">${nbrRows.map((r) => `<li class="${r.x === d ? "me" : ""}"><span class="name"><a href="${dHref(r.x)}">${CH.abbr} ${r.x.district} · ${esc(r.x.member)}</a></span><span class="amt">${money0(r.u.actual)}</span>
            <span class="track"><span class="fill${r.x === d ? "" : " alt"}" style="width:${(r.u.actual / maxN * 100).toFixed(1)}%"></span></span></li>`).join("")}</ul></section>
        <section class="card"><div class="card-head"><h2>Across report periods</h2>${ps ? `<span class="summary">${changeText(change(s.actual, ps.actual))}</span>` : ""}</div>
          <div class="cols">${periodsBars.map((m) => `<a class="col" href="${buildHash("district/" + d.district, { p: m.key === PERIODS[0].id ? "" : m.key })}" title="${esc(m.label)}: ${money(m.total)}">
            <span class="colval">${m.total ? compact(m.total) : "—"}</span><span class="colbar${m.cur ? "" : " dimbar"}" style="height:${(m.total / maxP * 100).toFixed(1)}%"></span><span class="collabel">${esc(m.label)}</span></a>`).join("")}</div></section>
        <section class="card"><div class="card-head"><h2>M&amp;O + travel by month</h2><span class="summary">click a month for its records</span></div>
          ${columns(monthlyFor(DB, s.id).map((m) => ({ ...m, href: buildHash("records", { unit: s.id, month: m.key }) })))}</section>
      </div>
      ${demogCard(d.district, s)}
      ${votersCard(d.district, s)}
      ${campaignCard(d.district, d.member)}
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
    // "/" jumps to the site search, unless the person is already typing somewhere.
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !/input|select|textarea/i.test(e.target.tagName || "") && !e.target.isContentEditable) {
      e.preventDefault();
      document.getElementById("globalSearchInput").focus();
    }
  });
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
      <section class="card a11y" id="accessibility" aria-labelledby="a11y-h">
        <h2 id="a11y-h">Accessibility</h2>
        <ul>
          <li><strong>Keyboard.</strong> Every link, button, filter, sortable column and map district can be reached with Tab and used with Enter or Space. Press <kbd>/</kbd> to jump to the search box. "Skip to main content" is the first stop on every page.</li>
          <li><strong>Screen readers.</strong> Page changes and updated result counts are announced; charts and map districts have spoken labels with their figures, and every chart's numbers are also in a table or list on the same page.</li>
          <li><strong>Color and contrast.</strong> Text meets WCAG AA contrast in light and dark themes. The theme follows your device unless you pick Light or Dark with the switch in the header. Charts never rely on color alone: amounts are always written out.</li>
          <li><strong>Motion and zoom.</strong> Animations are turned off when your device asks for reduced motion, and the layout reflows at 200% zoom and on phones. Windows high-contrast mode keeps chart bars and map districts visible.</li>
        </ul>
        <p class="summary">Something hard to use? <a href="https://github.com/rike4545/NY-Legislature-Expenditures/issues" target="_blank" rel="noopener">Open an issue on GitHub</a>.</p>
      </section>
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
        <li><strong>Pay types</strong> follow the Senate's biweekly payroll reports: Regular Annual (RA), Special Annual (SA) and Temporary (TE, hourly rate). VA isn't defined there and is shown as published.</li>
        <li><strong>Vacant district offices</strong> (e.g. "47TH SENATORIAL DISTRICT") appear as their own offices, as in the report.</li>`}
        <li><strong>Period comparisons</strong> match members and offices by their name as printed in each report. A member who joined or left between periods has no comparison.</li>
        <li><strong>Payroll lines</strong> have no voucher date; they carry service dates instead, so they don't appear in the by-month charts or month filter.</li>
        <li><strong>Negative amounts</strong> (${int.format(DB.records.filter((r) => r.amt < 0).length)} lines here) are refunds or adjustments and are included in totals as reported.</li>
        <li><strong>District map.</strong> Boundaries are the 2024 ${esc(CH.name)} district lines from the New York State GIS "${gisLayer}" layer, which also supplies each district's member name and party. Those names are matched to the reports by last name${isA ? ` (two by hand: AD 20 "Ari Brown" = BROWN, ERIC G.; AD 59 "Jaime R. Williams" = RIVAS-WILLIAMS, JAIME)` : ""}. Because the layer lists current members, a member who left before it was published (or joined after a report period) has no district shading for that period.${isA ? "" : " The layer lists Senate District 12 as vacant."}</li>
      </ul></section>
      <section class="card"><h2>Members: terms, the 2026 election, offices and posts</h2><ul>
        <li><strong>Terms.</strong> Assembly members and senators serve two-year terms; every seat was on the November 3, 2026 ballot for the term starting January 1, 2027. "In current district since" is Ballotpedia's assumed-office date for the current district number, so members who served before the 2022 redistricting can show 2023.</li>
        <li><strong>Senate payroll history.</strong> Every Senate biweekly payroll report published as a spreadsheet on <a href="https://www.nysenate.gov/open-data" target="_blank" rel="noopener">nysenate.gov/open-data</a>: 416 reports, pay periods ending Sep 15, 2010 to Nov 4, 2026 (earlier 2009–2010 reports have no spreadsheet). Each lists every employee's office, title, pay type and biweekly or hourly rate; members' own pay isn't in them. The Salaries page shows each person's rate on the latest report next to the estimate from the expenditure report, and links to their full history. A few reports are missing from the Senate's archive (for example the pay period ending Feb 26, 2025).</li>
        <li><strong>2026 election.</strong> November 3 outcomes come from the <a href="https://nyenr.elections.ny.gov/" target="_blank" rel="noopener">NYS Board of Elections unofficial election-night results</a> (as of Nov 12, 2026, 7:26 PM), with every candidate's combined votes across party lines. A member is "Re-elected" or "Lost" when the margin is at least 2 points of the ballots cast, or 5 points while election districts are still unreported (the State Board notes that many Westchester emergency ballots are not yet scanned); closer races are "Not yet decided". Retirements, runs for other office and June primary losses come from Wikipedia, City &amp; State (Nov 4, 2026) and Greenberg Traurig's November 2026 update. All results are unofficial until certified.</li>
        <li><strong>Offices and contacts</strong> (district office, district and Albany phones, email) come from the state's GIS district layers.</li>
        <li><strong>Posts</strong> are current 2025–2026 leadership, committee and caucus posts (Assembly: nyassembly.gov committee list and Wikipedia; Senate: Wikipedia). Where a post directs a central office in the reports (e.g. Ways and Means chair → Ways and Means Committee), that office is linked from the member's page. "Staff also paid by other offices" lists people on a member's payroll who were also paid by another office in the same report.</li>
      </ul></section>
      <section class="card" id="travel-rules"><h2>Travel rules and benchmarks</h2>
        <p>The Legislature sets its own travel rules; the Comptroller's travel manual for state agencies is shown here as a point of comparison, not as the rule legislators are held to.</p>
        <ul>
          <li><strong>Legislators' per diems.</strong> Under Legislative Law §5(2), members receive actual and necessary transportation expenses and a full or partial per diem equal to the federal (GSA) per diem rates, under regulations set by the Temporary President of the Senate and the Speaker of the Assembly. In the Senate files, full per diems are multiples of the GSA rate for the destination (e.g. $203 a night in Albany), and partial per diems match the GSA meals-and-incidentals rate.</li>
          <li><strong>Mileage.</strong> Personal-car mileage is reimbursed at the IRS business rate: 70¢ a mile in 2025, 72.5¢ from January 1, 2026 and 76¢ from July 1, 2026. Dividing a trip's mileage reimbursement by the rate on its start date gives whole miles for about 95% of Senate trips, so this site shows the miles implied by each reimbursement.</li>
          <li><strong>State agency employees (for comparison).</strong> The Comptroller's Travel Manual (revised 2/22/2024) puts employees in travel status only when they are 35 miles or more from both their official station and their home, treats home-to-station travel as non-reimbursable commuting, reimburses personal-vehicle mileage at IRS rates, and offers an unreceipted overnight per diem of $50 (New York City and Nassau, Suffolk, Rockland and Westchester), $40 (Albany, Binghamton, Buffalo, Rochester, Syracuse areas), $35 (elsewhere in New York) or $50 (out of state), or actual lodging plus a GSA-based meal allowance with receipts.</li>
          <li><strong>Assembly travel</strong> is reported only as voucher totals with a destination, so these breakdowns are available for the Senate only.</li>
        </ul>
        <p>Sources: <a href="https://www.osc.ny.gov/files/state-agencies/travel/pdf/agencies-travel-manual-attachment.pdf" target="_blank" rel="noopener">OSC Travel Manual</a> · <a href="https://www.nysenate.gov/open-data/expenditure-report-and-member-travel-detail-period-ending-2026-03-31" target="_blank" rel="noopener">Senate member travel detail</a> · <a href="https://www.irs.gov/newsroom/irs-sets-2026-business-standard-mileage-rate-at-725-cents-per-mile-up-25-cents" target="_blank" rel="noopener">IRS 2026 mileage rate</a></p>
      </section>
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
    const tab = { overview: "overview", units: "units", unit: "units", records: "records", payees: "payees", about: "about", compare: "compare", map: "map", district: "map", salaries: "salaries", person: "payroll", payroll: "payroll", stats: "stats", donations: "donations", scorecard: "scorecard", find: "find", vendors: "vendors" }[view] || "overview";
    let here = "";
    document.querySelectorAll(".tabs a").forEach((a) => { const on = a.dataset.tab === tab; a.classList.toggle("active", on); if (on) { a.setAttribute("aria-current", "page"); here = a.textContent; } else a.removeAttribute("aria-current"); });
    document.querySelectorAll(".navgroup").forEach((g) => g.classList.toggle("active", !!g.querySelector("a.active")));
    const nh = document.getElementById("navHere");
    if (nh) nh.textContent = here ? "· " + here : "";
    closeMenus();
  }
  let lastView = "";
  let booted = false;
  let liveTimer = 0;
  function announce(text) {
    const el = document.getElementById("liveRegion");
    if (!el) return;
    el.textContent = "";
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { el.textContent = text; }, 120);
  }

  /* Color theme: Auto follows the system setting; Light and Dark override it and are remembered. */
  const THEMES = ["auto", "light", "dark"];
  const THEME_ICON = {
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor"/></svg>',
  };
  const THEME_NAME = { auto: "automatic (follows your device)", light: "light", dark: "dark" };
  function currentTheme() { return document.documentElement.dataset.theme || "auto"; }
  function paintThemeButton() {
    const b = document.getElementById("themeToggle");
    if (!b) return;
    const t = currentTheme();
    const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    b.innerHTML = `${THEME_ICON[t]}<span class="theme-label">${t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark"}</span>`;
    b.setAttribute("aria-label", `Color theme: ${THEME_NAME[t]}. Switch to ${next}.`);
    b.title = `Theme: ${THEME_NAME[t]} — click for ${next}`;
  }
  /* Main menu: grouped dropdowns on wide screens, one Menu panel on phones. */
  function closeMenus(except) {
    document.querySelectorAll(".navgroup").forEach((g) => { if (g !== except) { g.classList.remove("open"); const b = g.querySelector(".ng-btn"); if (b) b.setAttribute("aria-expanded", "false"); } });
    const nav = document.getElementById("mainNav"), t = document.getElementById("navToggle");
    if (!except && nav && nav.classList.contains("menu-open")) { nav.classList.remove("menu-open"); t.setAttribute("aria-expanded", "false"); }
  }
  function wireNav() {
    const nav = document.getElementById("mainNav");
    if (!nav || nav.dataset.wired) return;
    nav.dataset.wired = "1";
    nav.querySelectorAll(".ng-btn").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const g = b.closest(".navgroup"), open = !g.classList.contains("open");
      closeMenus(g);
      g.classList.toggle("open", open);
      b.setAttribute("aria-expanded", String(open));
      if (open) { const first = g.querySelector("ul a"); if (first && e.detail === 0) first.focus(); }
    }));
    const t = document.getElementById("navToggle");
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !nav.classList.contains("menu-open");
      nav.classList.toggle("menu-open", open);
      t.setAttribute("aria-expanded", String(open));
      if (open) { const cur = nav.querySelector("a.active") || nav.querySelector(".navlist a"); if (cur) cur.focus(); }
    });
    document.addEventListener("click", (e) => { if (!nav.contains(e.target)) closeMenus(); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const g = document.activeElement && document.activeElement.closest && document.activeElement.closest(".navgroup.open");
      const inMenu = nav.classList.contains("menu-open");
      if (g) { closeMenus(); g.querySelector(".ng-btn").focus(); }
      else if (inMenu) { closeMenus(); t.focus(); }
    });
    nav.addEventListener("focusout", (e) => { if (!nav.contains(e.relatedTarget) && window.matchMedia("(min-width: 861px)").matches) closeMenus(); });
  }

  function wireTheme() {
    const b = document.getElementById("themeToggle");
    if (!b || b.dataset.wired) return;
    b.dataset.wired = "1";
    b.addEventListener("click", () => {
      const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
      if (next === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
      try { if (next === "auto") localStorage.removeItem("theme"); else localStorage.setItem("theme", next); } catch (e) { /* storage unavailable: theme lasts this visit */ }
      paintThemeButton();
      announce(`Color theme: ${THEME_NAME[next]}`);
      render();
    });
    paintThemeButton();
    const skip = document.getElementById("skipLink");
    if (skip) skip.addEventListener("click", (e) => { e.preventDefault(); const h1 = app.querySelector("h1") || app; h1.setAttribute("tabindex", "-1"); h1.focus(); });
  }
  function render() {
    wireTheme();
    wireNav();
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
      case "salaries": html = viewSalaries(params); break;
      case "person": html = viewPerson(params); break;
      case "payroll": html = viewPayroll(params); break;
      case "stats": html = viewStats(); break;
      case "donations": html = arg ? viewDonationDistrict(arg) : viewDonations(params); break;
      case "scorecard": html = viewScorecard(params); break;
      case "find": html = viewFind(params); break;
      case "vendors": html = viewVendors(); break;
      case "about": html = viewAbout(); if (params.s) setTimeout(() => { const t = document.getElementById(params.s); if (t) { t.setAttribute("tabindex", "-1"); t.scrollIntoView(); t.focus({ preventScroll: true }); } }, 0); break;
      case "compare": html = viewCompare(params); break;
      case "map": html = viewMap(params); break;
      case "district": html = viewDistrict(arg); break;
      default: html = viewOverview();
    }
    if (html != null) app.innerHTML = html;
    // Wide tables and charts that scroll sideways: reachable and scrollable by keyboard, and named for screen readers.
    app.querySelectorAll(".table-wrap, .cols").forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 2) {
        const h = el.closest("section, .card") && el.closest("section, .card").querySelector("h2, h3");
        el.setAttribute("tabindex", "0"); el.setAttribute("role", "region");
        el.setAttribute("aria-label", `${h ? h.textContent.trim() : "Table"} (scrolls sideways)`);
      } else if (el.getAttribute("role") === "region") { el.removeAttribute("tabindex"); el.removeAttribute("role"); el.removeAttribute("aria-label"); }
    });
    const psf = app.querySelector("#paySearch");
    if (psf) {
      const inp = psf.querySelector("#payq");
      let t = 0;
      inp.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => go("payroll", { q: inp.value.trim() }, true), 250); });
      psf.addEventListener("submit", (e) => e.preventDefault());
      if (params.q) focusEnd("#payq");
    }
    const hs = app.querySelector("#heroSearch");
    if (hs) hs.addEventListener("submit", (e) => { e.preventDefault(); go("records", { q: app.querySelector("#heroSearchInput").value.trim() }); });
    const key = view + (arg || "");
    if (key !== lastView) {
      const first = !lastView && !booted;
      window.scrollTo(0, 0); lastView = key;
      if (!first) {
        const h1 = app.querySelector("h1");
        if (h1) { h1.setAttribute("tabindex", "-1"); h1.focus({ preventScroll: true }); }
        announce(`${(h1 && h1.textContent.trim()) || "Page"} · ${CH.name} · ${periodName(DB)}`);
      }
      booted = true;
    } else {
      const sum = app.querySelector(".toolbar .summary");
      if (sum) announce(sum.textContent.replace(/\s+/g, " ").trim());
    }
    if (view === "records") document.getElementById("globalSearchInput").value = params.q || "";
  }

  function syncPeriodUI() {
    const sel = document.getElementById("periodSelect");
    // Every report period from both chambers; a period only one chamber has is labeled and
    // switches to that chamber when picked.
    const all = new Map();
    for (const c of CHAMBERS) for (const pm of c.periods) {
      const x = all.get(pm.id) || { pm, chambers: [] };
      x.chambers.push(c);
      all.set(pm.id, x);
    }
    const list = [...all.values()].sort((a, b) => b.pm.end.localeCompare(a.pm.end));
    if (sel.dataset.chamber !== CH.id) {
      sel.innerHTML = list.map(({ pm, chambers }) => {
        const only = chambers.length < CHAMBERS.length ? ` (${chambers.map((c) => c.name).join(", ")})` : "";
        return `<option value="${esc(pm.id)}">${esc(`${fmtShort(pm.start)} – ${fmtShort(pm.end)}`)}${esc(only)}</option>`;
      }).join("");
      sel.dataset.chamber = CH.id;
    }
    if (!sel.dataset.wired) {
      sel.dataset.wired = "1";
      sel.addEventListener("change", () => {
        const { view, arg, params } = parseHash();
        const entry = all.get(sel.value);
        const here = entry && entry.chambers.some((c) => c.id === CH.id);
        const c = here ? CH.id : entry.chambers[0].id;
        if (!here) {
          // The current chamber has no report for this period: open the chamber that does.
          const v = ["unit", "district", "person"].includes(view) ? (view === "district" ? "map" : view === "person" ? "salaries" : "units") : view;
          location.hash = buildHash(v === "overview" ? "" : v, { p: sel.value, c });
          return;
        }
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
    const tabView = { overview: "", units: "units", records: "records", map: "map", compare: "compare", salaries: "salaries", payroll: "payroll", stats: "stats", donations: "donations", scorecard: "scorecard", find: "find", vendors: "vendors", payees: "payees", about: "about" };
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
