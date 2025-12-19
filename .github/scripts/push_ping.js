// .github/scripts/push_ping.js
// Manual push test: send to TOPIC (default owner_all_orders) or TOKEN if provided.

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function parseJsonEnv(name) {
  const v = mustEnv(name);
  try {
    return JSON.parse(v);
  } catch {
    throw new Error(`Env ${name} is not valid JSON`);
  }
}

async function main() {
  const svc = parseJsonEnv('FIREBASE_SERVICE_ACCOUNT_JSON');
  console.log('🔎 svc.project_id =', svc.project_id);
  console.log('🔎 svc.client_email =', svc.client_email);

  const TOPIC = (process.env.TOPIC || 'owner_all_orders').trim();
  const TOKEN = (process.env.TOKEN || '').trim();

  const title = process.env.TITLE || 'PING';
  const body =
    process.env.BODY || `Ping from GitHub Actions @ ${new Date().toISOString()}`;

  const data = {
    kind: 'ping',
    brand: process.env.BRAND_ID || '',
    ts: new Date().toISOString(),
  };

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }

  const msg = {
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: { priority: 'high', notification: { sound: 'default' } },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default' } },
    },
    ...(TOKEN ? { token: TOKEN } : { topic: TOPIC }),
  };

  const id = await admin.messaging().send(msg);
  console.log(
    `✅ PUSH PING SENT: ${TOKEN ? `token=${TOKEN}` : `topic=${TOPIC}`} messageId=${id}`
  );
}

main().catch((err) => {
  console.error('❌ PUSH PING FAILED:', err);
  process.exit(1);
});
