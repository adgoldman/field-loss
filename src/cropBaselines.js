/*
  Crop acreage baselines — SINGLE SOURCE OF TRUTH
  ------------------------------------------------
  National planted/harvested acreage per crop and each state's approximate share
  of US production. These drive the crop+state ESTIMATE used as a fallback ONLY
  when live USDA NASS acreage is unavailable, so the National map, County slice,
  and Estimator all derive the same number from the same logic (no drift).

  Figures are illustrative USDA-scale approximations meant to be calibrated, and
  are always labeled as an estimate in the UI when used.
*/

// National acreage per crop (lowercase crop key used across the app).
export const NAT_ACRES = {
  potatoes: 920_000,
  tomatoes: 95_000,
  lettuce: 250_000,
  apples: 290_000,
  strawberries: 52_000,
};

// Each state's approximate share of US production (sum ≈ 1; unlisted states ≈ 0).
export const STATE_SHARES = {
  potatoes: { ID:.31, WA:.145, WI:.065, ND:.065, CO:.05, OR:.045, MN:.045, MI:.045, ME:.04, CA:.035, NE:.03, TX:.02 },
  tomatoes: { CA:.42, FL:.30, IN:.05, OH:.04, MI:.03, TN:.03, VA:.025, NC:.02, NJ:.02, PA:.02, GA:.015 },
  lettuce: { CA:.70, AZ:.25, FL:.02, NJ:.006, NY:.006, CO:.005, WA:.005, MI:.003 },
  apples: { WA:.55, NY:.12, MI:.10, PA:.045, CA:.045, VA:.025, OR:.02, NC:.015, OH:.01 },
  strawberries: { CA:.87, FL:.085, OR:.01, NC:.008, NY:.005, WA:.005, MI:.004, PA:.003 },
};

// Crop+state planted-acres estimate = national acreage × that state's share.
// Returns null when there is no logical basis (unknown crop) so callers can show
// NO value rather than a fabricated one. For a known crop in a state with no
// listed share, returns 0 (negligible commercial production), which is a
// defensible figure, not a guess.
export function estimateStateAcres(crop, state) {
  const nat = NAT_ACRES[crop];
  if (nat == null) return null;
  const share = (STATE_SHARES[crop] || {})[state] || 0;
  return Math.round(nat * share);
}
