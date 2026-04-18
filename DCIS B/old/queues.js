import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const redisConfig = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null, // required by BullMQ
};

// Shared Redis connection for BullMQ
export const redisConnection = new IORedis(redisConfig);

// Separate client for direct Redis operations (caching etc.)
export const redisClient = new IORedis(redisConfig);

redisClient.on('error', (err) => logger.error('Redis client error', { error: err.message }));
redisConnection.on('error', (err) => logger.error('Redis BullMQ error', { error: err.message }));

// ── Queue names ──────────────────────────────────────────────────────────────
export const QUEUES = {
  GITHUB_INGESTION: 'github-ingestion',
  LIVE_AUDIT: 'live-audit',
  RESUME_PARSE: 'resume-parse',
  CODE_ANALYSIS: 'code-analysis',
  LLM_REVIEW: 'llm-review',
  MARKET_MATCH: 'market-match',
  JOB_SCRAPE: 'job-scrape',
  OUTPUT_GENERATION: 'output-generation',
};

// Default job options
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

// ── Queues ───────────────────────────────────────────────────────────────────
export const githubQueue = new Queue(QUEUES.GITHUB_INGESTION, {
  connection: redisConnection,
  defaultJobOptions,
});

export const liveAuditQueue = new Queue(QUEUES.LIVE_AUDIT, {
  connection: redisConnection,
  defaultJobOptions,
});

export const resumeParseQueue = new Queue(QUEUES.RESUME_PARSE, {
  connection: redisConnection,
  defaultJobOptions,
});

export const codeAnalysisQueue = new Queue(QUEUES.CODE_ANALYSIS, {
  connection: redisConnection,
  defaultJobOptions,
});

export const llmReviewQueue = new Queue(QUEUES.LLM_REVIEW, {
  connection: redisConnection,
  defaultJobOptions,
});

export const marketMatchQueue = new Queue(QUEUES.MARKET_MATCH, {
  connection: redisConnection,
  defaultJobOptions,
});

export const jobScrapeQueue = new Queue(QUEUES.JOB_SCRAPE, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 5 },
});

export const outputGenerationQueue = new Queue(QUEUES.OUTPUT_GENERATION, {
  connection: redisConnection,
  defaultJobOptions,
});

// ── Cache helpers ─────────────────────────────────────────────────────────────
export async function cacheGet(key) {
  const val = await redisClient.get(key);
  return val ? JSON.parse(val) : null;
}

export async function cacheSet(key, value, ttlSeconds = 3600) {
  await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

export async function cacheDel(key) {
  await redisClient.del(key);
}
