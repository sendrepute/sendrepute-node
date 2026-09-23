// Preload before SDK imports, including in child test workers. Never permit real
// SMTP, API calls, or DNS even if a fixture accidentally omits its fake client.
const deny = () => { throw new Error("Network access is forbidden in SDK runtime checks"); };
require("node:net").Socket.prototype.connect = deny;
require("node:net").connect = deny;
require("node:net").createConnection = deny;
require("node:tls").connect = deny;
for (const name of ["node:http", "node:https"]) {
  require(name).request = deny;
  require(name).get = deny;
}
for (const name of ["node:dns", "node:dns/promises"]) {
  const dns = require(name);
  for (const key of Object.keys(dns)) {
    if (/^(lookup|resolve|reverse)/.test(key)) dns[key] = deny;
  }
}
globalThis.fetch = deny;