import {
  Controller,
  Get,
  Query,
  Post,
  Param,
  Body,
  BadRequestException,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiQuery,
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('search')
  @ApiQuery({ name: 'q', required: false, description: 'search query' })
  @ApiQuery({ name: 'location', required: false, description: 'location' })
  @ApiQuery({
    name: 'isEmailAvailable',
    required: false,
    type: Boolean,
    description:
      'Filter by email availability (true: only jobs with email, false: only jobs without email)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'page size (default 25, max 100)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'page offset (default 0)',
  })
  async search(
    @Query('q') q?: string,
    @Query('location') location?: string,
    @Query('isEmailAvailable') isEmailAvailableStr?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ) {
    const limit = limitStr ? Number(limitStr) : undefined;
    const offset = offsetStr ? Number(offsetStr) : undefined;
    const isEmailAvailable =
      isEmailAvailableStr !== undefined
        ? isEmailAvailableStr === 'true'
        : undefined;

    if (
      (!q || q.trim() === '') &&
      (!location || location.trim() === '') &&
      isEmailAvailable === undefined
    ) {
      throw new BadRequestException(
        'q, location, 또는 isEmailAvailable 중 하나는 반드시 제공해야 합니다.',
      );
    }

    return this.jobsService.searchJobs({
      query: q,
      location,
      isEmailAvailable,
      limit,
      offset,
    });
  }

  @Post('import/local')
  async importCsvFromLocal() {
    return this.jobsService.startLocalCsvImport();
  }

  @Get('import/:id/status')
  async importStatus(@Param('id') id: string): Promise<any> {
    return this.jobsService.getImportStatus(id);
  }

  @Post('apply')
  @UseInterceptors(FilesInterceptor('files'))
  @ApiOperation({
    summary: 'Apply to job(s)',
    description:
      'Apply to one or multiple jobs by job_posting_id. Extracts email from job_summary and sends application email with attachments.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        job_posting_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description:
            'Single job_posting_id (string) or multiple IDs (array). For array, send as JSON string.',
        },
        applicant_email: {
          type: 'string',
          description: 'Email address of the applicant',
        },
        applicant_name: {
          type: 'string',
          description: 'Name of the applicant (optional)',
        },
        emailTestMode: {
          type: 'boolean',
          description:
            'If true, emails will be sent to rudwo8134@gmail.com instead of actual resume_email (for testing)',
        },
        files: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
          description: 'Files to attach (resume, cover letter, etc.)',
        },
      },
      required: ['job_posting_id', 'applicant_email'],
    },
  })
  async apply(
    @Body()
    body: {
      job_posting_id: string | string[];
      applicant_email: string;
      applicant_name?: string;
      emailTestMode?: string | boolean;
    },
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    if (!body.job_posting_id) {
      throw new BadRequestException('job_posting_id는 필수입니다.');
    }

    if (!body.applicant_email) {
      throw new BadRequestException('applicant_email은 필수입니다.');
    }

    // Parse job_posting_id if it's a JSON string (for array support in form-data)
    let jobPostingIds: string | string[];
    try {
      const parsed = JSON.parse(body.job_posting_id as string);
      jobPostingIds = Array.isArray(parsed) ? parsed : body.job_posting_id;
    } catch {
      jobPostingIds = body.job_posting_id;
    }

    // Parse emailTestMode (can be string "true"/"false" from form-data or boolean)
    // Default to false if not provided
    const emailTestMode =
      body.emailTestMode === true ||
      body.emailTestMode === 'true' ||
      body.emailTestMode === '1'
        ? true
        : false;

    return this.jobsService.applyToJobs(
      jobPostingIds,
      body.applicant_email,
      body.applicant_name,
      files,
      emailTestMode,
    );
  }
}
