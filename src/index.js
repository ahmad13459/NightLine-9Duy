/**
 * NIGHTLINE · Railway Edition — entry point.
 */
import { ensureDirs, PORT, PANEL_PORTS, PORT_CONFLICT, MUX_PORT, DATA_DIR, BIN, APP, IS_RAILWAY, RAILWAY } from './env.js';
import { auditEnvironment, requirementBanner } from './guard.js';
import { load, get } from './store.js';
import { Runtime } from './runtime.js';
import { createPanelServer } from './http/server.js';

/* ── boot guard: variables + volume are mandatory ─────────────────────── */
const guard = auditEnvironment({ dataDir: process.env.DATA_DIR || process.env.NL_DATA_DIR || '', volumeMount: RAILWAY.volumePath });
if (guard.warn.length) {
  for (const item of guard.warn) {
    console.warn(`[guard] ${item.en} — ${item.fix}`);
  }
}
if (!guard.ok) {
  console.error(requirementBanner(guard));
  process.exit(1);
}

ensureDirs();
load();

const runtime = new Runtime();
const api = { httpRoutes: () => runtime.httpRoutes() };
/** One HTTP listener per candidate port (a Node server can only bind once). */
const servers = [];

const boundPanelPorts = [];

function banner() {
  const doc = get();
  const facts = runtime.facts();
  const lines = [
    '',
    '  ███ NIGHTLINE · Railway',
    `  version ${APP.version} · ${new Date().toISOString()}`,
    `  panel port        : ${boundPanelPorts.join(', ') || PORT}`,
    `  tcp mux port      : ${MUX_PORT}`,
    `  data directory    : ${DATA_DIR}${guard.info.volumeAttached ? ' (volume attached)' : ''}`,
    `  volume path       : ${RAILWAY.volumePath || DATA_DIR}`,
    `  public host       : ${facts.publicHost || '(not detected yet)'}`,
    `  tcp proxy         : ${facts.tcpHost ? `${facts.tcpHost}:${facts.tcpPort}` : '(not enabled)'}`,
    `  railway           : ${IS_RAILWAY ? `${RAILWAY.projectName || '-'} / ${RAILWAY.serviceName || '-'}` : 'local run'}`,
    `  xray binary       : ${BIN.xray}`,
    `  sing-box binary   : ${BIN.singbox}`,
    `  mtg binary        : ${BIN.mtg}`,
    `  setup required    : ${doc.admin ? 'no' : 'yes → open /setup'}`,
    '',
    '  Railway checklist',
    `    public domain  → target port ${boundPanelPorts.includes(8080) ? '8080' : boundPanelPorts[0] || PORT}`,
    `    TCP proxy      → target port ${MUX_PORT}`,
    '',
  ];
  console.log(lines.join('\n'));

  if (PORT_CONFLICT) {
    console.log([
      '  ┌─ PORT CONFLICT ────────────────────────────────────────────────',
      `  │ PORT=${PORT} and NL_TCP_PORT=${MUX_PORT} are the same port.`,
      `  │ The TCP multiplexer keeps :${MUX_PORT} (that is what your Railway`,
      '  │ TCP proxy targets), so the panel is served on:',
      `  │     ${boundPanelPorts.join(', ') || '(none)'}`,
      '  │ Fix it properly with any one of these:',
      `  │   1. set PORT=8080 (panel) and keep the TCP proxy on ${MUX_PORT}`,
      '  │   2. point your Railway domain target at the panel port above',
      '  └────────────────────────────────────────────────────────────────',
      '',
    ].join('\n'));
  }
}

// Listen on every candidate panel port; the first success is enough to boot.
let booted = false;
function onListening(port) {
  if (booted) return;
  booted = true;
  runtime.usePanelPort(port);
  banner();
  runtime.boot().catch((err) => console.error('[boot]', err));
}

if (!PANEL_PORTS.length) {
  console.error('[panel] no usable panel port (PORT / NL_PANEL_PORT collided with NL_TCP_PORT)');
}

for (const port of PANEL_PORTS) {
  const srv = createPanelServer({ runtime, api });
  srv.on('error', (err) => console.error(`[panel] :${port} — ${err.message}`));
  srv.listen(port, '0.0.0.0', () => {
    boundPanelPorts.push(port);
    console.log(`[panel] listening on :${port}`);
    onListening(port);
  });
  servers.push(srv);
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[nightline] ${signal} received, shutting down…`);
  for (const srv of servers) { try { srv.close(); } catch { /* ignore */ } }
  try { await runtime.shutdown(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
