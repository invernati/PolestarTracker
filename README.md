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
| **Ventas** | Histórico de vehículos retirados del inventario oficial (≈ vendidos/reservados). Un coche que vuelve a aparecer —con el mismo anuncio o con un anuncio nuevo pero el **mismo VIN**— se reconoce como *relistado*: hereda su historial, no cuenta como nuevo ni como venta doble, y la retirada anterior deja de contar. KPIs: modelo y coche más vendidos, país, mediana de días en venta, precio medio; gráfica apilada por modelo (mes / semana / día); tabla con versión, año, km, último precio (e inicial), días en venta. Respeta los filtros. Datos desde el primer refresco (17/08/2026); fuente `public/data/sales.json`, generada desde `data/tracking.json`. |

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

Los datos cambian cuando se ejecuta `npm run refresh`. En producción lo hacen **dos workflows de GitHub Actions**
(tu PC puede estar apagado; ambos avisan por Telegram/ntfy/email y republican la web):

| Workflow | Alcance | Frecuencia (hora España, verano) | Coste por run |
|---|---|---|---|
| `refresh-and-deploy.yml` **General** | 7 mercados × 4 modelos × 2 fuentes | **cada hora**, en el minuto 05, de 07:05 a 00:05 (cron `5 5-22 * * *` UTC) | ~102 requests, 6-8 min |
| `refresh-es.yml` **España rápido** | solo ES (pre-owned + stock, todos los modelos) | **cada 10 min** de 07:00 a 00:50 (cron `*/10 5-22 * * *` UTC) | ~15 requests, 1-2 min |

Comparten cola (`concurrency: refresh-deploy`): nunca se solapan; si el general está corriendo, el de España espera,
y si se acumulan runs en cola solo se conserva el más reciente. Al día: ~18 generales + ~100 de España ≈ **3.300 requests
a Polestar y ~330 min de Actions** (gratis en repo público). En invierno (CET) los crons quedan una hora antes en hora
local; para mantener 07-00 cambia `5-22` por `6-23` en ambos ficheros. GitHub no admite crons de menos de 5 min y en
horas punta los retrasa; 10 min es el mínimo práctico.

La cabecera de la web muestra **"Actualizado: general hh:mm · España hh:mm"** (último refresco completo y último de
España) y el alcance del último run. En la web publicada no hay botón de refresco (es estática); sí puedes lanzar un
run a mano desde Actions → *Run workflow* (app móvil incluida). Los botones **↻ Actualizar lo que veo / ↻ Todo**
aparecen solo cuando la web la sirve `npm run serve` en tu PC (España + P3/P4 pre-owned ≈ 4 s; todo ≈ 4-5 min).

**¿Más frecuencia?** En repo público los minutos de Actions son ilimitados, así que el freno real es la cortesía con
la API de Polestar y la puntualidad del cron. Si algún día pasas el repo a privado (con GitHub Student tienes 3.000
min/mes), la configuración actual (~330 min/día ≈ 10.000 min/mes) NO cabría: vuelve a 4-8 generales/día y España
cada 30 min, o déjalo público.

## Publicarla en internet con dominio propio (opciones de menos a más esfuerzo)

La web es **100 % estática** (`public/`), así que lo más barato y robusto es NO exponer tu ordenador:

### Opción A (recomendada): GitHub Pages + Actions — PC apagado, acceso desde el móvil

El repo local ya está inicializado y commiteado. Pasos (una sola vez):

1. Crea el repositorio en GitHub: https://github.com/new → nombre `PolestarTracker`, **sin** README/.gitignore
   (ya existen). Público (minutos de Actions ilimitados) o privado (4 refrescos/día ≈ 600 min/mes, dentro de los
   2000 gratis). Luego, en la carpeta del proyecto:
   ```bash
   git remote add origin https://github.com/invernati/PolestarTracker.git
   git push -u origin main
   ```
   (Git pedirá login de GitHub la primera vez: navegador o token.)
2. En el repo: **Settings → Pages → Build and deployment → Source: "GitHub Actions"**.
3. **Actions** → workflow *"Refresh inventory & deploy"* → **Run workflow** (o espera al siguiente cron). Al
   terminar, la web está en `https://invernati.github.io/PolestarTracker/` — ábrela en el móvil y añádela a la
   pantalla de inicio. Cada refresco commitea `data/` (tracking e historial) y republica.
4. (Opcional) **Dominio propio**: cómpralo en Cloudflare Registrar / Porkbun (~7-11 €/año), en Pages → *Custom domain*
   pon `www.tudominio.com`, y en el DNS crea `CNAME www → invernati.github.io` (+ registros A del apex que indica
   GitHub). HTTPS automático.

**Avisos al móvil (Telegram o ntfy) de cambios en P3/P4 España** — ya integrados en el workflow (`src/notify.js`),
solo hay que configurar el canal en Settings → *Secrets and variables* → *Actions*:
- **Telegram**: crea un bot con [@BotFather](https://t.me/BotFather) (`/newbot`) → copia el token. Escribe algo al
  bot y obtén tu chat id abriendo `https://api.telegram.org/bot<TOKEN>/getUpdates` (campo `chat.id`). Secrets:
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- **ntfy** (más simple, sin bot): instala la app *ntfy* (Android/iOS), suscríbete a un tema difícil de adivinar
  (p.ej. `polestar-guille-8f3k2`) y crea el secret `NTFY_TOPIC` con ese nombre. Opcional `NTFY_EMAIL` para recibir
  también un correo (ntfy.sh limita los correos por día).
- **Email (SMTP, sin dependencias)**: secrets `SMTP_USER` (tu correo), `SMTP_PASS` y `MAIL_TO` (destinatario, puede ser
  el mismo). Por defecto usa Gmail (`smtp.gmail.com:465`): activa la verificación en 2 pasos y crea una **contraseña
  de aplicación** en https://myaccount.google.com/apppasswords (16 letras) → esa es `SMTP_PASS`. Otros proveedores:
  `SMTP_HOST`, `SMTP_PORT` (465, TLS implícito) y `MAIL_FROM`.
- **Qué se vigila: desde la web, botón 🔔 Avisos.** Ajusta los filtros (países, modelos, Dual/Single, año, precio máx.,
  km máx., pestaña Pre-owned/Stock) → "Añadir a la lista" (elige nuevos / bajadas / retirados) → "Guardar en GitHub".
  Las alertas viven en `public/alerts.json` (varias a la vez, se pueden pausar/eliminar). Para guardar desde la web
  hace falta un **token de GitHub** que se queda solo en tu navegador: https://github.com/settings/personal-access-tokens/new
  → *Fine-grained*, *Only select repositories* → PolestarTracker, *Repository permissions → Contents: Read and write*.
  Sin token: "Copiar JSON" y pegarlo con el enlace "Abrir alerts.json en GitHub". Cada guardado dispara un refresco y
  el aviso se aplica desde entonces (España se comprueba cada 10 min).
- Respaldo por variables de entorno si `alerts.json` no tiene alertas (Variables, no secrets; por defecto entre paréntesis): `NOTIFY_MARKETS` (`es`),
  `NOTIFY_MODELS` (`P3,P4`), `NOTIFY_SOURCES` (`preowned,stock`), `NOTIFY_VARIANTS` (todas; p.ej.
  `Dual Motor,Performance` para ignorar Single), `NOTIFY_EVENTS` (`new,drop`; añade `removed` si quieres),
  `SITE_URL` (enlace a tu web en el mensaje).
- Prueba en local: `TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… npm run notify:test` (o `NTFY_TOPIC=…`, o `SMTP_USER=… SMTP_PASS=… MAIL_TO=…`).
- Los tres canales pueden convivir (se envía por todos los que estén configurados).

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
