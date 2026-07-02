// api/send-email-code.js
// Generates a 6-digit OTP, stores it in Supabase with 10-minute expiry,
// then sends it to the vendor's email via SendBaba
// Called by: onboarding.html Stage 0 (email verification)

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SENDBABA_API_KEY     = process.env.SENDBABA_API_KEY;
const SENDBABA_SENDER      = process.env.SENDBABA_SENDER_EMAIL || 'noreply@mcstore.com.ng';
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

/* ── Generate a random 6-digit code ── */
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ── Supabase helper ── */
async function sbFetch(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ── Send email via SendBaba ── */
async function sendViaSendBaba(toEmail, code) {
  const res = await fetch('https://api.sendbaba.com/api/v1/emails/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDBABA_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      from:    SENDBABA_SENDER,
      to:      toEmail,
      subject: `${code} — Your MC Vendor Center verification code`,
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8" /></head>
        <body style="margin:0;padding:0;background:#f6f8fd;font-family:'Plus Jakarta Sans',Arial,sans-serif;">
          <div style="max-width:480px;margin:32px auto;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid rgba(26,86,219,.10);box-shadow:0 8px 28px rgba(15,27,61,.09);">

            <!-- Header -->
            <div style="background:linear-gradient(135deg,#1a56db 0%,#1543ad 100%);padding:28px 32px;text-align:center;">
              <div style="width:48px;height:48px;background:rgba(255,255,255,.18);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
                <span style="font-size:22px;">&#128274;</span>
              </div>
              <div style="font-family:Arial,sans-serif;font-weight:900;font-size:20px;color:#ffffff;letter-spacing:-0.02em;">MC Vendor Center</div>
              <div style="font-size:12px;color:rgba(255,255,255,.80);margin-top:3px;">by MC Store Nigeria</div>
            </div>

            <!-- Body -->
            <div style="padding:32px;">
              <div style="font-size:16px;font-weight:700;color:#0f1b3d;margin-bottom:8px;">Verify your email address</div>
              <div style="font-size:14px;color:#5b6987;line-height:1.6;margin-bottom:24px;">
                Use the 6-digit code below to verify your email and continue setting up your MC Store vendor account.
              </div>

              <!-- Code box -->
              <div style="background:#f6f8fd;border:2px solid rgba(26,86,219,.15);border-radius:14px;padding:24px;text-align:center;margin-bottom:24px;">
                <div style="font-size:11px;font-weight:800;color:#93a0bd;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">Your verification code</div>
                <div style="font-family:Arial,sans-serif;font-weight:900;font-size:40px;color:#1a56db;letter-spacing:.18em;">${code}</div>
                <div style="font-size:12px;color:#93a0bd;margin-top:10px;">This code expires in <strong>10 minutes</strong></div>
              </div>

              <div style="font-size:13px;color:#5b6987;line-height:1.6;margin-bottom:20px;">
                Enter this code on the MC Vendor Center onboarding page to continue.
                If you did not request this, you can safely ignore this email.
              </div>

              <div style="padding-top:20px;border-top:1px solid rgba(26,86,219,.08);font-size:11px;color:#93a0bd;text-align:center;">
                &copy; 2025 MC Store Nigeria &middot; Bodija, Ibadan, Oyo State
                <br />Need help? WhatsApp: +234 805 623 0366
              </div>
            </div>
          </div>
        </body>
        </html>
      `
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SendBaba error ${res.status}: ${err}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, uid } = req.body || {};

  if (!email || !uid) {
    return res.status(400).json({ error: 'email and uid are required' });
  }

  /* Basic email validation */
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  /* Rate limiting — max 3 codes per uid per hour */
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await sbFetch(
      `email_otps?uid=eq.${uid}&created_at=gt.${oneHourAgo}&select=id`
    );
    if (recent && recent.length >= 3) {
      return res.status(429).json({
        error: 'Too many code requests. Please wait an hour before requesting again.'
      });
    }
  } catch (err) {
    /* If table doesn't exist yet, skip rate limiting */
    console.warn('[send-email-code] Rate limit check failed (table may not exist):', err.message);
  }

  try {
    const code    = generateCode();
    const expiry  = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    /* Store code in Supabase */
    await sbFetch('email_otps', 'POST', {
      uid,
      email,
      code,
      expires_at:  expiry,
      used:        false,
      created_at:  new Date().toISOString()
    });

    /* Send via SendBaba */
    await sendViaSendBaba(email, code);

    return res.status(200).json({
      success: true,
      message: `Verification code sent to ${email}`
    });

  } catch (err) {
    console.error('[send-email-code] Error:', err.message);
    return res.status(500).json({
      error: 'Failed to send verification code. Please try again.'
    });
  }
}
