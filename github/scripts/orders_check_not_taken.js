// .github/scripts/orders_check_not_taken.js
// After 5 minutes from order creation, if order is still NEW => notify owner.

const fs = require('fs');
const path = require('path');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function parseJsonEnv(name) {
  const v = mustEnv(name);
  try {
    return JSON.parse(v);
  } catch (e) {
    throw new Error(`Env ${name} is not valid JSON`);
  }
}

function isoNow() {
  return new Date().toISOString();
}

function minutesBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 60000.0;
}

async function main() {
  const BRAND_ID = mustEnv('BRAND_ID');
  const ORDERS_PATH = mustEnv('ORDERS_PATH');
  const OWNER_TOPIC = process.env.OWNER_TOPIC || 'owner_all_orders';
  const svc = parseJsonEnv('FIREBASE_SERVICE_ACCOUNT_JSON');
  const ORDER_IDS = parseJsonEnv('ORDER_IDS_JSON');

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }

  const filePath = path.resolve(process.cwd(), ORDERS_PATH);
  if (!fs.existsSync(filePath)) return;

  let orders = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(orders)) return;

  const nowIso = isoNow();
  let changed = false;

  async function sendOwner(title, body, data = {}) {
    const msg = {
      topic: OWNER_TOPIC,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [String(k), String(v ?? '')])
      ),
      android: { priority: 'high', notification: { sound: 'default' } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    };
    return admin.messaging().send(msg);
  }

  for (const id of ORDER_IDS) {
    const order = orders.find((o) => o && typeof o === 'object' && String(o.orderId) === String(id));
    if (!order) continue;

    const status = String(order.status || 'NEW').trim().toUpperCase();
    const createdAt = order.createdAt || order.ts;
    if (!createdAt) continue;

    if (!order.notifs || typeof order.notifs !== 'object') {
      order.notifs = {};
      changed = true;
    }

    if (status === 'NEW' && !order.notifs.notTaken5mSentAt) {
      const mins = minutesBetween(createdAt, nowIso);
      if (mins != null && mins >= 5.0) {
        const branchName = String(order.branch || 'unknown');
        const title = '⚠️ Order not taken (5 min)';
        const body = `[${BRAND_ID}] [${branchName}] ${id}`;

        await sendOwner(title, body, {
          kind: 'not_taken_5m',
          orderId: String(id),
          brand: BRAND_ID,
          branch: branchName,
          status,
          createdAt: String(createdAt),
        });

        order.notifs.notTaken5mSentAt = nowIso;
        changed = true;
      }
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(orders, null, 2) + '\n', 'utf8');
  }

  const outPath = process.env.GITHUB_OUTPUT;
  if (outPath) {
    fs.appendFileSync(outPath, `escalations_changed=${changed ? 'true' : 'false'}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
