import {
  Controller,
  Get,
  Query,
  Post,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('search')
  @ApiQuery({ name: 'q', required: false, description: 'search query' })
  @ApiQuery({ name: 'location', required: false, description: 'location' })
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
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ) {
    const limit = limitStr ? Number(limitStr) : undefined;
    const offset = offsetStr ? Number(offsetStr) : undefined;

    if ((!q || q.trim() === '') && (!location || location.trim() === '')) {
      throw new BadRequestException(
        'q 또는 location 중 하나는 반드시 제공해야 합니다.',
      );
    }

    return this.jobsService.searchJobs({
      query: q,
      location,
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
}
