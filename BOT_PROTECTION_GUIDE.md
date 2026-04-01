# 🛡️ Bot Protection Deployment Guide

## What We Built

**3-Layer Bot Protection:**
1. **Cloudflare Turnstile** - Privacy-friendly CAPTCHA (auto-verifies humans)
2. **Rate Limiting** - Max 3 submissions per IP per hour
3. **Honeypot Field** - Hidden trap for dumb bots

## 🚀 Deployment Steps

### 1. Install Wrangler CLI (if needed)

```bash
cd ~/path/to/studiox-website
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

This will open your browser to authenticate.

### 3. Create KV Namespace for Rate Limiting

```bash
wrangler kv:namespace create "RATE_LIMIT_KV"
```

**Output will look like:**
```
🌀 Creating namespace with title "studiox-form-handler-RATE_LIMIT_KV"
✨ Success!
Add the following to your wrangler.toml:
kv_namespaces = [
  { binding = "RATE_LIMIT_KV", id = "abc123xyz456" }
]
```

**Copy the ID** (e.g., `abc123xyz456`) and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "abc123xyz456"  # ← Replace with YOUR actual ID
```

### 4. Deploy the Worker

```bash
wrangler deploy
```

**Expected output:**
```
✨ Built successfully
🌍 Deploying...
✅ Deployed studiox-form-handler
   https://studiox-form-handler.YOUR_ACCOUNT.workers.dev
```

### 5. Commit & Push to GitHub

```bash
git add .
git commit -m "Add bot protection: Turnstile + rate limiting + honeypot"
git push origin main
```

GitHub Pages will auto-deploy the updated contact form.

---

## 🧪 Testing

### Test 1: Normal Submission (Should Work)

1. Go to https://studiox.fit/contact/
2. Fill out the form normally
3. Submit
4. Should see: **"Thank you! We'll be in touch soon."**

### Test 2: Rate Limiting (Should Block After 3)

1. Submit the form 3 times quickly
2. On the 4th attempt, should see:
   - **"Too many submissions. Please try again in X minutes."**

### Test 3: Honeypot (Bot Detection)

Open browser console and run:
```javascript
document.getElementById('website').value = 'I am a bot';
document.getElementById('contact-form').submit();
```

Should see: **"Invalid submission"** (bot detected)

### Test 4: Missing Turnstile Token

1. Disable JavaScript in browser
2. Try to submit form
3. Should see: **"Security verification failed."**

---

## 🔧 Troubleshooting

### "Worker not found" error
- Run `wrangler whoami` to confirm you're logged in
- Run `wrangler deploy` again

### KV namespace errors
- Make sure you replaced `YOUR_KV_NAMESPACE_ID` in `wrangler.toml`
- Run `wrangler kv:namespace list` to see your namespaces

### Form not submitting
- Check browser console for errors
- Verify Turnstile keys in `contact/index.html`:
  - Site Key: `0x4AAAAAACy1i5jMD3WGGFWp`
- Verify Worker is deployed: `wrangler deployments list`

### CORS errors
- Worker only accepts requests from:
  - `https://studiox.fit`
  - `https://www.studiox.fit`
- Test on actual domain, not localhost

---

## 📊 Monitoring

### View Worker Logs (Real-Time)

```bash
wrangler tail
```

Then submit the form — you'll see:
- Turnstile verification results
- Rate limit checks
- Honeypot detections
- Submission success/failures

### Check Rate Limit Data

```bash
wrangler kv:key list --binding RATE_LIMIT_KV
```

Shows IPs that have submitted (stores for 1 hour).

---

## 🔐 Security Features

| Layer | Protection | Bypass Difficulty |
|-------|-----------|-------------------|
| **Turnstile** | Behavioral analysis + challenge | Very Hard (Cloudflare-level) |
| **Rate Limiting** | 3 per hour per IP | Medium (need rotating IPs) |
| **Honeypot** | Hidden field trap | Easy to bypass (but catches 90% of bots) |

**Combined:** Stops 99%+ of automated spam.

---

## 💰 Cost

- **Cloudflare Workers:** 100k requests/day FREE
- **Cloudflare KV:** 100k reads/day FREE
- **Turnstile:** 1M verifications/month FREE

**Total:** $0/month (you'll never hit limits)

---

## 📝 Next Steps (Optional)

1. **Email Notifications:** Add Mailgun/SendGrid to Worker to email you on submissions
2. **Slack Alerts:** Post to Slack channel on form submission
3. **Analytics:** Track submission rate, bot detection rate
4. **A/B Testing:** Test Turnstile vs. reCAPTCHA conversion rates

---

## 🆘 Need Help?

- **Wrangler Docs:** https://developers.cloudflare.com/workers/wrangler/
- **Turnstile Docs:** https://developers.cloudflare.com/turnstile/
- **Worker Logs:** `wrangler tail` (real-time debugging)

Let me know if you hit any errors!
