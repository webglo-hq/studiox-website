/**
 * Studio X Wrestling - Cloudflare Worker Form Handler
 * 
 * SETUP INSTRUCTIONS:
 * 
 * 1. Go to Cloudflare Dashboard > Workers & Pages
 * 2. Click "Create Worker"
 * 3. Name it "studiox-form-handler"
 * 4. Replace the code with this script
 * 5. Click "Deploy"
 * 
 * 6. Set up environment variables (Settings > Variables):
 *    - GOOGLE_SCRIPT_URL: Your deployed Google Apps Script Web App URL
 *    - ALLOWED_ORIGINS: https://studiox.fit,https://www.studiox.fit
 * 
 * 7. Add a Custom Route (Workers > studiox-form-handler > Triggers):
 *    - Route: studiox.fit/api/*
 *    - Zone: studiox.fit
 * 
 * 8. Make sure the route is also added for www:
 *    - Route: www.studiox.fit/api/*
 *    - Zone: studiox.fit
 */

// Environment variables (set in Cloudflare dashboard)
// GOOGLE_SCRIPT_URL - The deployed Google Apps Script web app URL
// ALLOWED_ORIGINS - Comma-separated list of allowed origins

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }
    
    // Route handling
    if (url.pathname === '/api/contact') {
      return handleContactForm(request, env);
    }
    
    if (url.pathname === '/api/unsubscribe') {
      return handleUnsubscribe(request, env);
    }
    
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'Studio X Form Handler'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 404 for unknown API routes
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Handle CORS preflight requests
function handleCORS(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = (env.ALLOWED_ORIGINS || 'https://studiox.fit,https://www.studiox.fit').split(',');
  
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  
  if (allowedOrigins.includes(origin) || origin.includes('localhost')) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
  }
  
  return new Response(null, { headers: corsHeaders });
}

// Add CORS headers to response
function addCORSHeaders(response, request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = (env.ALLOWED_ORIGINS || 'https://studiox.fit,https://www.studiox.fit').split(',');
  
  const newHeaders = new Headers(response.headers);
  
  if (allowedOrigins.includes(origin) || origin.includes('localhost')) {
    newHeaders.set('Access-Control-Allow-Origin', origin);
  }
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

// Handle contact form submissions
async function handleContactForm(request, env) {
  // Only allow POST
  if (request.method !== 'POST') {
    return addCORSHeaders(new Response(JSON.stringify({ 
      error: 'Method not allowed' 
    }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    }), request, env);
  }
  
  try {
    // Parse form data (supports both JSON and form-urlencoded)
    let data;
    const contentType = request.headers.get('Content-Type') || '';
    
    if (contentType.includes('application/json')) {
      data = await request.json();
    } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      data = Object.fromEntries(formData.entries());
    } else {
      // Try to parse as JSON anyway
      const text = await request.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = Object.fromEntries(new URLSearchParams(text));
      }
    }
    
    // Validate required fields
    const errors = validateFormData(data);
    if (errors.length > 0) {
      return addCORSHeaders(new Response(JSON.stringify({ 
        success: false, 
        errors 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }), request, env);
    }
    
    // Sanitize data
    const sanitizedData = sanitizeFormData(data);
    
    // Add metadata
    sanitizedData.source = 'Website Form';
    sanitizedData.submitted_at = new Date().toISOString();
    sanitizedData.ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    sanitizedData.user_agent = request.headers.get('User-Agent') || 'unknown';
    sanitizedData.country = request.headers.get('CF-IPCountry') || 'unknown';
    
    // Forward to Google Apps Script
    if (env.GOOGLE_SCRIPT_URL) {
      try {
        const gasResponse = await fetch(env.GOOGLE_SCRIPT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(sanitizedData)
        });
        
        const gasResult = await gasResponse.json();
        
        if (!gasResult.success) {
          console.error('Google Apps Script error:', gasResult.error);
        }
      } catch (gasError) {
        console.error('Failed to forward to Google Apps Script:', gasError);
        // Continue anyway - we don't want to fail the user's submission
      }
    }
    
    // Return success to the user
    return addCORSHeaders(new Response(JSON.stringify({ 
      success: true, 
      message: 'Thank you! We\'ll be in touch soon.',
      redirect: '/contact/thank-you/'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }), request, env);
    
  } catch (error) {
    console.error('Form handler error:', error);
    
    return addCORSHeaders(new Response(JSON.stringify({ 
      success: false, 
      error: 'Something went wrong. Please try again or DM us on Instagram.' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    }), request, env);
  }
}

// Validate form data
function validateFormData(data) {
  const errors = [];
  
  if (!data.name || data.name.trim().length < 2) {
    errors.push({ field: 'name', message: 'Please enter your name' });
  }
  
  if (!data.email || !isValidEmail(data.email)) {
    errors.push({ field: 'email', message: 'Please enter a valid email address' });
  }
  
  if (!data.message || data.message.trim().length < 10) {
    errors.push({ field: 'message', message: 'Please tell us a bit more about your goals' });
  }
  
  if (!data.marketing_consent || data.marketing_consent !== 'yes') {
    errors.push({ field: 'marketing_consent', message: 'Please agree to receive updates' });
  }
  
  return errors;
}

// Email validation
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Sanitize form data to prevent XSS and injection
function sanitizeFormData(data) {
  const sanitized = {};
  
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      // Remove HTML tags and trim whitespace
      sanitized[key] = value
        .replace(/<[^>]*>/g, '')
        .trim()
        .substring(0, 5000); // Limit length
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

// Handle unsubscribe requests
async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  
  // GET request - show unsubscribe page
  if (request.method === 'GET') {
    const email = url.searchParams.get('email');
    const token = url.searchParams.get('token');
    
    if (!email || !token) {
      return new Response(getUnsubscribePage('error', 'Invalid unsubscribe link'), {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    return new Response(getUnsubscribePage('confirm', email, token), {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // POST request - process unsubscribe
  if (request.method === 'POST') {
    try {
      const formData = await request.formData();
      const email = formData.get('email');
      const token = formData.get('token');
      const reason = formData.get('reason') || 'User requested';
      
      if (!email || !token) {
        return new Response(getUnsubscribePage('error', 'Missing required fields'), {
          status: 400,
          headers: { 'Content-Type': 'text/html' }
        });
      }
      
      // Forward to Google Apps Script
      if (env.GOOGLE_SCRIPT_URL) {
        const gasResponse = await fetch(env.GOOGLE_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'unsubscribe',
            email: email,
            token: token,
            reason: reason
          })
        });
        
        const result = await gasResponse.json();
        
        if (result.success) {
          return new Response(getUnsubscribePage('success', email), {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
          });
        } else {
          return new Response(getUnsubscribePage('error', result.error || 'Failed to unsubscribe'), {
            status: 400,
            headers: { 'Content-Type': 'text/html' }
          });
        }
      }
      
      return new Response(getUnsubscribePage('error', 'Service unavailable'), {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      });
      
    } catch (error) {
      console.error('Unsubscribe error:', error);
      return new Response(getUnsubscribePage('error', 'Something went wrong'), {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      });
    }
  }
  
  return new Response('Method not allowed', { status: 405 });
}

// Generate unsubscribe HTML page
function getUnsubscribePage(status, emailOrMessage, token = '') {
  const baseStyles = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #171717; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
      .container { max-width: 480px; width: 100%; text-align: center; }
      .card { background: #262626; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
      .logo { font-size: 24px; font-weight: bold; color: #E6C200; margin-bottom: 24px; }
      h1 { font-size: 28px; margin-bottom: 16px; }
      p { color: #a3a3a3; line-height: 1.6; margin-bottom: 24px; }
      .email { color: #E6C200; font-weight: 600; }
      .btn { display: inline-block; padding: 14px 32px; border-radius: 50px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; font-size: 16px; transition: all 0.2s; }
      .btn-primary { background: #E6C200; color: #171717; }
      .btn-primary:hover { background: #CCA800; }
      .btn-secondary { background: transparent; border: 2px solid #525252; color: #fff; margin-left: 12px; }
      .btn-secondary:hover { border-color: #737373; }
      .success-icon { font-size: 48px; margin-bottom: 16px; }
      .error-icon { font-size: 48px; margin-bottom: 16px; }
      textarea { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #404040; background: #1a1a1a; color: #fff; font-family: inherit; font-size: 14px; resize: vertical; min-height: 80px; margin-bottom: 20px; }
      textarea:focus { outline: none; border-color: #E6C200; }
      input[type="hidden"] { display: none; }
      form { margin-top: 20px; }
      .actions { display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }
      a { color: #E6C200; }
    </style>
  `;
  
  if (status === 'confirm') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribe - Studio X Wrestling</title>
  ${baseStyles}
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">Studio X Wrestling</div>
      <h1>Unsubscribe</h1>
      <p>You're about to unsubscribe <span class="email">${emailOrMessage}</span> from Studio X Wrestling emails.</p>
      <form method="POST" action="/api/unsubscribe">
        <input type="hidden" name="email" value="${emailOrMessage}">
        <input type="hidden" name="token" value="${token}">
        <textarea name="reason" placeholder="Optional: Let us know why you're leaving (helps us improve)"></textarea>
        <div class="actions">
          <button type="submit" class="btn btn-primary">Unsubscribe</button>
          <a href="https://studiox.fit" class="btn btn-secondary">Cancel</a>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
  }
  
  if (status === 'success') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed - Studio X Wrestling</title>
  ${baseStyles}
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">Studio X Wrestling</div>
      <div class="success-icon">✓</div>
      <h1>You're Unsubscribed</h1>
      <p>We've removed <span class="email">${emailOrMessage}</span> from our mailing list. You won't receive any more emails from us.</p>
      <p>Changed your mind? You can always <a href="https://studiox.fit/contact/">contact us</a> again.</p>
      <a href="https://studiox.fit" class="btn btn-primary">Back to Website</a>
    </div>
  </div>
</body>
</html>`;
  }
  
  // Error state
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Studio X Wrestling</title>
  ${baseStyles}
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">Studio X Wrestling</div>
      <div class="error-icon">⚠</div>
      <h1>Something Went Wrong</h1>
      <p>${emailOrMessage}</p>
      <p>If you continue having issues, please <a href="https://www.instagram.com/studioxwrestling/">DM us on Instagram</a>.</p>
      <a href="https://studiox.fit" class="btn btn-primary">Back to Website</a>
    </div>
  </div>
</body>
</html>`;
}
