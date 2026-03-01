const Donations = require('../models/donations');

let stripe = null;

function getClient() {
  if (!stripe && process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

const StripeService = {
  async createCheckoutSession(amount, donorEmail) {
    const client = getClient();
    if (!client) throw new Error('Stripe not configured');

    const session = await client.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Donation — Claryville Fire Department',
            description: 'Supporting the Claryville Fire Department',
          },
          unit_amount: amount, // in cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: donorEmail || undefined,
      success_url: `${process.env.BASE_URL || 'http://localhost:3000'}/donate/success`,
      cancel_url: `${process.env.BASE_URL || 'http://localhost:3000'}/donate`,
    });

    return session;
  },

  handleWebhook(payload, sig) {
    const client = getClient();
    if (!client) throw new Error('Stripe not configured');

    let event;
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = client.webhooks.constructEvent(payload, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(payload);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      Donations.create(
        session.id,
        session.customer_details?.name || null,
        session.customer_details?.email || session.customer_email || null,
        session.amount_total // in cents
      );
      console.log(`[Stripe] Donation recorded: $${(session.amount_total / 100).toFixed(2)}`);
    }

    return event;
  },

  isConfigured() {
    return !!process.env.STRIPE_SECRET_KEY;
  },

  getPublishableKey() {
    return process.env.STRIPE_PUBLISHABLE_KEY || '';
  },
};

module.exports = StripeService;
