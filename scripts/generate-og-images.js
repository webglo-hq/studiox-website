/**
 * Studio X Wrestling - OG Image Generator
 * Generates Open Graph images for blog posts using Gemini AI
 * 
 * Usage: node scripts/generate-og-images.js [--force]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Configuration
const CONFIG = {
  postsDir: '_posts',
  outputDir: 'assets/images/og',
  imageWidth: 1200,
  imageHeight: 630,
  geminiApiKey: 'AIzaSyAtZCIn4OyakDS31DQuzf6tdvCJam1XgKA'
};

/**
 * Make HTTPS request (promise wrapper)
 */
function httpsRequest(url, options, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Generate image using Gemini API
 */
async function generateWithGemini(title, category) {
  const prompt = `Create a bold, professional sports marketing image for a wrestling blog article titled "${title}". 
Style: Modern athletic brand aesthetic, dramatic lighting, high contrast.
Color scheme: Deep charcoal black (#171717) background with vibrant gold/yellow (#E6C200) accents.
Subject: Dynamic wrestling or grappling action - could show wrestlers in competitive stance, a dramatic mat scene, or athletic silhouettes.
Mood: Powerful, competitive, elite sports training.
DO NOT include any text, words, letters, or typography in the image.
Aspect ratio: 16:9 widescreen format.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${CONFIG.geminiApiKey}`;
  
  const requestBody = JSON.stringify({
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      responseModalities: ["image", "text"]
    }
  });

  try {
    console.log('  🤖 Calling Gemini API...');
    
    const response = await httpsRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, requestBody);

    if (response.status !== 200) {
      console.log(`  ⚠️ API returned status ${response.status}`);
      if (response.data.error) {
        console.log(`  Error: ${response.data.error.message}`);
      }
      return null;
    }

    // Extract image data from response
    const candidates = response.data.candidates;
    if (candidates && candidates[0] && candidates[0].content && candidates[0].content.parts) {
      for (const part of candidates[0].content.parts) {
        if (part.inlineData && part.inlineData.mimeType.startsWith('image/')) {
          return {
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType
          };
        }
      }
    }
    
    console.log('  ⚠️ No image in response');
    return null;
  } catch (error) {
    console.log(`  ⚠️ API error: ${error.message}`);
    return null;
  }
}

/**
 * Parse front matter from a markdown file
 */
function parseFrontMatter(content) {
  // Normalize line endings
  content = content.replace(/\r\n/g, '\n');
  
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  
  const frontMatter = {};
  const lines = match[1].split('\n');
  
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontMatter[key] = value;
    }
  }
  
  return frontMatter;
}

/**
 * Create a branded OG image using SVG template (fallback)
 * This generates a simple branded placeholder
 */
function createFallbackSVG(title, category) {
  const truncatedTitle = title.length > 60 ? title.substring(0, 57) + '...' : title;
  const lines = [];
  
  // Simple word wrap
  const words = truncatedTitle.split(' ');
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).length > 25) {
      lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine += ' ' + word;
    }
  }
  if (currentLine) lines.push(currentLine.trim());
  
  const textLines = lines.slice(0, 3).map((line, i) => 
    `<text x="60" y="${280 + i * 60}" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="white">${escapeXml(line)}</text>`
  ).join('\n');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#171717"/>
      <stop offset="100%" style="stop-color:#262626"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#E6C200"/>
      <stop offset="100%" style="stop-color:#FFD700"/>
    </linearGradient>
  </defs>
  
  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>
  
  <!-- Decorative elements -->
  <circle cx="1100" cy="100" r="200" fill="#E6C200" opacity="0.1"/>
  <circle cx="100" cy="530" r="150" fill="#2563EB" opacity="0.1"/>
  
  <!-- Top accent bar -->
  <rect x="0" y="0" width="1200" height="8" fill="url(#accent)"/>
  
  <!-- Category tag -->
  <rect x="60" y="180" width="${(category || 'Wrestling').length * 12 + 30}" height="36" rx="18" fill="#E6C200"/>
  <text x="75" y="205" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#171717" text-transform="uppercase">${escapeXml((category || 'WRESTLING').toUpperCase())}</text>
  
  <!-- Title -->
  ${textLines}
  
  <!-- Logo area -->
  <text x="60" y="560" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#E6C200">Studio X Wrestling</text>
  <text x="60" y="590" font-family="Arial, sans-serif" font-size="16" fill="#a3a3a3">studiox.fit</text>
  
  <!-- Wrestling icon -->
  <g transform="translate(1040, 480)">
    <circle cx="50" cy="50" r="50" fill="#E6C200" opacity="0.2"/>
    <text x="50" y="65" font-size="40" text-anchor="middle">🤼</text>
  </g>
</svg>`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Process all blog posts and generate OG images
 */
async function processAllPosts() {
  console.log('🎨 Starting OG Image Generation with Gemini AI...\n');
  
  // Ensure output directory exists
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    console.log(`📁 Created output directory: ${CONFIG.outputDir}\n`);
  }
  
  // Read all posts
  const posts = fs.readdirSync(CONFIG.postsDir)
    .filter(f => f.endsWith('.md') || f.endsWith('.markdown'));
  
  console.log(`📝 Found ${posts.length} posts to process\n`);
  
  for (const postFile of posts) {
    const postPath = path.join(CONFIG.postsDir, postFile);
    const content = fs.readFileSync(postPath, 'utf-8');
    const frontMatter = parseFrontMatter(content);
    
    // Generate output filename from post filename
    const slug = postFile.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.(md|markdown)$/, '');
    const pngPath = path.join(CONFIG.outputDir, `${slug}.png`);
    const svgPath = path.join(CONFIG.outputDir, `${slug}.svg`);
    
    // Check if image already exists (check both png and svg)
    if ((fs.existsSync(pngPath) || fs.existsSync(svgPath)) && !process.argv.includes('--force')) {
      console.log(`⏭️  Skipping ${slug} (already exists)`);
      continue;
    }
    
    console.log(`🖼️  Generating image for: ${frontMatter.title || slug}`);
    
    // Try Gemini API first
    const geminiImage = await generateWithGemini(
      frontMatter.title || slug,
      frontMatter.categories || frontMatter.category
    );
    
    if (geminiImage) {
      // Save AI-generated image
      const ext = geminiImage.mimeType === 'image/png' ? '.png' : '.jpg';
      const outputPath = path.join(CONFIG.outputDir, `${slug}${ext}`);
      fs.writeFileSync(outputPath, Buffer.from(geminiImage.data, 'base64'));
      console.log(`  ✅ Saved AI image: ${outputPath}`);
      
      // Update post front matter
      updatePostFrontMatter(postPath, `/assets/images/og/${slug}${ext}`);
    } else {
      // Fallback to SVG template
      console.log('  📝 Using SVG fallback...');
      const svg = createFallbackSVG(
        frontMatter.title || slug,
        frontMatter.categories || frontMatter.category
      );
      fs.writeFileSync(svgPath, svg);
      console.log(`  ✅ Saved fallback: ${svgPath}`);
      
      // Update post front matter
      updatePostFrontMatter(postPath, `/assets/images/og/${slug}.svg`);
    }
    
    // Small delay between API calls to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n✨ OG Image generation complete!');
}

/**
 * Update post front matter with OG image path
 */
function updatePostFrontMatter(postPath, imagePath) {
  let content = fs.readFileSync(postPath, 'utf-8');
  // Normalize line endings for matching
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const frontMatterMatch = normalizedContent.match(/^---\n([\s\S]*?)\n---/);
  
  if (!frontMatterMatch) return;
  
  let frontMatter = frontMatterMatch[1];
  
  // Check if og_image already exists
  if (frontMatter.includes('og_image:')) {
    // Update existing
    frontMatter = frontMatter.replace(/og_image:.*/, `og_image: "${imagePath}"`);
  } else {
    // Add new
    frontMatter += `\nog_image: "${imagePath}"`;
  }
  
  // Rebuild content with normalized endings then restore original
  const newContent = normalizedContent.replace(/^---\n[\s\S]*?\n---/, `---\n${frontMatter}\n---`);
  fs.writeFileSync(postPath, newContent);
}

// Run the generator
processAllPosts().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
