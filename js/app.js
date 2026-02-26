import {
  dbListEncounters, dbGetEncounter, dbPutEncounter, dbDeleteEncounter,
  dbListEvents, dbPutEvent, dbDeleteEvent,
  dbDumpAll, dbImportAll,
  dbGetSettings, dbPutSettings
} from './db.js';

import { uid, fmtDateTime, fmtDate, downloadText, readFileAsText, safeNum, clamp } from './utils.js';
import { DEFAULT_SETTINGS, predictETA } from './models.js';
import { renderCharts, destroyCharts } from './charts.js';

/* -------------------- PWA install -------------------- */
let deferredPrompt = null;
const btnInstall = document.getElementById('btnInstall');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  btnInstall.classList.remove('hidden');
});

btnInstall.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  btnInstall.classList.add('hidden');
});

/* -------------------- SW register -------------------- */
if ('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js');
}

/* -------------------- State -------------------- */
let SETTINGS = DEFAULT_SETTINGS;
let encounters = [];
let selectedEncId = null;
let selectedEvents = [];

let overlayOpts = {
  nullip: true,
  multip: false,
  induction: false,
  epidural: false,
  op: false
};

/* -------------------- DOM refs -------------------- */
const encList = document.getElementById('encList');
const encSearch = document.getElementById('encSearch');
const encFilter = document.getElementById('encFilter');

const emptyState = document.getElementById('emptyState');
const encView = document.getElementById('encView');
const encTitle = document.getElementById('encTitle');
const encMeta = document.getElementById('encMeta');

const eventList = document.getElementById('eventList');
const quickStats = document.getElementById('quickStats');
const encNotes = document.getElementById('encNotes');
const encTags = document.getElementById('encTags');
const btnSaveEncMeta = document.getElementById('btnSaveEncMeta');

const btnNewEncounter = document.getElementById('btnNewEncounter');
const btnNewEncounter2 = document.getElementById('btnNewEncounter2');
const btnAddSVE = document.getElementById('btnAddSVE');
const btnAddMed = document.getElementById('btnAddMed');
const btnAddROM = document.getElementById('btnAddROM');
const btnAddVitals = document.getElementById('btnAddVitals');
const btnAddFetal = document.getElementById('btnAddFetal');
const btnOutcome = document.getElementById('btnOutcome');
const btnDeleteEnc = document.getElementById('btnDeleteEnc');
const btnExportEnc = document.getElementById('btnExportEnc');

const btnExportAll = document.getElementById('btnExportAll');
const fileImportAll = document.getElementById('fileImportAll');
const btnSettings = document.getElementById('btnSettings');

const ovNullip = document.getElementById('ovNullip');
const ovMultip = document.getElementById('ovMultip');
const ovInduction = document.getElementById('ovInduction');
const ovEpidural = document.getElementById('ovEpidural');
const ovOP = document.getElementById('ovOP');

const predictNow = document.getElementById('predictNow');
const predictExplain = document.getElementById('predictExplain');
const phaseFlags = document.getElementById('phaseFlags');

const replayAt = document.getElementById('replayAt');
const btnReplay = document.getElementById('btnReplay');
const replayCard = document.getElementById('replayCard');

const summaryText = document.getElementById('summaryText');
const btnCopySummary = document.getElementById('btnCopySummary');

/* -------------------- Tabs -------------------- */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tabpane').forEach(p=>p.classList.add('hidden'));
    document.getElementById(`tab-${tab}`).classList.remove('hidden');

    if (tab === 'curves') refreshCharts();
    if (tab === 'predict') refreshPredict();
    if (tab === 'summary') refreshSummary();
  });
});

/* -------------------- Modal system -------------------- */
const modalBackdrop = document.getElementById('modalBackdrop');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalClose = document.getElementById('modalClose');
const modalCancel = document.getElementById('modalCancel');
const modalOk = document.getElementById('modalOk');

let modalResolve = null;
let modalOnOk = null;

function openModal(title, bodyHtml, { okText='Save', cancelText='Cancel', onOk=null } = {}){
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalOk.textContent = okText;
  modalCancel.textContent = cancelText;
  modalOnOk = onOk;

  modalBackdrop.classList.remove('hidden');
  modal.classList.remove('hidden');
  return new Promise((resolve) => { modalResolve = resolve; });
}

function closeModal(result=null){
  modalBackdrop.classList.add('hidden');
  modal.classList.add('hidden');
  modalBody.innerHTML = '';
  const r = modalResolve;
  modalResolve = null;
  modalOnOk = null;
  if (r) r(result);
}

modalClose.addEventListener('click', () => closeModal(null));
modalCancel.addEventListener('click', () => closeModal(null));
modalBackdrop.addEventListener('click', () => closeModal(null));

modalOk.addEventListener('click', async () => {
  if (modalOnOk){
    const out = await modalOnOk();
    if (out !== false) closeModal(out ?? true);
  } else {
    closeModal(true);
  }
});

/* -------------------- Boot -------------------- */
(async function init(){
  const stored = await dbGetSettings();
  SETTINGS = stored ? { ...DEFAULT_SETTINGS, ...stored } : DEFAULT_SETTINGS;
  await loadEncounters();
  bindHandlers();
  renderEncounterList();
})();

function bindHandlers(){
  encSearch.addEventListener('input', renderEncounterList);
  encFilter.addEventListener('change', renderEncounterList);

  btnNewEncounter.addEventListener('click', newEncounterFlow);
  btnNewEncounter2.addEventListener('click', newEncounterFlow);

  btnAddSVE.addEventListener('click', () => addEventFlow('sve'));
  btnAddMed.addEventListener('click', () => addEventFlow('med'));
  btnAddROM.addEventListener('click', () => addEventFlow('rom'));
  btnAddVitals.addEventListener('click', () => addEventFlow('vitals'));
  btnAddFetal.addEventListener('click', () => addEventFlow('fetal'));
  btnOutcome.addEventListener('click', outcomeFlow);

  btnSaveEncMeta.addEventListener('click', saveEncounterMeta);

  btnDeleteEnc.addEventListener('click', deleteSelectedEncounter);
  btnExportEnc.addEventListener('click', exportSelectedEncounter);

  btnExportAll.addEventListener('click', exportAll);
  fileImportAll.addEventListener('change', importAll);

  btnSettings.addEventListener('click', settingsFlow);

  ovNullip.addEventListener('change', () => { overlayOpts.nullip = ovNullip.checked; refreshCharts(); });
  ovMultip.addEventListener('change', () => { overlayOpts.multip = ovMultip.checked; refreshCharts(); });
  ovInduction.addEventListener('change', () => { overlayOpts.induction = ovInduction.checked; refreshCharts(); });
  ovEpidural.addEventListener('change', () => { overlayOpts.epidural = ovEpidural.checked; refreshCharts(); });
  ovOP.addEventListener('change', () => { overlayOpts.op = ovOP.checked; refreshCharts(); });

  btnReplay.addEventListener('click', refreshReplay);

  btnCopySummary.addEventListener('click', async () => {
    const txt = summaryText.textContent || '';
    await navigator.clipboard.writeText(txt);
  });
}

async function loadEncounters(){
  encounters = await dbListEncounters();
  encounters.sort((a,b)=> new Date(b.updatedAt) - new Date(a.updatedAt));
}

/* -------------------- Encounters UI -------------------- */
function renderEncounterList(){
  const q = (encSearch.value || '').trim().toLowerCase();
  const f = encFilter.value;

  const filtered = encounters.filter(e => {
    if (f === 'open' && e.status !== 'open') return false;
    if (f === 'delivered' && e.status !== 'delivered') return false;
    if (f === 'cs' && e.status !== 'cs') return false;

    if (!q) return true;
    const hay = `${e.tags||''} ${e.notes||''} ${e.title||''}`.toLowerCase();
    return hay.includes(q);
  });

  encList.innerHTML = '';
  for (const e of filtered){
    const div = document.createElement('div');
    div.className = `card ${e.id === selectedEncId ? 'selected' : ''}`;
    div.innerHTML = `
      <div class="row">
        <div>
          <div><strong>${escapeHtml(e.title || 'Encounter')}</strong></div>
          <div class="small">${fmtDate(new Date(e.startedAt), true)} • ${escapeHtml(e.parity)} • ${escapeHtml(e.isInduction ? 'IOL' : 'Spont')} • ${escapeHtml(e.gaWeeks ? `${e.gaWeeks}w` : '')}</div>
        </div>
        <div class="badge ${badgeClass(e.status)}">${escapeHtml(e.status)}</div>
      </div>
      <div class="small" style="margin-top:6px;">${escapeHtml((e.tags||'').slice(0,80))}</div>
    `;
    div.addEventListener('click', () => selectEncounter(e.id));
    encList.appendChild(div);
  }
}

function badgeClass(status){
  if (status === 'open') return 'warn';
  if (status === 'delivered') return 'ok';
  if (status === 'cs') return 'danger';
  return '';
}

async function selectEncounter(id){
  selectedEncId = id;
  await refreshSelected();
  renderEncounterList();
}

/* -------------------- Selected encounter view -------------------- */
async function refreshSelected(){
  if (!selectedEncId){
    emptyState.classList.remove('hidden');
    encView.classList.add('hidden');
    destroyCharts();
    return;
  }
  const enc = await dbGetEncounter(selectedEncId);
  selectedEvents = await dbListEvents(selectedEncId);

  emptyState.classList.add('hidden');
  encView.classList.remove('hidden');

  encTitle.textContent = enc.title || 'Encounter';
  encMeta.textContent =
    `${fmtDateTime(enc.startedAt)} • ${enc.parity} • ${enc.isInduction ? 'Induction' : 'Spontaneous'} • GA ${enc.gaWeeks || '?'}w` +
    (enc.epiduralPlanned ? ' • epidural' : '');

  encNotes.value = enc.notes || '';
  encTags.value = enc.tags || '';

  renderEventList(selectedEvents);
  renderQuickStats(enc, selectedEvents);
  refreshReplayOptions();
}

function renderEventList(events){
  eventList.innerHTML = '';
  if (!events.length){
    eventList.innerHTML = `<div class="small">No events yet. Add an SVE to start.</div>`;
    return;
  }
  for (const ev of events){
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="row">
        <div>
          <div><strong>${labelForEvent(ev)}</strong></div>
          <div class="small">${fmtDateTime(ev.ts)} • ${ev.type.toUpperCase()}</div>
        </div>
        <div class="row">
          <button class="btn secondary" data-edit="${ev.id}">Edit</button>
          <button class="btn danger" data-del="${ev.id}">Del</button>
        </div>
      </div>
      ${ev.data?.note ? `<div class="small" style="margin-top:6px;">${escapeHtml(ev.data.note)}</div>` : ''}
    `;
    div.querySelector('[data-del]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await dbDeleteEvent(ev.id);
      await touchEncounter();
      await refreshSelected();
      if (activeTab() === 'curves') refreshCharts();
      if (activeTab() === 'predict') refreshPredict();
    });
    div.querySelector('[data-edit]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await editEventFlow(ev);
    });
    eventList.appendChild(div);
  }
}

function labelForEvent(ev){
  const d = ev.data || {};
  if (ev.type === 'sve'){
    const pos = d.position ? ` ${String(d.position).toUpperCase()}` : '';
    return `SVE: ${d.dilationCm} cm / ${d.effacementPct ?? '?'}% / ${d.station ?? '?'}${pos}`;
  }
  if (ev.type === 'rom') return `ROM: ${d.fluid || 'unknown'}${d.meconium ? ' (meconium)' : ''}`;
  if (ev.type === 'med'){
    const n = (d.medName || 'med').toUpperCase();
    const rate = d.rate ? ` • ${d.rate}` : '';
    return `${n}${rate}`;
  }
  if (ev.type === 'vitals'){
    const t = d.tempC != null ? `${d.tempC}°C` : '';
    const hr = d.hr != null ? `HR ${d.hr}` : '';
    const bp = (d.sbp != null && d.dbp != null) ? `BP ${d.sbp}/${d.dbp}` : '';
    return `Vitals: ${[t,hr,bp].filter(Boolean).join(' • ') || 'entry'}`;
  }
  if (ev.type === 'fetal'){
    const cat = d.category ? `Cat ${d.category}` : 'Fetal';
    const dec = d.recurrentDecels ? ' • recurrent decels' : '';
    return `${cat}${dec}`;
  }
  return ev.type;
}

function renderQuickStats(enc, events){
  const sves = events.filter(e=>e.type==='sve');
  const latest = sves.length ? sves[sves.length-1] : null;
  const rom = events.filter(e=>e.type==='rom').at(-1) || null;
  const epi = events.filter(e=>e.type==='med' && (e.data?.medName||'').toLowerCase()==='epidural').at(-1) || null;

  const kpis = [];
  kpis.push(kpi('Status', enc.status));
  if (latest){
    kpis.push(kpi('Latest SVE', `${latest.data.dilationCm} cm / ${latest.data.effacementPct ?? '?'}% / ${latest.data.station ?? '?'}`));
    if (latest.data.position) kpis.push(kpi('Position', String(latest.data.position).toUpperCase()));
  } else {
    kpis.push(kpi('Latest SVE', '—'));
  }
  if (rom) kpis.push(kpi('ROM', `${fmtDateTime(rom.ts)} • ${rom.data?.fluid||'?'}`));
  if (epi) kpis.push(kpi('Epidural', fmtDateTime(epi.ts)));

  quickStats.innerHTML = kpis.join('');
}

function kpi(label, value, sub=''){
  return `
    <div class="kpi">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(String(value ?? '—'))}</div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
    </div>
  `;
}

async function touchEncounter(){
  const enc = await dbGetEncounter(selectedEncId);
  enc.updatedAt = new Date().toISOString();
  await dbPutEncounter(enc);
  await loadEncounters();
}

/* -------------------- Encounter creation/edit -------------------- */
async function newEncounterFlow(){
  const nowISO = new Date().toISOString();
  const body = `
    <div class="grid">
      <div>
        <label class="small">Title</label>
        <input id="fTitle" class="input" placeholder="e.g., G1 39w IOL OP" />
      </div>
      <div>
        <label class="small">Started</label>
        <input id="fStart" class="input" type="datetime-local" value="${toLocalInput(nowISO)}" />
      </div>
      <div>
        <label class="small">Parity</label>
        <select id="fParity" class="select">
          <option value="nullip">nullip</option>
          <option value="multip">multip</option>
        </select>
      </div>
      <div>
        <label class="small">GA (weeks)</label>
        <input id="fGA" class="input" type="number" min="20" max="45" step="0.1" placeholder="e.g., 39.4" />
      </div>
      <div>
        <label class="small">Induction?</label>
        <select id="fIOL" class="select">
          <option value="false">No (spontaneous)</option>
          <option value="true">Yes (induction)</option>
        </select>
      </div>
      <div>
        <label class="small">Epidural planned?</label>
        <select id="fEpi" class="select">
          <option value="false">No/unknown</option>
          <option value="true">Yes</option>
        </select>
      </div>
      <div style="grid-column:1/-1;">
        <label class="small">Tags (comma separated)</label>
        <input id="fTags" class="input" placeholder="IOL, OP, GBS+, etc (avoid PHI)" />
      </div>
    </div>
    <div class="hr"></div>
    <div class="small">This app is for intuition training. Avoid patient identifiers.</div>
  `;

  const ok = await openModal('New encounter', body, {
    okText: 'Create',
    onOk: async () => {
      const title = document.getElementById('fTitle').value.trim() || 'Encounter';
      const startedAt = fromLocalInput(document.getElementById('fStart').value);
      const parity = document.getElementById('fParity').value;
      const gaWeeks = safeNum(document.getElementById('fGA').value, null);
      const isInduction = document.getElementById('fIOL').value === 'true';
      const epiduralPlanned = document.getElementById('fEpi').value === 'true';
      const tags = document.getElementById('fTags').value.trim();

      const enc = {
        id: uid('enc'),
        title,
        startedAt,
        updatedAt: new Date().toISOString(),
        parity,
        gaWeeks,
        isInduction,
        epiduralPlanned,
        status: 'open', // open | delivered | cs
        outcomeAt: null,
        outcomeMode: null, // vaginal | cs
        outcomeNote: '',
        tags,
        notes: ''
      };
      await dbPutEncounter(enc);
      await loadEncounters();
      selectedEncId = enc.id;
      await refreshSelected();
      renderEncounterList();
      return true;
    }
  });

  return ok;
}

async function saveEncounterMeta(){
  const enc = await dbGetEncounter(selectedEncId);
  enc.notes = encNotes.value;
  enc.tags = encTags.value;
  enc.updatedAt = new Date().toISOString();
  await dbPutEncounter(enc);
  await loadEncounters();
  renderEncounterList();
}

/* -------------------- Events: add/edit -------------------- */
async function addEventFlow(type){
  if (!selectedEncId) return;

  const nowISO = new Date().toISOString();
  const title = ({
    sve:'Add SVE',
    med:'Add medication',
    rom:'Add ROM',
    vitals:'Add vitals',
    fetal:'Add fetal status'
  })[type] || 'Add event';

  const body = eventFormHtml(type, nowISO, {});
  await openModal(title, body, {
    okText:'Save',
    onOk: async () => {
      const evt = readEventForm(type, null);
      if (!evt) return false;
      await dbPutEvent(evt);
      await touchEncounter();
      await refreshSelected();
      if (activeTab() === 'curves') refreshCharts();
      if (activeTab() === 'predict') refreshPredict();
      return true;
    }
  });
}

async function editEventFlow(ev){
  const title = `Edit ${ev.type.toUpperCase()}`;
  const body = eventFormHtml(ev.type, ev.ts, ev.data || {});
  await openModal(title, body, {
    okText:'Save',
    onOk: async () => {
      const evt = readEventForm(ev.type, ev.id);
      if (!evt) return false;
      await dbPutEvent(evt);
      await touchEncounter();
      await refreshSelected();
      if (activeTab() === 'curves') refreshCharts();
      if (activeTab() === 'predict') refreshPredict();
      return true;
    }
  });
}

function eventFormHtml(type, tsISO, data){
  const tsVal = toLocalInput(tsISO);
  if (type === 'sve'){
    return `
      <div class="grid">
        <div style="grid-column:1/-1;">
          <label class="small">Time</label>
          <input id="fTs" class="input" type="datetime-local" value="${tsVal}" />
        </div>
        <div>
          <label class="small">Dilation (cm)</label>
          <input id="fDil" class="input" type="number" min="0" max="10" step="0.5" value="${escVal(data.dilationCm)}" />
        </div>
        <div>
          <label class="small">Effacement (%)</label>
          <input id="fEff" class="input" type="number" min="0" max="100" step="5" value="${escVal(data.effacementPct)}" />
        </div>
        <div>
          <label class="small">Station (-5..+5)</label>
          <input id="fSta" class="input" type="number" min="-5" max="5" step="1" value="${escVal(data.station)}" />
        </div>
        <div>
          <label class="small">Position (OA/OP/OT)</label>
          <select id="fPos" class="select">
            <option value="" ${sel(data.position,'')}>unknown</option>
            <option value="oa" ${sel(data.position,'oa')}>OA</option>
            <option value="op" ${sel(data.position,'op')}>OP</option>
            <option value="ot" ${sel(data.position,'ot')}>OT</option>
          </select>
        </div>
        <div>
          <label class="small">Caput (0-3)</label>
          <input id="fCap" class="input" type="number" min="0" max="3" step="1" value="${escVal(data.caput)}" />
        </div>
        <div>
          <label class="small">Molding (0-3)</label>
          <input id="fMol" class="input" type="number" min="0" max="3" step="1" value="${escVal(data.molding)}" />
        </div>
        <div style="grid-column:1/-1;">
          <label class="small">Note</label>
          <input id="fNote" class="input" value="${escVal(data.note)}" placeholder="optional" />
        </div>
      </div>
    `;
  }
  if (type === 'rom'){
    return `
      <div class="grid">
        <div style="grid-column:1/-1;">
          <label class="small">Time</label>
          <input id="fTs" class="input" type="datetime-local" value="${tsVal}" />
        </div>
        <div>
          <label class="small">Fluid</label>
          <select id="fFluid" class="select">
            <option value="clear" ${sel(data.fluid,'clear')}>clear</option>
            <option value="blood" ${sel(data.fluid,'blood')}>blood-tinged</option>
            <option value="meconium" ${sel(data.fluid,'meconium')}>meconium</option>
            <option value="unknown" ${sel(data.fluid,'unknown')}>unknown</option>
          </select>
        </div>
        <div>
          <label class="small">Meconium?</label>
          <select id="fMeconium" class="select">
            <option value="false" ${sel(String(data.meconium),'false')}>No</option>
            <option value="true" ${sel(String(data.meconium),'true')}>Yes</option>
          </select>
        </div>
        <div style="grid-column:1/-1;">
          <label class="small">Note</label>
          <input id="fNote" class="input" value="${escVal(data.note)}" placeholder="optional" />
        </div>
      </div>
    `;
  }
  if (type === 'med'){
    return `
      <div class="grid">
        <div style="grid-column:1/-1;">
          <label class="small">Time</label>
          <input id="fTs" class="input" type="datetime-local" value="${tsVal}" />
        </div>
        <div>
          <label class="small">Medication</label>
          <select id="fMedName" class="select">
            <option value="oxytocin" ${sel(data.medName,'oxytocin')}>oxytocin</option>
            <option value="epidural" ${sel(data.medName,'epidural')}>epidural</option>
            <option value="miso" ${sel(data.medName,'miso')}>miso</option>
            <option value="cervidil" ${sel(data.medName,'cervidil')}>cervidil</option>
            <option value="dinoprostone" ${sel(data.medName,'dinoprostone')}>dinoprostone</option>
            <option value="foley" ${sel(data.medName,'foley')}>foley/cook</option>
            <option value="magnesium" ${sel(data.medName,'magnesium')}>magnesium</option>
            <option value="antibiotics" ${sel(data.medName,'antibiotics')}>antibiotics</option>
            <option value="other" ${sel(data.medName,'other')}>other</option>
          </select>
        </div>
        <div>
          <label class="small">Rate / Dose</label>
          <input id="fRate" class="input" value="${escVal(data.rate)}" placeholder="e.g., 10 mU/min" />
        </div>
        <div style="grid-column:1/-1;">
          <label class="small">Note</label>
          <input id="fNote" class="input" value="${escVal(data.note)}" placeholder="optional" />
        </div>
      </div>
    `;
  }
  if (type === 'vitals'){
    return `
      <div class="grid">
        <div style="grid-column:1/-1;">
          <label class="small">Time</label>
          <input id="fTs" class="input" type="datetime-local" value="${tsVal}" />
        </div>
        <div>
          <label class="small">Temp (°C)</label>
          <input id="fTemp" class="input" type="number" min="30" max="43" step="0.1" value="${escVal(data.tempC)}" />
        </div>
        <div>
          <label class="small">HR</label>
          <input id="fHR" class="input" type="number" min="20" max="220" step="1" value="${escVal(data.hr)}" />
        </div>
        <div>
          <label class="small">SBP</label>
          <input id="fSBP" class="input" type="number" min="50" max="250" step="1" value="${escVal(data.sbp)}" />
        </div>
        <div>
          <label class="small">DBP</label>
          <input id="fDBP" class="input" type="number" min="20" max="160" step="1" value="${escVal(data.dbp)}" />
        </div>
        <div style="grid-column:1/-1;">
          <label class="small">Note</label>
          <input id="fNote" class="input" value="${escVal(data.note)}" placeholder="optional" />
        </div>
      </div>
    `;
  }
  if (type === 'fetal'){
    return `
      <div class="grid">
        <div style="grid-column:1/-1;">
          <label class="small">Time</label>
          <input id="fTs" class="input" type="datetime-local" value="${tsVal}" />
        </div>
        <div>
          <label class="small">Category</label>
          <select id="fCat" class="select">
            <option value="" ${sel(data.category,'')}>unknown</option>
            <option value="I" ${sel(data.category,'I')}>I</option>
            <option value="II" ${sel(data.category,'II')}>II</option>
            <option value="III" ${sel(data.category,'III')}>III</option>
          </select>
        </div>
        <div>
          <label class="small">Recurrent decels?</label>
          <select id="fDec" class="select">
            <option value="false" ${sel(String(data.recurrentDecels),'false')}>No</option>
            <option value="true" ${sel(String(data.recurrentDecels),'true')}>Yes</option>
          </select>
        </div>
        <div style="grid-column:1/-1;">
          <label class="small">Note</label>
          <input id="fNote" class="input" value="${escVal(data.note)}" placeholder="optional" />
        </div>
      </div>
    `;
  }
  return `<div class="small">Unknown event type</div>`;
}

function readEventForm(type, existingId){
  const ts = fromLocalInput(document.getElementById('fTs').value);
  if (!ts) return null;

  let data = {};
  if (type === 'sve'){
    const dilationCm = safeNum(document.getElementById('fDil').value, null);
    if (dilationCm == null) return null;
    data = {
      dilationCm,
      effacementPct: safeNum(document.getElementById('fEff').value, null),
      station: safeNum(document.getElementById('fSta').value, null),
      position: (document.getElementById('fPos').value || '').trim(),
      caput: safeNum(document.getElementById('fCap').value, null),
      molding: safeNum(document.getElementById('fMol').value, null),
      note: (document.getElementById('fNote').value || '').trim()
    };
  } else if (type === 'rom'){
    data = {
      fluid: document.getElementById('fFluid').value,
      meconium: document.getElementById('fMeconium').value === 'true',
      note: (document.getElementById('fNote').value || '').trim()
    };
  } else if (type === 'med'){
    data = {
      medName: document.getElementById('fMedName').value,
      rate: (document.getElementById('fRate').value || '').trim(),
      note: (document.getElementById('fNote').value || '').trim()
    };
  } else if (type === 'vitals'){
    data = {
      tempC: safeNum(document.getElementById('fTemp').value, null),
      hr: safeNum(document.getElementById('fHR').value, null),
      sbp: safeNum(document.getElementById('fSBP').value, null),
      dbp: safeNum(document.getElementById('fDBP').value, null),
      note: (document.getElementById('fNote').value || '').trim()
    };
  } else if (type === 'fetal'){
    data = {
      category: document.getElementById('fCat').value,
      recurrentDecels: document.getElementById('fDec').value === 'true',
      note: (document.getElementById('fNote').value || '').trim()
    };
  }

  return {
    id: existingId || uid('evt'),
    encounterId: selectedEncId,
    type,
    ts: new Date(ts).toISOString(),
    data
  };
}

/* -------------------- Outcome -------------------- */
async function outcomeFlow(){
  const enc = await dbGetEncounter(selectedEncId);
  const nowISO = new Date().toISOString();
  const body = `
    <div class="grid">
      <div style="grid-column:1/-1;">
        <label class="small">Outcome time</label>
        <input id="fTs" class="input" type="datetime-local" value="${toLocalInput(enc.outcomeAt || nowISO)}" />
      </div>
      <div>
        <label class="small">Mode</label>
        <select id="fMode" class="select">
          <option value="vaginal" ${sel(enc.outcomeMode,'vaginal')}>vaginal</option>
          <option value="cs" ${sel(enc.outcomeMode,'cs')}>C/S</option>
          <option value="unknown" ${sel(enc.outcomeMode,'unknown')}>unknown</option>
        </select>
      </div>
      <div>
        <label class="small">Status</label>
        <select id="fStatus" class="select">
          <option value="open" ${sel(enc.status,'open')}>open</option>
          <option value="delivered" ${sel(enc.status,'delivered')}>delivered</option>
          <option value="cs" ${sel(enc.status,'cs')}>cs</option>
        </select>
      </div>
      <div style="grid-column:1/-1;">
        <label class="small">Note</label>
        <input id="fNote" class="input" value="${escVal(enc.outcomeNote)}" placeholder="optional" />
      </div>
    </div>
    <div class="hr"></div>
    <div class="small">Outcome enables prediction-vs-reality replay.</div>
  `;
  await openModal('Outcome', body, {
    okText:'Save',
    onOk: async () => {
      enc.outcomeAt = new Date(fromLocalInput(document.getElementById('fTs').value)).toISOString();
      enc.outcomeMode = document.getElementById('fMode').value;
      enc.status = document.getElementById('fStatus').value;
      enc.outcomeNote = (document.getElementById('fNote').value || '').trim();
      enc.updatedAt = new Date().toISOString();
      await dbPutEncounter(enc);
      await loadEncounters();
      await refreshSelected();
      renderEncounterList();
      if (activeTab() === 'predict') refreshPredict();
      return true;
    }
  });
}

/* -------------------- Curves -------------------- */
async function refreshCharts(){
  if (!selectedEncId) return;
  const enc = await dbGetEncounter(selectedEncId);
  const events = await dbListEvents(selectedEncId);
  renderCharts(enc, events, SETTINGS, overlayOpts);
}

/* -------------------- Predictor + replay -------------------- */
function fmtHr(hr){
  if (hr == null || !Number.isFinite(hr)) return '—';
  if (hr < 1) return `${Math.round(hr*60)} min`;
  return `${hr.toFixed(1)} hr`;
}

function fmtProb(p){
  if (p == null) return '—';
  return `${Math.round(p*100)}%`;
}

async function refreshPredict(){
  if (!selectedEncId) return;
  const enc = await dbGetEncounter(selectedEncId);
  const events = await dbListEvents(selectedEncId);

  const pred = predictETA(enc, events, SETTINGS);

  predictNow.innerHTML = '';
  predictExplain.innerHTML = '';
  phaseFlags.innerHTML = '';

  if (!pred.etadelivery){
    predictNow.innerHTML = kpi('ETA to delivery', '—', 'Add an SVE');
    predictExplain.innerHTML = pred.explain.map(x=>kpi('Info', x)).join('');
    return;
  }

  const d = pred.etadelivery;
  const t10 = pred.eta10;

  predictNow.innerHTML = [
    kpi('Phase', pred.phase),
    kpi('ETA to 10 cm (mid)', fmtHr(t10.midHr), `PI: ${fmtHr(t10.lowHr)} – ${fmtHr(t10.highHr)}`),
    kpi('ETA to delivery (mid)', fmtHr(d.midHr), `PI: ${fmtHr(d.lowHr)} – ${fmtHr(d.highHr)}`),
    kpi('P(delivery by 2 hr)', fmtProb(pred.probs.by2)),
    kpi('P(delivery by 4 hr)', fmtProb(pred.probs.by4)),
    kpi('P(delivery by 8 hr)', fmtProb(pred.probs.by8))
  ].join('');

  predictExplain.innerHTML = pred.explain.map(x=>kpi('Contributor', x)).join('');

  const flags = pred.flags || {};
  phaseFlags.innerHTML = [
    kpi('Induction', flags.induction ? 'Yes' : 'No'),
    kpi('Epidural', flags.epidural ? 'Yes' : 'No'),
    kpi('OP/OT', flags.op ? 'Yes' : 'No'),
    kpi('Recent oxytocin titration', flags.oxyRecent ? 'Yes' : 'No'),
  ].join('');

  refreshReplayOptions();
  refreshReplay();
}

function refreshReplayOptions(){
  replayAt.innerHTML = '';
  if (!selectedEvents?.length) return;

  const sves = selectedEvents.filter(e=>e.type==='sve');
  if (!sves.length) return;

  for (const s of sves){
    const opt = document.createElement('option');
    opt.value = s.ts;
    opt.textContent = `SVE @ ${fmtDateTime(s.ts)} (${s.data?.dilationCm} cm)`;
    replayAt.appendChild(opt);
  }
}

async function refreshReplay(){
  replayCard.innerHTML = '';
  if (!selectedEncId) return;

  const enc = await dbGetEncounter(selectedEncId);
  const events = await dbListEvents(selectedEncId);
  const sves = events.filter(e=>e.type==='sve');
  if (!sves.length) return;

  const atTs = replayAt.value || sves[sves.length-1].ts;
  const prefixEvents = events.filter(e => new Date(e.ts) <= new Date(atTs));

  const predAt = predictETA(enc, prefixEvents, SETTINGS);

  // Need outcome to compute actual
  if (!enc.outcomeAt){
    replayCard.innerHTML = kpi('Replay', 'Outcome not set', 'Set outcome to see error vs reality.');
    return;
  }

  const actualHr = (new Date(enc.outcomeAt).getTime() - new Date(atTs).getTime()) / 3600000;

  if (!predAt.etadelivery){
    replayCard.innerHTML = kpi('Replay', 'Insufficient data', 'Add more events.');
    return;
  }

  const mid = predAt.etadelivery.midHr;
  const err = mid - actualHr;

  replayCard.innerHTML = [
    kpi('Prediction (mid)', fmtHr(mid), `PI: ${fmtHr(predAt.etadelivery.lowHr)} – ${fmtHr(predAt.etadelivery.highHr)}`),
    kpi('Actual time to delivery', fmtHr(actualHr)),
    kpi('Error (pred - actual)', fmtHr(err), err > 0 ? 'Overestimated (too slow)' : 'Underestimated (too fast)'),
  ].join('');
}

/* -------------------- Summary -------------------- */
async function refreshSummary(){
  if (!selectedEncId) return;
  const enc = await dbGetEncounter(selectedEncId);
  const events = await dbListEvents(selectedEncId);

  const lines = [];
  lines.push(`LaborCurve Logbook summary`);
  lines.push(`Encounter: ${enc.title}`);
  lines.push(`Started: ${fmtDateTime(enc.startedAt)}`);
  lines.push(`Parity: ${enc.parity} | GA: ${enc.gaWeeks ?? '?'}w | ${enc.isInduction ? 'Induction' : 'Spontaneous'}${enc.epiduralPlanned ? ' | Epidural planned' : ''}`);
  if (enc.tags) lines.push(`Tags: ${enc.tags}`);
  if (enc.notes) lines.push(`Notes: ${enc.notes}`);
  lines.push('');

  for (const ev of events){
    lines.push(`${fmtDateTime(ev.ts)}  ${labelForEvent(ev)}`);
  }

  lines.push('');
  if (enc.outcomeAt){
    lines.push(`Outcome: ${enc.status} (${enc.outcomeMode || 'unknown'}) @ ${fmtDateTime(enc.outcomeAt)} ${enc.outcomeNote ? `• ${enc.outcomeNote}` : ''}`);
  } else {
    lines.push(`Outcome: not set`);
  }

  summaryText.textContent = lines.join('\n');
}

/* -------------------- Export / Import -------------------- */
async function exportAll(){
  const dump = await dbDumpAll();
  const fname = `laborcurve_${fmtDate(new Date(), true)}.laborlog.json`;
  downloadText(fname, JSON.stringify(dump, null, 2));
}

async function importAll(){
  const file = fileImportAll.files?.[0];
  if (!file) return;
  const txt = await readFileAsText(file);
  let payload = null;
  try { payload = JSON.parse(txt); } catch {
    alert('Import failed: not valid JSON');
    fileImportAll.value = '';
    return;
  }

  // merge by default
  try {
    await dbImportAll(payload, {mode:'merge'});
    await loadEncounters();
    selectedEncId = encounters[0]?.id || null;
    await refreshSelected();
    renderEncounterList();
  } catch (e){
    alert('Import failed: ' + (e?.message || e));
  } finally {
    fileImportAll.value = '';
  }
}

async function exportSelectedEncounter(){
  if (!selectedEncId) return;
  const enc = await dbGetEncounter(selectedEncId);
  const events = await dbListEvents(selectedEncId);
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    kind: 'encounter',
    encounter: enc,
    events
  };
  const fname = `enc_${(enc.title||'encounter').replaceAll(/\s+/g,'_').slice(0,40)}_${fmtDate(new Date(enc.startedAt), true)}.laborlog.json`;
  downloadText(fname, JSON.stringify(payload, null, 2));
}

async function deleteSelectedEncounter(){
  if (!selectedEncId) return;
  const ok = confirm('Delete this encounter and all events?');
  if (!ok) return;
  await dbDeleteEncounter(selectedEncId);
  selectedEncId = null;
  await loadEncounters();
  renderEncounterList();
  await refreshSelected();
}

/* -------------------- Settings -------------------- */
async function settingsFlow(){
  const s = SETTINGS;

  const body = `
    <div class="grid">
      <div>
        <label class="small">Active labor threshold (cm)</label>
        <input id="sActive" class="input" type="number" min="4" max="8" step="0.5" value="${escVal(s.activeThresholdCm)}" />
      </div>

      <div style="grid-column:1/-1;"><div class="hr"></div><div class="small"><strong>Active dilation rates (cm/hr)</strong></div></div>

      <div>
        <label class="small">Nullip low</label>
        <input id="nLow" class="input" type="number" step="0.1" value="${escVal(s.rates.nullip.low)}" />
      </div>
      <div>
        <label class="small">Nullip mid</label>
        <input id="nMid" class="input" type="number" step="0.1" value="${escVal(s.rates.nullip.mid)}" />
      </div>
      <div>
        <label class="small">Nullip high</label>
        <input id="nHigh" class="input" type="number" step="0.1" value="${escVal(s.rates.nullip.high)}" />
      </div>

      <div>
        <label class="small">Multip low</label>
        <input id="mLow" class="input" type="number" step="0.1" value="${escVal(s.rates.multip.low)}" />
      </div>
      <div>
        <label class="small">Multip mid</label>
        <input id="mMid" class="input" type="number" step="0.1" value="${escVal(s.rates.multip.mid)}" />
      </div>
      <div>
        <label class="small">Multip high</label>
        <input id="mHigh" class="input" type="number" step="0.1" value="${escVal(s.rates.multip.high)}" />
      </div>

      <div style="grid-column:1/-1;"><div class="hr"></div><div class="small"><strong>Second stage (hours)</strong> (used for delivery ETA)</div></div>

      <div>
        <label class="small">Nullip no-epi mid</label>
        <input id="ssNN" class="input" type="number" step="0.1" value="${escVal(s.secondStage.nullip_noEpi.mid)}" />
      </div>
      <div>
        <label class="small">Nullip epi mid</label>
        <input id="ssNE" class="input" type="number" step="0.1" value="${escVal(s.secondStage.nullip_epi.mid)}" />
      </div>
      <div>
        <label class="small">Multip no-epi mid</label>
        <input id="ssMN" class="input" type="number" step="0.1" value="${escVal(s.secondStage.multip_noEpi.mid)}" />
      </div>
      <div>
        <label class="small">Multip epi mid</label>
        <input id="ssME" class="input" type="number" step="0.1" value="${escVal(s.secondStage.multip_epi.mid)}" />
      </div>

      <div style="grid-column:1/-1;"><div class="hr"></div><div class="small">These are intuition-training priors. They are not a validated clinical device.</div></div>
    </div>
  `;

  await openModal('Settings', body, {
    okText:'Save',
    onOk: async () => {
      const next = JSON.parse(JSON.stringify(SETTINGS));

      next.activeThresholdCm = safeNum(document.getElementById('sActive').value, next.activeThresholdCm);

      next.rates.nullip.low  = safeNum(document.getElementById('nLow').value, next.rates.nullip.low);
      next.rates.nullip.mid  = safeNum(document.getElementById('nMid').value, next.rates.nullip.mid);
      next.rates.nullip.high = safeNum(document.getElementById('nHigh').value, next.rates.nullip.high);

      next.rates.multip.low  = safeNum(document.getElementById('mLow').value, next.rates.multip.low);
      next.rates.multip.mid  = safeNum(document.getElementById('mMid').value, next.rates.multip.mid);
      next.rates.multip.high = safeNum(document.getElementById('mHigh').value, next.rates.multip.high);

      // update second stage mids; keep low/high proportional if desired
      next.secondStage.nullip_noEpi.mid = safeNum(document.getElementById('ssNN').value, next.secondStage.nullip_noEpi.mid);
      next.secondStage.nullip_epi.mid   = safeNum(document.getElementById('ssNE').value, next.secondStage.nullip_epi.mid);
      next.secondStage.multip_noEpi.mid = safeNum(document.getElementById('ssMN').value, next.secondStage.multip_noEpi.mid);
      next.secondStage.multip_epi.mid   = safeNum(document.getElementById('ssME').value, next.secondStage.multip_epi.mid);

      SETTINGS = next;
      await dbPutSettings(SETTINGS);

      if (activeTab() === 'curves') refreshCharts();
      if (activeTab() === 'predict') refreshPredict();
      return true;
    }
  });
}

/* -------------------- Helpers -------------------- */
function activeTab(){
  return document.querySelector('.tab.active')?.dataset?.tab || 'timeline';
}

function escapeHtml(s){
  return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
}
function escVal(v){ return escapeHtml(v ?? ''); }
function sel(v, target){
  return String(v ?? '').toLowerCase() === String(target ?? '').toLowerCase() ? 'selected' : '';
}

function toLocalInput(iso){
  const d = new Date(iso);
  const pad = (n)=>String(n).padStart(2,'0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth()+1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}
function fromLocalInput(v){
  // treat as local time
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}
