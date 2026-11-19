'use strict';
// FreePBX operator panel bridge: Asterisk AMI (TCP) <-> authenticated WebSocket.
const net = require('net'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = process.env;
const cfg = {
  host: E.AMI_HOST || '127.0.0.1', port: +E.AMI_PORT || 5038, user: E.AMI_USER, secret: E.AMI_SECRET,
  listen: E.LISTEN_HOST || '127.0.0.1', lport: +E.LISTEN_PORT || 8099,
  puser: E.PANEL_USER || 'operator', ppass: E.PANEL_PASS,
  ctx: E.DIAL_CONTEXT || 'from-internal',
  confs: (E.CONF_ROOMS || '').split(',').map(s => s.trim()).filter(Boolean), // "800:Sales,801:Support"
  ivrs: Object.fromEntries((E.IVR_NAMES || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(s => { const [i, ...n] = s.split(':'); return [i, n.join(':')]; })), // "2:Main,3:Support" (id from ivr-<id>)
  ktoken: E.KIOSK_TOKEN || '', // optional: lets a wall display sign in from a URL fragment
  kips: (E.KIOSK_IPS || '').split(/[\s,]+/).filter(Boolean), // optional: restrict the token to these client IPs
  dbUser: E.DB_USER,
  shortcuts: (E.SHORTCUTS || '').split(',').map(s => s.trim()).filter(Boolean) // "Park:70,Voicemail:*101"
    .map(s => { const i = s.lastIndexOf(':'); return { label: s.slice(0, i), code: s.slice(i + 1) }; }).filter(s => s.label && s.code)
};
if (cfg.ktoken && cfg.ktoken.length < 24) { console.error('KIOSK_TOKEN must be at least 24 characters'); process.exit(1); }
if (!cfg.user || !cfg.secret || !cfg.ppass) { console.error('AMI_USER, AMI_SECRET and PANEL_PASS are required'); process.exit(1); }

const S = { exts: new Map(), ch: new Map(), confs: [], lots: [], parked: [], queues: [] };
const D = { rg: [], q: new Map(), ivr: new Map(), conf: [] }; // FreePBX database (names, membership)
const u = v => (!v || v === '<unknown>') ? '' : String(v);
const dev = s => String(s || '').toUpperCase().replace(/[\s_]/g, ''); // "Not in use" and NOT_INUSE -> NOTINUSE
const NUM = /^[0-9*#+]{1,32}$/;

// Optional network allowlist for the whole panel (page and WebSocket): ALLOW_IPS="192.168.0.0/24 10.0.0.5"
const ipNum = ip => { const p = ip.split('.'); return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x < 256) ? +p[0] * 16777216 + +p[1] * 65536 + +p[2] * 256 + +p[3] : null; };
const allow = (E.ALLOW_IPS || '').split(/[\s,]+/).filter(Boolean).map(t => {
  const [a, b] = t.split('/'), n = ipNum(a), bits = b === undefined ? 32 : (/^\d{1,2}$/.test(b) ? +b : -1);
  if (n === null || bits < 0 || bits > 32) { console.error('ALLOW_IPS entries must be IPv4 addresses or CIDR ranges such as 192.168.0.0/24'); process.exit(1); }
  const size = 2 ** (32 - bits), lo = Math.floor(n / size) * size;
  return { lo, hi: lo + size - 1 };
});
const cip = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const allowed = ip => { if (!allow.length) return true; const n = ipNum(ip); return n !== null && allow.some(r => n >= r.lo && n <= r.hi); };

// ---- AMI client ----
let sock = null, buf = '', seq = 0, ready = false;
const pend = new Map();
const clean = v => { v = String(v); if (/[\r\n]/.test(v)) throw new Error('Invalid value'); return v; };

function act(name, args = {}) {
  return new Promise((res, rej) => {
    if (!sock || sock.destroyed) return rej(new Error('AMI unavailable'));
    const id = String(++seq);
    let m = `Action: ${name}\r\nActionID: ${id}\r\n`;
    for (const [k, v] of Object.entries(args)) m += `${k}: ${clean(v)}\r\n`;
    const t = setTimeout(() => { pend.delete(id); rej(new Error('AMI timeout')); }, 10000);
    pend.set(id, { ev: [], res: x => { clearTimeout(t); res(x); }, rej: e => { clearTimeout(t); rej(e); } });
    sock.write(m + '\r\n');
  });
}

function block(b) {
  const m = {};
  for (const l of b.split('\r\n')) { const i = l.indexOf(': '); if (i > 0) m[l.slice(0, i)] = l.slice(i + 2); }
  const p = pend.get(m.ActionID), el = (m.EventList || '').toLowerCase();
  if (m.Response) {
    if (!p) return;
    if (m.Response === 'Error') { pend.delete(m.ActionID); p.rej(new Error(m.Message || 'AMI error')); }
    else if (el === 'start') p.list = true;
    else { pend.delete(m.ActionID); p.res([]); }
    return;
  }
  if (!m.Event) return;
  if (p && p.list) {
    if (el === 'complete') { pend.delete(m.ActionID); p.res(p.ev); } else p.ev.push(m);
    return;
  }
  onEvent(m);
}

function connect() {
  buf = ''; ready = false;
  let hello = false;
  sock = net.connect(cfg.port, cfg.host);
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d;
    if (!hello) {
      const i = buf.indexOf('\r\n'); if (i < 0) return;
      hello = true; buf = buf.slice(i + 2);
      act('Login', { Username: cfg.user, Secret: cfg.secret })
        .then(() => { ready = true; console.log('AMI connected'); sync(); })
        .catch(e => console.error('AMI login failed:', e.message));
    }
    let i;
    while ((i = buf.indexOf('\r\n\r\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 4); block(b); }
  });
  sock.on('error', e => console.error('AMI socket:', e.message));
  sock.on('close', () => {
    ready = false;
    for (const p of pend.values()) p.rej(new Error('AMI closed'));
    pend.clear(); setTimeout(connect, 3000);
  });
}

// ---- State ----
const mk = (n, e) => ({ name: n, lid: e.Linkedid, num: e.CallerIDNum, cname: e.CallerIDName, cnum: e.ConnectedLineNum,
  cn: e.ConnectedLineName, state: e.ChannelStateDesc || '', bridge: '', since: Date.now(), ctx: e.Context || '', exten: e.Exten || '', app: e.Application || '', csince: Date.now() });
const hms = s => { const p = (s || '0:0:0').split(':').map(Number); return ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000 || 0; };

async function syncExts() {
  const eps = (await act('PJSIPShowEndpoints')).filter(e => e.Event === 'EndpointList');
  const next = new Map();
  for (let i = 0; i < eps.length; i += 20) {
    await Promise.all(eps.slice(i, i + 20).map(async e => {
      try { // only FreePBX extensions have AMPUSER/<ext>/cidname; trunks fail here and are skipped
        const r = await act('DBGet', { Family: 'AMPUSER', Key: e.ObjectName + '/cidname' });
        next.set(e.ObjectName, { id: e.ObjectName, name: (r[0] && r[0].Val) || '', state: dev(e.DeviceState) });
      } catch { /* not an extension */ }
    }));
  }
  S.exts = next;
}

async function syncCalls() {
  const next = new Map();
  for (const e of (await act('CoreShowChannels')).filter(e => e.Event === 'CoreShowChannel')) {
    const c = mk(e.Channel, e);
    c.bridge = (e.BridgeId && e.BridgeId !== '(null)') ? e.BridgeId : '';
    c.since = Date.now() - hms(e.Duration); c.csince = c.since;
    next.set(e.Channel, c);
  }
  S.ch = next;
}

async function syncConfs() {
  const rooms = new Map();
  const cl = D.conf.length ? D.conf : cfg.confs.map(r => { const [id, ...n] = r.split(':'); return { id, name: n.join(':') }; });
  for (const c of cl) rooms.set(c.id, { id: c.id, name: c.name, members: [], locked: false });
  let l = [];
  try { l = (await act('ConfBridgeListRooms')).filter(e => e.Event === 'ConfbridgeListRooms'); } catch { /* none active */ }
  for (const e of l) {
    const r = rooms.get(e.Conference) || { id: e.Conference, name: '', members: [] };
    r.locked = e.Locked === 'Yes';
    rooms.set(e.Conference, r);
    try {
      r.members = (await act('ConfBridgeList', { Conference: e.Conference })).filter(x => x.Event === 'ConfbridgeList')
        .map(x => {
          const id = (/^PJSIP\/([^-]+)-/.exec(x.Channel) || [])[1], ex = S.exts.get(id);
          return { ch: x.Channel, num: ex ? id : u(x.CallerIDNum), name: ex ? ex.name : u(x.CallerIDName), admin: x.Admin === 'Yes', muted: x.Muted === 'Yes' };
        });
    } catch { /* room ended */ }
  }
  S.confs = [...rooms.values()];
}

async function syncPark() {
  try { S.lots = (await act('Parkinglots')).filter(e => e.Event === 'Parkinglot').map(e => ({ name: e.Name, start: +e.StartSpace, stop: +e.StopSpace })); } catch { S.lots = []; }
  try {
    S.parked = (await act('ParkedCalls')).filter(e => e.Event === 'ParkedCall').map(e => ({ lot: e.Parkinglot, space: +e.ParkingSpace,
      ch: e.ParkeeChannel, num: u(e.ParkeeCallerIDNum), name: u(e.ParkeeCallerIDName), since: Date.now() - (+e.ParkingDuration || 0) * 1000 }));
  } catch { S.parked = []; }
}

let pool = null;
if (cfg.dbUser) {
  pool = require('mysql2/promise').createPool({ socketPath: E.DB_SOCKET || undefined, host: E.DB_SOCKET ? undefined : (E.DB_HOST || '127.0.0.1'),
    user: cfg.dbUser, password: E.DB_PASS, database: E.DB_NAME || 'asterisk', connectionLimit: 2 });
}
async function syncDb() { // read-only: names and ring group membership, which AMI does not expose
  if (!pool) return;
  try {
    const [rg] = await pool.query('SELECT grpnum, description, grplist FROM ringgroups');
    const [q] = await pool.query('SELECT extension, descr FROM queues_config');
    const [iv] = await pool.query('SELECT id, name FROM ivr_details');
    const [cf] = await pool.query('SELECT exten, description FROM meetme');
    D.rg = rg.map(r => ({ id: String(r.grpnum), name: r.description || '', members: String(r.grplist).replace(/#/g, '').split('-').filter(Boolean) }));
    D.q = new Map(q.map(r => [String(r.extension), r.descr || '']));
    D.ivr = new Map(iv.map(r => [String(r.id), r.name || '']));
    D.conf = cf.map(r => ({ id: String(r.exten), name: r.description || '' }));
  } catch (e) { console.error('db:', e.message); }
}

const QSTATE = { 1: 'NOTINUSE', 2: 'INUSE', 3: 'BUSY', 6: 'RINGING', 7: 'RINGINUSE', 8: 'ONHOLD' };
async function syncQueues() {
  let ev = [];
  try { ev = await act('QueueStatus'); } catch { S.queues = []; return; }
  const out = new Map();
  for (const e of ev) {
    const q = out.get(e.Queue);
    if (e.Event === 'QueueParams') { if (!D.q.size || D.q.has(e.Queue)) out.set(e.Queue, { id: e.Queue, name: D.q.get(e.Queue) || '', members: [], callers: [] }); }
    else if (q && e.Event === 'QueueMember') {
      const itf = e.StateInterface || e.Interface || e.Location || '', id = (/\d+/.exec(itf) || [''])[0], ex = S.exts.get(id);
      q.members.push({ ext: id || itf, name: ex ? ex.name : (e.MemberName || e.Name || ''), state: QSTATE[+e.Status] || 'UNAVAILABLE', paused: e.Paused === '1' });
    } else if (q && e.Event === 'QueueEntry') {
      q.callers.push({ ch: e.Channel, pos: +e.Position, num: u(e.CallerIDNum), name: u(e.CallerIDName), since: Date.now() - (+e.Wait || 0) * 1000 });
    }
  }
  S.queues = [...out.values()];
}

let busy = false;
async function sync() {
  if (busy || !ready) return;
  busy = true;
  try { await syncDb(); await syncExts(); await syncCalls(); await Promise.all([syncConfs(), syncPark(), syncQueues()]); bc(); }
  catch (e) { console.error('sync:', e.message); }
  busy = false;
}

let polling = false;
async function pollCtx() { // refreshes each channel's dialplan context so IVR occupancy is visible
  if (polling || busy || !ready || ![...wss.clients].some(w => w.auth)) return;
  polling = true;
  try {
    let changed = false;
    for (const e of (await act('CoreShowChannels')).filter(e => e.Event === 'CoreShowChannel')) {
      const c = S.ch.get(e.Channel);
      if (c && (c.ctx !== e.Context || c.exten !== e.Exten || c.app !== e.Application)) { if (c.ctx !== e.Context) c.csince = Date.now(); c.ctx = e.Context; c.exten = e.Exten; c.app = e.Application; changed = true; }
    }
    if (changed) bc();
  } catch { /* retry next cycle */ }
  polling = false;
}

const T = {};
const deb = (k, f) => { clearTimeout(T[k]); T[k] = setTimeout(() => f().then(bc).catch(e => console.error(k, e.message)), 300); };

function onEvent(m) {
  const n = m.Channel;
  switch (m.Event) {
    case 'DeviceStateChange': { const x = S.exts.get((m.Device || '').replace(/^PJSIP\//, '')); if (x) { x.state = dev(m.State); bc(); } break; }
    case 'Newchannel': S.ch.set(n, mk(n, m)); bc(); break;
    case 'Newstate': case 'NewCallerid': case 'NewConnectedLine': {
      const c = S.ch.get(n); if (!c) break;
      c.num = m.CallerIDNum || c.num; c.cname = m.CallerIDName || c.cname;
      c.cnum = m.ConnectedLineNum || c.cnum; c.cn = m.ConnectedLineName || c.cn;
      if (m.ChannelStateDesc) c.state = m.ChannelStateDesc;
      if (m.Event === 'Newstate' && m.ChannelStateDesc === 'Up') c.since = Date.now();
      bc(); break;
    }
    case 'Rename': { const c = S.ch.get(n); if (c) { S.ch.delete(n); c.name = m.Newname; S.ch.set(m.Newname, c); } break; }
    case 'Hangup': S.ch.delete(n); bc(); break;
    case 'BridgeEnter': { const c = S.ch.get(n); if (c) { c.bridge = m.BridgeUniqueid; bc(); } break; }
    case 'BridgeLeave': { const c = S.ch.get(n); if (c && c.bridge === m.BridgeUniqueid) { c.bridge = ''; bc(); } break; }
    case 'Reload': case 'FullyBooted': deb('reload', sync); break;
    case 'ParkedCall': case 'UnParkedCall': case 'ParkedCallGiveUp': case 'ParkedCallTimeOut': deb('park', syncPark); break;
    default:
      if (/^confbridge/i.test(m.Event) && !/talking$/i.test(m.Event)) deb('conf', syncConfs);
      else if (/^Queue(Caller|Member)/.test(m.Event)) deb('queue', syncQueues);
  }
}

function snap() {
  const hide = new Set(S.parked.map(p => p.ch));
  for (const r of S.confs) for (const m of r.members) hide.add(m.ch);
  const g = new Map(), iw = {};
  for (const c of S.ch.values()) {
    if (c.name.startsWith('Local/') || hide.has(c.name)) continue;
    const iv = /^ivr-(\d+)$/.exec(c.ctx || '');
    if (iv) { (iw[iv[1]] = iw[iv[1]] || []).push({ ch: c.name, num: u(c.num), name: u(c.cname), since: c.csince }); continue; }
    const k = c.bridge || 'L' + c.lid;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push({ ch: c.name, num: u(c.num), name: u(c.cname), cnum: u(c.cnum), cname: u(c.cn), state: c.state, since: c.since, br: !!c.bridge,
      ext: (/^PJSIP\/([^-]+)-/.exec(c.name) || [])[1] || '' });
  }
  const ivrs = [...new Set([...Object.keys(cfg.ivrs), ...D.ivr.keys(), ...Object.keys(iw)])].sort((a, b) => a - b)
    .map(id => ({ id, name: cfg.ivrs[id] || D.ivr.get(id) || '', callers: iw[id] || [] }));
  const chans = [...S.ch.values()];
  const rgs = D.rg.map(r => ({ id: r.id, name: r.name, members: r.members,
    calling: chans.filter(c => c.exten === r.id && c.app === 'Dial' && !c.name.startsWith('Local/')).length }));
  const seen = new Set(), sc = [...cfg.shortcuts,
    ...S.confs.map(r => ({ label: `Conf ${r.id} ${r.name}`.trim(), code: r.id }))]
    .filter(x => !seen.has(x.label + x.code) && seen.add(x.label + x.code));
  return JSON.stringify({ type: 'state', ivrs, queues: S.queues, rgs, shortcuts: sc, exts: [...S.exts.values()], calls: [...g.values()], confs: S.confs, lots: S.lots, parked: S.parked, now: Date.now() });
}

let bt = 0;
function bc() {
  if (bt) return;
  bt = setTimeout(() => { bt = 0; const s = snap(); for (const w of wss.clients) if (w.auth && w.readyState === 1) w.send(s); }, 150);
}

// ---- Commands (every argument is validated against live state before reaching AMI) ----
const known = c => { if (!S.ch.has(c)) throw new Error('Unknown channel'); };
const dest = t => { if (!NUM.test(String(t))) throw new Error('Invalid destination'); };

async function cmd(m) {
  switch (m.type) {
    case 'originate':
      if (!S.exts.has(String(m.from))) throw new Error('Unknown source extension');
      dest(m.to);
      // Rings the "from" phone first; on answer, the dialplan dials the target in the configured context.
      await act('Originate', { Channel: 'PJSIP/' + m.from, Context: cfg.ctx, Exten: m.to, Priority: 1,
        CallerID: m.from, Timeout: 30000, Async: 'true' });
      return `Calling ${m.to} from ${m.from}`;
    case 'hangup': {
      const l = [].concat(m.channels || []);
      if (!l.length || !l.every(c => S.ch.has(c) || S.parked.some(p => p.ch === c))) throw new Error('Unknown channel');
      for (const c of l) await act('Hangup', { Channel: c, Cause: 16 });
      return 'Call ended';
    }
    case 'blind': // transfers the party bridged to m.channel
      known(m.channel); dest(m.to);
      await act('BlindTransfer', { Channel: m.channel, Context: cfg.ctx, Exten: m.to });
      return `Transferred to ${m.to}`;
    case 'attended': // m.channel dials m.to; the other party is held until m.channel hangs up (completes)
      known(m.channel); dest(m.to);
      await act('Atxfer', { Channel: m.channel, Context: cfg.ctx, Exten: m.to });
      return `Consulting ${m.to}. Hang up the consulting phone to complete the transfer.`;
    case 'redirect': { // moves a single channel out of a conference or parking slot
      const ok = S.confs.some(r => r.members.some(x => x.ch === m.channel)) || S.parked.some(p => p.ch === m.channel)
        || /^ivr-\d+$/.test((S.ch.get(m.channel) || {}).ctx || '')
        || (S.ch.has(m.channel) && !S.ch.get(m.channel).bridge && !m.channel.startsWith('Local/'));
      if (!ok) throw new Error('Unknown channel');
      dest(m.to);
      await act('Redirect', { Channel: m.channel, Context: cfg.ctx, Exten: m.to, Priority: 1 });
      return `Sent to ${m.to}`;
    }
    case 'kick': case 'mute': {
      if (!S.confs.some(r => r.id === m.conf && r.members.some(x => x.ch === m.channel))) throw new Error('Unknown conference member');
      const a = m.type === 'kick' ? 'ConfBridgeKick' : m.on ? 'ConfBridgeMute' : 'ConfBridgeUnmute';
      await act(a, { Conference: m.conf, Channel: m.channel });
      return 'Done';
    }
    default: throw new Error('Unknown command');
  }
}

// ---- HTTP + WebSocket ----
// Embedding (e.g. a Home Assistant iframe card): FRAME_ANCESTORS="http://homeassistant.local:8123"; BACK_URL adds a link that returns the parent page
const FA = (E.FRAME_ANCESTORS || '').trim().split(/\s+/).filter(Boolean);
if (FA.some(o => !/^(https?:\/\/[A-Za-z0-9.\-:\[\]]+|'self')$/.test(o))) { console.error('FRAME_ANCESTORS must list origins such as http://homeassistant.local:8123'); process.exit(1); }
const BACK = /^https?:\/\/[^\s"'<>]+$/.test(E.BACK_URL || '') ? E.BACK_URL : '';
const page = Buffer.from(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('__BACK_URL__', BACK.replace(/&/g, '&amp;')));
const srv = http.createServer((q, r) => {
  if (!allowed(cip(q))) { r.writeHead(403); return r.end(); }
  if (q.url === '/' || q.url === '/index.html') {
    const hdr = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors " + (FA.length ? FA.join(' ') : "'none'") };
    if (!FA.length) hdr['X-Frame-Options'] = 'DENY';
    r.writeHead(200, hdr);
    r.end(page);
  } else { r.writeHead(404); r.end(); }
});
const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 4096,
  verifyClient: i => { try { return allowed(cip(i.req)) && new URL(i.origin).host === i.req.headers.host; } catch { return false; } } });

const H = s => crypto.createHash('sha256').update(String(s)).digest();
const eq = (a, b) => crypto.timingSafeEqual(H(a), H(b));

wss.on('connection', (ws, req) => {
  ws.auth = false; let fails = 0;
  ws.ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const kill = setTimeout(() => { if (!ws.auth) ws.close(); }, 30000);
  ws.on('close', () => clearTimeout(kill));
  ws.on('error', () => {});
  const out = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('message', async d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    try {
      if (!ws.auth) {
        if (m.type !== 'login') return;
        const ext = String(m.ext);
        const ok = m.token !== undefined
          ? !!(cfg.ktoken && (!cfg.kips.length || cfg.kips.includes(ws.ip)) && eq(m.token, cfg.ktoken))
          : !!(eq(m.user, cfg.puser) & eq(m.pass, cfg.ppass));
        if (!ok) await new Promise(r => setTimeout(r, 1500));
        if (ok && !S.exts.size) return out({ type: 'auth', ok: false, msg: ready ? 'PBX data still loading, retry shortly' : 'Bridge cannot reach the PBX (AMI login failed or down)' });
        if (!ok || !S.exts.has(ext)) { if (++fails >= 3) ws.close(); return out({ type: 'auth', ok: false, msg: ok ? 'Unknown extension' : 'Invalid credentials' }); }
        ws.auth = true; out({ type: 'auth', ok: true, ext }); ws.send(snap());
        return;
      }
      out({ type: 'result', ok: true, msg: await cmd(m) });
    } catch (e) { out({ type: 'result', ok: false, msg: e.message }); }
  });
});

srv.listen(cfg.lport, cfg.listen, () => console.log(`Panel on ${cfg.listen}:${cfg.lport}`));
connect();
setInterval(sync, 60000); // heals any missed events
setInterval(pollCtx, 2000);
