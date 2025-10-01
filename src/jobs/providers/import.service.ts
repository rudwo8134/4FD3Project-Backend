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

  constructor(
    @InjectRepository(JobPosting)
    private readonly jobPostingRepo: Repository<JobPosting>,
  ) {}

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
              return {
                job_posting_id: String(v),
                data: r,
              } as Partial<JobPosting>;
            })
            .filter(Boolean) as Partial<JobPosting>[];

          if (prepared.length > 0) {
            const ids = prepared.map((e) => e.job_posting_id as string);
            const existing = await this.jobPostingRepo.find({
              where: { job_posting_id: In(ids) },
              select: ['job_posting_id'],
            });
            const existingSet = new Set(existing.map((e) => e.job_posting_id));
            const newOnes = prepared.filter(
              (e) => !existingSet.has(e.job_posting_id as string),
            );

            if (newOnes.length > 0) {
              await this.jobPostingRepo
                .createQueryBuilder()
                .insert()
                .into(JobPosting)
                .values(newOnes)
                .execute();
            }

            status.inserted += newOnes.length;
            status.skipped += prepared.length - newOnes.length;
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
