import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { JobPosting } from '../../entities/job-posting.entity';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'crypto';

interface ImportStatus {
  id: string;
  total: number;
  processed: number;
  inserted: number;
  skipped: number;
  failed: number;
  done: boolean;
  startedAt: number;
  lastError?: string;
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  private readonly statuses = new Map<string, ImportStatus>();
  // Multiple email patterns for better coverage
  private readonly emailPatterns = [
    // Pattern 1: Standard email with word boundaries
    /\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}\b/gi,
    // Pattern 2: Email without strict word boundaries (for cases like "at email@domain.com")
    /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}/gi,
    // Pattern 3: More permissive pattern
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi,
  ];

  constructor(
    @InjectRepository(JobPosting)
    private readonly jobPostingRepo: Repository<JobPosting>,
  ) {}

  private isValidEmail(email: string): boolean {
    if (!email || email.length < 5) return false;

    // Basic validation: must have @ and at least one dot in domain
    const parts = email.split('@');
    if (parts.length !== 2) return false;

    const [local, domain] = parts;
    if (!local || local.length === 0) return false;
    if (!domain || domain.length === 0) return false;

    // Domain must have at least one dot
    if (!domain.includes('.')) return false;

    // Domain must have valid TLD (at least 2 characters)
    const domainParts = domain.split('.');
    const tld = domainParts[domainParts.length - 1];
    if (!tld || tld.length < 2) return false;

    return true;
  }

  private extractEmail(jobSummary: string | undefined): {
    isEmailAvailable: boolean;
    resume_email: string | null;
  } {
    if (!jobSummary || typeof jobSummary !== 'string') {
      return { isEmailAvailable: false, resume_email: null };
    }

    // Normalize text: remove extra whitespace but preserve structure
    const normalizedText = jobSummary.trim();

    // Try each pattern and collect all matches
    const allMatches: string[] = [];

    for (const pattern of this.emailPatterns) {
      const matches = normalizedText.match(pattern);
      if (matches) {
        allMatches.push(...matches);
      }
    }

    if (allMatches.length === 0) {
      this.logger.debug(
        `No email found in job_summary (length: ${normalizedText.length})`,
      );
      return { isEmailAvailable: false, resume_email: null };
    }

    // Remove duplicates and normalize (lowercase for comparison)
    const uniqueEmails = Array.from(
      new Set(allMatches.map((e) => e.toLowerCase().trim())),
    );

    // Validate and find the best email (prefer longer emails as they're more complete)
    const validEmails = uniqueEmails
      .filter((email) => this.isValidEmail(email))
      .sort((a, b) => b.length - a.length); // Sort by length, longest first

    if (validEmails.length === 0) {
      this.logger.warn(
        `Found email-like strings but none are valid: ${allMatches.join(', ')}`,
      );
      return { isEmailAvailable: false, resume_email: null };
    }

    // Use the longest valid email (most likely to be complete)
    const selectedEmail = validEmails[0];

    // Find the original case version if available
    const originalEmail =
      allMatches.find((e) => e.toLowerCase().trim() === selectedEmail) ||
      selectedEmail;

    this.logger.debug(
      `Extracted email: ${originalEmail} from job_summary (found ${allMatches.length} matches, ${validEmails.length} valid)`,
    );

    return {
      isEmailAvailable: true,
      resume_email: originalEmail.trim(),
    };
  }

  startCsvImport(
    fileBuffer: Buffer,
    opts?: { batchSize?: number; intervalMs?: number; idColumn?: string },
  ) {
    const batchSize = opts?.batchSize ?? 30;
    const intervalMs = opts?.intervalMs ?? 5000;
    const idColumn = opts?.idColumn ?? 'job_posting_id';

    const id = randomUUID();
    const status: ImportStatus = {
      id,
      total: 0,
      processed: 0,
      inserted: 0,
      skipped: 0,
      failed: 0,
      done: false,
      startedAt: Date.now(),
    };
    this.statuses.set(id, status);

    try {
      const records = parse(fileBuffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];

      status.total = records.length;
      this.logger.log(`Parsed ${records.length} records for import ${id}`);

      let cursor = 0;
      const runBatch = async () => {
        if (cursor >= records.length) {
          status.done = true;
          this.logger.log(
            `Import ${id} completed: inserted=${status.inserted} skipped=${status.skipped} failed=${status.failed}`,
          );
          return;
        }

        const slice = records.slice(cursor, cursor + batchSize);
        cursor += slice.length;

        try {
          const prepared = slice
            .map((r) => {
              const v = r[idColumn];
              if (!v) return null;

              const jobSummary = r.job_summary;
              const { isEmailAvailable, resume_email } =
                this.extractEmail(jobSummary);

              return {
                job_posting_id: String(v),
                data: r,
                isEmailAvailable,
                resume_email,
              } as Partial<JobPosting>;
            })
            .filter(Boolean) as Partial<JobPosting>[];

          if (prepared.length > 0) {
            const ids = prepared.map((e) => e.job_posting_id as string);
            const existing = await this.jobPostingRepo.find({
              where: { job_posting_id: In(ids) },
              select: ['job_posting_id', 'isEmailAvailable', 'resume_email'],
            });
            const existingSet = new Set(existing.map((e) => e.job_posting_id));
            const newOnes = prepared.filter(
              (e) => !existingSet.has(e.job_posting_id as string),
            );
            const toUpdate = prepared.filter((e) =>
              existingSet.has(e.job_posting_id as string),
            );

            // Insert new records
            if (newOnes.length > 0) {
              await this.jobPostingRepo
                .createQueryBuilder()
                .insert()
                .into(JobPosting)
                .values(newOnes)
                .execute();
              status.inserted += newOnes.length;
            }

            // Update existing records with email information
            if (toUpdate.length > 0) {
              // Use save() for batch updates (more efficient than individual updates)
              const existingRecords = await this.jobPostingRepo.find({
                where: {
                  job_posting_id: In(toUpdate.map((r) => r.job_posting_id)),
                },
              });

              const existingMap = new Map(
                existingRecords.map((r) => [r.job_posting_id, r]),
              );

              const recordsToSave = toUpdate
                .map((record) => {
                  const existing = existingMap.get(
                    record.job_posting_id as string,
                  );
                  if (existing) {
                    existing.data = record.data;
                    existing.isEmailAvailable = record.isEmailAvailable;
                    existing.resume_email = record.resume_email;
                    return existing;
                  }
                  return null;
                })
                .filter(Boolean) as JobPosting[];

              if (recordsToSave.length > 0) {
                await this.jobPostingRepo.save(recordsToSave);
              }
              status.inserted += toUpdate.length;
            }

            status.skipped = 0; // We're updating existing records, not skipping
          }

          status.processed += slice.length;
        } catch (err: any) {
          status.failed += slice.length;
          status.lastError = err?.message ?? String(err);
          this.logger.error(
            `Batch failed for import ${id}: ${status.lastError}`,
          );
        }

        setTimeout(runBatch, intervalMs);
      };

      void runBatch();
    } catch (err: any) {
      status.done = true;
      status.lastError = err?.message ?? String(err);
      this.logger.error(`CSV parse error for import ${id}`, err?.stack);
    }

    return { importId: id };
  }

  getStatus(importId: string) {
    const s = this.statuses.get(importId);
    if (!s) return { error: 'not_found' };
    return s;
  }
}
