# DEPLOY — running the Quanta ecosystem 24/7

This runs the two CAP agents (**Quanta** = due-diligence provider, **Zodyl** =
portfolio-scan provider) as always-on processes so they show **ONLINE** in the
CROO Agent Store even when your laptop is closed.

> **Why a small VM and not Lambda / App Runner / Cloud Run?**
> Each agent holds a **long-lived websocket** to `api.croo.network`. Serverless
> platforms freeze/cycle idle processes and don't keep an outbound socket open,
> so the agent would flap OFFLINE. Use a tiny always-on VM (**EC2 t3.micro** or
> **Lightsail $5**) with **pm2** as the process supervisor. A t3.micro is well
> within the AWS free tier / your $100 credit.

> **⚠️ Security first.** The `.env` on this box holds SDK keys that control
> **funded USDC wallets on Base**. Anyone who reads it can drain them. Lock the
> box down (see [Security](#security)) and never commit `.env` (it's gitignored).

---

## 0. What runs

| pm2 name | script            | SDK key env               | shows as        |
|----------|-------------------|---------------------------|-----------------|
| `quanta` | `dist/provider.js`| `CROO_SDK_KEY`            | Quanta provider |
| `zodyl`  | `dist/zodyl-provider.js` | `CROO_ZODYL_SDK_KEY` (→ `CROO_REQUESTER_SDK_KEY`) | Zodyl provider  |

Both are defined in [`ecosystem.config.js`](./ecosystem.config.js). They use
**different keys**, so both websockets are legal (CAP allows one socket per key).

---

## 1. Launch the VM (AWS EC2, ~5 min)

1. EC2 → **Launch instance**.
2. **AMI:** Amazon Linux 2023 (or Ubuntu 22.04 — commands below note both).
3. **Type:** `t3.micro`.
4. **Key pair:** create/download one (e.g. `quanta.pem`) — this is your SSH key.
5. **Network / Security group:** create one that allows **only**:
   - Inbound: **SSH (22)** from **My IP** (not `0.0.0.0/0`).
   - Outbound: **all** (the agents need to reach `api.croo.network` + Base RPC).
   - **No inbound 80/443** — the agents are outbound websocket clients, they
     serve no public port.
6. Storage: default 8–10 GB gp3 is plenty. Launch.

SSH in:
```bash
chmod 400 quanta.pem
ssh -i quanta.pem ec2-user@<PUBLIC_IP>      # Ubuntu: ubuntu@<PUBLIC_IP>
```

## 2. Install Node 20 + git + pm2

```bash
# Amazon Linux 2023:
sudo dnf -y update && sudo dnf -y install git
# Ubuntu:  sudo apt-get update && sudo apt-get -y install git

# Node 20 via nvm (works on both):
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 20 && nvm alias default 20

npm install -g pm2
node -v   # expect v20.x
```

## 3. Clone + build

```bash
git clone https://github.com/zaxcoraider/Quanta.git
cd Quanta
npm ci
npm run build            # compiles src/ -> dist/ (provider.js, zodyl-provider.js)
```

## 4. Create the `.env` (the secret step)

Create `~/Quanta/.env` with the **real** keys/ids from your dashboard. Do NOT
paste them into your shell history — use the heredoc below, then lock perms:

```bash
umask 077
cat > .env <<'EOF'
CROO_SDK_KEY=croo_sk_...provider...
CROO_SERVICE_ID=8879e4ab-4b1b-44be-8282-509b4aa44048

CROO_REQUESTER_SDK_KEY=croo_sk_...zodyl/requester...
CROO_ZODYL_SERVICE_ID=be95ebc1-6ae5-44d0-b899-8c53cb5b95e3

# endpoints (defaults are fine — Base mainnet)
CROO_API_URL=https://api.croo.network
CROO_WS_URL=wss://api.croo.network/ws
CROO_RPC_URL=https://mainnet.base.org

# live A2A sub-orders take >90s — keep the bumped timeout
CROO_UPSTREAM_TIMEOUT_MS=200000

# optional LLM overlay (safe to omit — engine runs zero-key)
DGRID_API_KEY=
DGRID_BASE_URL=https://api.dgrid.ai/v1
QUANTA_LLM_MODEL=claude-opus-4-8
EOF
chmod 600 .env
```
> Copy the exact values from your **local** gitignored `.env` (the canonical
> source). `CROO_ZODYL_SDK_KEY` can stay unset — Zodyl falls back to
> `CROO_REQUESTER_SDK_KEY`.

## 5. Start under pm2 (24/7)

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save                 # snapshot the process list
pm2 startup              # prints ONE sudo command — copy/paste & run it
                         # (registers a systemd unit so pm2 resurrects on reboot)
```

Verify both are up:
```bash
pm2 status               # quanta + zodyl should be "online"
pm2 logs --lines 40      # expect: "🟢 Quanta provider online" / "🟢 Zodyl portfolio agent online"
```
Then open the CROO store — both agents should now read **ONLINE**.

---

## Updating after a code change

```bash
cd ~/Quanta
git pull
npm ci                   # only if package.json changed
npm run build
pm2 restart all
pm2 logs --lines 20
```

## Handy pm2 commands

```bash
pm2 status               # health / restarts / memory
pm2 logs quanta          # tail one agent
pm2 restart zodyl        # bounce one agent
pm2 stop all             # take both OFFLINE (e.g. before running a local demo)
pm2 delete all           # remove from pm2 (undo with `pm2 start ecosystem.config.js`)
pm2 monit                # live dashboard
```

> **Recording the demo?** You can leave these running, OR `pm2 stop all` on the
> box and run the agents locally so the on-screen terminal is the one settling
> the order. Judging doesn't require 24/7 — it's for real buyers and presence.

---

## Security

The wallets behind these keys hold real USDC. Minimum hardening:

- **`chmod 600 .env`** (done above). Never `git add` it — it's gitignored;
  confirm with `git status` that it never shows up.
- **SSH-only, from your IP.** No inbound 80/443. Rotate to key-only auth
  (default on AWS AMIs — password login is already off).
- **Keep the box patched:** `sudo dnf -y update` (or `apt-get upgrade`) periodically.
- **Don't echo keys** into shell history (the heredoc above avoids that). If you
  ever paste a key at a prompt, clear history: `history -c && rm -f ~/.bash_history`.
- **Least funds on the box:** keep only the small working USDC balance the agents
  need to pay for A2A sub-orders. Withdraw earnings periodically from the dashboard.
- **If a key leaks:** rotate it in the CROO dashboard immediately and move funds
  to a fresh wallet; the old key's websocket dies on rotation.
