// GET /api/stripe — the Stripe subscriptions, live, for the dashboard's Stripe tab.
// Clients are billed by Stripe through Amelia; this only reads. STRIPE_READ_KEY is a restricted
// key with Read access (Customers, Subscriptions, Invoices, Products, Prices) set in Vercel.
// Only dashboard staff get an answer: the caller's Firebase token must be able to read
// /staff/<uid> = true in the Realtime Database, the same check the database rules use.
const RTDB = process.env.FIREBASE_DATABASE_URL || 'https://gymgo-b752c-default-rtdb.europe-west1.firebasedatabase.app';
const RTDB_NS = process.env.FIREBASE_DATABASE_NS || ''; // local emulator only
const STRIPE = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const KEEP_CANCELED_DAYS = 120;

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

async function isStaff(token) {
  let uid;
  try { uid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).user_id; } catch { return false; }
  if (!uid || !/^[\w-]+$/.test(uid)) return false;
  // The database checks the token's signature; a forged uid gets "Permission denied".
  const r = await fetch(`${RTDB}/staff/${uid}.json?auth=${encodeURIComponent(token)}${RTDB_NS ? `&ns=${RTDB_NS}` : ''}`);
  return r.ok && (await r.json()) === true;
}

async function stripeList(path, params) {
  const out = [];
  let after = null;
  do {
    const url = new URL(path, STRIPE);
    for (const [k, v] of [...params, ['limit', '100'], ...(after ? [['starting_after', after]] : [])]) url.searchParams.append(k, v);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.STRIPE_READ_KEY}` } });
    const page = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(page.error?.message || `Stripe ${r.status}`);
    out.push(...page.data);
    after = page.has_more ? page.data[page.data.length - 1].id : null;
  } while (after);
  return out;
}

const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
const money = (cents) => (cents == null ? null : Math.round(cents) / 100);
const bucharestDay = (isoStr) => (isoStr ? new Date(isoStr).toLocaleDateString('sv-SE', { timeZone: 'Europe/Bucharest' }) : null);

function toRow(s, products) {
  const item = s.items?.data?.[0] || {};
  const price = item.price || s.plan || {};
  const listAmount = money((price.unit_amount ?? price.amount ?? 0) * (item.quantity || 1));
  const d = s.discount || (s.discounts || []).find((x) => typeof x === 'object');
  const coupon = d?.coupon || d?.source?.coupon || null;
  let amount = listAmount;
  if (coupon?.percent_off) amount = Math.round(listAmount * (100 - coupon.percent_off)) / 100;
  else if (coupon?.amount_off) amount = Math.max(0, listAmount - money(coupon.amount_off));
  const inv = typeof s.latest_invoice === 'object' ? s.latest_invoice : null;
  const cust = typeof s.customer === 'object' && s.customer ? s.customer : { id: s.customer };
  // Recent API versions keep the billing period on the subscription item.
  const start = s.current_period_start ?? item.current_period_start;
  const end = s.current_period_end ?? item.current_period_end;
  return {
    id: s.id,
    customerId: cust.id, name: cust.name || '', email: (cust.email || '').toLowerCase(), phone: cust.phone || '',
    product: products.get(price.product)?.name || price.nickname || '',
    listAmount, amount,
    discount: coupon ? { name: coupon.name || coupon.id, percentOff: coupon.percent_off || null, amountOff: money(coupon.amount_off), duration: coupon.duration } : null,
    status: s.status,
    cancelAtPeriodEnd: !!s.cancel_at_period_end, cancelAt: iso(s.cancel_at), endedAt: iso(s.ended_at || s.canceled_at),
    startDate: iso(s.start_date || s.created),
    periodStart: iso(start), periodEnd: iso(end),
    invoice: inv ? {
      status: inv.status, amountPaid: money(inv.amount_paid), amountDue: money(inv.amount_due), attempts: inv.attempt_count || 0,
      paidAt: iso(inv.status_transitions?.paid_at), created: iso(inv.created), nextAttempt: iso(inv.next_payment_attempt),
    } : null,
  };
}

// This month's payment: paid, failed, still to come, or nothing this month.
function monthPayment(s, today) {
  const month = today.slice(0, 7);
  const inv = s.invoice;
  if (s.status === 'canceled') return { state: 'ended', date: bucharestDay(s.endedAt) };
  if (['past_due', 'unpaid', 'incomplete'].includes(s.status) || (inv?.status === 'open' && inv.attempts > 0)) {
    return { state: 'failed', amount: inv?.amountDue ?? s.amount, date: bucharestDay(inv?.created), retry: bucharestDay(inv?.nextAttempt) };
  }
  const paidDay = bucharestDay(inv?.paidAt || inv?.created);
  if (inv?.status === 'paid' && paidDay?.slice(0, 7) === month) return { state: 'paid', amount: inv.amountPaid, date: paidDay };
  if (s.status === 'trialing') return { state: 'trial', date: bucharestDay(s.periodEnd) };
  const renews = bucharestDay(s.periodEnd);
  if (renews?.slice(0, 7) === month && renews >= today && !s.cancelAtPeriodEnd) return { state: 'due', amount: s.amount, date: renews };
  return { state: 'none' };
}

module.exports = async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token || !(await isStaff(token))) return send(res, 403, { error: 'Doar conturile de staff au acces.' });
    if (!process.env.STRIPE_READ_KEY) return send(res, 503, { error: 'Lipsește STRIPE_READ_KEY în Vercel (proiectul dashboard-ului).' });
    const [subs, products] = await Promise.all([
      stripeList('/v1/subscriptions', [['status', 'all'], ['expand[]', 'data.customer'], ['expand[]', 'data.latest_invoice'], ['expand[]', 'data.discounts']]),
      stripeList('/v1/products', []),
    ]);
    const byId = new Map(products.map((p) => [p.id, p]));
    const cutoff = Date.now() - KEEP_CANCELED_DAYS * 86400000;
    const today = bucharestDay(new Date().toISOString());
    const rows = subs
      .filter((s) => s.status !== 'canceled' || (s.ended_at || s.canceled_at || 0) * 1000 > cutoff)
      .map((s) => toRow(s, byId))
      .map((s) => ({ ...s, month: monthPayment(s, today) }));
    send(res, 200, { today, fetchedAt: new Date().toISOString(), subs: rows });
  } catch (e) {
    console.error('[stripe]', e.message);
    send(res, 502, { error: 'Stripe nu a răspuns: ' + e.message });
  }
};
