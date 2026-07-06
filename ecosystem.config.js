// PM2 process file for 24/7 hosting of the Quanta ecosystem.
//
// Runs BOTH CAP agents as long-lived processes (each holds one websocket to
// api.croo.network so the agent shows ONLINE in the store):
//   - quanta : the due-diligence PROVIDER  (src/provider.ts        -> dist/provider.js)
//   - zodyl  : the portfolio-scan provider (src/zodyl-provider.ts  -> dist/zodyl-provider.js)
//
// CAP rule: ONE websocket per SDK key. These two use DIFFERENT keys
//   - quanta -> CROO_SDK_KEY
//   - zodyl  -> CROO_ZODYL_SDK_KEY (falls back to CROO_REQUESTER_SDK_KEY)
// so they can run side by side. Never point both at the same key, and never run
// a buyer on a key that already has a provider process here (duplicate-key kick).
//
// Prereqs on the box:  npm ci && npm run build   (compiles src -> dist)
// Env: a gitignored `.env` in this directory (loaded by config.ts via dotenv).
//
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save            # persist the process list across reboots
//   pm2 startup         # print the systemd command to enable boot-time resurrect
//   pm2 logs            # tail both agents
//   pm2 restart all     # after a `git pull && npm run build`

const path = require("path");

// Run the COMPILED JS (not ts-node) for lower memory + faster start on a t3.micro.
const common = {
  cwd: __dirname, // so dotenv finds ./.env no matter where pm2 is invoked
  instances: 1, // exactly one websocket per agent — do NOT cluster
  exec_mode: "fork",
  autorestart: true,
  max_restarts: 20,
  restart_delay: 5000, // back off 5s between crash-restarts
  max_memory_restart: "300M",
  time: true, // timestamp log lines
  env: {
    NODE_ENV: "production",
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: "quanta",
      script: path.join(__dirname, "dist", "provider.js"),
      error_file: path.join(__dirname, "logs", "quanta.err.log"),
      out_file: path.join(__dirname, "logs", "quanta.out.log"),
    },
    {
      ...common,
      name: "zodyl",
      script: path.join(__dirname, "dist", "zodyl-provider.js"),
      error_file: path.join(__dirname, "logs", "zodyl.err.log"),
      out_file: path.join(__dirname, "logs", "zodyl.out.log"),
    },
  ],
};
