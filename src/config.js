// Configuración del fetcher. Todo lo "ajustable" vive aquí.

// --- API Pre-owned (Remarketing) ---
export const API_URL = 'https://pc-api.polestar.com/eu-north-1/partner-rm-tool/public/';
// --- API Stock cars / coches nuevos listos para entrega (Preconfigured cars) ---
export const STOCK_API_URL = 'https://pc-api.polestar.com/eu-north-1/preconfigured-cars/';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

// Cortesía: pausa entre requests (ms) y reintentos por request.
export const DELAY_BETWEEN_REQUESTS_MS = 2500;
export const DELAY_BETWEEN_PAGES_MS = 1200;
export const MAX_RETRIES = 2;
export const REQUEST_TIMEOUT_MS = 45000;
// Pre-owned: la API acepta limit grandes, pero con >≈300 coches (GB/P2) devuelve "internal error"; 200 es seguro y se pagina.
export const PAGE_LIMIT = 200;
// Stock cars: el resolver de AppSync falla con pageSize>≈20 ("Reached evaluated resolver code size limit").
export const STOCK_PAGE_SIZE = 20;

// Modelos: modelCode de la API → metadatos. Añadir aquí modelos nuevos cuando aparezcan.
//  - slug: segmento de URL de la ficha (pre-owned y stock usan los mismos slugs; el P4 es "polestar-4-coupe").
//  - preowned/stock: si se consulta ese inventario para el modelo.
export const MODELS = {
  534: { name: 'Polestar 2', short: 'P2', slug: 'polestar-2', preowned: true, stock: true },
  359: { name: 'Polestar 3', short: 'P3', slug: 'polestar-3', preowned: true, stock: true },
  814: { name: 'Polestar 4', short: 'P4', slug: 'polestar-4-coupe', preowned: true, stock: true },
  824: { name: 'Polestar 5', short: 'P5', slug: 'polestar-5', preowned: true, stock: true },
};

// Mercados.
//  api    = variable `market` de la API Pre-owned (código ISO de país: be, gb, …)
//  slug   = segmento de URL de polestar.com; también es el `market` de la API de stock cars (nl-be, uk, …)
//  eu     = Unión Europea · rhd = volante a la derecha
//  europe = mercado del preset "Europa" (actualmente todos los activos)
//  stock  = consultar también el inventario de coches nuevos en stock (stock-cars)
//  stockState = valor de `stateCode` que exige la API de stock (solo España usa 'ES')
//  note   = texto informativo que se muestra en la cabecera
export const MARKETS = [
  { api: 'es', slug: 'es',    name: 'España',        flag: '🇪🇸', currency: 'EUR', eu: true,  rhd: false, europe: true, stock: true, stockState: 'ES' },
  { api: 'fr', slug: 'fr',    name: 'Francia',       flag: '🇫🇷', currency: 'EUR', eu: true,  rhd: false, europe: true, stock: true },
  { api: 'nl', slug: 'nl',    name: 'Países Bajos',  flag: '🇳🇱', currency: 'EUR', eu: true,  rhd: false, europe: true, stock: true },
  { api: 'be', slug: 'nl-be', name: 'Bélgica',       flag: '🇧🇪', currency: 'EUR', eu: true,  rhd: false, europe: true, stock: true,
    note: 'nl-be y fr-be comparten inventario' },
  { api: 'de', slug: 'de',    name: 'Alemania',      flag: '🇩🇪', currency: 'EUR', eu: true,  rhd: false, europe: true, stock: true },
  { api: 'it', slug: 'it',    name: 'Italia',        flag: '🇮🇹', currency: 'EUR', eu: true,  rhd: false, europe: true, stock: true },
  { api: 'pt', slug: 'pt',    name: 'Portugal',      flag: '🇵🇹', currency: 'EUR', eu: true,  rhd: false, europe: true, stock: true },
  // Otros mercados verificados (17/08/2026) por si algún día interesan; añadir aquí para activarlos:
  //   { api: 'lu', slug: 'fr-lu', name: 'Luxemburgo',  currency: 'EUR', eu: true,  rhd: false }   (pre-owned vacío)
  //   { api: 'at', slug: 'at',    name: 'Austria',     currency: 'EUR', eu: true,  rhd: false }   (vacío)
  //   { api: 'fi', slug: 'fi',    name: 'Finlandia',   currency: 'EUR', eu: true,  rhd: false }   (vacío)
  //   { api: 'dk', slug: 'dk',    name: 'Dinamarca',   currency: 'DKK', eu: true,  rhd: false }
  //   { api: 'se', slug: 'se',    name: 'Suecia',      currency: 'SEK', eu: true,  rhd: false }   (pre-owned oficial vía wayke.se; API casi vacía)
  //   { api: 'no', slug: 'no',    name: 'Noruega',     currency: 'NOK', eu: false, rhd: false }
  //   { api: 'ch', slug: 'de-ch', name: 'Suiza',       currency: 'CHF', eu: false, rhd: false }   (vacío)
  //   { api: 'gb', slug: 'uk',    name: 'Reino Unido', currency: 'GBP', eu: false, rhd: true  }   (~840 pre-owned, RHD; stock cars: market 'uk')
  //   { api: 'ie', slug: 'ie',    name: 'Irlanda',     currency: 'EUR', eu: true,  rhd: true  }   (vacío)
];

// Tipos de cambio fijos → EUR (solo para ORDENAR/comparar; ajustar a mano cuando convenga).
export const FX_TO_EUR = {
  EUR: 1,
  GBP: 1.17,
  CHF: 1.06,
  NOK: 0.086,
  SEK: 0.089,
  DKK: 0.134,
};

// Códigos de motorización (motorInfo.value en pre-owned; content[Engine].code en stock) → variante normalizada.
// Si aparece un código nuevo, se infiere por la etiqueta (single/rear/dual/performance).
//  P4: PB Single (Rear motor) · PA Dual.
//  P3 MY24-25: EJ Single · EA Dual · EE Dual+Performance. P3 MY26 (800 V): DD Rear · DE Dual · DA Performance.
//  P2 (según año): EU/EF/FC Standard range Single · EG/FE Long range Single · ED/FD Long range Dual · ET/FF Long range Dual+Performance.
//  P5: GC Dual (Launch edition) · GA Performance (Launch edition).
export const MOTOR_CODES = {
  814: { PB: 'Single Motor', PA: 'Dual Motor' },
  359: { EJ: 'Single Motor', EA: 'Dual Motor', EE: 'Performance', DD: 'Single Motor', DE: 'Dual Motor', DA: 'Performance' },
  534: { EU: 'Single Motor', EF: 'Single Motor', FC: 'Single Motor', EG: 'Single Motor', FE: 'Single Motor', ED: 'Dual Motor', FD: 'Dual Motor', ET: 'Performance', FF: 'Performance' },
  824: { GC: 'Dual Motor', GA: 'Performance' },
};

export const MILES_TO_KM = 1.609344;
