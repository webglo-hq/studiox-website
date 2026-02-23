/**
 * Studio X Wrestling - Contact Form Handler & CRM
 * 
 * SETUP INSTRUCTIONS:
 * 1. Go to Google Apps Script (https://script.google.com)
 * 2. Create a new project named "StudioX Form Handler"
 * 3. Copy and paste this entire script
 * 4. Run the `setup()` function once to create the spreadsheet
 * 5. Deploy as Web App:
 *    - Click Deploy > New deployment
 *    - Select type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    - Click Deploy and copy the URL
 * 6. Use the deployment URL in your Cloudflare Worker
 */

// ============================================
// CONFIGURATION - Update these values
// ============================================
const CONFIG = {
  // Business owner email for notifications
  OWNER_EMAIL: 'info@studiox.fit',
  
  // Spreadsheet name (will be created on setup)
  SPREADSHEET_NAME: 'StudioX CRM - Contact Form Submissions',
  
  // Email templates
  BUSINESS_NAME: 'Studio X Wrestling',
  WEBSITE_URL: 'https://studiox.fit',
  INSTAGRAM_URL: 'https://www.instagram.com/studioxwrestling/',
  ADDRESS: 'Cellar (Lower Level - Below JoJu), 83-27 Broadway, Elmhurst, NY 11373'
};

// ============================================
// SETUP FUNCTION - Run this once!
// ============================================
function setup() {
  // Create the spreadsheet
  const spreadsheet = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
  const sheet = spreadsheet.getActiveSheet();
  sheet.setName('Leads');
  
  // Set up headers
  const headers = [
    'Timestamp',
    'Name',
    'Email',
    'Phone',
    'Interest',
    'Message',
    'Marketing Consent',
    'Source',
    'Status',
    'Notes',
    'Follow-up Date'
  ];
  
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  
  // Format header row
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#f4c542'); // Primary yellow
  headerRange.setFontColor('#171717');
  
  // Set column widths
  sheet.setColumnWidth(1, 160);  // Timestamp
  sheet.setColumnWidth(2, 150);  // Name
  sheet.setColumnWidth(3, 200);  // Email
  sheet.setColumnWidth(4, 130);  // Phone
  sheet.setColumnWidth(5, 130);  // Interest
  sheet.setColumnWidth(6, 300);  // Message
  sheet.setColumnWidth(7, 120);  // Marketing Consent
  sheet.setColumnWidth(8, 100);  // Source
  sheet.setColumnWidth(9, 100);  // Status
  sheet.setColumnWidth(10, 200); // Notes
  sheet.setColumnWidth(11, 120); // Follow-up Date
  
  // Freeze header row
  sheet.setFrozenRows(1);
  
  // Add data validation for Status column
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['New', 'Contacted', 'Scheduled', 'Converted', 'Not Interested', 'Follow Up'])
    .setAllowInvalid(false)
    .build();
  sheet.getRange('I2:I1000').setDataValidation(statusRule);
  
  // Create a Marketing List sheet
  const marketingSheet = spreadsheet.insertSheet('Marketing List');
  marketingSheet.getRange(1, 1, 1, 4).setValues([['Name', 'Email', 'Date Added', 'Source']]);
  marketingSheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#f4c542');
  
  // Create a Dashboard sheet
  const dashboardSheet = spreadsheet.insertSheet('Dashboard');
  dashboardSheet.getRange('A1').setValue('Studio X CRM Dashboard');
  dashboardSheet.getRange('A1').setFontSize(18).setFontWeight('bold');
  
  // Add summary formulas
  dashboardSheet.getRange('A3').setValue('Total Leads:');
  dashboardSheet.getRange('B3').setFormula('=COUNTA(Leads!A:A)-1');
  
  dashboardSheet.getRange('A4').setValue('New Leads:');
  dashboardSheet.getRange('B4').setFormula('=COUNTIF(Leads!I:I,"New")');
  
  dashboardSheet.getRange('A5').setValue('Converted:');
  dashboardSheet.getRange('B5').setFormula('=COUNTIF(Leads!I:I,"Converted")');
  
  dashboardSheet.getRange('A6').setValue('Marketing Opt-ins:');
  dashboardSheet.getRange('B6').setFormula('=COUNTIF(Leads!G:G,"Yes")');
  
  // Move dashboard to first position
  spreadsheet.setActiveSheet(dashboardSheet);
  spreadsheet.moveActiveSheet(1);
  
  // Store the spreadsheet ID for the web app
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty('SPREADSHEET_ID', spreadsheet.getId());
  
  // Log success message
  Logger.log('✅ Setup complete!');
  Logger.log('📊 Spreadsheet created: ' + spreadsheet.getUrl());
  Logger.log('🔑 Spreadsheet ID: ' + spreadsheet.getId());
  
  // Return info for the user
  return {
    success: true,
    spreadsheetUrl: spreadsheet.getUrl(),
    spreadsheetId: spreadsheet.getId(),
    message: 'CRM spreadsheet created successfully! Check your Google Drive.'
  };
}

// ============================================
// WEB APP ENDPOINT - Handles form submissions
// ============================================
function doPost(e) {
  try {
    // Parse the incoming data
    const data = JSON.parse(e.postData.contents);
    
    // Get the spreadsheet
    const scriptProperties = PropertiesService.getScriptProperties();
    const spreadsheetId = scriptProperties.getProperty('SPREADSHEET_ID');
    
    if (!spreadsheetId) {
      throw new Error('Spreadsheet not found. Please run setup() first.');
    }
    
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const leadsSheet = spreadsheet.getSheetByName('Leads');
    
    // Prepare row data
    const timestamp = new Date();
    const rowData = [
      timestamp,
      data.name || '',
      data.email || '',
      data.phone || '',
      data.interest || '',
      data.message || '',
      data.marketing_consent === 'yes' ? 'Yes' : 'No',
      data.source || 'Website Form',
      'New',
      '',
      ''
    ];
    
    // Append to spreadsheet
    leadsSheet.appendRow(rowData);
    
    // If marketing consent given, add to marketing list
    if (data.marketing_consent === 'yes') {
      const marketingSheet = spreadsheet.getSheetByName('Marketing List');
      marketingSheet.appendRow([
        data.name || '',
        data.email || '',
        timestamp,
        'Contact Form'
      ]);
    }
    
    // Send email notifications
    sendNotifications(data);
    
    // Return success response
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: 'Form submitted successfully'
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    Logger.log('Error: ' + error.message);
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Handle GET requests (for testing)
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Studio X Form Handler is running',
    setup_required: !PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
  })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// EMAIL NOTIFICATIONS
// ============================================
function sendNotifications(data) {
  // Send notification to business owner
  sendOwnerNotification(data);
  
  // Send confirmation to the visitor
  sendVisitorConfirmation(data);
}

function sendOwnerNotification(data) {
  const subject = `🤼 New Lead: ${data.name} - ${data.interest || 'General Inquiry'}`;
  
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f4c542 0%, #ffd700 100%); padding: 20px; text-align: center;">
        <h1 style="margin: 0; color: #171717; font-size: 24px;">New Contact Form Submission</h1>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee; font-weight: bold; width: 120px;">Name:</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee;">${data.name || 'Not provided'}</td>
          </tr>
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee; font-weight: bold;">Email:</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee;">
              <a href="mailto:${data.email}" style="color: #0066cc;">${data.email || 'Not provided'}</a>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee; font-weight: bold;">Phone:</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee;">
              ${data.phone ? `<a href="tel:${data.phone}" style="color: #0066cc;">${data.phone}</a>` : 'Not provided'}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee; font-weight: bold;">Interest:</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee;">${formatInterest(data.interest)}</td>
          </tr>
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee; font-weight: bold;">Marketing:</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #eee;">
              ${data.marketing_consent === 'yes' ? '✅ Opted in' : '❌ Not opted in'}
            </td>
          </tr>
        </table>
        
        <div style="margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 8px;">
          <h3 style="margin: 0 0 10px 0; color: #171717;">Message:</h3>
          <p style="margin: 0; color: #333; line-height: 1.6;">${data.message || 'No message provided'}</p>
        </div>
        
        <div style="margin-top: 30px; text-align: center;">
          <a href="mailto:${data.email}?subject=Re: Your inquiry to Studio X Wrestling" 
             style="display: inline-block; padding: 12px 30px; background: #f4c542; color: #171717; 
                    text-decoration: none; border-radius: 25px; font-weight: bold;">
            Reply to ${data.name?.split(' ')[0] || 'Lead'}
          </a>
        </div>
      </div>
      
      <div style="padding: 20px; background: #171717; text-align: center;">
        <p style="margin: 0; color: #888; font-size: 12px;">
          This lead was captured from the Studio X Wrestling website contact form.
        </p>
      </div>
    </div>
  `;
  
  const plainBody = `
New Contact Form Submission

Name: ${data.name || 'Not provided'}
Email: ${data.email || 'Not provided'}
Phone: ${data.phone || 'Not provided'}
Interest: ${formatInterest(data.interest)}
Marketing Consent: ${data.marketing_consent === 'yes' ? 'Yes' : 'No'}

Message:
${data.message || 'No message provided'}

---
Reply to: ${data.email}
  `;
  
  GmailApp.sendEmail(CONFIG.OWNER_EMAIL, subject, plainBody, {
    htmlBody: htmlBody,
    name: 'Studio X Website'
  });
}

function sendVisitorConfirmation(data) {
  if (!data.email) return;
  
  const subject = `Thanks for reaching out, ${data.name?.split(' ')[0] || 'wrestler'}! 🤼`;
  
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f4c542 0%, #ffd700 100%); padding: 30px; text-align: center;">
        <h1 style="margin: 0; color: #171717; font-size: 28px;">Studio X Wrestling</h1>
        <p style="margin: 10px 0 0; color: #333; font-size: 16px;">Elite Training in Queens, NY</p>
      </div>
      
      <div style="padding: 30px; background: #ffffff;">
        <h2 style="margin: 0 0 20px; color: #171717;">Hey ${data.name?.split(' ')[0] || 'there'}! 👋</h2>
        
        <p style="color: #333; line-height: 1.6;">
          Thanks for reaching out to Studio X Wrestling! We got your message and will get back to you 
          within 24 hours (usually much faster).
        </p>
        
        <div style="margin: 30px 0; padding: 20px; background: linear-gradient(135deg, #f4c542 0%, #ffd700 100%); 
                    border-radius: 12px; text-align: center;">
          <h3 style="margin: 0 0 10px; color: #171717;">🎁 Remember: Your First Class is FREE!</h3>
          <p style="margin: 0; color: #333;">No commitment, no pressure — just show up and train.</p>
        </div>
        
        <p style="color: #333; line-height: 1.6;">
          <strong>Here's what happens next:</strong>
        </p>
        <ol style="color: #333; line-height: 1.8;">
          <li>One of our coaches will review your message</li>
          <li>We'll reach out to schedule your free session</li>
          <li>Come train with us and see what Studio X is all about!</li>
        </ol>
        
        <p style="color: #333; line-height: 1.6;">
          <strong>Need a faster response?</strong> DM us on Instagram — we're pretty quick there!
        </p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${CONFIG.INSTAGRAM_URL}" 
             style="display: inline-block; padding: 12px 30px; background: #171717; color: #fff; 
                    text-decoration: none; border-radius: 25px; font-weight: bold;">
            📱 DM Us on Instagram
          </a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        
        <p style="color: #666; font-size: 14px;">
          <strong>📍 Find us at:</strong><br>
          ${CONFIG.ADDRESS}<br>
          <a href="https://maps.google.com/?q=83-27+Broadway+Elmhurst+NY+11373" style="color: #0066cc;">Get directions →</a>
        </p>
      </div>
      
      <div style="padding: 20px; background: #171717; text-align: center;">
        <p style="margin: 0 0 10px; color: #f4c542; font-weight: bold;">Studio X Wrestling</p>
        <p style="margin: 0; color: #888; font-size: 12px;">
          Elite wrestling and grappling training in Elmhurst, Queens, NY
        </p>
        <p style="margin: 10px 0 0; color: #666; font-size: 11px;">
          You received this email because you submitted a contact form on our website.
        </p>
      </div>
    </div>
  `;
  
  const plainBody = `
Hey ${data.name?.split(' ')[0] || 'there'}!

Thanks for reaching out to Studio X Wrestling! We got your message and will get back to you within 24 hours.

🎁 REMINDER: Your First Class is FREE! No commitment, no pressure — just show up and train.

What happens next:
1. One of our coaches will review your message
2. We'll reach out to schedule your free session
3. Come train with us!

Need a faster response? DM us on Instagram: ${CONFIG.INSTAGRAM_URL}

📍 Find us at:
${CONFIG.ADDRESS}

See you on the mat!
- Studio X Wrestling Team
  `;
  
  GmailApp.sendEmail(data.email, subject, plainBody, {
    htmlBody: htmlBody,
    name: CONFIG.BUSINESS_NAME,
    replyTo: CONFIG.OWNER_EMAIL
  });
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function formatInterest(interest) {
  const interestMap = {
    'private': 'Private Sessions',
    'group': 'Group Classes',
    'competition': 'Competition Prep',
    'bjj': 'Wrestling for BJJ',
    'team': 'Team Clinic/Seminar',
    'other': 'Other'
  };
  return interestMap[interest] || interest || 'Not specified';
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Get spreadsheet URL (useful for checking if setup was done)
function getSpreadsheetUrl() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProperties.getProperty('SPREADSHEET_ID');
  
  if (!spreadsheetId) {
    Logger.log('Spreadsheet not found. Please run setup() first.');
    return null;
  }
  
  const url = 'https://docs.google.com/spreadsheets/d/' + spreadsheetId;
  Logger.log('Spreadsheet URL: ' + url);
  return url;
}

// Test the email sending (sends to owner email)
function testEmails() {
  const testData = {
    name: 'Test User',
    email: CONFIG.OWNER_EMAIL, // Send test to yourself
    phone: '555-123-4567',
    interest: 'group',
    message: 'This is a test submission to verify email notifications are working.',
    marketing_consent: 'yes'
  };
  
  sendNotifications(testData);
  Logger.log('Test emails sent to: ' + CONFIG.OWNER_EMAIL);
}
