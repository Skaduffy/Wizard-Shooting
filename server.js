// Monster Warlords — Multiplayer Server
// Deploy on Render as a Node.js web service
// Start command: node server.js
// Environment: PORT is set automatically by Render

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
  // Health check endpoint for Render
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Monster Warlords Server OK');
});

const io = new Server(httpServer, {
  cors: {
    origin: '*', // tighten this to your GitHub Pages URL once deployed
    methods: ['GET', 'POST'],
  },
});

// ── Room state ────────────────────────────────────────
// rooms[code] = { host: socketId, guest: socketId|null, phase: 'waiting'|'squad'|'battle'|'done', squads: {} }
const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function cleanupRoom(code) {
  if (rooms[code]) {
    console.log(`Room ${code} cleaned up`);
    delete rooms[code];
  }
}

// ── Connection ────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`+ connected: ${socket.id}`);

  // ── HOST: create a room ──
  socket.on('host_room', ({ username }) => {
    const code = makeCode();
    rooms[code] = {
      code,
      host: socket.id,
      hostName: username || 'Warlord',
      guest: null,
      guestName: null,
      phase: 'waiting',
      squads: {},
      readyCount: 0,
    };
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'host';
    socket.emit('room_created', { code });
    console.log(`Room ${code} created by ${username}`);
  });

  // ── GUEST: join a room ──
  socket.on('join_room', ({ code, username }) => {
    const room = rooms[code];
    if (!room) { socket.emit('join_error', { msg: 'Room not found.' }); return; }
    if (room.guest) { socket.emit('join_error', { msg: 'Room is full.' }); return; }
    if (room.phase !== 'waiting') { socket.emit('join_error', { msg: 'Game already started.' }); return; }

    room.guest = socket.id;
    room.guestName = username || 'Challenger';
    room.phase = 'squad';
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'guest';

    // Tell both players who they're fighting
    io.to(room.host).emit('opponent_joined', {
      opponentName: room.guestName,
      role: 'host',
      code,
    });
    socket.emit('opponent_joined', {
      opponentName: room.hostName,
      role: 'guest',
      code,
    });
    console.log(`${username} joined room ${code}`);
  });

  // ── SQUAD: player submits their chosen squad ──
  socket.on('submit_squad', ({ code, squad, battleSize }) => {
    const room = rooms[code];
    if (!room) return;
    const role = socket.id === room.host ? 'host' : 'guest';
    room.squads[role] = squad;
    room.readyCount = (room.readyCount || 0) + 1;
    console.log(`Squad submitted in ${code} by ${role} (${room.readyCount}/2)`);

    if (room.readyCount >= 2) {
      room.phase = 'battle';
      // Send each player the opponent's squad
      io.to(room.host).emit('battle_start', {
        yourSquad:    room.squads['host'],
        enemySquad:   room.squads['guest'],
        yourRole:     'host',
        battleSize,
      });
      io.to(room.guest).emit('battle_start', {
        yourSquad:    room.squads['guest'],
        enemySquad:   room.squads['host'],
        yourRole:     'guest',
        battleSize,
      });
    } else {
      // Tell this player to wait
      socket.emit('waiting_for_opponent');
    }
  });

  // ── BATTLE: relay a unit move command ──
  // Payload: { code, unitIndex, destQ, destR }
  socket.on('unit_move', (data) => {
    const room = rooms[data.code];
    if (!room) return;
    // Relay to the other player only
    socket.to(data.code).emit('opponent_move', data);
  });

  // ── BATTLE: relay an attack event (for visual sync) ──
  socket.on('unit_attack', (data) => {
    const room = rooms[data.code];
    if (!room) return;
    socket.to(data.code).emit('opponent_attack', data);
  });

  // ── BATTLE: one player reports battle over ──
  socket.on('battle_result', ({ code, winner }) => {
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit('battle_ended', { winner });
    room.phase = 'done';
    setTimeout(() => cleanupRoom(code), 30000);
  });

  // ── Disconnect ────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`- disconnected: ${socket.id}`);
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    // Notify the other player
    socket.to(code).emit('opponent_disconnected');
    cleanupRoom(code);
  });

  // ── Ping/keepalive ──
  socket.on('ping_room', ({ code }) => {
    if (rooms[code]) socket.emit('pong_room');
  });
});

httpServer.listen(PORT, () => {
  console.log(`Monster Warlords server running on port ${PORT}`);
});
