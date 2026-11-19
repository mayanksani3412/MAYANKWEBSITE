const allowedOrigins = (Deno.env.get('CONTACT_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function jsonResponse(body: Record<string, unknown>, status: number, origin: string | null) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin' });
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'content-type');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins.includes(origin)) {
    return jsonResponse({ ok: false, error: 'Origin is not allowed.' }, 403, null);
  }
  if (request.method === 'OPTIONS') return jsonResponse({ ok: true }, 200, origin);
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405, origin);

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 12000) {
    return jsonResponse({ ok: false, error: 'Request is too large.' }, 413, origin);
  }
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400, origin);
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400, origin);
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const website = typeof input.website === 'string' ? input.website.trim() : '';
  if (website) return jsonResponse({ ok: false, error: 'Invalid request.' }, 400, origin);
  if (name.length < 1 || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 || subject.length < 1 || subject.length > 150 ||
      message.length < 1 || message.length > 5000) {
    return jsonResponse({ ok: false, error: 'Please provide valid contact details and a message.' }, 400, origin);
  }

  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('CONTACT_FROM_EMAIL');
  const to = Deno.env.get('CONTACT_TO_EMAIL') ?? 'mayanksaini1072007@gmail.com';
  if (!apiKey || !from) {
    return jsonResponse({ ok: false, error: 'Email delivery is not configured on the server.' }, 503, origin);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const rateLimitSalt = Deno.env.get('CONTACT_RATE_LIMIT_SALT');
    if (!supabaseUrl || !serviceRoleKey || !rateLimitSalt) {
      return jsonResponse({ ok: false, error: 'Contact rate limiting is not configured on the server.' }, 503, origin);
    }
    const remoteAddress = request.headers.get('x-real-ip') ??
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
    const rateInput = new TextEncoder().encode(rateLimitSalt + ':' + remoteAddress);
    const rateHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', rateInput)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const limitResponse = await fetch(supabaseUrl + '/rest/v1/rpc/allow_contact_submission', {
      method: 'POST',
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': 'Bearer ' + serviceRoleKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ request_hash: rateHash })
    });
    if (!limitResponse.ok) {
      return jsonResponse({ ok: false, error: 'Contact rate limiting is temporarily unavailable.' }, 503, origin);
    }
    if (await limitResponse.json() !== true) {
      return jsonResponse({ ok: false, error: 'Too many messages. Please try again later.' }, 429, origin);
    }

    const delivery = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: 'Portfolio contact: ' + subject.replace(/[\r\n]/g, ' ').slice(0, 150),
        text: 'Name: ' + name + '\nEmail: ' + email + '\n\n' + message
      })
    });
    const deliveryBody = await delivery.json().catch(() => ({}));
    if (!delivery.ok || !deliveryBody.id) {
      return jsonResponse({ ok: false, error: 'The email service did not accept the message.' }, 502, origin);
    }
    return jsonResponse({ ok: true }, 200, origin);
  } catch {
    return jsonResponse({ ok: false, error: 'The email service could not be reached.' }, 502, origin);
  }
});
