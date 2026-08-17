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

  const inTab = (v) => tab === 'offers' ? v.isOffer : tab === 'recent' ? v.isRecent : v.source === tab;
  const tabCount = { preowned: 0, stock: 0, offers: 0, recent: 0 }; // se rellena al cargar
  const byId = new Map();

  // ---------- filtros ----------
  function uniqueSorted(arr, cmp) { return [...new Set(arr)].sort(cmp); }
  const modelName = (s) => (DATA.models && Object.values(DATA.models).find((m) => m.short === s)?.name) || s;

  function buildFilterUI() {
    const pool = all.filter(inTab);
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
    return all.filter((v) => {
      if (!inTab(v)) return false;
      if (f.models && !f.models.includes(v.modelShort)) return false;
      if (f.variants && !f.variants.includes(v.variant)) return false;
      if (f.years && !f.years.includes(String(v.modelYear))) return false;
      if (f.countries && !f.countries.includes(v.country)) return false;
      if (f.hideSingle && v.flags.single) return false;
      if (f.hideCoupe && v.flags.coupe) return false;
      if (f.vatOnly && tab !== 'stock' && v.source === 'preowned' && !v.vatDeductible) return false;
      if (f.campaignOnly && tab !== 'preowned' && v.source === 'stock' && !(v.discount > 0)) return false;
      if (f.onlyNew && !v.isNew) return false;
      if (f.onlyDrops && !v.isDrop) return false;
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
  const DEFAULT_SORT = { preowned: { key: 'priceEur', desc: false }, stock: { key: 'priceEur', desc: false }, offers: { key: 'dropPct', desc: true }, recent: { key: 'recentTs', desc: true } };

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
    if (n === undefined) { n = 0; for (const v of all) if (v.country === code && inTab(v)) n++; countByCountryTab.set(k, n); }
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

  // ---------- init ----------
  loadData().then((data) => {
    if (!data) {
      $('#updated').innerHTML = 'Sin datos. Ejecuta <code>npm run refresh</code> y recarga.';
      return;
    }
    DATA = data;
    GEN_TS = Date.parse(DATA.generatedAt) || Date.now();
    all = data.vehicles.map(decorate);
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
  });
})();
