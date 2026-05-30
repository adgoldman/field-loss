import React, { useState, useEffect, useMemo } from "react";

/*
  Field Loss Map (US prototype)
  -----------------------------
  National overview of estimated on-farm food loss by state, drilling into the
  per-field model. Design notes:
   - Tile-grid cartogram: every state = one square (reliable in-sandbox, equal
     visual weight for small states). Production would use county polygons.
   - All 50 states' weather pulled in ONE batched Open-Meteo call (live).
   - Map = production x economics x weather. Per-state planted-acre shares are
     ILLUSTRATIVE placeholders for a NASS county/state pull via the proxy.
*/

const CROPS = {
  potatoes:    { label: "Potatoes",        nass:"POTATOES",    nassStat:"AREA HARVESTED", unit: "cwt", lbs: 100, yield: 440, price: 10.50, harvestCost: 7.50, baseLoss: 0.040, perish: 0.50, natAcres: 920_000 },
  tomatoes:    { label: "Tomatoes (fresh)",nass:"TOMATOES",    nassStat:"AREA HARVESTED", unit: "cwt", lbs: 100, yield: 350, price: 38.0,  harvestCost: 26.0, baseLoss: 0.100, perish: 0.90, natAcres: 95_000 },
  lettuce:     { label: "Lettuce",         nass:"LETTUCE",     nassStat:"AREA HARVESTED", unit: "cwt", lbs: 100, yield: 360, price: 22.0,  harvestCost: 15.0, baseLoss: 0.110, perish: 0.95, natAcres: 250_000 },
  apples:      { label: "Apples",          nass:"APPLES",      nassStat:"AREA HARVESTED", unit: "cwt", lbs: 100, yield: 380, price: 30.0,  harvestCost: 20.0, baseLoss: 0.080, perish: 0.80, natAcres: 290_000 },
  strawberries:{ label: "Strawberries",    nass:"STRAWBERRIES",nassStat:"AREA HARVESTED", unit: "cwt", lbs: 100, yield: 500, price: 90.0,  harvestCost: 60.0, baseLoss: 0.120, perish: 1.00, natAcres: 52_000 },
};

// Same-origin: dev → Vite proxies /api to :8787; prod → Express serves /api directly.
const DEFAULT_PROXY = "";

// NASS harvested-but-unsold rate (mirrors server UNSOLD_RATE); unlisted crops ~0.
const UNSOLD = { potatoes: 0.055, tomatoes: 0.006, apples: 0.034 };

// Illustrative production shares (sum ~1; unlisted states = 0). Replace with NASS.
const SHARES = {
  potatoes: { ID:.31, WA:.145, WI:.065, ND:.065, CO:.05, OR:.045, MN:.045, MI:.045, ME:.04, CA:.035, NE:.03, TX:.02 },
  tomatoes: { CA:.42, FL:.30, IN:.05, OH:.04, MI:.03, TN:.03, VA:.025, NC:.02, NJ:.02, PA:.02, GA:.015 },
  lettuce: { CA:.70, AZ:.25, FL:.02, NJ:.006, NY:.006, CO:.005, WA:.005, MI:.003 },
  apples: { WA:.55, NY:.12, MI:.10, PA:.045, CA:.045, VA:.025, OR:.02, NC:.015, OH:.01 },
  strawberries: { CA:.87, FL:.085, OR:.01, NC:.008, NY:.005, WA:.005, MI:.004, PA:.003 },
};

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
const NAMES = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming" };

// tile-grid layout [row, col]
const GRID = {
  ME:[0,10],
  WA:[1,0],ID:[1,1],MT:[1,2],ND:[1,3],MN:[1,4],WI:[1,5],MI:[1,6],NY:[1,8],VT:[1,9],NH:[1,10],
  OR:[2,0],NV:[2,1],WY:[2,2],SD:[2,3],IA:[2,4],IL:[2,5],IN:[2,6],OH:[2,7],PA:[2,8],NJ:[2,9],MA:[2,10],
  CA:[3,0],UT:[3,1],CO:[3,2],NE:[3,3],MO:[3,4],KY:[3,5],WV:[3,6],VA:[3,7],MD:[3,8],CT:[3,9],RI:[3,10],
  AZ:[4,1],NM:[4,2],KS:[4,3],AR:[4,4],TN:[4,5],NC:[4,6],SC:[4,7],DE:[4,8],
  TX:[5,2],OK:[5,3],LA:[5,4],MS:[5,5],AL:[5,6],GA:[5,7],
  FL:[6,7],
  AK:[7,0],HI:[7,1],
};
const ROWS = 8, COLS = 11;

const C = { paper:"#F4F1E8", panel:"#FBFAF4", ink:"#23301F", sub:"#5C6B52", line:"#D9D3C2",
  field:"#3A5A40", gold:"#BC8A3C", soil:"#8A5A3B", clay:"#A4442E", teal:"#46787B", nodata:"#E7E3D6" };

const fmt = (n,d=0)=>Number.isFinite(n)?n.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const usd = (n)=> "$" + (Math.abs(n)>=1e6 ? fmt(n/1e6,2)+"M" : fmt(n));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

function hex2rgb(h){return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];}
function lerpColor(a,b,t){const A=hex2rgb(a),B=hex2rgb(b);const m=A.map((v,i)=>Math.round(v+(B[i]-v)*clamp(t,0,1)));return `rgb(${m[0]},${m[1]},${m[2]})`;}

// Loss model. `area` carries live NASS figures: { planted, harvested, yield, yieldUnit }.
// Abandonment is MEASURED from the planted−harvested gap when both exist (same year);
// otherwise it falls back to the economic (margin) model. Production uses real NASS
// yield when its unit matches the crop, else the assumed coefficient.
function modelState(crop, area, wx, priceOverride) {
  const c = CROPS[crop];
  const price = Number(priceOverride) > 0 ? Number(priceOverride) : c.price; // live NASS farm-gate price, else default
  const planted = Number(area?.planted) || 0;
  const harvestedRaw = Number(area?.harvested) || 0;
  const yUnit = String(area?.yieldUnit || "").toUpperCase();
  const realYield = (Number(area?.yield) > 0 && yUnit.includes(c.unit.toUpperCase())) ? Number(area.yield) : null;
  const yieldPerAc = realYield || c.yield;
  const yieldSource = realYield ? "NASS" : "assumed";

  const haveGap = planted > 0 && harvestedRaw > 0 && harvestedRaw <= planted * 1.02;
  let gross, production, abandonedVol, fAband, harvested, abandonSource;
  if (haveGap) {
    harvested = Math.min(harvestedRaw, planted);
    gross = planted * yieldPerAc;
    production = harvested * yieldPerAc;
    abandonedVol = (planted - harvested) * yieldPerAc;
    fAband = (planted - harvested) / planted;
    abandonSource = "measured";
  } else {
    const acres = planted || harvestedRaw || 0;
    const marginRatio = price > 0 ? (price - c.harvestCost) / price : -1;
    fAband = clamp(0.015 + 0.60 / (1 + Math.exp(14 * (marginRatio - 0.18))), 0, 0.65);
    gross = acres * yieldPerAc;
    abandonedVol = gross * fAband;
    production = gross - abandonedVol;
    harvested = acres - acres * fAband;
    abandonSource = "modeled";
  }
  const harvestLoss = production * c.baseLoss;
  const wxRate = clamp((wx?.index || 0) * 0.5, 0, 0.20) * c.perish;
  const weatherLoss = production * wxRate;
  const totalVol = abandonedVol + harvestLoss + weatherLoss;
  const tons = v => v * c.lbs / 2000;
  const unsoldRate = UNSOLD[crop] || 0;
  const unsoldVol = production * unsoldRate;
  const marketedVol = Math.max(production - harvestLoss - weatherLoss - unsoldVol, 0);
  return { acres: planted || harvestedRaw, planted, harvested, gross, production, fAband, wxRate,
    abandonSource, yieldSource, yieldPerAc,
    unsoldRate, harvestedUnsoldTons: tons(unsoldVol), inFieldTons: tons(abandonedVol),
    drivers:[{k:"Brought to market",v:marketedVol,t:tons(marketedVol),c:C.field},
             {k:"Unharvested · in field",v:abandonedVol,t:tons(abandonedVol),c:C.soil},
             {k:"Lost during harvest",v:harvestLoss,t:tons(harvestLoss),c:C.gold},
             {k:"Weather/spoilage",v:weatherLoss,t:tons(weatherLoss),c:C.teal},
             ...(unsoldRate>0?[{k:"Harvested · unsold",v:unsoldVol,t:tons(unsoldVol),c:C.clay}]:[])],
    totalTons: tons(totalVol), totalUSD: totalVol*price, pct: gross>0?totalVol/gross:0 };
}

export default function FieldLossMap({ onDrill }) {
  const [crop, setCrop] = useState("tomatoes");
  const [metric, setMetric] = useState("tons"); // tons | usd | pct
  const [wx, setWx] = useState({ status:"loading", byState:{} });
  const [sel, setSel] = useState(null);
  const [livePrice, setLivePrice] = useState(null); // NASS farm-gate $/cwt, national
  // per-state area: live NASS {planted,harvested,yield} via proxy, SHARES as fallback
  const [acresInfo, setAcresInfo] = useState(() => {
    const byState = {};
    Object.keys(STATES).forEach(s => { byState[s] = { planted: CROPS.tomatoes.natAcres * ((SHARES.tomatoes || {})[s] || 0) }; });
    return { status:"idle", source:"illustrative shares", byState };
  });

  // pull planted+harvested+yield for every state (one batched NASS call via proxy)
  useEffect(() => {
    let cancelled = false;
    const c = CROPS[crop];
    setAcresInfo(a => ({ ...a, status:"loading", source:"…" }));
    const fallback = () => {
      const byState = {};
      Object.keys(STATES).forEach(s => { byState[s] = { planted: c.natAcres * ((SHARES[crop] || {})[s] || 0) }; });
      if (!cancelled) setAcresInfo({ status:"fallback", source:"illustrative shares", byState });
    };
    fetch(`${DEFAULT_PROXY}/api/nass/state-acres?crop=${c.nass}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => {
        if (cancelled) return;
        if (!d.states || !d.states.length) return fallback();
        const byState = {};
        d.states.forEach(x => { if (STATES[x.state]) byState[x.state] = x; });
        if (!Object.keys(byState).length) return fallback();
        setAcresInfo({ status:"ok", source:`NASS ${d.states[0].year || ""} (live)`, byState });
      })
      .catch(() => !cancelled && fallback());
    return () => { cancelled = true; };
  }, [crop]);

  // national farm-gate price (NASS PRICE RECEIVED, $/cwt) — drives $ totals and
  // the economic-abandonment fallback; null leaves the static default in place.
  useEffect(() => {
    let cancelled = false;
    setLivePrice(null);
    fetch(`${DEFAULT_PROXY}/api/price?crop=${CROPS[crop].nass}`)
      .then(r => r.ok ? r.json() : null).catch(() => null)
      .then(d => { if (!cancelled && d && d.price > 0) setLivePrice(d); });
    return () => { cancelled = true; };
  }, [crop]);

  // one batched weather call for all states
  useEffect(() => {
    const order = Object.keys(STATES);
    const lats = order.map(s=>STATES[s][0]).join(",");
    const lons = order.map(s=>STATES[s][1]).join(",");
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`+
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=16`;
    let cancelled=false;
    fetch(url).then(r=>r.json()).then(data=>{
      if(cancelled) return;
      const arr = Array.isArray(data)?data:[data];
      const byState={};
      order.forEach((s,i)=>{
        const D=(arr[i]&&arr[i].daily)||{};
        const n=(D.time||[]).length||1;
        let heavy=0,frost=0,heat=0;
        for(let j=0;j<n;j++){
          if((D.precipitation_sum?.[j]??0)>20)heavy++;
          if((D.temperature_2m_min?.[j]??99)<0)frost++;
          if((D.temperature_2m_max?.[j]??-99)>35)heat++;
        }
        byState[s]={index:0.5*(heavy/n)+0.3*(frost/n)+0.2*(heat/n),heavy,frost,heat,n};
      });
      setWx({status:"ok",byState});
    }).catch(()=>!cancelled&&setWx({status:"error",byState:{}}));
    return ()=>{cancelled=true;};
  }, []);

  // per-state model + metric value
  const data = useMemo(()=>{
    const out={};
    let max=0, pmin=Infinity, pmax=0;
    Object.keys(STATES).forEach(s=>{
      const area=acresInfo.byState[s];
      const acres=area?(Number(area.planted)||Number(area.harvested)||0):0;
      if(acres<=0){ out[s]={acres:0}; return; }
      const m=modelState(crop,area,wx.byState[s],livePrice?.price);
      out[s]=m;
      const val = metric==="tons"?m.totalTons : metric==="usd"?m.totalUSD : m.pct;
      if(metric==="pct"){ pmin=Math.min(pmin,val); pmax=Math.max(pmax,val); }
      else max=Math.max(max,val);
    });
    return { out, max, pmin:pmin===Infinity?0:pmin, pmax };
  }, [crop, metric, wx, acresInfo, livePrice]);

  function valueOf(s){const m=data.out[s]; if(!m||!m.acres) return null;
    return metric==="tons"?m.totalTons:metric==="usd"?m.totalUSD:m.pct;}
  function colorOf(s){const v=valueOf(s); if(v==null) return C.nodata;
    let t; if(metric==="pct"){t=data.pmax>data.pmin?(v-data.pmin)/(data.pmax-data.pmin):0.5;}
    else {t=data.max>0?Math.sqrt(v/data.max):0;}
    return lerpColor("#EFE7D2", C.clay, t);}

  // default selection = top state
  useEffect(()=>{
    const ranked=Object.keys(STATES).filter(s=>data.out[s]&&data.out[s].acres>0)
      .sort((a,b)=>(valueOf(b)||0)-(valueOf(a)||0));
    if(ranked.length) setSel(ranked[0]);
  // eslint-disable-next-line
  },[crop, metric, wx, acresInfo]);

  const metricLabel = metric==="tons"?"tons lost":metric==="usd"?"value lost":"% of production";
  const selM = sel && data.out[sel] && data.out[sel].acres ? data.out[sel] : null;
  const selWx = sel ? wx.byState[sel] : null;
  const maxDriver = selM ? Math.max(...selM.drivers.map(d=>d.t)) : 1;

  return (
    <div style={{background:C.paper,color:C.ink,padding:"26px 22px",fontFamily:"'Archivo',system-ui,sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
        .disp{font-family:'Fraunces',serif}
        .card{background:${C.panel};border:1px solid ${C.line};border-radius:10px}
        .tile{transition:transform .08s ease, outline .08s ease;cursor:pointer}
        .tile:hover{transform:translateY(-2px)}
        select,button{font-family:'IBM Plex Mono',monospace}
      `}</style>

      <div style={{maxWidth:1000,margin:"0 auto"}}>
        <div style={{borderBottom:`2px solid ${C.ink}`,paddingBottom:14,marginBottom:18}}>
          <div className="mono" style={{fontSize:11,letterSpacing:2,color:C.field,textTransform:"uppercase"}}>US On-Farm Food Loss · National View</div>
          <h1 className="disp" style={{fontSize:38,fontWeight:600,margin:"4px 0 0"}}>Where the Loss Concentrates</h1>
        </div>

        {/* controls */}
        <div style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"flex-end",marginBottom:16}}>
          <label style={{display:"block"}}>
            <span className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",display:"block",marginBottom:5}}>Crop</span>
            <select value={crop} onChange={e=>setCrop(e.target.value)} style={{padding:"8px 10px",border:`1px solid ${C.line}`,borderRadius:7,background:"#fff",color:C.ink,fontSize:13}}>
              {Object.entries(CROPS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <div>
            <span className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",display:"block",marginBottom:5}}>Color by</span>
            <div style={{display:"flex",border:`1px solid ${C.line}`,borderRadius:7,overflow:"hidden"}}>
              {[["tons","Tons"],["usd","$ Value"],["pct","% of crop"]].map(([k,lbl])=>(
                <button key={k} onClick={()=>setMetric(k)} style={{padding:"8px 14px",border:"none",cursor:"pointer",fontSize:12.5,
                  background: metric===k?C.field:"#fff", color: metric===k?"#fff":C.sub}}>{lbl}</button>
              ))}
            </div>
          </div>
          <div className="mono" style={{fontSize:11,color:C.sub,marginLeft:"auto",textAlign:"right",lineHeight:1.5}}>
            <div>
              {wx.status==="loading"&&"loading live weather…"}
              {wx.status==="ok"&&"weather: live (1 batched call)"}
              {wx.status==="error"&&"weather unavailable"}
            </div>
            <div style={{color: acresInfo.status==="ok"?C.field:C.gold}}>acres: {acresInfo.source}</div>
          </div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1.35fr 1fr",gap:16}}>
          {/* map */}
          <div className="card" style={{padding:"18px"}}>
            <div style={{display:"grid",gridTemplateColumns:`repeat(${COLS},1fr)`,gap:5,aspectRatio:`${COLS}/${ROWS}`}}>
              {Array.from({length:ROWS*COLS}).map((_,idx)=>{
                const r=Math.floor(idx/COLS), col=idx%COLS;
                const s=Object.keys(GRID).find(k=>GRID[k][0]===r&&GRID[k][1]===col);
                if(!s) return <div key={idx}/>;
                const active = sel===s;
                const hasData = data.out[s] && data.out[s].acres>0;
                return (
                  <div key={idx} className="tile" onClick={()=>setSel(s)}
                    title={`${NAMES[s]}${hasData?"":" · no modeled production"}`}
                    style={{background:colorOf(s),borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",
                      outline:active?`2.5px solid ${C.ink}`:"1px solid rgba(0,0,0,0.05)",outlineOffset:active?0:-1,
                      minHeight:30}}>
                    <span className="mono" style={{fontSize:10.5,fontWeight:600,
                      color: hasData? (sqrtNorm(valueOf(s),data,metric)>0.55?"#fff":C.ink) : "#B8B19E"}}>{s}</span>
                  </div>
                );
              })}
            </div>
            {/* legend */}
            <div style={{display:"flex",alignItems:"center",gap:10,marginTop:14}}>
              <span className="mono" style={{fontSize:10.5,color:C.sub}}>low</span>
              <div style={{flex:1,height:10,borderRadius:5,background:`linear-gradient(90deg, #EFE7D2, ${C.clay})`}}/>
              <span className="mono" style={{fontSize:10.5,color:C.sub}}>high {metricLabel}</span>
            </div>
            <div style={{marginTop:6}}><span className="mono" style={{fontSize:10,background:C.nodata,padding:"1px 8px",borderRadius:4,border:`1px solid ${C.line}`,color:C.sub}}>▩ no modeled production</span></div>
          </div>

          {/* detail */}
          <div className="card" style={{padding:"18px"}}>
            {!selM && <p style={{color:C.sub,fontSize:13}}>Select a state with modeled production.</p>}
            {selM && (
              <>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                  <div className="mono" style={{fontSize:11,letterSpacing:1,color:C.field,textTransform:"uppercase"}}>{NAMES[sel]} · {CROPS[crop].label}</div>
                  {onDrill && (
                    <button onClick={()=>onDrill(sel,crop)}
                      style={{padding:"5px 11px",border:"none",borderRadius:6,cursor:"pointer",fontSize:11.5,whiteSpace:"nowrap",
                        background:C.field,color:"#fff",fontFamily:"'IBM Plex Mono',monospace"}}>
                      Drill into counties →
                    </button>
                  )}
                </div>
                <div style={{display:"flex",gap:18,margin:"10px 0 16px"}}>
                  <Big label="Loss" value={fmt(selM.totalTons)+" t"} color={C.clay}/>
                  <Big label="Value" value={usd(selM.totalUSD)}/>
                  <Big label="Of crop" value={fmt(selM.pct*100,1)+"%"}/>
                </div>
                <div className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",marginBottom:8}}>Where the crop goes (tons · 100%)</div>
                {selM.drivers.map(d=>(
                  <div key={d.k} style={{marginBottom:9}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:3}}>
                      <span>{d.k}</span><span className="mono" style={{color:C.sub}}>{fmt(d.t)}</span>
                    </div>
                    <div style={{height:8,background:"#EEE9DA",borderRadius:4,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${maxDriver>0?(d.t/maxDriver)*100:0}%`,background:d.c,borderRadius:4}}/>
                    </div>
                  </div>
                ))}
                <div style={{borderTop:`1px solid ${C.line}`,marginTop:14,paddingTop:12}}>
                  <div className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",marginBottom:8}}>Rescue channels (tons)</div>
                  <ChannelRow k="Harvested · unsold" v={selM.unsoldRate>0?fmt(selM.harvestedUnsoldTons)+" t":"~0"} c={C.clay}/>
                  <ChannelRow k={`Unharvested · in field (${selM.abandonSource})`} v={fmt(selM.inFieldTons)+" t"} c={C.soil}/>
                </div>
                <div style={{borderTop:`1px solid ${C.line}`,marginTop:14,paddingTop:12}}>
                  <div className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",marginBottom:8}}>Inputs</div>
                  <Row k="Planted acres" v={fmt(selM.planted)}/>
                  <Row k="Harvested acres" v={fmt(selM.harvested)}/>
                  <Row k="Production" v={fmt(selM.production/1000)+"k "+CROPS[crop].unit}/>
                  <Row k={`Yield (${selM.yieldSource})`} v={fmt(selM.yieldPerAc)+" "+CROPS[crop].unit+"/ac"}/>
                  <Row k={`Abandonment (${selM.abandonSource})`} v={fmt(selM.fAband*100,1)+"%"}/>
                  {selWx && <Row k="Weather (rain/frost/heat dy)" v={`${selWx.heavy}/${selWx.frost}/${selWx.heat}`}/>}
                </div>
              </>
            )}
          </div>
        </div>

        <p style={{fontSize:11.5,color:C.sub,marginTop:14,lineHeight:1.6}}>
          Map blends production × economic abandonment × live weather. Per-state acres are pulled live from
          USDA NASS via the proxy (illustrative shares are used only if the proxy is unavailable), and the same
          model runs at county level. Loss coefficients are starting assumptions to calibrate against ERS LAFA / FAO.
        </p>
      </div>
    </div>
  );
}

function sqrtNorm(v,data,metric){ if(v==null) return 0;
  if(metric==="pct") return data.pmax>data.pmin?(v-data.pmin)/(data.pmax-data.pmin):0.5;
  return data.max>0?Math.sqrt(v/data.max):0; }

function Big({label,value,color}){return(
  <div><div className="mono" style={{fontSize:10,color:C.sub,textTransform:"uppercase"}}>{label}</div>
  <div className="disp" style={{fontSize:24,fontWeight:600,color:color||C.ink,lineHeight:1.1}}>{value}</div></div>);}
function Row({k,v}){return(
  <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"3px 0"}}>
    <span style={{color:C.sub}}>{k}</span><span className="mono">{v}</span></div>);}
function ChannelRow({k,v,c}){return(
  <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"3px 0"}}>
    <span style={{color:C.sub}}>{k}</span><span className="mono" style={{color:c,fontWeight:600}}>{v}</span></div>);}
