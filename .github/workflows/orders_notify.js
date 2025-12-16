// .github/scripts/orders_notify.js
// Sends push notifications for:
// - NEW orders -> branch manager topic + owner topic
// - ASSIGNED_DRIVER orders -> driver topic (only after manager assigns)
// Then writes notification markers back into orders.json to prevent duplicates.

const fs = require('fs');
const path = require('path');

function slug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

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

async function main() {
  const BRAND_ID = mustEnv('BRAND_ID');            // e.g. "mahfouz_market" or "nounas_food"
  const ORDERS_PATH = mustEnv('ORDERS_PATH');      // e.g. "orders.json" or "nouna's_food/orders.json"
  const OWNER_TOPIC = process.env.OWNER_TOPIC || 'owner_all_orders';
  const svc = parseJsonEnv('FIREBASE_SERVICE_ACCOUNT_JSON');

  // Lazy import so the script errors fast if env missing
  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(svc),
    });
  }

  const filePath = path.resolve(process.cwd(), ORDERS_PATH);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Orders file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  let orders;
  try {
    orders = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${ORDERS_PATH}`);
  }

  if (!Array.isArray(orders)) {
    throw new Error(`${ORDERS_PATH} must be a JSON array`);
  }

  let changed = false;
  const newOrderIds = [];

  const nowIso = isoNow();
  const brandSlug = slug(BRAND_ID);

  // Helper: send push to topic
  async function sendTopic(topic, title, body, data = {}) {
    const msg = {
      topic,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [String(k), String(v ?? '')])
      ),
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            sound: 'default',
          },
        },
      },
    };

    return admin.messaging().send(msg);
  }

  for (const o of orders) {
    if (!o || typeof o !== 'object') continue;

    const orderId = String(o.orderId || '');
    if (!orderId) continue;

    // Normalize timestamps
    const createdAt = o.createdAt || o.ts || nowIso;
    if (!o.createdAt) { o.createdAt = createdAt; changed = true; }
    if (!o.ts)        { o.ts = createdAt;        changed = true; }

    // Normalize brand
    if (!o.brand) { o.brand = BRAND_ID; changed = true; }

    // Normalize status
    const status = String(o.status || 'NEW').trim().toUpperCase();
    if (!o.status) { o.status = status; changed = true; }

    // Ensure notifs object
    if (!o.notifs || typeof o.notifs !== 'object') {
      o.notifs = {};
      changed = true;
    }

    const branchName = String(o.branch || 'unknown');
    const branchSlug = slug(branchName) || 'unknown';

    // --- 1) NEW order notifications ---
    if (status === 'NEW' && !o.notifs.newOrderSentAt) {
      const managerTopic = `orders_${brandSlug}_${branchSlug}`;

      const title = 'New Order';
      const body = `[${BRAND_ID}] [${branchName}] ${orderId}`;

      // Branch manager
      await sendTopic(managerTopic, title, body, {
        kind: 'new_order',
        orderId,
        brand: BRAND_ID,
        branch: branchName,
        status,
      });

      // Owner
      await sendTopic(OWNER_TOPIC, title, body, {
        kind: 'new_order',
        orderId,
        brand: BRAND_ID,
        branch: branchName,
        status,
      });

      o.notifs.newOrderSentAt = nowIso;
      changed = true;
      newOrderIds.push(orderId);
    }

    // --- 2) Driver assignment notifications ---
    // IMPORTANT: driver should NOT get notified unless manager transfers (ASSIGNED_DRIVER).
    if (status === 'ASSIGNED_DRIVER' && o.assignedDriverId && !o.notifs.assignedDriverSentAt) {
      const driverId = String(o.assignedDriverId);
      const driverTopic = `driver_${slug(driverId)}`;

      const title = 'Delivery Assigned';
      const body = `Order ${orderId} (${branchName})`;

      await sendTopic(driverTopic, title, body, {
        kind: 'assigned_driver',
        orderId,
        brand: BRAND_ID,
        branch: branchName,
        status,
        driverId,
      });

      o.notifs.assignedDriverSentAt = nowIso;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(orders, null, 2) + '\n', 'utf8');
  }

  // Output for next step (5-minute escalation)
  const outPath = process.env.GITHUB_OUTPUT;
  if (outPath) {
    fs.appendFileSync(outPath, `new_order_ids_json=${JSON.stringify(newOrderIds)}\n`);
    fs.appendFileSync(outPath, `orders_changed=${changed ? 'true' : 'false'}\n`);
  } else {
    // local run
    console.log(JSON.stringify({ newOrderIds, changed }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
