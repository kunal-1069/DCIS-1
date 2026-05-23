import 'dotenv/config';

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000'),
    env: process.env.NODE_ENV || 'development',
  },
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    name: process.env.DB_NAME || 'dev_audit',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  github: {
    token: process.env.GITHUB_TOKEN,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large',
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o',
  },
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY,
    indexName: process.env.PINECONE_INDEX_NAME || 'dev-audit-jobs',
    dimension: parseInt(process.env.PINECONE_DIMENSION || '3072'),
  },
  s3: {
    region: process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'dev-audit-outputs',
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
  },
  scraping: {
    linkedinEnabled: process.env.LINKEDIN_SCRAPE_ENABLED === 'true',
    greenhouseEnabled: process.env.GREENHOUSE_API_ENABLED !== 'false',
    levelsFyiCacheTtl: parseInt(process.env.LEVELS_FYI_CACHE_TTL || '604800'),
  },
};
