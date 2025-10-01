import { Injectable, Logger } from '@nestjs/common';
import type { JobSearchParams } from '../jobs.service';

@Injectable()
export class GoogleJobsService {
  private readonly logger = new Logger(GoogleJobsService.name);

  // Placeholder: 실제 Google Cloud Talent Solution 연동은 서비스 계정 및 추가 SDK 필요
  async search(params: JobSearchParams) {
    void params;
    this.logger.log(
      'Google Jobs integration not configured. Returning empty list.',
    );
    return [] as any[];
  }
}
