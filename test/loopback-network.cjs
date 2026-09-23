// Separate from offline-network.cjs: preserve native fetch, but permit sockets
// only to HTTP fixture servers explicitly registered in this process.
const net = require("node:net");
const http = require("node:http");
const { syncBuiltinESMExports } = require("node:module");
const ports = new Set();
const deny = () => { throw new Error("Only registered loopback HTTP fixtures are permitted"); };
const connect = net.Socket.prototype.connect;
const listen = net.Server.prototype.listen;
net.Socket.prototype.connect = function (...args) {
  // net.connect passes an already-normalized [options, callback] pair to
  // Socket.connect; direct Socket callers pass the ordinary argument list.
  const options = (Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args))[0];
  if (options.path || options.host !== "127.0.0.1" || !ports.has(Number(options.port))) {
    // Match socket failure semantics, including Undici's asynchronous attempt
    // to replace an aborted connection after a fixture has closed.
    return this.destroy(new Error("Only registered loopback HTTP fixtures are permitted"));
  }
  return connect.apply(this, args);
};
net.Server.prototype.listen = deny;
require("node:tls").connect = deny;
require("node:dgram").createSocket = deny;
for (const name of ["node:dns", "node:dns/promises"]) {
  const dns = require(name);
  for (const key of Object.keys(dns)) {
    if (/^(lookup|resolve|reverse)/.test(key)) dns[key] = deny;
  }
}
// net.Server.listen calls lookup even for a numeric bind address. Answer that
// one literal locally; never invoke the OS resolver.
require("node:dns").lookup = (host, options, callback) => {
  if (host !== "127.0.0.1") deny();
  if (typeof options === "function") callback = options;
  process.nextTick(() => callback(null, ...(options?.all
    ? [[{ address: host, family: 4 }]]
    : [host, 4])));
};
syncBuiltinESMExports();

module.exports.listen = async (server) => {
  if (!(server instanceof http.Server)) deny();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    listen.call(server, { host: "127.0.0.1", port: 0 }, () => {
      server.removeListener("error", reject);
      ports.add(server.address().port);
      resolve();
    });
  });
  const port = server.address().port;
  server.once("close", () => ports.delete(port));
  return `http://127.0.0.1:${port}`;
};