import React, { useState, useEffect, useMemo } from "react";

/*
  Rescue Forecast (prototype)
  ---------------------------
  Forward look at what becomes RESCUABLE in the next 30 / 90 days, per state,
  split into the two categories that matter for food recovery:
    - HARVESTED · UNSOLD  -> crop that gets harvested but doesn't sell, from the
        NASS NOT-SOLD / utilized-vs-total rate. Available for redistribution.
    - UNHARVESTED · IN FIELD -> standing crop left in the field (NASS area
        planted - area harvested), valued at yield. Gleanable / destroyed
        without intervention. ALL-CAUSE (weather + market).
  Window timing comes from the live NASS harvest-progress curve where it exists
  (corn/soy/wheat/potatoes) and a static harvest calendar for specialty crops
  (tomatoes/lettuce/strawberries) that NASS doesn't publish progress for.
*/

// Fresh produce / food-recovery crops only. Commodity grains (corn, soy, wheat)
// are excluded — they go to elevators and processors, not food banks.
// lbs = pounds per native volume unit, used to convert rescue volume to tons
// (tons = volume × lbs / 2000). Most crops report CWT (100 lb); citrus volume
// already arrives in TONS, so lbs:2000 makes that conversion a pass-through.
const CROPS = {
  tomatoes:     { label: "Tomatoes",     nass: "TOMATOES",     lbs: 100 },
  lettuce:      { label: "Lettuce",      nass: "LETTUCE",      lbs: 100 },
  strawberries: { label: "Strawberries", nass: "STRAWBERRIES", lbs: 100 },
  potatoes:     { label: "Potatoes",     nass: "POTATOES",     lbs: 100 },
  apples:       { label: "Apples",       nass: "APPLES",       lbs: 100 },
  oranges:      { label: "Oranges",      nass: "ORANGES",      lbs: 2000 },
  lemons:       { label: "Lemons",       nass: "LEMONS",       lbs: 2000 },
};

// Same-origin: dev → Vite proxies /api to :8787; prod → Express serves /api directly.
const DEFAULT_PROXY = "";

const C = { paper:"#F4F1E8", panel:"#FBFAF4", ink:"#23301F", sub:"#5C6B52", line:"#D9D3C2",
  field:"#3A5A40", gold:"#BC8A3C", soil:"#8A5A3B", clay:"#A4442E", teal:"#46787B", nodata:"#E7E3D6" };

const NAMES = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming" };

const fmt = (n, d = 0) => Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

function riskColor(r) {
  if (r == null) return C.sub;
  if (r >= 0.30) return C.clay;
  if (r >= 0.12) return C.gold;
  return C.field;
}

export default function FieldLossForecast() {
  const [crop, setCrop] = useState("tomatoes");
  const [horizon, setHorizon] = useState(30);
  const [data, setData] = useState({ status: "idle", states: [] });

  useEffect(() => {
    let cancelled = false;
    setData(d => ({ ...d, status: "loading" }));
    fetch(`${DEFAULT_PROXY}/api/forecast/rescue?crop=${CROPS[crop].nass}&horizon=${horizon}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`proxy ${r.status}`)))
      .then(d => { if (!cancelled) setData({ status: "ok", ...d }); })
      .catch(e => { if (!cancelled) setData({ status: "error", error: String(e), states: [] }); });
    return () => { cancelled = true; };
  }, [crop, horizon]);

  const rows = useMemo(() => {
    const lbs = CROPS[crop].lbs;
    const toTons = v => (Number.isFinite(v) ? v : 0) * lbs / 2000;
    return (data.states || [])
      .filter(s => (s.availableForRescue || 0) + (s.lostInField || 0) > 0)
      .map(s => ({
        ...s,
        unsoldTons: toTons(s.availableForRescue),
        inFieldTons: toTons(s.lostInField),
        pendingTons: toTons(s.pendingToMarket),
      }));
  }, [data, crop]);

  const totalVol = rows.reduce((a, r) => a + (r.volumeEnteringHarvest || 0), 0);
  const totalUnsold = rows.reduce((a, r) => a + r.unsoldTons, 0);
  const totalInField = rows.reduce((a, r) => a + r.inFieldTons, 0);
  const totalPending = rows.reduce((a, r) => a + r.pendingTons, 0);
  const unit = data.yieldUnit || CROPS[crop].nass;
  // citrus has no measured rescue channels; its in-field figure is an economic
  // at-risk estimate (volume × on-tree-abandonment risk) and "unsold" is n/a.
  const isCitrus = data.cropKind === "citrus";

  return (
    <div style={{ padding: 16, fontFamily: "'Archivo', system-ui, sans-serif", color: C.ink }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Rescue forecast</h2>
        <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace",
          background: "#EFE9D8", color: C.soil, padding: "2px 8px", borderRadius: 6 }}>PROTOTYPE</span>
        {data.windowSource === "static-calendar" && (
          <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace",
            background: "#EFE9D8", color: C.teal, padding: "2px 8px", borderRadius: 6 }}>static harvest calendar</span>
        )}
        {data.asOf && <span style={{ fontSize: 12, color: C.sub }}>as of {data.asOf}</span>}
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: C.sub, maxWidth: 760 }}>
        Fresh-produce crops headed to food recovery. Of the crop entering the window per state,
        <b style={{ color: C.field }}> pending to market</b> is the share expected to sell; the rest
        splits into two rescue channels. <b style={{ color: C.clay }}>Harvested · unsold</b> — gets
        harvested but doesn't sell (NASS not-sold rate); available for redistribution.
        <b style={{ color: C.soil }}> Unharvested · in field</b> — standing crop left unharvested
        (NASS planted − harvested), valued at yield; gleanable / lost without intervention (all-cause:
        weather + market). Tree crops (apples) report production, not acreage, so their in-field
        abandonment isn't in queryable NASS.
      </p>
      {isCitrus && (
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: C.soil, background: "#F3EDDD",
          padding: "8px 10px", borderRadius: 6, maxWidth: 760 }}>
          <b>Citrus is modeled differently.</b> Public data has no NOT-SOLD series and no
          abandonment quantity for citrus, so <b style={{ color: C.clay }}>harvested · unsold</b> is
          n/a. The <b style={{ color: C.soil }}>on-tree at-risk</b> figure is an <i>economic</i>
          estimate — volume × on-tree-abandonment risk derived from Equivalent On-Tree returns in the
          USDA NASS <i>Citrus Fruits 2024 Summary</i> (lemon processing returns −$4.49/box; orange
          processing ~$6–13/box). The <b>risk</b> column shows that on-tree-abandonment risk, not weather condition.
        </p>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {Object.entries(CROPS).map(([k, c]) => (
          <button key={k} onClick={() => setCrop(k)}
            style={{ padding: "6px 12px", border: `1px solid ${C.line}`, borderRadius: 7, cursor: "pointer",
              fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace",
              background: crop === k ? C.field : "#fff", color: crop === k ? "#fff" : C.sub }}>
            {c.label}
          </button>
        ))}
        <span style={{ width: 12 }} />
        {[30, 90].map(h => (
          <button key={h} onClick={() => setHorizon(h)}
            style={{ padding: "6px 12px", border: `1px solid ${C.line}`, borderRadius: 7, cursor: "pointer",
              fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace",
              background: horizon === h ? C.teal : "#fff", color: horizon === h ? "#fff" : C.sub }}>
            next {h} days
          </button>
        ))}
      </div>

      {data.status === "loading" && <p style={{ color: C.sub, fontSize: 13 }}>Loading live NASS progress + condition…</p>}
      {data.status === "error" && <p style={{ color: C.clay, fontSize: 13 }}>Proxy error: {data.error}. Is the proxy running on :8787?</p>}
      {data.note && <p style={{ color: C.soil, fontSize: 13, background: "#F3EDDD", padding: "8px 10px", borderRadius: 6 }}>{data.note}</p>}

      {rows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 24, margin: "6px 0 12px", flexWrap: "wrap" }}>
            <Stat label={`Volume entering harvest · next ${horizon}d`} value={`${fmt(totalVol / 1e6, 1)}M ${unit}`} />
            <Stat label="Pending to market" value={`${fmt(totalPending, 0)} tons`} color={C.field} />
            <Stat label="Harvested · unsold" value={isCitrus ? "n/a" : `${fmt(totalUnsold, 0)} tons`} color={C.clay} />
            <Stat label={isCitrus ? "On-tree at-risk (econ)" : "Unharvested · in field"} value={data.inFieldAvailable === false ? "n/a" : `${fmt(totalInField, 0)} tons`} color={C.soil} />
            <Stat label="States in window" value={String(rows.length)} />
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: 700 }}>
              <thead>
                <tr style={{ textAlign: "left", color: C.sub, borderBottom: `2px solid ${C.line}` }}>
                  <Th>#</Th><Th>State</Th><Th>Yr</Th><Th right>Harvest in window</Th>
                  <Th right>Volume entering ({unit})</Th><Th right>{isCitrus ? "On-tree abandon risk" : "Condition risk"}</Th>
                  <Th right>Pending to market</Th><Th right>Harvested · unsold</Th><Th right>{isCitrus ? "On-tree at-risk" : "Unharvested · in field"}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.state} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <Td mono>{i + 1}</Td>
                    <Td>{NAMES[r.state] || r.state}</Td>
                    <Td mono dim>{r.year}</Td>
                    <Td right mono>{r.windowHarvestPct != null ? `${fmt(r.windowHarvestPct * 100, 0)}%` : "—"}</Td>
                    <Td right mono>{fmt(r.volumeEnteringHarvest / 1e6, 1)}M</Td>
                    {isCitrus ? (
                      <Td right mono style={{ color: riskColor(r.econAbandonRisk) }}
                        title={r.onTreeReturn != null ? `on-tree return $${r.onTreeReturn}/box` : undefined}>
                        {r.econAbandonRisk != null ? `${fmt(r.econAbandonRisk * 100, 0)}%` : "—"}
                      </Td>
                    ) : (
                      <Td right mono style={{ color: riskColor(r.conditionRisk) }}>
                        {r.conditionRisk != null ? `${fmt(r.conditionRisk * 100, 0)}%` : "—"}
                      </Td>
                    )}
                    <Td right mono style={{ color: r.pendingTons > 0 ? C.field : C.sub }}>{r.pendingTons > 0 ? `${fmt(r.pendingTons, 0)} t` : "—"}</Td>
                    <Td right mono style={{ color: r.unsoldTons > 0 ? C.clay : C.sub }}>{isCitrus ? "n/a" : (r.unsoldTons > 0 ? `${fmt(r.unsoldTons, 0)} t` : "—")}</Td>
                    <Td right mono style={{ color: r.inFieldTons > 0 ? C.soil : C.sub }}>{r.inFieldTons > 0 ? `${fmt(r.inFieldTons, 0)} t` : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: 10, fontSize: 11.5, color: C.sub, fontFamily: "'IBM Plex Mono', monospace" }}>
            {isCitrus ? (
              <>
                pending to market = window volume − on-tree at-risk · on-tree at-risk = window volume ×
                on-tree-abandonment risk (from Equivalent On-Tree returns, USDA NASS Citrus Fruits 2024
                Summary) · economic estimate, not a measured figure · window from citrus marketing
                season (Citrus Fruits summary p.23)
              </>
            ) : (
              <>
                pending to market + unsold = window volume · unsold = window volume × NASS not-sold
                rate ({fmt((data.unsoldRate || 0) * 100, 1)}%) · in field = (planted − harvested) acres
                × yield, gated to window (separate, unharvested crop) ·
                window from {data.windowSource === "static-calendar" ? "static harvest calendar" : "live NASS progress"}
              </>
            )}
          </p>
        </>
      )}
      {data.status === "ok" && rows.length === 0 && !data.note && (
        <p style={{ color: C.sub, fontSize: 13 }}>No crop entering harvest in the next {horizon} days for this selection.</p>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.sub, fontFamily: "'IBM Plex Mono', monospace" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color || C.ink }}>{value}</div>
    </div>
  );
}
const Th = ({ children, right }) => (
  <th style={{ padding: "6px 12px", textAlign: right ? "right" : "left", fontWeight: 600, whiteSpace: "nowrap" }}>{children}</th>
);
const Td = ({ children, right, mono, dim, style }) => (
  <td style={{ padding: "6px 12px", textAlign: right ? "right" : "left",
    fontFamily: mono ? "'IBM Plex Mono', monospace" : "inherit", color: dim ? C.sub : "inherit", ...style }}>{children}</td>
);
