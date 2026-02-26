import { uid } from './utils.js';

const DB_NAME = 'laborcurve_db';
const DB_VER = 1;

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('encounters')) {
        const s = db.createObjectStore('encounters', { keyPath:'id' });
        s.createIndex('status', 'status', { unique:false });
        s.createIndex('updatedAt', 'updatedAt', { unique:false });
      }
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath:'id' });
        s.createIndex('encounterId', 'encounterId', { unique:false });
        s.createIndex('ts', 'ts', { unique:false });
        s.createIndex('type', 'type', { unique:false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath:'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(db, storeName, mode='readonly'){
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function dbGetSettings(){
  const db = await openDB();
  const store = await tx(db,'settings');
  const req = store.get('app');
  return await new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result?.value || null);
    req.onerror = () => resolve(null);
  });
}

export async function dbPutSettings(value){
  const db = await openDB();
  const store = await tx(db,'settings','readwrite');
  store.put({ key:'app', value });
  return true;
}

export async function dbListEncounters(){
  const db = await openDB();
  const store = await tx(db,'encounters');
  const req = store.getAll();
  return await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetEncounter(id){
  const db = await openDB();
  const store = await tx(db,'encounters');
  const req = store.get(id);
  return await new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

export async function dbPutEncounter(enc){
  const db = await openDB();
  const store = await tx(db,'encounters','readwrite');
  store.put(enc);
  return true;
}

export async function dbDeleteEncounter(encId){
  const db = await openDB();
  // delete encounter
  await new Promise((resolve, reject) => {
    const tr = db.transaction(['encounters','events'], 'readwrite');
    tr.objectStore('encounters').delete(encId);

    const evStore = tr.objectStore('events');
    const idx = evStore.index('encounterId');
    const req = idx.openCursor(IDBKeyRange.only(encId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tr.oncomplete = () => resolve(true);
    tr.onerror = () => reject(tr.error);
  });
  return true;
}

export async function dbListEvents(encounterId){
  const db = await openDB();
  const store = await tx(db,'events');
  const idx = store.index('encounterId');
  const req = idx.getAll(encounterId);
  const all = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  all.sort((a,b)=> new Date(a.ts) - new Date(b.ts));
  return all;
}

export async function dbPutEvent(evt){
  const db = await openDB();
  const store = await tx(db,'events','readwrite');
  store.put(evt);
  return true;
}

export async function dbDeleteEvent(eventId){
  const db = await openDB();
  const store = await tx(db,'events','readwrite');
  store.delete(eventId);
  return true;
}

/** Export everything */
export async function dbDumpAll(){
  const encounters = await dbListEncounters();
  const db = await openDB();
  const store = await tx(db,'events');
  const req = store.getAll();
  const events = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  const settings = await dbGetSettings();
  return { version:1, exportedAt: new Date().toISOString(), settings, encounters, events };
}

/** Import everything (merge or replace) */
export async function dbImportAll(payload, {mode='merge'} = {}){
  if (!payload || !payload.version) throw new Error('Invalid import file');

  const db = await openDB();
  if (mode === 'replace') {
    // wipe and replace
    await new Promise((resolve, reject) => {
      const tr = db.transaction(['encounters','events','settings'], 'readwrite');
      tr.objectStore('encounters').clear();
      tr.objectStore('events').clear();
      tr.objectStore('settings').clear();
      tr.oncomplete = () => resolve(true);
      tr.onerror = () => reject(tr.error);
    });
  }

  // Write settings
  if (payload.settings) await dbPutSettings(payload.settings);

  // Write encounters/events
  await new Promise((resolve, reject) => {
    const tr = db.transaction(['encounters','events'], 'readwrite');
    const encStore = tr.objectStore('encounters');
    const evStore = tr.objectStore('events');

    (payload.encounters || []).forEach(e => {
      if (!e.id) e.id = uid('enc');
      encStore.put(e);
    });
    (payload.events || []).forEach(ev => {
      if (!ev.id) ev.id = uid('evt');
      evStore.put(ev);
    });

    tr.oncomplete = () => resolve(true);
    tr.onerror = () => reject(tr.error);
  });

  return true;
}
