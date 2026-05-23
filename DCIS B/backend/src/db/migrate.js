import { pool } from './pool.js';
import { logger } from '../config/logger.js';

const SCHEMA = `
-- Developer profiles
CREATE TABLE IF NOT EXISTS developers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_username VARCHAR(255) UNIQUE,
  email VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit runs (one developer can have many audits over time)
CREATE TABLE IF NOT EXISTS audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id UUID REFERENCES developers(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'pending',
  -- pending | ingesting | analyzing | llm_processing | market_matching | generating_output | complete | failed
  error TEXT,
  github_username VARCHAR(255),
  live_url TEXT,
  resume_path TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- GitHub ingestion results
CREATE TABLE IF NOT EXISTS github_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id UUID REFERENCES audit_runs(id) ON DELETE CASCADE,
  username VARCHAR(255) NOT NULL,
  public_repos INTEGER,
  followers INTEGER,
  account_created_at TIMESTAMPTZ,
  languages JSONB DEFAULT '[]',
  repositories JSONB DEFAULT '[]',
  commit_frequency JSONB DEFAULT '{}',
  pr_communication_style JSONB DEFAULT '{}',
  raw_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live app audit results
CREATE TABLE IF NOT EXISTS live_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id UUID REFERENCES audit_runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  is_reachable BOOLEAN DEFAULT FALSE,
  screenshot_url TEXT,
  page_title TEXT,
  load_time_ms INTEGER,
  http_status INTEGER,
  interactions JSONB DEFAULT '[]',
  console_errors JSONB DEFAULT '[]',
  functional BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Resume parse results
CREATE TABLE IF NOT EXISTS resume_parses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id UUID REFERENCES audit_runs(id) ON DELETE CASCADE,
  original_filename TEXT,
  raw_text TEXT,
  claimed_skills JSONB DEFAULT '[]',
  years_experience INTEGER,
  education JSONB DEFAULT '[]',
  previous_roles JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Code analysis results (AST + security + tests)
CREATE TABLE IF NOT EXISTS code_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id UUID REFERENCES audit_runs(id) ON DELETE CASCADE,
  repo_name VARCHAR(255),
  repo_url TEXT,
  -- AST analysis
  complexity_report JSONB DEFAULT '{}',
  -- Security scan
  security_report JSONB DEFAULT '{}',
  -- Test verification
  test_report JSONB DEFAULT '{}',
  -- Combined structured report fed to LLM
  structured_json_report JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- LLM review results
CREATE TABLE IF NOT EXISTS llm_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id UUID REFERENCES audit_runs(id) ON DELETE CASCADE,
  -- Senior reviewer agent output
  architectural_feedback JSONB DEFAULT '[]',
  scalability_concerns JSONB DEFAULT '[]',
  -- Skill gap truth check
  verified_skills JSONB DEFAULT '[]',
  unverified_skills JSONB DEFAULT '[]',
  hidden_strengths JSONB DEFAULT '[]',
  skill_gap_report JSONB DEFAULT '{}',
  -- Overall grade
  seniority_score INTEGER, -- 1-10
  overall_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Job postings (scraped)
CREATE TABLE IF NOT EXISTS job_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50), -- linkedin | greenhouse
  external_id VARCHAR(255),
  title VARCHAR(500),
  company VARCHAR(255),
  location VARCHAR(255),
  remote BOOLEAN DEFAULT FALSE,
  required_skills JSONB DEFAULT '[]',
  nice_to_have_skills JSONB DEFAULT '[]',
  salary_min INTEGER,
  salary_max INTEGER,
  salary_currency VARCHAR(10) DEFAULT 'USD',
  description_summary TEXT,
  apply_url TEXT,
  pinecone_id VARCHAR(255),
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, external_id)
);

-- Salary benchmarks (from Levels.fyi)
CREATE TABLE IF NOT EXISTS salary_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_title VARCHAR(255),
  location VARCHAR(255),
  yoe_min INTEGER,
  yoe_max INTEGER,
  p25 INTEGER,
  p50 INTEGER,
  p75 INTEGER,
  currency VARCHAR(10) DEFAULT 'USD',
  source VARCHAR(50) DEFAULT 'levels.fyi',
  cached_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(role_title, location, yoe_min, yoe_max)
);

-- Market match results
CREATE TABLE IF NOT EXISTS market_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id UUID REFERENCES audit_runs(id) ON DELETE CASCADE,
  job_posting_id UUID REFERENCES job_postings(id),
  similarity_score FLOAT,
  salary_gap INTEGER, -- developer worth vs job salary (can be negative = underpaid)
  salary_trajectory VARCHAR(50), -- underpaid | at-market | premium
  fit_summary TEXT,
  rank INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Final audit outputs
CREATE TABLE IF NOT EXISTS audit_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id UUID REFERENCES audit_runs(id) ON DELETE CASCADE,
  code_audit_report JSONB DEFAULT '{}',
  ninety_day_plan JSONB DEFAULT '{}',
  smart_resume JSONB DEFAULT '{}',
  job_leads JSONB DEFAULT '[]',
  -- Download URLs (S3 signed URLs or paths)
  audit_report_url TEXT,
  ninety_day_plan_url TEXT,
  smart_resume_url TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_audit_runs_developer ON audit_runs(developer_id);
CREATE INDEX IF NOT EXISTS idx_audit_runs_status ON audit_runs(status);
CREATE INDEX IF NOT EXISTS idx_code_analyses_audit ON code_analyses(audit_run_id);
CREATE INDEX IF NOT EXISTS idx_market_matches_audit ON market_matches(audit_run_id);
CREATE INDEX IF NOT EXISTS idx_market_matches_score ON market_matches(similarity_score DESC);
CREATE INDEX IF NOT EXISTS idx_job_postings_source ON job_postings(source, scraped_at DESC);
`;

export async function migrate() {
  const client = await pool.connect();
  try {
    logger.info('Running database migration...');
    await client.query(SCHEMA);
    logger.info('Migration complete.');
  } catch (err) {
    logger.error('Migration failed', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// Run directly: node src/db/migrate.js
if (process.argv[1].endsWith('migrate.js')) {
  migrate().then(() => process.exit(0)).catch(() => process.exit(1));
}
