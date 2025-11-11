import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('job_postings')
@Index('uq_job_posting_id', ['job_posting_id'], { unique: true })
export class JobPosting {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  job_posting_id!: string;

  @Column({ type: 'jsonb' })
  data!: Record<string, any>;

  @Column({ type: 'boolean', default: false, nullable: true })
  isEmailAvailable?: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  resume_email?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
