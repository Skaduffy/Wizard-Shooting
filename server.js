// ═══════════════════════════════════════════════════════════════
//  WIZARD SHOOTER — Colyseus Multiplayer Server
//  Colyseus handles delta-compressed binary state sync,
//  which is far more efficient than sending full JSON over Socket.io
// ═══════════════════════════════════════════════════════════════

const colyseus  = require('@colyseus/core');
const schema    = require('@colyseus/schema');
const http      = require('http');
const express   = require('express');
const path      = require('path');

const { Room }                                    = colyseus;
const { Schema, MapSchema, ArraySchema, defineTypes } = schema;

// ── Schema definitions (auto delta-patched by Colyseus) ──────
class PlayerState extends Schema {}
defineTypes(PlayerState, {
  name:   'string',
  spell:  'string',
  wx:     'float32',
  wy:     'float32',
  angle:  'float32',
  hp:     'int8',
  maxHp:  'int8',
  alive:  'boolean',
  score:  'int32',
  iframes:'float32',
});

class EnemyState extends Schema {}
defineTypes(EnemyState, {
  id:         'int32',
  type:       'string',
  wx:         'float32',
  wy:         'float32',
  angle:      'float32',
  hp:         'int16',
  maxHp:      'int16',
  speed:      'float32',
  radius:     'int8',
  burning:    'float32',
  smashing:   'float32',
  smashTimer: 'float32',
  preferDist: 'int16',
  armorFlash: 'float32',
  wobble:     'float32',
});

class ArrowState extends Schema {}
defineTypes(ArrowState, {
  wx: 'float32', wy: 'float32',
  dx: 'float32', dy: 'float32',
  age:'float32',
});

class RoomStateSchema extends Schema {}
defineTypes(RoomStateSchema, {
  wave:      'int16',
  score:     'int32',
  gameTime:  'float32',
  mode:      'string',
  running:   'boolean',
  players:   { map: PlayerState  },
  enemies:   { map: EnemyState   },
  arrows:    { map: ArrowState   },
});

// ── Constants ─────────────────────────────────────────────────
const MAX_PLAYERS   = 8;
const TICK_RATE     = 20;
const DT            = 1 / TICK_RATE;
const WAVE_INTERVAL = 22;
const PVP_HIT_DMG   = 1;

// ── Wizard Room ───────────────────────────────────────────────
class WizardRoom extends Room {
  onCreate(options) {
    // Internal (non-schema) server state
    this._players     = {};   // sessionId -> rich player data (projectiles etc.)
    this._nextEnemyId = 0;
    this._nextArrowId = 0;
    this._gameTime    = 0;
    this._waveTimer   = 0;
    this._spawnTimer  = 2.5;
    this._armoredUnlocked = false;
    this._archerUnlocked  = false;
    this._miniBossSpawned = false;

    this.maxClients = MAX_PLAYERS;

    // Set up Colyseus schema state
    const st = new RoomStateSchema();
    st.players = new MapSchema();
    st.enemies = new MapSchema();
    st.arrows  = new MapSchema();
    st.wave    = 1;
    st.score   = 0;
    st.gameTime= 0;
    st.mode    = options.mode || 'coop';
    st.running = false;
    this.setState(st);

    // Patch rate: how often Colyseus sends delta state to clients (ms)
    // 50ms = 20fps, but Colyseus only sends CHANGES so it's very efficient
    this.setPatchRate(50);

    // ── Message handlers ────────────────────────────────────────
    this.onMessage('start_game', (client) => {
      if (this.state.running) return;
      const playerIds = [...this.state.players.keys()];
      if (playerIds[0] !== client.sessionId) {
        client.send('error_msg', { msg: 'Only the host can start.' });
        return;
      }
      this.state.running = true;
      // Spread players in a circle
      let i = 0;
      for (const [id, p] of this.state.players.entries()) {
        const a = (i / this.state.players.size) * Math.PI * 2;
        p.wx = Math.cos(a) * 80;
        p.wy = Math.sin(a) * 80;
        this._players[id].wx = p.wx;
        this._players[id].wy = p.wy;
        i++;
      }
      this.broadcast('game_started', {
        mode: this.state.mode,
        players: [...this.state.players.entries()].map(([id, p]) => ({
          id, name: p.name, spell: p.spell, wx: p.wx, wy: p.wy,
        })),
      });
      // Start simulation at TICK_RATE fps
      this.setSimulationInterval((dt) => this._tick(dt), 1000 / TICK_RATE);
      console.log(`[Game] Started room ${this.roomId} — ${this.state.mode}, ${this.state.players.size}P`);
    });

    this.onMessage('input', (client, data) => {
      const p = this._players[client.sessionId];
      if (!p || !p.alive) return;
      if (data.keys)    p.keys    = data.keys;
      if (data.mouseWx !== undefined) p.mouseWx = data.mouseWx;
      if (data.mouseWy !== undefined) p.mouseWy = data.mouseWy;
    });

    this.onMessage('shoot', (client, data) => {
      if (!this.state.running) return;
      const p = this._players[client.sessionId];
      if (!p || !p.alive || p.shootCD > 0) return;
      const a = data.angle;
      if (data.type === 'bullet') {
        p.bullets.push({ wx:p.wx+Math.cos(a)*24, wy:p.wy+Math.sin(a)*24, dx:Math.cos(a)*11, dy:Math.sin(a)*11, r:5 });
        p.shootCD = 0.10;
      }
      if (data.type === 'fireball') {
        p.fireballs.push({ wx:p.wx+Math.cos(a)*26, wy:p.wy+Math.sin(a)*26, dx:Math.cos(a)*10, dy:Math.sin(a)*10, r:7, age:0 });
        p.shootCD = 0.18;
      }
      if (data.type === 'arcane') {
        const spread = 0.22;
        for (let i=-1; i<=1; i++) {
          const aa = a + i*spread;
          p.arcaneMissiles.push({ wx:p.wx+Math.cos(aa)*26, wy:p.wy+Math.sin(aa)*26, dx:Math.cos(aa)*13, dy:Math.sin(aa)*13, angle:aa, r:6, age:0 });
        }
        p.shootCD = 2.0;
      }
      if (data.type === 'lightning') {
        let bestEi = -1, bestDist = Infinity;
        const enemies = [...this.state.enemies.values()];
        enemies.forEach((e, ei) => {
          const d = Math.hypot(e.wx-p.wx, e.wy-p.wy);
          if (d > 700) return;
          let diff = Math.atan2(e.wy-p.wy, e.wx-p.wx) - a;
          while (diff >  Math.PI) diff -= Math.PI*2;
          while (diff < -Math.PI) diff += Math.PI*2;
          if (Math.abs(diff) < 0.38 && d < bestDist) { bestDist=d; bestEi=ei; }
        });
        const target = bestEi >= 0 ? enemies[bestEi] : null;
        const endWx = target ? target.wx : p.wx+Math.cos(a)*600;
        const endWy = target ? target.wy : p.wy+Math.sin(a)*600;
        p.lightningZaps.push({ x1:p.wx, y1:p.wy, x2:endWx, y2:endWy, age:0, life:0.12 });
        if (target) {
          const id = [...this.state.enemies.entries()].find(([,e])=>e===target)?.[0];
          if (id) this._damageEnemy(id, 1, client.sessionId);
        }
        p.shootCD = 0.13;
      }
    });

    this.onMessage('spell', (client, data) => {
      if (!this.state.running) return;
      const p = this._players[client.sessionId];
      if (!p || !p.alive || p.spellCD > 0) return;
      const a = data.angle;
      if (data.type === 'vine') {
        p.vines.push({ wx:p.wx, wy:p.wy, dx:Math.cos(a)*7.5, dy:Math.sin(a)*7.5, angle:a, age:0, trail:[], hitSet:new Set(), segT:0 });
        p.spellCD = 0.85;
      }
      if (data.type === 'inferno') {
        p.infernos.push({ wx:p.wx, wy:p.wy, angle:a, age:0, duration:2.0, hitCooldowns:{} });
        p.spellCD = 4.0;
      }
      if (data.type === 'chain_lightning') {
        const enemyArr = [...this.state.enemies.entries()]; // [id, state]
        let firstIdx = -1, bestDist = Infinity;
        enemyArr.forEach(([id, e], idx) => {
          const d = Math.hypot(e.wx-p.wx, e.wy-p.wy);
          if (d > 900) return;
          let diff = Math.atan2(e.wy-p.wy, e.wx-p.wx) - a;
          while (diff >  Math.PI) diff -= Math.PI*2;
          while (diff < -Math.PI) diff += Math.PI*2;
          if (Math.abs(diff) < 0.6 && d < bestDist) { bestDist=d; firstIdx=idx; }
        });
        const segs = []; const hitIds = new Set();
        if (firstIdx < 0) {
          segs.push({ x1:p.wx, y1:p.wy, x2:p.wx+Math.cos(a)*420, y2:p.wy+Math.sin(a)*420 });
        } else {
          let curIdx=firstIdx, prevWx=p.wx, prevWy=p.wy;
          for (let b=0; b<=7; b++) {
            if (curIdx < 0 || curIdx >= enemyArr.length) break;
            const [eid, e] = enemyArr[curIdx];
            segs.push({ x1:prevWx, y1:prevWy, x2:e.wx, y2:e.wy });
            prevWx=e.wx; prevWy=e.wy; hitIds.add(eid);
            this._damageEnemy(eid, 5, client.sessionId);
            let ni=-1, nd=Infinity;
            enemyArr.forEach(([nid, ne], ni2) => {
              if (hitIds.has(nid)) return;
              const d = Math.hypot(ne.wx-prevWx, ne.wy-prevWy);
              if (d < 300 && d < nd) { nd=d; ni=ni2; }
            });
            curIdx = ni;
          }
        }
        p.chainBolts.push({ segments:segs, age:0, life:0.25 });
        p.spellCD = 2.5;
      }
      if (data.type === 'void_orb') {
        p.voidOrbs.push({ wx:p.wx, wy:p.wy, dx:Math.cos(a)*2.2, dy:Math.sin(a)*2.2, r:26, age:0, hitSet:new Set() });
        p.spellCD = 9.0;
      }
    });
  }

  onJoin(client, options) {
    const spell = options.spell || 'earth';
    const name  = options.name  || 'Wizard';

    // Schema state (synced automatically by Colyseus)
    const ps = new PlayerState();
    ps.name=name; ps.spell=spell; ps.wx=0; ps.wy=0; ps.angle=0;
    ps.hp=5; ps.maxHp=5; ps.alive=true; ps.score=0; ps.iframes=0;
    this.state.players.set(client.sessionId, ps);

    // Rich internal state (projectiles, not synced via schema — sent as messages)
    this._players[client.sessionId] = {
      id:client.sessionId, name, spell,
      wx:0, wy:0, angle:0, hp:5, maxHp:5, alive:true, score:0, iframes:0,
      radius:18, keys:{w:false,a:false,s:false,d:false},
      mouseWx:0, mouseWy:0, shootCD:0, spellCD:0,
      bullets:[], fireballs:[], vines:[], infernos:[],
      arcaneMissiles:[], voidOrbs:[], lightningZaps:[], chainBolts:[],
    };

    // Tell everyone about the new player
    this.broadcast('player_joined', { id:client.sessionId, name, spell }, { except: client });

    // Tell the joiner the current room info
    client.send('room_info', {
      mode:    this.state.mode,
      running: this.state.running,
      players: [...this.state.players.entries()].map(([id,p])=>({ id, name:p.name, spell:p.spell })),
    });
    console.log(`[Join] ${name} -> room ${this.roomId}`);
  }

  onLeave(client) {
    const p = this.state.players.get(client.sessionId);
    const name = p?.name || '?';
    this.state.players.delete(client.sessionId);
    delete this._players[client.sessionId];
    this.broadcast('player_left', { id:client.sessionId, name });
    console.log(`[Leave] ${name} from room ${this.roomId}`);

    if (this.state.running && this.state.mode === 'coop') {
      const alive = [...Object.values(this._players)].filter(pl=>pl.alive);
      if (alive.length === 0) this._endGame('all_dead');
    }
  }

  // ── Main game tick ────────────────────────────────────────────
  _tick(dt) {
    if (!this.state.running) return;
    const DT = dt / 1000; // ms -> seconds

    this._gameTime  += DT;
    this._waveTimer += DT;
    this._spawnTimer -= DT;
    this.state.gameTime = this._gameTime;

    // Announcements
    if (!this._armoredUnlocked && this._gameTime >= 20) {
      this._armoredUnlocked = true;
      this.broadcast('announcement', { text:'⚔️ Armored Goblins!', color:'#aaaaff' });
    }
    if (!this._archerUnlocked && this._gameTime >= 45) {
      this._archerUnlocked = true;
      this.broadcast('announcement', { text:'🏹 Goblin Archers!', color:'#ffaa44' });
    }

    // Wave progression
    if (this._waveTimer >= WAVE_INTERVAL) {
      this._waveTimer = 0;
      this.state.wave++;
      this.broadcast('wave_change', { wave: this.state.wave });
      if (this.state.wave === 5 && !this._miniBossSpawned && this.state.mode !== 'pvp') {
        this._miniBossSpawned = true;
        this.clock.setTimeout(() => this._spawnMiniBoss(), 2000);
      }
    }

    // Spawn enemies (coop only)
    if (this._spawnTimer <= 0) {
      if (this.state.mode !== 'pvp') {
        const n = Math.ceil(this.state.wave * 0.6 + 0.5);
        for (let k = 0; k < n; k++) {
          const roll = Math.random();
          if      (this._archerUnlocked  && roll < 0.25) this._spawnArcher();
          else if (this._armoredUnlocked && roll < 0.50) this._spawnArmored();
          else this._spawnGoblin();
        }
      }
      this._spawnTimer = Math.max(0.5, 2.5 - this.state.wave * 0.12);
    }

    // ── Move players + update projectiles ───────────────────────
    for (const [sid, p] of Object.entries(this._players)) {
      if (!p.alive) continue;
      const sp = this.state.players.get(sid);
      if (!sp) continue;

      let mx=0, my=0;
      if (p.keys.w) my=-1; if (p.keys.s) my=1;
      if (p.keys.a) mx=-1; if (p.keys.d) mx=1;
      if (mx&&my){mx*=0.707;my*=0.707;}
      p.wx+=mx*4; p.wy+=my*4;
      p.angle = Math.atan2(p.mouseWy-p.wy, p.mouseWx-p.wx);

      // Sync to schema state (Colyseus diffs and sends only changes)
      sp.wx=p.wx; sp.wy=p.wy; sp.angle=p.angle;
      sp.hp=p.hp; sp.alive=p.alive; sp.score=p.score; sp.iframes=p.iframes;

      if (p.shootCD  > 0) p.shootCD  -= DT;
      if (p.spellCD  > 0) p.spellCD  -= DT;
      if (p.iframes  > 0) p.iframes  -= DT;

      this._updateProjectiles(p, sid, DT);
    }

    // ── Move enemies ──────────────────────────────────────────────
    for (const [eid, e] of this.state.enemies.entries()) {
      e.wobble += DT * 3.5;
      if (e.burning    > 0) e.burning    -= DT;
      if (e.armorFlash > 0) e.armorFlash -= DT * 5;
      if (e.smashing   > 0) e.smashing   -= DT;

      const target = this._nearestPlayer(e.wx, e.wy);
      if (!target) continue;
      const dx=target.wx-e.wx, dy=target.wy-e.wy;
      const dist=Math.hypot(dx,dy);
      e.angle=Math.atan2(dy,dx);

      if (e.type==='archer') {
        const pd=e.preferDist||220;
        if(dist>pd+40){e.wx+=Math.cos(e.angle)*e.speed;e.wy+=Math.sin(e.angle)*e.speed;}
        else if(dist<pd-40){e.wx-=Math.cos(e.angle)*e.speed;e.wy-=Math.sin(e.angle)*e.speed;}
        else{const perp=e.angle+Math.PI/2;e.wx+=Math.cos(perp)*e.speed*0.6;e.wy+=Math.sin(perp)*e.speed*0.6;}
        e.smashTimer -= DT; // reuse smashTimer as shootTimer for archer
        if (e.smashTimer <= 0) {
          e.smashTimer = 2.0 + Math.random()*1.5;
          const aa=e.angle+(Math.random()-0.5)*0.18;
          const aid = 'a'+(this._nextArrowId++);
          const as2 = new ArrowState();
          as2.wx=e.wx; as2.wy=e.wy; as2.dx=Math.cos(aa)*8; as2.dy=Math.sin(aa)*8; as2.age=0;
          this.state.arrows.set(aid, as2);
        }
      } else if (e.type==='miniboss') {
        e.wx+=Math.cos(e.angle)*e.speed; e.wy+=Math.sin(e.angle)*e.speed;
        if (e.smashing<=0) {
          e.smashTimer-=DT;
          if (e.smashTimer<=0) {
            e.smashTimer=2.5+Math.random()*1.5; e.smashing=0.55;
            if (dist<120) this._damagePlayer(target.id, 2, null);
          }
        }
      } else {
        e.wx+=Math.cos(e.angle)*e.speed; e.wy+=Math.sin(e.angle)*e.speed;
      }

      // Melee contact
      if (dist < e.radius+18) this._damagePlayer(target.id, 1, null);
    }

    // ── Move arrows ───────────────────────────────────────────────
    for (const [aid, ar] of this.state.arrows.entries()) {
      ar.wx+=ar.dx; ar.wy+=ar.dy; ar.age+=DT;
      if (ar.age > 3) { this.state.arrows.delete(aid); continue; }
      for (const [sid, p] of Object.entries(this._players)) {
        if (!p.alive) continue;
        if (Math.hypot(ar.wx-p.wx, ar.wy-p.wy) < 18+ar.r) {
          this.state.arrows.delete(aid);
          this._damagePlayer(sid, 1, null);
          break;
        }
      }
    }

    // ── Send projectile data as a message (too dynamic for schema) ─
    // Colyseus schema is great for slow-changing state (positions, hp)
    // Projectiles change every frame, so we send them as a slim message
    const projData = {};
    for (const [sid, p] of Object.entries(this._players)) {
      projData[sid] = {
        bl: p.bullets.map(b=>[~~(b.wx),~~(b.wy)]),
        fb: p.fireballs.map(b=>[~~(b.wx),~~(b.wy),+(b.age).toFixed(2)]),
        vn: p.vines.map(v=>[~~(v.wx),~~(v.wy),+(v.angle).toFixed(2),+(v.age).toFixed(2)]),
        in: p.infernos.map(i=>[~~(i.wx),~~(i.wy),+(i.angle).toFixed(2),+(i.age).toFixed(2),i.duration]),
        am: p.arcaneMissiles.map(m=>[~~(m.wx),~~(m.wy),+(m.angle).toFixed(2)]),
        vo: p.voidOrbs.map(o=>[~~(o.wx),~~(o.wy),+(o.age).toFixed(2)]),
        lz: p.lightningZaps.map(z=>[~~(z.x1),~~(z.y1),~~(z.x2),~~(z.y2),+(z.age).toFixed(2),z.life]),
        cb: p.chainBolts.map(c=>({s:c.segments.map(s=>[~~(s.x1),~~(s.y1),~~(s.x2),~~(s.y2)]),a:+(c.age).toFixed(2),l:c.life})),
      };
    }
    this.broadcast('proj', projData);
  }

  _updateProjectiles(p, sid, DT) {
    // Bullets
    for (let i=p.bullets.length-1;i>=0;i--) {
      const b=p.bullets[i]; b.wx+=b.dx; b.wy+=b.dy;
      if(Math.hypot(b.wx-p.wx,b.wy-p.wy)>1400){p.bullets.splice(i,1);continue;}
      let hit=false;
      for(const [eid] of this.state.enemies.entries()) {
        const e=this.state.enemies.get(eid);
        if(Math.hypot(b.wx-e.wx,b.wy-e.wy)<e.radius+b.r){this._damageEnemy(eid,1,sid);hit=true;break;}
      }
      if(!hit&&this.state.mode==='pvp') {
        for(const [tid,tp] of Object.entries(this._players)) {
          if(tid===sid||!tp.alive)continue;
          if(Math.hypot(b.wx-tp.wx,b.wy-tp.wy)<tp.radius+b.r){this._damagePlayer(tid,PVP_HIT_DMG,sid);hit=true;break;}
        }
      }
      if(hit)p.bullets.splice(i,1);
    }
    // Fireballs
    for(let i=p.fireballs.length-1;i>=0;i--){
      const b=p.fireballs[i];b.wx+=b.dx;b.wy+=b.dy;b.age+=DT;
      if(Math.hypot(b.wx-p.wx,b.wy-p.wy)>1400){p.fireballs.splice(i,1);continue;}
      let hit=false;
      for(const [eid] of this.state.enemies.entries()){
        const e=this.state.enemies.get(eid);
        if(Math.hypot(b.wx-e.wx,b.wy-e.wy)<e.radius+b.r){this._damageEnemy(eid,2,sid);hit=true;break;}
      }
      if(!hit&&this.state.mode==='pvp'){
        for(const [tid,tp] of Object.entries(this._players)){
          if(tid===sid||!tp.alive)continue;
          if(Math.hypot(b.wx-tp.wx,b.wy-tp.wy)<tp.radius+b.r){this._damagePlayer(tid,2,sid);hit=true;break;}
        }
      }
      if(hit)p.fireballs.splice(i,1);
    }
    // Vines
    for(let i=p.vines.length-1;i>=0;i--){
      const v=p.vines[i];v.age+=DT;v.wx+=v.dx;v.wy+=v.dy;v.segT+=DT;
      if(v.segT>0.025){v.segT=0;v.trail.push({wx:v.wx,wy:v.wy});}
      for(const [eid] of this.state.enemies.entries()){
        if(v.hitSet.has(eid))continue;
        const e=this.state.enemies.get(eid);
        if(Math.hypot(v.wx-e.wx,v.wy-e.wy)<e.radius+12){v.hitSet.add(eid);this._damageEnemy(eid,3,sid);}
      }
      if(v.age>2.2||Math.hypot(v.wx-p.wx,v.wy-p.wy)>1400)p.vines.splice(i,1);
    }
    // Infernos
    for(let i=p.infernos.length-1;i>=0;i--){
      const inf=p.infernos[i];inf.age+=DT;inf.wx=p.wx;inf.wy=p.wy;
      for(const [eid] of this.state.enemies.entries()){
        const e=this.state.enemies.get(eid);
        const dist=Math.hypot(e.wx-inf.wx,e.wy-inf.wy);
        if(dist>160)continue;
        let diff=Math.atan2(e.wy-inf.wy,e.wx-inf.wx)-inf.angle;
        while(diff>Math.PI)diff-=Math.PI*2;while(diff<-Math.PI)diff+=Math.PI*2;
        if(Math.abs(diff)>0.85)continue;
        const key='e'+eid;
        if(!inf.hitCooldowns[key]||inf.hitCooldowns[key]<=0){e.burning=1.5;this._damageEnemy(eid,1,sid);inf.hitCooldowns[key]=0.18;}
        else inf.hitCooldowns[key]-=DT;
      }
      if(inf.age>=inf.duration)p.infernos.splice(i,1);
    }
    // Arcane missiles
    for(let i=p.arcaneMissiles.length-1;i>=0;i--){
      const m=p.arcaneMissiles[i];
      let ni=-1,nd=Infinity;
      for(const [eid] of this.state.enemies.entries()){
        const e=this.state.enemies.get(eid);
        const d=Math.hypot(e.wx-m.wx,e.wy-m.wy);
        if(d<nd){nd=d;ni=eid;}
      }
      if(ni>=0&&nd<300){
        const e=this.state.enemies.get(ni);
        let da=Math.atan2(e.wy-m.wy,e.wx-m.wx)-m.angle;
        while(da>Math.PI)da-=Math.PI*2;while(da<-Math.PI)da+=Math.PI*2;
        m.angle+=da*0.07;m.dx=Math.cos(m.angle)*13;m.dy=Math.sin(m.angle)*13;
      }
      m.wx+=m.dx;m.wy+=m.dy;m.age+=DT;
      if(m.age>2.5||Math.hypot(m.wx-p.wx,m.wy-p.wy)>1400){p.arcaneMissiles.splice(i,1);continue;}
      let hit=false;
      for(const [eid] of this.state.enemies.entries()){
        const e=this.state.enemies.get(eid);
        if(Math.hypot(m.wx-e.wx,m.wy-e.wy)<e.radius+m.r){this._damageEnemy(eid,2,sid);hit=true;break;}
      }
      if(!hit&&this.state.mode==='pvp'){
        for(const [tid,tp] of Object.entries(this._players)){
          if(tid===sid||!tp.alive)continue;
          if(Math.hypot(m.wx-tp.wx,m.wy-tp.wy)<tp.radius+m.r){this._damagePlayer(tid,2,sid);hit=true;break;}
        }
      }
      if(hit)p.arcaneMissiles.splice(i,1);
    }
    // Void orbs
    for(let i=p.voidOrbs.length-1;i>=0;i--){
      const orb=p.voidOrbs[i];orb.wx+=orb.dx;orb.wy+=orb.dy;orb.age+=DT;
      if(orb.age>7||Math.hypot(orb.wx-p.wx,orb.wy-p.wy)>1600){p.voidOrbs.splice(i,1);continue;}
      for(const [eid] of this.state.enemies.entries()){
        if(orb.hitSet.has(eid))continue;
        const e=this.state.enemies.get(eid);
        if(Math.hypot(orb.wx-e.wx,orb.wy-e.wy)<e.radius+orb.r){
          orb.hitSet.add(eid);this._damageEnemy(eid,e.type==='miniboss'?40:999,sid);
        }
      }
      if(this.state.mode==='pvp'){
        for(const [tid,tp] of Object.entries(this._players)){
          if(tid===sid||!tp.alive||orb.hitSet.has('p'+tid))continue;
          if(Math.hypot(orb.wx-tp.wx,orb.wy-tp.wy)<tp.radius+orb.r){orb.hitSet.add('p'+tid);this._damagePlayer(tid,3,sid);}
        }
      }
    }
    // Age lightning visuals
    for(let i=p.lightningZaps.length-1;i>=0;i--){p.lightningZaps[i].age+=DT;if(p.lightningZaps[i].age>=p.lightningZaps[i].life)p.lightningZaps.splice(i,1);}
    for(let i=p.chainBolts.length-1;i>=0;i--){p.chainBolts[i].age+=DT;if(p.chainBolts[i].age>=p.chainBolts[i].life)p.chainBolts.splice(i,1);}
  }

  // ── Helpers ───────────────────────────────────────────────────
  _nearestPlayer(wx, wy) {
    let best=null, bestD=Infinity;
    for(const [id,p] of Object.entries(this._players)){
      if(!p.alive)continue;
      const d=Math.hypot(p.wx-wx,p.wy-wy);
      if(d<bestD){bestD=d;best=p;}
    }
    return best;
  }

  _roomCentroid() {
    const ps=Object.values(this._players).filter(p=>p.alive);
    if(!ps.length)return{wx:0,wy:0};
    return{wx:ps.reduce((s,p)=>s+p.wx,0)/ps.length,wy:ps.reduce((s,p)=>s+p.wy,0)/ps.length};
  }

  _spawnEdge() {
    const{wx:cx,wy:cy}=this._roomCentroid();
    const side=Math.floor(Math.random()*4),hw=900,hh=600;
    if(side===0)return{wx:cx+(Math.random()*2-1)*hw,wy:cy-hh};
    if(side===1)return{wx:cx+hw,wy:cy+(Math.random()*2-1)*hh};
    if(side===2)return{wx:cx+(Math.random()*2-1)*hw,wy:cy+hh};
    return{wx:cx-hw,wy:cy+(Math.random()*2-1)*hh};
  }

  _addEnemy(type, extra) {
    const {wx,wy}=this._spawnEdge();
    const es=new EnemyState();
    es.id=this._nextEnemyId++; es.type=type; es.wx=wx; es.wy=wy;
    es.angle=0; es.wobble=Math.random()*Math.PI*2; es.burning=0;
    es.armorFlash=0; es.smashing=0; es.smashTimer=3+Math.random();
    Object.assign(es, extra);
    this.state.enemies.set('e'+es.id, es);
  }

  _spawnGoblin() {
    const hp=3+Math.floor(this.state.wave*0.6);
    this._addEnemy('basic',{hp,maxHp:hp,speed:1.1+this.state.wave*0.1+Math.random()*0.5,radius:16,preferDist:0});
  }
  _spawnArmored() {
    const hp=10+Math.floor(this.state.wave*1.2);
    this._addEnemy('armored',{hp,maxHp:hp,speed:0.7+this.state.wave*0.05+Math.random()*0.3,radius:20,preferDist:0});
  }
  _spawnArcher() {
    const hp=4+Math.floor(this.state.wave*0.5);
    this._addEnemy('archer',{hp,maxHp:hp,speed:0.9+Math.random()*0.4,radius:14,
      preferDist:220+Math.random()*80,smashTimer:1.5+Math.random()*2});
  }
  _spawnMiniBoss() {
    this._addEnemy('miniboss',{hp:120,maxHp:120,speed:1.1,radius:36,preferDist:0,smashTimer:3+Math.random()});
    this.broadcast('announcement',{text:'👹 GRUMTUSK ARRIVES!',color:'#ff4444'});
  }

  _damageEnemy(eid, dmg, killerId) {
    const e=this.state.enemies.get(eid);
    if(!e)return;
    if(e.type==='armored')  dmg=Math.max(1,Math.ceil(dmg*0.6));
    if(e.type==='miniboss') dmg=Math.max(1,Math.ceil(dmg*0.8));
    e.hp-=dmg; e.armorFlash=0.5;
    if(e.hp<=0){
      const pts={miniboss:500,armored:25,archer:15,basic:10}[e.type]||10;
      const earned=pts*this.state.wave;
      if(this.state.mode==='coop'){this.state.score+=earned;}
      else{
        const kp=this._players[killerId];
        if(kp){kp.score+=earned;const sp=this.state.players.get(killerId);if(sp)sp.score=kp.score;}
      }
      this.broadcast('enemy_killed',{id:e.id,pts:earned,killerId});
      this.state.enemies.delete(eid);
    }
  }

  _damagePlayer(targetId, dmg, attackerId) {
    const p=this._players[targetId];
    if(!p||!p.alive||p.iframes>0)return;
    p.hp-=dmg; p.iframes=1.5;
    const sp=this.state.players.get(targetId);
    if(sp){sp.hp=p.hp;sp.iframes=p.iframes;}
    if(p.hp<=0){
      p.hp=0;p.alive=false;
      if(sp){sp.hp=0;sp.alive=false;}
      this.broadcast('player_died',{id:targetId,killerId:attackerId});
      const alive=Object.values(this._players).filter(pl=>pl.alive);
      if(this.state.mode==='coop'&&alive.length===0)this._endGame('all_dead');
      if(this.state.mode==='pvp' &&alive.length<=1) this._endGame('pvp_winner',alive[0]?.id||null);
    }
  }

  _endGame(reason, winnerId=null) {
    this.state.running=false;
    this.broadcast('game_over',{
      reason,winnerId,score:this.state.score,
      players:Object.values(this._players).map(p=>({id:p.id,name:p.name,score:p.score,spell:p.spell})),
    });
  }
}

// ── Express + Colyseus server ─────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);

const fs = require('fs');

// Serve from both public/ and root
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  const inPublic = path.join(__dirname, 'public', 'Wizard Shooter.html');
  const inRoot   = path.join(__dirname, 'Wizard Shooter.html');
  if      (fs.existsSync(inPublic)) res.sendFile(inPublic);
  else if (fs.existsSync(inRoot))   res.sendFile(inRoot);
  else res.status(404).send('Wizard Shooter.html not found — check your repo structure.');
});

const gameServer = new colyseus.Server({ server: httpServer });
gameServer.define('wizard_room', WizardRoom);

const PORT = process.env.PORT || 2567;
httpServer.listen(PORT, () => console.log(`✨ Wizard Shooter (Colyseus) on port ${PORT}`));
