# Wizard Shooter — Multiplayer

A co-op and PvP wizard bullet-hell game. Up to 8 players per room.

## Repo Structure

```
/
├── server.js          ← Node.js + Socket.io game server (deploy to Render)
├── package.json
├── render.yaml        ← Render auto-deploy config
└── public/
    └── Wizard_shooter.html  ← Game client (host on GoDaddy or any static host)
```

---

## Deploy the Server (Render)

1. **Push this repo to GitHub.**

2. Go to [render.com](https://render.com) → New → Web Service.

3. Connect your GitHub repo.

4. Render will auto-detect `render.yaml`. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node

5. Click **Deploy**. Wait ~2 minutes.

6. Copy your Render URL — it looks like:
   `https://wizard-shooter-xxxx.onrender.com`

---

## Update the Client with Your Server URL

Open `public/Wizard_shooter.html` and find this line (near the top of the `<script>`):

```js
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://YOUR-APP-NAME.onrender.com'; // ← REPLACE THIS
```

Replace `YOUR-APP-NAME.onrender.com` with your actual Render URL.

---

## Host the Client (GoDaddy)

1. Upload `public/Wizard_shooter.html` to your GoDaddy hosting via File Manager or FTP.
2. Rename it to `index.html` if you want it at your root domain.
3. Done — players visit your domain and click **Multiplayer**.

> The HTML file connects to your Render server for all multiplayer features.
> The single-player mode works entirely offline (no server needed).

---

## How to Play Multiplayer

1. One player clicks **Multiplayer** → **Create Room** → picks **Co-op** or **PvP** → **Create Game**.
2. Share the 5-letter room code with friends.
3. Friends click **Multiplayer** → **Join Room** → enter the code.
4. Host clicks **Start Game** when everyone is ready.

### Co-op Mode
- All players share a single wave counter and score.
- Enemies target the nearest wizard.
- Game ends when all wizards die.

### PvP Mode  
- Each player has their own score (kills earn points).
- All spells and projectiles damage other players too.
- Void Orb deals 3 damage to enemy wizards.
- Last wizard standing wins.

---

## Local Development

```bash
npm install
npm run dev        # starts server on port 3000 with nodemon

# Open public/Wizard_shooter.html in a browser
# SERVER_URL auto-detects localhost:3000
```

---

## Render Free Tier Notes

- Free tier servers **spin down after 15 minutes of inactivity**.
- The first connection after spin-down takes ~30 seconds to wake up.
- To avoid this, upgrade to Render's $7/month tier or add a cron ping.
- Game state is **in-memory only** — restarting the server clears all rooms.