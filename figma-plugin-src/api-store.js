
function createBridgeApi() {
  const api = {};
  const ctx = { proxy: null };   // the object handed out; module sources get it too
  installBridgeStore(api, ctx);
  installBridgeMacros(api, ctx);
  installBridgePrototype(api, ctx);
  installBridgeReads(api, ctx);

  // Reading a helper that does not exist used to yield undefined and a cryptic
  // "bridge.foo is not a function" one line later. Fail at the call instead,
  // naming what does exist. Symbols and probe keys used by promises/serializers
  // must stay undefined or awaiting/serializing the bridge would break.
  ctx.proxy = new Proxy(api, {
    get(target, key, receiver) {
      if (typeof key !== "string" || key in target || BRIDGE_PROBE_KEYS.indexOf(key) !== -1) {
        return Reflect.get(target, key, receiver);
      }
      return function () {
        throw new Error("bridge." + key + " does not exist. Available: " + Object.keys(target).sort().join(", "));
      };
    }
  });
  return ctx.proxy;
}

function installBridgeStore(api, ctx) {
  // --- ephemeral scratch: survives calls, dies on plugin reload ------------
  api.state = BRIDGE_STATE;

  // --- durable key/value stored inside the .fig document -------------------
  api.store = {
    set(key, value) {
      bridgeWrite("kv:" + key, JSON.stringify(value === undefined ? null : value));
      bridgeIndexAdd("kv", key);
      return value;
    },
    get(key, fallback) {
      const raw = bridgeRead("kv:" + key);
      if (!raw) return fallback;
      try { return JSON.parse(raw); } catch (e) { return fallback; }
    },
    remove(key) {
      bridgeWrite("kv:" + key, "");
      bridgeIndexRemove("kv", key);
    },
    keys() { return bridgeIndex("kv"); }
  };

  // --- reusable code modules ----------------------------------------------
  api.define = function (name, source) {
    const exported = bridgeCompile(name, source, ctx.proxy || api);   // fail fast before saving
    bridgeWrite("mod:" + name, source);
    bridgeIndexAdd("mod", name);
    return exported;
  };

  api.require = function (name) {
    if (BRIDGE_MODULES[name]) return BRIDGE_MODULES[name];
    const source = bridgeRead("mod:" + name);
    if (!source) {
      throw new Error(
        "Module \"" + name + "\" is not defined. Available: [" + api.list().join(", ") + "]. " +
        "Create it with bridge.define(\"" + name + "\", \"...source ending in module.exports = {...}...\")."
      );
    }
    return bridgeCompile(name, source, ctx.proxy || api);
  };

  api.list = function () {
    const saved = bridgeIndex("mod");
    Object.keys(BRIDGE_MODULES).forEach(n => { if (saved.indexOf(n) === -1) saved.push(n); });
    return saved;
  };

  api.source = function (name) { return bridgeRead("mod:" + name); };

  api.remove = function (name) {
    delete BRIDGE_MODULES[name];
    bridgeWrite("mod:" + name, "");
    bridgeIndexRemove("mod", name);
  };
}
