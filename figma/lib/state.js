// Mutable bridge state shared across modules. A CommonJS "let" cannot be handed
// to another module (the receiver gets a copy), so the fields that several
// modules read and write live on one object; never destructure them.
const state = {
  commandResolvers: new Map(),
  lastPluginPing: 0,
  isBridgeMaster: false,
  listenAttemptInFlight: false,
  // Late-result blocks a proxy got from the master (`__late` in /execute and
  // /job replies), waiting for the router wrapper to hand them to the model.
  lateInbox: []
};

// Commands queue instead of overwriting a single slot: two tool calls issued
// while the plugin is offline used to clobber each other, and the loser only
// surfaced as a timeout 40s later.
const pendingCommands = [];
const wsClients = new Set();

// Wakes callers parked in waitForClient() the moment a plugin (re)connects.
const clientWaiters = new Set();
function wakeClientWaiters() {
  for (const fn of Array.from(clientWaiters)) { try { fn(); } catch (e) {} }
}
function waitForClient(ms) {
  if (wsClients.size > 0 || !(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); clientWaiters.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    clientWaiters.add(done);
  });
}

module.exports = { state, pendingCommands, wsClients, clientWaiters, wakeClientWaiters, waitForClient };
