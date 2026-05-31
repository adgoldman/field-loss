import React, { useState } from "react";
import Estimator from "./FieldLossEstimator.jsx";
import MapView from "./FieldLossMap.jsx";
import County from "./FieldLossCounty.jsx";
import Forecast from "./FieldLossForecast.jsx";

const TABS = [
  ["Estimator", Estimator],
  ["National map", MapView],
  ["County slice", County],
  ["Rescue forecast", Forecast],
];

export default function App() {
  const [i, setI] = useState(0);
  const [countyInit, setCountyInit] = useState(null); // {state, crop} drilled from national map
  // One import-shock lever shared across every tab: the fractional change in fresh
  // imports being simulated (−1..+1). 0 = status quo. Lifted here so adjusting it
  // in any view (Estimator slider) flows through Map / County / Rescue forecast.
  const [importShock, setImportShock] = useState(0);

  function drillToCounty(state, crop) {
    setCountyInit({ state, crop, at: Date.now() });
    setI(2);
  }

  const View = TABS[i][1];
  const shock = { importShock, setImportShock };
  const viewProps =
    i === 1 ? { onDrill: drillToCounty, ...shock } :
    i === 2 ? { init: countyInit, ...shock } : shock;

  return (
    <div style={{ minHeight: "100vh", background: "#F4F1E8", fontFamily: "'Archivo', system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: 6, padding: "10px 16px", borderBottom: "1px solid #D9D3C2", position: "sticky", top: 0, background: "#F4F1E8", zIndex: 5 }}>
        {TABS.map((t, idx) => (
          <button key={t[0]} onClick={() => setI(idx)}
            style={{ padding: "8px 14px", border: "1px solid #D9D3C2", borderRadius: 7, cursor: "pointer", fontSize: 13,
              fontFamily: "'IBM Plex Mono', monospace", background: i === idx ? "#3A5A40" : "#fff", color: i === idx ? "#fff" : "#5C6B52" }}>
            {t[0]}
          </button>
        ))}
      </div>
      <View {...viewProps} />
    </div>
  );
}
