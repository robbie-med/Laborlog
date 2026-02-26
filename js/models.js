import { hoursBetween, clamp } from './utils.js';

/**
 * Settings: editable defaults
 */
export const DEFAULT_SETTINGS = {
  activeThresholdCm: 6.0,
  // Active dilation rate ranges (cm/hr)
  rates: {
    nullip: { low: 0.5, mid: 1.0, high: 1.5 },
    multip: { low: 1.0, mid: 1.5, high: 2.0 }
  },
  // Second stage duration ranges (hr)
  secondStage: {
    nullip_noEpi: { low: 0.5, mid: 1.0, high: 2.0 },
    nullip_epi:   { low: 1.0, mid: 1.5, high: 3.0 },
    multip_noEpi: { low: 0.25, mid: 0.5, high: 1.5 },
    multip_epi:   { low: 0.5, mid: 1.0, high: 2.0 }
  },
  // Adjusters (multipliers)
  adjusters: {
    induction: { rateMult: 0.9, widen: 1.15 },
    epidural:  { rateMult: 0.95, widen: 1.10 }, // active dilation modest effect; 2nd stage handled separately
    op:        { rateMult: 0.85, widen: 1.25 },
    oxytocin:  { rateMult: 1.05, widen: 1.05 }  // only if active infusion + recent titration
  }
};

/**
 * Reference curve generator (parameterized, not trained):
 * Creates a smooth-ish curve that accelerates after active threshold.
 * Output: [{tHr, cm}]
 */
export function referenceCurve({parity='nullip', durationHr=12, activeThreshold=6, induction=false, epidural=false, op=false}){
  // Baseline shape params
  const base = (parity === 'multip')
    ? { early: 0.45, late: 1.55 }   // cm/hr effective slope components
    : { early: 0.30, late: 1.05 };

  let late = base.late;
  let early = base.early;
  let widen = 1.0;
  if (induction) { late *= 0.95; early *= 0.95; widen *= 1.08; }
  if (epidural)  { late *= 0.98; widen *= 1.05; }
  if (op)        { late *= 0.88; widen *= 1.18; }

  // Logistic-ish transition around active threshold
  const pts = [];
  for (let i=0;i<=durationHr*12;i++){ // 5-min steps
    const t = i/12;
    // transition factor 0..1
    const k = 1.15;
    const x0 = durationHr * 0.45; // nominal inflection
    const f = 1/(1+Math.exp(-k*(t-x0))); // logistic
    // build cm as integrated slope approximation
    const slope = early*(1-f) + late*f;
    const cm = clamp(0.8 + slope*t, 0, 10);
    pts.push({tHr:t, cm});
  }
  // Force monotone nondecreasing
  for (let i=1;i<pts.length;i++){
    if (pts[i].cm < pts[i-1].cm) pts[i].cm = pts[i-1].cm;
  }
  return { pts, widen };
}

function getLatest(events, type){
  const e = events.filter(x=>x.type===type);
  return e.length ? e[e.length-1] : null;
}

function getSVEs(events){
  return events.filter(e=>e.type==='sve').sort((a,b)=> new Date(a.ts)-new Date(b.ts));
}

function getMedFlags(events){
  const meds = events.filter(e=>e.type==='med');
  let epidural = false;
  let induction = false;
  let op = false;
  let activeOxyRecent = false;

  // epidural if any medName === 'epidural'
  epidural = meds.some(m => (m.data?.medName || '').toLowerCase() === 'epidural');

  // induction if encounter has iol flag in meta stored elsewhere; here infer if prostaglandin present
  induction = meds.some(m => ['miso','misoprostol','cervidil','dinoprostone','cook','foley'].includes((m.data?.medName||'').toLowerCase()));

  // oxytocin "recent titration": any oxytocin event in last 90 minutes
  const now = new Date();
  const oxyEvents = meds.filter(m => (m.data?.medName || '').toLowerCase() === 'oxytocin');
  if (oxyEvents.length){
    const last = oxyEvents[oxyEvents.length-1];
    const dtMin = (now.getTime() - new Date(last.ts).getTime())/60000;
    if (dtMin <= 90) activeOxyRecent = true;
  }

  // OP flag if any SVE has position OP/OT
  const sves = getSVEs(events);
  op = sves.some(s => ['op','ot'].includes(String(s.data?.position||'').toLowerCase()));

  return { epidural, induction, op, activeOxyRecent };
}

/**
 * Deterministic predictor:
 * - phase: latent (<activeThreshold), active (>=threshold and <10), second stage (10cm)
 * - returns ETA distributions for 10cm and delivery
 */
export function predictETA(encounter, events, settings=DEFAULT_SETTINGS){
  const sves = getSVEs(events);
  const latestSVE = sves.length ? sves[sves.length-1] : null;

  const flags = getMedFlags(events);
  const activeThreshold = Number(settings.activeThresholdCm || 6);

  const parity = (encounter?.parity || 'nullip'); // 'nullip' | 'multip'
  const epidural = !!(encounter?.epiduralPlanned || flags.epidural);
  const induction = !!(encounter?.isInduction || flags.induction);
  const op = !!flags.op;
  const oxyRecent = !!flags.activeOxyRecent;

  const explain = [];

  if (!latestSVE){
    return {
      phase: 'no-data',
      now: new Date().toISOString(),
      eta10: null,
      etadelivery: null,
      probs: null,
      explain: ['No SVE entered yet. Add at least one cervical exam.'],
      flags: { epidural, induction, op, oxyRecent }
    };
  }

  const cm = Number(latestSVE.data?.dilationCm ?? NaN);
  const ts = latestSVE.ts;

  // Estimate recent dilation velocity using last 2 SVEs (or fallback)
  let vel = null;
  if (sves.length >= 2){
    const a = sves[sves.length-2];
    const b = sves[sves.length-1];
    const dcm = Number(b.data?.dilationCm) - Number(a.data?.dilationCm);
    const dt = Math.max(0.25, hoursBetween(a.ts, b.ts)); // guard
    vel = dcm / dt;
  }

  let phase = 'latent';
  if (cm >= 10) phase = 'second';
  else if (cm >= activeThreshold) phase = 'active';

  const baseRates = settings.rates[parity];
  let low = baseRates.low, mid = baseRates.mid, high = baseRates.high;
  let widen = 1.0;

  // Apply adjusters (rate multipliers and widening)
  if (induction){ low*=settings.adjusters.induction.rateMult; mid*=settings.adjusters.induction.rateMult; high*=settings.adjusters.induction.rateMult; widen*=settings.adjusters.induction.widen; explain.push('Induction adjustment applied'); }
  if (op){ low*=settings.adjusters.op.rateMult; mid*=settings.adjusters.op.rateMult; high*=settings.adjusters.op.rateMult; widen*=settings.adjusters.op.widen; explain.push('OP/OT adjustment applied'); }
  if (epidural){ low*=settings.adjusters.epidural.rateMult; mid*=settings.adjusters.epidural.rateMult; high*=settings.adjusters.epidural.rateMult; widen*=settings.adjusters.epidural.widen; explain.push('Epidural adjustment applied'); }
  if (oxyRecent){ low*=settings.adjusters.oxytocin.rateMult; mid*=settings.adjusters.oxytocin.rateMult; high*=settings.adjusters.oxytocin.rateMult; widen*=settings.adjusters.oxytocin.widen; explain.push('Recent oxytocin titration adjustment applied'); }

  // If observed velocity is available and sensible, blend toward it (still keep wide priors)
  if (vel !== null && Number.isFinite(vel)){
    explain.push(`Recent dilation slope: ${vel.toFixed(2)} cm/hr`);
    if (vel > 0.1 && vel < 4.0){
      const blend = 0.35;
      mid = mid*(1-blend) + vel*blend;
      low = Math.min(low, mid*0.7);
      high = Math.max(high, mid*1.3);
    }
  } else {
    explain.push('Recent dilation slope: insufficient data');
  }

  // widen uncertainty
  low = low / widen;
  high = high * widen;

  const remainingTo10 = Math.max(0, 10 - cm);
  const remainingToActive = Math.max(0, activeThreshold - cm);

  // latent: use a conservative latent-to-active time, then active rate
  let eta10_hr_low, eta10_hr_mid, eta10_hr_high;

  if (phase === 'latent'){
    // crude latent duration heuristic: 2–8 hr to reach active depending on parity and cm
    const latentBase = (parity === 'multip') ? { low:1.5, mid:3.0, high:6.0 } : { low:2.5, mid:4.5, high:8.0 };
    // closer to threshold => shorten
    const closeness = clamp((activeThreshold - cm)/activeThreshold, 0, 1); // 0 near threshold, 1 very early
    const latentAdj = 0.6 + 0.6*closeness; // 0.6..1.2
    const tLatLow = latentBase.low*latentAdj;
    const tLatMid = latentBase.mid*latentAdj;
    const tLatHigh = latentBase.high*latentAdj;

    const activeRemaining = Math.max(0, 10 - activeThreshold);
    const tActLow = activeRemaining / Math.max(0.15, high);
    const tActMid = activeRemaining / Math.max(0.15, mid);
    const tActHigh = activeRemaining / Math.max(0.15, low);

    eta10_hr_low = tLatLow + tActLow;
    eta10_hr_mid = tLatMid + tActMid;
    eta10_hr_high = tLatHigh + tActHigh;

    explain.push(`Phase: latent (<${activeThreshold} cm)`);
  } else if (phase === 'active'){
    eta10_hr_low = remainingTo10 / Math.max(0.15, high);
    eta10_hr_mid = remainingTo10 / Math.max(0.15, mid);
    eta10_hr_high = remainingTo10 / Math.max(0.15, low);
    explain.push(`Phase: active (≥${activeThreshold} cm)`);
  } else { // second stage already
    eta10_hr_low = 0; eta10_hr_mid=0; eta10_hr_high=0;
    explain.push('Phase: second stage (10 cm)');
  }

  // Second stage expectations (hr)
  const key = `${parity}_${epidural ? 'epi' : 'noEpi'}`.replace('noEpi','noEpi');
  const ss = epidural
    ? (parity==='multip' ? settings.secondStage.multip_epi : settings.secondStage.nullip_epi)
    : (parity==='multip' ? settings.secondStage.multip_noEpi : settings.secondStage.nullip_noEpi);

  // Total to delivery
  let etad_hr_low, etad_hr_mid, etad_hr_high;
  if (phase !== 'second'){
    etad_hr_low = eta10_hr_low + ss.low;
    etad_hr_mid = eta10_hr_mid + ss.mid;
    etad_hr_high = eta10_hr_high + ss.high;
  } else {
    // if already 10cm, estimate remaining second stage
    etad_hr_low = ss.low; etad_hr_mid = ss.mid; etad_hr_high = ss.high;
  }

  // quick probability by time using triangular-ish approximation around mid with low/high bounds
  const probs = calcProbs(etad_hr_low, etad_hr_mid, etad_hr_high);

  return {
    phase,
    now: new Date().toISOString(),
    basedOnTs: ts,
    eta10: { lowHr: eta10_hr_low, midHr: eta10_hr_mid, highHr: eta10_hr_high },
    etadelivery: { lowHr: etad_hr_low, midHr: etad_hr_mid, highHr: etad_hr_high },
    probs, // by 2/4/8 hr
    explain,
    flags: { epidural, induction, op, oxyRecent }
  };
}

function calcProbs(low, mid, high){
  // Map time horizon -> probability using a simple piecewise-linear CDF
  const cdf = (t) => {
    if (t <= low) return 0.05;
    if (t >= high) return 0.95;
    if (t <= mid) {
      return 0.05 + 0.45 * (t - low) / Math.max(1e-6, (mid - low)); // 0.05..0.5
    }
    return 0.5 + 0.45 * (t - mid) / Math.max(1e-6, (high - mid)); // 0.5..0.95
  };

  return {
    by2: clamp(cdf(2),0,1),
    by4: clamp(cdf(4),0,1),
    by8: clamp(cdf(8),0,1)
  };
}
