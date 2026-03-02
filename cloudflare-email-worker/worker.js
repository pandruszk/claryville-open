// Cloudflare Email Worker for Claryville Open
// Routes incoming emails to the app's webhook endpoint
//
// Setup:
// 1. Create a Cloudflare Worker with this code
// 2. Add environment variable: WEBHOOK_SECRET (same as EMAIL_WEBHOOK_SECRET in .env)
// 3. In Cloudflare Dashboard > Email Routing > Email Workers, create a route:
//    - Custom address: rulescommittee@claryvilleopen.com (or catch-all)
//    - Action: Send to Worker → this worker

import PostalMime from 'postal-mime';

export default {
  async email(message, env) {
    const WEBHOOK_URL = 'https://claryvilleopen.com/webhook/email';

    try {
      // Read the raw email
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parser = new PostalMime();
      const parsed = await parser.parse(rawEmail);

      const payload = {
        from: message.from,
        subject: parsed.subject || '(no subject)',
        body: parsed.text || parsed.html || '',
      };

      const resp = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.WEBHOOK_SECRET}`,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        console.log(`Webhook responded ${resp.status}: ${await resp.text()}`);
        message.setReject(`Webhook error: ${resp.status}`);
      }
    } catch (err) {
      console.log('Email worker error:', err.message);
      message.setReject(`Worker error: ${err.message}`);
    }
  },
};
