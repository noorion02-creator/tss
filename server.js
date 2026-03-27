// ═══════════════════════════════════════════════════════════════
//  ZoneGeek API  —  Stripe Connect Marketplace
//  Deploy: Railway.app ou Fly.io (grátis)
// ═══════════════════════════════════════════════════════════════
const express  = require('express');
const Stripe   = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors     = require('cors');

const app = express();
const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SITE_URL = 'https://zonegeek.com.br', PORT = 3000 } = process.env;

if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Variáveis obrigatórias não configuradas!'); process.exit(1);
}

const stripe   = Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: '*' }));

// ── WEBHOOK (body RAW — deve vir ANTES do json parser) ────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).send(`Webhook Error: ${e.message}`); }

  console.log(`[webhook] ${event.type}`);
  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      await supabase.from('orders').update({ payment_status: 'pago', status: 'em_preparacao', stripe_payment_intent_id: pi.id, pago_em: new Date().toISOString() }).eq('id', pi.metadata.order_id);
      console.log(`✅ Pedido ${pi.metadata.order_id} PAGO`);
    }
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      await supabase.from('orders').update({ payment_status: 'falhou', status: 'cancelado', payment_error: pi.last_payment_error?.message ?? 'Recusado' }).eq('id', pi.metadata.order_id);
    }
    if (event.type === 'payment_intent.canceled') {
      const pi = event.data.object;
      await supabase.from('orders').update({ payment_status: 'expirado', status: 'cancelado' }).eq('id', pi.metadata.order_id);
    }
    if (event.type === 'account.updated') {
      const acc = event.data.object;
      await supabase.from('sellers').update({ stripe_onboarding_complete: acc.charges_enabled && acc.payouts_enabled }).eq('stripe_account_id', acc.id);
    }
  } catch (e) { console.error('[webhook] Erro:', e.message); }
  res.json({ received: true });
});

app.use(express.json());

async function getUser(token) {
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

app.get('/', (_, res) => res.json({ ok: true, service: 'ZoneGeek API v1.0' }));

// ── POST /create-intent ───────────────────────────────────────
app.post('/create-intent', async (req, res) => {
  try {
    const { supabase_token, order_id, payment_method = 'cartao', parcelas = 1 } = req.body;
    const user = await getUser(supabase_token);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });

    const { data: order, error: oErr } = await supabase.from('orders').select('*, sellers(stripe_account_id)').eq('id', order_id).eq('cliente_id', user.id).single();
    if (oErr || !order) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (!['pendente','pendente_confirmacao'].includes(order.payment_status)) return res.status(400).json({ error: 'Pedido já processado' });

    const totalCents    = Math.round(parseFloat(order.total) * 100);
    const vendedorCents = Math.round(totalCents * 0.90);
    const sellerStripe  = order.sellers?.stripe_account_id ?? null;

    const params = {
      amount: totalCents, currency: 'brl',
      payment_method_types: payment_method === 'pix' ? ['card','pix'] : ['card'],
      metadata: { order_id, cliente_id: user.id, seller_id: order.seller_id ?? '' },
    };

    if (sellerStripe) {
      params.transfer_data          = { destination: sellerStripe, amount: vendedorCents };
      params.application_fee_amount = totalCents - vendedorCents;
    }

    const intent = await stripe.paymentIntents.create(params);
    await supabase.from('orders').update({ stripe_payment_intent_id: intent.id, payment_status: 'pendente_confirmacao', payment_installments: parcelas }).eq('id', order_id);

    res.json({ client_secret: intent.client_secret, intent_id: intent.id, pix: intent.next_action?.pix_display_qr_code ?? null });
  } catch (e) { console.error('[create-intent]', e.message); res.status(500).json({ error: e.message }); }
});

// ── POST /onboarding ──────────────────────────────────────────
app.post('/onboarding', async (req, res) => {
  try {
    const { supabase_token } = req.body;
    const user = await getUser(supabase_token);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });

    const { data: seller } = await supabase.from('sellers').select('*').eq('user_id', user.id).single();
    if (!seller) return res.status(404).json({ error: 'Loja não encontrada' });

    let stripeId = seller.stripe_account_id;
    if (!stripeId) {
      const { data: profile } = await supabase.from('profiles').select('email,nome').eq('id', user.id).single();
      const account = await stripe.accounts.create({ type: 'express', country: 'BR', email: profile?.email ?? user.email, business_profile: { name: seller.nome_loja }, capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'friday' } } } });
      stripeId = account.id;
      await supabase.from('sellers').update({ stripe_account_id: stripeId }).eq('id', seller.id);
    }

    const link = await stripe.accountLinks.create({ account: stripeId, type: 'account_onboarding', return_url: `${SITE_URL}/vendedor.html?stripe=success`, refresh_url: `${SITE_URL}/vendedor.html?stripe=refresh`, collect: 'eventually_due' });
    res.json({ url: link.url, account_id: stripeId });
  } catch (e) { console.error('[onboarding]', e.message); res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 ZoneGeek API na porta ${PORT} | Stripe: ${STRIPE_SECRET_KEY?.startsWith('sk_live') ? '🟢 PROD' : '🟡 TESTE'}`));
