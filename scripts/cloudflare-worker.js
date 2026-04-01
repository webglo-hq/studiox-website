/**
 * Studio X Contact Form Handler - Cloudflare Worker
 * 
 * Features:
 * - Cloudflare Turnstile verification (anti-bot)
 * - Rate limiting (3 submissions/hour per IP)
 * - Honeypot field detection
 * - CORS handling
 * - Forwards to Google Apps Script
 */

const TURNSTILE_SECRET = '0x4AAAAAACy1i5i4Zh5m7MFk2gbprHRx-Wg';
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz-Neh8iazLF2phqEQDZsq-lvo27BR3xITzF9DDaHLlARyDFBUx879-XBDgDQh3Zc4dFw/exec';
const ALLOWED_ORIGINS = ['https://studiox.fit', 'https://www.studiox.fit'];
const RATE_LIMIT = 3; // Max submissions per hour
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request);
    }

    // Only accept POST
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // Check origin
    const origin = request.headers.get('Origin');
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }

    try {
      // Parse form data
      const formData = await request.formData();
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

      // Extract fields
      const name = formData.get('name');
      const email = formData.get('email');
      const phone = formData.get('phone') || '';
      const interest = formData.get('interest') || '';
      const message = formData.get('message');
      const marketingConsent = formData.get('marketing_consent');
      const turnstileToken = formData.get('cf-turnstile-response');
      const honeypot = formData.get('website'); // Honeypot field

      // 1. HONEYPOT CHECK (instant reject if filled)
      if (honeypot && honeypot.trim() !== '') {
        console.log(`Bot detected (honeypot): IP ${ip}`);
        return jsonResponse({ 
          success: false, 
          error: 'Invalid submission' 
        }, 400);
      }

      // 2. RATE LIMITING
      const rateLimitKey = `ratelimit:${ip}`;
      const rateLimitResult = await checkRateLimit(env, rateLimitKey);
      
      if (!rateLimitResult.allowed) {
        return jsonResponse({ 
          success: false, 
          error: `Too many submissions. Please try again in ${Math.ceil(rateLimitResult.retryAfter / 60)} minutes.`
        }, 429);
      }

      // 3. TURNSTILE VERIFICATION
      if (!turnstileToken) {
        return jsonResponse({ 
          success: false, 
          error: 'Security verification failed. Please refresh and try again.' 
        }, 400);
      }

      const turnstileValid = await verifyTurnstile(turnstileToken, ip);
      if (!turnstileValid) {
        return jsonResponse({ 
          success: false, 
          error: 'Security verification failed. Please try again.' 
        }, 400);
      }

      // 4. VALIDATE REQUIRED FIELDS
      if (!name || !email || !message || !marketingConsent) {
        return jsonResponse({ 
          success: false, 
          error: 'Please fill in all required fields.' 
        }, 400);
      }

      // 5. EMAIL VALIDATION
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return jsonResponse({ 
          success: false, 
          error: 'Please enter a valid email address.' 
        }, 400);
      }

      // 6. INCREMENT RATE LIMIT COUNTER
      await incrementRateLimit(env, rateLimitKey);

      // 7. FORWARD TO GOOGLE APPS SCRIPT
      const googleFormData = new FormData();
      googleFormData.append('name', name);
      googleFormData.append('email', email);
      googleFormData.append('phone', phone);
      googleFormData.append('interest', interest);
      googleFormData.append('message', message);
      googleFormData.append('marketing_consent', marketingConsent);
      googleFormData.append('ip', ip);
      googleFormData.append('timestamp', new Date().toISOString());

      const googleResponse = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        body: googleFormData,
      });

      if (!googleResponse.ok) {
        throw new Error('Failed to submit to Google Apps Script');
      }

      return jsonResponse({ 
        success: true, 
        message: 'Thank you! We\'ll be in touch soon.' 
      }, 200, origin);

    } catch (error) {
      console.error('Contact form error:', error);
      return jsonResponse({ 
        success: false, 
        error: 'An error occurred. Please try again or DM us on Instagram.' 
      }, 500);
    }
  }
};

/**
 * Verify Turnstile token with Cloudflare
 */
async function verifyTurnstile(token, ip) {
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret: TURNSTILE_SECRET,
        response: token,
        remoteip: ip,
      }),
    });

    const data = await response.json();
    return data.success === true;
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return false;
  }
}

/**
 * Rate limiting with KV storage (or in-memory fallback)
 */
async function checkRateLimit(env, key) {
  // If KV is available, use it; otherwise allow (graceful degradation)
  if (!env.RATE_LIMIT_KV) {
    return { allowed: true };
  }

  try {
    const data = await env.RATE_LIMIT_KV.get(key, { type: 'json' });
    
    if (!data) {
      return { allowed: true };
    }

    const now = Date.now() / 1000;
    const elapsed = now - data.firstSubmission;

    if (elapsed > RATE_LIMIT_WINDOW) {
      // Window expired, reset
      return { allowed: true };
    }

    if (data.count >= RATE_LIMIT) {
      // Rate limit exceeded
      const retryAfter = RATE_LIMIT_WINDOW - elapsed;
      return { allowed: false, retryAfter };
    }

    return { allowed: true };
  } catch (error) {
    console.error('Rate limit check error:', error);
    return { allowed: true }; // Fail open
  }
}

/**
 * Increment rate limit counter
 */
async function incrementRateLimit(env, key) {
  if (!env.RATE_LIMIT_KV) return;

  try {
    const data = await env.RATE_LIMIT_KV.get(key, { type: 'json' });
    const now = Date.now() / 1000;

    if (!data || (now - data.firstSubmission) > RATE_LIMIT_WINDOW) {
      // First submission in window
      await env.RATE_LIMIT_KV.put(key, JSON.stringify({
        count: 1,
        firstSubmission: now,
      }), {
        expirationTtl: RATE_LIMIT_WINDOW,
      });
    } else {
      // Increment counter
      await env.RATE_LIMIT_KV.put(key, JSON.stringify({
        count: data.count + 1,
        firstSubmission: data.firstSubmission,
      }), {
        expirationTtl: RATE_LIMIT_WINDOW,
      });
    }
  } catch (error) {
    console.error('Rate limit increment error:', error);
  }
}

/**
 * Handle CORS preflight
 */
function handleCORS(request) {
  const origin = request.headers.get('Origin');
  
  if (ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  
  return new Response(null, { status: 403 });
}

/**
 * JSON response helper
 */
function jsonResponse(data, status = 200, origin = null) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}
