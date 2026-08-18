/* Frontend estático: lee data/inventory.js (o data/inventory.json), filtra, ordena y pinta.
 * Pestañas: preowned (Pre-owned) · stock (nuevos listos para entrega) · offers (ofertas y bajadas). */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const STORAGE_KEY = 'polestar-tracker-v2';
  const VARIANT_ORDER = ['Dual Motor', 'Performance', 'Single Motor'];

  let DATA = null;
  let all = [];            // todos los vehículos (con campos derivados)
  let sales = [];          // histórico de retirados/vendidos (public/data/sales.json)
  let SALES = null;
  let tab = 'preowned';
  let sortKey = 'priceEur';
  let sortDesc = false;
  const expanded = new Set();

  // ---------- estado / persistencia ----------
  function defaultFilters() {
    return {
      models: null,       // null = todos; si no, array de valores permitidos
      variants: null,
      years: null,
      countries: 'europe', // 'europe' = preset por defecto (se resuelve al cargar)
      hideSingle: false,
      hideCoupe: false,
      vatOnly: false,
      campaignOnly: false,
      onlyNew: false,      // solo aparecidos en el último refresco
      onlyDrops: false,    // solo con bajada de precio respecto al refresco anterior
      priceMax: '',
      kmMax: '',
      text: '',
    };
  }
  const state = Object.assign({ tab: 'preowned', sort: {} , filters: defaultFilters() }, loadState() || {});
  // Completar con valores por defecto por si el estado guardado es de una versión con menos campos.
  state.filters = Object.assign(defaultFilters(), state.filters && typeof state.filters === 'object' ? state.filters : {});
  if (!state.sort || typeof state.sort !== 'object') state.sort = {};
  function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; } }
  function saveState() {
    state.tab = tab;
    state.sort[tab] = { key: sortKey, desc: sortDesc };
    // Sin almacenamiento (modo privado, cuota, storage bloqueado) la web debe seguir funcionando, solo sin persistir.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }
  const F = () => state.filters;

  // ---------- carga ----------
  async function loadData() {
    if (window.__INVENTORY__) return window.__INVENTORY__;
    try {
      const r = await fetch('data/inventory.json', { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch { /* ignore */ }
    return null;
  }

  async function loadSales() {
    if (window.__SALES__) return window.__SALES__;
    try { const r = await fetch('data/sales.json', { cache: 'no-store' }); if (r.ok) return await r.json(); } catch { /* ignore */ }
    return { sales: [], trackingSince: null };
  }
  function decorateSale(x) {
    return {
      ...x,
      packs: [], bundles: [], options: [], packsStr: '', priceChange: 0, isOffer: false, isNew: false, isDrop: false, isRecent: false,
      flags: x.flags || {}, removedTs: Date.parse(x.removedAt) || 0,
      _search: [x.model, x.variant, x.color, x.countryName, x.country, x.vin, x.modelYear, x.source].join(' ').toLowerCase(),
    };
  }

  // ---------- formato ----------
  // Los formateadores Intl se crean una sola vez: construirlos por celda costaba ~50 µs cada uno (×3000 por render).
  const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0, useGrouping: 'always' });
  const moneyFmt = new Map();
  const cc = (code) => `<span class="cc">${esc(String(code || '').toUpperCase())}</span>`;
  function fmtMoney(v, cur) {
    if (v == null) return '—';
    cur = cur || 'EUR';
    let f = moneyFmt.get(cur);
    if (f === undefined) {
      try { f = new Intl.NumberFormat('es-ES', { style: 'currency', currency: cur, maximumFractionDigits: 0, useGrouping: 'always' }); } catch { f = null; }
      moneyFmt.set(cur, f);
    }
    return f ? f.format(v) : nf0.format(v) + ' ' + esc(cur);
  }
  const DF_MONTH = new Intl.DateTimeFormat('es-ES', { month: '2-digit', year: 'numeric' });
  const DF_DAY = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const DF_DATETIME = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? esc(iso) : DF_MONTH.format(d);
  }
  function fmtDay(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? esc(iso) : DF_DAY.format(d);
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? 'Invalid Date' : DF_DATETIME.format(d);
  }
  const ESC_RE = /[&<>"']/g;
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(ESC_RE, (c) => ESC_MAP[c]);
  const collator = new Intl.Collator('es');

  // ---------- derivados ----------
  function decorate(v) {
    // Bajada de precio "relevante": desde el máximo visto por el tracker (pre-owned) o descuento sobre lista (stock).
    let dropAbs = 0, dropPct = 0, dropRef = null, dropWhen = null;
    if (v.source === 'stock') {
      dropAbs = v.discount || 0; dropRef = v.listPrice; dropPct = v.discountPct || 0;
    } else {
      const ref = v.priceMax != null && isFinite(v.priceMax) ? v.priceMax : null;
      if (ref != null && v.price != null && ref > v.price) { dropAbs = ref - v.price; dropRef = ref; dropPct = Math.round((dropAbs / ref) * 1000) / 10; dropWhen = v.priceChangeAt; }
    }
    const rec = {
      ...v,
      // public/data/* omite el histórico cuando solo tiene la entrada inicial (ver slimForWeb en src/fetch.js).
      priceHistory: v.priceHistory || [{ t: v.firstSeen, price: v.price, currency: v.currency }],
      packsStr: (v.packs || []).join(', '),
      dropAbs, dropPct, dropRef, dropWhen,
      dropAbsEur: dropAbs ? Math.round(dropAbs * (DATA.fxToEur[v.currency] || 1)) : 0,
      isOffer: dropAbs > 0,
      // "nuevo" = visto por primera vez en el último refresco (si es el primer refresco de la historia, nada es "nuevo").
      isNew: v.firstSeen === DATA.generatedAt && !!DATA.previousGeneratedAt,
      // "bajada" = precio menor que en el refresco anterior (cambio detectado en este refresco).
      isDrop: v.priceChange < 0 && v.priceChangeAt === DATA.generatedAt,
      // Últimas 24 h: nuevos (posteriores al primer refresco de la historia) o bajadas de precio en esa ventana.
      isNew24: !!v.firstSeen && DATA.trackingSince != null && v.firstSeen > DATA.trackingSince && (GEN_TS - Date.parse(v.firstSeen)) <= H24,
      isDrop24: v.priceChange < 0 && !!v.priceChangeAt && (GEN_TS - Date.parse(v.priceChangeAt)) <= H24,
      _search: [v.model, v.displayName, v.variant, v.motorLabel, v.color, v.interior, v.wheels, v.location, v.partner, v.countryName, v.country, v.vin, (v.packs || []).join(' '), (v.bundles || []).join(' '), (v.options || []).join(' '), v.modelYear, v.delivery].join(' ').toLowerCase(),
    };
    rec.isRecent = rec.isNew24 || rec.isDrop24;
    // Para ordenar la pestaña "Últimas 24 h": momento del cambio más reciente.
    rec.recentAt = rec.isDrop24 ? v.priceChangeAt : rec.isNew24 ? v.firstSeen : null;
    rec.recentTs = rec.recentAt ? Date.parse(rec.recentAt) : null;
    return rec;
  }
  const H24 = 24 * 3600 * 1000;
  let GEN_TS = 0;

  const inTab = (v) => tab === 'sales' ? true : tab === 'offers' ? v.isOffer : tab === 'recent' ? v.isRecent : v.source === tab;
  const poolFor = (t) => (t === 'sales' ? sales : all);
  const tabCount = { preowned: 0, stock: 0, offers: 0, recent: 0, sales: 0 }; // se rellena al cargar
  const byId = new Map();

  // ---------- filtros ----------
  function uniqueSorted(arr, cmp) { return [...new Set(arr)].sort(cmp); }
  const modelName = (s) => (DATA.models && Object.values(DATA.models).find((m) => m.short === s)?.name) || s;

  function buildFilterUI() {
    const pool = poolFor(tab).filter(inTab);
    const models = uniqueSorted(all.map((v) => v.modelShort));
    const variants = uniqueSorted(all.map((v) => v.variant), (a, b) => {
      const ia = VARIANT_ORDER.indexOf(a), ib = VARIANT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const years = uniqueSorted(all.map((v) => v.modelYear).filter((y) => y != null), (a, b) => a - b);
    const marketList = Object.values(DATA.markets);
    const count = (fn) => pool.filter(fn).length;

    renderCheckGroup('#f-model', models.map((m) => ({ value: m, label: modelName(m), count: count((v) => v.modelShort === m) })), 'models');
    renderCheckGroup('#f-variant', variants.map((x) => ({ value: x, label: x === 'Single Motor' ? 'Single / Rear motor' : x, count: count((v) => v.variant === x) })), 'variants');
    renderCheckGroup('#f-year', years.map((y) => ({ value: String(y), label: String(y), count: count((v) => v.modelYear === y) })), 'years');
    renderCheckGroup('#f-country', marketList.map((m) => ({
      value: m.code, label: m.name, count: count((v) => v.country === m.code),
      title: m.status === 'error' ? 'Error al consultar: ' + m.errors.join(' | ') : m.note || '',
    })), 'countries');

    $('#f-hide-single').checked = F().hideSingle;
    $('#f-hide-coupe').checked = F().hideCoupe;
    $('#f-vat').checked = F().vatOnly;
    $('#f-campaign').checked = F().campaignOnly;
    $('#f-new').checked = F().onlyNew;
    $('#f-drops').checked = F().onlyDrops;
    $('#f-price-max').value = F().priceMax;
    $('#f-km-max').value = F().kmMax;
    $('#f-text').value = F().text;
    $$('.only-preowned').forEach((el) => el.classList.toggle('hidden', tab === 'stock'));
    $$('.only-stock').forEach((el) => el.classList.toggle('hidden', tab === 'preowned'));
    updateQuickButtons();
  }

  function renderCheckGroup(sel, opts, key) {
    const sel_ = F()[key];
    $(sel).innerHTML = opts.map((o) => {
      const checked = sel_ == null || sel_.includes(o.value);
      return `<label class="${o.count ? '' : 'zero'}" title="${esc(o.title || '')}"><input type="checkbox" data-key="${key}" value="${esc(o.value)}" ${checked ? 'checked' : ''}/> ${key === 'countries' ? cc(o.value) + ' ' : ''}${esc(o.label)} <span class="cnt">${o.count}</span></label>`;
    }).join('');
  }

  function readGroup(key) {
    const boxes = $$(`input[data-key="${key}"]`);
    const checked = boxes.filter((b) => b.checked).map((b) => b.value);
    return checked.length === boxes.length ? null : checked;
  }

  function readFiltersFromUI() {
    const f = F();
    f.models = readGroup('models');
    f.variants = readGroup('variants');
    f.years = readGroup('years');
    f.countries = readGroup('countries');
    f.hideSingle = $('#f-hide-single').checked;
    f.hideCoupe = $('#f-hide-coupe').checked;
    f.vatOnly = $('#f-vat').checked;
    f.campaignOnly = $('#f-campaign').checked;
    f.onlyNew = $('#f-new').checked;
    f.onlyDrops = $('#f-drops').checked;
    f.priceMax = $('#f-price-max').value;
    f.kmMax = $('#f-km-max').value;
    f.text = $('#f-text').value.trim();
    saveState();
    updateQuickButtons();
  }

  function countriesForPreset(mode) {
    const ms = Object.values(DATA.markets);
    if (mode === 'europe') return ms.filter((m) => m.europe).map((m) => m.code);
    if (mode === 'eu') return ms.filter((m) => m.eu).map((m) => m.code);
    if (mode === 'all') return ms.map((m) => m.code);
    if (mode === 'es') return ms.filter((m) => m.code === 'es').map((m) => m.code);
    return [];
  }
  function updateQuickButtons() {
    const cur = $$('input[data-key="countries"]').filter((b) => b.checked).map((b) => b.value).sort().join(',');
    $$('[data-quick-group="countries"]').forEach((btn) => {
      const preset = countriesForPreset(btn.dataset.quick).sort().join(',');
      btn.classList.toggle('on', preset === cur && (cur || btn.dataset.quick === 'none'));
    });
  }

  function applyFilters() {
    const f = F();
    const priceMax = f.priceMax ? Number(f.priceMax) : null;
    const kmMax = f.kmMax ? Number(f.kmMax) : null;
    const q = f.text.toLowerCase();
    return poolFor(tab).filter((v) => {
      if (!inTab(v)) return false;
      if (f.models && !f.models.includes(v.modelShort)) return false;
      if (f.variants && !f.variants.includes(v.variant)) return false;
      if (f.years && !f.years.includes(String(v.modelYear))) return false;
      if (f.countries && !f.countries.includes(v.country)) return false;
      if (f.hideSingle && v.flags.single) return false;
      if (f.hideCoupe && v.flags.coupe) return false;
      if (tab !== 'sales') {
        if (f.vatOnly && tab !== 'stock' && v.source === 'preowned' && !v.vatDeductible) return false;
        if (f.campaignOnly && tab !== 'preowned' && v.source === 'stock' && !(v.discount > 0)) return false;
        if (f.onlyNew && !v.isNew) return false;
        if (f.onlyDrops && !v.isDrop) return false;
      }
      if (priceMax != null && (v.priceEur == null || v.priceEur > priceMax)) return false;
      if (kmMax != null && v.source === 'preowned' && (v.mileageKm == null || v.mileageKm > kmMax)) return false;
      if (q && !v._search.includes(q)) return false;
      return true;
    });
  }

  function sortRows(rows) {
    const dir = sortDesc ? -1 : 1;
    const key = sortKey;
    const cmp = collator.compare;
    // Array.prototype.sort es estable; desempate por precio en EUR como siempre.
    return rows.slice().sort((a, b) => {
      let x = a[key], y = b[key];
      if (x == null) return y == null ? 0 : 1;
      if (y == null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir || (a.priceEur ?? 0) - (b.priceEur ?? 0);
      if (typeof x !== 'string') x = String(x);
      if (typeof y !== 'string') y = String(y);
      return cmp(x, y) * dir || (a.priceEur ?? 0) - (b.priceEur ?? 0);
    });
  }

  // ---------- columnas por pestaña ----------
  const thumb = (v) => { const img = v.imageStudio || v.imagePhoto; return img ? `<img loading="lazy" decoding="async" width="84" height="46" src="${esc(img)}" alt="" />` : ''; };
  const modelCell = (v) => `<b>${esc(v.model)}</b>${badges(v)}<span class="sub">${esc(v.motorLabel || v.displayName || '')}</span>`;
  const variantCell = (v) => `${esc(v.variant)}${(v.packs || []).includes('Performance') && v.variant !== 'Performance' ? `<span class="badge perf" title="Pack Performance">Perf</span>` : ''}`;
  const kmCell = (v) => v.source === 'stock' ? '<span class="muted">nuevo</span>' : `${v.mileageKm != null ? nf0.format(v.mileageKm) : '—'}${v.mileageUnit === 'mi' ? `<span class="sub">${nf0.format(v.mileageRaw)} mi</span>` : ''}`;
  const priceCell = (v) => `${fmtMoney(v.price, v.currency)}${v.source === 'preowned' && v.vatDeductible ? '<span class="sub" title="IVA deducible">IVA ded.</span>' : ''}${v.source === 'stock' && v.discount > 0 ? `<span class="sub strike">${fmtMoney(v.listPrice, v.currency)}</span>` : ''}`;
  const eurCell = (v) => v.currency === 'EUR' ? '' : fmtMoney(v.priceEur, 'EUR');
  const packsCell = (v) => (v.packs || []).map((p) => `<span class="badge pack">${esc(p)}</span>`).join('') + (v.bundles || []).map((b) => `<span class="badge bundle" title="Bundle">${esc(b)}</span>`).join('');
  const countryCell = (v) => `${cc(v.country)} ${esc(v.countryName)}`;
  const linkCell = (v) => `<a class="lnk" href="${esc(v.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ficha ↗</a>`;
  const deliveryCell = (v) => v.source === 'stock' ? esc(v.delivery || '—') : fmtDate(v.firstRegistration);
  const dropCell = (v) => v.dropAbs ? `<span class="disc">−${fmtMoney(v.dropAbs, v.currency)}</span>${v.dropRef ? `<span class="sub">antes ${fmtMoney(v.dropRef, v.currency)}</span>` : ''}` : '—';

  const COLUMNS = {
    preowned: [
      { key: null, label: '', cls: 'thumb', render: thumb },
      { key: 'model', label: 'Modelo', render: modelCell },
      { key: 'variant', label: 'Versión', render: variantCell },
      { key: 'modelYear', label: 'MY', cls: 'num', render: (v) => v.modelYear ?? '—' },
      { key: 'firstRegistration', label: 'Matric.', render: (v) => fmtDate(v.firstRegistration) },
      { key: 'mileageKm', label: 'Km', cls: 'num', render: kmCell },
      { key: 'price', label: 'Precio', cls: 'num price', render: priceCell },
      { key: 'priceEur', label: '≈ EUR', cls: 'num', render: eurCell },
      { key: 'color', label: 'Color', render: (v) => esc(v.color || '—') },
      { key: 'packsStr', label: 'Packs', render: packsCell },
      { key: 'location', label: 'Ubicación', cls: 'loc', render: (v) => `<span class="ell" title="${esc((v.location || '') + (v.partner ? ' · ' + v.partner : ''))}">${esc(v.location || '—')}</span>` },
      { key: 'countryName', label: 'País', render: countryCell },
      { key: 'daysListed', label: 'Días', cls: 'num', title: 'Días desde que este tracker lo vio por primera vez', render: (v) => v.daysListed ?? '—' },
      { key: null, label: '', render: linkCell },
    ],
    stock: [
      { key: null, label: '', cls: 'thumb', render: thumb },
      { key: 'model', label: 'Modelo', render: modelCell },
      { key: 'variant', label: 'Versión', render: variantCell },
      { key: 'modelYear', label: 'MY', cls: 'num', render: (v) => v.modelYear ?? '—' },
      { key: 'deliveryDate', label: 'Entrega', render: (v) => esc(v.delivery || '—') },
      { key: 'price', label: 'Precio', cls: 'num price', render: (v) => fmtMoney(v.price, v.currency) },
      { key: 'listPrice', label: 'P. lista', cls: 'num', render: (v) => v.discount > 0 ? `<span class="strike">${fmtMoney(v.listPrice, v.currency)}</span>` : fmtMoney(v.listPrice, v.currency) },
      { key: 'dropPct', label: 'Dto.', cls: 'num', render: (v) => v.discount > 0 ? `<span class="disc">−${fmtMoney(v.discount, v.currency)}</span><span class="sub">−${v.discountPct}%</span>` : '—' },
      { key: 'priceEur', label: '≈ EUR', cls: 'num', render: eurCell },
      { key: 'color', label: 'Color', render: (v) => esc(v.color || '—') },
      { key: 'packsStr', label: 'Packs', render: packsCell },
      { key: 'countryName', label: 'País', render: countryCell },
      { key: 'daysListed', label: 'Días', cls: 'num', title: 'Días desde que este tracker lo vio por primera vez', render: (v) => v.daysListed ?? '—' },
      { key: null, label: '', render: linkCell },
    ],
    offers: [
      { key: null, label: '', cls: 'thumb', render: thumb },
      { key: 'source', label: 'Tipo', render: (v) => `<span class="badge src">${v.source === 'stock' ? 'nuevo' : 'pre-owned'}</span>` },
      { key: 'model', label: 'Modelo', render: modelCell },
      { key: 'variant', label: 'Versión', render: variantCell },
      { key: 'modelYear', label: 'MY', cls: 'num', render: (v) => v.modelYear ?? '—' },
      { key: 'mileageKm', label: 'Km / entrega', cls: 'num', render: (v) => v.source === 'stock' ? esc(v.delivery || 'nuevo') : kmCell(v) },
      { key: 'price', label: 'Precio ahora', cls: 'num price', render: (v) => fmtMoney(v.price, v.currency) },
      { key: 'dropAbsEur', label: 'Bajada', cls: 'num', render: dropCell },
      { key: 'dropPct', label: '%', cls: 'num', render: (v) => v.dropPct ? `<span class="disc">−${v.dropPct}%</span>` : '—' },
      { key: 'dropWhen', label: 'Cuándo', render: (v) => v.source === 'stock' ? '<span class="muted">campaña</span>' : fmtDay(v.dropWhen) },
      { key: 'priceEur', label: '≈ EUR', cls: 'num', render: eurCell },
      { key: 'packsStr', label: 'Packs', render: packsCell },
      { key: 'countryName', label: 'País', render: countryCell },
      { key: null, label: '', render: linkCell },
    ],
  };
  COLUMNS.recent = [
    { key: null, label: '', cls: 'thumb', render: thumb },
    { key: 'recentTs', label: 'Cambio', render: (v) => (v.isDrop24 ? `<span class="badge kind-drop">▼ bajada</span>` : '') + (v.isNew24 ? `<span class="badge kind-new">nuevo</span>` : '') + `<span class="sub">${v.recentAt ? fmtDateTime(v.recentAt) : ''}</span>` },
    { key: 'source', label: 'Tipo', render: (v) => `<span class="badge src">${v.source === 'stock' ? 'nuevo (stock)' : 'pre-owned'}</span>` },
    { key: 'model', label: 'Modelo', render: modelCell },
    { key: 'variant', label: 'Versión', render: variantCell },
    { key: 'modelYear', label: 'MY', cls: 'num', render: (v) => v.modelYear ?? '—' },
    { key: 'mileageKm', label: 'Km / entrega', cls: 'num', render: (v) => v.source === 'stock' ? esc(v.delivery || 'nuevo') : kmCell(v) },
    { key: 'price', label: 'Precio ahora', cls: 'num price', render: (v) => fmtMoney(v.price, v.currency) },
    { key: 'priceChange', label: 'Variación', cls: 'num', render: (v) => v.priceChange < 0 ? `<span class="disc">−${fmtMoney(-v.priceChange, v.currency)}</span><span class="sub">antes ${fmtMoney(v.price - v.priceChange, v.currency)}</span>` : (v.priceChange > 0 ? `<span class="badge rise">▲ ${fmtMoney(v.priceChange, v.currency)}</span>` : '—') },
    { key: 'priceEur', label: '≈ EUR', cls: 'num', render: eurCell },
    { key: 'color', label: 'Color', render: (v) => esc(v.color || '—') },
    { key: 'packsStr', label: 'Packs', render: packsCell },
    { key: 'countryName', label: 'País', render: countryCell },
    { key: null, label: '', render: linkCell },
  ];
  const thumbSale = (v) => v.image ? `<img loading="lazy" decoding="async" width="84" height="46" src="${esc(v.image)}" alt="" />` : '';
  COLUMNS.sales = [
    { key: null, label: '', cls: 'thumb', render: thumbSale },
    { key: 'removedTs', label: 'Retirado', render: (v) => fmtDateTime(v.removedAt) },
    { key: 'source', label: 'Tipo', render: (v) => `<span class="badge src">${v.source === 'stock' ? 'nuevo (stock)' : 'pre-owned'}</span>` },
    { key: 'model', label: 'Modelo', render: (v) => `<b>${esc(v.model)}</b>${v.flags.coupe ? '<span class="badge warn">MY27/Coupé</span>' : ''}${v.partial ? '<span class="sub muted">retirado antes de guardar detalles</span>' : ''}` },
    { key: 'variant', label: 'Versión', render: (v) => esc(v.variant || '—') },
    { key: 'modelYear', label: 'MY', cls: 'num', render: (v) => v.modelYear ?? '—' },
    { key: 'mileageKm', label: 'Km', cls: 'num', render: (v) => v.source === 'stock' ? '<span class="muted">nuevo</span>' : (v.mileageKm != null ? nf0.format(v.mileageKm) : '—') },
    { key: 'price', label: 'Último precio', cls: 'num price', render: (v) => fmtMoney(v.price, v.currency) + (v.priceHistory && v.priceHistory.length > 1 ? `<span class="sub">inicial ${fmtMoney(v.priceHistory[0].price, v.currency)}</span>` : '') },
    { key: 'color', label: 'Color', render: (v) => esc(v.color || '—') },
    { key: 'daysListed', label: 'Días en venta', cls: 'num', title: 'Días entre la primera vez que el tracker lo vio y su retirada', render: (v) => v.daysListed ?? '—' },
    { key: 'countryName', label: 'País', render: countryCell },
    { key: null, label: '', render: (v) => v.url ? `<a class="lnk" href="${esc(v.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="La ficha puede ya no existir">Ficha ↗</a>` : '' },
  ];
  const DEFAULT_SORT = { preowned: { key: 'priceEur', desc: false }, stock: { key: 'priceEur', desc: false }, offers: { key: 'dropPct', desc: true }, recent: { key: 'recentTs', desc: true }, sales: { key: 'removedTs', desc: true } };

  // ---------- render ----------
  function badges(v) {
    let b = '';
    if (v.flags.coupe) b += `<span class="badge warn" title="Polestar 4 MY2027/Coupé: sin suspensión semiactiva de serie en Dual Motor">MY27/Coupé</span>`;
    if (v.flags.rhd) b += `<span class="badge rhd" title="Volante a la derecha">RHD</span>`;
    else if (v.flags.nonEu) b += `<span class="badge import" title="Fuera de la UE: aduanas/IVA al importar">no UE</span>`;
    if (v.source === 'stock' && v.discount > 0) b += `<span class="badge offer" title="Descuento sobre precio de lista">oferta −${v.discountPct}%</span>`;
    if (v.priceChange < 0) b += `<span class="badge drop" title="Bajó ${fmtMoney(-v.priceChange, v.currency)} el ${fmtDay(v.priceChangeAt)}${v.isDrop ? ' (último refresco)' : ''}">▼ ${fmtMoney(-v.priceChange, v.currency)}</span>`;
    else if (v.priceChange > 0) b += `<span class="badge rise" title="Subió ${fmtMoney(v.priceChange, v.currency)} el ${fmtDay(v.priceChangeAt)}">▲ ${fmtMoney(v.priceChange, v.currency)}</span>`;
    if (v.isNew) b += `<span class="badge new">nuevo</span>`;
    return b;
  }

  let headerDone = false;
  let chipsKey = null;   // último estado pintado de las chips (pestaña + países) para no reconstruirlas sin cambios
  let headKey = null;    // ídem cabecera de la tabla (pestaña + orden)
  const countByCountryTab = new Map(); // "tab|country" → nº vehículos (no depende de los filtros)
  function countryCount(code) {
    const k = tab + '|' + code;
    let n = countByCountryTab.get(k);
    if (n === undefined) { n = 0; for (const v of poolFor(tab)) if (v.country === code && inTab(v)) n++; countByCountryTab.set(k, n); }
    return n;
  }

  function renderHeader() {
    if (!headerDone) {
      headerDone = true;
      const sc = DATA.scope;
      const scopeTxt = sc ? ` · <span class="scope" title="Último refresco parcial: solo ${sc.markets.join(', ').toUpperCase()} · ${sc.models.join(', ')}${sc.source ? ' · ' + (sc.source === 'stock' ? 'stock' : 'pre-owned') : ''}. El resto de datos son del refresco anterior.">parcial: ${sc.markets.map((m) => m.toUpperCase()).join(', ')} · ${sc.models.join(', ')}${sc.source ? ' · ' + (sc.source === 'stock' ? 'stock' : 'pre-owned') : ''}</span>` : '';
      const rf = DATA.refreshes || {};
      const esAt = rf.markets && rf.markets.es;
      const fullAt = rf.full;
      let txt;
      if (esAt || fullAt) {
        // Refrescos por alcance: general (todos los mercados) y España (cada pocos minutos).
        txt = `Actualizado: general <b>${fullAt ? fmtDateTime(fullAt) : '—'}</b> · España <b>${esAt ? fmtDateTime(esAt) : '—'}</b> <span class="muted">(último run: ${fmtDateTime(DATA.generatedAt)}, ${DATA.durationSec}s, ${DATA.requestCount} requests)${scopeTxt}</span>`;
      } else {
        txt = `Actualizado: <b>${fmtDateTime(DATA.generatedAt)}</b> <span class="muted">(${DATA.durationSec}s, ${DATA.requestCount} requests)${scopeTxt}</span>`;
      }
      $('#updated').innerHTML = txt;
      $('#cnt-preowned').textContent = tabCount.preowned;
      $('#cnt-stock').textContent = tabCount.stock;
      $('#cnt-offers').textContent = tabCount.offers;
      $('#cnt-recent').textContent = tabCount.recent;
      $('#cnt-sales').textContent = tabCount.sales;
    }
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    renderStats();

    const f = F();
    const key = tab + '|' + (f.countries ? f.countries.join(',') : '*');
    if (key === chipsKey) return;
    chipsKey = key;
    $('#market-chips').innerHTML = Object.values(DATA.markets).map((m) => {
      const n = countryCount(m.code);
      const off = f.countries && !f.countries.includes(m.code);
      const cls = ['chip', m.status, off ? 'off' : '', m.stale ? 'stale' : ''].join(' ');
      const title = m.status === 'error' ? 'ERROR: ' + m.errors.join(' | ') : m.status === 'partial' ? 'Parcial: ' + m.errors.join(' | ') : (m.note || `${m.name}`);
      const by = m.bySource ? Object.entries(m.bySource).map(([k, n]) => `${k} ${n}`).join(' · ') : '';
      return `<span class="${cls}" data-country="${esc(m.code)}" title="${esc(title)}${by ? ' (' + esc(by) + ')' : ''}${m.stale ? ' — datos del refresco anterior' : ''}">${cc(m.code)} ${esc(m.name)} <b>${m.status === 'error' ? '✗' : n}</b></span>`;
    }).join('');
  }

  function renderStats() {
    const t = DATA.totals || {};
    const f = F();
    const prev = DATA.previousGeneratedAt ? 'respecto al refresco anterior (' + fmtDateTime(DATA.previousGeneratedAt) + ')' : 'primer refresco: sin comparación';
    const stat = (key, label, n, on) => `<span class="stat ${on ? 'on' : ''} ${n ? '' : 'zero'}" data-stat="${key}" title="${esc(prev)}. Clic para ${on ? 'quitar el filtro' : 'ver cuáles son'}">${label} <b>${n}</b></span>`;
    $('#totals').innerHTML = stat('new', 'nuevos', t.added ?? 0, f.onlyNew) + ' · ' + stat('removed', 'retirados', t.removed ?? 0, !$('#removed-panel').classList.contains('hidden')) + ' · ' + stat('drops', 'bajadas', t.priceDrops ?? 0, f.onlyDrops);
  }

  function renderRemoved() {
    const list = DATA.removed || [];
    $('#removed-info').textContent = list.length ? `${list.length} vehículos que estaban el ${DATA.previousGeneratedAt ? fmtDateTime(DATA.previousGeneratedAt) : '—'} y ya no aparecen (vendidos o retirados del anuncio)` : 'ninguno';
    $('#removed-rows').innerHTML = list.map((v) => `<tr>
      <td class="thumb">${v.imageStudio ? `<img loading="lazy" decoding="async" width="64" height="36" src="${esc(v.imageStudio)}" alt="" />` : ''}</td>
      <td><span class="badge src">${v.source === 'stock' ? 'nuevo' : 'pre-owned'}</span></td>
      <td><b>${esc(v.model)}</b></td><td>${esc(v.variant || '')}</td><td class="num">${v.modelYear ?? '—'}</td>
      <td class="num">${v.source === 'stock' ? '<span class="muted">nuevo</span>' : (v.mileageKm != null ? nf0.format(v.mileageKm) : '—')}</td>
      <td class="num price">${fmtMoney(v.price, v.currency)}</td><td>${esc(v.color || '—')}</td><td>${esc(v.location || '—')}</td>
      <td>${cc(v.country)} ${esc(v.countryName || '')}</td><td class="num">${v.daysListed ?? '—'}</td>
      <td><a class="lnk" href="${esc(v.url)}" target="_blank" rel="noopener">Ficha ↗</a></td></tr>`).join('');
  }

  function renderSummary(rows) {
    const byCountry = {};
    let minEur = Infinity, sumEur = 0, n = 0;
    for (const v of rows) {
      byCountry[v.country] = (byCountry[v.country] || 0) + 1;
      if (v.priceEur != null) { if (v.priceEur < minEur) minEur = v.priceEur; sumEur += v.priceEur; n++; }
    }
    const per = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${cc(c)} ${k}`).join(' · ');
    const total = tabCount[tab];
    $('#summary').innerHTML = `<span>Mostrando <b>${rows.length}</b> de ${total}</span>` +
      (n ? `<span>Desde <b>${fmtMoney(minEur, 'EUR')}</b> · media <b>${fmtMoney(Math.round(sumEur / n), 'EUR')}</b></span>` : '') +
      (per ? `<span>${per}</span>` : '');
  }

  function renderHead() {
    const key = tab + '|' + sortKey + '|' + sortDesc;
    if (key === headKey) return;
    headKey = key;
    const cols = COLUMNS[tab];
    $('#thead-row').innerHTML = cols.map((c) => {
      const cls = [c.cls || '', c.key ? '' : 'nosort', c.key && c.key === sortKey ? 'sorted' : '', c.key && c.key === sortKey && sortDesc ? 'desc' : ''].filter(Boolean).join(' ');
      return `<th ${c.key ? `data-sort="${c.key}"` : ''} class="${cls}" title="${esc(c.title || '')}">${c.label}</th>`;
    }).join('');
  }

  function rowHtml(v) {
    const cols = COLUMNS[tab];
    const cls = ['main', v.flags.single ? 'single' : ''].join(' ');
    return `<tr class="${cls}" data-id="${esc(v.id)}">${cols.map((c) => `<td class="${c.cls || ''}">${c.render(v)}</td>`).join('')}</tr>`;
  }

  function detailHtml(v) {
    const ph = (v.priceHistory || []).map((p) => `${fmtDay(p.t)}: ${fmtMoney(p.price, p.currency)}`).join(' → ');
    const img = v.imagePhoto || v.imageStudio;
    return `<tr class="detail" data-for="${esc(v.id)}"><td colspan="${COLUMNS[tab].length}"><div class="dgrid">
      ${img ? `<img class="photo ${v.imagePhoto ? '' : 'contain'}" loading="lazy" decoding="async" width="220" height="140" src="${esc(img)}" alt="" />` : '<div></div>'}
      <dl>
        ${v.source === 'preowned' ? `<dt>VIN</dt><dd><code>${esc(v.vin || '—')}</code></dd>` : `<dt>Configuración</dt><dd><code>${esc(v.pno34 || '—')}</code> · MY${v.modelYear ?? '?'} · semana ${esc(v.structureWeek || '?')}</dd>`}
        <dt>Modelo</dt><dd>${esc(v.displayName || v.model)} · ${esc(v.motorLabel || v.variant)}</dd>
        <dt>Interior</dt><dd>${esc(v.interior || '—')}</dd>
        <dt>Llantas</dt><dd>${esc(v.wheels || '—')}</dd>
        <dt>Tracción / potencia</dt><dd>${esc(v.drivetrain || '—')} · ${esc(v.power || '—')} · ${esc(v.acceleration || '—')}${v.rangeKm ? ' · ' + esc(v.rangeKm) + ' km WLTP' : ''}</dd>
        <dt>Packs</dt><dd>${(v.packs || []).length ? v.packs.map(esc).join(', ') : '—'}${(v.bundles || []).length ? ' · bundles: ' + v.bundles.map(esc).join(', ') : ''}</dd>
        <dt>Opciones</dt><dd>${(v.options || []).length ? v.options.map(esc).join(', ') : '—'}</dd>
        ${v.source === 'preowned' ? `<dt>Entrega / vendedor</dt><dd>${esc(v.location || '—')} · ${esc(v.partner || '—')}${v.vatDeductible ? ' · IVA deducible' : ''}</dd>` : `<dt>Entrega estimada</dt><dd>${esc(v.delivery || '—')}${v.deliveryDate ? ' (' + fmtDay(v.deliveryDate) + ')' : ''}</dd>`}
        ${v.source === 'stock' ? `<dt>Precio</dt><dd>${fmtMoney(v.price, v.currency)}${v.discount > 0 ? ` · lista ${fmtMoney(v.listPrice, v.currency)} · <b class="disc">−${fmtMoney(v.discount, v.currency)} (−${v.discountPct}%)</b>` : ' (sin descuento)'}</dd>` : ''}
        <dt>Seguimiento</dt><dd>Visto por primera vez ${v.firstSeen ? fmtDateTime(v.firstSeen) : '—'} (${v.daysListed ?? '?'} días)${v.versionTimestamp ? ' · anuncio actualizado ' + fmtDateTime(v.versionTimestamp) : ''}</dd>
        <dt>Histórico precio</dt><dd>${ph || '—'}</dd>
        <dt>Enlace</dt><dd><a class="lnk" href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.url)}</a></dd>
      </dl></div></td></tr>`;
  }

  // Pintado progresivo: el coste dominante es el layout de la tabla (~0,25 ms/fila), así que se pintan las
  // primeras PAGE filas y el resto bajo demanda (botones "Mostrar más" / al llegar al final). Orden, contador y
  // resumen se calculan siempre sobre el total filtrado.
  const PAGE = 300;
  const view = { rows: [], shown: 0 };

  function renderRows(limit) {
    const rows = view.rows;
    const end = Math.min(rows.length, limit);
    if (end > view.shown) {
      let html = '';
      for (let i = view.shown; i < end; i++) { const v = rows[i]; html += rowHtml(v); if (expanded.has(v.id)) html += detailHtml(v); }
      if (view.shown === 0) $('#rows').innerHTML = html; else $('#rows').insertAdjacentHTML('beforeend', html);
      view.shown = end;
    }
    const rest = rows.length - view.shown;
    const more = $('#more');
    more.classList.toggle('hidden', rest <= 0);
    if (rest > 0) {
      $('#more-info').textContent = `Mostrando ${view.shown} de ${rows.length} filas`;
      $('#more-page').textContent = `Mostrar ${Math.min(PAGE, rest)} más`;
      $('#more-all').textContent = `Mostrar todas (${rest} restantes)`;
    }
  }

  function render() {
    const rows = sortRows(applyFilters());
    renderHeader();
    $('#sales-panel').classList.toggle('hidden', tab !== 'sales');
    if (tab === 'sales') renderSalesPanel(rows);
    renderSummary(rows);
    renderHead();
    view.rows = rows; view.shown = 0;
    if (!rows.length) $('#rows').innerHTML = '';
    renderRows(PAGE);
    $('#empty').classList.toggle('hidden', rows.length > 0);
    $('#empty').textContent = tab === 'recent' && !tabCount.recent
      ? 'Sin cambios en las últimas 24 horas (nuevos o bajadas de precio). Se detectan comparando refrescos: cuantos más refrescos al día, más fino el seguimiento.'
      : 'Ningún vehículo cumple los filtros.';
  }

  // ---------- botones de refresco (solo cuando la web la sirve src/serve.js en local) ----------
  // Alcance "lo que veo": países y modelos marcados en los filtros + fuente según la pestaña
  // (Pre-owned → solo pre-owned, Nuevos en stock → solo stock, Ofertas/Últimas 24 h → ambas).
  function currentScope() {
    const f = F();
    const allMarkets = Object.keys(DATA.markets);
    const allModels = [...new Set(all.map((v) => v.modelShort))];
    const markets = f.countries ? f.countries.filter((c) => allMarkets.includes(c)) : allMarkets;
    const models = f.models ? f.models.filter((m) => allModels.includes(m)) : allModels;
    const source = tab === 'preowned' || tab === 'stock' ? tab : null;
    return { markets, models, source, delay: 1000 };
  }
  function scopeLabel(sc) {
    const m = sc.markets.length === Object.keys(DATA.markets).length ? 'todos los países' : sc.markets.map((c) => c.toUpperCase()).join(', ');
    const allModels = [...new Set(all.map((v) => v.modelShort))];
    const mo = sc.models.length === allModels.length ? 'todos los modelos' : sc.models.join(', ');
    return `${m} · ${mo}${sc.source ? ' · ' + (sc.source === 'stock' ? 'stock' : 'pre-owned') : ''}`;
  }
  async function initRefreshButton() {
    let st;
    try { const r = await fetch('api/status', { cache: 'no-store' }); if (!r.ok) return; st = await r.json(); } catch { return; }
    const box = $('#refresh-box'), btnScope = $('#refresh-btn'), btnAll = $('#refresh-all'), out = $('#refresh-status');
    box.classList.remove('hidden');
    let timer = 0;
    const setBusy = (b) => { btnScope.disabled = b; btnAll.disabled = b; };
    const updateLabel = () => { if (!btnScope.disabled) btnScope.title = 'Refresca solo ' + scopeLabel(currentScope()) + ' (según los filtros y la pestaña actuales)'; };
    const poll = async () => {
      try {
        const r = await fetch('api/status', { cache: 'no-store' }); const s = await r.json();
        if (s.running) {
          setBusy(true);
          const secs = Math.round((Date.now() - Date.parse(s.startedAt)) / 1000);
          out.textContent = `Actualizando… ${secs}s · ${(s.lastLine || '').trim().slice(0, 70)}`;
          timer = setTimeout(poll, 1500);
        } else {
          setBusy(false);
          if (s.finishedAt && s.finishedAt !== initRefreshButton.seenFinish) {
            initRefreshButton.seenFinish = s.finishedAt;
            if (s.exitCode === 0) { out.textContent = 'Listo, recargando…'; setTimeout(() => location.reload(), 600); }
            else out.textContent = 'Error en el refresco (código ' + s.exitCode + '): ' + (s.log || []).slice(-1)[0];
          }
        }
      } catch { out.textContent = ''; }
    };
    initRefreshButton.seenFinish = st.finishedAt;
    if (st.running) poll();
    const launch = async (scope) => {
      setBusy(true); out.textContent = 'Lanzando refresco…';
      try {
        const r = await fetch('api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope) });
        if (r.status === 409) out.textContent = 'Ya hay un refresco en marcha…';
      } catch { out.textContent = 'No se pudo lanzar'; setBusy(false); return; }
      clearTimeout(timer); poll();
    };
    btnScope.addEventListener('click', () => launch(currentScope()));
    btnAll.addEventListener('click', () => launch(null));
    document.addEventListener('change', updateLabel); // en burbuja: se ejecuta después de que #filters actualice el estado
    $('#tabs').addEventListener('click', () => setTimeout(updateLabel, 0));
    updateLabel();
  }

  // Expandir/contraer una fila sin repintar la tabla entera.
  function toggleDetail(tr) {
    if (tab === 'sales') return;
    const id = tr.dataset.id;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('detail')) { next.remove(); expanded.delete(id); return; }
    const v = byId.get(id);
    if (!v) return;
    expanded.add(id);
    tr.insertAdjacentHTML('afterend', detailHtml(v));
  }

  function switchTab(t) {
    if (!COLUMNS[t]) return;
    tab = t;
    const s = state.sort[tab] || DEFAULT_SORT[tab];
    sortKey = s.key; sortDesc = !!s.desc;
    if (!COLUMNS[tab].some((c) => c.key === sortKey)) { sortKey = DEFAULT_SORT[tab].key; sortDesc = DEFAULT_SORT[tab].desc; }
    saveState();
    buildFilterUI();
    render();
  }

  // ---------- eventos ----------
  function bind() {
    // Móvil: filtros plegados por defecto (botón "Filtros"); en escritorio el botón no se muestra y los filtros siempre se ven.
    const ft = $('#filters-toggle');
    ft.addEventListener('click', () => {
      const open = !$('#filters').classList.contains('open');
      $('#filters').classList.toggle('open', open); ft.classList.toggle('open', open);
      ft.setAttribute('aria-expanded', String(open)); ft.textContent = open ? 'Filtros ▴' : 'Filtros ▾';
    });
    $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) switchTab(b.dataset.tab); });
    const LIVE_INPUTS = '#f-text, #f-price-max, #f-km-max';
    // Los campos de texto/número ya se aplican con 'input'; ignorar su 'change' (al perder el foco) para no
    // re-pintar la tabla en mitad de un clic sobre una cabecera/fila (el clic se perdería).
    $('#filters').addEventListener('change', (e) => { if (e.target.matches(LIVE_INPUTS)) return; readFiltersFromUI(); render(); });
    // Debounce (~120 ms) al teclear: se guarda el filtro al momento pero se pinta cuando el usuario hace una pausa.
    let typeTimer = 0;
    $$(LIVE_INPUTS).forEach((el) => el.addEventListener('input', () => {
      readFiltersFromUI();
      clearTimeout(typeTimer);
      typeTimer = setTimeout(render, 120);
    }));

    $('#more-page').addEventListener('click', () => renderRows(view.shown + PAGE));
    $('#more-all').addEventListener('click', () => renderRows(Infinity));
    if ('IntersectionObserver' in window) {
      // Al acercarse al final de lo pintado se añade la siguiente página automáticamente.
      new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && view.shown < view.rows.length) renderRows(view.shown + PAGE);
      }, { rootMargin: '600px 0px' }).observe($('#more'));
    }

    $('#totals').addEventListener('click', (e) => {
      const el = e.target.closest('.stat');
      if (!el || el.classList.contains('zero')) return;
      const k = el.dataset.stat;
      if (k === 'removed') {
        const panel = $('#removed-panel');
        const show = panel.classList.contains('hidden');
        if (show) renderRemoved();
        panel.classList.toggle('hidden', !show);
        renderStats();
        return;
      }
      if (k === 'new') $('#f-new').checked = !F().onlyNew;
      if (k === 'drops') $('#f-drops').checked = !F().onlyDrops;
      readFiltersFromUI(); render();
    });
    $('#removed-close').addEventListener('click', () => { $('#removed-panel').classList.add('hidden'); renderStats(); });

    $('#f-reset').addEventListener('click', () => {
      state.filters = defaultFilters();
      state.filters.countries = null;
      const d = DEFAULT_SORT[tab]; sortKey = d.key; sortDesc = d.desc;
      saveState(); buildFilterUI(); render();
    });

    $$('.quick button').forEach((btn) => btn.addEventListener('click', () => {
      const group = btn.dataset.quickGroup, mode = btn.dataset.quick;
      const boxes = $$(`input[data-key="${group}"]`);
      if (group === 'countries') {
        const set = new Set(countriesForPreset(mode));
        boxes.forEach((box) => { box.checked = set.has(box.value); });
      } else {
        boxes.forEach((box) => { box.checked = true; });
      }
      readFiltersFromUI(); render();
    }));

    $('#market-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const box = document.querySelector(`input[data-key="countries"][value="${chip.dataset.country}"]`);
      if (!box) return;
      const boxes = $$('input[data-key="countries"]');
      const checked = boxes.filter((b) => b.checked);
      // Un clic deja solo ese país; clic sobre el único seleccionado vuelve a todos.
      if (checked.length === 1 && checked[0] === box) boxes.forEach((b) => (b.checked = true));
      else boxes.forEach((b) => (b.checked = b === box));
      readFiltersFromUI(); render();
    });

    $('#thead-row').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const k = th.dataset.sort;
      if (sortKey === k) sortDesc = !sortDesc; else { sortKey = k; sortDesc = DEFAULT_SORT[tab].key === k ? DEFAULT_SORT[tab].desc : false; }
      saveState(); render();
    });

    $('#rows').addEventListener('click', (e) => {
      const tr = e.target.closest('tr.main');
      if (tr) toggleDetail(tr);
    });
  }


  // ---------- Ventas: KPIs y gráfica (SVG sin dependencias) ----------
  const SERIES = { P2: 'var(--s1)', P3: 'var(--s2)', P4: 'var(--s3)', P5: 'var(--s4)' };
  const SERIES_ORDER = ['P2', 'P3', 'P4', 'P5'];
  let chartPeriod = state.chartPeriod || 'month';
  const median = (arr) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const top = (rows, keyFn) => { const c = new Map(); for (const r of rows) { const k = keyFn(r); if (!k) continue; c.set(k, (c.get(k) || 0) + 1); } return [...c.entries()].sort((a, b) => b[1] - a[1]); };
  function periodKey(iso, period) {
    const d = new Date(iso);
    if (period === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (period === 'day') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // semana ISO (lunes)
    const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
    return `${x.getUTCFullYear()}-S${String(Math.ceil(((x - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
  }
  function periodLabel(k, period) {
    if (period === 'month') { const [y, m] = k.split('-'); return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('es-ES', { month: 'short', year: '2-digit' }); }
    if (period === 'day') { const [y, m, d] = k.split('-'); return `${d}/${m}`; }
    return k.replace(/^\d{4}-/, '');
  }
  function periodSeq(fromIso, toIso, period) {
    // Todas las claves de periodo entre from y to (inclusive), para pintar también los periodos con 0.
    const keys = []; const d = new Date(fromIso), end = new Date(toIso);
    d.setHours(0, 0, 0, 0);
    if (period === 'month') d.setDate(1);
    if (period === 'week') { const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); }
    for (let i = 0; i < 400 && d <= end; i++) {
      keys.push(periodKey(d.toISOString(), period));
      if (period === 'month') d.setMonth(d.getMonth() + 1); else d.setDate(d.getDate() + (period === 'week' ? 7 : 1));
    }
    return [...new Set(keys)];
  }

  function renderSalesPanel(rows) {
    $('#sales-since').textContent = SALES?.trackingSince ? fmtDay(SALES.trackingSince) : '—';
    // KPIs
    const n = rows.length;
    const byModel = top(rows, (r) => r.model);
    const byCar = top(rows, (r) => r.variant ? `${r.model} ${r.variant}` : null);
    const byCountry = top(rows, (r) => r.countryName);
    const days = rows.map((r) => r.daysListed).filter((x) => x != null);
    const eur = rows.map((r) => r.priceEur).filter((x) => x != null);
    const pre = rows.filter((r) => r.source === 'preowned').length;
    const kpi = (label, value, sub) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
    $('#sales-kpis').innerHTML = [
      kpi('Retirados / vendidos', n, n ? `${pre} pre-owned · ${n - pre} stock` : 'aún sin datos'),
      kpi('Modelo más vendido', byModel[0] ? esc(byModel[0][0]) : '—', byModel[0] ? `${byModel[0][1]} (${Math.round((byModel[0][1] / n) * 100)} %)${byModel[1] ? ' · 2º ' + esc(byModel[1][0]) + ' ' + byModel[1][1] : ''}` : ''),
      kpi('Coche más vendido', byCar[0] ? esc(byCar[0][0]) : '—', byCar[0] ? `${byCar[0][1]} unidades${byCar[1] ? ' · 2º ' + esc(byCar[1][0]) + ' ' + byCar[1][1] : ''}` : ''),
      kpi('País con más ventas', byCountry[0] ? esc(byCountry[0][0]) : '—', byCountry.slice(1, 3).map((x) => esc(x[0]) + ' ' + x[1]).join(' · ')),
      kpi('Días en venta (mediana)', days.length ? median(days) : '—', days.length ? `media ${Math.round(days.reduce((a, b) => a + b, 0) / days.length)} · máx ${Math.max(...days)}` : ''),
      kpi('Precio medio (≈ EUR)', eur.length ? fmtMoney(Math.round(eur.reduce((a, b) => a + b, 0) / eur.length), 'EUR') : '—', eur.length ? `mediana ${fmtMoney(median(eur), 'EUR')}` : ''),
    ].join('');
    // Gráfica
    $$('[data-period]').forEach((b) => b.classList.toggle('on', b.dataset.period === chartPeriod));
    $('#chart-period-label').textContent = chartPeriod === 'month' ? 'mes' : chartPeriod === 'week' ? 'semana' : 'día';
    const svg = $('#sales-chart');
    const from = SALES?.trackingSince || (rows.length ? rows[rows.length - 1].removedAt : DATA.generatedAt);
    let keys = periodSeq(from, DATA.generatedAt, chartPeriod);
    const MAXP = chartPeriod === 'month' ? 12 : chartPeriod === 'week' ? 16 : 31;
    if (keys.length > MAXP) keys = keys.slice(-MAXP);
    const models = SERIES_ORDER.filter((m) => rows.some((r) => r.modelShort === m));
    const counts = new Map(keys.map((k) => [k, Object.fromEntries(models.map((m) => [m, 0]))]));
    for (const r of rows) { const k = periodKey(r.removedAt, chartPeriod); if (counts.has(k)) counts.get(k)[r.modelShort]++; }
    const totals = keys.map((k) => Object.values(counts.get(k)).reduce((a, b) => a + b, 0));
    const max = Math.max(1, ...totals);
    const W = Math.max(320, Math.min(1400, svg.clientWidth || 800)), H = 240, padL = 34, padR = 12, padT = 18, padB = 26;
    const cw = (W - padL - padR) / keys.length, bw = Math.min(64, cw * 0.62);
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const ticks = max <= 5 ? [...Array(max + 1).keys()] : [0, Math.round(max / 2), max];
    let out = `<g class="grid">${ticks.map((t) => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" /><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}</g>`;
    out += `<line class="axis" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" />`;
    keys.forEach((k, i) => {
      const x0 = padL + cw * i + (cw - bw) / 2;
      let acc = 0;
      const segs = models.map((m) => [m, counts.get(k)[m]]).filter(([, c]) => c > 0);
      segs.forEach(([m, c], j) => {
        const y1 = y(acc + c), y2 = y(acc); acc += c;
        const gap = j < segs.length - 1 ? 2 : 0; // 2px de separación entre segmentos
        const h = Math.max(0, y2 - y1 - gap);
        const rx = j === segs.length - 1 ? 3 : 0;
        out += `<rect class="seg" x="${x0}" y="${y1}" width="${bw}" height="${h}" rx="${rx}" fill="${SERIES[m]}" data-tip="${esc(`${periodLabel(k, chartPeriod)} · ${m}: ${c} de ${totals[i]}`)}"></rect>`;
      });
      if (totals[i]) out += `<text class="total" x="${x0 + bw / 2}" y="${y(totals[i]) - 4}" text-anchor="middle">${totals[i]}</text>`;
      const every = keys.length > 16 ? Math.ceil(keys.length / 12) : 1;
      if (i % every === 0 || i === keys.length - 1) out += `<text x="${x0 + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(periodLabel(k, chartPeriod))}</text>`;
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
    $('#sales-legend').innerHTML = models.map((m) => `<span><span class="sw" style="background:${SERIES[m]}"></span>${modelName(m)} <b>${rows.filter((r) => r.modelShort === m).length}</b></span>`).join('');
  }
  function bindSales() {
    $$('[data-period]').forEach((b) => b.addEventListener('click', () => { chartPeriod = b.dataset.period; state.chartPeriod = chartPeriod; saveState(); render(); }));
    const tip = $('#chart-tip'), wrap = $('.chart-wrap');
    $('#sales-chart').addEventListener('mousemove', (e) => {
      const r = e.target.closest('rect.seg');
      if (!r) { tip.classList.add('hidden'); return; }
      tip.textContent = r.dataset.tip; tip.classList.remove('hidden');
      const box = wrap.getBoundingClientRect();
      tip.style.left = Math.min(box.width - tip.offsetWidth - 8, e.clientX - box.left + 12) + 'px';
      tip.style.top = (e.clientY - box.top - 34) + 'px';
    });
    $('#sales-chart').addEventListener('mouseleave', () => tip.classList.add('hidden'));
    window.addEventListener('resize', () => { if (tab === 'sales') render(); });
  }

  // ---------- 🔔 Avisos: alertas guardadas en public/alerts.json (las lee src/notify.js tras cada refresco) ----------
  const REPO = (() => {
    const h = location.hostname;
    if (h.endsWith('.github.io')) { const seg = location.pathname.split('/').filter(Boolean)[0]; if (seg) return h.split('.')[0] + '/' + seg; }
    return 'invernati/PolestarTracker';
  })();
  const ALERTS_PATH = 'public/alerts.json';
  const alertsState = { doc: null, sha: null, dirty: false, source: '' };
  const TOKEN_KEY = 'polestar-gh-token';

  async function loadAlerts() {
    alertsState.sha = null;
    // Preferimos la versión del repo (con sha, necesaria para guardar); si no hay token, la copia publicada.
    const token = localStorage.getItem(TOKEN_KEY) || '';
    if (token) {
      try {
        const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${ALERTS_PATH}?ref=main`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, cache: 'no-store' });
        if (r.ok) { const j = await r.json(); alertsState.sha = j.sha; alertsState.doc = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g, ''))))); alertsState.source = 'repositorio (main)'; alertsState.dirty = false; return; }
        if (r.status === 401 || r.status === 403) $('#alerts-status').textContent = 'El token no es válido o no tiene permiso Contents en ' + REPO + ' (se muestra la copia publicada).';
      } catch { /* sin red / CORS: seguimos con la copia publicada */ }
    }
    try {
      const r = await fetch('alerts.json', { cache: 'no-store' });
      if (r.ok) { alertsState.doc = await r.json(); alertsState.source = 'web publicada'; alertsState.dirty = false; return; }
    } catch { /* file:// */ }
    alertsState.doc = { alerts: [] }; alertsState.source = 'nuevo';
  }

  const alertDesc = (al) => {
    const p = [];
    p.push(al.markets?.length ? al.markets.map((c) => c.toUpperCase()).join(', ') : 'todos los países');
    p.push(al.models?.length ? al.models.join(', ') : 'todos los modelos');
    if (al.sources?.length && al.sources.length < 2) p.push(al.sources[0] === 'stock' ? 'solo stock' : 'solo pre-owned');
    if (al.variants?.length) p.push(al.variants.join(' / '));
    if (al.years?.length) p.push('MY ' + al.years.join(','));
    if (al.priceMaxEur) p.push('≤ ' + fmtMoney(al.priceMaxEur, 'EUR'));
    if (al.kmMax) p.push('≤ ' + nf0.format(al.kmMax) + ' km');
    if (al.hideSingle) p.push('sin Single');
    if (al.hideCoupe) p.push('sin P4 MY27');
    const ev = (al.events?.length ? al.events : ['new', 'drop']).map((e) => ({ new: 'nuevos', drop: 'bajadas', removed: 'retirados' }[e] || e)).join(' + ');
    return p.join(' · ') + ' — avisa de ' + ev;
  };

  function alertFromFilters() {
    const f = F();
    const allM = Object.keys(DATA.markets), allMo = [...new Set(all.map((v) => v.modelShort))], allV = [...new Set(all.map((v) => v.variant))], allY = [...new Set(all.map((v) => String(v.modelYear)))];
    const pick = (sel, universe) => (sel && sel.length < universe.length ? sel : []);
    return {
      id: 'a' + Date.now().toString(36),
      name: $('#alert-name').value.trim(),
      enabled: true,
      markets: pick(f.countries, allM),
      models: pick(f.models, allMo),
      sources: tab === 'preowned' || tab === 'stock' ? [tab] : [],
      variants: pick(f.variants, allV),
      years: pick(f.years, allY).map(Number),
      priceMaxEur: f.priceMax ? Number(f.priceMax) : null,
      kmMax: f.kmMax ? Number(f.kmMax) : null,
      hideSingle: !!f.hideSingle,
      hideCoupe: !!f.hideCoupe,
      events: [$('#ev-new').checked && 'new', $('#ev-drop').checked && 'drop', $('#ev-removed').checked && 'removed'].filter(Boolean),
    };
  }

  function renderAlerts() {
    const list = alertsState.doc?.alerts ?? [];
    $('#cnt-alerts').textContent = list.filter((a) => a.enabled !== false).length;
    $('#alerts-src').textContent = alertsState.source ? '(' + alertsState.source + (alertsState.dirty ? ', cambios sin guardar' : '') + ')' : '';
    $('#alerts-list').innerHTML = list.length ? list.map((al, i) => `<li class="${al.enabled === false ? 'off' : ''}"><div><div class="al-name">${esc(al.name || al.id || 'Alerta')}</div><div class="al-desc">${esc(alertDesc(al))}</div></div><div class="al-actions"><button type="button" class="btn-reset" data-al-toggle="${i}">${al.enabled === false ? 'Activar' : 'Pausar'}</button><button type="button" class="btn-reset" data-al-del="${i}">Eliminar</button></div></li>`).join('') : '<li class="muted">Ninguna. Ajusta los filtros de la web y pulsa "Añadir a la lista".</li>';
    const draft = alertFromFilters();
    $('#alert-preview').textContent = alertDesc(draft);
    if (!$('#alert-name').value) $('#alert-name').placeholder = draft.markets.map((c) => c.toUpperCase()).join(',') || 'Todos';
    $('#alerts-edit-link').href = `https://github.com/${REPO}/edit/main/${ALERTS_PATH}`;
    $('#secrets-link').href = `https://github.com/${REPO}/settings/secrets/actions`;
  }

  async function saveAlerts() {
    const token = $('#gh-token').value.trim();
    const st = $('#alerts-status');
    if (!token) { st.textContent = 'Pon un token de GitHub (o usa "Copiar JSON" y pégalo en el editor de GitHub).'; return; }
    localStorage.setItem(TOKEN_KEY, token);
    st.textContent = 'Guardando…';
    try {
      const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
      if (!alertsState.sha) {
        const r0 = await fetch(`https://api.github.com/repos/${REPO}/contents/${ALERTS_PATH}?ref=main`, { headers, cache: 'no-store' });
        if (r0.ok) alertsState.sha = (await r0.json()).sha;
      }
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(alertsState.doc, null, 2) + '\n')));
      const body = { message: 'alerts: actualizado desde la web', content, branch: 'main' };
      if (alertsState.sha) body.sha = alertsState.sha;
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${ALERTS_PATH}`, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('GitHub ' + r.status + ': ' + ((await r.json()).message || ''));
      const j = await r.json(); alertsState.sha = j.content.sha; alertsState.dirty = false; alertsState.source = 'repositorio (main)';
      st.textContent = 'Guardado en GitHub ✓ — se aplica en el próximo refresco (España cada 10 min). La web publicada mostrará la lista nueva en unos minutos.';
      renderAlerts();
    } catch (e) { st.textContent = 'No se pudo guardar: ' + e.message + '. Alternativa: "Copiar JSON" y pegar en el editor de GitHub.'; }
  }

  function bindAlerts() {
    const dlg = $('#alerts-dlg');
    $('#gh-token').value = localStorage.getItem(TOKEN_KEY) || '';
    $('#alerts-open').addEventListener('click', async () => { $('#alerts-status').textContent = ''; await loadAlerts(); renderAlerts(); dlg.showModal(); });
    ['#alert-name', '#ev-new', '#ev-drop', '#ev-removed'].forEach((sel) => $(sel).addEventListener('input', renderAlerts));
    $('#alert-add').addEventListener('click', () => {
      const al = alertFromFilters();
      if (!al.name) al.name = alertDesc(al).split(' — ')[0];
      if (!al.events.length) { $('#alerts-status').textContent = 'Marca al menos un tipo de aviso.'; return; }
      alertsState.doc.alerts = alertsState.doc.alerts || []; alertsState.doc.alerts.push(al); alertsState.dirty = true;
      $('#alert-name').value = ''; $('#alerts-status').textContent = 'Añadida. Pulsa "Guardar en GitHub" (o copia el JSON) para que tenga efecto.'; renderAlerts();
    });
    $('#alerts-list').addEventListener('click', (e) => {
      const del = e.target.closest('[data-al-del]'), tog = e.target.closest('[data-al-toggle]');
      if (del) { alertsState.doc.alerts.splice(Number(del.dataset.alDel), 1); alertsState.dirty = true; renderAlerts(); }
      if (tog) { const al = alertsState.doc.alerts[Number(tog.dataset.alToggle)]; al.enabled = al.enabled === false; alertsState.dirty = true; renderAlerts(); }
    });
    $('#alerts-save').addEventListener('click', saveAlerts);
    $('#alerts-copy').addEventListener('click', async () => {
      const txt = JSON.stringify(alertsState.doc, null, 2);
      try { await navigator.clipboard.writeText(txt); $('#alerts-status').textContent = 'JSON copiado. Pégalo en alerts.json (enlace "Abrir alerts.json en GitHub") y guarda el commit.'; }
      catch { $('#alerts-status').textContent = 'No se pudo copiar automáticamente; el JSON es: ' + txt; }
    });
    // Contador del botón sin abrir el diálogo.
    loadAlerts().then(() => { $('#cnt-alerts').textContent = (alertsState.doc?.alerts ?? []).filter((a) => a.enabled !== false).length; });
  }

  // ---------- init ----------
  loadData().then(async (data) => {
    if (!data) {
      $('#updated').innerHTML = 'Sin datos. Ejecuta <code>npm run refresh</code> y recarga.';
      return;
    }
    DATA = data;
    GEN_TS = Date.parse(DATA.generatedAt) || Date.now();
    all = data.vehicles.map(decorate);
    SALES = await loadSales();
    sales = (SALES.sales || []).map(decorateSale);
    tabCount.sales = sales.length;
    for (const v of all) { byId.set(v.id, v); tabCount[v.source] = (tabCount[v.source] || 0) + 1; if (v.isOffer) tabCount.offers++; if (v.isRecent) tabCount.recent++; }
    // Resolver preset inicial de países y limpiar selecciones guardadas que ya no existen.
    if (state.filters.countries === 'europe') state.filters.countries = countriesForPreset('europe');
    const known = { models: all.map((v) => v.modelShort), variants: all.map((v) => v.variant), years: all.map((v) => String(v.modelYear)), countries: Object.keys(DATA.markets) };
    for (const k of Object.keys(known)) {
      const sel = state.filters[k];
      if (Array.isArray(sel)) { state.filters[k] = sel.filter((x) => known[k].includes(x)); if (!state.filters[k].length && k !== 'countries') state.filters[k] = null; }
    }
    if (Array.isArray(state.filters.countries) && countriesForPreset('all').every((c) => state.filters.countries.includes(c))) state.filters.countries = null;
    bind();
    switchTab(state.tab && COLUMNS[state.tab] ? state.tab : 'preowned');
    initRefreshButton();
    bindAlerts();
    bindSales();
  });
})();
