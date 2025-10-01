import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';
import type { Express } from 'express';

@Injectable()
export class JobBoardService {
  private readonly baseUrl = 'https://boards-api.greenhouse.io/v1/boards';

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async listJobs(boardToken: string, options?: { content?: boolean }) {
    if (!boardToken) throw new BadRequestException('boardToken is required');
    const url = `${this.baseUrl}/${encodeURIComponent(boardToken)}/jobs`;
    const params: any = {};
    if (options?.content) params.content = true;
    const { data } = await firstValueFrom(this.http.get(url, { params }));
    return data; // { jobs: [...], meta: { total: N } }
  }

  async getJob(
    boardToken: string,
    jobId: string,
    options?: { questions?: boolean },
  ) {
    if (!boardToken) throw new BadRequestException('boardToken is required');
    if (!jobId) throw new BadRequestException('jobId is required');
    const url = `${this.baseUrl}/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(
      jobId,
    )}`;
    const params: any = {};
    if (options?.questions) params.questions = true;
    const { data } = await firstValueFrom(this.http.get(url, { params }));
    return data;
  }

  async apply(
    boardToken: string,
    jobId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      resume?: Express.Multer.File;
      coverLetter?: Express.Multer.File;
      coverLetterText?: string;
      boardApiKey?: string;
    },
  ) {
    if (!boardToken) throw new BadRequestException('boardToken is required');
    if (!jobId) throw new BadRequestException('jobId is required');

    const url = `${this.baseUrl}/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(
      jobId,
    )}`;

    const form = new FormData();
    form.append('first_name', input.firstName);
    form.append('last_name', input.lastName);
    form.append('email', input.email);
    if (input.phone) form.append('phone', input.phone);

    if (input.resume) {
      form.append('resume', input.resume.buffer, {
        filename: input.resume.originalname,
        contentType: input.resume.mimetype,
      } as any);
    }
    if (input.coverLetter) {
      form.append('cover_letter', input.coverLetter.buffer, {
        filename: input.coverLetter.originalname,
        contentType: input.coverLetter.mimetype,
      } as any);
    } else if (input.coverLetterText) {
      form.append('cover_letter_text', input.coverLetterText);
    }

    const apiKey =
      input.boardApiKey ||
      this.config.get<string>('GREENHOUSE_JOB_BOARD_API_KEY');
    if (!apiKey) {
      throw new UnauthorizedException('Missing GREENHOUSE_JOB_BOARD_API_KEY');
    }
    const encoded = Buffer.from(apiKey).toString('base64');
    const headers = {
      Authorization: `Basic ${encoded}`,
      ...form.getHeaders(),
    } as Record<string, string>;

    const { data } = await firstValueFrom(
      this.http.post(url, form, { headers }),
    );
    return data;
  }
}
