import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename?: string;
    content?: Buffer | string;
    path?: string;
    contentType?: string;
  }>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST', 'smtp.gmail.com'),
      port: this.configService.get<number>('SMTP_PORT', 587),
      secure: this.configService.get<boolean>('SMTP_SECURE', false), // true for 465, false for other ports
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASSWORD'),
      },
    });
  }

  /**
   * Extract email addresses from text using regex
   */
  extractEmails(text: string): string[] {
    if (!text) return [];
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = text.match(emailRegex) || [];
    // Remove duplicates
    return [...new Set(emails)];
  }

  /**
   * Send email using SMTP
   */
  async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      const fromEmail = this.configService.get<string>(
        'SMTP_USER',
        'ericshin8134@gmail.com',
      );
      const fromName = this.configService.get<string>(
        'SMTP_FROM_NAME',
        'Job Application System',
      );

      const mailOptions: nodemailer.SendMailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html || options.text,
        attachments: options.attachments,
      };

      const info = await this.transporter.sendMail(mailOptions);
      this.logger.log(
        `Email sent successfully to ${options.to}: ${info.messageId}`,
      );
      return true;
    } catch (error) {
      this.logger.error(`Failed to send email to ${options.to}:`, error);
      return false;
    }
  }

  /**
   * Send job application email
   */
  async sendApplicationEmail(
    toEmail: string,
    jobTitle: string,
    applicantEmail: string,
    applicantName?: string,
    attachments?: Array<{
      filename?: string;
      content?: Buffer | string;
      path?: string;
      contentType?: string;
    }>,
  ): Promise<boolean> {
    const subject = `Job Application: ${jobTitle}`;
    const applicantDisplayName = applicantName || applicantEmail;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f4f4f4;
    }
    .container {
      background-color: #ffffff;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      border-radius: 8px 8px 0 0;
      margin: -30px -30px 30px -30px;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
    }
    .content {
      margin: 20px 0;
    }
    .info-box {
      background-color: #f8f9fa;
      border-left: 4px solid #667eea;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .info-item {
      margin: 10px 0;
    }
    .info-label {
      font-weight: bold;
      color: #667eea;
      display: inline-block;
      width: 100px;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      color: #666;
      font-size: 14px;
    }
    .signature {
      margin-top: 20px;
      color: #333;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📧 Job Application</h1>
    </div>
    <div class="content">
      <p>Dear Hiring Manager,</p>
      <p>I am writing to express my interest in the <strong>${jobTitle}</strong> position.</p>
      
      <div class="info-box">
        <div class="info-item">
          <span class="info-label">Position:</span>
          <span>${jobTitle}</span>
        </div>
        ${
          applicantName
            ? `<div class="info-item">
          <span class="info-label">Name:</span>
          <span>${applicantName}</span>
        </div>`
            : ''
        }
        <div class="info-item">
          <span class="info-label">Email:</span>
          <span><a href="mailto:${applicantEmail}">${applicantEmail}</a></span>
        </div>
      </div>

      <p>I would be grateful for the opportunity to discuss how my skills and experience align with your requirements.</p>
      
      <div class="signature">
        <p>Best regards,<br>
        <strong>${applicantDisplayName}</strong></p>
      </div>
    </div>
    <div class="footer">
      <p>This email was sent through the Job Application System.</p>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
Dear Hiring Manager,

I am writing to express my interest in the ${jobTitle} position.

${applicantName ? `Name: ${applicantName}` : ''}
Email: ${applicantEmail}

I would be grateful for the opportunity to discuss how my skills and experience align with your requirements.

Best regards,
${applicantDisplayName}
    `.trim();

    return this.sendEmail({
      to: toEmail,
      subject,
      text,
      html,
      attachments,
    });
  }

  /**
   * Send confirmation email to applicant
   */
  async sendConfirmationEmail(
    applicantEmail: string,
    jobTitle: string,
    recipientEmail: string,
  ): Promise<boolean> {
    const subject = 'Confirmation: Your Job Application Has Been Sent';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f4f4f4;
    }
    .container {
      background-color: #ffffff;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
      color: white;
      padding: 20px;
      border-radius: 8px 8px 0 0;
      margin: -30px -30px 30px -30px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
    }
    .success-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }
    .content {
      margin: 20px 0;
    }
    .info-box {
      background-color: #f0f9ff;
      border-left: 4px solid #11998e;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .info-item {
      margin: 10px 0;
    }
    .info-label {
      font-weight: bold;
      color: #11998e;
      display: inline-block;
      width: 120px;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      color: #666;
      font-size: 14px;
      text-align: center;
    }
    .button {
      display: inline-block;
      padding: 12px 24px;
      background-color: #11998e;
      color: white;
      text-decoration: none;
      border-radius: 5px;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="success-icon">✅</div>
      <h1>Application Confirmed</h1>
    </div>
    <div class="content">
      <p>Dear Applicant,</p>
      <p>This is a confirmation that your job application has been <strong>successfully sent</strong>.</p>
      
      <div class="info-box">
        <div class="info-item">
          <span class="info-label">Position:</span>
          <span>${jobTitle}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Sent to:</span>
          <span>${recipientEmail}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Date:</span>
          <span>${new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}</span>
        </div>
      </div>

      <p>We will notify you if there are any updates regarding your application.</p>
      
      <p>Thank you for your interest!</p>
    </div>
    <div class="footer">
      <p>This is an automated confirmation email from the Job Application System.</p>
      <p style="margin-top: 10px; color: #999; font-size: 12px;">
        If you have any questions, please contact the hiring manager directly.
      </p>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
Dear Applicant,

This is a confirmation that your job application for "${jobTitle}" has been successfully sent to ${recipientEmail}.

Date: ${new Date().toLocaleString()}

We will notify you if there are any updates regarding your application.

Best regards,
Job Application System
    `.trim();

    return this.sendEmail({
      to: applicantEmail,
      subject,
      text,
      html,
    });
  }
}
