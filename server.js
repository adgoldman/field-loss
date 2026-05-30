/*
 * Field Loss Estimator — backend proxy
 * ------------------------------------
 * Browsers can't call USDA NASS Quick Stats or USDA Market News directly
 * (no CORS headers + keys shouldn't live in client code). This thin Express
 * server sits in front of both, adds CORS for your app origin, caches
 * responses to respect rate limits, and keeps API keys server-side.
 *
 * Run:
 *   npm install            # see package.json
 *   NASS_KEY=xxx AMS_KEY=yyy node server.js
 *
 * Endpoints:
 *   GET /api/health
 *   GET /api/nass/planted-acres?crop=CORN&state=IA[&year=2024]
 *   GET /api/price?crop=TOMATOES            (USDA Market News scaffold)
 *
 * Node 18+ (uses global fetch).
 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8787;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const NASS_KEY = process.env.NASS_KEY || "";
const AMS_KEY = process.env.AMS_KEY || ""; // USDA Market News (MARS) API key

// ---- CORS + tiny in-memory cache ----
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const cache = new Map(); // key -> { at, ttl, data }
function getCached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
  return null;
}
function setCached(key, data, ttlMs) {
  cache.set(key, { at: Date.now(), ttl: ttlMs, data });
}

// ---- NASS helpers ----
// crop -> the yield unit token to prefer (corn/soy/wheat in BU, specialty in CWT)
const CROP_YIELD_UNIT = { CORN:"BU", SOYBEANS:"BU", WHEAT:"BU", POTATOES:"CWT", TOMATOES:"CWT", LETTUCE:"CWT", APPLES:"CWT", STRAWBERRIES:"CWT", ORANGES:"TONS", LEMONS:"TONS" };

// ---- Rescue model: two channels ----
// The forecast splits "what becomes rescuable in the window" into the two
// categories the user cares about, each from a distinct LIVE NASS signal:
//
//   1. harvested-but-unsold (available for redistribution): a crop that IS
//      harvested but does not sell. Measured as the structural NOT-SOLD /
//      utilized-vs-total production rate (UNSOLD_RATE below). Applied to the
//      volume entering harvest in the window.
//
//   2. unharvested-in-field (standing crop, gleanable / destroyed without
//      intervention): the NASS AREA PLANTED − AREA HARVESTED abandonment gap,
//      valued at yield and gated to the harvest window. Computed live per state
//      in the endpoint, no static rate needed.
//
// UNSOLD_RATE provenance (NASS Quick Stats PRODUCTION, util_practice NOT SOLD vs
// ALL UTILIZATION PRACTICES, latest year):
//   POTATOES 5.5% (2024 394.95M/417.85M CWT) · APPLES 3.0% · TOMATOES 0.6%
//   (2025 NOT SOLD 1,533,100 / 248,316,500 CWT) · LETTUCE ~0% (2025 14,000 /
//   101,057,000 — sold once cut) · grains ~0% (≈100% utilized).
// NOTE on channel 2: the planted−harvested gap is ALL-cause (weather + market).
// RMA colsom_2024 shows "Decline in Price" (market-driven) is <0.2% of grain
// unharvested acres and is NOT recorded at all for specialty crops — so the gap
// is the gleanable upper bound, not a market-only figure.
const UNSOLD_RATE = {
  POTATOES: 0.055, TOMATOES: 0.006, LETTUCE: 0.000, STRAWBERRIES: 0.000,
  APPLES: 0.034, // 2025 NOT SOLD 383.5M / 11,102M LB
};

// Tree crops: perennial, so NASS reports utilized PRODUCTION (not planted/harvested
// acres). They have NO acreage abandonment gap. Volume comes from production directly.
const TREE_CROPS = new Set(["APPLES", "ORANGES", "LEMONS"]);
const TREE_PROD_UNIT = { APPLES: "LB", ORANGES: "TONS", LEMONS: "TONS" }; // NASS production unit
const TREE_TO_DISPLAY = { APPLES: 1 / 100, ORANGES: 1, LEMONS: 1 }; // -> display unit (apples LB->CWT; citrus TONS->TONS)

// Citrus is a special tree-crop case. Neither rescue channel is directly measured:
// Quick Stats has no NOT-SOLD series (no harvested-unsold rate) and no abandonment
// quantity (its "Total production" == utilized). The ONLY abandonment signal in the
// USDA NASS Citrus Fruits 2024 Summary (Aug 2025) is the Equivalent On-Tree (EOT)
// return going low/negative — it costs more to pick + haul than the fruit returns,
// so the marginal (processing / cull) fruit is economically rational to leave on
// the tree. That's the gleanable, "destroyed in field without intervention" fruit.
// We model the in-field channel for citrus as volume x econ-abandonment risk, NOT a
// measured acreage gap. Risk is curated per crop/state from the 2024-25 EOT returns
// (auditable via onTreeReturn $/box, surfaced to the client). Headline figures:
// lemon processing EOT = -$4.49/box (US, 2024-25) -> juice/cull lemons uneconomic;
// orange processing EOT ~$6-13/box -> marginal; FL orange bearing acreage collapsed
// 249.8k -> 188.4k acres (greening + hurricanes).
const CITRUS_CROPS = new Set(["ORANGES", "LEMONS"]);
const ECON_ABANDON_RISK = {
  ORANGES: {
    FL: { risk: 0.30, onTreeReturn: 12.86, basis: "juice-dominant; processing EOT ~$13/box, marginal; acreage 249.8k->188.4k" },
    CA: { risk: 0.10, onTreeReturn: 15.63, basis: "fresh-dominant navel, healthy on-tree returns" },
    TX: { risk: 0.08, onTreeReturn: 25.04, basis: "high on-tree returns ($25/box)" },
    AZ: { risk: 0.10, onTreeReturn: null, basis: "minor production" },
  },
  LEMONS: {
    AZ: { risk: 0.22, onTreeReturn: 14.40, basis: "processing EOT negative (US -$4.49/box); cull lemons abandoned" },
    CA: { risk: 0.18, onTreeReturn: 19.78, basis: "fresh healthy; processing/cull EOT negative" },
    FL: { risk: 0.30, onTreeReturn: 11.40, basis: "new/marginal; lowest on-tree returns" },
  },
};

// Citrus marketing seasons (USDA NASS Citrus Fruits 2024 Summary, p.23), as
// day-of-year [start, peak, end]. Citrus is a winter crop, so end < start means
// the season WRAPS the new year. Per state because seasons differ markedly.
const CITRUS_SEASON = {
  ORANGES: {
    CA: [273, 60, 165], // Oct 1 -> ~Mar 1 peak -> Jun 15 (navel-dominant)
    FL: [273, 31, 211], // Oct 1 -> ~Feb 1 -> Jul 31
    TX: [273, 31, 150], // Oct 1 -> ~Feb 1 -> May 31
  },
  LEMONS: {
    AZ: [243, 334, 58], // Sep 1 -> ~Dec 1 -> Feb 28
    CA: [212, 60, 211], // Aug 1 -> spring -> Jul 31 (near year-round)
    FL: [243, 1, 90],   // Sep 1 -> ~Jan 1 -> Mar 31 (approx; FL lemons new in 2024-25)
  },
};
// Fraction of a citrus crop's annual harvest that falls inside a forecast window,
// summed day-by-day so it is robust to seasons that wrap the new year and to
// windows that sit partly/fully in the off-season. Cumulative harvest within a
// season rises 0 -> 50% (at peak) -> 100% (at end), piecewise-linear.
function citrusShare(season, startDoy, horizon) {
  const [s, pk, e] = season;
  const span = (((e - s) % 365) + 365) % 365 || 365;
  const peakOff = (((pk - s) % 365) + 365) % 365;
  const cumAt = (o) => {
    if (o <= 0) return 0;
    if (o >= span) return 100;
    return o <= peakOff
      ? (peakOff ? 50 * (o / peakOff) : 0)
      : 50 + 50 * ((o - peakOff) / Math.max(span - peakOff, 1));
  };
  let pct = 0;
  for (let d = 0; d < horizon; d++) {
    const doy = (startDoy + d) % 365;
    const o = (((doy - s) % 365) + 365) % 365;
    pct += cumAt(o + 1) - cumAt(o); // harvest fraction occurring on this day
  }
  return pct / 100;
}

// Static harvest calendars (approx, national) for crops NASS does NOT publish a
// weekly PCT-HARVESTED progress curve for. {start, peak, end} as day-of-year;
// synthesized into a piecewise-cumulative curve (0/50/100%).
const HARVEST_CALENDAR = {
  TOMATOES:     [182, 244, 304], // ~Jul 1 / Sep 1 / Oct 31
  LETTUCE:       [91, 196, 319], // ~Apr 1 / mid-Jul / Nov 15 (Salinas main)
  STRAWBERRIES:  [60, 121, 304], // ~Mar 1 / May 1 / Oct 31 (CA dominant)
  APPLES:       [213, 263, 314], // ~Aug 1 / Sep 20 / Nov 10
};
const calendarCurve = (cal) => cal ? [[cal[0], 0], [cal[1], 50], [cal[2], 100]] : null;
const num = (x) => { const v = Number(String(x).replace(/,/g, "")); return Number.isFinite(v) ? v : null; };
async function nassFetch(paramsObj) {
  const params = new URLSearchParams({ key: NASS_KEY, format: "JSON", ...paramsObj });
  const r = await fetch(`https://quickstats.nass.usda.gov/api/api_GET/?${params}`);
  if (!r.ok) throw new Error(`NASS ${r.status}`);
  const json = await r.json();
  return json.data || [];
}
// NASS answers a zero-match query with HTTP 400 ("bad request - invalid query"),
// indistinguishable from a real bad param. For optional series (e.g. a crop with
// no weekly condition record this year) treat that as simply empty, not fatal.
async function nassFetchSoft(paramsObj) {
  try { return await nassFetch(paramsObj); }
  catch (e) { if (String(e).includes("NASS 400")) return []; throw e; }
}
// Reduce NASS acreage + yield rows into one record per area. Crucially, planted
// and harvested are taken from the SAME (latest shared) year so their gap is a
// real abandonment figure rather than an artifact of comparing different years
// (e.g. 2026 planting intentions vs 2025 actual harvest).
function reduceArea(acreRows, yieldRows, idOf, metaOf, yieldUnitHint) {
  const acc = new Map();
  const get = (row) => {
    const id = idOf(row); if (id == null) return null;
    let o = acc.get(id);
    if (!o) { o = { planted: {}, harvested: {}, yld: {}, meta: metaOf(row) }; acc.set(id, o); }
    return o;
  };
  // A year's acreage may arrive as one aggregate row (ALL CLASSES / ALL UTILIZATION
  // PRACTICES) or as components (e.g. corn GRAIN + SILAGE, wheat by class). Prefer
  // the aggregate; otherwise sum the components. Dedupe reference-period repeats
  // within a single short_desc by keeping the max.
  const addAcre = (slotByYear, row, v) => {
    const slot = (slotByYear[Number(row.year)] ||= { agg: null, comps: {} });
    const isAgg = row.class_desc === "ALL CLASSES" && row.util_practice_desc === "ALL UTILIZATION PRACTICES";
    if (isAgg) { if (slot.agg == null || v > slot.agg) slot.agg = v; }
    else { const k = row.short_desc; if (slot.comps[k] == null || v > slot.comps[k]) slot.comps[k] = v; }
  };
  const resolve = (slot) => {
    if (!slot) return null;
    if (slot.agg != null) return slot.agg;
    const vals = Object.values(slot.comps);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  for (const row of acreRows) {
    // settled annual estimate only; drop forecasts / planting intentions
    // ("YEAR - AUG FORECAST", "YEAR - JUN ACREAGE", …) which make the current
    // crop year look partial (e.g. winter wheat in before spring wheat).
    if (row.reference_period_desc !== "YEAR") continue;
    const v = num(row.Value); if (v == null) continue;
    const field = row.statisticcat_desc === "AREA PLANTED" ? "planted"
                : row.statisticcat_desc === "AREA HARVESTED" ? "harvested" : null;
    if (!field) continue;
    const o = get(row); if (!o) continue;
    addAcre(o[field], row, v);
  }
  for (const row of yieldRows) {
    if (row.reference_period_desc !== "YEAR") continue;
    const v = num(row.Value); if (v == null) continue;
    const o = get(row); if (!o) continue;
    const y = Number(row.year);
    // a crop (e.g. CORN) reports several yield series (grain BU/ACRE, silage
    // TONS/ACRE); keep the one whose unit matches the crop so production stays
    // in the crop's own unit.
    const matches = !!(yieldUnitHint && String(row.unit_desc || "").toUpperCase().includes(yieldUnitHint));
    const cur = o.yld[y];
    if (!cur || (matches && !cur.matches)) o.yld[y] = { v, unit: row.unit_desc, matches };
  }
  const out = [];
  for (const o of acc.values()) {
    // Union of component keys ever seen on each side. A year that resolves from
    // components but is missing some of these is a partial/in-season report (e.g.
    // wheat harvested as WINTER-only before the spring crop comes in) and must not
    // be compared against a full-aggregate planted figure.
    const fullKeys = (slots) => {
      const s = new Set();
      for (const slot of Object.values(slots)) for (const k of Object.keys(slot.comps)) s.add(k);
      return s;
    };
    const pFull = fullKeys(o.planted), hFull = fullKeys(o.harvested);
    const complete = (slot, full) => {
      if (!slot) return false;
      if (slot.agg != null) return true;
      const keys = Object.keys(slot.comps);
      return keys.length > 0 && keys.length === full.size && keys.every((k) => full.has(k));
    };
    const pYears = Object.keys(o.planted).map(Number);
    const hYears = Object.keys(o.harvested).map(Number);
    const shared = pYears.filter((y) => o.harvested[y] != null).sort((a, b) => b - a);
    const rec = { ...o.meta };
    // Latest year where BOTH sides cover the full crop, so planted−harvested is a
    // real abandonment gap rather than a class-coverage artifact.
    const gy = shared.find((y) => complete(o.planted[y], pFull) && complete(o.harvested[y], hFull));
    if (gy != null) {
      rec.planted = resolve(o.planted[gy]); rec.harvested = resolve(o.harvested[gy]); rec.year = gy;
    } else if (shared.length) {
      const y = shared[0];
      rec.planted = resolve(o.planted[y]); rec.harvested = resolve(o.harvested[y]); rec.year = y;
    } else {
      if (pYears.length) { const y = Math.max(...pYears); rec.planted = resolve(o.planted[y]); rec.year = y; }
      if (hYears.length) { const y = Math.max(...hYears); rec.harvested = resolve(o.harvested[y]); rec.year = rec.year ?? y; }
    }
    const yYears = Object.keys(o.yld).map(Number);
    if (yYears.length) {
      const yy = (rec.year != null && o.yld[rec.year]) ? rec.year : Math.max(...yYears);
      rec.yield = o.yld[yy].v; rec.yieldUnit = o.yld[yy].unit;
    }
    if (rec.planted || rec.harvested) out.push(rec);
  }
  return out;
}

// day-of-year (0..364) for a Date or "YYYY-MM-DD", so progress curves from any
// year can be compared by calendar position regardless of the year they're from.
const doyOf = (y, m, d) => Math.round((Date.UTC(2001, m - 1, d) - Date.UTC(2001, 0, 1)) / 86400000);
const doyISO = (iso) => { const [y, m, d] = iso.split("-").map(Number); return doyOf(y, m, d); };
// Cumulative % at a day-of-year, linearly interpolated along a sorted [doy,val] curve.
function cumAtDoy(curve, doy) {
  if (!curve.length) return null;
  if (doy <= curve[0][0]) return 0;
  if (doy >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 1; i < curve.length; i++) {
    if (doy <= curve[i][0]) {
      const [d0, v0] = curve[i - 1], [d1, v1] = curve[i];
      return v0 + (v1 - v0) * ((doy - d0) / Math.max(d1 - d0, 1));
    }
  }
  return curve[curve.length - 1][1];
}

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, nassKey: !!NASS_KEY, amsKey: !!AMS_KEY })
);

// ---- USDA NASS Quick Stats: latest state planted acres ----
app.get("/api/nass/planted-acres", async (req, res) => {
  const crop = String(req.query.crop || "").toUpperCase();
  const state = String(req.query.state || "").toUpperCase();
  if (!NASS_KEY) return res.status(500).json({ error: "NASS_KEY not configured" });
  if (!crop || !state) return res.status(400).json({ error: "crop and state required" });

  const ck = `nass:${crop}:${state}:${req.query.year || "latest"}`;
  const cached = getCached(ck);
  if (cached) return res.json({ ...cached, cached: true });

  // Query one acreage series for this crop/state; returns null if the series
  // doesn't exist (NASS 400) or has no usable rows.
  const queryAcres = async (stat) => {
    const params = new URLSearchParams({
      key: NASS_KEY,
      commodity_desc: crop,
      statisticcat_desc: stat,
      unit_desc: "ACRES",
      agg_level_desc: "STATE",
      state_alpha: state,
      format: "JSON",
    });
    if (req.query.year) params.set("year", String(req.query.year));
    else params.set("year__GE", "2021");
    const r = await fetch(`https://quickstats.nass.usda.gov/api/api_GET/?${params}`);
    if (!r.ok) return null; // 400 = no such series for this commodity
    const json = await r.json();
    const rows = (json.data || []).filter((x) => x.Value && x.Value !== "(D)");
    if (!rows.length) return null;
    rows.sort((a, b) => Number(b.year) - Number(a.year));
    return { acres: Number(String(rows[0].Value).replace(/,/g, "")), year: rows[0].year, stat };
  };

  try {
    // Fresh produce often reports AREA HARVESTED but not AREA PLANTED, and tree
    // crops (apples) report neither as PLANTED — fall back so every crop resolves.
    const hit = (await queryAcres("AREA PLANTED")) || (await queryAcres("AREA HARVESTED"));
    if (!hit) return res.json({ crop, state, acres: null, note: "no rows" });
    const out = { crop, state, year: hit.year, acres: hit.acres, stat: hit.stat };
    setCached(ck, out, 1000 * 60 * 60 * 12); // 12h
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "NASS fetch failed", detail: String(e) });
  }
});

// ---- USDA Market News (MARS API) scaffold ----
// MARS uses HTTP Basic auth with the API key as the username and per-commodity
// report slugs. Map your crops to the report IDs you care about, then parse the
// fields relevant to farm-gate / shipping-point price. Left as a scaffold
// because the right report + field varies by commodity and desired price point.
const MARS_REPORTS = {
  // crop:        report slug (look up at mymarketnews.ams.usda.gov)
  TOMATOES: "2667",
  POTATOES: "2667",
  LETTUCE: "2667",
  APPLES: "2667",
  STRAWBERRIES: "2667",
  CORN: "3346",
  SOYBEANS: "3346",
  WHEAT: "3346",
};

app.get("/api/price", async (req, res) => {
  const crop = String(req.query.crop || "").toUpperCase();
  if (!AMS_KEY) return res.status(500).json({ error: "AMS_KEY not configured" });
  const slug = MARS_REPORTS[crop];
  if (!slug) return res.status(400).json({ error: `no report mapped for ${crop}` });

  const ck = `price:${crop}`;
  const cached = getCached(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const auth = "Basic " + Buffer.from(`${AMS_KEY}:`).toString("base64");
  const url = `https://marsapi.ams.usda.gov/services/v1.2/reports/${slug}?q=commodity=${encodeURIComponent(crop)}`;
  try {
    const r = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) return res.status(r.status).json({ error: `MARS ${r.status}` });
    const json = await r.json();
    // NOTE: response shape varies by report. Adapt this extraction to the
    // report you map above — pull the price field + unit you want to model.
    const out = { crop, raw: json, note: "adapt extraction to chosen report" };
    setCached(ck, out, 1000 * 60 * 60 * 6); // 6h
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "MARS fetch failed", detail: String(e) });
  }
});

// ---- USDA NASS Quick Stats: county planted + harvested + yield for one state ----
// Returns measured area planted AND harvested (their gap = real abandonment) plus
// yield, so the client computes real production instead of acres × assumed yield.
app.get("/api/nass/county-acres", async (req, res) => {
  const crop = String(req.query.crop || "").toUpperCase();
  const state = String(req.query.state || "").toUpperCase();
  if (!NASS_KEY) return res.status(500).json({ error: "NASS_KEY not configured" });
  if (!crop || !state) return res.status(400).json({ error: "crop and state required" });

  const ck = `nassC2:${crop}:${state}`;
  const cached = getCached(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const base = { commodity_desc: crop, agg_level_desc: "COUNTY", state_alpha: state, year__GE: "2017" };
  try {
    const [acreRows, yieldRows] = await Promise.all([
      nassFetch({ ...base, unit_desc: "ACRES" }),        // AREA PLANTED + AREA HARVESTED
      nassFetch({ ...base, statisticcat_desc: "YIELD" }),
    ]);
    const fipsOf = (row) => (!row.county_code || row.county_code === "998") ? null
      : String(row.state_fips_code).padStart(2, "0") + String(row.county_code).padStart(3, "0");
    const counties = reduceArea(acreRows, yieldRows, fipsOf,
      (row) => ({ fips: fipsOf(row), county: row.county_name }), CROP_YIELD_UNIT[crop]);
    const out = { crop, state, counties };
    if (!counties.length) out.note = "no county rows for this crop/state";
    setCached(ck, out, 1000 * 60 * 60 * 12);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "NASS county fetch failed", detail: String(e) });
  }
});

// ---- USDA NASS Quick Stats: planted + harvested + yield for ALL states ----
// Powers the national map. planted − harvested = measured abandonment; yield
// turns harvested acres into real production.
app.get("/api/nass/state-acres", async (req, res) => {
  const crop = String(req.query.crop || "").toUpperCase();
  if (!NASS_KEY) return res.status(500).json({ error: "NASS_KEY not configured" });
  if (!crop) return res.status(400).json({ error: "crop required" });

  const ck = `nassS2:${crop}`;
  const cached = getCached(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const base = { commodity_desc: crop, agg_level_desc: "STATE", year__GE: "2017" };
  try {
    const [acreRows, yieldRows] = await Promise.all([
      nassFetch({ ...base, unit_desc: "ACRES" }),        // AREA PLANTED + AREA HARVESTED
      nassFetch({ ...base, statisticcat_desc: "YIELD" }),
    ]);
    const states = reduceArea(acreRows, yieldRows,
      (row) => row.state_alpha || null, (row) => ({ state: row.state_alpha }), CROP_YIELD_UNIT[crop]);
    const out = { crop, states };
    if (!states.length) out.note = "no state rows";
    setCached(ck, out, 1000 * 60 * 60 * 12);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "NASS state fetch failed", detail: String(e) });
  }
});

// ---- Forward rescue forecast: what volume enters harvest in the next 30/90 days ----
// Leading indicators only: a per-state harvest-progress curve (from the latest
// COMPLETE year, used as the typical calendar pattern) says what share of a crop's
// harvest falls inside the window; live acres×yield gives the volume; live crop
// condition flags how stressed this year's crop is. Field crops + potatoes have
// full coverage; specialty crops (tomatoes/lettuce/strawberries/apples) report
// progress only for minor states and need a static harvest calendar instead.
app.get("/api/forecast/rescue", async (req, res) => {
  const crop = String(req.query.crop || "").toUpperCase();
  const horizon = Number(req.query.horizon) === 90 ? 90 : 30;
  if (!NASS_KEY) return res.status(500).json({ error: "NASS_KEY not configured" });
  if (!crop) return res.status(400).json({ error: "crop required" });

  const ck = `fcast:${crop}:${horizon}`;
  const cached = getCached(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const nowY = new Date().getUTCFullYear();
  const base = { commodity_desc: crop, agg_level_desc: "STATE" };
  try {
    const isTree = TREE_CROPS.has(crop);
    const [progRows, acreRows, yieldRows, condRows, prodRows] = await Promise.all([
      nassFetchSoft({ ...base, statisticcat_desc: "PROGRESS", unit_desc: "PCT HARVESTED", year__GE: String(nowY - 3) }),
      nassFetchSoft({ ...base, unit_desc: "ACRES", year__GE: "2017" }),
      nassFetchSoft({ ...base, statisticcat_desc: "YIELD", year__GE: "2017" }),
      nassFetchSoft({ ...base, statisticcat_desc: "CONDITION", year: String(nowY) }),
      isTree ? nassFetchSoft({ ...base, statisticcat_desc: "PRODUCTION", unit_desc: TREE_PROD_UNIT[crop], util_practice_desc: "UTILIZED", class_desc: "ALL CLASSES", year__GE: "2019" }) : Promise.resolve([]),
    ]);

    // typical harvest curve per state: latest year whose series actually completes
    // (>=90%), and within it the sub-type (e.g. winter vs spring wheat) with the
    // most weekly observations — a stand-in for the dominant class in that state.
    const byState = {};
    for (const r of progRows) {
      const st = r.state_alpha; const v = num(r.Value); const we = r.week_ending;
      if (!st || v == null || !we) continue;
      ((byState[st] ||= {})[r.year] ||= {})[r.short_desc] ||= [];
      byState[st][r.year][r.short_desc].push([doyISO(we), v]);
    }
    const curveByState = {};
    for (const [st, years] of Object.entries(byState)) {
      let best = null;
      for (const y of Object.keys(years).map(Number).sort((a, b) => b - a)) {
        for (const series of Object.values(years[y])) {
          const pts = series.sort((a, b) => a[0] - b[0]);
          const peak = pts[pts.length - 1][1];
          if (peak >= 90 && (!best || pts.length > best.pts.length)) best = { pts, y };
        }
        if (best && best.y === y) break; // prefer the latest complete year
      }
      if (best) curveByState[st] = best.pts;
    }

    const acres = reduceArea(acreRows, yieldRows,
      (row) => row.state_alpha || null, (row) => ({ state: row.state_alpha }), CROP_YIELD_UNIT[crop]);
    const acreByState = Object.fromEntries(acres.map((a) => [a.state, a]));

    // tree crops: production-based volume (latest year per state, converted to the
    // display unit). No acreage -> no in-field abandonment gap available.
    const prodByState = {};
    if (isTree) {
      const conv = TREE_TO_DISPLAY[crop] || 1;
      // settled annual estimate only; citrus reports many in-season monthly
      // forecasts (YEAR - JAN FORECAST, ...) for the same year — keep only "YEAR".
      const settled = prodRows.filter((r) => r.reference_period_desc === "YEAR" && num(r.Value) != null);
      const latestYr = {};
      for (const r of settled) {
        const st = r.state_alpha; if (!st) continue;
        if (!latestYr[st] || +r.year > latestYr[st]) latestYr[st] = +r.year;
      }
      for (const r of settled) {
        const st = r.state_alpha;
        if (!st || +r.year !== latestYr[st]) continue;
        prodByState[st] = { state: st, production: num(r.Value) * conv, year: +r.year, yieldUnit: CROP_YIELD_UNIT[crop] };
      }
    }
    const recByState = isTree ? prodByState : acreByState;

    // live condition: latest reported week, averaged across sub-types present
    const condByState = {};
    for (const r of condRows) {
      const st = r.state_alpha; const v = num(r.Value); if (!st || v == null) continue;
      const slot = (condByState[st] ||= { week: "", acc: {} });
      if (r.week_ending > slot.week) { slot.week = r.week_ending; slot.acc = {}; }
      if (r.week_ending === slot.week) (slot.acc[r.short_desc] ||= {})[r.unit_desc] = v;
    }
    const riskOf = (st) => {
      const slot = condByState[st]; if (!slot) return null;
      const series = Object.values(slot.acc);
      if (!series.length) return null;
      const risks = series.map((u) => ((u["PCT VERY POOR"] || 0) + (u["PCT POOR"] || 0)) / 100);
      return { risk: risks.reduce((a, b) => a + b, 0) / risks.length, week: slot.week };
    };

    const now = new Date();
    const startDoy = doyOf(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
    const end = new Date(now.getTime() + horizon * 86400000);
    const endDoy = doyOf(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate());
    const wrapped = endDoy < startDoy; // window crosses year-end; clamp to Dec 31

    const staticCurve = calendarCurve(HARVEST_CALENDAR[crop]);
    const unsoldRate = UNSOLD_RATE[crop] ?? 0;
    const isCitrus = CITRUS_CROPS.has(crop);
    let usedCalendar = false;

    const states = [];
    for (const [st, a] of Object.entries(recByState)) {
      const curve = curveByState[st] || staticCurve;
      const fromCalendar = !curveByState[st] && !!staticCurve;
      const harvestedAcres = Number(a.harvested) || 0;
      const plantedAcres = Number(a.planted) || 0;
      const yld = Number(a.yield) || 0;
      const prodAcres = harvestedAcres || plantedAcres;
      const production = isTree ? (Number(a.production) || 0) : (prodAcres * yld);
      const gapAcres = Math.max(0, plantedAcres - harvestedAcres); // abandoned in field
      let windowPct = null, volume = null, lostInField = null, econAbandonRisk = null, onTreeReturn = null;
      if (isCitrus) {
        // citrus: per-state marketing season (wrap-aware), production-based volume,
        // in-field channel = economically-at-risk fruit (volume x on-tree-abandon risk)
        const season = (CITRUS_SEASON[crop] || {})[st];
        if (season) {
          windowPct = citrusShare(season, startDoy, horizon);
          usedCalendar = true;
          if (production > 0) volume = production * windowPct;
          const er = (ECON_ABANDON_RISK[crop] || {})[st];
          if (er) { econAbandonRisk = er.risk; onTreeReturn = er.onTreeReturn; }
          if (volume != null && econAbandonRisk != null) lostInField = volume * econAbandonRisk;
        }
      } else if (curve) {
        const s = cumAtDoy(curve, startDoy);
        const e = cumAtDoy(curve, wrapped ? 364 : endDoy);
        windowPct = Math.max(0, (e - s)) / 100;
        if (production > 0) volume = production * windowPct;
        // in-field abandonment only where acreage exists (not tree crops)
        if (!isTree) lostInField = gapAcres * yld * windowPct;
        if (fromCalendar) usedCalendar = true;
      }
      const c = riskOf(st);
      const risk = c ? c.risk : null;
      // channel 1: harvested but unsold — n/a for citrus (no NOT-SOLD series)
      const availableForRescue = (!isCitrus && volume != null) ? volume * unsoldRate : null;
      // of the volume entering harvest, the share expected to sell successfully.
      // citrus at-risk fruit is a subset of volume; field/tree unsold is a fraction
      // of volume (the in-field gap is separate, unharvested crop on top of volume).
      let pendingToMarket = null;
      if (volume != null) {
        pendingToMarket = isCitrus
          ? Math.max(0, volume - (lostInField || 0))
          : Math.max(0, volume - (availableForRescue || 0));
      }
      states.push({ state: st, year: a.year, harvestedAcres, plantedAcres, gapAcres,
        yield: yld, yieldUnit: a.yieldUnit, production, windowHarvestPct: windowPct,
        windowFromCalendar: fromCalendar,
        volumeEnteringHarvest: volume, conditionRisk: risk, conditionWeek: c ? c.week : null,
        econAbandonRisk, onTreeReturn,
        unsoldRate: isCitrus ? null : unsoldRate, availableForRescue, lostInField, pendingToMarket });
    }
    // rank by total rescuable in window (unsold + in-field), then by volume
    const rescuable = (s) => (s.availableForRescue || 0) + (s.lostInField || 0);
    states.sort((x, y) => rescuable(y) - rescuable(x) || (y.volumeEnteringHarvest || 0) - (x.volumeEnteringHarvest || 0));

    const haveCurves = states.filter((s) => s.windowHarvestPct != null).length;
    const cropKind = isCitrus ? "citrus" : isTree ? "tree" : "field";
    const out = { crop, horizonDays: horizon, asOf: now.toISOString().slice(0, 10),
      yieldUnit: CROP_YIELD_UNIT[crop], unsoldRate: isCitrus ? null : unsoldRate,
      windowSource: isCitrus ? "citrus-season" : (usedCalendar ? "static-calendar" : "live-progress"),
      cropKind,
      // citrus: in-field channel IS available, but as an ECONOMIC estimate (volume x
      // on-tree abandonment risk), not a measured acreage gap.
      inFieldAvailable: isCitrus || !isTree,
      inFieldBasis: isCitrus ? "economic" : "acreage-gap", states };
    if (isCitrus) out.note = "citrus: no NOT-SOLD or abandonment quantity exists in public data. 'Unharvested · in field' is an ECONOMIC estimate = volume x on-tree-abandonment risk, derived from Equivalent On-Tree returns in the USDA NASS Citrus Fruits 2024 Summary (lemon processing EOT -$4.49/box; orange processing ~$6-13/box). Not a measured figure.";
    else if (isTree) out.note = "tree crop: in-field abandonment not in queryable NASS (on-tree economic abandonment is published only in the annual Fruits summary tables)";
    if (!haveCurves) out.note = "no harvest-progress curve or static calendar for this crop";
    setCached(ck, out, 1000 * 60 * 60 * 6);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "forecast failed", detail: String(e) });
  }
});

// ---- County geometry (fetched + filtered server-side; no browser CSP issue) ----
const STATE_FIPS = { AL:"01",AK:"02",AZ:"04",AR:"05",CA:"06",CO:"08",CT:"09",DE:"10",FL:"12",GA:"13",HI:"15",ID:"16",IL:"17",IN:"18",IA:"19",KS:"20",KY:"21",LA:"22",ME:"23",MD:"24",MA:"25",MI:"26",MN:"27",MS:"28",MO:"29",MT:"30",NE:"31",NV:"32",NH:"33",NJ:"34",NM:"35",NY:"36",NC:"37",ND:"38",OH:"39",OK:"40",OR:"41",PA:"42",RI:"44",SC:"45",SD:"46",TN:"47",TX:"48",UT:"49",VT:"50",VA:"51",WA:"53",WV:"54",WI:"55",WY:"56" };
const GEO_SRC = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";
let GEO_RAW = null;

app.get("/api/geo/counties", async (req, res) => {
  const state = String(req.query.state || "").toUpperCase();
  const fips = STATE_FIPS[state];
  if (!fips) return res.status(400).json({ error: `unknown state ${state}` });
  try {
    if (!GEO_RAW) {
      const r = await fetch(GEO_SRC);
      if (!r.ok) return res.status(502).json({ error: `geo source ${r.status}` });
      GEO_RAW = await r.json();
    }
    const features = GEO_RAW.features.filter((f) => String(f.id).slice(0, 2) === fips);
    res.json({ type: "FeatureCollection", features });
  } catch (e) {
    res.status(502).json({ error: "geo fetch failed", detail: String(e) });
  }
});

// ---- Serve the built React app (production) ----
// `npm run build` emits to ./dist. In prod we serve those static files plus a
// SPA catch-all so the frontend and /api live on one origin (no CORS, no
// hardcoded host). In dev you still use Vite (:5173), which proxies /api here.
const DIST = path.join(__dirname, "dist");
app.use(express.static(DIST));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(DIST, "index.html"), (err) => {
    if (err) res.status(404).send("Build not found — run `npm run build`.");
  });
});

// ---- Cache warm-up ----
// The rescue endpoint makes ~5 live USDA calls, so the FIRST request after a
// cold start (e.g. Render free-tier spin-up) is slow enough to look like a
// failure. On boot we pre-fetch the default-horizon rescue query for each
// fresh-produce crop against our own route, so the 6h cache is already warm
// when the first visitor arrives. Best-effort: failures here never block boot.
// Disable with WARM_CACHE=0.
const WARM_CROPS = ["TOMATOES", "LETTUCE", "STRAWBERRIES", "POTATOES", "APPLES", "ORANGES", "LEMONS"];
async function warmCache(port) {
  if (process.env.WARM_CACHE === "0" || !NASS_KEY) return;
  for (const crop of WARM_CROPS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/forecast/rescue?crop=${crop}&horizon=30`);
      console.log(`  warm ${crop} -> ${r.status}`);
    } catch (e) {
      console.log(`  warm ${crop} failed: ${String(e)}`);
    }
  }
  console.log("Cache warm-up complete.");
}

app.listen(PORT, () => {
  console.log(`Field Loss server on http://localhost:${PORT}`);
  warmCache(PORT); // fire-and-forget; does not block serving
});
