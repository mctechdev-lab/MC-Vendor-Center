// api/verify-email-code.js
// Checks the 6-digit OTP the vendor entered against what's stored in Supabase
// Marks the vendor's email as verified if the code is correct and not expired
// Called by: onboarding.html Stage 0 when vendor submits the code

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ALLOWED_ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

/* ── Supabase helper ── */
async function sbFetch(path, method = 'GET', body = null, prefer = 'return=minimal') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        prefer
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

export default async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, uid } = req.body || {};

  if (!code || !uid) {
    return res.status(400).json({ error: 'code and uid are required' });
  }

  /* Must be exactly 6 digits */
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Code must be 6 digits' });
  }

  try {
    const now = new Date().toISOString();

    /* 1. Find the most recent unused, non-expired code for this uid */
    const records = await sbFetch(
      `email_otps?uid=eq.${uid}&used=eq.false&expires_at=gt.${now}&order=created_at.desc&limit=1&select=*`,
      'GET'
    );

    if (!records || records.length === 0) {
      return res.status(400).json({
        error: 'Code has expired or was not found. Please request a new one.'
      });
    }

    const record = records[0];

    /* 2. Check if codes match */
    if (record.code !== code) {
      /* Log failed attempt (optional — helps detect brute force) */
      console.warn(`[verify-email-code] Wrong code for uid=${uid}`);
      return res.status(400).json({
        error: 'Incorrect code. Please check and try again.'
      });
    }

    /* 3. Mark code as used */
    await sbFetch(
      `email_otps?id=eq.${record.id}`,
      'PATCH',
      { used: true, used_at: now }
    );

    /* 4. Mark vendor email as verified in vendors table */
    await sbFetch(
      `vendors?uid=eq.${uid}`,
      'PATCH',
      {
        email_verified: true,
        email:          record.email,
        onboarding_step: 1
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully'
    });

  } catch (err) {
    console.error('[verify-email-code] Error:', err.message);
    return res.status(500).json({
      error: 'Verification failed. Please try again.'
    });
  }
}
