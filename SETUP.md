# Restaurant CRM — Synology NAS Setup

## 1. Install Node.js on Synology
1. Open **Package Center** → search **Node.js v18** → Install
2. Open **Package Center** → search **Git** → Install (optional, for copying files)

## 2. Copy files to NAS
Copy the entire `restaurant-crm` folder to your NAS, e.g.:
`/volume1/homes/admin/restaurant-crm/`

Easiest way: drag and drop via **File Station** in DSM.

## 3. Install PM2
SSH into your Synology (enable SSH under Control Panel → Terminal & SNMP):
```bash
ssh admin@<NAS-IP>
cd /volume1/homes/admin/restaurant-crm
npm install -g pm2
```

## 4. Start the app
```bash
pm2 start ecosystem.config.js
pm2 save          # save so it survives reboot
pm2 startup       # follow the printed instructions to auto-start on boot
```

## 5. Access the app
From any device on your network:
```
http://<NAS-IP>:3001
```
Find your NAS IP in DSM → Control Panel → Network → Network Interface.

## Useful PM2 commands
```bash
pm2 status                  # check if running
pm2 logs restaurant-crm     # view live logs
pm2 restart restaurant-crm  # restart after updating files
pm2 stop restaurant-crm     # stop
```

## Port forwarding (optional — remote access outside home)
In your router, forward external port 3001 → NAS-IP:3001.
Consider putting it behind a VPN instead for security.

## Updating the app
1. Copy new files to the NAS (overwrite)
2. `pm2 restart all`

---

## Setting up go.woodpeckers.pizza (public feedback URL)

The CRM runs two servers:
- **Port 3001** — `crm.woodpeckers.pizza` (admin-only, keep restricted)
- **Port 3002** — `go.woodpeckers.pizza` (public, feedback form only)

### Step 1 — Start the public server
After copying the new files, start both processes:
```bash
pm2 start ecosystem.config.js
pm2 save
```
Verify both are running:
```bash
pm2 status
# Should show: restaurant-crm (online) and restaurant-public (online)
```

### Step 2 — Forward port 3002 on your router
In your router, add a second port forwarding rule:
```
External port 3002  →  NAS IP : 3002
```
(Keep your existing rule: External port 3001 → NAS IP : 3001)

### Step 3 — DNS
In your DNS provider, add an A record for `go.woodpeckers.pizza` pointing to the same public IP as `crm.woodpeckers.pizza`.

### Step 4 — Verify
Open `http://go.woodpeckers.pizza:3002/fb` in a browser — you should see the feedback form.
Opening `http://go.woodpeckers.pizza:3002/` (the root) will also show the feedback form.
Any other path (e.g. `/api/data`) returns 404 — the admin CRM is not exposed.

### Optional — HTTPS / clean URL (no port number)
If you use Synology's built-in **Application Portal** (reverse proxy):
1. Control Panel → Application Portal → Reverse Proxy → Create
2. Source: `https`, hostname `go.woodpeckers.pizza`, port `443`
3. Destination: `http`, hostname `localhost`, port `3002`
4. This lets customers reach the form at `https://go.woodpeckers.pizza/fb?t=...` with no port number, which matches the `feedbackBaseUrl` already saved in Settings.
