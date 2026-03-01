// ═══════════════════════════════════════════════════════════════
//  WIZARD SHOOTER — Multiplayer Server
//  Stack: Node.js + Express + Socket.io
//  Deploy: Render (free tier)
//  Supports: Co-op and PvP, up to 8 players per room
// ═══════════════════════════════════════════════════════════════

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'Wizard Shooter.html'))
);

// ── Constants ─────────────────────────────────────────────────
const MAX_PLAYERS    = 8;
const TICK_RATE      = 20;       // server updates per second
const DT             = 1 / TICK_RATE;
const WAVE_INTERVAL  = 22;       // seconds per wave
const PVP_HIT_DMG    = 1;

// ── Room storage ──────────────────────────────────────────────
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(code, mode) {
  return {
    code, mode,
    players:        {},
    enemies:        [],
    arrows:         [],
    nextEnemyId:    0,
    wave:           1,
    score:          0,
    gameTime:       0,
    spawnTimer:     2.5,
    waveTimer:      0,
    armoredUnlocked:false,
    archerUnlocked: false,
    miniBossSpawned:false,
    running:        false,
    tickInterval:   null,
  };
}

function createPlayer(socketId, name, spell) {
  return {
    id: socketId, name: name || 'Wizard', spell: spell || 'earth',
    wx: 0, wy: 0, angle: 0,
    hp: 5, maxHp: 5, alive: true, score: 0, iframes: 0,
    radius: 18,
    keys: { w:false, a:false, s:false, d:false },
    mouseWx: 0, mouseWy: 0,
    shootCD: 0, spellCD: 0,
    bullets: [], fireballs: [], vines: [], infernos: [],
    arcaneMissiles: [], voidOrbs: [],
    lightningZaps: [], chainBolts: [],
    nextProjId: 0,
  };
}

// ── Spawn helpers ─────────────────────────────────────────────
function roomCentroid(room) {
  const ps = Object.values(room.players).filter(p => p.alive);
  if (!ps.length) return { wx:0, wy:0 };
  return { wx: ps.reduce((s,p)=>s+p.wx,0)/ps.length, wy: ps.reduce((s,p)=>s+p.wy,0)/ps.length };
}

function spawnEdge(room) {
  const { wx:cx, wy:cy } = roomCentroid(room);
  const side = Math.floor(Math.random()*4);
  const hw = 900, hh = 600;
  if (side===0) return { wx: cx+(Math.random()*2-1)*hw, wy: cy-hh };
  if (side===1) return { wx: cx+hw,                     wy: cy+(Math.random()*2-1)*hh };
  if (side===2) return { wx: cx+(Math.random()*2-1)*hw, wy: cy+hh };
               return { wx: cx-hw,                     wy: cy+(Math.random()*2-1)*hh };
}

function baseEnemy(room, type, extra) {
  return { id: room.nextEnemyId++, type, angle:0, wobble:Math.random()*Math.PI*2,
           burning:0, armorFlash:0, smashTimer:3, smashing:0, shootTimer:0, preferDist:0,
           ...spawnEdge(room), ...extra };
}

function spawnGoblin(room) {
  const hp = 3 + Math.floor(room.wave*0.6);
  room.enemies.push(baseEnemy(room,'basic',{ radius:16, hp, maxHp:hp, speed:1.1+room.wave*0.1+Math.random()*0.5 }));
}
function spawnArmored(room) {
  const hp = 10 + Math.floor(room.wave*1.2);
  room.enemies.push(baseEnemy(room,'armored',{ radius:20, hp, maxHp:hp, speed:0.7+room.wave*0.05+Math.random()*0.3 }));
}
function spawnArcher(room) {
  const hp = 4 + Math.floor(room.wave*0.5);
  room.enemies.push(baseEnemy(room,'archer',{ radius:14, hp, maxHp:hp, speed:0.9+Math.random()*0.4,
    shootTimer: 1.5+Math.random()*2, preferDist: 220+Math.random()*80 }));
}
function spawnMiniBoss(room) {
  room.enemies.push(baseEnemy(room,'miniboss',{ radius:36, hp:120, maxHp:120, speed:1.1,
    smashTimer: 3+Math.random() }));
  broadcastToRoom(room, 'announcement', { text:'👹 GRUMTUSK ARRIVES!', color:'#ff4444' });
}

// ── Damage ────────────────────────────────────────────────────
function damageEnemy(room, ei, dmg, killerId) {
  const e = room.enemies[ei];
  if (!e) return false;
  if (e.type==='armored')  dmg = Math.max(1, Math.ceil(dmg*0.6));
  if (e.type==='miniboss') dmg = Math.max(1, Math.ceil(dmg*0.8));
  e.hp -= dmg;
  e.armorFlash = 0.5;
  if (e.hp <= 0) {
    const pts = { miniboss:500, armored:25, archer:15, basic:10 }[e.type] || 10;
    const earned = pts * room.wave;
    if (room.mode==='coop') { room.score += earned; }
    else { const kp = room.players[killerId]; if (kp) kp.score += earned; }
    broadcastToRoom(room, 'enemy_killed', { id:e.id, pts:earned, killerId });
    room.enemies.splice(ei, 1);
    return true;
  }
  return false;
}

function damagePlayer(room, targetId, dmg, attackerId) {
  const p = room.players[targetId];
  if (!p || !p.alive || p.iframes > 0) return;
  p.hp -= dmg;
  p.iframes = 1.5;
  if (p.hp <= 0) {
    p.hp = 0; p.alive = false;
    broadcastToRoom(room, 'player_died', { id:targetId, killerId:attackerId });
    const alive = Object.values(room.players).filter(pl => pl.alive);
    if (room.mode==='coop' && alive.length===0) endGame(room,'all_dead');
    if (room.mode==='pvp'  && alive.length<=1)  endGame(room,'pvp_winner', alive[0]?.id||null);
  }
}

function nearestPlayer(room, wx, wy) {
  let best=null, bestD=Infinity;
  for (const p of Object.values(room.players)) {
    if (!p.alive) continue;
    const d = Math.hypot(p.wx-wx, p.wy-wy);
    if (d < bestD) { bestD=d; best=p; }
  }
  return best;
}

// ── Server tick ───────────────────────────────────────────────
function tickRoom(room) {
  if (!room.running) return;

  room.gameTime  += DT;
  room.waveTimer += DT;
  room.spawnTimer -= DT;

  if (!room.armoredUnlocked && room.gameTime>=20) {
    room.armoredUnlocked=true;
    broadcastToRoom(room,'announcement',{text:'⚔️ Armored Goblins!',color:'#aaaaff'});
  }
  if (!room.archerUnlocked && room.gameTime>=45) {
    room.archerUnlocked=true;
    broadcastToRoom(room,'announcement',{text:'🏹 Goblin Archers!',color:'#ffaa44'});
  }

  if (room.waveTimer >= WAVE_INTERVAL) {
    room.waveTimer=0; room.wave++;
    broadcastToRoom(room,'wave_change',{wave:room.wave});
    if (room.wave===5 && !room.miniBossSpawned && room.mode!=='pvp') {
      room.miniBossSpawned=true;
      setTimeout(()=>{ if(room.running) spawnMiniBoss(room); }, 2000);
    }
  }

  if (room.spawnTimer <= 0) {
    if (room.mode !== 'pvp') {
      const n = Math.ceil(room.wave*0.6+0.5);
      for (let k=0; k<n; k++) {
        const roll = Math.random();
        if      (room.archerUnlocked  && roll<0.25) spawnArcher(room);
        else if (room.armoredUnlocked && roll<0.50) spawnArmored(room);
        else spawnGoblin(room);
      }
    }
    room.spawnTimer = Math.max(0.5, 2.5-room.wave*0.12);
  }

  // ── Player movement + projectile updates ─────────────────────
  for (const p of Object.values(room.players)) {
    if (!p.alive) continue;

    let mx=0, my=0;
    if (p.keys.w) my=-1; if (p.keys.s) my=1;
    if (p.keys.a) mx=-1; if (p.keys.d) mx=1;
    if (mx&&my) { mx*=0.707; my*=0.707; }
    p.wx += mx*4; p.wy += my*4;
    p.angle = Math.atan2(p.mouseWy-p.wy, p.mouseWx-p.wx);
    if (p.shootCD>0) p.shootCD-=DT;
    if (p.spellCD>0) p.spellCD-=DT;
    if (p.iframes>0) p.iframes-=DT;

    // Bullets
    for (let i=p.bullets.length-1;i>=0;i--) {
      const b=p.bullets[i]; b.wx+=b.dx; b.wy+=b.dy;
      if (Math.hypot(b.wx-p.wx,b.wy-p.wy)>1400){p.bullets.splice(i,1);continue;}
      let hit=false;
      for (let ei=room.enemies.length-1;ei>=0;ei--)
        if(Math.hypot(b.wx-room.enemies[ei].wx,b.wy-room.enemies[ei].wy)<room.enemies[ei].radius+b.r)
          { damageEnemy(room,ei,1,p.id); hit=true; break; }
      if (!hit && room.mode==='pvp')
        for (const [tid,tp] of Object.entries(room.players))
          if(tid!==p.id&&tp.alive&&Math.hypot(b.wx-tp.wx,b.wy-tp.wy)<tp.radius+b.r)
            { damagePlayer(room,tid,PVP_HIT_DMG,p.id); hit=true; break; }
      if (hit) p.bullets.splice(i,1);
    }

    // Fireballs
    for (let i=p.fireballs.length-1;i>=0;i--) {
      const b=p.fireballs[i]; b.wx+=b.dx; b.wy+=b.dy; b.age+=DT;
      if (Math.hypot(b.wx-p.wx,b.wy-p.wy)>1400){p.fireballs.splice(i,1);continue;}
      let hit=false;
      for (let ei=room.enemies.length-1;ei>=0;ei--)
        if(Math.hypot(b.wx-room.enemies[ei].wx,b.wy-room.enemies[ei].wy)<room.enemies[ei].radius+b.r)
          { damageEnemy(room,ei,2,p.id); hit=true; break; }
      if (!hit && room.mode==='pvp')
        for (const [tid,tp] of Object.entries(room.players))
          if(tid!==p.id&&tp.alive&&Math.hypot(b.wx-tp.wx,b.wy-tp.wy)<tp.radius+b.r)
            { damagePlayer(room,tid,2,p.id); hit=true; break; }
      if (hit) p.fireballs.splice(i,1);
    }

    // Vines (piercing)
    for (let i=p.vines.length-1;i>=0;i--) {
      const v=p.vines[i]; v.age+=DT; v.wx+=v.dx; v.wy+=v.dy; v.segT+=DT;
      if(v.segT>0.025){v.segT=0;v.trail.push({wx:v.wx,wy:v.wy});}
      for (let ei=room.enemies.length-1;ei>=0;ei--) {
        if(v.hitSet.has(room.enemies[ei].id))continue;
        if(Math.hypot(v.wx-room.enemies[ei].wx,v.wy-room.enemies[ei].wy)<room.enemies[ei].radius+12)
          { v.hitSet.add(room.enemies[ei].id); damageEnemy(room,ei,3,p.id); }
      }
      if(v.age>2.2||Math.hypot(v.wx-p.wx,v.wy-p.wy)>1400) p.vines.splice(i,1);
    }

    // Infernos
    for (let i=p.infernos.length-1;i>=0;i--) {
      const inf=p.infernos[i]; inf.age+=DT; inf.wx=p.wx; inf.wy=p.wy;
      const spread=0.65;
      for (let ei=room.enemies.length-1;ei>=0;ei--) {
        const e=room.enemies[ei];
        const dist=Math.hypot(e.wx-inf.wx,e.wy-inf.wy);
        if(dist>160)continue;
        let diff=Math.atan2(e.wy-inf.wy,e.wx-inf.wx)-inf.angle;
        while(diff>Math.PI)diff-=Math.PI*2; while(diff<-Math.PI)diff+=Math.PI*2;
        if(Math.abs(diff)>spread+0.2)continue;
        const key='e'+room.enemies[ei].id;
        if(!inf.hitCooldowns[key]||inf.hitCooldowns[key]<=0)
          { e.burning=1.5; damageEnemy(room,ei,1,p.id); inf.hitCooldowns[key]=0.18; }
        else inf.hitCooldowns[key]-=DT;
      }
      if(inf.age>=inf.duration) p.infernos.splice(i,1);
    }

    // Arcane missiles (homing)
    for (let i=p.arcaneMissiles.length-1;i>=0;i--) {
      const m=p.arcaneMissiles[i];
      let ni=-1, nd=Infinity;
      room.enemies.forEach((e,ei)=>{const d=Math.hypot(e.wx-m.wx,e.wy-m.wy);if(d<nd){nd=d;ni=ei;}});
      if(ni>=0&&nd<300){
        let da=Math.atan2(room.enemies[ni].wy-m.wy,room.enemies[ni].wx-m.wx)-m.angle;
        while(da>Math.PI)da-=Math.PI*2;while(da<-Math.PI)da+=Math.PI*2;
        m.angle+=da*0.07; m.dx=Math.cos(m.angle)*13; m.dy=Math.sin(m.angle)*13;
      }
      m.wx+=m.dx; m.wy+=m.dy; m.age+=DT;
      if(m.age>2.5||Math.hypot(m.wx-p.wx,m.wy-p.wy)>1400){p.arcaneMissiles.splice(i,1);continue;}
      let hit=false;
      for(let ei=room.enemies.length-1;ei>=0;ei--)
        if(Math.hypot(m.wx-room.enemies[ei].wx,m.wy-room.enemies[ei].wy)<room.enemies[ei].radius+m.r)
          { damageEnemy(room,ei,2,p.id); hit=true; break; }
      if(!hit&&room.mode==='pvp')
        for(const [tid,tp] of Object.entries(room.players))
          if(tid!==p.id&&tp.alive&&Math.hypot(m.wx-tp.wx,m.wy-tp.wy)<tp.radius+m.r)
            { damagePlayer(room,tid,2,p.id); hit=true; break; }
      if(hit) p.arcaneMissiles.splice(i,1);
    }

    // Void orbs (kill everything)
    for (let i=p.voidOrbs.length-1;i>=0;i--) {
      const orb=p.voidOrbs[i]; orb.wx+=orb.dx; orb.wy+=orb.dy; orb.age+=DT;
      if(orb.age>7||Math.hypot(orb.wx-p.wx,orb.wy-p.wy)>1600){p.voidOrbs.splice(i,1);continue;}
      for(let ei=room.enemies.length-1;ei>=0;ei--) {
        if(orb.hitSet.has(room.enemies[ei].id))continue;
        if(Math.hypot(orb.wx-room.enemies[ei].wx,orb.wy-room.enemies[ei].wy)<room.enemies[ei].radius+orb.r)
          { orb.hitSet.add(room.enemies[ei].id); damageEnemy(room,ei,room.enemies[ei].type==='miniboss'?40:999,p.id); }
      }
      if(room.mode==='pvp')
        for(const [tid,tp] of Object.entries(room.players)) {
          if(tid===p.id||!tp.alive||orb.hitSet.has('p'+tid))continue;
          if(Math.hypot(orb.wx-tp.wx,orb.wy-tp.wy)<tp.radius+orb.r)
            { orb.hitSet.add('p'+tid); damagePlayer(room,tid,3,p.id); }
        }
    }

    // Age lightning visuals
    for(let i=p.lightningZaps.length-1;i>=0;i--)
      { p.lightningZaps[i].age+=DT; if(p.lightningZaps[i].age>=p.lightningZaps[i].life)p.lightningZaps.splice(i,1); }
    for(let i=p.chainBolts.length-1;i>=0;i--)
      { p.chainBolts[i].age+=DT; if(p.chainBolts[i].age>=p.chainBolts[i].life)p.chainBolts.splice(i,1); }
  }

  // ── Enemy movement ───────────────────────────────────────────
  for (let ei=room.enemies.length-1;ei>=0;ei--) {
    const e=room.enemies[ei];
    e.wobble+=DT*3.5;
    if(e.burning>0)e.burning-=DT;
    if(e.armorFlash>0)e.armorFlash-=DT*5;
    if(e.smashing>0)e.smashing-=DT;
    const target=nearestPlayer(room,e.wx,e.wy);
    if(!target)continue;
    const dx=target.wx-e.wx, dy=target.wy-e.wy;
    const dist=Math.hypot(dx,dy);
    e.angle=Math.atan2(dy,dx);
    if(e.type==='archer'){
      const pd=e.preferDist;
      if(dist>pd+40){e.wx+=Math.cos(e.angle)*e.speed;e.wy+=Math.sin(e.angle)*e.speed;}
      else if(dist<pd-40){e.wx-=Math.cos(e.angle)*e.speed;e.wy-=Math.sin(e.angle)*e.speed;}
      else{const perp=e.angle+Math.PI/2;e.wx+=Math.cos(perp)*e.speed*0.6;e.wy+=Math.sin(perp)*e.speed*0.6;}
      e.shootTimer-=DT;
      if(e.shootTimer<=0){
        e.shootTimer=2.0+Math.random()*1.5;
        const aa=e.angle+(Math.random()-0.5)*0.18;
        room.arrows.push({wx:e.wx,wy:e.wy,dx:Math.cos(aa)*8,dy:Math.sin(aa)*8,angle:aa,r:5,age:0});
      }
    } else if(e.type==='miniboss'){
      e.wx+=Math.cos(e.angle)*e.speed; e.wy+=Math.sin(e.angle)*e.speed;
      if(e.smashing<=0){
        e.smashTimer-=DT;
        if(e.smashTimer<=0){
          e.smashTimer=2.5+Math.random()*1.5; e.smashing=0.55;
          if(dist<120)damagePlayer(room,target.id,2,null);
        }
      }
    } else {
      e.wx+=Math.cos(e.angle)*e.speed; e.wy+=Math.sin(e.angle)*e.speed;
    }
    if(dist<e.radius+target.radius&&target.iframes<=0)
      damagePlayer(room,target.id,1,null);
  }

  // ── Arrow movement ───────────────────────────────────────────
  for(let i=room.arrows.length-1;i>=0;i--) {
    const ar=room.arrows[i]; ar.wx+=ar.dx; ar.wy+=ar.dy; ar.age+=DT;
    if(ar.age>3){room.arrows.splice(i,1);continue;}
    for(const [tid,tp] of Object.entries(room.players)) {
      if(!tp.alive)continue;
      if(Math.hypot(ar.wx-tp.wx,ar.wy-tp.wy)<tp.radius+ar.r)
        { room.arrows.splice(i,1); damagePlayer(room,tid,1,null); break; }
    }
  }

  // ── Broadcast slim state ─────────────────────────────────────
  // Round floats to 1 decimal — cuts payload ~40%
  const r1 = n => Math.round(n*10)/10;
  const playerSnaps={};
  for(const [id,p] of Object.entries(room.players)) {
    playerSnaps[id]={
      id:p.id, wx:r1(p.wx), wy:r1(p.wy), angle:r1(p.angle),
      hp:p.hp, alive:p.alive, score:p.score, iframes:r1(p.iframes),
      // Projectiles: position only, no trails (client simulates locally)
      bl:p.bullets.map(b=>[r1(b.wx),r1(b.wy)]),
      fb:p.fireballs.map(b=>[r1(b.wx),r1(b.wy),r1(b.age)]),
      vn:p.vines.map(v=>[r1(v.wx),r1(v.wy),r1(v.angle),r1(v.age)]), // NO trail — client rebuilds
      in:p.infernos.map(i=>[r1(i.wx),r1(i.wy),r1(i.angle),r1(i.age),i.duration]),
      am:p.arcaneMissiles.map(m=>[r1(m.wx),r1(m.wy),r1(m.angle)]),
      vo:p.voidOrbs.map(o=>[r1(o.wx),r1(o.wy),r1(o.age)]),
      lz:p.lightningZaps.map(z=>[r1(z.x1),r1(z.y1),r1(z.x2),r1(z.y2),r1(z.age),z.life]),
      cb:p.chainBolts.map(c=>({segs:c.segments.map(s=>[r1(s.x1),r1(s.y1),r1(s.x2),r1(s.y2)]),age:r1(c.age),life:c.life})),
    };
  }
  // Enemies: only essential fields, rounded
  const enemySnaps = room.enemies.map(e=>({
    id:e.id, type:e.type,
    wx:r1(e.wx), wy:r1(e.wy), angle:r1(e.angle),
    hp:e.hp, maxHp:e.maxHp,
    speed:e.speed, radius:e.radius,
    burning:r1(e.burning||0),
    smashing:r1(e.smashing||0), smashTimer:r1(e.smashTimer||0),
    preferDist:e.preferDist||0,
    armorFlash:r1(e.armorFlash||0),
  }));
  // Arrows: minimal
  const arrowSnaps = room.arrows.map(a=>([r1(a.wx),r1(a.wy),r1(a.dx),r1(a.dy),r1(a.age||0)]));

  broadcastToRoom(room,'state',{
    p:playerSnaps, e:enemySnaps, a:arrowSnaps,
    w:room.wave, s:room.score, t:r1(room.gameTime), m:room.mode,
  });
}

function broadcastToRoom(room,event,data){ io.to(room.code).emit(event,data); }

function endGame(room,reason,winnerId=null){
  room.running=false;
  if(room.tickInterval){clearInterval(room.tickInterval);room.tickInterval=null;}
  broadcastToRoom(room,'game_over',{
    reason,winnerId,score:room.score,
    players:Object.values(room.players).map(p=>({id:p.id,name:p.name,score:p.score,spell:p.spell})),
  });
}

// ═══════════════════════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════════════════════
io.on('connection',(socket)=>{
  console.log(`[+] ${socket.id}`);

  socket.on('create_room',({name,spell,mode})=>{
    let code; do{code=makeRoomCode();}while(rooms.has(code));
    const room=createRoom(code,mode||'coop');
    rooms.set(code,room);
    const player=createPlayer(socket.id,name,spell);
    room.players[socket.id]=player;
    socket.join(code); socket.roomCode=code;
    socket.emit('room_created',{code,mode:room.mode,playerId:socket.id,
      players:Object.values(room.players).map(p=>({id:p.id,name:p.name,spell:p.spell}))});
    console.log(`[Room] Created ${code} (${mode}) by ${name}`);
  });

  socket.on('join_room',({code,name,spell})=>{
    code=code.toUpperCase().trim();
    const room=rooms.get(code);
    if(!room) return socket.emit('join_error',{msg:'Room not found.'});
    if(room.running) return socket.emit('join_error',{msg:'Game already in progress.'});
    if(Object.keys(room.players).length>=MAX_PLAYERS) return socket.emit('join_error',{msg:'Room is full.'});
    const player=createPlayer(socket.id,name,spell);
    room.players[socket.id]=player;
    socket.join(code); socket.roomCode=code;
    socket.emit('room_joined',{code,mode:room.mode,playerId:socket.id,
      players:Object.values(room.players).map(p=>({id:p.id,name:p.name,spell:p.spell}))});
    socket.to(code).emit('player_joined',{id:socket.id,name,spell});
    console.log(`[Room] ${name} joined ${code}`);
  });

  socket.on('start_game',()=>{
    const room=rooms.get(socket.roomCode);
    if(!room||room.running)return;
    if(Object.keys(room.players)[0]!==socket.id)
      return socket.emit('error_msg',{msg:'Only the host can start.'});
    room.running=true;
    Object.values(room.players).forEach((p,i,arr)=>{
      const a=(i/arr.length)*Math.PI*2;
      p.wx=Math.cos(a)*80; p.wy=Math.sin(a)*80;
    });
    broadcastToRoom(room,'game_started',{
      mode:room.mode,
      players:Object.values(room.players).map(p=>({id:p.id,name:p.name,spell:p.spell,wx:p.wx,wy:p.wy})),
    });
    room.tickInterval=setInterval(()=>tickRoom(room),1000/TICK_RATE);
    console.log(`[Game] Started ${room.code} — ${room.mode}, ${Object.keys(room.players).length}P`);
  });

  socket.on('input',({keys,mouseWx,mouseWy})=>{
    const room=rooms.get(socket.roomCode);
    const p=room?.players[socket.id];
    if(!p||!p.alive)return;
    if(keys)p.keys=keys;
    if(mouseWx!==undefined)p.mouseWx=mouseWx;
    if(mouseWy!==undefined)p.mouseWy=mouseWy;
  });

  socket.on('shoot',({type,angle})=>{
    const room=rooms.get(socket.roomCode);
    const p=room?.players[socket.id];
    if(!p||!p.alive||!room.running||p.shootCD>0)return;
    const a=angle;
    if(type==='bullet'){
      p.bullets.push({wx:p.wx+Math.cos(a)*24,wy:p.wy+Math.sin(a)*24,dx:Math.cos(a)*11,dy:Math.sin(a)*11,r:5});
      p.shootCD=0.10;
    }
    if(type==='fireball'){
      p.fireballs.push({wx:p.wx+Math.cos(a)*26,wy:p.wy+Math.sin(a)*26,dx:Math.cos(a)*10,dy:Math.sin(a)*10,r:7,age:0});
      p.shootCD=0.18;
    }
    if(type==='arcane'){
      const spread=0.22;
      for(let i=-1;i<=1;i++){const aa=a+i*spread;p.arcaneMissiles.push({wx:p.wx+Math.cos(aa)*26,wy:p.wy+Math.sin(aa)*26,dx:Math.cos(aa)*13,dy:Math.sin(aa)*13,angle:aa,r:6,age:0});}
      p.shootCD=2.0;
    }
    if(type==='lightning'){
      let bestEi=-1,bestDist=Infinity;
      room.enemies.forEach((e,ei)=>{
        const d=Math.hypot(e.wx-p.wx,e.wy-p.wy);if(d>700)return;
        let diff=Math.atan2(e.wy-p.wy,e.wx-p.wx)-a;
        while(diff>Math.PI)diff-=Math.PI*2;while(diff<-Math.PI)diff+=Math.PI*2;
        if(Math.abs(diff)<0.38&&d<bestDist){bestDist=d;bestEi=ei;}
      });
      const endWx=bestEi>=0?room.enemies[bestEi].wx:p.wx+Math.cos(a)*600;
      const endWy=bestEi>=0?room.enemies[bestEi].wy:p.wy+Math.sin(a)*600;
      p.lightningZaps.push({x1:p.wx,y1:p.wy,x2:endWx,y2:endWy,age:0,life:0.12});
      if(bestEi>=0)damageEnemy(room,bestEi,1,p.id);
      p.shootCD=0.13;
    }
  });

  socket.on('spell',({type,angle})=>{
    const room=rooms.get(socket.roomCode);
    const p=room?.players[socket.id];
    if(!p||!p.alive||!room.running||p.spellCD>0)return;
    const a=angle;
    if(type==='vine'){
      p.vines.push({wx:p.wx,wy:p.wy,dx:Math.cos(a)*7.5,dy:Math.sin(a)*7.5,angle:a,age:0,trail:[],hitSet:new Set(),segT:0});
      p.spellCD=0.85;
    }
    if(type==='inferno'){
      p.infernos.push({wx:p.wx,wy:p.wy,angle:a,age:0,duration:2.0,hitCooldowns:{}});
      p.spellCD=4.0;
    }
    if(type==='chain_lightning'){
      let firstEi=-1,bestDist=Infinity;
      room.enemies.forEach((e,ei)=>{
        const d=Math.hypot(e.wx-p.wx,e.wy-p.wy);if(d>900)return;
        let diff=Math.atan2(e.wy-p.wy,e.wx-p.wx)-a;
        while(diff>Math.PI)diff-=Math.PI*2;while(diff<-Math.PI)diff+=Math.PI*2;
        if(Math.abs(diff)<0.6&&d<bestDist){bestDist=d;firstEi=ei;}
      });
      const segs=[]; const hitSet=new Set();
      if(firstEi<0){
        segs.push({x1:p.wx,y1:p.wy,x2:p.wx+Math.cos(a)*420,y2:p.wy+Math.sin(a)*420});
      } else {
        let curEi=firstEi,prevWx=p.wx,prevWy=p.wy;
        for(let b=0;b<=7;b++){
          if(curEi<0||curEi>=room.enemies.length)break;
          const e=room.enemies[curEi];
          segs.push({x1:prevWx,y1:prevWy,x2:e.wx,y2:e.wy});
          prevWx=e.wx;prevWy=e.wy;hitSet.add(curEi);
          damageEnemy(room,curEi,5,p.id);
          let ni=-1,nd=Infinity;
          room.enemies.forEach((ne,nei)=>{if(hitSet.has(nei))return;const d=Math.hypot(ne.wx-prevWx,ne.wy-prevWy);if(d<300&&d<nd){nd=d;ni=nei;}});
          curEi=ni;
        }
      }
      p.chainBolts.push({segments:segs,age:0,life:0.25});
      p.spellCD=2.5;
    }
    if(type==='void_orb'){
      p.voidOrbs.push({wx:p.wx,wy:p.wy,dx:Math.cos(a)*2.2,dy:Math.sin(a)*2.2,r:26,age:0,hitSet:new Set()});
      p.spellCD=9.0;
    }
  });

  socket.on('disconnect',()=>{
    console.log(`[-] ${socket.id}`);
    const room=rooms.get(socket.roomCode);
    if(!room)return;
    const name=room.players[socket.id]?.name||'?';
    delete room.players[socket.id];
    broadcastToRoom(room,'player_left',{id:socket.id,name});
    if(Object.keys(room.players).length===0){
      if(room.tickInterval)clearInterval(room.tickInterval);
      rooms.delete(room.code);
      console.log(`[Room] Deleted empty room ${room.code}`);
    } else if(room.running&&room.mode==='coop') {
      if(Object.values(room.players).filter(pl=>pl.alive).length===0)endGame(room,'all_dead');
    }
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✨ Wizard Shooter server on port ${PORT}`));

