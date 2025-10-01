import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GoogleJobsService } from './providers/google-jobs.service';
import { JobBoardService } from './providers/job-board.service';
import { ImportService } from './providers/import.service';
import { JobPosting } from '../entities/job-posting.entity';
import { expandTokens } from './search/synonyms';

export interface JobSearchParams {
  query?: string;
  location?: string;
}

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(JobPosting)
    private readonly jobPostingRepo: Repository<JobPosting>,
    private readonly googleJobs: GoogleJobsService,
    private readonly jobBoard: JobBoardService,
    private readonly importer: ImportService,
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
}
