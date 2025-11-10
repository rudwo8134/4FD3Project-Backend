import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { GoogleJobsService } from './providers/google-jobs.service';
import { JobBoardService } from './providers/job-board.service';
import { ImportService } from './providers/import.service';
import { EmailService } from './providers/email.service';
import { JobPosting } from '../entities/job-posting.entity';
import { expandTokens } from './search/synonyms';

export interface JobSearchParams {
  query?: string;
  location?: string;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @InjectRepository(JobPosting)
    private readonly jobPostingRepo: Repository<JobPosting>,
    private readonly googleJobs: GoogleJobsService,
    private readonly jobBoard: JobBoardService,
    private readonly importer: ImportService,
    private readonly emailService: EmailService,
  ) {}

  async searchJobs(
    params: JobSearchParams & { limit?: number; offset?: number },
  ) {
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);

    const rawQuery = (params.query ?? '').trim();
    const rawLocation = (params.location ?? '').trim();

    // If nothing provided, return empty result to avoid full table scan
    if (!rawQuery && !rawLocation) {
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
    qb.select(['jp.id', 'jp.job_posting_id', 'jp.data', 'jp.created_at']);

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

    if (whereClauses.length > 0) {
      qb.where(whereClauses.map((c) => `(${c})`).join(' OR ')).setParameters({
        ...whereParams,
      });
    }

    if (rawLocation) {
      // If a location filter is provided, require it
      qb.andWhere(`(jp.data->>'job_location') ILIKE :locFilter`, {
        locFilter: `%${rawLocation}%`,
      });
    }
    qb.orderBy('score', 'DESC');
    qb.addOrderBy('jp.created_at', 'DESC');
    qb.limit(limit);
    qb.offset(offset);
    const { entities, raw } = await qb.getRawAndEntities();

    const results = entities.map((e, i) => {
      const score = Number(raw[i]?.score ?? 0);
      return {
        id: e.id,
        job_posting_id: e.job_posting_id,
        score,
        ...e.data,
      } as Record<string, any>;
    });

    return { count: results.length, results };
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

    // Process each job posting
    for (const jobPosting of jobPostings) {
      const jobData = jobPosting.data as Record<string, any>;
      const jobTitle = jobData.job_title || 'Unknown Position';
      const jobSummary = jobData.job_summary || '';

      // Extract emails from job_summary
      const extractedEmails = this.emailService.extractEmails(jobSummary);

      if (extractedEmails.length === 0) {
        results.push({
          job_posting_id: jobPosting.job_posting_id,
          job_title: jobTitle,
          status: 'failed',
          reason: 'job_summary에서 이메일 주소를 찾을 수 없습니다.',
          emails_found: [],
        });
        continue;
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
            await this.emailService.sendConfirmationEmail(
              applicantEmailNormalized,
              jobTitle,
              recipientEmail,
            );
          } else {
            emailResults.push({
              email: recipientEmail,
              status: 'failed',
            });
          }
        } catch (error) {
          this.logger.error(
            `Failed to send email to ${recipientEmail} for job ${jobPosting.job_posting_id}:`,
            error,
          );
          emailResults.push({
            email: recipientEmail,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
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
      });
    }

    // Overall status
    const overallSuccess = results.some((r) => r.status === 'success');

    return {
      status: overallSuccess ? 'success' : 'partial_failure',
      applicant_email: applicantEmailNormalized,
      total_jobs_processed: results.length,
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
}
