import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  fromName?: string;
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
    // SMTP configuration - hardcoded in code (from .env)
    const smtpHost = 'smtp.gmail.com';
    const smtpPort = 587;
    const smtpSecure = false; // false for port 587 (STARTTLS)
    const smtpUser = 'ericshin8134@gmail.com'; // Replace with your Gmail address
    const smtpPassword = 'jefh dosi gdwo iych'; // Replace with your Gmail App Password

    // Log SMTP configuration (without password)
    this.logger.log(
      `SMTP Configuration: host=${smtpHost}, port=${smtpPort}, secure=${smtpSecure}, user=${smtpUser ? '***' : 'NOT SET'}`,
    );

    if (!smtpUser || !smtpPassword) {
      this.logger.warn(
        'SMTP_USER or SMTP_PASSWORD is not set. Email sending will fail.',
      );
    }

    // For port 587 with STARTTLS, use service option for Gmail
    // This ensures proper STARTTLS handling
    this.transporter = nodemailer.createTransport({
      service: 'gmail', // Use service option for Gmail (handles STARTTLS automatically)
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure, // false for STARTTLS
      auth: {
        user: smtpUser,
        pass: smtpPassword,
      },
      // Connection timeouts
      connectionTimeout: 30000, // 30 seconds
      greetingTimeout: 30000, // 30 seconds
      socketTimeout: 30000, // 30 seconds
      // DNS lookup timeout
      dnsTimeout: 10000,
      // Connection pooling
      pool: true,
      maxConnections: 1,
      maxMessages: 3,
      // Debug options (development only)
      debug: process.env.NODE_ENV === 'development',
      logger: process.env.NODE_ENV === 'development',
    });

    // Verify SMTP connection on startup (non-blocking)
    // Don't block application startup if verification fails
    void this.verifyConnection().catch((err) => {
      this.logger.warn(
        'SMTP verification failed on startup, but continuing. Emails may fail.',
        err,
      );
    });
  }

  /**
   * Verify SMTP connection
   */
  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      this.logger.log('SMTP connection verified successfully');
      return true;
    } catch (error) {
      this.logger.error('SMTP connection verification failed:', error);
      if (error instanceof Error) {
        this.logger.error(`Error details: ${error.message}`);
        this.logger.error(`Error stack: ${error.stack}`);
      }
      return false;
    }
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
  async sendEmail(options: EmailOptions, retries = 2): Promise<boolean> {
    const maxRetries = retries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Use hardcoded SMTP configuration (from .env)
        const fromEmail = 'ericshin8134@gmail.com';
        // Use fromName from options if provided, otherwise use default
        const fromName = options.fromName || 'Job Application System';

        const mailOptions: nodemailer.SendMailOptions = {
          from: `"${fromName}" <${fromEmail}>`,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html || options.text,
          attachments: options.attachments,
        };

        if (attempt > 0) {
          this.logger.log(
            `Retrying email send to ${options.to} (attempt ${attempt + 1}/${maxRetries + 1})`,
          );
        } else {
          this.logger.debug(
            `Attempting to send email to ${options.to} from ${fromEmail} (${fromName})`,
          );
        }

        const info = await this.transporter.sendMail(mailOptions);
        this.logger.log(
          `Email sent successfully to ${options.to}: ${info.messageId}`,
        );
        return true;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorCode = (error as any)?.code;
        const errorCommand = (error as any)?.command;

        // If it's a connection timeout and we have retries left, wait and retry
        if (
          (errorCode === 'ETIMEDOUT' || errorCode === 'ECONNRESET') &&
          attempt < maxRetries
        ) {
          const waitTime = (attempt + 1) * 2000; // Exponential backoff: 2s, 4s
          this.logger.warn(
            `Email send attempt ${attempt + 1} failed with ${errorCode}, retrying in ${waitTime}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }

        // Enhanced error logging for production debugging
        const errorStack = error instanceof Error ? error.stack : undefined;

        this.logger.error(`Failed to send email to ${options.to}:`, {
          message: errorMessage,
          code: errorCode,
          command: errorCommand,
          stack: errorStack,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
        });

        // Log SMTP configuration status (hardcoded values)
        this.logger.error('SMTP Configuration Check:', {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          userSet: true,
          passwordSet: true,
        });
      }
    }

    // All retries failed
    return false;
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
      fromName: applicantName || applicantEmail,
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
    applicantName?: string,
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
      fromName: applicantName || applicantEmail,
    });
  }
}
