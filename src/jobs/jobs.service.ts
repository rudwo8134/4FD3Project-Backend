import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { GoogleJobsService } from './providers/google-jobs.service';
import { JobBoardService } from './providers/job-board.service';
import { ImportService } from './providers/import.service';
import { EmailService } from './providers/email.service';
import { JobPosting } from '../entities/job-posting.entity';
import { expandTokens } from './search/synonyms';
import { randomUUID } from 'crypto';

export interface JobSearchParams {
  query?: string;
  location?: string;
  isEmailAvailable?: boolean;
}

interface FixScoresStatus {
  id: string;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  done: boolean;
  startedAt: number;
  lastError?: string;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly fixScoresStatuses = new Map<string, FixScoresStatus>();

  constructor(
    @InjectRepository(JobPosting)
    private readonly jobPostingRepo: Repository<JobPosting>,
    private readonly googleJobs: GoogleJobsService,
    private readonly jobBoard: JobBoardService,
    private readonly importer: ImportService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async searchJobs(
    params: JobSearchParams & { limit?: number; offset?: number },
  ) {
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);

    const rawQuery = (params.query ?? '').trim();
    const rawLocation = (params.location ?? '').trim();
    const isEmailAvailable = params.isEmailAvailable;

    // If nothing provided, return empty result to avoid full table scan
    if (!rawQuery && !rawLocation && isEmailAvailable === undefined) {
      return { count: 0, results: [] };
    }

    // Tokenize query and expand synonyms for broader matching
    const baseTokens = rawQuery
      ? rawQuery
          .toLowerCase()
          .split(/[^a-z0-9+]+/i)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    const tokens = expandTokens(baseTokens);

    // Build dynamic score and where clauses
    const qb = this.jobPostingRepo.createQueryBuilder('jp');

    // Select entity columns
    qb.select([
      'jp.id',
      'jp.job_posting_id',
      'jp.data',
      'jp.created_at',
      'jp.isEmailAvailable',
      'jp.resume_email',
    ]);

    // Build a single score expression (cannot reuse SELECT aliases in Postgres)
    const scoreExprParts: string[] = [];

    if (rawQuery) {
      qb.setParameter('qPhrase', `%${rawQuery}%`);
      scoreExprParts.push(
        `(CASE WHEN (jp.data->>'job_title') ILIKE :qPhrase THEN 5 ELSE 0 END)`,
      );
    }

    tokens.forEach((_, idx) => {
      const p = `qTok${idx}`;
      qb.setParameter(p, `%${tokens[idx]}%`);
      scoreExprParts.push(
        `(CASE WHEN (jp.data->>'job_title') ILIKE :${p} THEN 3 ELSE 0 END)`,
      );
      scoreExprParts.push(
        `(CASE WHEN (jp.data->>'job_function') ILIKE :${p} THEN 2 ELSE 0 END)`,
      );
      scoreExprParts.push(
        `(CASE WHEN (jp.data->>'job_summary') ILIKE :${p} THEN 1 ELSE 0 END)`,
      );
      scoreExprParts.push(
        `(CASE WHEN (jp.data->>'job_location') ILIKE :${p} THEN 4 ELSE 0 END)`,
      );
    });

    if (rawLocation) {
      qb.setParameter('locTok', `%${rawLocation}%`);
      scoreExprParts.push(
        `(CASE WHEN (jp.data->>'job_location') ILIKE :locTok THEN 6 ELSE 0 END)`,
      );
    }

    qb.addSelect(
      scoreExprParts.length ? scoreExprParts.join(' + ') : '0',
      'score',
    );

    // WHERE: match any token in any field OR phrase in title; and if location provided, also require location match
    const whereClauses: string[] = [];
    const whereParams: Record<string, any> = {};

    if (rawQuery) {
      whereParams['qPhraseWhere'] = `%${rawQuery}%`;
      whereClauses.push(`(jp.data->>'job_title') ILIKE :qPhraseWhere`);
    }

    tokens.forEach((t, idx) => {
      const p = `wTok${idx}`;
      whereParams[p] = `%${t}%`;
      whereClauses.push(`(jp.data->>'job_title') ILIKE :${p}`);
      whereClauses.push(`(jp.data->>'job_function') ILIKE :${p}`);
      whereClauses.push(`(jp.data->>'job_summary') ILIKE :${p}`);
      whereClauses.push(`(jp.data->>'job_location') ILIKE :${p}`);
    });

    // Add location filter to params if provided
    if (rawLocation) {
      whereParams['locFilter'] = `%${rawLocation}%`;
    }

    // Note: isEmailAvailable uses IS TRUE/IS FALSE, so no parameter needed

    // Build WHERE conditions - combine all conditions with AND
    const allWhereConditions: string[] = [];

    // Query conditions (OR group)
    if (whereClauses.length > 0) {
      allWhereConditions.push(
        `(${whereClauses.map((c) => `(${c})`).join(' OR ')})`,
      );
    }

    // Location filter (AND)
    if (rawLocation) {
      allWhereConditions.push(`(jp.data->>'job_location') ILIKE :locFilter`);
    }

    // isEmailAvailable filter (AND)
    if (isEmailAvailable !== undefined) {
      if (isEmailAvailable) {
        // Return records where resume_email is not null (has email value)
        // This ensures we only return jobs with actual email addresses
        allWhereConditions.push('jp.resume_email IS NOT NULL');
        // Also check that resume_email is not empty string
        allWhereConditions.push("jp.resume_email != ''");
      } else {
        // Return records where isEmailAvailable is false or null, or resume_email is null/empty
        allWhereConditions.push(
          "(jp.isEmailAvailable IS FALSE OR jp.isEmailAvailable IS NULL OR jp.resume_email IS NULL OR jp.resume_email = '')",
        );
      }
    }

    // Apply all WHERE conditions
    if (allWhereConditions.length > 0) {
      const whereSql = allWhereConditions.join(' AND ');
      qb.where(whereSql).setParameters(whereParams);

      // Debug logging
      this.logger.debug(
        `Search query - WHERE: ${whereSql}, params: ${JSON.stringify(whereParams)}`,
      );
    } else {
      // This should not happen due to validation, but log if it does
      this.logger.warn('No WHERE conditions generated for search');
    }

    // Get total count before pagination for proper pagination support
    // Create a separate count query builder
    const countQb = this.jobPostingRepo.createQueryBuilder('jp');
    if (allWhereConditions.length > 0) {
      const whereSql = allWhereConditions.join(' AND ');
      countQb.where(whereSql).setParameters(whereParams);
    }
    const totalCount = await countQb.getCount();

    // Order by score DESC first (highest score first), then by created_at DESC (latest within same score)
    qb.orderBy('score', 'DESC');
    qb.addOrderBy('jp.created_at', 'DESC');
    qb.limit(limit);
    qb.offset(offset);

    // Debug: log the generated SQL
    const sql = qb.getSql();
    this.logger.debug(`Generated SQL: ${sql}`);

    const { entities, raw } = await qb.getRawAndEntities();

    this.logger.debug(
      `Search results: found ${entities.length} entities (total: ${totalCount}), isEmailAvailable filter: ${isEmailAvailable}`,
    );

    const results = entities.map((e, i) => {
      const score = Number(raw[i]?.score ?? 0);
      return {
        id: e.id,
        job_posting_id: e.job_posting_id,
        score,
        isEmailAvailable: e.isEmailAvailable ?? false,
        resume_email: e.resume_email ?? null,
        ...e.data,
      } as Record<string, any>;
    });

    return { count: totalCount, results };
  }

  async listBoardJobs(boardToken: string, content?: boolean) {
    return this.jobBoard.listJobs(boardToken, { content });
  }

  async getBoardJob(boardToken: string, jobId: string, questions?: boolean) {
    return this.jobBoard.getJob(boardToken, jobId, { questions });
  }

  async applyBoardJob(
    boardToken: string,
    jobId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      coverLetterText?: string;
      resume?: Express.Multer.File;
      coverLetter?: Express.Multer.File;
      boardApiKey?: string;
    },
  ) {
    return this.jobBoard.apply(boardToken, jobId, input);
  }

  startCsvImport(file: Express.Multer.File) {
    return this.importer.startCsvImport(file.buffer, {
      batchSize: 30,
      intervalMs: 5000,
      idColumn: 'job_posting_id',
    });
  }

  startLocalCsvImport() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');

    const candidates = [
      path.resolve(__dirname, '../Data/jobList.csv'),
      path.resolve(__dirname, './Data/jobList.csv'),
      path.resolve(process.cwd(), 'dist/Data/jobList.csv'),
      path.resolve(process.cwd(), 'src/Data/jobList.csv'),
      path.resolve(__dirname, '../Data/JobList.csv'),
    ];
    const existing = candidates.find((p: string) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!existing) {
      throw new Error('jobList.csv not found in Data directory');
    }

    const buffer = fs.readFileSync(existing);
    return this.importer.startCsvImport(buffer, {
      batchSize: 30,
      intervalMs: 5000,
      idColumn: 'job_posting_id',
    });
  }

  getImportStatus(id: string): any {
    return this.importer.getStatus(id);
  }

  /**
   * Apply to jobs by job_posting_id(s)
   * Supports both single ID (string) and multiple IDs (array of strings)
   */
  async applyToJobs(
    jobPostingIds: string | string[],
    applicantEmail: string,
    applicantName?: string,
    files?: Express.Multer.File[],
    emailTestMode?: boolean,
  ) {
    // Normalize to array
    const ids = Array.isArray(jobPostingIds) ? jobPostingIds : [jobPostingIds];

    if (ids.length === 0) {
      throw new BadRequestException('job_posting_id는 필수입니다.');
    }

    if (!applicantEmail || !applicantEmail.trim()) {
      throw new BadRequestException('applicant_email은 필수입니다.');
    }

    // Fetch job postings from database
    const jobPostings = await this.jobPostingRepo.find({
      where: {
        job_posting_id: In(ids),
      },
    });

    if (jobPostings.length === 0) {
      throw new BadRequestException(
        `해당 job_posting_id에 매칭되는 데이터를 찾을 수 없습니다.`,
      );
    }

    const results = [];
    const applicantEmailNormalized = applicantEmail.trim();

    // Default emailTestMode to false if not provided
    const isTestMode = emailTestMode === true;

    // Process each job posting
    for (const jobPosting of jobPostings) {
      const jobData = jobPosting.data as Record<string, any>;
      const jobTitle = jobData.job_title || 'Unknown Position';

      // Use resume_email from database instead of extracting from job_summary
      const resumeEmail = jobPosting.resume_email;

      // In test mode, use test email address instead of actual resume_email
      const testEmailAddress = 'rudwo8134@gmail.com';
      const targetEmail = isTestMode ? testEmailAddress : resumeEmail?.trim();

      if (!targetEmail || targetEmail === '') {
        results.push({
          job_posting_id: jobPosting.job_posting_id,
          job_title: jobTitle,
          status: 'failed',
          reason: isTestMode
            ? 'Test mode is enabled but test email address is invalid.'
            : 'resume_email이 데이터베이스에 저장되어 있지 않습니다.',
          emails_found: [],
        });
        continue;
      }

      const extractedEmails = [targetEmail];

      // Log test mode usage
      if (isTestMode) {
        this.logger.log(
          `Test mode enabled: Sending email to ${testEmailAddress} instead of ${resumeEmail || 'N/A'} for job ${jobPosting.job_posting_id}`,
        );
      }

      // Prepare attachments from files
      const attachments = files
        ? files.map((file) => ({
            filename: file.originalname,
            content: file.buffer,
            contentType: file.mimetype,
          }))
        : undefined;

      // Send emails to all found addresses
      const emailResults = [];
      let successCount = 0;

      for (const recipientEmail of extractedEmails) {
        try {
          const sent = await this.emailService.sendApplicationEmail(
            recipientEmail,
            jobTitle,
            applicantEmailNormalized,
            applicantName,
            attachments,
          );

          if (sent) {
            successCount++;
            emailResults.push({
              email: recipientEmail,
              status: 'sent',
            });

            // Send confirmation email to applicant
            try {
              await this.emailService.sendConfirmationEmail(
                applicantEmailNormalized,
                jobTitle,
                recipientEmail,
                applicantName,
              );
            } catch (confirmError) {
              this.logger.warn(
                `Failed to send confirmation email to ${applicantEmailNormalized}:`,
                confirmError,
              );
              // Don't fail the whole operation if confirmation fails
            }
          } else {
            // SMTP configuration is hardcoded, so credentials are always set
            const failureReason =
              'Email sending failed (check logs for details)';

            this.logger.error(
              `Failed to send application email to ${recipientEmail} for job ${jobPosting.job_posting_id}. Reason: ${failureReason}`,
            );

            emailResults.push({
              email: recipientEmail,
              status: 'failed',
              error: failureReason,
            });
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          const errorStack = error instanceof Error ? error.stack : undefined;

          this.logger.error(
            `Exception while sending email to ${recipientEmail} for job ${jobPosting.job_posting_id}:`,
            {
              message: errorMessage,
              stack: errorStack,
            },
          );

          emailResults.push({
            email: recipientEmail,
            status: 'error',
            error: errorMessage,
          });
        }
      }

      results.push({
        job_posting_id: jobPosting.job_posting_id,
        job_title: jobTitle,
        status: successCount > 0 ? 'success' : 'failed',
        emails_found: extractedEmails,
        email_results: emailResults,
        total_emails: extractedEmails.length,
        successful_emails: successCount,
        test_mode: isTestMode,
        original_resume_email: isTestMode ? resumeEmail : undefined,
      });
    }

    // Overall status
    const overallSuccess = results.some((r) => r.status === 'success');

    return {
      status: overallSuccess ? 'success' : 'partial_failure',
      applicant_email: applicantEmailNormalized,
      total_jobs_processed: results.length,
      email_test_mode: isTestMode,
      files_attached: files
        ? files.map((f) => ({
            filename: f.originalname,
            size: f.size,
            mimetype: f.mimetype,
          }))
        : [],
      results,
    };
  }

  /**
   * Start fixing decimal scores to integer scores
   * Finds records with 0 < score < 1 and multiplies by 100
   * Processes 100 records at a time to avoid system overload
   */
  startFixScores() {
    const id = randomUUID();
    const status: FixScoresStatus = {
      id,
      total: 0,
      processed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      done: false,
      startedAt: Date.now(),
    };
    this.fixScoresStatuses.set(id, status);

    // Start async processing
    void this.processFixScores(id);

    return { fixScoresId: id };
  }

  /**
   * Process score fixing in batches of 100
   */
  private async processFixScores(id: string) {
    const status = this.fixScoresStatuses.get(id);
    if (!status) {
      this.logger.error(`Fix scores status not found: ${id}`);
      return;
    }

    const batchSize = 100;
    let offset = 0;
    let hasMore = true;

    try {
      // First, get total count of records with decimal scores
      // Handle both numeric and string representations
      const totalCount = await this.jobPostingRepo
        .createQueryBuilder('jp')
        .where(
          "jp.data->>'Suitability Score' IS NOT NULL AND " +
            "CAST(jp.data->>'Suitability Score' AS NUMERIC) > 0 AND " +
            "CAST(jp.data->>'Suitability Score' AS NUMERIC) < 1",
        )
        .getCount();

      status.total = totalCount;
      this.logger.log(
        `Found ${totalCount} records with decimal scores for fix ${id}`,
      );

      while (hasMore) {
        // Get batch of records with decimal scores
        const records = await this.jobPostingRepo
          .createQueryBuilder('jp')
          .where(
            "jp.data->>'Suitability Score' IS NOT NULL AND " +
              "CAST(jp.data->>'Suitability Score' AS NUMERIC) > 0 AND " +
              "CAST(jp.data->>'Suitability Score' AS NUMERIC) < 1",
          )
          .orderBy('jp.created_at', 'ASC')
          .skip(offset)
          .take(batchSize)
          .getMany();

        if (records.length === 0) {
          hasMore = false;
          break;
        }

        // Process each record
        const recordsToUpdate: JobPosting[] = [];

        for (const record of records) {
          try {
            const scoreValue = record.data?.['Suitability Score'];
            if (scoreValue === undefined || scoreValue === null) {
              status.skipped++;
              continue;
            }

            // Parse score (handle both number and string)
            let score: number;
            if (typeof scoreValue === 'number') {
              score = scoreValue;
            } else if (typeof scoreValue === 'string') {
              score = parseFloat(scoreValue);
              if (isNaN(score)) {
                status.skipped++;
                continue;
              }
            } else {
              status.skipped++;
              continue;
            }

            // Check if score is in decimal range (0 < score < 1)
            if (score > 0 && score < 1) {
              // Multiply by 100 and round to integer
              const newScore = Math.round(score * 100);
              record.data['Suitability Score'] = newScore;
              recordsToUpdate.push(record);
            } else {
              status.skipped++;
            }
          } catch (err: any) {
            status.failed++;
            this.logger.warn(
              `Failed to process record ${record.job_posting_id}: ${err?.message}`,
            );
          }
        }

        // Batch update
        if (recordsToUpdate.length > 0) {
          await this.jobPostingRepo.save(recordsToUpdate);
          status.updated += recordsToUpdate.length;
          this.logger.debug(
            `Updated ${recordsToUpdate.length} records in batch (offset: ${offset})`,
          );
        }

        status.processed += records.length;
        offset += batchSize;

        // Check if we're done
        if (records.length < batchSize || status.processed >= status.total) {
          hasMore = false;
        }

        // Small delay to avoid overwhelming the system
        if (hasMore) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      status.done = true;
      this.logger.log(
        `Fix scores ${id} completed: updated=${status.updated} skipped=${status.skipped} failed=${status.failed}`,
      );
    } catch (err: any) {
      status.done = true;
      status.lastError = err?.message ?? String(err);
      this.logger.error(`Fix scores error for ${id}:`, err?.stack);
    }
  }

  /**
   * Get the status of a score fixing operation
   */
  getFixScoresStatus(id: string): FixScoresStatus | { error: string } {
    const status = this.fixScoresStatuses.get(id);
    if (!status) {
      return { error: 'not_found' };
    }
    return status;
  }
}
