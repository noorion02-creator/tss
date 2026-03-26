const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors({ origin: '*' }));

// Webhook precisa do body RAW (antes do json parser)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    await supabase.from('orders').update({
      payment_status: 'pago',
      status: 'em_preparacao',
      stripe_payment_intent_id: intent.id,
      pago_em: new Date().toISOString(),
    }).eq('id', intent.metadata.order_id);
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    await supabase.from('orders').update({
      payment_status: 'falhou',
      status: 'cancelado',
    }).eq('id', intent.metadata.order_id);
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    await supabase.from('sellers')
      .update({ stripe_onboarding_complete: account.charges_enabled && account.payouts_enabled })
      .eq('stripe_account_id', account.id);
  }

  res.json({ received: true });
});

app.use(express.json());

// Cria PaymentIntent com split 90/10
app.post('/create-intent', async (req, res) => {
  try {
    const { order_id, supabase_token } = req.body;

    // Verifica o usuário pelo token
    const { data: { user }, error: authErr } = await supabase.auth.getUser(supabase_token);
    if (authErr || !user) return res.status(401).json({ error: 'Não autenticado' });

    // Busca o pedido
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('*, sellers(stripe_account_id)')
      .eq('id', order_id)
      .eq('cliente_id', user.id)
      .single();

    if (orderErr || !order) return res.status(404).json({ error: 'Pedido não encontrado' });

    const totalCents    = Math.round(Number(order.total) * 100);
    const vendedorCents = Math.round(totalCents * 0.90);
    const sellerStripeId = order.sellers?.stripe_account_id;

    const intentParams = {
      amount: totalCents,
      currency: 'brl',
      payment_method_types: ['card'],
      metadata: { order_id },
    };

    if (sellerStripeId) {
      intentParams.transfer_data = { destination: sellerStripeId, amount: vendedorCents };
      intentParams.application_fee_amount = totalCents - vendedorCents;
    }

    const intent = await stripe.paymentIntents.create(intentParams);

    await supabase.from('orders').update({
      stripe_payment_intent_id: intent.id,
      payment_status: 'pendente_confirmacao',
    }).eq('id', order_id);

    res.json({ client_secret: intent.client_secret });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Onboarding do vendedor
app.post('/onboarding', async (req, res) => {
  try {
    const { supabase_token } = req.body;

    const { data: { user }, error: authErr } = await supabase.auth.getUser(supabase_token);
    if (authErr || !user) return res.status(401).json({ error: 'Não autenticado' });

    const { data: seller } = await supabase
      .from('sellers').select('*').eq('user_id', user.id).single();
    if (!seller) return res.status(404).json({ error: 'Loja não encontrada' });

    let stripeAccountId = seller.stripe_account_id;

    if (!stripeAccountId) {
      const { data: profile } = await supabase
        .from('profiles').select('email').eq('id', user.id).single();

      const account = await stripe.accounts.create({
        type: 'express',
        country: 'BR',
        email: profile?.email,
        business_profile: { name: seller.nome_loja },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      });
      stripeAccountId = account.id;
      await supabase.from('sellers').update({ stripe_account_id: stripeAccountId }).eq('id', seller.id);
    }

    const link = await stripe.accountLinks.create({
      account: stripeAccountId,
      type: 'account_onboarding',
      return_url: `${process.env.SITE_URL}/vendedor.html?stripe=success`,
      refresh_url: `${process.env.SITE_URL}/vendedor.html?stripe=refresh`,
    });

    res.json({ url: link.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_, res) => res.send('ZoneGeek API ✅'));

app.listen(process.env.PORT || 3000, () => console.log('Servidor rodando!'));
