// api/vendor-auth.js
// Verifies Firebase ID token server-side and creates/fetches vendor profile in Supabase
// Called by: signup.html after every successful auth (email, Google, phone)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ── Init Firebase Admin (once) ── */
function initFirebaseAdmin() {
  if (getApps().length > 0) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

/* ── Supabase helper using service key (bypasses RLS) ── */
async function sbServiceFetch(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'return=representation' : 'return=minimal'
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
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, email, phone, displayName, token } = req.body || {};

  if (!uid || !token) {
    return res.status(400).json({ error: 'uid and token are required' });
  }

  try {
    initFirebaseAdmin();
    const auth = getAuth();

    /* 1. Verify the Firebase ID token */
    const decoded = await auth.verifyIdToken(token);
    if (decoded.uid !== uid) {
      return res.status(401).json({ error: 'Token UID mismatch' });
    }

    /* 2. Check if vendor profile already exists */
    const existing = await sbServiceFetch(`vendors?uid=eq.${uid}&select=uid,status,onboarding_step`);

    if (existing && existing.length > 0) {
      /* Already exists — return current status */
      return res.status(200).json({
        success: true,
        isNew:   false,
        vendor:  existing[0]
      });
    }

    /* 3. Create new vendor profile */
    const newVendor = {
      uid,
      email:               email || decoded.email || '',
      phone:               phone || decoded.phone_number || '',
      display_name:        displayName || decoded.name || '',
      status:              'draft',
      onboarding_complete: false,
      onboarding_step:     0,
      email_verified:      decoded.email_verified || false,
      created_at:          new Date().toISOString()
    };

    const created = await sbServiceFetch('vendors', 'POST', newVendor);

    return res.status(201).json({
      success: true,
      isNew:   true,
      vendor:  created ? created[0] : newVendor
    });

  } catch (err) {
    console.error('[vendor-auth] Error:', err.message);

    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (err.code === 'auth/invalid-id-token') {
      return res.status(401).json({ error: 'Invalid session token.' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
}
