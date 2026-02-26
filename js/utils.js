export const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

export function fmtDate(d, includeYear=false){
  const dt = (d instanceof Date) ? d : new Date(d);
  const dd = String(dt.getDate()).padStart(2,'0');
  const mon = MONTHS[dt.getMonth()];
  if (includeYear) return `${dd}${mon}${dt.getFullYear()}`;
  return `${dd}${mon}`;
}

export function fmtDateTime(d){
  const dt = (d instanceof Date) ? d : new Date(d);
  const hh = String(dt.getHours()).padStart(2,'0');
  const mm = String(dt.getMinutes()).padStart(2,'0');
  return `${fmtDate(dt,true)} ${hh}:${mm}`;
}

export function hoursBetween(t1, t2){
  return (new Date(t2).getTime() - new Date(t1).getTime()) / 3600000;
}

export function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

export function uid(prefix="id"){
  return `${prefix}_${crypto.randomUUID()}`;
}

export function safeNum(v, fallback=null){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function downloadText(filename, text){
  const blob = new Blob([text], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function readFileAsText(file){
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = reject;
    r.readAsText(file);
  });
}

export function deepCopy(obj){ return JSON.parse(JSON.stringify(obj)); }

export function median(arr){
  const a = [...arr].sort((x,y)=>x-y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n/2);
  return (n%2) ? a[mid] : (a[mid-1]+a[mid])/2;
}
