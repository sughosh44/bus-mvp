// index.js
// --- durable token store (file-backed) ---
const fs = require('fs');
const path = require('path');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

let TOKENS = {}; // token -> { busId, routeId, expiresAt }

function loadTokens(){
  try{
    if(fs.existsSync(TOKENS_FILE)){
      const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
      TOKENS = JSON.parse(raw) || {};
    } else {
      TOKENS = {};
    }
  }catch(e){
    console.error('failed loading tokens file', e);
    TOKENS = {};
  }
}
function saveTokens(){
  try{
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOKENS, null, 2), 'utf8');
  }catch(e){
    console.error('failed saving tokens file', e);
  }
}
loadTokens();

function createToken(busId, routeId='route-1', ttlMs=12*3600*1000){
  const t = 'tk_' + Math.random().toString(36).slice(2,10);
  const entry = { busId, routeId, expiresAt: Date.now() + ttlMs };
  TOKENS[t] = entry;
  saveTokens();
  return t;
}

function verifyToken(tk, busId){
  if(!tk) return false;
  const e = TOKENS[tk];
  if(!e) return false;
  if(e.expiresAt < Date.now()){ delete TOKENS[tk]; saveTokens(); return false; }
  if(busId && e.busId && e.busId !== busId) return false;
  return true;
}
// --- end token store ---

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const bodyParser = require('body-parser');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory stores (MVP)
const buses = {}; // busId -> { id, busNumber, lat, lng, speed, routeId, ts }
const TOKENS = new Map(); // token -> { busId, routeId, expiresAt }

// Helper: create simple token (demo)
function createToken(busId, routeId='route-1', ttlMs=12*3600*1000){
  const t = 'tk_' + Math.random().toString(36).slice(2,10);
  TOKENS.set(t, { busId, routeId, expiresAt: Date.now() + ttlMs });
  return t;
}
function verifyToken(tk, busId){
  if(!tk) return false;
  const e = TOKENS.get(tk);
  if(!e) return false;
  if(e.expiresAt < Date.now()){ TOKENS.delete(tk); return false; }
  if(busId && e.busId && e.busId !== busId) return false;
  return true;
}

// Test token printed for convenience
const sampleToken = createToken('bus-1','route-1');
console.log('\n=== Server started ===');
console.log('Sample token (for quick testing):', sampleToken);
console.log(`Open commuter UI: http://<this-machine-ip>:${PORT}/commuter.html`);
console.log(`Driver link example (put on phone): http://<this-machine-ip>:${PORT}/driver.html?token=${sampleToken}&busId=bus-1&busNumber=BUS-1`);
console.log('=====================\n');

// Socket.IO: handle driver connections & commuter subscriptions
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('subscribe:route', (routeId) => {
    console.log('subscribe:route', routeId, socket.id);
    if(routeId) socket.join(`route:${routeId}`);
  });

  socket.on('driver:location', (payload) => {
    // payload: { id, busNumber, lat, lng, speed, routeId, token }
    if(!payload || !payload.id) return;
    if(!verifyToken(payload.token, payload.id)){
      socket.emit('driver:error', { error: 'invalid token' });
      console.warn('invalid token from driver', payload.id);
      return;
    }
    const id = payload.id;
    buses[id] = {
      id,
      busNumber: payload.busNumber || payload.id,
      lat: Number(payload.lat),
      lng: Number(payload.lng),
      speed: Number(payload.speed) || 0,
      routeId: payload.routeId || 'route-1',
      ts: Date.now()
    };
    // broadcast to commuters
    io.to(`route:${buses[id].routeId}`).emit('bus:update', buses[id]);
    io.emit('bus:update', buses[id]);
  });

  socket.on('disconnect', () => {
    // NO-OP for MVP
  });
});

// REST fallback for devices that cannot open sockets
app.post('/api/driver/update', (req, res) => {
  const payload = req.body;
  const token = req.headers['x-driver-token'] || payload.token;
  if(!payload || !payload.id) return res.status(400).json({ error: 'missing payload.id' });
  if(!verifyToken(token, payload.id)) return res.status(401).json({ error: 'invalid token' });
  const id = payload.id;
  buses[id] = {
    id,
    busNumber: payload.busNumber || payload.id,
    lat: Number(payload.lat),
    lng: Number(payload.lng),
    speed: Number(payload.speed) || 0,
    routeId: payload.routeId || 'route-1',
    ts: Date.now()
  };
  io.to(`route:${buses[id].routeId}`).emit('bus:update', buses[id]);
  io.emit('bus:update', buses[id]);
  return res.json({ ok: true });
});

// Endpoint to create quick token (for admin/demo)
app.get('/gen-token', (req, res) => {
  const busId = req.query.busId || ('bus-' + Math.floor(Math.random() * 9999));
  const routeId = req.query.routeId || 'route-1';
  const tk = createToken(busId, routeId);
  return res.json({ token: tk, busId, routeId });
});

app.get('/api/buses', (req, res) => res.json({ buses }));

server.listen(PORT, () => console.log('listening on', PORT));
