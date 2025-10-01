import { Controller, Get, Query, Post, Param } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('search')
  @ApiQuery({ name: 'q', required: false, description: '검색 키워드' })
  @ApiQuery({ name: 'location', required: false, description: '지역 필터' })
  async search(@Query('q') q?: string, @Query('location') location?: string) {
    if (!q && !location) {
      // 최소 하나는 제공하도록 유도
    }
    return this.jobsService.searchJobs({
      query: q,
      location,
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
}
