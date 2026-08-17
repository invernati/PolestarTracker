#!/usr/bin/env node
// Avisa de cambios (nuevos, bajadas de precio, retirados) del último refresco por Telegram y/o ntfy (push al móvil).
// Se ejecuta después de `npm run refresh` (en GitHub Actions o en local). Sin dependencias.
//
// Configuración por variables de entorno (en GitHub: Settings → Secrets and variables → Actions):
//   NOTIFY_MARKETS   países a vigilar, códigos separados por coma          (defecto: es)
//   NOTIFY_MODELS    modelos, cortos separados por coma                    (defecto: P3,P4)
//   NOTIFY_SOURCES   preowned,stock                                        (defecto: preowned,stock)
//   NOTIFY_VARIANTS  p.ej. "Dual Motor,Performance" para ignorar Single    (defecto: todas)
//   NOTIFY_EVENTS    new,drop,removed                                      (defecto: new,drop)
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   → mensaje por Telegram (bot creado con @BotFather)
//   NTFY_TOPIC (+ NTFY_SERVER, defecto https://ntfy.sh; + NTFY_EMAIL opcional) → notificación push con la app ntfy
//   SMTP_USER + SMTP_PASS + MAIL_TO (+ SMTP_HOST defecto smtp.gmail.com, SMTP_PORT 465, MAIL_FROM) → email por SMTP/TLS
//     (Gmail: activa verificación en 2 pasos y crea una "contraseña de aplicación"; SMTP_USER = tu gmail)
//   SITE_URL         URL de la web publicada, para enlazar en el mensaje (opcional)
//
// Uso:  node src/notify.js            → envía si hay cambios que cumplan el filtro
//       node src/notify.js --dry      → solo imprime el mensaje, no envía
//       node src/notify.js --test     → envía un mensaje de prueba aunque no haya cambios

import { readFileSync, existsSync } from 'node:fs';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_JSON = join(ROOT, 'data', 'inventory.json');
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry');
const test = args.has('--test');

const env = (k, d) => (process.env[k] ?? d);
const list = (k, d) => env(k, d).split(',').map((s) => s.trim()).filter(Boolean);
const MARKETS = list('NOTIFY_MARKETS', 'es').map((s) => s.toLowerCase());
const MODELS = list('NOTIFY_MODELS', 'P3,P4').map((s) => s.toUpperCase());
const SOURCES = list('NOTIFY_SOURCES', 'preowned,stock');
const VARIANTS = list('NOTIFY_VARIANTS', '');
const EVENTS = new Set(list('NOTIFY_EVENTS', 'new,drop'));
const SITE_URL = env('SITE_URL', '');

const nf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const money = (v, cur) => (v == null ? '—' : `${nf.format(v)} ${cur === 'EUR' ? '€' : cur}`);
const km = (v) => (v == null ? '' : `${nf.format(v)} km`);

function matches(v) {
  if (!MARKETS.includes(v.country)) return false;
  if (!MODELS.includes(String(v.modelShort).toUpperCase())) return false;
  if (!SOURCES.includes(v.source)) return false;
  if (VARIANTS.length && !VARIANTS.includes(v.variant)) return false;
  return true;
}

function line(v, kind) {
  const what = v.source === 'stock' ? 'NUEVO en stock' : 'Pre-owned';
  const spec = [v.model, v.variant, v.modelYear ? `MY${v.modelYear}` : '', v.color].filter(Boolean).join(' · ');
  const extra = v.source === 'stock' ? (v.delivery ? `entrega ${v.delivery}` : '') : [km(v.mileageKm), v.location].filter(Boolean).join(' · ');
  let price = money(v.price, v.currency);
  if (kind === 'drop') price = `${money(v.price - v.priceChange, v.currency)} → ${money(v.price, v.currency)} (${money(v.priceChange, v.currency)})`;
  else if (v.source === 'stock' && v.discount > 0) price += ` (lista ${money(v.listPrice, v.currency)}, −${v.discountPct}%)`;
  return `• ${what}: ${spec}\n  ${price}${extra ? ' · ' + extra : ''}\n  ${v.url}`;
}

function build(inv) {
  const g = inv.generatedAt;
  const news = EVENTS.has('new') ? inv.vehicles.filter((v) => matches(v) && v.firstSeen === g && !!inv.previousGeneratedAt) : [];
  const drops = EVENTS.has('drop') ? inv.vehicles.filter((v) => matches(v) && v.priceChange < 0 && v.priceChangeAt === g) : [];
  const removed = EVENTS.has('removed') ? (inv.removed ?? []).filter((v) => matches({ ...v, modelShort: v.model?.replace('Polestar ', 'P') })) : [];
  const parts = [];
  if (news.length) parts.push(`🆕 ${news.length} nuevo${news.length > 1 ? 's' : ''}:\n` + news.map((v) => line(v, 'new')).join('\n'));
  if (drops.length) parts.push(`📉 ${drops.length} bajada${drops.length > 1 ? 's' : ''} de precio:\n` + drops.map((v) => line(v, 'drop')).join('\n'));
  if (removed.length) parts.push(`🚫 ${removed.length} retirado${removed.length > 1 ? 's' : ''}:\n` + removed.map((v) => `• ${v.model} ${v.variant ?? ''} MY${v.modelYear ?? '?'} · ${money(v.price, v.currency)} · ${(v.country || '').toUpperCase()}`).join('\n'));
  if (!parts.length) return null;
  const when = new Date(g).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const scope = `${MARKETS.join(',').toUpperCase()} · ${MODELS.join(',')}`;
  return `Polestar Tracker (${scope}) — ${when}\n\n${parts.join('\n\n')}${SITE_URL ? `\n\n${SITE_URL}` : ''}`;
}

async function sendTelegram(text) {
  const token = env('TELEGRAM_BOT_TOKEN', ''), chat = env('TELEGRAM_CHAT_ID', '');
  if (!token || !chat) return false;
  // Telegram limita a 4096 caracteres por mensaje: trocear si hace falta.
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: chunk, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return true;
}

async function sendNtfy(text) {
  const topic = env('NTFY_TOPIC', '');
  if (!topic) return false;
  const server = env('NTFY_SERVER', 'https://ntfy.sh').replace(/\/$/, '');
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: 'Polestar Tracker', Tags: 'car', Priority: 'default' };
  if (env('NTFY_EMAIL', '')) headers.Email = env('NTFY_EMAIL', '');
  if (SITE_URL) headers.Click = SITE_URL;
  const res = await fetch(`${server}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body: text });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

// Cliente SMTP mínimo (TLS implícito, puerto 465, AUTH LOGIN). Suficiente para Gmail/Outlook/otros con app password.
function sendEmail(text) {
  const user = env('SMTP_USER', ''), pass = env('SMTP_PASS', ''), to = env('MAIL_TO', '');
  if (!user || !pass || !to) return Promise.resolve(false);
  const host = env('SMTP_HOST', 'smtp.gmail.com'), port = Number(env('SMTP_PORT', '465')), from = env('MAIL_FROM', user);
  const subject = 'Polestar Tracker: ' + (text.split('\n')[0] || 'cambios');
  const b64 = (v) => Buffer.from(v, 'utf8').toString('base64');
  const CRLF = '\r\n';
  const body = [
    `From: Polestar Tracker <${from}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    b64(text).replace(/(.{76})/g, '$1' + CRLF), '',
  ].join(CRLF);
  const rcpts = to.split(',').map((x) => x.trim()).filter(Boolean);
  const steps = [
    ['', 220], ['EHLO polestar-tracker', 250], ['AUTH LOGIN', 334], [b64(user), 334], [b64(pass), 235],
    ['MAIL FROM:<' + from + '>', 250], ...rcpts.map((r) => ['RCPT TO:<' + r + '>', 250]), ['DATA', 354], [body + CRLF + '.', 250], ['QUIT', 221],
  ];
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host, port, servername: host }, () => step());
    let i = 0, buf = '';
    const fail = (m) => { sock.destroy(); reject(new Error('SMTP ' + m)); };
    sock.setTimeout(20000, () => fail('timeout'));
    sock.on('error', (e) => reject(new Error('SMTP ' + e.message)));
    function step() { const [cmd] = steps[i]; if (cmd) sock.write(cmd + CRLF); }
    sock.on('data', (d) => {
      buf += d.toString();
      // Respuesta completa: última línea "NNN " (multilínea usa "NNN-").
      const lines = buf.split(CRLF).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3)); buf = '';
      const [, expected] = steps[i];
      if (code !== expected) return fail('paso "' + (steps[i][0] || 'greeting').slice(0, 12) + '": ' + last.slice(0, 120));
      i++;
      if (i >= steps.length) { sock.end(); return resolve(true); }
      step();
    });
  });
}

async function main() {
  if (!existsSync(INVENTORY_JSON)) { console.log('notify: no hay data/inventory.json'); return; }
  const inv = JSON.parse(readFileSync(INVENTORY_JSON, 'utf8'));
  let text = build(inv);
  if (!text && test) text = `Polestar Tracker: mensaje de prueba ✅ (${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })})\nVigilando ${MARKETS.join(',').toUpperCase()} · ${MODELS.join(',')} · ${SOURCES.join(',')}${SITE_URL ? '\n' + SITE_URL : ''}`;
  if (!text) { console.log('notify: sin cambios que avisar'); return; }
  console.log(text);
  if (dry) return;
  const sent = [];
  try { if (await sendTelegram(text)) sent.push('telegram'); } catch (e) { console.error('notify: ' + e.message); process.exitCode = 1; }
  try { if (await sendNtfy(text)) sent.push('ntfy'); } catch (e) { console.error('notify: ' + e.message); process.exitCode = 1; }
  try { if (await sendEmail(text)) sent.push('email'); } catch (e) { console.error('notify: ' + e.message); process.exitCode = 1; }
  const configured = !!(env('TELEGRAM_BOT_TOKEN', '') || env('NTFY_TOPIC', '') || env('SMTP_USER', ''));
  console.log(sent.length ? `notify: enviado por ${sent.join(' + ')}` : configured ? 'notify: no se pudo enviar por ningún canal (ver errores arriba)' : 'notify: ningún canal configurado (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, NTFY_TOPIC o SMTP_USER/SMTP_PASS/MAIL_TO)');
}

main().catch((e) => { console.error('notify: fallo', e); process.exit(1); });
