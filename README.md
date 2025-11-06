# ItplayLab Server (Render-ready)

Minimal Node.js + Express template designed for **Render.com**.

## Run locally
```bash
npm install
npm start
# http://localhost:10000
```

## Deploy on Render
1. Push this repo to GitHub.
2. In Render Dashboard: **New → Web Service**.
3. Select this repository.
4. Set **Environment: Node**.
5. **Build Command:** `npm install`
   **Start Command:** `npm start`
6. Deploy! Your app will be available at `https://<service-name>.onrender.com`.

Render supplies `PORT` env var automatically — the app reads `process.env.PORT`.
