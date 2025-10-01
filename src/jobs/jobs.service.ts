import { Injectable } from '@nestjs/common';
import { GoogleJobsService } from './providers/google-jobs.service';
import { JobBoardService } from './providers/job-board.service';
import { ImportService } from './providers/import.service';

export interface JobSearchParams {
  query?: string;
  location?: string;
}

@Injectable()
export class JobsService {
  constructor(
    private readonly googleJobs: GoogleJobsService,
    private readonly jobBoard: JobBoardService,
    private readonly importer: ImportService,
  ) {}

  async searchJobs(params: JobSearchParams) {
    const results = await Promise.allSettled([this.googleJobs.search(params)]);

    const aggregated = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r: any) => r.value);

    return { count: aggregated.length, results: aggregated };
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
