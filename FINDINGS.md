# FINDINGS — Descubrimiento de la fuente de datos (TAREA 1)

Fecha: 2026-08-17. Método: curl con headers de navegador, análisis de los bundles JS
de la SPA, llamadas directas a la API con Python/urllib y verificación final en un
Chrome real (Browser pane) capturando `performance.getEntriesByType('resource')`.

## Resumen ejecutivo

**Opción ganadora: API GraphQL pública, sin cookies ni tokens ("estilo Tesla").**

| | |
|---|---|
| Endpoint | `POST https://pc-api.polestar.com/eu-north-1/partner-rm-tool/public/` |
| Operación | `SearchVehicleAds` (query GraphQL, ver `src/SearchVehicleAds.graphql`) |
| Auth | Ninguna. Solo `Content-Type: application/json`. `Origin`/`Referer` opcionales (CORS permite `https://www.polestar.com`, pero server-side no se comprueba). |
| Variables | `modelCode` (`"359"`=Polestar 3, `"814"`=Polestar 4), `market` (ISO-3166 país en minúsculas: `es`, `be`, `gb`…), `offset`, `limit`, `sortOrder: "Ascending"`, `sortProperty: "Price"`, `equalFilters: []`, `excludeFilters: []` |
| Paginación | `limit=500` devuelve el mercado entero en una sola respuesta (probado con GB/P4 = 290 coches). `metadata.totalCount` permite paginar si hiciera falta. |
| Coste | 1 request por (mercado, modelo). ~65 KB por 11 coches; ~1,7 MB para 290. |

## Paso a paso

### 1. GET simple con headers de navegador → NO hay `__NEXT_DATA__`
La página NO es Next.js. Es una **SPA de Vite (rolldown) + React + Apollo Client**
servida como shell vacío (`<div id="root">` + `<noscript>JavaScript required</noscript>`,
3,7 KB). Sin SSR, sin estado embebido. El HTML solo aporta:
- `<link rel="preconnect" href="https://pc-api.polestar.com">` (pista del backend).
- Los bundles: `/preowned-cars/static/index-*.js`, `gql-*.js`, `apollo-client-*.js`…
- Redirección `/search-result/polestar-4/` → `/search-result/polestar-4-coupe/` (301/302,
  seguida por curl con `-L`).

### 2. `window.__APOLLO_STATE__` u otro estado serializado → NO existe
No hay JSON con coches en el HTML. Sí hay, dentro de los bundles JS, el mapa de
documentos GraphQL de graphql-codegen: las queries completas están en texto plano
en `gql-Do1aLmm5.js` e `index-*.js`. De ahí se extrajo `SearchVehicleAds` íntegra.

Configuración relevante hallada en `gql-BjZrgnsU.js`:
```
api.global       = https://pc-api.polestar.com/eu-north-1/partner-rm-tool/public/   ← inventario ("Remarketing API")
api.global_PRTA  = https://pc-api.polestar.com/eu-north-1/remarketing-administration-api/public
api.global_PRECONFIG = https://pc-api.polestar.com/eu-north-1/preconfigured-cars/  (coches nuevos preconfigurados)
dato.baseUrl     = https://cms-api.polestar.com/   (DatoCMS: textos/traducciones, token público en el bundle)
```
Apollo (`index-*.js`): `HttpLink({uri: api.global, useGETForQueries:false})`; añade
`authorization` **solo si** hay `id_token` de usuario logueado; `credentials:'include'`;
inyecta `variables.origin = window.location.origin`. Mapa slug→modelCode:
`polestar-1→232, polestar-2→534, polestar-3→359, polestar-4→814, polestar-4-coupe→814`.
Llamada inicial del listado: `{modelCode, market, offset:0, limit, sortOrder:'Ascending', sortProperty:'Price', equalFilters:[], excludeFilters:[]}`.

### 3. Playwright/interceptación → NO hizo falta
Se llamó a la API directamente con `urllib` (sin cookies, sin token, sin Origin
obligatorio) y respondió 200 con JSON completo. Después se verificó en un Chrome
real que la SPA hace exactamente esa llamada a esa URL (`de-ch` y `es`).

### 4. Verificaciones adicionales
- **Códigos de mercado**: la API usa el **código de país**, no el slug de la web:
  `nl-be`/`fr-be` → `be`; `uk` → `gb`; `fr-lu` → `lu`; `de-ch` → `ch`. Con el slug
  (`nl-be`, `uk`) la API devuelve 200 con `totalCount:0` (¡no da error!), por eso hay
  que usar los códigos correctos.
- **Sondeo 17/08/2026** (`totalCount` P3 / P4): es 11/11 · fr 8/15 · nl 20/41 · be 21/44 ·
  it 2/0 · dk 2/0 · no 7/2 · gb 111/290 · **de, lu, at, pt, se, fi, ch, ie = 0/0**.
  - `de` y `ch`: verificado en navegador que la web muestra "Keine Fahrzeuge gefunden" → vacío real.
  - `se`: `/se/preowned-cars/` es una landing que enlaza a **wayke.se** (marketplace
    externo) → Suecia NO usa esta app; se marca `empty` (con nota) y no se insiste.
  - `ch` (slug `ch`) redirige a `/global/`; el slug real es `de-ch`/`fr-ch`/`it-ch`.
- **URL de ficha** (ruta React `${base}/product/:model/:carId`), verificada en la web ES:
  `https://www.polestar.com/{slug}/preowned-cars/product/polestar-4-coupe/{id}/`
  y `…/product/polestar-3/{id}/`.
- **Campos**: `vehicleDetails.vin`, `price.retail`+`currency`, `mileageInfo` (`km` en
  UE, **`mi` en GB**), `firstTimeRegistration` (ISO), `modelDetails.modelYear`,
  `motorInfo.value` (código de motorización), `exterior/interior/wheels`, packs
  (`pilotPackage`, `plusPackage`, `performancePackage`, `proPack`, `plusProPackage`,
  `climatePack`), `singleOptions`, `handoverLocation`/`partnerLocation`, `vatDeductible`,
  `media` (fotos reales) y `vehicleImages` (renders de estudio), `versionTimestamp`.
  Las etiquetas (`labels`) solo vienen en el idioma del mercado.
- **Códigos de motorización observados**:
  - Polestar 4 (814): `PB` = Long range Single motor · `PA` = Long range Dual motor
    (el pack Performance del P4 va aparte en `performancePackage` code `220001`).
  - Polestar 3 (359): `EJ` = Long range Single motor · `EA` = Long range Dual motor ·
    `EE` = Long range Dual motor **with Performance pack** · `DE` = "Dual motor" (1 unidad MY2026).
- `cycleState` siempre `PreOwned` en la muestra. `edition` siempre `null`.
- MY observados: P4 2025/2026; P3 2024/2025/2026. Aún no aparece MY2027 ("Polestar 4
  coupé"/"Polestar 4 SUV" ya existen en la web de coches nuevos). El aviso de suspensión se
  aplica por `modelYear >= 2027` **o** `displayName` que contenga "coup".

## Segunda fuente: coches nuevos en stock ("listos para entrega", `/{mercado}/stock-cars/{modelo}/`)

Descubierta con el mismo método (bundles de `/stock-cars/static/*.js` → `config-*.js` con
`api.global = https://pc-api.polestar.com/eu-north-1/preconfigured-cars/`), y el payload exacto se
capturó con Playwright (`page.on('request')`) porque la app envía la query en un chunk lazy
(`ListView-*.js`, `ri.loc.source.body`).

| | |
|---|---|
| Endpoint | `POST https://pc-api.polestar.com/eu-north-1/preconfigured-cars/` |
| Operación | `LoadResultsQuery` → `filteredStockCars` (ver `src/LoadResultsQuery.graphql`). También `LoadFiltersQuery` (facetas) y `Campaigns` (campañas por modelo). |
| Auth | Ninguna. |
| Variables (capturadas) | `{"source":"Preconfigured","includeLocationStock":false,"market":"es","customerType":"B2C","includeValidFilters":false,"sort":{"attribute":"Price","direction":"Asc"},"filters":[{"filterTypeId":"4","filterValues":[{"value":"814","featureCode":"814"}]}],"stateCode":"ES","pagination":{"pageNo":1,"pageSize":10}}` |
| `market` | Aquí es el **slug de la web** (`es`, `nl-be`, `uk`, `fr-lu`…). `be` → error `INTERNAL_ERROR`. |
| `stateCode` | Solo España lo exige (`"ES"`, sale del código: `n===K.ES → stateCode='ES'`). Australia usa estados. |
| `pageSize` | **≤ 20**. Con 50 → `Reached evaluated resolver code size limit` (AppSync). Se pagina de 20 en 20; `pagination.totalRecords` solo es fiable en la primera página (en la última a veces vuelve 0). |
| Modelos | `filterTypeId "4"` con el modelCode: `534` P2 · `359` P3 · `814` P4 (slug `polestar-4-coupe`) · `824` P5. |
| Precio | `cashPriceData.listPrice.totals.car.carTotalPrice.value` (lista, IVA incl.) y `cashPriceData.discounted…carTotalPrice.value` (precio con campaña). `isCampaignEnabled`. La divisa no viene en la respuesta → se toma del mercado. |
| Otros campos | `content[]` con `featureType` = Color / Upholstery / Rims / Packages / Option / Bundle / Model / Engine (código de motor `PB`, `PA`, …) / ModelYear / Drive; `packages[]`, `bundles[]` (Prime pack, Business pack…), `earliestDeliveryDateLabel`, `carVisualizationImages`, `techData`, `wltpNedcSummary`. |
| URL de ficha | `https://www.polestar.com/{slug}/stock-cars/{modelSlug}/{encodeURIComponent(pno34)}/?year={modelYear}&structureweek={startStructureWeek}` (verificado en la web ES). |

Sondeo 17/08/2026 (P4): es 66 · fr 59 · nl 49 · nl-be 53 · de 52 · it 57 · pt 51 · uk 18. Los mercados
del preset "Europa" (ES, FR, NL, BE, DE, IT, PT) tienen `stock: true` en `src/config.js`.

## Riesgos / mantenimiento
- Los nombres de los bundles cambian en cada deploy; la query se guarda localmente en
  `src/SearchVehicleAds.graphql`. Si la API cambia el esquema, la respuesta traerá `errors`
  y el fetcher marcará el mercado como `error` sin romper el resto.
- La API está detrás de Cloudflare + CloudFront. Uso actual: 4 modelos × 16 mercados (pre-owned, paginado
  de 200) + 4 modelos × 7 mercados (stock, paginado de 20) ≈ 100-130 requests con pausas de 2,5 s → ~4-6 min
  por refresco. Sin captchas observados.
- Sin cookies/tokens: si algún día exigen `authorization`, habría que pasar al plan C
  (Playwright).
