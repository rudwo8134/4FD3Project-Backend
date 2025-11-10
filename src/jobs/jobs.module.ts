import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { GoogleJobsService } from './providers/google-jobs.service';
import { JobBoardService } from './providers/job-board.service';
import { ImportService } from './providers/import.service';
import { EmailService } from './providers/email.service';
import { JobPosting } from '../entities/job-posting.entity';

@Module({
  imports: [HttpModule, ConfigModule, TypeOrmModule.forFeature([JobPosting])],
  controllers: [JobsController],
  providers: [
    GoogleJobsService,
    JobBoardService,
    ImportService,
    EmailService,
    JobsService,
  ],
})
export class JobsModule {}
