'use strict';
// Imune! - servidor multiplayer sem dependências (Node 18+). Eventos via SSE + ações via POST.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const TY = ['virus', 'bac', 'fun', 'par'], AV = ['🧑', '🤖', '👾', '🦾', '🧠', '🛰️'];
const BN = ['Bot Alfa', 'Bot Beta', 'Bot Gama', 'Bot Delta', 'Bot Ômega'];
const rooms = new Map(); let uid = 0, fxn = 0;
const rnd = n => Math.random() * n | 0;
const shuf = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 14) || 'Jogador';

function build() { // 112 cartas: 72 números (1-9, 2x) + 32 ação + 8 coringas
  const d = [];
  TY.forEach(t => { for (let r = 0; r < 2; r++) { for (let n = 1; n <= 9; n++) d.push({ k: 'num', type: t, num: n }); ['skip', 'rev', 'att', 'def'].forEach(k => d.push({ k, type: t })); } });
  for (let i = 0; i < 4; i++) { d.push({ k: 'nk' }); d.push({ k: 'mut' }); }
  return d.map(c => ({ ...c, id: ++uid }));
}

function view(room, person) {
  const G = room.G, seat = person.seat, r = G.react;
  return { seat, host: person.pid === room.host, cur: G.cur, dir: G.dir, top: G.top, deck: G.deck.length, disc: G.disc.length,
    topCard: G.topCard && { k: G.topCard.k, type: G.topCard.type, num: G.topCard.num },
    ps: G.ps.map(p => ({ name: p.name, av: p.av, n: p.hand.length, mem: p.mem })),
    hand: G.ps[seat].hand, log: G.log.slice(-8), over: G.over, wseat: G.wseat, fx: G.fx,
    drawn: G.cur === seat ? G.drawn : null,
    react: r ? (r.vi === seat ? { by: G.ps[r.pi].name, type: r.type } : { wait: G.ps[r.vi].name }) : null };
}
function bcast(room) {
  for (const p of room.people) {
    if (!p.res) continue;
    const m = room.G ? { t: 'game', v: view(room, p) } : { t: 'lobby', code: room.code, host: p.pid === room.host, people: room.people.map(x => x.name), bots: room.bots };
    try { p.res.write('data: ' + JSON.stringify(m) + '\n\n'); } catch (e) {}
  }
}

function startGame(room) {
  const hs = room.people.map(p => ({ pid: p.pid, name: p.name, h: 1 }));
  const nb = Math.max(Math.min(room.bots, 6 - hs.length), 2 - hs.length, 0);
  const ps = shuf([...hs, ...BN.slice(0, nb).map(name => ({ name, h: 0 }))]);
  ps.forEach((p, i) => { p.av = AV[i]; p.hand = []; p.mem = []; if (p.pid) room.people.find(x => x.pid === p.pid).seat = i; });
  const G = room.G = { ps, deck: shuf(build()), disc: [], cur: 0, dir: 1, top: null, topCard: null, log: [], react: null, drawn: null, over: false, wseat: -1, fx: null, dead: false };
  const lg = m => { G.log.push(m); if (G.log.length > 30) G.log.shift(); };
  const T = (f, ms) => setTimeout(() => { if (!G.dead && !G.over) f(); }, ms);
  const conn = p => p.h && room.people.some(x => x.pid === p.pid && x.res);
  const isBot = p => !p.h || !conn(p);
  const bc = () => bcast(room);
  const draw = (p, n) => { for (let i = 0; i < n; i++) { if (!G.deck.length) { const l = G.disc.pop(); G.deck = shuf(G.disc); G.disc = l ? [l] : []; } if (G.deck.length) p.hand.push(G.deck.pop()); } };
  const nextOf = () => { const n = ps.length; return ps[((G.cur + G.dir) % n + n) % n]; };
  const canPlay = (c, p) => { const t = G.top; if (c.k === 'nk' || c.k === 'mut') return true; if (c.k === 'def') return p.mem.includes(c.type); if (c.type === t.type) return true; return c.k === 'num' ? (t.k === 'num' && c.num === t.num) : c.k === t.k; };
  const label = c => c.k === 'num' ? `${c.type}${c.num}` : c.k;

  const go = () => { G.drawn = null; bc(); if (isBot(ps[G.cur])) T(botTurn, 1100); };
  const finish = (p, s) => {
    if (!p.hand.length) { G.over = true; G.wseat = ps.indexOf(p); lg(`🏆 ${p.name} venceu!`); return bc(); }
    if (p.hand.length === 1) lg(`📣 ${p.name}: “Imune!” (1 carta)`);
    const n = ps.length; G.cur = ((G.cur + G.dir * s) % n + n) % n; go();
  };
  const hit = (p, v) => { draw(v, 2); G.fx = { seat: ps.indexOf(v), k: 'hit', n: ++fxn }; lg(`${v.name} comprou 2 cartas e perdeu a vez.`); finish(p, 2); };
  const defend = (p, v, type, d) => {
    v.hand.splice(v.hand.indexOf(d), 1); G.disc.push(d); v.mem.push(type); G.fx = { seat: ps.indexOf(v), k: 'mem', n: ++fxn };
    lg(`🛡️ ${v.name} usou o defensor: ataque anulado e memória 🧠 criada!`);
    if (v.mem.length === 4) { G.over = true; G.wseat = ps.indexOf(v); lg(`🏆 ${v.name} ganhou imunidade total (4 memórias)!`); return bc(); }
    finish(p, 1);
  };
  const reactDo = use => { const r = G.react; G.react = null; const v = ps[r.vi], p = ps[r.pi], d = v.hand.find(x => x.id === r.did); use && d ? defend(p, v, r.type, d) : hit(p, v); };
  const attack = (p, v, type) => {
    if (v.mem.includes(type)) { lg(`🧠 ${v.name} tem memória desse tipo: ataque ignorado!`); return finish(p, 1); }
    const d = v.hand.find(x => x.k === 'def' && x.type === type);
    if (!d) return hit(p, v);
    if (isBot(v)) return defend(p, v, type, d);
    G.react = { vi: ps.indexOf(v), pi: ps.indexOf(p), type, did: d.id }; bc();
    T(() => { if (G.react && G.react.did === d.id) reactDo(true); }, 25000);
  };
  const play = (p, c, o) => {
    p.hand.splice(p.hand.indexOf(c), 1); G.disc.push(c);
    let t = { type: c.type, num: null, k: c.k };
    if (c.k === 'num') t.num = c.num;
    if (c.k === 'nk') { t.type = o.type; lg(`${p.name} jogou Célula NK.`); }
    else if (c.k === 'mut') { const n0 = G.top.num; t.type = o.type; t.num = n0 === null ? null : Math.min(9, Math.max(1, n0 + o.delta)); t.k = t.num === null ? 'mut' : 'num'; lg(`${p.name} jogou Mutação.`); }
    else lg(c.k === 'def' ? `${p.name} descartou um defensor (já tem essa memória).` : `${p.name} jogou ${label(c)}.`);
    G.top = t; G.topCard = c;
    if (c.k === 'skip') { lg(`${nextOf().name} perdeu a vez.`); return finish(p, 2); }
    if (c.k === 'rev') { G.dir *= -1; return finish(p, ps.length === 2 ? 2 : 1); }
    if (c.k === 'att') return attack(p, nextOf(), c.type);
    finish(p, 1);
  };
  const botPlay = (p, c) => {
    const rest = p.hand.filter(x => x !== c && x.type), cn = t => rest.filter(x => x.type === t).length;
    const type = [...TY].sort((a, b) => cn(b) - cn(a) + Math.random() * .5 - .25)[0];
    let delta = Math.random() < .5 ? 1 : -1;
    if (c.k === 'mut' && G.top.num !== null) for (const d of [-1, 1]) if (rest.some(x => x.k === 'num' && x.type === type && x.num === G.top.num + d)) delta = d;
    play(p, c, { type, delta });
  };
  const botTurn = () => {
    const p = ps[G.cur]; const pl = p.hand.filter(c => canPlay(c, p));
    if (!pl.length) { draw(p, 1); const c = p.hand[p.hand.length - 1]; lg(`${p.name} comprou uma carta.`); if (c && canPlay(c, p)) { bc(); return T(() => botPlay(p, c), 900); } return finish(p, 1); }
    const nx = nextOf().hand.length, cnt = t => p.hand.filter(x => x.type === t).length;
    const sc = c => (c.k === 'att' ? 50 : (c.k === 'skip' || c.k === 'rev') ? 30 + (nx <= 2 ? 25 : 0) : c.k === 'num' ? 20 + cnt(c.type) : c.k === 'mut' ? 8 : c.k === 'def' ? 12 : 5) + Math.random() * 6;
    botPlay(p, pl.map(c => [c, sc(c)]).sort((a, b) => b[1] - a[1])[0][0]);
  };

  room.act = (seat, m) => {
    if (G.over || G.dead) return;
    const p = ps[seat];
    if (m.a === 'react') { if (!G.react || G.react.vi !== seat) return 'Nada para reagir.'; reactDo(!!m.use); return; }
    if (G.cur !== seat || G.react) return 'Não é a sua vez.';
    if (m.a === 'pass') { if (!G.drawn) return 'Compre uma carta antes.'; finish(p, 1); return; }
    if (m.a === 'buy') {
      if (G.drawn) return 'Você já comprou.';
      draw(p, 1); const c = p.hand[p.hand.length - 1]; if (!c) return 'O monte acabou.';
      lg(`${p.name} comprou uma carta.`); G.drawn = c.id; bc();
      if (!canPlay(c, p)) T(() => { if (G.cur === seat && G.drawn === c.id) finish(p, 1); }, 900);
      return;
    }
    if (m.a === 'play') {
      const c = p.hand.find(x => x.id === m.id); if (!c) return 'Carta inválida.';
      if (G.drawn && c.id !== G.drawn) return 'Depois de comprar, só dá para jogar a carta comprada.';
      if (!canPlay(c, p)) return c.k === 'def' ? 'Esse defensor só serve como reação a uma Epidemia do tipo dele.' : 'Essa carta não combina (tipo, número ou símbolo).';
      let o = null;
      if (c.k === 'nk' || c.k === 'mut') { if (!TY.includes(m.type)) return 'Escolha um tipo.'; o = { type: m.type, delta: m.delta === -1 ? -1 : 1 }; }
      play(p, c, o); return;
    }
    return 'Ação desconhecida.';
  };

  ps.forEach(p => draw(p, 7));
  let c; do { c = G.deck.pop(); if (c.k !== 'num') G.deck.unshift(c); } while (c.k !== 'num');
  G.disc.push(c); G.top = { type: c.type, num: c.num, k: 'num' }; G.topCard = c;
  go();
}

// ---------- HTTP ----------
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.webp': 'image/webp', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/events') {
      const room = rooms.get((u.searchParams.get('code') || '').toUpperCase());
      const person = room && room.people.find(x => x.pid === u.searchParams.get('pid'));
      if (!person) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      person.res = res; room.last = Date.now();
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(hb); if (person.res === res) person.res = null; });
      return bcast(room);
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      const m = await body(req), op = u.pathname.slice(5);
      if (op === 'create') {
        let code; do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[rnd(24)]).join(''); } while (rooms.has(code));
        const pid = crypto.randomUUID();
        rooms.set(code, { code, host: pid, people: [{ pid, name: clean(m.name), res: null, seat: -1 }], bots: 2, G: null, last: Date.now() });
        return json(res, 200, { code, pid });
      }
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return json(res, 200, { err: 'Sala não encontrada. Confira o código.' });
      room.last = Date.now();
      if (op === 'join') {
        if (room.G) return json(res, 200, { err: 'A partida dessa sala já começou.' });
        if (room.people.length >= 6) return json(res, 200, { err: 'A sala está cheia (máximo de 6).' });
        let name = clean(m.name); if (room.people.some(x => x.name === name)) name += room.people.length + 1;
        const pid = crypto.randomUUID(); room.people.push({ pid, name, res: null, seat: -1 });
        return json(res, 200, { code: room.code, pid });
      }
      if (op === 'act') {
        const person = room.people.find(x => x.pid === m.pid); if (!person) return json(res, 200, { err: 'Jogador não encontrado.' });
        const host = person.pid === room.host;
        if (m.a === 'bots' && host && !room.G) { room.bots = Math.max(0, Math.min(5, +m.n || 0)); bcast(room); return json(res, 200, {}); }
        if (m.a === 'start' && host && !room.G) { startGame(room); return json(res, 200, {}); }
        if (m.a === 'again' && host && room.G && room.G.over) { room.G.dead = true; room.G = null; bcast(room); return json(res, 200, {}); }
        if (!room.G) return json(res, 200, { err: 'A partida ainda não começou.' });
        return json(res, 200, { err: room.act(person.seat, m) || undefined });
      }
      return json(res, 404, { err: 'Rota desconhecida.' });
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    res.writeHead(404); return res.end('Não encontrado');
  } catch (e) { console.error(e); try { json(res, 500, { err: 'Erro no servidor.' }); } catch (x) {} }
}).listen(PORT, () => console.log('Imune! rodando em http://localhost:' + PORT));

setInterval(() => { for (const [c, r] of rooms) if (Date.now() - r.last > 2 * 3600e3) { if (r.G) r.G.dead = true; rooms.delete(c); } }, 600e3);
