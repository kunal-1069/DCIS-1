import fs from 'fs';
import path from 'path';
import { query } from '../db/pool.js';
import { logger } from '../config/logger.js';

// ── Skill taxonomy ────────────────────────────────────────────────────────────
// Canonical skill list for normalisation (extensible)
const SKILL_TAXONOMY = {
  // Languages
  javascript: ['javascript', 'js', 'ecmascript', 'es6', 'es2015'],
  typescript: ['typescript', 'ts'],
  python: ['python', 'python3', 'py'],
  java: ['java', 'java 8', 'java 11', 'java 17'],
  'c#': ['c#', 'csharp', 'dotnet', '.net', 'asp.net'],
  go: ['go', 'golang'],
  rust: ['rust', 'rustlang'],
  ruby: ['ruby', 'ruby on rails', 'rails', 'ror'],
  php: ['php', 'php8'],
  swift: ['swift'],
  kotlin: ['kotlin'],
  // Frontend
  react: ['react', 'react.js', 'reactjs', 'react native'],
  vue: ['vue', 'vue.js', 'vuejs', 'vue 3'],
  angular: ['angular', 'angularjs', 'angular 2+'],
  nextjs: ['next.js', 'nextjs', 'next'],
  svelte: ['svelte', 'sveltekit'],
  // Backend
  nodejs: ['node', 'node.js', 'nodejs', 'express', 'fastify', 'koa'],
  django: ['django', 'django rest framework', 'drf'],
  fastapi: ['fastapi', 'fast api'],
  spring: ['spring', 'spring boot', 'spring mvc'],
  // Databases
  postgresql: ['postgresql', 'postgres', 'pg', 'psql'],
  mysql: ['mysql', 'mariadb'],
  mongodb: ['mongodb', 'mongo', 'mongoose'],
  redis: ['redis', 'ioredis'],
  elasticsearch: ['elasticsearch', 'elastic', 'opensearch'],
  // Cloud / DevOps
  aws: ['aws', 'amazon web services', 'ec2', 's3', 'lambda', 'rds', 'ecs', 'eks'],
  gcp: ['gcp', 'google cloud', 'google cloud platform', 'gke'],
  azure: ['azure', 'microsoft azure'],
  docker: ['docker', 'dockerfile', 'docker-compose', 'containers'],
  kubernetes: ['kubernetes', 'k8s', 'kubectl', 'helm'],
  terraform: ['terraform', 'iac', 'infrastructure as code'],
  // Testing
  jest: ['jest', 'jest.js'],
  pytest: ['pytest', 'unittest', 'nose'],
  cypress: ['cypress', 'cypress.io'],
  // Other
  graphql: ['graphql', 'apollo', 'relay'],
  rest: ['rest', 'restful', 'rest api', 'rest apis'],
  kafka: ['kafka', 'apache kafka', 'confluent'],
  rabbitmq: ['rabbitmq', 'amqp'],
  git: ['git', 'github', 'gitlab', 'bitbucket', 'version control'],
  linux: ['linux', 'ubuntu', 'centos', 'bash', 'shell scripting'],
  'machine learning': ['machine learning', 'ml', 'deep learning', 'pytorch', 'tensorflow', 'scikit-learn'],
};

function buildSkillIndex() {
  const index = {};
  for (const [canonical, aliases] of Object.entries(SKILL_TAXONOMY)) {
    for (const alias of aliases) {
      index[alias.toLowerCase()] = canonical;
    }
  }
  return index;
}

const SKILL_INDEX = buildSkillIndex();

// ── PDF text extraction ───────────────────────────────────────────────────────

async function extractPdfText(filePath) {
  // Dynamic import since pdf-parse doesn't always play nice with ESM
  try {
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } catch {
    // Fallback: read raw bytes and extract printable ASCII runs
    logger.warn('pdf-parse unavailable, using fallback extraction');
    const buffer = fs.readFileSync(filePath);
    const text = buffer.toString('latin1').replace(/[^\x20-\x7E\n\r]/g, ' ').replace(/\s+/g, ' ');
    return text;
  }
}

// ── Skill extraction ──────────────────────────────────────────────────────────

function extractSkills(text) {
  const lower = text.toLowerCase();
  const found = new Set();

  for (const [alias, canonical] of Object.entries(SKILL_INDEX)) {
    // Word boundary matching
    const regex = new RegExp(`(?<![a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i');
    if (regex.test(lower)) {
      found.add(canonical);
    }
  }

  return Array.from(found).sort();
}

function extractYearsExperience(text) {
  // Look for patterns like "5 years", "5+ years", "five years of experience"
  const patterns = [
    /(\d+)\+?\s*years?\s+(?:of\s+)?(?:professional\s+)?experience/i,
    /(\d+)\+?\s*yrs?\s+(?:of\s+)?experience/i,
    /experience[:\s]+(\d+)\+?\s*years?/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}

function extractEducation(text) {
  const degrees = [];
  const degreePatterns = [
    /(?:b\.?s\.?|bachelor(?:'s)?(?:\s+of\s+\w+)?|b\.?e\.?|b\.?tech\.?)[\s,]+(?:in\s+)?([^\n,]{5,60})/gi,
    /(?:m\.?s\.?|master(?:'s)?(?:\s+of\s+\w+)?|m\.?e\.?|m\.?tech\.?|mba)[\s,]+(?:in\s+)?([^\n,]{5,60})/gi,
    /ph\.?d\.?[\s,]+(?:in\s+)?([^\n,]{5,60})/gi,
  ];
  for (const p of degreePatterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      degrees.push({ degree: m[0].split(/[\s,]/)[0].trim(), field: m[1]?.trim() });
    }
  }
  return degrees.slice(0, 3);
}

function extractPreviousRoles(text) {
  const roles = [];
  // Look for job title patterns
  const rolePatterns = [
    /(?:senior|lead|principal|staff|junior|mid)?\s*(?:software|backend|frontend|full[ -]?stack|devops|platform|data|ml|cloud)?\s*(?:engineer|developer|architect|scientist|analyst)/gi,
    /(?:engineering|product|technical)\s+(?:manager|director|lead|vp|head)/gi,
    /(?:cto|ceo|cpo|vp engineering|head of engineering)/gi,
  ];
  for (const p of rolePatterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const role = m[0].trim().replace(/\s+/g, ' ');
      if (role.length > 4 && !roles.includes(role)) {
        roles.push(role);
      }
    }
  }
  return roles.slice(0, 5);
}

// ── Main service ──────────────────────────────────────────────────────────────

export async function parseResume(auditRunId, filePath, originalFilename) {
  logger.info('Starting resume parse', { auditRunId, filePath });

  const rawText = await extractPdfText(filePath);
  const claimedSkills = extractSkills(rawText);
  const yearsExperience = extractYearsExperience(rawText);
  const education = extractEducation(rawText);
  const previousRoles = extractPreviousRoles(rawText);

  const result = {
    original_filename: originalFilename,
    raw_text: rawText.slice(0, 10000), // cap stored text
    claimed_skills: claimedSkills,
    years_experience: yearsExperience,
    education,
    previous_roles: previousRoles,
  };

  await query(
    `INSERT INTO resume_parses
      (audit_run_id, original_filename, raw_text, claimed_skills, years_experience, education, previous_roles)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      auditRunId,
      originalFilename,
      result.raw_text,
      JSON.stringify(claimedSkills),
      yearsExperience,
      JSON.stringify(education),
      JSON.stringify(previousRoles),
    ]
  );

  // Clean up temp file
  try { fs.unlinkSync(filePath); } catch {}

  logger.info('Resume parse complete', { auditRunId, skills: claimedSkills.length });
  return result;
}
