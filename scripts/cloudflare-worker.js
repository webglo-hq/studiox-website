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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
