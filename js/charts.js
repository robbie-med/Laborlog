import { hoursBetween } from './utils.js';
import { referenceCurve } from './models.js';

let dilationChart = null;
let stationChart = null;

function toTimeZero(events){
  const first = events.length ? new Date(events[0].ts) : new Date();
  return events.map(e => ({...e, tHr: hoursBetween(first, e.ts)}));
}

function getMarkers(events){
  const meds = events.filter(e=>e.type==='med');
  const roms = events.filter(e=>e.type==='rom');
  const markers = [];

  for (const r of roms){
    markers.push({ ts:r.ts, label:'ROM', kind:'rom' });
  }
  for (const m of meds){
    const n = (m.data?.medName||'').toLowerCase();
    if (n === 'epidural') markers.push({ ts:m.ts, label:'Epidural', kind:'epi' });
    if (n === 'oxytocin') markers.push({ ts:m.ts, label:`Oxy ${m.data?.rate||''}`, kind:'oxy' });
  }
  return markers;
}

export function destroyCharts(){
  if (dilationChart){ dilationChart.destroy(); dilationChart = null; }
  if (stationChart){ stationChart.destroy(); stationChart = null; }
}

export function renderCharts(encounter, events, settings, overlayOpts){
  const ev = [...events].sort((a,b)=> new Date(a.ts)-new Date(b.ts));
  const t0 = ev.length ? new Date(ev[0].ts) : new Date();

  const sves = ev.filter(e=>e.type==='sve');
  const svesT = sves.map(s => ({...s, tHr: hoursBetween(t0, s.ts)}));

  const dilationData = svesT.map(s => ({ x:s.tHr, y:Number(s.data?.dilationCm) }));
  const stationData = svesT.map(s => ({ x:s.tHr, y:Number(s.data?.station) }));

  const markers = getMarkers(ev).map(m => ({...m, tHr: hoursBetween(t0, m.ts)}));

  const parity = encounter?.parity || 'nullip';
  const isInduction = !!(encounter?.isInduction);
  const epiduralPlanned = !!(encounter?.epiduralPlanned);

  const ov = overlayDatasets({
    durationHr: Math.max(6, Math.min(24, (svesT.at(-1)?.tHr || 8) + 6)),
    activeThreshold: Number(settings.activeThresholdCm || 6),
    overlayOpts,
    baseParity: parity,
    baseInduction: isInduction,
    baseEpidural: epiduralPlanned,
    svesT
  });

  // Dilation chart
  const ctx1 = document.getElementById('chartDilation');
  if (dilationChart) dilationChart.destroy();
  dilationChart = new Chart(ctx1, {
    type: 'scatter',
    data: {
      datasets: [
        ...ov.dilationOverlays,
        {
          label: 'Patient (true curve)',
          data: dilationData,
          showLine: true,
          tension: 0.2,
          pointRadius: 4
        },
        ...markerDatasets(markers, 'dilation')
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#e9eefc' } },
        tooltip: { callbacks: {
          label: (ctx) => {
            const x = ctx.parsed.x;
            const y = ctx.parsed.y;
            return `${ctx.dataset.label}: ${y?.toFixed?.(1) ?? y} @ +${x.toFixed(2)} hr`;
          }
        }}
      },
      scales: {
        x: { title: { display:true, text:'Hours since first event', color:'#aeb9d6' }, ticks:{ color:'#aeb9d6' }, grid:{ color:'rgba(34,48,82,.35)' } },
        y: { title: { display:true, text:'Dilation (cm)', color:'#aeb9d6' }, min:0, max:10, ticks:{ color:'#aeb9d6' }, grid:{ color:'rgba(34,48,82,.35)' } }
      }
    }
  });

  // Station chart
  const ctx2 = document.getElementById('chartStation');
  if (stationChart) stationChart.destroy();
  stationChart = new Chart(ctx2, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Patient (station)',
          data: stationData,
          showLine: true,
          tension: 0.2,
          pointRadius: 4
        },
        ...markerDatasets(markers, 'station')
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#e9eefc' } }
      },
      scales: {
        x: { title: { display:true, text:'Hours since first event', color:'#aeb9d6' }, ticks:{ color:'#aeb9d6' }, grid:{ color:'rgba(34,48,82,.35)' } },
        y: { title: { display:true, text:'Station', color:'#aeb9d6' }, min:-5, max:5, ticks:{ color:'#aeb9d6' }, grid:{ color:'rgba(34,48,82,.35)' } }
      }
    }
  });

  return true;
}

function overlayDatasets({durationHr, activeThreshold, overlayOpts, baseParity, baseInduction, baseEpidural}){
  const dilationOverlays = [];
  const mk = (label, parity, induction, epidural, op) => {
    const { pts } = referenceCurve({ parity, durationHr, activeThreshold, induction, epidural, op });
    return {
      label,
      data: pts.map(p => ({x:p.tHr, y:p.cm})),
      showLine: true,
      pointRadius: 0,
      borderDash: [6,6],
      borderWidth: 2
    };
  };

  const ind = overlayOpts.induction || baseInduction;
  const epi = overlayOpts.epidural || baseEpidural;
  const op = overlayOpts.op;

  if (overlayOpts.nullip){
    dilationOverlays.push(mk('Ref: Nullip', 'nullip', ind && overlayOpts.induction, epi && overlayOpts.epidural, op && overlayOpts.op));
  }
  if (overlayOpts.multip){
    dilationOverlays.push(mk('Ref: Multip', 'multip', ind && overlayOpts.induction, epi && overlayOpts.epidural, op && overlayOpts.op));
  }
  return { dilationOverlays };
}

function markerDatasets(markers, which){
  if (!markers.length) return [];
  // Put markers at y=0 for dilation and y=-5 for station, just to show timing
  const yVal = which === 'dilation' ? 0.2 : -4.8;
  return [{
    label: 'Markers',
    data: markers.map(m => ({x:m.tHr, y:yVal})),
    pointRadius: 5,
    showLine: false
  }];
}
