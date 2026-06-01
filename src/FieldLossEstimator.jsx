import React, { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Cell, ResponsiveContainer, Tooltip, LabelList,
} from "recharts";

/*
  On-Farm Food Loss Estimator (US prototype)
  -------------------------------------------
  Combines four data layers into a transparent loss model:
    1. Production baseline  -> USDA NASS Quick Stats (planted acres) + crop yield
    2. Weather / spoilage   -> Open-Meteo (LIVE, keyless, CORS-friendly)
    3. Economic abandonment -> market price vs. harvest cost
    4. Loss coefficients    -> FAO / USDA ERS style harvest-stage loss rates

  Everything in the model is exposed and editable. The numbers shipped as
  defaults are illustrative starting assumptions meant to be calibrated, not
  authoritative figures.
*/

// ---- Crop defaults (editable in UI). Values are representative US figures. ----
const CROPS = {
  potatoes:    { label: "Potatoes",       nass: "POTATOES",    unit: "cwt", lbsPerUnit: 100, yield: 440, price: 10.50, harvestCost: 7.50, baseLoss: 0.040, perish: 0.50 },
  tomatoes:    { label: "Tomatoes (fresh)", nass: "TOMATOES",  unit: "cwt", lbsPerUnit: 100, yield: 350, price: 38.0,  harvestCost: 26.0, baseLoss: 0.100, perish: 0.90 },
  lettuce:     { label: "Lettuce",        nass: "LETTUCE",     unit: "cwt", lbsPerUnit: 100, yield: 360, price: 22.0,  harvestCost: 15.0, baseLoss: 0.110, perish: 0.95 },
  apples:      { label: "Apples",         nass: "APPLES",      unit: "cwt", lbsPerUnit: 100, yield: 380, price: 30.0,  harvestCost: 20.0, baseLoss: 0.080, perish: 0.80 },
  strawberries:{ label: "Strawberries",   nass: "STRAWBERRIES",unit: "cwt", lbsPerUnit: 100, yield: 500, price: 90.0,  harvestCost: 60.0, baseLoss: 0.120, perish: 1.00 },
};

// Crops NASS publishes ONLY as ALL CLASSES (fresh + processing combined) with no
// isolable fresh series — e.g. tomatoes, whose combined per-acre yield is
// processing-dominated. For these we keep live acres + price but use the curated
// fresh-market yield default, so the loss math reflects fresh produce, not cannery
// tonnage. (Keyed by NASS commodity name.)
const NO_LIVE_FRESH_YIELD = new Set(["TOMATOES"]);

// ---- US state centroids for weather lookup ----
const STATES = {
  AL:[32.8,-86.8],AK:[64.1,-152.3],AZ:[34.2,-111.7],AR:[34.9,-92.4],CA:[37.2,-119.4],
  CO:[39.0,-105.5],CT:[41.6,-72.7],DE:[39.0,-75.5],FL:[28.6,-82.4],GA:[32.6,-83.4],
  HI:[20.3,-156.4],ID:[44.4,-114.6],IL:[40.0,-89.2],IN:[39.9,-86.3],IA:[42.0,-93.5],
  KS:[38.5,-98.4],KY:[37.5,-85.3],LA:[31.0,-92.0],ME:[45.4,-69.2],MD:[39.0,-76.8],
  MA:[42.3,-71.8],MI:[44.3,-85.4],MN:[46.3,-94.3],MS:[32.7,-89.7],MO:[38.4,-92.5],
  MT:[47.0,-109.6],NE:[41.5,-99.8],NV:[39.3,-116.6],NH:[43.7,-71.6],NJ:[40.2,-74.7],
  NM:[34.4,-106.1],NY:[42.9,-75.5],NC:[35.6,-79.4],ND:[47.5,-100.5],OH:[40.3,-82.8],
  OK:[35.6,-97.5],OR:[44.0,-120.5],PA:[40.9,-77.8],RI:[41.7,-71.5],SC:[33.9,-80.9],
  SD:[44.4,-100.2],TN:[35.9,-86.4],TX:[31.5,-99.3],UT:[39.3,-111.7],VT:[44.1,-72.7],
  VA:[37.5,-78.9],WA:[47.4,-120.5],WV:[38.6,-80.7],WI:[44.6,-90.0],WY:[43.0,-107.5],
};
const STATE_NAMES = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",
  CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",
  IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",
  ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",
  MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",
  NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",
  OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",
  TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",
  WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};

// ---- palette ----
const C = {
  paper:"#F4F1E8", panel:"#FBFAF4", ink:"#23301F", sub:"#5C6B52", line:"#D9D3C2",
  field:"#3A5A40", gold:"#BC8A3C", soil:"#8A5A3B", clay:"#A4442E", teal:"#46787B",
};

const fmt = (n, d = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n) =>
  "$" + (Math.abs(n) >= 1e6 ? fmt(n / 1e6, 2) + "M" : fmt(n));

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

export default function FieldLossEstimator({ importShock = 0, setImportShock }) {
  const [cropKey, setCropKey] = useState("tomatoes");
  const [stateCode, setStateCode] = useState("CA");
  const [acres, setAcres] = useState(20000);
  const [acresSource, setAcresSource] = useState("manual"); // manual | nass | sample

  // editable assumptions, seeded from crop defaults
  const base = CROPS[cropKey];
  const [a, setA] = useState(seed(base));
  function seed(c) {
    return { yield: c.yield, price: c.price, harvestCost: c.harvestCost, baseLoss: c.baseLoss, perish: c.perish };
  }
  useEffect(() => { setA(seed(CROPS[cropKey])); }, [cropKey]);

  // imports: structural share + price flexibility (drives the import-shock swing),
  // plus live FAS volume/trend as context. Falls back to nulls without a key.
  const [imp, setImp] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/imports?crop=${CROPS[cropKey].nass}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((d) => { if (!cancelled) setImp(d); });
    return () => { cancelled = true; };
  }, [cropKey]);
  // import shock → price displacement, anchored to the live year-over-year change.
  // pf(x) = 1 − flex × x × importShare; the effective price is the ratio
  // pf(shock)/pf(yoyAnchor), so at shock = the observed YoY change the factor is
  // ×1.00 (reproduces today's real market — no double-count) and only the swing
  // away from it moves the price. yoyAnchor = 0 falls back to a status-quo anchor.
  const importShare = imp?.importShare ?? 0;
  const priceFlex = imp?.priceFlex ?? 2.0;
  const yoyAnchor = imp?.live?.yoyPct ?? 0;
  const pf = (x) => clamp(1 - priceFlex * x * importShare, 0.25, 2.5);
  const priceFactor = clamp(pf(importShock) / pf(yoyAnchor), 0.25, 2.5);
  const effPrice = a.price * priceFactor;

  // auto-set the shared lever to the observed YoY import change when live FAS data
  // arrives, so every tab opens on the real current market. Only fires once per crop
  // load (when the lever is still at status quo) to avoid stomping a user's drag.
  const [autoSetCrop, setAutoSetCrop] = useState(null);
  useEffect(() => {
    const yoy = imp?.live?.yoyPct;
    // only act on FAS data that matches the selected crop (the fetch is async, so
    // imp can briefly hold the previous crop's payload)
    if (yoy == null || !setImportShock || imp?.crop !== CROPS[cropKey].nass) return;
    if (autoSetCrop === cropKey) return;
    setImportShock(clamp(yoy, -1, 1));
    setAutoSetCrop(cropKey);
  }, [imp, cropKey, setImportShock, autoSetCrop]);

  // weather (live)
  const [wx, setWx] = useState({ status: "idle", index: 0, heavy: 0, frost: 0, heat: 0, days: 0 });
  useEffect(() => {
    const [lat, lon] = STATES[stateCode];
    let cancelled = false;
    setWx((w) => ({ ...w, status: "loading" }));
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=16`;
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const D = d.daily || {};
        const n = (D.time || []).length || 1;
        let heavy = 0, frost = 0, heat = 0;
        for (let i = 0; i < n; i++) {
          if ((D.precipitation_sum?.[i] ?? 0) > 20) heavy++;
          if ((D.temperature_2m_min?.[i] ?? 99) < 0) frost++;
          if ((D.temperature_2m_max?.[i] ?? -99) > 35) heat++;
        }
        const raw = 0.5 * (heavy / n) + 0.3 * (frost / n) + 0.2 * (heat / n);
        setWx({ status: "ok", index: raw, heavy, frost, heat, days: n });
      })
      .catch(() => !cancelled && setWx((w) => ({ ...w, status: "error" })));
    return () => { cancelled = true; };
  }, [stateCode]);

  // Live model inputs from USDA NASS (same-origin proxy): acreage + yield for the
  // selected state, and national farm-gate price. All remain editable overrides.
  const [nassMsg, setNassMsg] = useState("");
  // the crop|state the live NASS data corresponds to; compared against the current
  // selection so readiness flips false the instant the user switches (no stale frame).
  const [loadedKey, setLoadedKey] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const c = CROPS[cropKey];
    setNassMsg("Loading live data…");
    Promise.all([
      fetch(`/api/nass/state-acres?crop=${c.nass}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/price?crop=${c.nass}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([sa, pr]) => {
      if (cancelled) return;
      const parts = [];
      const row = sa && (sa.states || []).find((s) => s.state === stateCode);
      // acreage: planted preferred, harvested fallback (tree crops report harvested)
      const ac = row ? (Number(row.planted) || Number(row.harvested) || 0) : 0;
      if (ac > 0) { setAcres(ac); setAcresSource("nass"); parts.push(`${row.year} ${row.planted ? "planted" : "harvested"} acres`); }
      // yield — only when the NASS unit matches the crop's display unit (e.g. CWT).
      // For crops NASS reports only as ALL CLASSES (fresh + processing combined,
      // e.g. tomatoes), the live per-acre yield is processing-dominated, so we keep
      // the curated fresh-market default instead of importing it.
      const noFreshYield = NO_LIVE_FRESH_YIELD.has(c.nass);
      const unitOk = row && String(row.yieldUnit || "").toUpperCase().includes(c.unit.toUpperCase());
      if (!noFreshYield && row && Number(row.yield) > 0 && unitOk) {
        setA((a) => ({ ...a, yield: Number(row.yield) })); parts.push(`yield ${fmt(Number(row.yield))}`);
      } else {
        setA((a) => ({ ...a, yield: c.yield }));
        if (noFreshYield && row && Number(row.yield) > 0) parts.push(`fresh-market yield ${fmt(c.yield)} (NASS publishes tomatoes only as combined incl. processing)`);
      }
      // national farm-gate price ($/cwt)
      if (pr && pr.price > 0) { setA((a) => ({ ...a, price: pr.price })); parts.push(`price $${pr.price}/cwt (${pr.year})`); }
      else setA((a) => ({ ...a, price: c.price }));
      setNassMsg(parts.length ? `Live from USDA NASS: ${parts.join(" · ")}. Editable below.` : "No live data for this crop/state — using defaults.");
      setLoadedKey(`${cropKey}|${stateCode}`);
    });
    return () => { cancelled = true; };
  }, [cropKey, stateCode]);

  // Results render only once live inputs (NASS acres/price + weather) have resolved
  // for the CURRENT selection, so we never flash loss figures computed from seed
  // defaults or stale values left over from the previously selected crop/state.
  const resultsReady = loadedKey === `${cropKey}|${stateCode}` && (wx.status === "ok" || wx.status === "error");

  // ---- the model ----
  const m = useMemo(() => {
    const gross = acres * a.yield;                      // crop units
    // economics run on the import-adjusted price (effPrice); at shock 0 effPrice = a.price
    const marginRatio = effPrice > 0 ? (effPrice - a.harvestCost) / effPrice : -1;
    // economic abandonment: logistic on margin ratio
    const fAband = clamp(0.015 + 0.60 / (1 + Math.exp(14 * (marginRatio - 0.18))), 0, 0.65);
    const abandonedVol = gross * fAband;
    const harvestedVol = gross - abandonedVol;
    const harvestLossVol = harvestedVol * a.baseLoss;
    const wxRate = clamp(wx.index * 0.5, 0, 0.20) * a.perish;
    const weatherLossVol = harvestedVol * wxRate;
    const totalVol = abandonedVol + harvestLossVol + weatherLossVol;
    const marketedVol = Math.max(gross - totalVol, 0); // crop that successfully leaves the farm
    const toTons = (v) => (v * CROPS[cropKey].lbsPerUnit) / 2000;
    return {
      gross, fAband, marginRatio, wxRate,
      parts: [
        { key: "Brought to market",    vol: marketedVol, tons: toTons(marketedVol), color: C.field },
        { key: "Abandoned (economic)", vol: abandonedVol, tons: toTons(abandonedVol), color: C.soil },
        { key: "Lost during harvest",   vol: harvestLossVol, tons: toTons(harvestLossVol), color: C.gold },
        { key: "Weather / spoilage",   vol: weatherLossVol, tons: toTons(weatherLossVol), color: C.teal },
      ],
      totalVol, totalTons: toTons(totalVol), totalUSD: totalVol * effPrice,
      marketedTons: toTons(marketedVol), marketedPct: gross > 0 ? marketedVol / gross : 0,
      pct: gross > 0 ? totalVol / gross : 0,
    };
  }, [acres, a, wx, cropKey, effPrice]);

  const upd = (k) => (e) => setA({ ...a, [k]: Number(e.target.value) });
  const unit = CROPS[cropKey].unit;

  return (
    <div style={{ background: C.paper, color: C.ink, padding: "28px 22px", fontFamily: "'Archivo', system-ui, sans-serif", lineHeight: 1.45 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
        .disp{font-family:'Fraunces',serif}
        input,select{font-family:'IBM Plex Mono',monospace}
        .card{background:${C.panel};border:1px solid ${C.line};border-radius:10px}
        .recharts-wrapper{font-family:'IBM Plex Mono',monospace}
      `}</style>

      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        {/* header */}
        <div style={{ borderBottom: `2px solid ${C.ink}`, paddingBottom: 14, marginBottom: 20 }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: 2, color: C.field, textTransform: "uppercase" }}>
            US On-Farm Food Loss · Prototype Model
          </div>
          <h1 className="disp" style={{ fontSize: 40, fontWeight: 600, margin: "4px 0 0", lineHeight: 1.05 }}>
            Field Loss Estimator
          </h1>
          <p style={{ color: C.sub, fontSize: 14, maxWidth: 620, margin: "8px 0 0" }}>
            Estimates crop that never makes it off the farm — left unharvested, lost at harvest, or
            spoiled by weather — by combining production, market, and live weather signals.
          </p>
        </div>

        {/* controls */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
          <Field label="Crop">
            <select value={cropKey} onChange={(e) => setCropKey(e.target.value)} style={selStyle}>
              {Object.entries(CROPS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Field>
          <Field label="State">
            <select value={stateCode} onChange={(e) => setStateCode(e.target.value)} style={selStyle}>
              {Object.keys(STATES).sort().map((s) => <option key={s} value={s}>{STATE_NAMES[s]}</option>)}
            </select>
          </Field>
          <Field label={`Planted acres · ${acresSource}`}>
            <input type="number" value={acres} onChange={(e) => { setAcres(Number(e.target.value)); setAcresSource("manual"); }} style={selStyle} />
          </Field>
        </div>

        {/* headline result */}
        {resultsReady ? (
          <div className="card" style={{ padding: "20px 22px", marginBottom: 16, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
            <Stat big label="Est. on-farm loss" value={fmt(m.totalTons) + " t"} sub={`${fmt(m.pct * 100, 1)}% of production`} color={C.clay} />
            <Stat label="Value lost" value={usd(m.totalUSD)} sub={`@ $${a.price}/${unit}`} />
            <Stat label="Gross production" value={fmt(m.gross / 1000) + "k " + unit} sub={`${fmt(acres)} ac × ${a.yield}`} />
            <Stat label="Abandonment rate" value={fmt(m.fAband * 100, 1) + "%"} sub={m.marginRatio < 0 ? "negative margin" : `${fmt(m.marginRatio * 100, 0)}% margin`} color={m.fAband > 0.2 ? C.clay : C.field} />
          </div>
        ) : (
          <LoadingCard height={92} label={`Loading live USDA data for ${CROPS[cropKey].label} · ${STATE_NAMES[stateCode]}…`} />
        )}

        {/* chart + drivers */}
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16, marginBottom: 16 }}>
          <div className="card" style={{ padding: "18px 18px 8px" }}>
            <SectionTitle>Where the crop goes (tons · sums to 100%)</SectionTitle>
            {resultsReady ? (
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={m.parts} layout="vertical" margin={{ left: 8, right: 40, top: 6, bottom: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="key" width={150} tick={{ fontSize: 11, fill: C.ink }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v) => fmt(v) + " t"} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  <Bar dataKey="tons" radius={[0, 4, 4, 0]}>
                    {m.parts.map((p, i) => <Cell key={i} fill={p.color} />)}
                    <LabelList dataKey="tons" position="right" formatter={(v) => fmt(v)} style={{ fontSize: 11, fill: C.sub }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 210, display: "flex", alignItems: "center", justifyContent: "center", color: C.sub, fontSize: 13 }} className="mono">Waiting for live data…</div>
            )}
          </div>

          {/* weather panel */}
          <div className="card" style={{ padding: "18px 18px" }}>
            <SectionTitle>Live weather signal · {STATE_NAMES[stateCode]}</SectionTitle>
            {wx.status === "loading" && <p style={{ color: C.sub, fontSize: 13 }}>Fetching Open-Meteo forecast…</p>}
            {wx.status === "error" && <p style={{ color: C.clay, fontSize: 13 }}>Weather fetch failed; weather loss set to 0.</p>}
            {wx.status === "ok" && (
              <>
                <p style={{ color: C.sub, fontSize: 12, margin: "0 0 12px" }}>Next {wx.days} days, state centroid</p>
                <WxRow label="Heavy-rain days (>20mm)" v={wx.heavy} c={C.teal} />
                <WxRow label="Frost days (<0°C)" v={wx.frost} c={C.field} />
                <WxRow label="Extreme-heat days (>35°C)" v={wx.heat} c={C.gold} />
                <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 10, paddingTop: 10, fontSize: 12, color: C.sub }} className="mono">
                  weather index {fmt(wx.index, 3)} → loss rate {fmt(m.wxRate * 100, 1)}%<br />
                  (scaled by {CROPS[cropKey].label} perishability {a.perish})
                </div>
              </>
            )}
          </div>
        </div>

        {/* import shock */}
        <div className="card" style={{ padding: "18px 18px", marginBottom: 16 }}>
          <SectionTitle>Import shock → recovery-market swing</SectionTitle>
          <p style={{ fontSize: 12, color: C.sub, margin: "0 0 12px" }}>
            Fresh imports add to US supply. Demand is inelastic, so an import surge crashes the farm-gate
            price, collapses grower margins, and pushes more crop into the rescue / waste market. The size of
            the swing scales with this crop’s import exposure.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18, alignItems: "center" }}>
            <div>
              <div className="mono" style={{ fontSize: 12, color: C.sub, display: "flex", justifyContent: "space-between" }}>
                <span>Simulated import change</span>
                <span style={{ color: importShock === 0 ? C.sub : (importShock > 0 ? C.clay : C.field), fontWeight: 600 }}>
                  {importShock > 0 ? "+" : ""}{fmt(importShock * 100)}%
                </span>
              </div>
              <input type="range" min={-100} max={100} step={5} value={Math.round(importShock * 100)}
                onChange={(e) => setImportShock && setImportShock(Number(e.target.value) / 100)}
                style={{ width: "100%", margin: "8px 0 4px", accentColor: C.field }} />
              <div className="mono" style={{ fontSize: 10, color: C.sub, display: "flex", justifyContent: "space-between" }}>
                <span>−100% (imports vanish)</span><span>status quo</span><span>+100% (imports double)</span>
              </div>
            </div>
            <div className="mono" style={{ fontSize: 12, color: C.ink, lineHeight: 1.7 }}>
              <div>Import share of US supply: <b>{importShare > 0 ? fmt(importShare * 100) + "%" : "—"}</b></div>
              <div>Price flexibility: <b>{imp ? priceFlex : "—"}</b></div>
              <div>Price factor: <b style={{ color: priceFactor < 1 ? C.clay : priceFactor > 1 ? C.field : C.ink }}>×{fmt(priceFactor, 2)}</b></div>
              <div>Effective price: <b>{resultsReady ? `$${fmt(effPrice, 2)}` : "—"}</b>{resultsReady && <span style={{ color: C.sub }}> (base ${fmt(a.price, 2)})</span>}</div>
              <div>Economic abandonment: <b style={{ color: C.soil }}>{resultsReady ? `${fmt(m.fAband * 100, 1)}%` : "—"}</b></div>
            </div>
          </div>
          <p style={{ fontSize: 11, color: C.sub, margin: "12px 0 0" }} className="mono">
            {imp?.live?.volCwt
              ? `Live FAS imports: ${fmt(imp.live.volCwt / 1000)}k CWT in ${imp.live.period}${imp.live.yoyPct != null ? ` · ${imp.live.yoyPct > 0 ? "+" : ""}${fmt(imp.live.yoyPct * 100, 1)}% YoY` : ""} (${imp.live.source}).`
              : imp
                ? `Import share is a curated USDA-ERS structural estimate${imp?.note?.includes("FAS_KEY") ? " (set FAS_KEY for live FAS volume/trend)" : ""}.`
                : "Loading import exposure…"}
            {" "}{imp?.live?.yoyPct != null
              ? `Lever auto-sets to the live ${imp.live.yoyPct > 0 ? "+" : ""}${fmt(imp.live.yoyPct * 100, 1)}% YoY change and is anchored there at ×1.00, so it reproduces today’s market without double-counting; drag to explore other scenarios.`
              : "Lever defaults to status quo, since the live price already embeds today’s imports."}
          </p>
        </div>

        {/* assumptions */}
        <div className="card" style={{ padding: "18px 18px", marginBottom: 16 }}>
          <SectionTitle>Model assumptions — edit to calibrate</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
            <Field label={`Yield (${unit}/ac)`}><input type="number" value={a.yield} onChange={upd("yield")} style={selStyle} /></Field>
            <Field label={`Price ($/${unit})`}><input type="number" step="0.01" value={a.price} onChange={upd("price")} style={selStyle} /></Field>
            <Field label={`Harvest cost ($/${unit})`}><input type="number" step="0.01" value={a.harvestCost} onChange={upd("harvestCost")} style={selStyle} /></Field>
            <Field label="Harvest-loss rate"><input type="number" step="0.005" value={a.baseLoss} onChange={upd("baseLoss")} style={selStyle} /></Field>
            <Field label="Perishability (0–1)"><input type="number" step="0.05" value={a.perish} onChange={upd("perish")} style={selStyle} /></Field>
          </div>
          <p style={{ fontSize: 12, color: C.sub, margin: "12px 0 0" }}>
            Economic abandonment is a logistic function of margin (price − harvest cost): when the per-unit
            margin gets thin or negative, more of the crop is left in the field. Harvest-loss and perishability
            seed from FAO / USDA-ERS-style coefficients.
          </p>
        </div>

        {/* NASS */}
        <div className="card" style={{ padding: "18px 18px", marginBottom: 18 }}>
          <SectionTitle>USDA NASS Quick Stats (live inputs)</SectionTitle>
          <p style={{ fontSize: 12.5, color: C.sub, margin: 0, lineHeight: 1.6 }}>
            Acreage, yield, and farm-gate price load automatically for the selected
            crop and state via the data service — no key needed. Any value above can
            be edited to override the live figure.
          </p>
          {nassMsg && <p style={{ fontSize: 12, color: acresSource === "nass" ? C.field : C.gold, margin: "10px 0 0" }} className="mono">{nassMsg}</p>}
        </div>

        {/* sources / caveats */}
        <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.6 }}>
          <strong style={{ color: C.ink }}>Data layers:</strong>{" "}
          <Tag c={C.field}>Open-Meteo · live</Tag>
          <Tag c={C.gold}>NASS Quick Stats · key + proxy</Tag>
          <Tag c={C.soil}>Market price · manual / USDA Market News</Tag>
          <Tag c={C.teal}>FAO / ERS loss coefficients · defaults</Tag>
          <p style={{ marginTop: 8 }}>
            Prototype. Default coefficients are illustrative and should be calibrated against ERS LAFA and
            FAO loss figures. NASS and Market News need a server-side proxy in production (browser CORS).
          </p>
        </div>
      </div>
    </div>
  );
}

// ---- small components ----
const selStyle = { width: "100%", padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 7, background: "#fff", color: C.ink, fontSize: 13, boxSizing: "border-box" };

function Field({ label, children }) {
  return (
    <label style={{ display: "block" }}>
      <span className="mono" style={{ fontSize: 10.5, letterSpacing: 0.5, color: C.sub, textTransform: "uppercase", display: "block", marginBottom: 5 }}>{label}</span>
      {children}
    </label>
  );
}
function SectionTitle({ children }) {
  return <div className="mono" style={{ fontSize: 11, letterSpacing: 1, color: C.field, textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}
function LoadingCard({ height = 80, label }) {
  return (
    <div className="card" style={{ padding: "20px 22px", marginBottom: 16, minHeight: height, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="mono" style={{ fontSize: 12.5, color: C.sub, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: C.gold, display: "inline-block", animation: "flpulse 1s ease-in-out infinite" }} />
        {label || "Loading live data…"}
      </div>
      <style>{`@keyframes flpulse{0%,100%{opacity:.3}50%{opacity:1}}`}</style>
    </div>
  );
}
function Stat({ label, value, sub, color, big }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: 0.5, color: C.sub, textTransform: "uppercase" }}>{label}</div>
      <div className="disp" style={{ fontSize: big ? 30 : 24, fontWeight: 600, color: color || C.ink, lineHeight: 1.1, marginTop: 3 }}>{value}</div>
      {sub && <div className="mono" style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function WxRow({ label, v, c }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", fontSize: 13 }}>
      <span style={{ color: C.ink }}>{label}</span>
      <span className="mono" style={{ fontWeight: 600, color: c }}>{v}</span>
    </div>
  );
}
function Tag({ c, children }) {
  return <span className="mono" style={{ display: "inline-block", fontSize: 10.5, color: c, border: `1px solid ${c}`, borderRadius: 5, padding: "2px 7px", margin: "0 6px 6px 0" }}>{children}</span>;
}
