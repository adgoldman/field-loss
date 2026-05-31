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

export default function FieldLossForecast({ importShock = 0, setImportShock }) {
  const [crop, setCrop] = useState("tomatoes");
  const [horizon, setHorizon] = useState(30);
  const [data, setData] = useState({ status: "idle", states: [] });
  const [imp, setImp] = useState(null); // import exposure (share + flex + live FAS) for this crop

  // yoyBaseline anchors the server price model to the prior-year import level, so the
  // live price (which embeds today's imports) is not double-counted: at importShock =
  // this YoY change the price factor is ×1.00 and only the swing away from it adds
  // import-driven rescue. Only use the baseline once imp matches the selected crop.
  const yoyBaseline = (imp?.crop === CROPS[crop].nass ? imp?.live?.yoyPct : 0) ?? 0;

  useEffect(() => {
    let cancelled = false;
    setData(d => ({ ...d, status: "loading" }));
    fetch(`${DEFAULT_PROXY}/api/forecast/rescue?crop=${CROPS[crop].nass}&horizon=${horizon}&importShock=${importShock}&yoyBaseline=${yoyBaseline}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`proxy ${r.status}`)))
      .then(d => { if (!cancelled) setData({ status: "ok", ...d }); })
      .catch(e => { if (!cancelled) setData({ status: "error", error: String(e), states: [] }); });
    return () => { cancelled = true; };
  }, [crop, horizon, importShock, yoyBaseline]);

  // import exposure for this crop → drives the shared import-shock lever readouts
  useEffect(() => {
    let cancelled = false;
    setImp(null);
    fetch(`${DEFAULT_PROXY}/api/imports?crop=${CROPS[crop].nass}`)
      .then(r => r.ok ? r.json() : null).catch(() => null)
      .then(d => { if (!cancelled) setImp(d); });
    return () => { cancelled = true; };
  }, [crop]);

  // auto-set the shared lever to the live YoY import change on FAS load (once per
  // crop), so the forecast opens on the real current market. Guard on imp.crop
  // because the fetch is async and imp can briefly hold the previous crop's payload.
  const [autoSetCrop, setAutoSetCrop] = useState(null);
  useEffect(() => {
    const yoy = imp?.live?.yoyPct;
    if (yoy == null || !setImportShock || imp?.crop !== CROPS[crop].nass) return;
    if (autoSetCrop === crop) return;
    setImportShock(Math.max(-1, Math.min(1, yoy)));
    setAutoSetCrop(crop);
  }, [imp, crop, setImportShock, autoSetCrop]);

  const rows = useMemo(() => {
    const lbs = CROPS[crop].lbs;
    const toTons = v => (Number.isFinite(v) ? v : 0) * lbs / 2000;
    return (data.states || [])
      .filter(s => (s.availableForRescue || 0) + (s.lostInField || 0) + (s.importDrivenRescue || 0) > 0)
      .map(s => ({
        ...s,
        unsoldTons: toTons(s.availableForRescue),
        inFieldTons: toTons(s.lostInField),
        pendingTons: toTons(s.pendingToMarket),
        importTons: toTons(s.importDrivenRescue),
      }));
  }, [data, crop]);

  const totalVol = rows.reduce((a, r) => a + (r.volumeEnteringHarvest || 0), 0);
  const totalUnsold = rows.reduce((a, r) => a + r.unsoldTons, 0);
  const totalInField = rows.reduce((a, r) => a + r.inFieldTons, 0);
  const totalPending = rows.reduce((a, r) => a + r.pendingTons, 0);
  const totalImport = rows.reduce((a, r) => a + r.importTons, 0);
  const unit = data.yieldUnit || CROPS[crop].nass;
  // citrus has no measured rescue channels; its in-field figure is an economic
  // at-risk estimate (volume × on-tree-abandonment risk) and "unsold" is n/a.
  const isCitrus = data.cropKind === "citrus";
  // import-driven rescue only appears when the lever is pushed *past* the live YoY
  // anchor (a surge beyond today's market crashes price further); at or below the
  // anchor it's 0, so key the extra column off real volume rather than shock !== 0.
  const showImport = !isCitrus && totalImport > 0;

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

      <ImportShockBar imp={imp} data={data} importShock={importShock} setImportShock={setImportShock}
        importTons={totalImport} isCitrus={isCitrus} />

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
            {showImport && (
              <Stat label="Import-driven rescue" value={`${fmt(totalImport, 0)} tons`} color={C.clay} />
            )}
            <Stat label="States in window" value={String(rows.length)} />
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: 700 }}>
              <thead>
                <tr style={{ textAlign: "left", color: C.sub, borderBottom: `2px solid ${C.line}` }}>
                  <Th>#</Th><Th>State</Th><Th>Yr</Th><Th right>Harvest in window</Th>
                  <Th right>Volume entering ({unit})</Th><Th right>{isCitrus ? "On-tree abandon risk" : "Condition risk"}</Th>
                  <Th right>Pending to market</Th><Th right>Harvested · unsold</Th><Th right>{isCitrus ? "On-tree at-risk" : "Unharvested · in field"}</Th>
                  {showImport && <Th right>Import-driven</Th>}
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
                    {showImport && (
                      <Td right mono style={{ color: r.importTons > 0 ? C.clay : C.sub }}>{r.importTons > 0 ? `${fmt(r.importTons, 0)} t` : "—"}</Td>
                    )}
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

// Shared import-shock lever — same state + server model as the other tabs. Moving
// it re-fetches /api/forecast/rescue with importShock, so a simulated change in
// fresh imports collapses margins → extra economic abandonment → import-driven
// rescue volume per state. No-op for citrus (no import model for oranges/lemons).
function ImportShockBar({ imp, data, importShock, setImportShock, importTons, isCitrus }) {
  const pct = Math.round((importShock || 0) * 100);
  const share = imp?.importShare ?? null;
  const flex = imp?.priceFlex ?? null;
  const factor = data?.priceFactor != null ? data.priceFactor : 1;
  const live = imp?.live;
  const yoy = live?.yoyPct;
  const atAnchor = yoy != null && Math.abs(importShock - yoy) < 0.005;
  return (
    <div style={{ border: `1px solid ${C.line}`, background: C.panel, borderRadius: 10, padding: "12px 14px", margin: "0 0 12px", maxWidth: 760 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 1, fontFamily: "'IBM Plex Mono', monospace" }}>Import shock → recovery-market swing</div>
        <div style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", color: importShock === 0 ? C.sub : (importShock > 0 ? C.clay : C.field) }}>
          {pct > 0 ? `+${pct}` : pct}% fresh imports {atAnchor ? "· live YoY (today's market)" : (importShock === 0 ? "· status quo" : "")}
        </div>
      </div>
      <input type="range" min={-100} max={100} step={5} value={pct}
        onChange={e => setImportShock && setImportShock(Number(e.target.value) / 100)}
        style={{ width: "100%", margin: "10px 0 4px", accentColor: C.clay }} />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: C.sub, fontFamily: "'IBM Plex Mono', monospace" }}>−100% (import collapse)</span>
        <span style={{ fontSize: 10, color: C.sub, fontFamily: "'IBM Plex Mono', monospace" }}>+100% (import surge)</span>
      </div>
      {isCitrus ? (
        <div style={{ fontSize: 11, color: C.soil, marginTop: 8, fontFamily: "'IBM Plex Mono', monospace" }}>
          No fresh-import model for citrus — the lever does not affect oranges/lemons.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 10 }}>
            <Mini label="Import share" v={share != null ? `${fmt(share * 100, 0)}%` : "—"} />
            <Mini label="Price flexibility" v={flex != null ? fmt(flex, 1) : "—"} />
            <Mini label="Price factor" v={`×${fmt(factor, 2)}`} color={factor < 1 ? C.clay : (factor > 1 ? C.field : C.ink)} />
            <Mini label="Import-driven rescue" v={importTons > 0 ? `${fmt(importTons, 0)} t` : "—"} color={C.clay} />
          </div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 8, lineHeight: 1.5, fontFamily: "'IBM Plex Mono', monospace" }}>
            {live
              ? `FAS live: ${fmt(live.volCwt / 1000)}k cwt in ${live.period}${live.yoyPct != null ? ` (${live.yoyPct > 0 ? "+" : ""}${fmt(live.yoyPct * 100, 1)}% YoY)` : ""} · ${live.source}`
              : (imp?.note || "structural import share (live FAS volume unavailable)")}
            {yoy != null
              ? `. Lever auto-set to the live ${yoy > 0 ? "+" : ""}${fmt(yoy * 100, 1)}% YoY change and anchored there at ×1.00 (today's market) — push past it to add import-driven rescue.`
              : ". Live price already embeds today's imports — move the lever to simulate a change."}
          </div>
        </>
      )}
    </div>
  );
}
function Mini({ label, v, color }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, color: C.sub, textTransform: "uppercase", fontFamily: "'IBM Plex Mono', monospace" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: color || C.ink, fontFamily: "'IBM Plex Mono', monospace" }}>{v}</div>
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
