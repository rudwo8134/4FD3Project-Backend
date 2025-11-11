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

  private smtpHost = 'smtp.gmail.com';
  private smtpUser = 'ericshin8134@gmail.com';
  private smtpPassword = 'jefh dosi gdwo iych';
  private isProduction = false;

  constructor(private readonly configService: ConfigService) {
    // Detect production environment
    // Check multiple indicators for production
    const nodeEnv = process.env.NODE_ENV?.toLowerCase() || '';
    this.isProduction =
      nodeEnv === 'production' ||
      nodeEnv === 'prod' ||
      process.env.RAILWAY_ENVIRONMENT === 'production' ||
      process.env.VERCEL_ENV === 'production' ||
      process.env.HEROKU_APP_NAME !== undefined ||
      process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;

    // Production uses port 465 (SSL) for better reliability
    // Development uses port 587 (STARTTLS)
    const smtpPort = this.isProduction ? 465 : 587;
    const smtpSecure = this.isProduction ? true : false;

    this.logger.log(
      `SMTP Configuration [${this.isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}]: host=${this.smtpHost}, port=${smtpPort}, secure=${smtpSecure}, user=${this.smtpUser ? '***' : 'NOT SET'}`,
    );

    if (!this.smtpUser || !this.smtpPassword) {
      this.logger.warn(
        'SMTP_USER or SMTP_PASSWORD is not set. Email sending will fail.',
      );
    }

    // Initialize transporter with production-optimized settings
    this.initializeTransporter(smtpPort, smtpSecure);

    // Skip connection verification on startup for production
    // Verify connection only when actually sending emails
    if (!this.isProduction) {
      void this.verifyConnection().catch((err) => {
        this.logger.warn(
          'SMTP verification failed on startup, but continuing. Emails may fail.',
          err,
        );
      });
    } else {
      this.logger.log(
        'Production mode: Skipping SMTP verification on startup. Connection will be established on first email send.',
      );
    }
  }

  /**
   * Initialize or recreate transporter with optimal settings
   * Based on Nodemailer official documentation: https://nodemailer.com/smtp
   * This is used only for the initial transporter in constructor
   */
  private initializeTransporter(port: number, secure: boolean): void {
    const transportOptions: any = {
      host: this.smtpHost,
      port: port,
      secure: secure, // true for port 465 (SSL), false for port 587 (STARTTLS)
      auth: {
        user: this.smtpUser,
        pass: this.smtpPassword,
      },
      // Connection timeouts based on Nodemailer defaults
      // Defaults: connectionTimeout: 120000ms, greetingTimeout: 30000ms,
      // socketTimeout: 600000ms, dnsTimeout: 30000ms
      connectionTimeout: this.isProduction ? 120000 : 60000, // 120s (default) for production
      greetingTimeout: 30000, // 30s (default)
      socketTimeout: this.isProduction ? 600000 : 300000, // 600s (default) for production
      dnsTimeout: 30000, // 30s (default)
      // Disable connection pooling - single connection pattern
      pool: false,
      // Debug options (development only)
      debug: !this.isProduction,
      logger: !this.isProduction,
    };

    // Add STARTTLS requirement only for port 587
    if (!secure && port === 587) {
      transportOptions.requireTLS = true;
    }

    // Add TLS options for SSL (port 465)
    // Based on Nodemailer docs: "Allow self-signed certificates"
    if (secure && port === 465) {
      transportOptions.tls = {
        rejectUnauthorized: false, // Do not fail on invalid certs
        minVersion: 'TLSv1.2',
      };
    }

    this.transporter = nodemailer.createTransport(transportOptions);
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
   * For production: Creates a new transporter for each email to avoid connection issues
   */
  async sendEmail(options: EmailOptions, retries = 2): Promise<boolean> {
    const maxRetries = retries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Create a new transporter for each attempt (especially important for production)
      // This ensures a clean connection state and avoids connection pooling issues
      const smtpPort = this.isProduction ? 465 : 587;
      const smtpSecure = this.isProduction ? true : false;
      let transporter: nodemailer.Transporter | null = null;

      try {
        // Create fresh transporter for this attempt
        transporter = this.createTransporter(smtpPort, smtpSecure);

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

        // Wrap sendMail in Promise for production/serverless environments
        // This ensures the email is fully sent before the function completes
        // Based on Stack Overflow solution for production nodemailer issues
        const info = await new Promise<nodemailer.SentMessageInfo>(
          (resolve, reject) => {
            transporter!.sendMail(mailOptions, (err, info) => {
              if (err) {
                reject(err);
              } else {
                resolve(info);
              }
            });
          },
        );

        this.logger.log(
          `Email sent successfully to ${options.to}: ${info.messageId}`,
        );

        // Close transporter after successful send
        try {
          transporter.close();
        } catch {
          // Ignore close errors
        }

        return true;
      } catch (error) {
        // Always close transporter on error
        if (transporter) {
          try {
            transporter.close();
          } catch {
            // Ignore close errors
          }
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorCode = (error as any)?.code;
        const errorCommand = (error as any)?.command;

        // If it's a connection timeout and we have retries left, wait and retry
        if (
          (errorCode === 'ETIMEDOUT' ||
            errorCode === 'ECONNRESET' ||
            errorCode === 'ESOCKET') &&
          attempt < maxRetries
        ) {
          const waitTime = (attempt + 1) * 3000; // Exponential backoff: 3s, 6s
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

        // Log SMTP configuration status (environment-aware)
        this.logger.error('SMTP Configuration Check:', {
          host: this.smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          environment: this.isProduction ? 'PRODUCTION' : 'DEVELOPMENT',
          userSet: !!this.smtpUser,
          passwordSet: !!this.smtpPassword,
        });
      }
    }

    // All retries failed
    return false;
  }

  /**
   * Create a new transporter instance
   * Used for creating fresh connections in production
   * Based on Nodemailer official documentation: https://nodemailer.com/smtp
   */
  private createTransporter(
    port: number,
    secure: boolean,
  ): nodemailer.Transporter {
    const transportOptions: any = {
      host: this.smtpHost,
      port: port,
      secure: secure, // true for port 465 (SSL), false for port 587 (STARTTLS)
      auth: {
        user: this.smtpUser,
        pass: this.smtpPassword,
      },
      // Connection timeouts based on Nodemailer defaults
      // Defaults: connectionTimeout: 120000ms, greetingTimeout: 30000ms,
      // socketTimeout: 600000ms, dnsTimeout: 30000ms
      // Production uses longer timeouts for network latency
      connectionTimeout: this.isProduction ? 120000 : 60000, // 120s (default) for production, 60s for dev
      greetingTimeout: this.isProduction ? 30000 : 30000, // 30s (default) for both
      socketTimeout: this.isProduction ? 600000 : 300000, // 600s (default) for production, 300s for dev
      dnsTimeout: this.isProduction ? 30000 : 30000, // 30s (default) for both
      // Disable connection pooling - each email gets a fresh connection
      // This follows the "Single connection" pattern from Nodemailer docs
      pool: false,
      // Debug options (development only)
      debug: !this.isProduction,
      logger: !this.isProduction,
    };

    // Add STARTTLS requirement only for port 587
    // According to docs: secure: false doesn't mean plaintext - STARTTLS is used automatically
    if (!secure && port === 587) {
      transportOptions.requireTLS = true; // Force STARTTLS
    }

    // Add TLS options for SSL (port 465) - Critical for production
    // Based on Nodemailer docs example: "Allow self-signed certificates"
    if (secure && port === 465) {
      transportOptions.tls = {
        rejectUnauthorized: false, // Do not fail on invalid certs (from Nodemailer docs)
        minVersion: 'TLSv1.2',
      };
    }

    return nodemailer.createTransport(transportOptions);
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
