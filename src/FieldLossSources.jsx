import React from "react";

/*
  Data & Sources tab
  ------------------
  A transparent inventory of every data source the app uses and how each one
  feeds the model. Two buckets: LIVE feeds pulled at runtime (via the proxy or
  keyless), and CURATED reference inputs (constants / editable defaults derived
  from published USDA / FAO figures). Nothing here is fetched — it documents the
  rest of the app, so it always renders instantly.
*/

const C = {
  paper: "#F4F1E8", panel: "#FBFAF4", ink: "#23301F", sub: "#5C6B52", line: "#D9D3C2",
  field: "#3A5A40", gold: "#BC8A3C", soil: "#8A5A3B", clay: "#A4442E", teal: "#46787B",
};

// ---- LIVE data feeds (fetched at runtime) ----
const LIVE = [
  {
    name: "USDA NASS Quick Stats",
    endpoint: "quickstats.nass.usda.gov/api",
    auth: "API key (server-side, NASS_KEY)",
    color: C.field,
    provides: "Planted & harvested acres, per-acre yield (state + county), national farm-gate price received, weekly harvest progress (% harvested), crop condition ratings, and utilized production for tree crops.",
    usedFor: "The production baseline everywhere: acreage × yield = volume; price drives the economic-abandonment margin; progress + condition shape the rescue-window forecast.",
    tabs: "Estimator · National map · County slice · Rescue forecast",
  },
  {
    name: "USDA FAS GATS — Census Imports",
    endpoint: "api.fas.usda.gov (X-Api-Key header, FAS_KEY)",
    auth: "API key (server-side, FAS_KEY)",
    color: C.clay,
    provides: "Monthly US fresh-produce import volume by HS commodity code and partner country (e.g. tomatoes 070200 from MX+CA), latest released month, and year-over-year change.",
    usedFor: "Auto-sets the import-shock lever to the observed YoY import change and anchors the price model to it, so a simulated import surge/collapse moves the rescue volume off today's real market.",
    tabs: "Import-shock lever (all tabs)",
  },
  {
    name: "Open-Meteo Forecast API",
    endpoint: "api.open-meteo.com/v1/forecast",
    auth: "Keyless (called direct from the browser)",
    color: C.teal,
    provides: "16-day daily forecast — max/min temperature and precipitation — at state and county centroids (one batched call per view).",
    usedFor: "Builds a weather-risk index (heavy-rain, frost, and extreme-heat days) that, scaled by each crop's perishability, estimates weather/spoilage loss and feeds condition risk.",
    tabs: "Estimator · National map · County slice",
  },
  {
    name: "County boundary GeoJSON",
    endpoint: "raw.githubusercontent.com/plotly/datasets (FIPS counties)",
    auth: "Public file (proxy-cached, GitHub fallback)",
    color: C.gold,
    provides: "County polygon geometry keyed by FIPS code for the selected state.",
    usedFor: "Draws the county choropleth; loaded once and cached.",
    tabs: "County slice",
  },
];

// ---- CURATED reference inputs (constants / editable defaults) ----
const CURATED = [
  {
    name: "FAO / USDA-ERS loss coefficients",
    color: C.soil,
    detail: "Harvest-stage loss rate and perishability per crop, seeded from FAO / USDA-ERS LAFA-style figures. Shown as editable assumptions in the Estimator — calibrate, don't trust blindly.",
  },
  {
    name: "Import share of US fresh supply + price flexibility",
    color: C.clay,
    detail: "Per-crop structural import share (≈ USDA-ERS Fruit & Vegetable data) and a price-flexibility coefficient. These set how hard the import-shock lever swings the price; the live FAS feed supplies the trend, these supply the magnitude.",
  },
  {
    name: "Fresh-market yield defaults",
    color: C.field,
    detail: "For crops NASS publishes only as ALL CLASSES (fresh + processing combined — e.g. tomatoes), the live per-acre yield is processing-dominated, so a curated fresh-market yield is used instead while keeping live acres + price.",
  },
  {
    name: "Structural NOT-SOLD / unsold rate",
    color: C.gold,
    detail: "Share of harvested crop that doesn't sell, derived from NASS PRODUCTION (utilized vs not-sold): e.g. potatoes ≈0.6%, apples ≈3.4%, lettuce ≈0%. Splits forecast volume into the harvested-unsold rescue channel.",
  },
  {
    name: "Static harvest calendars",
    color: C.teal,
    detail: "Typical harvest windows for specialty crops that lack weekly NASS progress data, so the rescue forecast still knows what's in-window over the next 30/90 days.",
  },
  {
    name: "Citrus on-tree economic returns",
    color: C.soil,
    detail: "Equivalent On-Tree (EOT) returns from the USDA NASS Citrus Fruits 2024 Summary (e.g. lemon processing EOT −$4.49/box). Citrus has no public NOT-SOLD or abandonment quantity, so its in-field figure is an explicit economic estimate, not a measured gap.",
  },
  {
    name: "Geographic share fallbacks",
    color: C.sub,
    detail: "National acreage × each state's production share — the crop+state acreage estimate used only when the live NASS call returns nothing (Estimator + National map; County adds area-weighting). One shared source of truth, always labeled 'estimate' in the UI.",
  },
];

// ---- Downstream distribution & logistics (PROSPECTIVE — not yet connected) ----
// How a forecasted rescue opportunity could actually reach a food bank. Listed for
// transparency about the integration path; none of these are wired into the app yet.
const DIST_FIND = [
  { name: "Open Referral / HSDS + HSDA", api: "Open standard + API spec", color: C.field,
    detail: "Machine-readable directories of food pantries & assistance, the basis of many 211 systems. The open, standards-based way to ingest who-receives-what near a farm." },
  { name: "Feeding America / MealConnect", api: "Partnership (no open API)", color: C.clay,
    detail: "The national food-rescue matching platform across 200+ food banks. Reaches the network at scale via a partner integration, not self-serve." },
  { name: "AmpleHarvest.org", api: "Directory (no public API)", color: C.gold,
    detail: "Registry of ~8,500 pantries that specifically accept fresh garden/farm produce — the most on-point directory for this app's output." },
  { name: "USDA Local Food Directories (AMS)", api: "Public API", color: C.teal,
    detail: "Farmers markets, food hubs, on-farm markets, CSAs — candidate aggregation points near a farm." },
];
const DIST_MOVE = [
  { name: "Food Rescue Hero (412 Food Rescue)", api: "Platform partnership", color: C.field,
    detail: "Purpose-built last-mile volunteer-driver dispatch & matching; live in 20+ cities. The closest fit for the last mile." },
  { name: "OpenRouteService / Google Routes / Onfleet / Routific", api: "Routing APIs (open + commercial)", color: C.teal,
    detail: "Multi-stop route optimization and driver dispatch for local pickups → drop-offs. OpenRouteService is free/open; the others are commercial." },
  { name: "project44 / FourKites / DAT / Truckstop / Uber Freight", api: "Commercial APIs", color: C.soil,
    detail: "Freight visibility and load matching for longer-haul truckload moves of bulk surplus. (Convoy shut down in 2023.)" },
  { name: "Samsara / Geotab", api: "Telematics APIs", color: C.gold,
    detail: "Fleet tracking with reefer/temperature monitoring — cold-chain compliance for perishable produce in transit." },
];

export default function FieldLossSources() {
  return (
    <div style={{ background: C.paper, color: C.ink, padding: "28px 22px", fontFamily: "'Archivo', system-ui, sans-serif", lineHeight: 1.5 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
        .disp{font-family:'Fraunces',serif}
        .card{background:${C.panel};border:1px solid ${C.line};border-radius:10px}
      `}</style>

      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        {/* header */}
        <div style={{ borderBottom: `2px solid ${C.ink}`, paddingBottom: 14, marginBottom: 20 }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: 2, color: C.field, textTransform: "uppercase" }}>
            US On-Farm Food Loss · Data & Methods
          </div>
          <h1 className="disp" style={{ fontSize: 38, fontWeight: 600, margin: "4px 0 0", lineHeight: 1.05 }}>
            Where the numbers come from
          </h1>
          <p style={{ color: C.sub, fontSize: 14, maxWidth: 680, margin: "8px 0 0" }}>
            Every figure in this app is either pulled live from a public data service or seeded from a
            published USDA / FAO reference. This page lists each source and exactly how it feeds the model —
            so you always know what you're looking at and why it changes.
          </p>
        </div>

        {/* live feeds */}
        <SectionTitle>Live data feeds — fetched at runtime</SectionTitle>
        <div style={{ display: "grid", gap: 12, marginBottom: 26 }}>
          {LIVE.map((s) => (
            <div key={s.name} className="card" style={{ padding: "16px 18px", borderLeft: `4px solid ${s.color}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <div className="disp" style={{ fontSize: 19, fontWeight: 600, color: s.color }}>{s.name}</div>
                <div className="mono" style={{ fontSize: 11, color: C.sub }}>{s.endpoint}</div>
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: C.sub, marginTop: 2 }}>{s.auth}</div>
              <p style={{ fontSize: 13.5, margin: "10px 0 6px" }}><b style={{ color: C.ink }}>Provides.</b> {s.provides}</p>
              <p style={{ fontSize: 13.5, margin: "0 0 8px", color: C.ink }}><b>How it's used.</b> {s.usedFor}</p>
              <div className="mono" style={{ fontSize: 10.5, color: s.color, textTransform: "uppercase", letterSpacing: 0.5 }}>{s.tabs}</div>
            </div>
          ))}
        </div>

        {/* curated inputs */}
        <SectionTitle>Curated reference inputs — constants & editable defaults</SectionTitle>
        <p style={{ fontSize: 12.5, color: C.sub, margin: "0 0 12px", maxWidth: 680 }}>
          These are not fetched. They are starting assumptions built from published USDA / FAO figures, used
          where no live series exists or where the live series would be misleading. Many are editable in the
          Estimator so you can calibrate them.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 26 }}>
          {CURATED.map((s) => (
            <div key={s.name} className="card" style={{ padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, display: "inline-block" }} />
                <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{s.name}</div>
              </div>
              <p style={{ fontSize: 12.5, color: C.sub, margin: 0 }}>{s.detail}</p>
            </div>
          ))}
        </div>

        {/* how tabs combine */}
        <SectionTitle>How each tab combines them</SectionTitle>
        <div className="card" style={{ padding: "16px 18px", marginBottom: 22 }}>
          {[
            ["Estimator", "NASS acres + yield + price × FAO/ERS loss coefficients × live Open-Meteo weather, for one crop in one state — fully editable."],
            ["National map", "Same model run for every state from batched NASS acres/yield + one batched Open-Meteo call; colored by tons, value, or % of crop."],
            ["County slice", "County-level NASS acres + county-centroid weather over the state's county GeoJSON; drill-down from the national map."],
            ["Rescue forecast", "NASS harvest progress + condition (or static calendars / citrus EOT returns) project what enters the rescue window over 30/90 days, split into harvested-unsold and in-field channels."],
            ["Import-shock lever", "Live FAS GATS imports set the lever's anchor and price swing on top of any tab; shared across all four views."],
          ].map(([t, d]) => (
            <div key={t} style={{ display: "flex", gap: 12, padding: "7px 0", borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
              <div className="mono" style={{ minWidth: 130, color: C.field, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.5, paddingTop: 2 }}>{t}</div>
              <div style={{ color: C.ink }}>{d}</div>
            </div>
          ))}
        </div>

        {/* downstream distribution & logistics */}
        <SectionTitle>Distribution & logistics — prospective integrations</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 12px" }}>
          <span className="mono" style={{ fontSize: 10, color: "#fff", background: C.soil, padding: "2px 8px", borderRadius: 5, textTransform: "uppercase", letterSpacing: 0.5 }}>Not yet connected</span>
          <span style={{ fontSize: 12.5, color: C.sub, maxWidth: 620 }}>
            How a forecasted rescue opportunity could reach a food bank. These are documented integration paths,
            not live data — the app does not currently call any of them.
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
          {[["Find & match receivers", DIST_FIND], ["Move the produce", DIST_MOVE]].map(([group, items]) => (
            <div key={group}>
              <div className="mono" style={{ fontSize: 10.5, color: C.field, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{group}</div>
              <div style={{ display: "grid", gap: 10 }}>
                {items.map((s) => (
                  <div key={s.name} className="card" style={{ padding: "12px 14px", borderLeft: `4px solid ${s.color}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>{s.name}</div>
                      <div className="mono" style={{ fontSize: 10, color: s.color }}>{s.api}</div>
                    </div>
                    <p style={{ fontSize: 12, color: C.sub, margin: "5px 0 0" }}>{s.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.6, marginBottom: 8 }}>
          <strong style={{ color: C.ink }}>Prototype.</strong> Live feeds are real; loss coefficients, import
          shares, and price-flexibility values are illustrative starting points meant to be calibrated against
          USDA-ERS LAFA and FAO loss figures. NASS and FAS keys live server-side in the proxy; the browser only
          ever calls the keyless Open-Meteo endpoint directly.
        </p>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: C.field, textTransform: "uppercase", marginBottom: 12 }}>{children}</div>;
}
