#!/usr/bin/env node
// Refresca el inventario (pre-owned + stock cars): llama a la API por cada (mercado, modelo),
// normaliza, guarda data/inventory.json, un snapshot en data/history/YYYY-MM-DD_HH.json,
// actualiza data/tracking.json (primera vez visto, histórico de precios) y copia los datos a
// public/data/ para que la web (public/) sea autocontenida.
//
// Uso:  npm run refresh                    → todo
//       node src/fetch.js --market=es,fr    → solo esos mercados
//       node src/fetch.js --only=preowned   → solo pre-owned (o --only=stock)
//       node src/fetch.js --model=P3,P4     → solo esos modelos (códigos 359,814 o cortos P3,P4)
//       node src/fetch.js --delay=1000      → pausa entre requests en ms (por defecto config)
//       node src/fetch.js --offline         → renormaliza data/raw sin llamar a la API
//       node src/fetch.js --fast            → sin pausas (depuración)
//       node src/fetch.js --history=daily   → un snapshot por día en data/history (en vez de uno por hora)

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MARKETS, MODELS, DELAY_BETWEEN_REQUESTS_MS, DELAY_BETWEEN_PAGES_MS, FX_TO_EUR } from './config.js';
import { fetchAllVehicleAds, fetchAllStockCars, sleep } from './api.js';
import { normalizeVehicle, normalizeStockCar } from './normalize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const HISTORY_DIR = join(DATA_DIR, 'history');
const RAW_DIR = join(DATA_DIR, 'raw');
const INVENTORY_JSON = join(DATA_DIR, 'inventory.json');
const TRACKING_JSON = join(DATA_DIR, 'tracking.json');
const PUBLIC_DATA_DIR = join(ROOT, 'public', 'data');
const PUBLIC_INVENTORY_JS = join(PUBLIC_DATA_DIR, 'inventory.js');
const PUBLIC_INVENTORY_JSON = join(PUBLIC_DATA_DIR, 'inventory.json');

const args = new Set(process.argv.slice(2));
const argValue = (name) => [...args].filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3)).pop();
const onlyMarkets = (argValue('market') ?? '').split(',').filter(Boolean);
const onlySource = argValue('only'); // 'preowned' | 'stock' | undefined
const onlyModels = (argValue('model') ?? '').split(',').filter(Boolean).map((m) => m.toUpperCase()); // códigos (814) o cortos (P4)
const delayOverride = argValue('delay') != null ? Number(argValue('delay')) : null; // ms entre requests (refrescos parciales rápidos)
const fast = args.has('--fast');
const offline = args.has('--offline');
const historyMode = argValue('history') ?? 'hourly'; // 'hourly' (fichero por hora) | 'daily' (uno por día, se sobrescribe) | 'none'

// Orden de modelos por nombre corto (P2, P3, P4, P5) en vez del orden numérico de las claves.
const MODEL_ENTRIES_ALL = Object.entries(MODELS).sort((a, b) => a[1].short.localeCompare(b[1].short));
const MODEL_ENTRIES = MODEL_ENTRIES_ALL
  .filter(([code, m]) => !onlyModels.length || onlyModels.includes(code) || onlyModels.includes(m.short.toUpperCase()));

const SOURCES = {
  preowned: {
    label: 'Pre-owned',
    enabledForMarket: () => true,
    enabledForModel: (m) => m.preowned !== false,
    fetch: async (market, modelCode, delay) => {
      const { total, vehicleAds, requests } = await fetchAllVehicleAds({ market: market.api, modelCode, delayMs: delay ? DELAY_BETWEEN_PAGES_MS : 0 });
      return { total, items: vehicleAds, requests };
    },
    normalize: (item, market) => normalizeVehicle(item, market),
  },
  stock: {
    label: 'Stock (nuevos)',
    enabledForMarket: (m) => !!m.stock,
    enabledForModel: (m) => m.stock !== false,
    fetch: async (market, modelCode, delay) => {
      const { total, cars, requests } = await fetchAllStockCars({ market: market.slug, modelCode, stateCode: market.stockState, delayMs: delay ? DELAY_BETWEEN_PAGES_MS : 0 });
      return { total, items: cars, requests };
    },
    normalize: (item, market) => normalizeStockCar(item, market),
  },
};

function loadJson(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.warn(`  (aviso) no se pudo leer ${path}: ${e.message}`);
  }
  return fallback;
}

// Campos que la web (public/app.js) no usa: se quedan solo en data/inventory.json (salida canónica).
const WEB_DROP = new Set(['packDetails', 'colorCode', 'priceChangeSinceFirst', 'locationCity', 'cycleState', 'countryFlag', 'marketSlug', 'modelCode', 'motorCode', 'eu', 'rhd', 'listPriceEur']);
/** Versión reducida de un vehículo para public/data/*: sin campos no usados ni valores vacíos.
 *  Reglas que app.js asume: claves ausentes ≡ null/0/false/[]; `flags` solo lleva las banderas activas;
 *  `mileageUnit`/`mileageRaw` solo cuando la unidad no es km; `priceMax` solo si supera el precio actual;
 *  `priceHistory` se omite cuando es la entrada única [{t: firstSeen, price, currency}] (app.js la reconstruye). */
function slimForWeb(v) {
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (WEB_DROP.has(k) || x == null) continue;
    if (Array.isArray(x) && x.length === 0) continue;
    if (x === 0 && (k === 'discount' || k === 'discountPct' || k === 'priceChange')) continue;
    if (k === 'mileageUnit' && x === 'km') continue;
    if (k === 'mileageRaw' && v.mileageUnit === 'km') continue;
    if (k === 'priceMax' && !(x > v.price)) continue;
    if (k === 'flags') { o.flags = {}; for (const [fk, fv] of Object.entries(x)) if (fv && fk !== 'campaign') o.flags[fk] = true; continue; }
    if (k === 'priceHistory' && x.length === 1 && x[0].t === v.firstSeen && x[0].price === v.price && x[0].currency === v.currency) continue;
    o[k] = x;
  }
  return o;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return historyMode === 'daily' ? day : `${day}_${p(d.getHours())}`;
}

/** Histórico de "ventas": vehículos retirados del inventario (y no reaparecidos). Se publica en public/data/sales.{js,json}. */
function writeSales(tracking, nowIso) {
  const configured = new Set(MARKETS.map((m) => m.api));
  // Relleno para retirados anteriores a que el tracking guardara metadatos: los snapshots compactos del historial
  // (data/history/*.json) tienen variant, modelYear, mileageKm, priceEur y vin por id.
  const backfill = new Map();
  try {
    const files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const snap = loadJson(join(HISTORY_DIR, f), null);
      for (const v of snap?.vehicles ?? []) backfill.set(v.id, v); // el más reciente pisa al anterior
    }
  } catch { /* sin historial */ }
  const names = Object.fromEntries(MARKETS.map((m) => [m.api, m.name]));
  const modelName = (short) => Object.values(MODELS).find((m) => m.short === short)?.name ?? short;
  const sales = [];
  for (const [id, t] of Object.entries(tracking.vehicles)) {
    if (!t.removedAt || !configured.has(t.country)) continue;
    const bf = backfill.get(id) ?? {};
    const m = t.meta ?? (bf.id ? { variant: bf.variant, modelYear: bf.modelYear, mileageKm: bf.mileageKm, priceEur: bf.priceEur, price: bf.price, currency: bf.currency, packs: bf.packs ?? [], bundles: bf.bundles ?? [] } : {});
    const days = Math.max(0, Math.round((Date.parse(t.removedAt) - Date.parse(t.firstSeen)) / 86400000));
    sales.push({
      ...m,
      id, source: t.source, country: t.country, countryName: m.countryName ?? names[t.country] ?? t.country,
      modelShort: t.model, model: m.model ?? modelName(t.model), variant: m.variant ?? null, modelYear: m.modelYear ?? null,
      mileageKm: m.mileageKm ?? null, color: m.color ?? null, price: m.price ?? t.priceHistory?.[t.priceHistory.length - 1]?.price ?? null,
      currency: m.currency ?? t.priceHistory?.[t.priceHistory.length - 1]?.currency ?? 'EUR',
      priceEur: m.priceEur ?? ((m.currency ?? t.priceHistory?.[t.priceHistory.length - 1]?.currency ?? 'EUR') === 'EUR' ? (m.price ?? t.priceHistory?.[t.priceHistory.length - 1]?.price ?? null) : null),
      listPrice: m.listPrice ?? null, discount: m.discount ?? 0, firstSeen: t.firstSeen, removedAt: t.removedAt, daysListed: days,
      priceHistory: t.priceHistory ?? [], url: m.url ?? null, image: m.image ?? null,
      packs: m.packs ?? [], bundles: m.bundles ?? [], interior: m.interior ?? null,
      flags: { single: !!m.single, coupe: !!m.coupe },
      vin: t.vin ?? bf.vin ?? null,
      // Sin metadatos ni snapshot (retirado antes de que se guardaran): la web lo mostrará con menos detalle.
      partial: !t.meta && !bf.id,
    });
  }
  sales.sort((a, b) => (a.removedAt < b.removedAt ? 1 : -1));
  const out = { generatedAt: nowIso, trackingSince: tracking.trackingSince ?? null, count: sales.length, sales };
  const json = JSON.stringify(out);
  writeFileSync(join(PUBLIC_DATA_DIR, 'sales.json'), json, 'utf8');
  writeFileSync(join(PUBLIC_DATA_DIR, 'sales.js'), "window.__SALES__=JSON.parse('" + json.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "');\n", 'utf8');
  return sales.length;
}

async function main() {
  const startedAt = new Date();
  const wallStart = Date.now();
  console.log(`Polestar tracker refresh — ${startedAt.toLocaleString()}${offline ? '  (modo --offline: sin llamadas a la API)' : ''}`);
  for (const d of [HISTORY_DIR, RAW_DIR, PUBLIC_DATA_DIR]) mkdirSync(d, { recursive: true });

  const markets = onlyMarkets.length ? MARKETS.filter((m) => onlyMarkets.includes(m.api) || onlyMarkets.includes(m.slug)) : MARKETS;
  const sources = Object.entries(SOURCES).filter(([k]) => !onlySource || k === onlySource);
  const delay = fast ? 0 : delayOverride ?? DELAY_BETWEEN_REQUESTS_MS;

  const previous = loadJson(INVENTORY_JSON, null);
  const tracking = loadJson(TRACKING_JSON, { vehicles: {} });
  for (const t of Object.values(tracking.vehicles)) if (t.removedAt && !t.removals) t.removals = [{ t: t.removedAt }];
  // --offline renormaliza los MISMOS datos del último refresco real: se conserva su fecha/hora para que
  // el tracking (lastSeen, historial de precios) y la cabecera de la web no cambien.
  if (offline && previous?.generatedAt) startedAt.setTime(Date.parse(previous.generatedAt));

  const vehicles = [];
  const seen = new Set(); // ids ya incorporados (la API de stock a veces repite un coche entre páginas)
  const marketStatus = {};
  let requestCount = 0;

  for (const market of markets) {
    const status = {
      code: market.api, slug: market.slug, name: market.name, flag: market.flag, eu: market.eu, rhd: market.rhd,
      europe: !!market.europe, currency: market.currency, note: market.note ?? null,
      status: 'ok', count: 0, bySource: {}, byModel: {}, errors: [], fetchedAt: null,
    };
    let blocked = false;
    for (const [sourceKey, source] of sources) {
      if (!source.enabledForMarket(market)) continue;
      status.bySource[sourceKey] = 0;
      for (const [modelCode, model] of MODEL_ENTRIES) {
        if (!source.enabledForModel(model)) continue;
        const tag = `${market.flag} ${market.name.padEnd(13)} ${sourceKey.padEnd(8)} ${model.short}`;
        if (blocked) { status.errors.push(`${sourceKey}/${model.short}: omitido tras posible bloqueo`); continue; }
        process.stdout.write(`  ${tag} … `);
        const rawPath = join(RAW_DIR, `${sourceKey}_${market.api}_${modelCode}.json`);
        try {
          let result;
          if (offline) {
            result = loadJson(rawPath, null);
            if (!result) throw new Error(`sin datos crudos (${rawPath})`);
          } else {
            result = await source.fetch(market, modelCode, delay);
            requestCount += result.requests;
            writeFileSync(rawPath, JSON.stringify({ fetchedAt: new Date().toISOString(), source: sourceKey, market: market.api, modelCode, total: result.total, items: result.items }), 'utf8');
          }
          const normalized = result.items.map((it) => source.normalize(it, market)).filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
          vehicles.push(...normalized);
          status.byModel[`${sourceKey}:${modelCode}`] = normalized.length;
          status.bySource[sourceKey] += normalized.length;
          status.count += normalized.length;
          console.log(`${normalized.length}${result.total !== normalized.length ? ` (API total ${result.total})` : ''}`);
        } catch (err) {
          status.byModel[`${sourceKey}:${modelCode}`] = null;
          status.errors.push(`${sourceKey}/${model.short}: ${err.message}`);
          console.log(`ERROR ${err.message}`);
          if (/403|429|503|bloqueo/.test(err.message)) blocked = true;
        }
        if (delay && !offline) await sleep(delay);
      }
    }
    status.fetchedAt = new Date().toISOString();
    const attempts = Object.values(status.byModel);
    if (attempts.length && attempts.every((v) => v == null)) status.status = 'error';
    else if (status.errors.length) status.status = 'partial';
    else if (status.count === 0) status.status = 'empty';
    marketStatus[market.api] = status;
  }

  // Consultas (fuente, mercado, modelo) resueltas con éxito en esta ejecución: "source:country:modelShort".
  const queriedKeys = new Set();
  const failedKeys = new Set(); // intentadas en esta ejecución pero con error
  for (const s of Object.values(marketStatus)) {
    for (const [k, n] of Object.entries(s.byModel ?? {})) {
      const [src, modelCode] = k.split(':');
      const key = `${src}:${s.code}:${MODELS[modelCode]?.short ?? `M${modelCode}`}`;
      if (n == null) failedKeys.add(key); else queriedKeys.add(key);
    }
  }
  const vehicleKey = (v) => `${v.source}:${v.country}:${v.modelShort}`;
  const configuredMarkets = new Set(MARKETS.map((m) => m.api));
  const configuredModels = new Set(Object.values(MODELS).map((m) => m.short));

  // Refresco parcial (--market / --only / --model, o consultas fallidas): conservar del refresco anterior
  // todo lo que no se ha consultado con éxito ahora.
  const partial = onlyMarkets.length > 0 || !!onlySource || onlyModels.length > 0;
  if (previous) {
    // Se conservan: en refresco parcial, todo lo no consultado (de mercados/modelos aún configurados);
    // en refresco completo, solo lo de las consultas que han fallado ahora (para no perder inventario por un error puntual).
    const keep = (v) => !seen.has(v.id) && !queriedKeys.has(vehicleKey(v)) && configuredMarkets.has(v.country) && configuredModels.has(v.modelShort)
      && (partial || failedKeys.has(vehicleKey(v)));
    const carried = previous.vehicles.filter(keep).map((v) => ({ ...v, _carried: true }));
    for (const v of carried) seen.add(v.id);
    vehicles.push(...carried);
    for (const [code, prevStatus] of Object.entries(previous.markets ?? {})) {
      const cur = marketStatus[code];
      if (!cur) { if (partial && configuredMarkets.has(code)) marketStatus[code] = { ...prevStatus, stale: true }; continue; }
      // Completar con las consultas previas que no se han repetido (o han fallado) ahora.
      for (const [k, n] of Object.entries(prevStatus.byModel ?? {})) {
        if (cur.byModel[k] == null && n != null) cur.byModel[k] = n;
      }
      cur.bySource = {};
      cur.count = 0;
      for (const [k, n] of Object.entries(cur.byModel)) { const src = k.split(':')[0]; cur.bySource[src] = (cur.bySource[src] ?? 0) + (n ?? 0); cur.count += n ?? 0; }
      if (cur.status === 'empty' && cur.count > 0) cur.status = 'ok';
    }
    if (carried.length) console.log(`  (se conservan ${carried.length} vehículos del refresco anterior no consultados ahora)`);
    // Reordenar según config.
    const ordered = {};
    for (const m of MARKETS) if (marketStatus[m.api]) ordered[m.api] = marketStatus[m.api];
    for (const [k, v] of Object.entries(marketStatus)) if (!ordered[k]) ordered[k] = v;
    for (const k of Object.keys(marketStatus)) delete marketStatus[k];
    Object.assign(marketStatus, ordered);
  }

  // Ya deduplicado por id al incorporar cada lote (ver `seen`).
  const unique = vehicles;

  // Tracking: primera vez visto / última vez / histórico de precios (para análisis y pestaña Ofertas).
  const nowIso = startedAt.toISOString();
  // ¿Se ha consultado (con éxito) en esta ejecución el inventario al que pertenece este vehículo/registro de tracking?
  // En --offline los datos crudos pueden ser antiguos: no se marca nada como retirado ni se altera el tracking de retiradas.
  const wasQueried = (source, country, modelShort) => !offline && queriedKeys.has(`${source}:${country}:${modelShort}`);
  for (const v of unique) {
    if (v._carried) { delete v._carried; continue; } // no consultado en esta ejecución: se deja como estaba
    const t = tracking.vehicles[v.id] ?? { firstSeen: nowIso, priceHistory: [] };
    t.lastSeen = nowIso;
    // Un vehículo que había desaparecido y vuelve a aparecer se trata como alta nueva (relistado):
    // cuenta como "nuevo" y sus días en venta empiezan de cero (el histórico de precios se conserva).
    if (t.removedAt) {
      t.relistedAt = nowIso; t.firstSeen = nowIso;
      // El histórico de retiradas conserva el episodio, marcado como relistado (deja de contar como venta).
      t.removals = t.removals ?? []; const last = t.removals[t.removals.length - 1];
      if (last && !last.relistedAt) last.relistedAt = nowIso;
      delete t.removedAt;
    }
    t.country = v.country;
    t.model = v.modelShort;
    t.source = v.source;
    t.vin = v.vin;
    // Metadatos para el histórico de ventas (public/data/sales.json): se actualizan mientras el coche está a la venta.
    t.meta = { model: v.model, variant: v.variant, modelYear: v.modelYear, mileageKm: v.mileageKm, color: v.color, price: v.price, currency: v.currency, priceEur: v.priceEur, url: v.url, image: v.imageStudio, countryName: v.countryName, listPrice: v.listPrice ?? null, discount: v.discount || 0, single: !!v.flags?.single, coupe: !!v.flags?.coupe, packs: v.packs ?? [], bundles: v.bundles ?? [], interior: v.interior ?? null,
      // Detalle completo (para la ficha del coche en la pestaña Ventas)
      displayName: v.displayName ?? null, motorLabel: v.motorLabel ?? null, wheels: v.wheels ?? null, options: v.options ?? [], drivetrain: v.drivetrain ?? null,
      power: v.power ?? null, acceleration: v.acceleration ?? null, rangeKm: v.rangeKm ?? null, firstRegistration: v.firstRegistration ?? null,
      delivery: v.delivery ?? null, deliveryDate: v.deliveryDate ?? null, vatDeductible: v.vatDeductible ?? null, location: v.location ?? null, partner: v.partner ?? null,
      pno34: v.pno34 ?? null, structureWeek: v.structureWeek ?? null, imagePhoto: v.imagePhoto ?? null, discountPct: v.discountPct ?? 0 };
    const last = t.priceHistory[t.priceHistory.length - 1];
    if (!last || last.price !== v.price || last.currency !== v.currency) {
      t.priceHistory.push({ t: nowIso, price: v.price, currency: v.currency });
    }
    tracking.vehicles[v.id] = t;
    v.firstSeen = t.firstSeen;
    v.daysListed = Math.max(0, Math.round((startedAt - new Date(t.firstSeen)) / 86400000));
    v.priceHistory = t.priceHistory;
    const prevEntry = t.priceHistory.length >= 2 ? t.priceHistory[t.priceHistory.length - 2] : null;
    v.priceChange = prevEntry && prevEntry.price != null && v.price != null ? v.price - prevEntry.price : 0;
    v.priceChangeAt = prevEntry ? t.priceHistory[t.priceHistory.length - 1].t : null;
    const first = t.priceHistory[0];
    v.priceChangeSinceFirst = first && first.price != null && v.price != null ? v.price - first.price : 0;
    v.priceMax = Math.max(...t.priceHistory.map((p) => p.price ?? -Infinity));
  }
  // Marcar como retirados los que estaban y ya no aparecen (solo si su mercado respondió bien).
  for (const [id, t] of Object.entries(tracking.vehicles)) {
    if (!seen.has(id) && !t.removedAt && wasQueried(t.source, t.country, t.model)) {
      t.removedAt = nowIso;
      t.removals = t.removals ?? []; t.removals.push({ t: nowIso });
    }
  }
  tracking.updatedAt = nowIso;
  // Momento del primer refresco de la historia: lo que ya estaba entonces es "inventario base", no "nuevo".
  if (!tracking.trackingSince) tracking.trackingSince = Object.values(tracking.vehicles).reduce((m, t) => (t.firstSeen < m ? t.firstSeen : m), nowIso);

  // Diff frente al refresco anterior (informativo).
  const prevIds = new Set((previous?.vehicles ?? []).map((v) => v.id));
  const added = unique.filter((v) => !prevIds.has(v.id));
  const removed = previous ? previous.vehicles.filter((v) => !seen.has(v.id) && wasQueried(v.source, v.country, v.modelShort)) : [];
  // "Bajadas" = precio menor que en el refresco anterior (el cambio se ha detectado en ESTE refresco).
  const priceDrops = unique.filter((v) => v.priceChange < 0 && v.priceChangeAt === nowIso);
  const priceRises = unique.filter((v) => v.priceChange > 0 && v.priceChangeAt === nowIso);
  // Últimos refrescos por alcance (para la cabecera de la web: "General hh:mm · España hh:mm").
  const refreshes = tracking.refreshes ?? { full: null, markets: {} };
  if (!offline) {
    if (!partial) refreshes.full = nowIso;
    // Un mercado cuenta como "refrescado" si se han consultado todas sus fuentes y modelos configurados.
    for (const m of markets) {
      const expected = [];
      for (const [sourceKey, source] of Object.entries(SOURCES)) if (source.enabledForMarket(m)) for (const [, model] of MODEL_ENTRIES_ALL) if (source.enabledForModel(model)) expected.push(`${sourceKey}:${m.api}:${model.short}`);
      if (expected.length && expected.every((k) => queriedKeys.has(k))) refreshes.markets[m.api] = nowIso;
    }
    tracking.refreshes = refreshes;
  }
  const campaigns = unique.filter((v) => v.discount > 0);
  // Retirados: resumen para que la web pueda listarlos (ya no están en `vehicles`).
  const removedList = removed.map((v) => ({
    id: v.id, source: v.source, model: v.model, variant: v.variant, modelYear: v.modelYear, mileageKm: v.mileageKm,
    price: v.price, currency: v.currency, priceEur: v.priceEur, color: v.color, country: v.country, countryName: v.countryName,
    location: v.location, url: v.url, firstSeen: v.firstSeen, daysListed: v.daysListed, imageStudio: v.imageStudio,
  }));

  const output = {
    generatedAt: nowIso,
    durationSec: offline && previous ? previous.durationSec ?? 0 : Math.round((Date.now() - wallStart) / 1000),
    requestCount: offline && previous ? previous.requestCount ?? 0 : requestCount,
    fxToEur: FX_TO_EUR,
    models: MODELS,
    markets: marketStatus,
    totals: {
      vehicles: unique.length,
      preowned: unique.filter((v) => v.source === 'preowned').length,
      stock: unique.filter((v) => v.source === 'stock').length,
      added: offline && previous ? previous.totals?.added ?? 0 : added.length,
      removed: offline && previous ? previous.totals?.removed ?? 0 : removed.length,
      priceDrops: priceDrops.length, priceRises: priceRises.length, campaigns: campaigns.length,
    },
    refreshes,
    previousGeneratedAt: offline && previous ? previous.previousGeneratedAt ?? null : previous?.generatedAt ?? null,
    // Alcance del refresco (null = completo). La web lo muestra junto a la fecha.
    scope: partial ? { markets: markets.map((m) => m.api), models: MODEL_ENTRIES.map(([, m]) => m.short), source: onlySource ?? null } : null,
    trackingSince: tracking.trackingSince,
    removed: offline && previous ? previous.removed ?? [] : removedList,
    vehicles: unique,
  };

  writeFileSync(INVENTORY_JSON, JSON.stringify(output, null, 1), 'utf8');
  // Snapshot histórico compacto (solo lo necesario para analizar precios y rotación; ~0,3 MB en vez de ~5 MB).
  const snapshot = {
    generatedAt: nowIso,
    markets: Object.fromEntries(Object.values(marketStatus).map((s) => [s.code, { status: s.status, count: s.count, bySource: s.bySource }])),
    vehicles: unique.map((v) => ({
      id: v.id, source: v.source, country: v.country, model: v.modelShort, variant: v.variant, modelYear: v.modelYear,
      price: v.price, currency: v.currency, priceEur: v.priceEur, listPrice: v.listPrice ?? undefined, discount: v.discount || undefined,
      mileageKm: v.mileageKm, vin: v.vin ?? undefined, firstSeen: v.firstSeen, packs: v.packs?.length ? v.packs : undefined, bundles: v.bundles?.length ? v.bundles : undefined,
    })),
  };
  if (historyMode !== 'none') writeFileSync(join(HISTORY_DIR, `${stamp(startedAt)}.json`), JSON.stringify(snapshot), 'utf8');
  writeFileSync(TRACKING_JSON, JSON.stringify(tracking, null, 1), 'utf8');
  // Copia para la web: misma estructura pero sin los campos que app.js no usa ni los valores vacíos (~30 % menos).
  const web = JSON.stringify({ ...output, vehicles: unique.map(slimForWeb) });
  // JSON dentro de un string literal: el motor lo parsea con JSON.parse (más rápido que evaluar un objeto literal
  // de varios MB) y sigue funcionando por file:// (por eso existe este .js además del .json).
  writeFileSync(PUBLIC_INVENTORY_JS, "window.__INVENTORY__=JSON.parse('" + web.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "');\n", 'utf8');
  writeFileSync(PUBLIC_INVENTORY_JSON, web, 'utf8');
  writeSales(tracking, nowIso);

  console.log('');
  console.log(`Total: ${unique.length} vehículos (${output.totals.preowned} pre-owned + ${output.totals.stock} stock) en ${output.durationSec}s (${output.requestCount} requests).`);
  console.log(`  Nuevos: ${added.length} · Retirados: ${removed.length} · Bajadas de precio: ${priceDrops.length} · Subidas: ${priceRises.length} · Con oferta/descuento: ${campaigns.length}`);
  // Para los workflows: ¿ha habido algún cambio real en el inventario? (permite saltarse commit/deploy si no).
  const changed = added.length + removed.length + priceDrops.length + priceRises.length > 0;
  writeFileSync(join(DATA_DIR, 'last-run.json'), JSON.stringify({ generatedAt: nowIso, scope: output.scope, changed, added: added.length, removed: removed.length, priceDrops: priceDrops.length, priceRises: priceRises.length }), 'utf8');
  for (const s of Object.values(marketStatus)) {
    const tag = s.status === 'ok' ? 'ok' : s.status === 'empty' ? 'vacío' : s.status === 'partial' ? 'PARCIAL' : 'ERROR';
    const by = Object.entries(s.bySource).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`  ${s.flag} ${s.name.padEnd(13)} ${String(s.count).padStart(4)}  ${tag.padEnd(7)} ${by}${s.errors.length ? '  ' + s.errors.join(' | ') : ''}${s.note ? '  (' + s.note + ')' : ''}`);
  }
  console.log(`\nEscrito: data/inventory.json, data/history/${stamp(startedAt)}.json, data/tracking.json, public/data/inventory.{js,json}, public/data/sales.{js,json}`);
  console.log('Abrir la web:  npm run serve   →  http://localhost:8787');
}

main().catch((err) => {
  console.error('Fallo general del refresco:', err);
  process.exit(1);
});
