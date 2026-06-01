import React, { useState, useEffect, useMemo, useRef } from "react";
import * as d3 from "d3";

/*
  Field Loss — County Vertical Slice
  ----------------------------------
  Real county geography for ONE state, drilling the model to county grain.
  Data flow:
    1. County GeoJSON (all US counties, FIPS-keyed) fetched once, filtered to state.
    2. County centroids -> ONE batched Open-Meteo call (live weather per county).
    3. County planted acres via the proxy (/api/nass/county-acres); if the proxy
       isn't running, fall back to area-weighted estimates (clearly labeled).
    4. Same loss model as the national view, run per county.
*/

const GEO_URL = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";
// Same-origin: dev → Vite proxies /api to :8787; prod → Express serves /api directly.
const DEFAULT_PROXY = "";

// NASS harvested-but-unsold rate (mirrors server UNSOLD_RATE); unlisted crops ~0.
const UNSOLD = { potatoes: 0.055, tomatoes: 0.006, apples: 0.034 };

const CROPS = {
  potatoes:    { label:"Potatoes",         nass:"POTATOES",    nassStat:"AREA HARVESTED", unit:"cwt", lbs:100, yield:440, price:10.50, harvestCost:7.50, baseLoss:0.040, perish:0.50, natAcres:920_000 },
  tomatoes:    { label:"Tomatoes (fresh)", nass:"TOMATOES",    nassStat:"AREA HARVESTED", unit:"cwt", lbs:100, yield:350, price:38.0,  harvestCost:26.0, baseLoss:0.100, perish:0.90, natAcres:95_000 },
  lettuce:     { label:"Lettuce",          nass:"LETTUCE",     nassStat:"AREA HARVESTED", unit:"cwt", lbs:100, yield:360, price:22.0,  harvestCost:15.0, baseLoss:0.110, perish:0.95, natAcres:250_000 },
  apples:      { label:"Apples",           nass:"APPLES",      nassStat:"AREA HARVESTED", unit:"cwt", lbs:100, yield:380, price:30.0,  harvestCost:20.0, baseLoss:0.080, perish:0.80, natAcres:290_000 },
  strawberries:{ label:"Strawberries",     nass:"STRAWBERRIES",nassStat:"AREA HARVESTED", unit:"cwt", lbs:100, yield:500, price:90.0,  harvestCost:60.0, baseLoss:0.120, perish:1.00, natAcres:52_000 },
};
// state-level share of national acres (for fallback sizing only; from the national view)
const STATE_SHARE = {
  potatoes: { ID:.31, WA:.145, WI:.065, ND:.065, CO:.05, OR:.045, MN:.045, MI:.045, ME:.04, CA:.035, NE:.03, TX:.02 },
  tomatoes: { CA:.42, FL:.30, IN:.05, OH:.04, MI:.03, TN:.03, VA:.025, NC:.02, NJ:.02, PA:.02, GA:.015 },
  lettuce: { CA:.70, AZ:.25, FL:.02, NJ:.006, NY:.006, CO:.005, WA:.005, MI:.003 },
  apples: { WA:.55, NY:.12, MI:.10, PA:.045, CA:.045, VA:.025, OR:.02, NC:.015, OH:.01 },
  strawberries: { CA:.87, FL:.085, OR:.01, NC:.008, NY:.005, WA:.005, MI:.004, PA:.003 },
};
// every state (alpha -> {fips, name}); the national map drills into any of these.
const SLICE_STATES = {
  AL:{fips:"01",name:"Alabama"}, AK:{fips:"02",name:"Alaska"}, AZ:{fips:"04",name:"Arizona"}, AR:{fips:"05",name:"Arkansas"},
  CA:{fips:"06",name:"California"}, CO:{fips:"08",name:"Colorado"}, CT:{fips:"09",name:"Connecticut"}, DE:{fips:"10",name:"Delaware"},
  FL:{fips:"12",name:"Florida"}, GA:{fips:"13",name:"Georgia"}, HI:{fips:"15",name:"Hawaii"}, ID:{fips:"16",name:"Idaho"},
  IL:{fips:"17",name:"Illinois"}, IN:{fips:"18",name:"Indiana"}, IA:{fips:"19",name:"Iowa"}, KS:{fips:"20",name:"Kansas"},
  KY:{fips:"21",name:"Kentucky"}, LA:{fips:"22",name:"Louisiana"}, ME:{fips:"23",name:"Maine"}, MD:{fips:"24",name:"Maryland"},
  MA:{fips:"25",name:"Massachusetts"}, MI:{fips:"26",name:"Michigan"}, MN:{fips:"27",name:"Minnesota"}, MS:{fips:"28",name:"Mississippi"},
  MO:{fips:"29",name:"Missouri"}, MT:{fips:"30",name:"Montana"}, NE:{fips:"31",name:"Nebraska"}, NV:{fips:"32",name:"Nevada"},
  NH:{fips:"33",name:"New Hampshire"}, NJ:{fips:"34",name:"New Jersey"}, NM:{fips:"35",name:"New Mexico"}, NY:{fips:"36",name:"New York"},
  NC:{fips:"37",name:"North Carolina"}, ND:{fips:"38",name:"North Dakota"}, OH:{fips:"39",name:"Ohio"}, OK:{fips:"40",name:"Oklahoma"},
  OR:{fips:"41",name:"Oregon"}, PA:{fips:"42",name:"Pennsylvania"}, RI:{fips:"44",name:"Rhode Island"}, SC:{fips:"45",name:"South Carolina"},
  SD:{fips:"46",name:"South Dakota"}, TN:{fips:"47",name:"Tennessee"}, TX:{fips:"48",name:"Texas"}, UT:{fips:"49",name:"Utah"},
  VT:{fips:"50",name:"Vermont"}, VA:{fips:"51",name:"Virginia"}, WA:{fips:"53",name:"Washington"}, WV:{fips:"54",name:"West Virginia"},
  WI:{fips:"55",name:"Wisconsin"}, WY:{fips:"56",name:"Wyoming"},
};

const C = { paper:"#F4F1E8", panel:"#FBFAF4", ink:"#23301F", sub:"#5C6B52", line:"#D9D3C2",
  field:"#3A5A40", gold:"#BC8A3C", soil:"#8A5A3B", clay:"#A4442E", teal:"#46787B", nodata:"#E7E3D6" };
const W = 540, H = 430;

const fmt=(n,d=0)=>Number.isFinite(n)?n.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const usd=(n)=> "$"+(Math.abs(n)>=1e6?fmt(n/1e6,2)+"M":fmt(n));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function hex2rgb(h){return[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];}
function lerpColor(a,b,t){const A=hex2rgb(a),B=hex2rgb(b);const m=A.map((v,i)=>Math.round(v+(B[i]-v)*clamp(t,0,1)));return`rgb(${m[0]},${m[1]},${m[2]})`;}

// Crops NASS publishes ONLY as ALL CLASSES (fresh + processing combined) with no
// isolable fresh series — e.g. tomatoes, whose combined per-acre yield is
// processing-dominated. For these we keep live acres + price but use the curated
// fresh-market yield default, so production reflects fresh produce, not cannery
// tonnage. (Keyed by NASS commodity name.)
const NO_LIVE_FRESH_YIELD = new Set(["TOMATOES"]);

// `area` carries live NASS figures: { planted, harvested, yield, yieldUnit }.
// Abandonment is MEASURED from the planted−harvested gap (same year) when both
// exist, else falls back to the economic model. Production uses real NASS yield
// when its unit matches the crop, else the assumed coefficient.
function modelCounty(crop, area, wx, priceOverride, importFactor = 1) {
  const c=CROPS[crop];
  const basePrice=Number(priceOverride)>0?Number(priceOverride):c.price; // live NASS farm-gate price, else default
  const price=basePrice*importFactor; // import-shock displacement (×1 at status quo)
  const planted=Number(area?.planted)||0;
  const harvestedRaw=Number(area?.harvested)||0;
  const yUnit=String(area?.yieldUnit||"").toUpperCase();
  const noFreshYield=NO_LIVE_FRESH_YIELD.has(c.nass);
  const realYield=(!noFreshYield && Number(area?.yield)>0 && yUnit.includes(c.unit.toUpperCase()))?Number(area.yield):null;
  const yieldPerAc=realYield||c.yield;
  const yieldSource=realYield?"NASS":(noFreshYield?"fresh default":"assumed");

  const haveGap=planted>0 && harvestedRaw>0 && harvestedRaw<=planted*1.02;
  let gross, production, abandonedVol, fAband, harvested, abandonSource;
  if(haveGap){
    harvested=Math.min(harvestedRaw,planted);
    gross=planted*yieldPerAc;
    production=harvested*yieldPerAc;
    abandonedVol=(planted-harvested)*yieldPerAc;
    fAband=(planted-harvested)/planted;
    abandonSource="measured";
  } else {
    const acres=planted||harvestedRaw||0;
    const marginRatio=price>0?(price-c.harvestCost)/price:-1;
    fAband=clamp(0.015+0.60/(1+Math.exp(14*(marginRatio-0.18))),0,0.65);
    gross=acres*yieldPerAc;
    abandonedVol=gross*fAband;
    production=gross-abandonedVol;
    harvested=acres-acres*fAband;
    abandonSource="modeled";
  }
  const harvestLoss=production*c.baseLoss;
  const wxRate=clamp((wx?.index||0)*0.5,0,0.20)*c.perish;
  const weatherLoss=production*wxRate;
  const totalVol=abandonedVol+harvestLoss+weatherLoss;
  const tons=v=>v*c.lbs/2000;
  const unsoldRate=UNSOLD[crop]||0;
  const unsoldVol=production*unsoldRate;
  const marketedVol=Math.max(production-harvestLoss-weatherLoss-unsoldVol,0);
  return { acres:planted||harvestedRaw, planted, harvested, gross, production, fAband,
    abandonSource, yieldSource, yieldPerAc,
    unsoldRate, harvestedUnsoldTons:tons(unsoldVol), inFieldTons:tons(abandonedVol),
    drivers:[{k:"Brought to market",t:tons(marketedVol),c:C.field},
             {k:"Unharvested · in field",t:tons(abandonedVol),c:C.soil},
             {k:"Lost during harvest",t:tons(harvestLoss),c:C.gold},
             {k:"Weather/spoilage",t:tons(weatherLoss),c:C.teal},
             ...(unsoldRate>0?[{k:"Harvested · unsold",t:tons(unsoldVol),c:C.clay}]:[])],
    totalTons:tons(totalVol), totalUSD:totalVol*price, pct:gross>0?totalVol/gross:0 };
}

export default function FieldLossCounty({ init, importShock = 0, setImportShock }) {
  const [crop, setCrop] = useState(init?.crop && CROPS[init.crop] ? init.crop : "tomatoes");
  const [stAlpha, setStAlpha] = useState(init?.state && SLICE_STATES[init.state] ? init.state : "IA");
  const [metric, setMetric] = useState("tons");
  const [proxy, setProxy] = useState(DEFAULT_PROXY);
  const [geo, setGeo] = useState({ status:"loading", features:[] });
  const [wx, setWx] = useState({ status:"idle", byFips:{} });
  const [acres, setAcres] = useState({ status:"idle", source:"—", byFips:{} });
  const [sel, setSel] = useState(null);
  const [livePrice, setLivePrice] = useState(null); // NASS farm-gate $/cwt, national
  const [imp, setImp] = useState(null); // import exposure (share + flex) for this crop
  const geoCacheRef = useRef(null);

  // re-seed crop/state when the national map drills into a new state
  useEffect(() => {
    if (!init) return;
    if (init.crop && CROPS[init.crop]) setCrop(init.crop);
    if (init.state && SLICE_STATES[init.state]) setStAlpha(init.state);
  }, [init]);

  // 1. fetch + filter county geometry (proxy first, then direct GitHub)
  useEffect(() => {
    let cancelled=false;
    const stFips=SLICE_STATES[stAlpha].fips;
    setGeo({status:"loading",features:[]});
    const filt=(fc)=>fc.features.filter(f=>String(f.id).slice(0,2)===stFips);
    if(geoCacheRef.current){ setGeo({status:"ok",features:filt(geoCacheRef.current)}); return; }
    const direct=()=>fetch(GEO_URL).then(r=>r.json()).then(fc=>{geoCacheRef.current=fc; if(!cancelled) setGeo({status:"ok",features:filt(fc)});});
    fetch(`${proxy}/api/geo/counties?state=${stAlpha}`)
      .then(r=>r.ok?r.json():Promise.reject())
      .then(fc=>{ if(!cancelled) setGeo({status:"ok",features:fc.features||[]}); })
      .catch(()=>direct().catch(()=>!cancelled&&setGeo({status:"error",features:[]})));
    return ()=>{cancelled=true;};
  }, [stAlpha, proxy]);

  // manual GeoJSON load (works in-sandbox, no network)
  function onGeoFile(e){
    const file=e.target.files&&e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=()=>{ try{
        const fc=JSON.parse(reader.result); geoCacheRef.current=fc;
        const stFips=SLICE_STATES[stAlpha].fips;
        setGeo({status:"ok",features:fc.features.filter(f=>String(f.id).slice(0,2)===stFips)});
      }catch{ setGeo({status:"error",features:[]}); } };
    reader.readAsText(file);
  }

  // projection + paths
  const { path, centroids } = useMemo(()=>{
    if(!geo.features.length) return {path:null,centroids:{}};
    const fc={type:"FeatureCollection",features:geo.features};
    const proj=d3.geoMercator().fitExtent([[14,14],[W-14,H-14]],fc);
    const p=d3.geoPath(proj);
    const cen={};
    geo.features.forEach(f=>{cen[f.id]=d3.geoCentroid(f);}); // [lon,lat]
    return {path:p, centroids:cen};
  }, [geo.features]);

  // 2. batched weather for all county centroids (one call)
  useEffect(()=>{
    const ids=Object.keys(centroids);
    if(!ids.length) return;
    let cancelled=false;
    setWx({status:"loading",byFips:{}});
    const lats=ids.map(id=>centroids[id][1]).join(",");
    const lons=ids.map(id=>centroids[id][0]).join(",");
    const url=`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`+
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=16`;
    fetch(url).then(r=>r.json()).then(data=>{
      if(cancelled) return;
      const arr=Array.isArray(data)?data:[data];
      const byFips={};
      ids.forEach((id,i)=>{
        const D=(arr[i]&&arr[i].daily)||{};
        const n=(D.time||[]).length||1; let heavy=0,frost=0,heat=0;
        for(let j=0;j<n;j++){
          if((D.precipitation_sum?.[j]??0)>20)heavy++;
          if((D.temperature_2m_min?.[j]??99)<0)frost++;
          if((D.temperature_2m_max?.[j]??-99)>35)heat++;
        }
        byFips[id]={index:0.5*(heavy/n)+0.3*(frost/n)+0.2*(heat/n),heavy,frost,heat};
      });
      setWx({status:"ok",byFips});
    }).catch(()=>!cancelled&&setWx({status:"error",byFips:{}}));
    return ()=>{cancelled=true;};
  }, [centroids]);

  // 3. county acres: proxy first, area-weighted fallback
  useEffect(()=>{
    const ids=Object.keys(centroids);
    if(!ids.length) return;
    let cancelled=false;
    setAcres({status:"loading",source:"…",byFips:{}});
    const fallback=()=>{
      // distribute state total across counties by relative geographic area
      const featById={}; geo.features.forEach(f=>featById[f.id]=f);
      const areas=ids.map(id=>d3.geoArea(featById[id])||0);
      const sumA=areas.reduce((a,b)=>a+b,0)||1;
      const stateTotal=CROPS[crop].natAcres*((STATE_SHARE[crop]||{})[stAlpha]||0.05);
      const byFips={}; ids.forEach((id,i)=>{byFips[id]={planted:stateTotal*(areas[i]/sumA)};});
      if(!cancelled) setAcres({status:"ok",source:"area-weighted estimate",byFips,key:`${crop}|${stAlpha}`});
    };
    fetch(`${proxy}/api/nass/county-acres?crop=${CROPS[crop].nass}&state=${stAlpha}`)
      .then(r=>r.ok?r.json():Promise.reject())
      .then(d=>{
        if(cancelled) return;
        if(!d.counties||!d.counties.length) return fallback();
        const byFips={}; d.counties.forEach(c=>{byFips[c.fips]=c;});
        setAcres({status:"ok",source:`NASS ${d.counties[0].year||""} (live)`,byFips,key:`${crop}|${stAlpha}`});
      })
      .catch(()=>!cancelled&&fallback());
    return ()=>{cancelled=true;};
  }, [centroids, crop, stAlpha, proxy]);

  // national farm-gate price (NASS PRICE RECEIVED, $/cwt) — drives $ totals and
  // the economic-abandonment fallback; null leaves the static default in place.
  const [priceCrop, setPriceCrop] = useState(null); // crop the price fetch last settled for
  useEffect(()=>{
    let cancelled=false;
    setLivePrice(null);
    fetch(`${proxy}/api/price?crop=${CROPS[crop].nass}`)
      .then(r=>r.ok?r.json():null).catch(()=>null)
      .then(d=>{ if(!cancelled){ if(d && d.price>0) setLivePrice(d); setPriceCrop(crop); } });
    return ()=>{cancelled=true;};
  }, [crop, proxy]);

  // import exposure for this crop → import-shock price displacement (shared lever)
  useEffect(()=>{
    let cancelled=false;
    setImp(null);
    fetch(`${proxy}/api/imports?crop=${CROPS[crop].nass}`)
      .then(r=>r.ok?r.json():null).catch(()=>null)
      .then(d=>{ if(!cancelled) setImp(d); });
    return ()=>{cancelled=true;};
  }, [crop, proxy]);
  // anchored ratio form: pf(x)=1−flex·x·share; factor = pf(shock)/pf(yoyAnchor), so
  // at shock = live YoY change the factor is ×1.00 (today's real market) and only the
  // swing away from it moves price. yoyAnchor=0 → status-quo anchor.
  const importYoy = imp?.live?.yoyPct ?? 0;
  const pfCounty = (x) => clamp(1 - (imp?.priceFlex ?? 2.0) * x * (imp?.importShare ?? 0), 0.25, 2.5);
  const importFactor = clamp(pfCounty(importShock) / pfCounty(importYoy), 0.25, 2.5);

  // auto-set the shared lever to the live YoY import change on FAS load (once per
  // crop). Guard on imp.crop because the fetch is async and imp can briefly hold the
  // previous crop's payload.
  const [autoSetCrop, setAutoSetCrop] = useState(null);
  useEffect(()=>{
    const yoy = imp?.live?.yoyPct;
    if (yoy == null || !setImportShock || imp?.crop !== CROPS[crop].nass) return;
    if (autoSetCrop === crop) return;
    setImportShock(clamp(yoy, -1, 1));
    setAutoSetCrop(crop);
  }, [imp, crop, setImportShock, autoSetCrop]);

  // model per county
  const data = useMemo(()=>{
    const out={}; let max=0,pmin=Infinity,pmax=0;
    geo.features.forEach(f=>{
      const area=acres.byFips[f.id];
      const a=area?(Number(area.planted)||Number(area.harvested)||0):0;
      if(a<=0){out[f.id]={acres:0};return;}
      const m=modelCounty(crop,area,wx.byFips[f.id],livePrice?.price,importFactor); out[f.id]=m;
      const v=metric==="tons"?m.totalTons:metric==="usd"?m.totalUSD:m.pct;
      if(metric==="pct"){pmin=Math.min(pmin,v);pmax=Math.max(pmax,v);} else max=Math.max(max,v);
    });
    return {out,max,pmin:pmin===Infinity?0:pmin,pmax};
  }, [geo.features, acres, wx, crop, metric, livePrice, importFactor]);

  const valueOf=(id)=>{const m=data.out[id]; if(!m||!m.acres) return null;
    return metric==="tons"?m.totalTons:metric==="usd"?m.totalUSD:m.pct;};
  const norm=(id)=>{const v=valueOf(id); if(v==null) return 0;
    return metric==="pct"?(data.pmax>data.pmin?(v-data.pmin)/(data.pmax-data.pmin):0.5):(data.max>0?Math.sqrt(v/data.max):0);};
  const colorOf=(id)=>valueOf(id)==null?C.nodata:lerpColor("#EFE7D2",C.clay,norm(id));

  // default selection = top county
  useEffect(()=>{
    const ranked=geo.features.map(f=>f.id).filter(id=>data.out[id]&&data.out[id].acres>0)
      .sort((a,b)=>(valueOf(b)||0)-(valueOf(a)||0));
    setSel(ranked[0]||null);
  // eslint-disable-next-line
  },[geo.features,acres,wx,crop,metric]);

  const nmeById={}; geo.features.forEach(f=>{nmeById[f.id]=f.properties&&f.properties.NAME;});
  const selM = sel&&data.out[sel]&&data.out[sel].acres?data.out[sel]:null;
  const selWx = sel?wx.byFips[sel]:null;
  const maxDriver = selM?Math.max(...selM.drivers.map(d=>d.t)):1;
  const metricLabel = metric==="tons"?"tons lost":metric==="usd"?"value lost":"% of production";
  const withData = geo.features.filter(f=>data.out[f.id]&&data.out[f.id].acres>0).length;
  // gate the choropleth fill + county panel until live inputs resolve FOR THE CURRENT
  // crop+state, so counties aren't colored from placeholder acres/price or values left
  // over from the previously selected crop/state that then jump to live NASS values.
  const dataReady = geo.status==="ok" && acres.key===`${crop}|${stAlpha}` && priceCrop===crop && (wx.status==="ok"||wx.status==="error");

  return (
    <div style={{background:C.paper,color:C.ink,padding:"26px 22px",fontFamily:"'Archivo',system-ui,sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
        .disp{font-family:'Fraunces',serif}
        .card{background:${C.panel};border:1px solid ${C.line};border-radius:10px}
        select,button,input{font-family:'IBM Plex Mono',monospace}
        .cty{cursor:pointer;transition:opacity .1s} .cty:hover{opacity:.78}
      `}</style>
      <div style={{maxWidth:1000,margin:"0 auto"}}>
        <div style={{borderBottom:`2px solid ${C.ink}`,paddingBottom:14,marginBottom:18}}>
          <div className="mono" style={{fontSize:11,letterSpacing:2,color:C.field,textTransform:"uppercase"}}>On-Farm Food Loss · County Vertical Slice</div>
          <h1 className="disp" style={{fontSize:36,fontWeight:600,margin:"4px 0 0"}}>{SLICE_STATES[stAlpha].name} · {CROPS[crop].label}</h1>
        </div>

        <div style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"flex-end",marginBottom:16}}>
          <Ctrl label="Crop"><select value={crop} onChange={e=>setCrop(e.target.value)} style={selStyle}>
            {Object.entries(CROPS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></Ctrl>
          <Ctrl label="State"><select value={stAlpha} onChange={e=>setStAlpha(e.target.value)} style={selStyle}>
            {Object.entries(SLICE_STATES).map(([k,v])=><option key={k} value={k}>{v.name}</option>)}</select></Ctrl>
          <Ctrl label="Color by">
            <div style={{display:"flex",border:`1px solid ${C.line}`,borderRadius:7,overflow:"hidden"}}>
              {[["tons","Tons"],["usd","$"],["pct","%"]].map(([k,l])=>(
                <button key={k} onClick={()=>setMetric(k)} style={{padding:"8px 13px",border:"none",cursor:"pointer",fontSize:12.5,
                  background:metric===k?C.field:"#fff",color:metric===k?"#fff":C.sub}}>{l}</button>))}
            </div>
          </Ctrl>
          <Ctrl label="Proxy base"><input value={proxy} onChange={e=>setProxy(e.target.value)} style={{...selStyle,width:170}}/></Ctrl>
        </div>

        {/* shared import-shock lever */}
        <ImportShockBar imp={imp} importShock={importShock} setImportShock={setImportShock} importFactor={importFactor} />

        <div style={{display:"grid",gridTemplateColumns:"1.3fr 1fr",gap:16}}>
          <div className="card" style={{padding:"16px"}}>
            {geo.status==="loading"&&<P>Loading county geometry (~one-time 3 MB)…</P>}
            {geo.status==="error"&&(
              <div>
                <P style={{color:C.clay,marginBottom:10}}>The Claude preview's sandbox blocks the county GeoJSON fetch (allowlist). It works in your own app and via the proxy. To render here now, load the file manually:</P>
                <input type="file" accept=".json,.geojson,application/json" onChange={onGeoFile}
                  style={{fontSize:12,color:C.ink}}/>
                <P style={{marginTop:8,fontSize:11.5}}>One-time download: the plotly county FIPS GeoJSON (search "geojson-counties-fips.json"), then pick it above. Or run <span className="mono">node server.js</span> and the proxy serves geometry.</P>
              </div>
            )}
            {geo.status==="ok"&&path&&(
              <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}}>
                {geo.features.map(f=>(
                  <path key={f.id} className="cty" d={path(f)} fill={dataReady?colorOf(f.id):"#E9E3D2"}
                    stroke={sel===f.id?C.ink:"#fff"} strokeWidth={sel===f.id?1.6:0.4}
                    onClick={()=>dataReady&&setSel(f.id)}>
                    <title>{nmeById[f.id]}</title>
                  </path>
                ))}
              </svg>
            )}
            {geo.status==="ok"&&!dataReady&&(
              <div className="mono" style={{fontSize:11.5,color:C.sub,marginTop:10,display:"flex",alignItems:"center",gap:8}}>
                <span style={{width:8,height:8,borderRadius:"50%",background:C.gold,display:"inline-block",animation:"flpulse 1s ease-in-out infinite"}}/>
                Loading live county acres + price + weather…
                <style>{`@keyframes flpulse{0%,100%{opacity:.3}50%{opacity:1}}`}</style>
              </div>
            )}
            <div style={{display:"flex",alignItems:"center",gap:10,marginTop:12}}>
              <span className="mono" style={{fontSize:10.5,color:C.sub}}>low</span>
              <div style={{flex:1,height:10,borderRadius:5,background:`linear-gradient(90deg,#EFE7D2,${C.clay})`}}/>
              <span className="mono" style={{fontSize:10.5,color:C.sub}}>high {metricLabel}</span>
            </div>
          </div>

          <div className="card" style={{padding:"18px"}}>
            {!dataReady&&<P>Loading live USDA data for {CROPS[crop].label} · {SLICE_STATES[stAlpha].name}…</P>}
            {dataReady&&!selM&&<P>Select a county with modeled production.</P>}
            {dataReady&&selM&&(<>
              <div className="mono" style={{fontSize:11,letterSpacing:1,color:C.field,textTransform:"uppercase"}}>{nmeById[sel]} County</div>
              <div style={{display:"flex",gap:18,margin:"10px 0 16px"}}>
                <Big label="Loss" value={fmt(selM.totalTons)+" t"} color={C.clay}/>
                <Big label="Value" value={usd(selM.totalUSD)}/>
                <Big label="Of crop" value={fmt(selM.pct*100,1)+"%"}/>
              </div>
              <div className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",marginBottom:8}}>Where the crop goes (tons · 100%)</div>
              {selM.drivers.map(d=>(
                <div key={d.k} style={{marginBottom:9}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:3}}><span>{d.k}</span><span className="mono" style={{color:C.sub}}>{fmt(d.t)}</span></div>
                  <div style={{height:8,background:"#EEE9DA",borderRadius:4}}><div style={{height:"100%",width:`${maxDriver>0?(d.t/maxDriver)*100:0}%`,background:d.c,borderRadius:4}}/></div>
                </div>))}
              <div style={{borderTop:`1px solid ${C.line}`,marginTop:14,paddingTop:12}}>
                <div className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",marginBottom:8}}>Rescue channels (tons)</div>
                <ChannelRow k="Harvested · unsold" v={selM.unsoldRate>0?fmt(selM.harvestedUnsoldTons)+" t":"~0"} c={C.clay}/>
                <ChannelRow k={`Unharvested · in field (${selM.abandonSource})`} v={fmt(selM.inFieldTons)+" t"} c={C.soil}/>
              </div>
              <div style={{borderTop:`1px solid ${C.line}`,marginTop:14,paddingTop:12}}>
                <Row k="Planted acres" v={fmt(selM.planted)}/>
                <Row k="Harvested acres" v={fmt(selM.harvested)}/>
                <Row k="Production" v={fmt(selM.production/1000)+"k "+CROPS[crop].unit}/>
                <Row k={`Yield (${selM.yieldSource})`} v={fmt(selM.yieldPerAc)+" "+CROPS[crop].unit+"/ac"}/>
                <Row k={`Abandonment (${selM.abandonSource})`} v={fmt(selM.fAband*100,1)+"%"}/>
                {selWx&&<Row k="Weather (rain/frost/heat dy)" v={`${selWx.heavy}/${selWx.frost}/${selWx.heat}`}/>}
              </div>
            </>)}
          </div>
        </div>

        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:14}}>
          <Badge c={geo.status==="ok"?C.field:C.sub}>geometry {geo.status}</Badge>
          <Badge c={wx.status==="ok"?C.field:C.sub}>weather {wx.status} · 1 call</Badge>
          <Badge c={acres.source.includes("live")?C.field:C.gold}>acres: {acres.source}</Badge>
          <Badge c={C.sub}>{withData} counties modeled</Badge>
        </div>
        <p style={{fontSize:11.5,color:C.sub,marginTop:12,lineHeight:1.6}}>
          Run the proxy (<span className="mono">node server.js</span>) with a NASS key to replace the area-weighted
          fallback with real county planted acres. Weather is live per county via centroids. The same model and
          flow extend to every state; production would cache geometry + NASS server-side rather than fetching per session.
        </p>
      </div>
    </div>
  );
}

// Shared import-shock lever (same model + state as the other tabs). Flows through
// importFactor → county price → economic abandonment → per-county loss totals.
function ImportShockBar({ imp, importShock, setImportShock, importFactor }){
  const pct=Math.round((importShock||0)*100);
  const share=imp?.importShare ?? null;
  const flex=imp?.priceFlex ?? null;
  const live=imp?.live;
  const yoy=live?.yoyPct;
  const atAnchor = yoy != null && Math.abs(importShock - yoy) < 0.005;
  return (
    <div className="card" style={{padding:"14px 16px",marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,flexWrap:"wrap"}}>
        <div className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",letterSpacing:1}}>Import shock → recovery-market swing</div>
        <div className="mono" style={{fontSize:11,color: importShock===0?C.sub:(importShock>0?C.clay:C.field)}}>
          {pct>0?`+${pct}`:pct}% fresh imports {atAnchor?"· live YoY (today's market)":(importShock===0?"· status quo":"")}
        </div>
      </div>
      <input type="range" min={-100} max={100} step={5} value={pct}
        onChange={e=>setImportShock && setImportShock(Number(e.target.value)/100)}
        style={{width:"100%",margin:"10px 0 4px",accentColor:C.clay}}/>
      <div style={{display:"flex",justifyContent:"space-between"}}>
        <span className="mono" style={{fontSize:10,color:C.sub}}>−100% (import collapse)</span>
        <span className="mono" style={{fontSize:10,color:C.sub}}>+100% (import surge)</span>
      </div>
      <div style={{display:"flex",gap:18,flexWrap:"wrap",marginTop:10}}>
        <Mini label="Import share" v={share!=null?fmt(share*100,0)+"%":"—"}/>
        <Mini label="Price flexibility" v={flex!=null?fmt(flex,1):"—"}/>
        <Mini label="Price factor" v={"×"+fmt(importFactor,2)} color={importFactor<1?C.clay:(importFactor>1?C.field:C.ink)}/>
      </div>
      <div className="mono" style={{fontSize:10.5,color:C.sub,marginTop:8,lineHeight:1.5}}>
        {live
          ? `FAS live: ${fmt(live.volCwt/1000)}k cwt in ${live.period}${live.yoyPct!=null?` (${live.yoyPct>0?"+":""}${fmt(live.yoyPct*100,1)}% YoY)`:""} · ${live.source}`
          : (imp?.note || "structural import share (live FAS volume unavailable)")}
        {yoy != null
          ? `. Lever auto-set to the live ${yoy>0?"+":""}${fmt(yoy*100,1)}% YoY change and anchored there at ×1.00 (today's market) — drag to simulate other scenarios.`
          : ". Live price already embeds today's imports — move the lever to simulate a change."}
      </div>
    </div>
  );
}
function Mini({label,v,color}){return(
  <div><div className="mono" style={{fontSize:9.5,color:C.sub,textTransform:"uppercase"}}>{label}</div>
  <div className="mono" style={{fontSize:15,fontWeight:600,color:color||C.ink}}>{v}</div></div>);}

const selStyle={padding:"8px 10px",border:`1px solid ${C.line}`,borderRadius:7,background:"#fff",color:C.ink,fontSize:13};
function Ctrl({label,children}){return(<label style={{display:"block"}}>
  <span className="mono" style={{fontSize:10.5,color:C.sub,textTransform:"uppercase",display:"block",marginBottom:5}}>{label}</span>{children}</label>);}
function P({children,style}){return <p style={{color:C.sub,fontSize:13,...style}}>{children}</p>;}
function Big({label,value,color}){return(<div><div className="mono" style={{fontSize:10,color:C.sub,textTransform:"uppercase"}}>{label}</div>
  <div className="disp" style={{fontSize:23,fontWeight:600,color:color||C.ink,lineHeight:1.1}}>{value}</div></div>);}
function Row({k,v}){return(<div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"3px 0"}}>
  <span style={{color:C.sub}}>{k}</span><span className="mono">{v}</span></div>);}
function ChannelRow({k,v,c}){return(<div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"3px 0"}}>
  <span style={{color:C.sub}}>{k}</span><span className="mono" style={{color:c,fontWeight:600}}>{v}</span></div>);}
function Badge({c,children}){return <span className="mono" style={{fontSize:10.5,color:c,border:`1px solid ${c}`,borderRadius:5,padding:"2px 8px"}}>{children}</span>;}
