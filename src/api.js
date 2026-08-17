import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  API_URL, STOCK_API_URL, USER_AGENT, PAGE_LIMIT, STOCK_PAGE_SIZE, MAX_RETRIES, REQUEST_TIMEOUT_MS,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREOWNED_QUERY = readFileSync(join(__dirname, 'SearchVehicleAds.graphql'), 'utf8');
const STOCK_QUERY = readFileSync(join(__dirname, 'LoadResultsQuery.graphql'), 'utf8');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST GraphQL genérico con reintentos y timeout. Devuelve `json.data`.
 * Lanza Error con mensaje legible (HTTP xxx / GraphQL: …).
 */
async function graphql(url, body) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*',
          Origin: 'https://www.polestar.com',
          Referer: 'https://www.polestar.com/',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        // Posible captcha / rate limit: no insistir más de lo configurado.
        throw new Error(`HTTP ${res.status} (posible bloqueo/rate-limit)`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors?.length) {
        throw new Error('GraphQL: ' + json.errors.map((e) => e.message).join('; '));
      }
      if (!json.data) throw new Error('Respuesta sin data');
      return json.data;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(4000 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Pre-owned (SearchVehicleAds)
// ---------------------------------------------------------------------------

/** Una llamada a SearchVehicleAds. Devuelve { metadata, vehicleAds }. */
export async function searchVehicleAds({ market, modelCode, offset = 0, limit = PAGE_LIMIT }) {
  const data = await graphql(API_URL, {
    operationName: 'SearchVehicleAds',
    query: PREOWNED_QUERY,
    variables: {
      modelCode: String(modelCode),
      market,
      offset,
      limit,
      sortOrder: 'Ascending',
      sortProperty: 'Price',
      equalFilters: [],
      excludeFilters: [],
      origin: 'https://www.polestar.com',
    },
  });
  if (!data.searchVehicleAds) throw new Error('Respuesta sin data.searchVehicleAds');
  return data.searchVehicleAds;
}

/** Descarga TODO el inventario pre-owned de un (mercado, modelo), paginando si hace falta. */
export async function fetchAllVehicleAds({ market, modelCode, delayMs = 0 }) {
  const all = [];
  let offset = 0;
  let total = Infinity;
  let limit = PAGE_LIMIT;
  let requests = 0;
  while (offset < total) {
    let page;
    try {
      page = await searchVehicleAds({ market, modelCode, offset, limit });
      requests++;
    } catch (err) {
      // Con muchos coches (GB/P2 ≈ 440) la API falla con "internal error" para páginas grandes:
      // reducir el tamaño de página y reintentar.
      requests++;
      if (limit > 50) { limit = Math.max(50, Math.floor(limit / 2)); await sleep(2000); continue; }
      throw err;
    }
    total = page.metadata?.totalCount ?? 0;
    const ads = page.vehicleAds ?? [];
    all.push(...ads);
    if (!ads.length) break;
    offset += ads.length;
    if (offset < total && delayMs) await sleep(delayMs);
  }
  return { total: Number.isFinite(total) ? total : all.length, vehicleAds: all, requests };
}

// ---------------------------------------------------------------------------
// Stock cars / coches nuevos listos para entrega (LoadResultsQuery → filteredStockCars)
// ---------------------------------------------------------------------------

/** Una página de stock cars. `market` es el slug de la web (es, nl-be, uk…). */
export async function loadStockPage({ market, modelCode, pageNo = 1, pageSize = STOCK_PAGE_SIZE, stateCode }) {
  const variables = {
    source: 'Preconfigured',
    includeLocationStock: false,
    market,
    customerType: 'B2C',
    includeValidFilters: false,
    sort: { attribute: 'Price', direction: 'Asc' },
    filters: [{ filterTypeId: '4', filterValues: [{ value: String(modelCode), featureCode: String(modelCode) }] }],
    pagination: { pageNo, pageSize },
  };
  if (stateCode) variables.stateCode = stateCode;
  const data = await graphql(STOCK_API_URL, { operationName: 'LoadResultsQuery', query: STOCK_QUERY, variables });
  if (!data.vehicles) throw new Error('Respuesta sin data.vehicles');
  return data.vehicles;
}

/** Descarga TODO el stock de un (mercado, modelo) paginando de STOCK_PAGE_SIZE en STOCK_PAGE_SIZE. */
export async function fetchAllStockCars({ market, modelCode, stateCode, delayMs = 0 }) {
  const all = [];
  let pageNo = 1;
  let total = Infinity;
  let requests = 0;
  while (all.length < total) {
    const page = await loadStockPage({ market, modelCode, pageNo, stateCode });
    requests++;
    // totalRecords solo es fiable en la primera página (en la última a veces vuelve 0).
    if (pageNo === 1) total = page.pagination?.totalRecords ?? 0;
    const cars = page.filterResults ?? [];
    all.push(...cars);
    // La API puede devolver páginas intermedias con menos de pageSize ítems (dedup interno), así que
    // solo paramos en página vacía o cuando ya tenemos totalRecords.
    if (!cars.length) break;
    pageNo++;
    if (all.length < total && delayMs) await sleep(delayMs);
    if (pageNo > 100) break; // cinturón de seguridad
  }
  return { total: Number.isFinite(total) ? Math.max(total, all.length) : all.length, cars: all, requests };
}
