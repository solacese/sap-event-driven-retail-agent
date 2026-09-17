// Standalone Solace connectivity check. Mirrors src/server/solace/session.ts.
// Connects, subscribes to a unique test topic, publishes to it, and verifies
// the round-trip. Reads creds from env; never prints the password.
import solace from 'solclientjs';

const url = process.env.SOLACE_URL;
const vpn = process.env.SOLACE_VPN;
const username = process.env.SOLACE_USERNAME;
const password = process.env.SOLACE_PASSWORD;

if (!url || !vpn || !username || !password) {
  console.error('missing one of SOLACE_URL/VPN/USERNAME/PASSWORD in env');
  process.exit(2);
}

const props = new solace.SolclientFactoryProperties();
props.profile = solace.SolclientFactoryProfiles.version10_5;
props.logLevel = solace.LogLevel.WARN;
solace.SolclientFactory.init(props);

const topic = `conntest/roundtrip/${username}/${Date.now()}`;
let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  console.log(msg);
  try { session.disconnect(); } catch {}
  setTimeout(() => process.exit(code), 300);
};

const session = solace.SolclientFactory.createSession({
  url, vpnName: vpn, userName: username, password,
  connectRetries: 1, reconnectRetries: 1,
});

const hardTimeout = setTimeout(() => finish(1, 'RESULT: TIMEOUT - no UP_NOTICE within 15s'), 15000);

session.on(solace.SessionEventCode.UP_NOTICE, () => {
  console.log('OK: session UP (authenticated, VPN joined)');
  try {
    session.subscribe(solace.SolclientFactory.createTopicDestination(topic), true, topic, 5000);
  } catch (e) {
    finish(1, 'RESULT: FAIL - subscribe error: ' + String(e));
  }
});

session.on(solace.SessionEventCode.SUBSCRIPTION_OK, () => {
  console.log('OK: subscription confirmed on test topic');
  const m = solace.SolclientFactory.createMessage();
  m.setDestination(solace.SolclientFactory.createTopicDestination(topic));
  m.setBinaryAttachment(JSON.stringify({ ping: true }));
  m.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
  try { session.send(m); console.log('OK: publish sent, awaiting echo…'); }
  catch (e) { finish(1, 'RESULT: FAIL - publish error: ' + String(e)); }
});

session.on(solace.SessionEventCode.MESSAGE, (message) => {
  const dest = message.getDestination();
  console.log('OK: received message on', dest ? dest.getName() : '(unknown)');
  clearTimeout(hardTimeout);
  finish(0, 'RESULT: PASS - connect + subscribe + publish round-trip succeeded');
});

session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
  clearTimeout(hardTimeout);
  finish(1, 'RESULT: FAIL - CONNECT_FAILED_ERROR: ' + (e && e.infoStr));
});
session.on(solace.SessionEventCode.SUBSCRIPTION_ERROR, (e) => {
  finish(1, 'RESULT: FAIL - SUBSCRIPTION_ERROR: ' + (e && e.infoStr));
});

try { session.connect(); } catch (e) { finish(1, 'RESULT: FAIL - connect threw: ' + String(e)); }
