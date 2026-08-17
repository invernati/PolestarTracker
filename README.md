# Polestar Tracker · Europa

Web local que reúne en un único listado los **Polestar 2/3/4/5** de los inventarios oficiales de
Polestar en Europa — **Pre-owned** (certificados) y **Nuevos en stock** ("listos para entrega") — con
filtros, orden por precio, seguimiento de bajadas de precio y una pestaña de **Ofertas**.

Sin dependencias: solo Node.js ≥ 20 (usa `fetch` nativo). No hay `npm install`.

## Uso rápido

```bash
npm run refresh      # descarga el inventario (≈4-6 min con pausas de cortesía) → data/ y public/data/
npm run serve        # abre http://localhost:8787 (Ctrl+C para parar)
```

También puedes abrir `public/index.html` directamente (doble clic) sin servidor.

Opciones del refresco:

```bash
node src/fetch.js --market=es,fr     # solo esos mercados (el resto se conserva del refresco anterior)
node src/fetch.js --only=stock       # solo nuevos en stock (o --only=preowned)
node src/fetch.js --model=P3,P4      # solo esos modelos (combinable con --market y --only)
node src/fetch.js --delay=1000       # pausa entre requests en ms (por defecto 2500)
node src/fetch.js --offline          # renormaliza data/raw sin llamar a la API (desarrollo)
```

## Qué muestra

| Pestaña | Contenido |
|---|---|
| **Pre-owned** | Inventario certificado. Km, matriculación, precio, IVA deducible, packs, ubicación/Space, VIN, fotos. |
| **Nuevos en stock** | Coches nuevos preconfigurados listos para entrega. Precio de lista vs. precio con oferta, % descuento, fecha estimada de entrega, packs/bundles. |
| **Ofertas y bajadas** | Todo lo que tiene descuento: stock con campaña (precio < lista) y pre-owned cuyo precio ha bajado respecto al máximo visto por el tracker. Ordenado por % de bajada. |
| **Últimas 24 h** | Cambios detectados en las últimas 24 horas: vehículos nuevos (aparecidos después del primer refresco) y bajadas de precio, con la hora del cambio. Cuantos más refrescos al día, más fino el seguimiento. |

Mercados activos: **ES, FR, NL, BE, DE, IT, PT** (los únicos que interesan; otros verificados quedan
comentados en `src/config.js` por si se quieren activar). Filtros: modelo, motorización (Dual / Performance /
Single-Rear), año modelo, países, ocultar Single motor, ocultar P4 MY2027/Coupé, solo IVA deducible, solo con
oferta, **solo nuevos (último refresco)**, **solo bajadas de precio (último refresco)**, precio máx., km máx.,
búsqueda libre. Los contadores de la cabecera **nuevos / retirados / bajadas** comparan con el refresco anterior
y son clicables (nuevos y bajadas filtran la lista; retirados despliega la lista de los que han desaparecido). Clic en una fila → detalle
(interior, llantas, opciones, histórico de precios, enlace a la ficha oficial). Los filtros se guardan
en el navegador.

Marcas visuales: `MY27/Coupé` (P4 sin suspensión semiactiva de serie en Dual Motor) · `no UE` / `RHD`
(aviso de importación) · filas atenuadas = Single/Rear motor · `▼` bajada de precio en el último refresco ·
`oferta −x%` descuento sobre lista · `nuevo` visto por primera vez en el último refresco.

## Arquitectura

```
src/config.js               mercados, modelos, tipos de cambio, pausas, códigos de motor  ← lo que se toca
src/api.js                  cliente GraphQL (fetch nativo, reintentos, paginación) para ambas APIs
src/normalize.js            API → registro plano común (pre-owned y stock)
src/fetch.js                orquestador: recorre mercados×modelos×fuentes, tracking, historial, salida
src/serve.js                servidor estático mínimo (public/; brotli/gzip + ETag/304, sin dependencias)
src/SearchVehicleAds.graphql, src/LoadResultsQuery.graphql   queries extraídas de la web oficial
public/index.html, app.js, styles.css   frontend estático (vanilla JS)
public/data/inventory.js|json           copia reducida de los datos para la web (sin campos que app.js no usa; autocontenida → subible a cualquier hosting)
data/inventory.json         salida canónica (legible, con todos los campos)
data/history/YYYY-MM-DD_HH.json         snapshot compacto por refresco (id, precio, país, modelo… ~0,3 MB) para evolución de precios / rotación
data/tracking.json          por vehículo: firstSeen, lastSeen, removedAt, priceHistory
data/raw/                   respuestas crudas del último refresco (para --offline)
FINDINGS.md                 cómo se descubrieron las APIs (TAREA 1) y sus particularidades
```

### Fuentes de datos (ver `FINDINGS.md`)
- Pre-owned: `POST https://pc-api.polestar.com/eu-north-1/partner-rm-tool/public/` — query `SearchVehicleAds`,
  `market` = código de país (`es`, `be`, `gb`), `modelCode` (`534`, `359`, `814`, `824`), `limit` hasta 500.
- Stock: `POST https://pc-api.polestar.com/eu-north-1/preconfigured-cars/` — query `LoadResultsQuery`
  (`filteredStockCars`), `market` = slug de la web (`es`, `nl-be`, `uk`), `pageSize` ≤ 20, España exige `stateCode: "ES"`.
- Ambas públicas, sin cookies ni tokens. Uso previsto: 1-2 refrescos/día, con pausas entre requests.

### Añadir un modelo o mercado
Edita `src/config.js`: `MODELS` (código + slug de URL) y `MARKETS` (`api`, `slug`, divisa, banderas `eu`/`rhd`/`europe`/`stock`).
Los códigos de motorización nuevos se infieren por la etiqueta; si quieres fijarlos, `MOTOR_CODES`.

## Refresco automático (Windows) — creada pero DESACTIVADA

Existe la tarea programada **"Polestar Tracker refresh"** (08:00, 13:00, 18:00, 22:00, log en `data/refresh.log`),
pero está **desactivada** porque el refresco se hace en GitHub Actions (siguiente apartado) con el PC apagado.
Solo tiene sentido activarla si vuelves a usar el tracker en local sin GitHub:
`Enable-ScheduledTask "Polestar Tracker refresh"` (y `Disable-ScheduledTask …` para pararla).
Ojo: si el repo está en GitHub y además refrescas en local, `data/` cambia en los dos sitios; antes de `git pull`
descarta lo local con `git checkout -- data public/data`.

Cambiar horas / quitarla (PowerShell):

```powershell
# ver estado y horas
Get-ScheduledTask "Polestar Tracker refresh" | Select-Object State
(Get-ScheduledTask "Polestar Tracker refresh").Triggers | % { ([datetime]$_.StartBoundary).ToString('HH:mm') }
# cambiar horas (ejemplo: 07:30, 12:00, 16:30, 21:00)
$t = Get-ScheduledTask "Polestar Tracker refresh"; $t.Triggers = @('07:30','12:00','16:30','21:00') | % { New-ScheduledTaskTrigger -Daily -At $_ }; Set-ScheduledTask -InputObject $t
# ejecutar ahora / quitar
Start-ScheduledTask "Polestar Tracker refresh"
Unregister-ScheduledTask "Polestar Tracker refresh" -Confirm:$false
```

Cómo se creó (por si hay que recrearla en otro PC):

```powershell
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c ""C:\Program Files\nodejs\node.exe" src\fetch.js >> data\refresh.log 2>&1"' -WorkingDirectory "C:\Users\Guille\PolestarTracker"
$triggers = @('08:00','13:00','18:00','22:00') | % { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Polestar Tracker refresh" -Action $action -Trigger $triggers -Settings $settings
```

## ¿Cada cuánto se actualiza y quién lo hace?

Los datos cambian cuando se ejecuta `npm run refresh`. Formas de hacerlo:
- **GitHub Actions** (la buena para tener el PC apagado): el workflow `.github/workflows/refresh-and-deploy.yml`
  refresca a las **08:00, 13:00, 18:00 y 22:00** (hora España, verano) y publica la web en GitHub Pages. También se
  puede lanzar a mano desde Actions → *Run workflow* (incluida la app móvil de GitHub).
- Los botones de la cabecera de la web, **solo cuando la web la sirve `npm run serve` en tu PC** (en GitHub Pages no
  aparecen: una web estática no puede lanzar el fetcher):
  - **↻ Actualizar lo que veo**: solo los países y modelos marcados y la fuente de la pestaña actual (Pre-owned o
    Stock; en Ofertas / Últimas 24 h ambas). España + P3/P4 pre-owned ≈ 4 s; con stock ≈ 15 s. El resto se conserva y
    la cabecera indica "parcial: ES · P3, P4 · pre-owned".
  - **↻ Todo**: refresco completo (≈4-5 min). La página se recarga sola al terminar.
- La tarea programada de Windows (desactivada, ver arriba).
La web muestra en la cabecera la fecha/hora y el alcance del último refresco.

**¿Refresco cada hora?** Técnicamente sí:
- En **tu PC** (tarea programada cada hora): sin problema, ≈100 requests por refresco con pausas de cortesía.
- En **GitHub Actions**: viable en un repositorio **público** (minutos ilimitados). En uno **privado** no cabe:
  24 refrescos × ~5 min ≈ 3600 min/mes > 2000 gratis (≈ 13 €/mes extra). Ten en cuenta que el cron de GitHub
  no es puntual (retrasos de 5-30 min en horas punta y a veces se salta una ejecución) y que el commit de datos
  en cada refresco hace crecer el repo: usa `--history=daily` (un snapshot al día en vez de uno por hora).
  Compromiso razonable: cada 2-3 h de día (`cron: '15 6-22/2 * * *'`) → ~9 refrescos/día, ~1350 min/mes,
  cabe incluso en un repo privado.

## Publicarla en internet con dominio propio (opciones de menos a más esfuerzo)

La web es **100 % estática** (`public/`), así que lo más barato y robusto es NO exponer tu ordenador:

### Opción A (recomendada): GitHub Pages + Actions — PC apagado, acceso desde el móvil

El repo local ya está inicializado y commiteado. Pasos (una sola vez):

1. Crea el repositorio en GitHub: https://github.com/new → nombre `PolestarTracker`, **sin** README/.gitignore
   (ya existen). Público (minutos de Actions ilimitados) o privado (4 refrescos/día ≈ 600 min/mes, dentro de los
   2000 gratis). Luego, en la carpeta del proyecto:
   ```bash
   git remote add origin https://github.com/TU_USUARIO/PolestarTracker.git
   git push -u origin main
   ```
   (Git pedirá login de GitHub la primera vez: navegador o token.)
2. En el repo: **Settings → Pages → Build and deployment → Source: "GitHub Actions"**.
3. **Actions** → workflow *"Refresh inventory & deploy"* → **Run workflow** (o espera al siguiente cron). Al
   terminar, la web está en `https://TU_USUARIO.github.io/PolestarTracker/` — ábrela en el móvil y añádela a la
   pantalla de inicio. Cada refresco commitea `data/` (tracking e historial) y republica.
4. (Opcional) **Dominio propio**: cómpralo en Cloudflare Registrar / Porkbun (~7-11 €/año), en Pages → *Custom domain*
   pon `www.tudominio.com`, y en el DNS crea `CNAME www → TU_USUARIO.github.io` (+ registros A del apex que indica
   GitHub). HTTPS automático.

**Avisos al móvil (Telegram o ntfy) de cambios en P3/P4 España** — ya integrados en el workflow (`src/notify.js`),
solo hay que configurar el canal en Settings → *Secrets and variables* → *Actions*:
- **Telegram**: crea un bot con [@BotFather](https://t.me/BotFather) (`/newbot`) → copia el token. Escribe algo al
  bot y obtén tu chat id abriendo `https://api.telegram.org/bot<TOKEN>/getUpdates` (campo `chat.id`). Secrets:
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- **ntfy** (más simple, sin bot): instala la app *ntfy* (Android/iOS), suscríbete a un tema difícil de adivinar
  (p.ej. `polestar-guille-8f3k2`) y crea el secret `NTFY_TOPIC` con ese nombre. Opcional `NTFY_EMAIL` para recibir
  también un correo (ntfy.sh limita los correos por día).
- Qué se vigila (Variables, no secrets; valores por defecto entre paréntesis): `NOTIFY_MARKETS` (`es`),
  `NOTIFY_MODELS` (`P3,P4`), `NOTIFY_SOURCES` (`preowned,stock`), `NOTIFY_VARIANTS` (todas; p.ej.
  `Dual Motor,Performance` para ignorar Single), `NOTIFY_EVENTS` (`new,drop`; añade `removed` si quieres),
  `SITE_URL` (enlace a tu web en el mensaje).
- Prueba en local: `TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… npm run notify:test` (o `NTFY_TOPIC=…`).
- Email "de verdad" (SMTP) no está incluido a propósito (necesita credenciales de un servidor de correo); ntfy con
  `NTFY_EMAIL` o un bot de Telegram cubren el aviso al móvil sin nada más.

Coste total: 0 € (+ dominio opcional). Alternativas equivalentes: Cloudflare Pages o Netlify (arrastrar `public/`),
pero sin el refresco automático que aquí hace Actions.

### Opción B: correr la web en tu PC y salir a internet sin abrir puertos
Si quieres que sea tu ordenador quien sirva la web (`npm run serve`), lo seguro es un **túnel**, no abrir el router:
- **Cloudflare Tunnel** (gratis, necesita que el dominio use los DNS de Cloudflare): instala `cloudflared`, `cloudflared tunnel login`,
  `cloudflared tunnel create polestar`, `cloudflared tunnel route dns polestar tracker.tudominio.com` y ejecútalo como servicio
  apuntando a `http://localhost:8787`. Sin puertos abiertos, HTTPS incluido y puedes poner **Cloudflare Access** delante
  (login con tu email) para que solo tú la veas.
- **Tailscale** (gratis, sin dominio): instala Tailscale en el PC y en el móvil; accedes a `http://<nombre-pc>:8787` desde
  cualquier sitio, de forma privada. Con `tailscale funnel 8787` la haces pública con una URL `*.ts.net`.
- El PC tiene que estar encendido; combínalo con la tarea programada del apartado anterior. Para el servidor local usa
  `HOST=0.0.0.0` solo si de verdad quieres exponerlo en la LAN; con túnel no hace falta.

### Opción C: VPS barato
Un VPS de 3-5 €/mes (Hetzner, OVH, IONOS…) corriendo `npm run refresh` por cron + nginx sirviendo `public/`. Más control, más mantenimiento.
Para este caso de uso, la opción A es mejor y más barata.

### Costes orientativos (2026, IVA incl., precios aproximados)

| | Qué se paga | Al mes | Al año |
|---|---|---|---|
| **A** GitHub Pages + Actions | Hosting y refresco automático: 0 € (repo público o privado dentro de los 2000 min/mes gratis; ~8 min × 2/día ≈ 500 min/mes). Dominio `.com` ≈ 10-11 €/año o `.es` ≈ 7-9 €/año en Cloudflare Registrar / Porkbun. Sin dominio: 0 €. | **≈ 0,6-0,9 €** (0 € sin dominio) | **≈ 7-11 €** |
| **B** PC propio + Cloudflare Tunnel o Tailscale | Túnel/Tailscale: 0 €. Dominio: 7-11 €/año (Tailscale no lo necesita). Electricidad del PC encendido 24 h (60-100 W a ~0,15-0,20 €/kWh) ≈ 7-14 €/mes; si lo enciendes solo cuando lo usas, casi 0 pero la web no está disponible el resto del tiempo. Alternativa: mini-PC/Raspberry Pi (50-100 € una vez, ~5 W ≈ 1 €/mes). | **≈ 8-15 €** (PC 24 h) · ≈ 1-2 € (Raspberry) | **≈ 100-180 €** (PC 24 h) · ≈ 20-25 € + hardware (Raspberry) |
| **C** VPS | VPS pequeño (Hetzner CX22 ≈ 4,5 €/mes; IONOS/OVH desde ≈ 1-4 €/mes) + dominio 7-11 €/año. | **≈ 2-6 €** | **≈ 25-70 €** |

En los tres casos las APIs de Polestar son gratuitas y públicas; no hay más costes.
