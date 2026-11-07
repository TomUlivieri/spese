'use strict';
/* Spese — registro spese personale.
   Tutti i dati (e gli allegati) restano in IndexedDB su questo dispositivo.
   Nessuna richiesta di rete verso l'esterno: l'unico traffico è il caricamento dei file dell'app. */

const DB_NAME = 'spese-app';
const DB_VERSION = 1;
const TYPE_LABEL = { essential: 'Essenziale', extra: 'Extra' };
const DEFAULT_CATS = [
  { name: 'Casa e affitto', defaultType: 'essential' },
  { name: 'Bollette', defaultType: 'essential' },
  { name: 'Spesa alimentare', defaultType: 'essential' },
  { name: 'Trasporti', defaultType: 'essential' },
  { name: 'Salute', defaultType: 'essential' },
  { name: 'Ristoranti e bar', defaultType: 'extra' },
  { name: 'Svago e hobby', defaultType: 'extra' },
  { name: 'Abbigliamento', defaultType: 'extra' },
  { name: 'Abbonamenti', defaultType: 'extra' },
  { name: 'Altro', defaultType: 'extra' }
];
const MAX_FILE = 20 * 1024 * 1024; // per allegato
const MAX_FILES = 10;              // allegati per spesa

// Nomi dei mesi (italiano e inglese, interi e abbreviati) per leggere le date testuali di Notion.
const MONTHS = new Map(Object.entries({
  gennaio: 1, january: 1, jan: 1, gen: 1,
  febbraio: 2, february: 2, feb: 2,
  marzo: 3, march: 3, mar: 3,
  aprile: 4, april: 4, apr: 4,
  maggio: 5, may: 5, mag: 5,
  giugno: 6, june: 6, jun: 6, giu: 6,
  luglio: 7, july: 7, jul: 7, lug: 7,
  agosto: 8, august: 8, aug: 8, ago: 8,
  settembre: 9, september: 9, sep: 9, sept: 9, set: 9,
  ottobre: 10, october: 10, oct: 10, ott: 10,
  novembre: 11, november: 11, nov: 11,
  dicembre: 12, december: 12, dec: 12, dic: 12
}));

// Intestazioni riconosciute nell'importazione CSV (confronto senza maiuscole, spazi e accenti).
const COLS = {
  name: ['nomespesa', 'nome', 'name', 'titolo', 'spesa'],
  type: ['tipo', 'type'],
  category: ['categoria', 'category'],
  amount: ['importo', 'amount', 'costo', 'prezzo'],
  comment: ['commento', 'comment', 'nota', 'note'],
  date: ['data', 'date']
};

/* ---------- Utilità ---------- */
const $ = (s, r = document) => r.querySelector(s);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
}

const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', useGrouping: 'always' });
const fmt = cents => eur.format(cents / 100);
const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthOf = d => dateStr(d).slice(0, 7);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return Math.round(b / 1024) + ' KB';
  return (b / 1048576).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' MB';
}

function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  return monthOf(new Date(y, mo - 1 + delta, 1));
}
function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return cap(new Date(y, mo - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }));
}
function dayLabel(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return cap(new Date(y, m - 1, d).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }));
}

function validDate(y, m, d) {
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}
const isoDate = (y, m, d) => (validDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null);
const monthKey = w => w.toLowerCase().replace(/\./g, '');

// Accetta: 2026-11-07, 07/11/2026, 7 novembre 2026, 7 Nov 2026, November 7, 2026 (e intervalli di Notion: usa l'inizio).
function parseDate(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  s = s.split('→')[0].trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+(\d{4})/.exec(s);
  if (m && MONTHS.has(monthKey(m[2]))) return isoDate(+m[3], MONTHS.get(monthKey(m[2])), +m[1]);
  m = /^([A-Za-zÀ-ÿ.]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m && MONTHS.has(monthKey(m[1]))) return isoDate(+m[3], MONTHS.get(monthKey(m[1])), +m[2]);
  return null;
}

// "12,50" -> 1250 centesimi; "1.234,56" e "1,234.50" -> 123456 / 123450; "€45.5" -> 4550. Importi non validi -> 0.
function parseAmount(str) {
  let s = String(str ?? '').replace(/[€\s]/g, '');
  if (!s) return 0;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc >= 0 && ld >= 0) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc >= 0) s = s.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 0;
  const c = Math.round(parseFloat(s) * 100);
  return c > 0 && c < 1e11 ? c : 0;
}

const ls = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch (_) { /* archivio non disponibile */ }
  return null;
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function download(name, data, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const blobToB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

const fv = (form, n) => form.elements.namedItem(n).value;
const fs = (form, n, v) => { form.elements.namedItem(n).value = v; };
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/* ---------- Database (IndexedDB) ---------- */
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      const ex = d.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
      ex.createIndex('date', 'date');
      const cs = d.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
      DEFAULT_CATS.forEach(c => cs.add(c));
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const st = (n, mode = 'readonly') => db.transaction(n, mode).objectStore(n);

const getCats = () => rq(st('categories').getAll());
const getAll = () => rq(st('expenses').getAll());
const getRange = (a, b) => rq(st('expenses').index('date').getAll(IDBKeyRange.bound(a, b)));

/* ---------- Stato ---------- */
const S = { month: monthOf(new Date()), tab: 'spese', cats: [], exp: [], prevTotal: 0, prevCount: 0, count: 0 };
let editingId = null;
let editingCatId = null;
let installEvt = null;
let pendingAtt = [];
let typeTouched = false;

const catById = id => S.cats.find(c => c.id === id);
const catName = id => (catById(id) || {}).name || '(categoria eliminata)';
const sum = arr => arr.reduce((s, e) => s + e.amount, 0);

async function refresh() {
  S.cats = await getCats();
  S.exp = await getRange(S.month + '-01', S.month + '-31');
  const pm = shiftMonth(S.month, -1);
  const prev = await getRange(pm + '-01', pm + '-31');
  S.prevTotal = sum(prev);
  S.prevCount = prev.length;
  S.count = await rq(st('expenses').count());
  render();
}

/* ---------- Rendering ---------- */
function render() {
  $('#monthLabel').textContent = monthLabel(S.month);
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + S.tab; });
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
  $('#topbar').hidden = S.tab === 'dati';
  $('#fab').hidden = S.tab === 'dati';
  renderBanner();
  if (S.tab === 'spese') renderList();
  else if (S.tab === 'riepilogo') renderSummary();
  else renderData();
}

function renderBanner() {
  const b = $('#banner');
  b.replaceChildren();
  const lastBackup = Number(ls('lastBackup')) || 0;
  const since = Math.max(lastBackup, Number(ls('firstUse')) || 0);
  const days = since ? Math.floor((Date.now() - since) / 864e5) : 0;
  if (S.tab === 'dati' || S.count === 0 || days < 30) { b.hidden = true; return; }
  const msg = lastBackup
    ? `Ultimo backup: ${days} giorni fa. I dati sono solo su questo telefono.`
    : 'Non hai ancora fatto un backup. I dati sono solo su questo telefono.';
  b.append(el('span', { text: msg }), el('button', { class: 'link', type: 'button', text: 'Crea backup', onclick: backupJSON }));
  b.hidden = false;
}

function emptyState() {
  return el('div', { class: 'empty' },
    el('p', { text: 'Nessuna spesa in questo mese.' }),
    el('p', { class: 'muted', text: 'Tocca + per aggiungere la prima.' }));
}

function expenseItem(e) {
  const n = (e.attachments || []).length;
  const sub = [catName(e.categoryId), e.comment || e.note].filter(Boolean).join(' · ');
  return el('li', {},
    el('button', { class: 'item', type: 'button', onclick: () => openExpense(e) },
      el('span', { class: 'dot ' + e.type }),
      el('span', { class: 'meta' },
        el('span', { class: 'cat' }, e.name || catName(e.categoryId),
          n ? el('span', { class: 'clip', text: ' 📎' + (n > 1 ? n : '') }) : null),
        el('span', { class: 'note', text: sub })),
      el('span', { class: 'right' },
        el('span', { class: 'amt', text: fmt(e.amount) }),
        el('span', { class: 'badge ' + e.type, text: TYPE_LABEL[e.type] }))));
}

function renderList() {
  const root = $('#tab-spese');
  root.replaceChildren();
  root.append(el('div', { class: 'totalbar' },
    el('span', { class: 'muted', text: 'Totale del mese' }),
    el('strong', { text: fmt(sum(S.exp)) })));
  if (!S.exp.length) { root.append(emptyState()); return; }

  const sorted = [...S.exp].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const dayTotals = new Map();
  for (const e of sorted) dayTotals.set(e.date, (dayTotals.get(e.date) || 0) + e.amount);

  let current = null;
  let list = null;
  for (const e of sorted) {
    if (e.date !== current) {
      current = e.date;
      root.append(el('div', { class: 'dayhead' },
        el('span', { text: dayLabel(current) }),
        el('span', { text: fmt(dayTotals.get(current)) })));
      list = el('ul', { class: 'items' });
      root.append(list);
    }
    list.append(expenseItem(e));
  }
}

function legendRow(type, label, amount, pct) {
  return el('div', { class: 'lg' },
    el('span', { class: 'dot ' + type }),
    el('span', { text: label }),
    el('strong', { text: fmt(amount) }),
    el('span', { class: 'muted', text: pct + '%' }));
}

function renderSummary() {
  const root = $('#tab-riepilogo');
  root.replaceChildren();
  if (!S.exp.length) { root.append(emptyState()); return; }

  const total = sum(S.exp);
  const ess = sum(S.exp.filter(e => e.type === 'essential'));
  const ext = total - ess;
  const pEss = Math.round(ess / total * 100);

  let delta = null;
  if (S.prevCount > 0) {
    const d = total - S.prevTotal;
    delta = el('span', { class: 'muted small', text: `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))} rispetto al mese precedente` });
  }
  root.append(el('div', { class: 'card hero' },
    el('span', { class: 'muted', text: 'Totale speso' }),
    el('strong', { class: 'big', text: fmt(total) }),
    delta));

  root.append(el('div', { class: 'card' },
    el('h2', { text: 'Essenziali e extra' }),
    el('div', { class: 'split', role: 'img', 'aria-label': `Essenziali ${pEss}%, extra ${100 - pEss}%` },
      el('span', { class: 'seg essential', style: `flex:${ess}` }),
      el('span', { class: 'seg extra', style: `flex:${ext}` })),
    el('div', { class: 'legend' },
      legendRow('essential', 'Essenziali', ess, pEss),
      legendRow('extra', 'Extra', ext, 100 - pEss))));

  const by = new Map();
  for (const e of S.exp) {
    const r = by.get(e.categoryId) || { ess: 0, ext: 0 };
    if (e.type === 'essential') r.ess += e.amount; else r.ext += e.amount;
    by.set(e.categoryId, r);
  }
  const rows = [...by].map(([id, r]) => ({ id, ess: r.ess, ext: r.ext, tot: r.ess + r.ext })).sort((a, b) => b.tot - a.tot);
  const max = rows[0].tot;

  const card = el('div', { class: 'card' }, el('h2', { text: 'Per categoria' }));
  for (const r of rows) {
    card.append(el('div', { class: 'catrow' },
      el('div', { class: 'cathead' },
        el('span', { text: catName(r.id) }),
        el('span', {}, el('strong', { text: fmt(r.tot) }), ' ', el('span', { class: 'muted', text: Math.round(r.tot / total * 100) + '%' }))),
      el('div', { class: 'track' },
        el('div', { class: 'bar', style: `width:${(r.tot / max * 100).toFixed(1)}%` },
          el('span', { class: 'seg essential', style: `flex:${r.ess}` }),
          el('span', { class: 'seg extra', style: `flex:${r.ext}` })))));
  }
  root.append(card);
}

function renderData() {
  const root = $('#tab-dati');
  root.replaceChildren();
  root.append(el('h1', { class: 'pagetitle', text: 'Categorie e dati' }));

  if (installEvt) {
    root.append(el('div', { class: 'card' },
      el('button', {
        class: 'btn primary block', type: 'button', text: "Installa l'app sul telefono",
        onclick: async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; renderData(); }
      })));
  }

  const cats = el('div', { class: 'card' }, el('h2', { text: 'Categorie' }));
  const ul = el('ul', { class: 'items' });
  for (const c of S.cats) {
    ul.append(el('li', {},
      el('button', { class: 'item', type: 'button', onclick: () => openCat(c) },
        el('span', { class: 'dot ' + c.defaultType }),
        el('span', { class: 'meta' }, el('span', { class: 'cat', text: c.name })),
        el('span', { class: 'right' }, el('span', { class: 'badge ' + c.defaultType, text: TYPE_LABEL[c.defaultType] })))));
  }
  cats.append(ul, el('button', { class: 'btn block', type: 'button', text: '+ Nuova categoria', onclick: () => openCat(null) }));
  root.append(cats);

  const lastBackup = Number(ls('lastBackup')) || 0;
  root.append(el('div', { class: 'card' },
    el('h2', { text: 'Dati' }),
    el('p', { class: 'muted small', text: `${S.count} spese salvate. Ultimo backup: ${lastBackup ? new Date(lastBackup).toLocaleDateString('it-IT') : 'mai'}.` }),
    el('p', { class: 'muted small', text: 'Il backup (JSON) include anche gli allegati e può diventare pesante se ne hai molti. Il CSV contiene solo i nomi dei file allegati.' }),
    el('button', { class: 'btn block', type: 'button', text: 'Crea backup completo (JSON)', onclick: backupJSON }),
    el('button', { class: 'btn block', type: 'button', text: 'Ripristina da backup (JSON)', onclick: () => $('#fileJson').click() }),
    el('button', { class: 'btn block', type: 'button', text: 'Esporta tutte le spese (CSV)', onclick: async () => exportCSV(await getAll(), 'spese-tutte.csv') }),
    el('button', { class: 'btn block', type: 'button', text: 'Esporta il mese visualizzato (CSV)', onclick: () => exportCSV(S.exp, `spese-${S.month}.csv`) }),
    el('button', { class: 'btn block', type: 'button', text: 'Importa spese da CSV', onclick: () => $('#fileCsv').click() }),
    el('button', { class: 'btn danger block', type: 'button', text: 'Elimina tutte le spese', onclick: wipe })));

  const persist = el('p', { class: 'muted small' });
  const usage = el('p', { class: 'muted small' });
  root.append(el('div', { class: 'card' },
    el('h2', { text: 'Privacy' }),
    el('p', { text: "I dati e gli allegati sono salvati solo su questo dispositivo, nell'archivio del browser. L'app non invia nulla in rete e non usa servizi o risorse esterne." }),
    el('p', { class: 'muted small', text: 'Se cancelli i dati del sito o disinstalli il browser, le spese vanno perse: fai un backup ogni tanto.' }),
    persist, usage));
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(p => {
      persist.textContent = p
        ? 'Archiviazione persistente attiva: il browser non cancella i dati da solo.'
        : 'Archiviazione persistente non attiva: il browser potrebbe svuotarla se manca spazio. Tieni dei backup.';
    }).catch(() => {});
  }
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(({ usage: u }) => {
      if (u != null) usage.textContent = `Spazio occupato dall'app: ${fmtSize(u)}.`;
    }).catch(() => {});
  }
}

/* ---------- Spese: inserimento e modifica ---------- */
const expDlg = $('#expDialog');
const expForm = $('#expForm');

function fillCatSelect(sel, selectedId) {
  sel.replaceChildren(...S.cats.map(c => el('option', { value: String(c.id), text: c.name })));
  if (selectedId != null) sel.value = String(selectedId);
  if (!sel.value) sel.selectedIndex = 0;
}

function renderAtt() {
  const box = $('#attList');
  box.replaceChildren();
  pendingAtt.forEach((a, i) => {
    box.append(el('li', { class: 'att' },
      el('button', { class: 'attname', type: 'button', onclick: () => openAtt(a) },
        a.name, ' ', el('span', { class: 'muted small', text: fmtSize(a.size) })),
      el('button', {
        class: 'attdel', type: 'button', 'aria-label': 'Rimuovi ' + a.name,
        onclick: () => { pendingAtt.splice(i, 1); renderAtt(); }
      }, '×')));
  });
}

function addFiles(files) {
  for (const f of files) {
    if (pendingAtt.length >= MAX_FILES) { toast(`Massimo ${MAX_FILES} allegati per spesa`); break; }
    if (f.size > MAX_FILE) { toast(`${f.name}: supera i 20 MB`); continue; }
    pendingAtt.push({ name: f.name || 'allegato', type: f.type || 'application/octet-stream', size: f.size, blob: f });
  }
  renderAtt();
}

function openExpense(e) {
  editingId = e ? e.id : null;
  $('#expTitle').textContent = e ? 'Modifica spesa' : 'Nuova spesa';
  $('#expDelete').hidden = !e;

  const sel = expForm.elements.namedItem('category');
  const lastCat = Number(ls('lastCat')) || null;
  fillCatSelect(sel, e ? e.categoryId : (catById(lastCat) ? lastCat : null));

  fs(expForm, 'expname', e ? (e.name || '') : '');
  fs(expForm, 'amount', e ? (e.amount / 100).toFixed(2).replace('.', ',') : '');
  fs(expForm, 'comment', e ? (e.comment || e.note || '') : '');
  const today = dateStr(new Date());
  fs(expForm, 'date', e ? e.date : (S.month === today.slice(0, 7) ? today : S.month + '-01'));
  const cat = catById(Number(sel.value));
  fs(expForm, 'type', e ? e.type : (cat ? cat.defaultType : 'extra'));
  typeTouched = !!e; // in modifica il tipo scelto non viene più cambiato dalla categoria

  pendingAtt = e ? [...(e.attachments || [])] : [];
  renderAtt();

  expDlg.showModal();
  expDlg.scrollTop = 0;
  if (!e) expForm.elements.namedItem('expname').focus();
}

expForm.querySelectorAll('input[name=type]').forEach(r => r.addEventListener('change', () => { typeTouched = true; }));
expForm.elements.namedItem('category').addEventListener('change', () => {
  const c = catById(Number(fv(expForm, 'category')));
  if (c && !typeTouched) fs(expForm, 'type', c.defaultType);
});

$('#attPhotoBtn').onclick = () => $('#attPhoto').click();
$('#attFileBtn').onclick = () => $('#attFile').click();
for (const id of ['#attPhoto', '#attFile']) {
  $(id).addEventListener('change', ev => { addFiles([...ev.target.files]); ev.target.value = ''; });
}

expForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  const name = fv(expForm, 'expname').trim();
  if (!name) { toast('Inserisci il nome della spesa'); return; }
  const amount = parseAmount(fv(expForm, 'amount'));
  if (!amount) { toast('Inserisci un importo valido, ad esempio 12,50'); return; }
  const rec = {
    name,
    amount,
    date: fv(expForm, 'date'),
    categoryId: Number(fv(expForm, 'category')),
    type: fv(expForm, 'type') === 'essential' ? 'essential' : 'extra',
    comment: fv(expForm, 'comment').trim(),
    attachments: [...pendingAtt]
  };
  if (editingId != null) rec.id = editingId;
  try {
    await rq(st('expenses', 'readwrite').put(rec));
  } catch (_) {
    toast('Impossibile salvare: spazio esaurito o allegati troppo grandi');
    return;
  }
  ls('lastCat', String(rec.categoryId));
  expDlg.close();
  S.month = rec.date.slice(0, 7);
  await refresh();
  toast('Spesa salvata');
});

$('#expCancel').onclick = () => expDlg.close();
$('#expDelete').onclick = async () => {
  if (editingId == null || !confirm('Eliminare questa spesa e i suoi allegati?')) return;
  await rq(st('expenses', 'readwrite').delete(editingId));
  expDlg.close();
  await refresh();
  toast('Spesa eliminata');
};
expDlg.addEventListener('click', e => { if (e.target === expDlg) expDlg.close(); });

/* ---------- Anteprima allegati ---------- */
const viewDlg = $('#viewDialog');
let viewUrl = null;

function openAtt(a) {
  if (/^image\//.test(a.type)) {
    viewUrl = URL.createObjectURL(a.blob);
    $('#viewImg').src = viewUrl;
    $('#viewImg').alt = a.name;
    viewDlg.showModal();
  } else {
    download(a.name, a.blob, a.type || 'application/octet-stream');
  }
}
viewDlg.addEventListener('close', () => {
  if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = null; }
  $('#viewImg').removeAttribute('src');
});
$('#viewClose').onclick = () => viewDlg.close();
viewDlg.addEventListener('click', e => { if (e.target === viewDlg) viewDlg.close(); });

/* ---------- Categorie ---------- */
const catDlg = $('#catDialog');
const catForm = $('#catForm');

function openCat(c) {
  editingCatId = c ? c.id : null;
  $('#catTitle').textContent = c ? 'Modifica categoria' : 'Nuova categoria';
  $('#catDelete').hidden = !c;
  fs(catForm, 'catname', c ? c.name : '');
  fs(catForm, 'type', c ? c.defaultType : 'extra');
  catDlg.showModal();
  if (!c) catForm.elements.namedItem('catname').focus();
}

catForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  const name = fv(catForm, 'catname').trim();
  if (!name) return;
  if (S.cats.some(c => c.id !== editingCatId && c.name.toLowerCase() === name.toLowerCase())) {
    toast('Esiste già una categoria con questo nome');
    return;
  }
  const rec = { name, defaultType: fv(catForm, 'type') === 'essential' ? 'essential' : 'extra' };
  if (editingCatId != null) rec.id = editingCatId;
  await rq(st('categories', 'readwrite').put(rec));
  catDlg.close();
  await refresh();
  toast('Categoria salvata');
});

$('#catCancel').onclick = () => catDlg.close();
$('#catDelete').onclick = async () => {
  if (editingCatId == null) return;
  if (S.cats.length <= 1) { toast('Deve esistere almeno una categoria'); return; }
  const used = (await getAll()).filter(e => e.categoryId === editingCatId).length;
  if (used > 0) {
    toast(`Ci sono ${used} spese in questa categoria: spostale prima in un'altra`);
    return;
  }
  if (!confirm('Eliminare questa categoria?')) return;
  await rq(st('categories', 'readwrite').delete(editingCatId));
  catDlg.close();
  await refresh();
  toast('Categoria eliminata');
};
catDlg.addEventListener('click', e => { if (e.target === catDlg) catDlg.close(); });

/* ---------- Esporta / importa ---------- */
function csvCell(v) {
  const s = String(v ?? '');
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCSV(rows, filename) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const lines = ['NomeSpesa;Tipo;Categoria;Importo;Commento;Data;Allegati'].concat(sorted.map(e => [
    e.name || '',
    TYPE_LABEL[e.type],
    catName(e.categoryId),
    (e.amount / 100).toFixed(2).replace('.', ','),
    e.comment || e.note || '',
    e.date,
    (e.attachments || []).map(a => a.name).join(', ')
  ].map(csvCell).join(';')));
  download(filename, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  toast('CSV esportato');
}

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

// Il backup è un JSON costruito a pezzi (Blob concatenati) così gli allegati non gonfiano la memoria.
async function backupJSON() {
  toast('Preparo il backup…');
  const cats = await getCats();
  const exps = await getAll();
  let out = new Blob([
    `{"app":"spese","version":2,"exportedAt":${JSON.stringify(new Date().toISOString())},` +
    `"categories":${JSON.stringify(cats)},"expenses":[`
  ]);
  for (let i = 0; i < exps.length; i++) {
    const e = exps[i];
    const atts = [];
    for (const a of e.attachments || []) {
      atts.push({ name: a.name, type: a.type, size: a.size, data: await blobToB64(a.blob) });
    }
    out = new Blob([out, (i ? ',' : '') + JSON.stringify({ ...e, attachments: atts })]);
  }
  out = new Blob([out, ']}']);
  download(`spese-backup-${dateStr(new Date())}.json`, out, 'application/json');
  ls('lastBackup', String(Date.now()));
  render();
  toast('Backup creato');
}

function cleanCat(c) {
  const id = Number(c && c.id);
  const name = String((c && c.name) || '').trim();
  if (!Number.isInteger(id) || id < 1 || !name) return null;
  return { id, name: name.slice(0, 40), defaultType: c.defaultType === 'essential' ? 'essential' : 'extra' };
}

function cleanAtt(a) {
  try {
    if (!a || typeof a.data !== 'string' || !a.name) return null;
    const bin = atob(a.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type = String(a.type || 'application/octet-stream');
    return { name: String(a.name).slice(0, 120), type, size: bytes.length, blob: new Blob([bytes], { type }) };
  } catch (_) {
    return null;
  }
}

function cleanExp(e) {
  const id = Number(e && e.id);
  if (!e || !Number.isInteger(id) || id < 1) return null;
  if (!Number.isInteger(e.amount) || e.amount < 1) return null;
  if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || parseDate(e.date) !== e.date) return null;
  const categoryId = Number(e.categoryId);
  if (!Number.isInteger(categoryId)) return null;
  return {
    id, amount: e.amount, date: e.date, categoryId,
    name: String(e.name || '').slice(0, 80),
    type: e.type === 'essential' ? 'essential' : 'extra',
    comment: String(e.comment ?? e.note ?? '').slice(0, 500),
    attachments: (Array.isArray(e.attachments) ? e.attachments : []).map(cleanAtt).filter(Boolean)
  };
}

$('#fileJson').addEventListener('change', async ev => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || data.app !== 'spese') throw new Error('formato');
    const cats = (data.categories || []).map(cleanCat).filter(Boolean);
    const exps = (data.expenses || []).map(cleanExp).filter(Boolean);
    if (!cats.length) throw new Error('categorie');
    const files = exps.reduce((n, e) => n + e.attachments.length, 0);
    if (!confirm(`Il ripristino sostituisce tutti i dati attuali con ${exps.length} spese, ${files} allegati e ${cats.length} categorie. Continuare?`)) return;
    const t = db.transaction(['expenses', 'categories'], 'readwrite');
    t.objectStore('expenses').clear();
    t.objectStore('categories').clear();
    cats.forEach(c => t.objectStore('categories').put(c));
    exps.forEach(e => t.objectStore('expenses').put(e));
    await txDone(t);
    await refresh();
    toast('Backup ripristinato');
  } catch (_) {
    toast('File di backup non valido');
  }
});

$('#fileCsv').addEventListener('change', async ev => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const rows = parseCSV(await f.text());
    const head = rows[0] || [];
    const idx = k => head.findIndex(h => COLS[k].includes(norm(h)));
    const iD = idx('date'), iA = idx('amount'), iC = idx('category');
    const iT = idx('type'), iN = idx('name'), iM = idx('comment');
    if (rows.length < 2 || iD < 0 || iA < 0) throw new Error('intestazioni');
    const hasAtt = head.some(h => norm(h) === 'allegati');
    const cell = (r, i) => (i >= 0 ? (r[i] || '') : '').trim();

    const items = [];
    let skipped = 0;
    for (const r of rows.slice(1)) {
      const date = parseDate(cell(r, iD));
      const amount = parseAmount(cell(r, iA));
      if (!date || !amount) { skipped++; continue; }
      const category = cell(r, iC).slice(0, 40) || 'Altro';
      items.push({
        date, amount, category,
        name: cell(r, iN).slice(0, 80) || category,
        type: /^ess/i.test(cell(r, iT)) ? 'essential' : 'extra',
        comment: cell(r, iM).slice(0, 500)
      });
    }
    if (!items.length) throw new Error('vuoto');
    const notes = [];
    if (skipped) notes.push(`${skipped} righe non valide verranno ignorate`);
    if (hasAtt) notes.push('gli allegati non vengono importati');
    const extra = notes.length ? ` (${notes.join('; ')})` : '';
    if (!confirm(`Trovate ${items.length} spese${extra}. Aggiungerle a quelle esistenti? Importa lo stesso file una sola volta, per non creare doppioni.`)) return;

    const known = new Set((await getCats()).map(c => c.name.toLowerCase()));
    const missing = new Map();
    for (const it of items) {
      const k = it.category.toLowerCase();
      if (!known.has(k) && !missing.has(k)) missing.set(k, { name: it.category, defaultType: it.type });
    }
    if (missing.size) {
      const t1 = db.transaction('categories', 'readwrite');
      missing.forEach(c => t1.objectStore('categories').add(c));
      await txDone(t1);
    }
    const ids = new Map((await getCats()).map(c => [c.name.toLowerCase(), c.id]));
    const t2 = db.transaction('expenses', 'readwrite');
    items.forEach(it => t2.objectStore('expenses').add({
      name: it.name, amount: it.amount, date: it.date, categoryId: ids.get(it.category.toLowerCase()),
      type: it.type, comment: it.comment, attachments: []
    }));
    await txDone(t2);
    await refresh();
    toast(`Importate ${items.length} spese`);
  } catch (_) {
    toast('CSV non valido: servono almeno le colonne Data e Importo');
  }
});

async function wipe() {
  if (!confirm("Eliminare TUTTE le spese e i relativi allegati? L'operazione non si può annullare.")) return;
  if (!confirm('Sei sicuro? Se non hai un backup, i dati andranno persi.')) return;
  await rq(st('expenses', 'readwrite').clear());
  await refresh();
  toast('Spese eliminate');
}

/* ---------- Navigazione ---------- */
$('#prev').onclick = () => { S.month = shiftMonth(S.month, -1); refresh(); };
$('#next').onclick = () => { S.month = shiftMonth(S.month, 1); refresh(); };
$('#fab').onclick = () => openExpense(null);
document.querySelectorAll('#tabbar button').forEach(b => {
  b.onclick = () => { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); };
});

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvt = e;
  if (S.tab === 'dati') renderData();
});
window.addEventListener('appinstalled', () => { installEvt = null; if (S.tab === 'dati') renderData(); });

/* ---------- Avvio ---------- */
(async function init() {
  if (!ls('firstUse')) ls('firstUse', String(Date.now()));
  try {
    db = await openDB();
  } catch (_) {
    document.body.prepend(el('p', { class: 'fatal', text: "Impossibile aprire l'archivio locale del browser. Se stai usando la navigazione in incognito, riapri l'app in una finestra normale." }));
    return;
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await refresh();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
