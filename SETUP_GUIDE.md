# Studio X Wrestling - Complete Setup Guide

This guide covers setting up the Studio X Wrestling website with GitHub Pages, Cloudflare DNS, form handling, and analytics.

## Table of Contents
1. [GitHub Pages Setup](#1-github-pages-setup)
2. [Cloudflare DNS Configuration](#2-cloudflare-dns-configuration)
3. [Google Apps Script CRM Setup](#3-google-apps-script-crm-setup)
4. [Cloudflare Worker Form Handler](#4-cloudflare-worker-form-handler)
5. [Google Analytics Configuration](#5-google-analytics-configuration)
6. [Testing Checklist](#6-testing-checklist)

---

## 1. GitHub Pages Setup

### Create Repository
1. Go to https://github.com/organizations/webglo/repositories/new
2. Repository name: `studiox-website` (or similar)
3. Make it **Public** (GitHub Pages free tier requires public repos for organizations)
4. Don't initialize with README (we have existing code)

### Push Code to GitHub
```powershell
# Navigate to the site directory
cd "g:\My Drive\Dev\studioxwrestling_site"

# Initialize git if not already done
git init

# Add the remote repository
git remote add origin https://github.com/webglo/studiox-website.git

# Create .gitignore if needed
# Add these to .gitignore:
# _site/
# .sass-cache/
# .jekyll-cache/
# .jekyll-metadata
# vendor/
# node_modules/
# Gemfile.lock (optional, for cross-platform compatibility)

# Stage all files
git add .

# Commit
git commit -m "Initial commit - Studio X Wrestling website"

# Push to GitHub
git push -u origin main
```

### Enable GitHub Pages
1. Go to repository **Settings** → **Pages**
2. Source: **GitHub Actions** (recommended for Jekyll)
3. Or use **Deploy from a branch** → select `main` branch

### GitHub Actions Workflow (Recommended)
Create `.github/workflows/jekyll.yml`:

```yaml
name: Deploy Jekyll site to Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      
      - name: Setup Ruby
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.1'
          bundler-cache: true
      
      - name: Setup Pages
        id: pages
        uses: actions/configure-pages@v4
      
      - name: Build with Jekyll
        run: bundle exec jekyll build --baseurl "${{ steps.pages.outputs.base_path }}"
        env:
          JEKYLL_ENV: production
      
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### Configure Custom Domain in GitHub
1. Go to **Settings** → **Pages**
2. Under "Custom domain", enter: `studiox.fit`
3. Check "Enforce HTTPS"
4. Save

---

## 2. Cloudflare DNS Configuration

### Login to Cloudflare
- Dashboard: https://dash.cloudflare.com
- Zone ID: `cf7bd144722f3440cf305e9de142513b`
- Account ID: `853d7d770df969437c1c8ccfef30a03f`

### Required DNS Records

Go to **DNS** → **Records** and add:

#### For Apex Domain (studiox.fit)
| Type | Name | Content | Proxy Status |
|------|------|---------|--------------|
| A | @ | 185.199.108.153 | Proxied (orange) |
| A | @ | 185.199.109.153 | Proxied (orange) |
| A | @ | 185.199.110.153 | Proxied (orange) |
| A | @ | 185.199.111.153 | Proxied (orange) |

#### For WWW Subdomain
| Type | Name | Content | Proxy Status |
|------|------|---------|--------------|
| CNAME | www | webglo.github.io | Proxied (orange) |

> Note: Replace `webglo.github.io` with your actual GitHub Pages domain if different.

### SSL/TLS Settings
1. Go to **SSL/TLS** → **Overview**
2. Set encryption mode to **Full (strict)**
3. Go to **SSL/TLS** → **Edge Certificates**
4. Enable **Always Use HTTPS**
5. Enable **Automatic HTTPS Rewrites**

### Page Rules (Optional but Recommended)
Go to **Rules** → **Page Rules**:

**Rule 1: Force WWW to non-WWW**
- URL: `www.studiox.fit/*`
- Setting: Forwarding URL (301)
- Destination: `https://studiox.fit/$1`

### Caching Rules
Go to **Caching** → **Configuration**:
- Browser Cache TTL: 1 month
- Caching Level: Standard

---

## 3. Google Apps Script CRM Setup

### Step 1: Create the Script
1. Go to https://script.google.com
2. Click **+ New project**
3. Name it: "StudioX Form Handler"
4. Delete the default code
5. Copy and paste the contents of `scripts/google-apps-script.js`

### Step 2: Update Configuration
In the script, update the `CONFIG` object:
```javascript
const CONFIG = {
  OWNER_EMAIL: 'your-actual-email@gmail.com', // Business owner email
  // ... rest stays the same
};
```

### Step 3: Run Setup
1. In the Apps Script editor, select function: `setup`
2. Click **Run**
3. Authorize when prompted (allow all permissions)
4. Check the execution log for the spreadsheet URL

### Step 4: Deploy as Web App
1. Click **Deploy** → **New deployment**
2. Click the gear icon → Select **Web app**
3. Configure:
   - Description: "Studio X Contact Form Handler v1"
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**
5. **COPY THE WEB APP URL** - you'll need this for the Cloudflare Worker

The URL will look like:
```
https://script.google.com/macros/s/AKfycb...../exec
```

### Step 5: Test
1. Run the `testEmails()` function to verify email sending works
2. Check that emails are received

---

## 4. Cloudflare Worker Form Handler

### Step 1: Create the Worker
1. Go to Cloudflare Dashboard → **Workers & Pages**
2. Click **Create** → **Create Worker**
3. Name: `studiox-form-handler`
4. Click **Deploy** (with default code)
5. Click **Edit code**
6. Replace all code with contents of `scripts/cloudflare-worker.js`
7. Click **Deploy**

### Step 2: Set Environment Variables
1. Go to **Workers & Pages** → `studiox-form-handler` → **Settings**
2. Click **Variables and Secrets** (or **Variables** tab)
3. Add these as **Environment Variables**:

| Variable Name | Value |
|--------------|-------|
| GOOGLE_SCRIPT_URL | Your Apps Script Web App URL from Step 3.4 |
| ALLOWED_ORIGINS | https://studiox.fit,https://www.studiox.fit |

### Step 3: Add Route
1. Go to **Workers & Pages** → `studiox-form-handler` → **Triggers**
2. Under **Routes**, click **Add route**
3. Add these routes:
   - Route: `studiox.fit/api/*` → Zone: `studiox.fit`
   - Route: `www.studiox.fit/api/*` → Zone: `studiox.fit`

### Step 4: Test
Visit: `https://studiox.fit/api/health`

Should return:
```json
{"status":"ok","timestamp":"...","service":"Studio X Form Handler"}
```

---

## 5. Google Analytics Configuration

The tracking code is already added to the site in `_includes/head.html`:
- Property ID: `G-3LW3FMPM3X`

### Recommended GA4 Configuration

#### 1. Set Up Conversions
Go to GA4 → **Configure** → **Events** → **Mark as conversion**:
- `form_submit` (when contact form is submitted)
- `page_view` (already tracked)

#### 2. Create Custom Events
In GA4 → **Configure** → **Events** → **Create event**:

**Contact Form View:**
- Name: `contact_form_view`
- Matching conditions: `page_location` contains `/contact/`

**Thank You Page:**
- Name: `form_submission_success`
- Matching conditions: `page_location` contains `/thank-you/`

#### 3. Set Up Audiences
Go to **Configure** → **Audiences**:

**Engaged Visitors:**
- Session duration > 60 seconds
- Page views > 2

**Contact Page Visitors:**
- Viewed /contact/ page

#### 4. Link Google Search Console
1. Go to **Admin** → **Product Links** → **Search Console**
2. Connect your verified Search Console property

#### 5. Enable Enhanced Measurement
Go to **Admin** → **Data Streams** → Your stream → **Enhanced measurement**:
- ✅ Page views
- ✅ Scrolls
- ✅ Outbound clicks
- ✅ Site search
- ✅ Form interactions

#### 6. Set Up Data Retention
Go to **Admin** → **Data Settings** → **Data Retention**:
- Set to 14 months (maximum for free GA4)

---

## 6. Testing Checklist

### DNS & SSL
- [ ] https://studiox.fit loads correctly
- [ ] https://www.studiox.fit redirects to https://studiox.fit
- [ ] SSL certificate is valid (padlock shows)
- [ ] No mixed content warnings

### Website
- [ ] Homepage loads with "First Class Free" banner
- [ ] Address shows correctly in footer
- [ ] Address shows correctly on contact page
- [ ] All navigation links work
- [ ] Mobile responsive design works

### Form Submission
- [ ] Contact form loads on /contact/
- [ ] Marketing consent checkbox is present and required
- [ ] Form submits successfully
- [ ] Redirects to /contact/thank-you/
- [ ] Business owner receives notification email
- [ ] Visitor receives confirmation email
- [ ] Lead appears in Google Sheets CRM

### Analytics
- [ ] Google Analytics Real-time shows visits
- [ ] Page views are being tracked
- [ ] Events are firing correctly

### Lighthouse Scores
Run Lighthouse audit on key pages:
- [ ] Homepage: Performance ≥ 90, Accessibility ≥ 95
- [ ] Contact page: Performance ≥ 90, Accessibility ≥ 95

---

## Quick Reference

| Service | Dashboard URL |
|---------|---------------|
| GitHub | https://github.com/webglo/studiox-website |
| Cloudflare | https://dash.cloudflare.com |
| Google Apps Script | https://script.google.com |
| Google Analytics | https://analytics.google.com |
| Google Sheets CRM | (URL from setup function) |

## Support

If you encounter issues:
1. Check Cloudflare Worker logs: **Workers** → `studiox-form-handler` → **Logs**
2. Check Apps Script logs: **Execution log** in Apps Script editor
3. Check GA4 Real-time reports for tracking issues
