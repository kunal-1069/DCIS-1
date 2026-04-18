import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger.js';

// ── Pattern definitions ───────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/, severity: 'critical' },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret|secret_access_key)\s*[=:]\s*['"][A-Za-z0-9/+=]{40}['"]/, severity: 'critical' },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/, severity: 'critical' },
  { name: 'Generic API Key', pattern: /(?:api_key|apikey|api-key)\s*[=:]\s*['"][A-Za-z0-9_\-]{20,}['"]/, severity: 'high', ignoreCase: true },
  { name: 'Generic Password', pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{6,}['"]/, severity: 'high', ignoreCase: true },
  { name: 'Generic Secret', pattern: /(?:secret|token)\s*[=:]\s*['"][A-Za-z0-9_\-]{16,}['"]/, severity: 'high', ignoreCase: true },
  { name: 'Database URL with credentials', pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@/, severity: 'critical' },
  { name: 'GitHub Token', pattern: /(?:ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{36}/, severity: 'critical' },
  { name: 'JWT Secret hardcoded', pattern: /jwt\.sign\([^,]+,\s*['"][^'"]{8,}['"]/, severity: 'high' },
  { name: 'OpenAI API Key', pattern: /sk-[A-Za-z0-9]{48}/, severity: 'critical' },
];

const VULNERABILITY_PATTERNS = [
  {
    name: 'SQL Injection via string concatenation',
    pattern: /(?:query|execute|db\.run|pool\.query)\s*\(\s*(?:`|'|")[^`'"]*\$\{|(?:query|execute)\s*\(\s*['"`][^'"`]+'\s*\+/,
    severity: 'critical',
    description: 'User input appears to be concatenated directly into a SQL query.',
  },
  {
    name: 'Use of eval()',
    pattern: /\beval\s*\(/,
    severity: 'high',
    description: 'eval() executes arbitrary code and is a severe security risk.',
  },
  {
    name: 'Insecure HTTP usage',
    pattern: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    severity: 'medium',
    description: 'Non-localhost HTTP (not HTTPS) detected. Use HTTPS in production.',
  },
  {
    name: 'Disabled HTTPS cert verification',
    pattern: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False/,
    severity: 'high',
    description: 'SSL/TLS certificate verification is disabled.',
  },
  {
    name: 'Command injection risk',
    pattern: /exec\s*\(\s*[`'"][^`'"]*\$\{|execSync\s*\(\s*[`'"][^`'"]*\$\{/,
    severity: 'critical',
    description: 'User-controlled data may be passed to shell exec.',
  },
  {
    name: 'XSS via innerHTML',
    pattern: /\.innerHTML\s*=(?!=)/,
    severity: 'medium',
    description: 'Setting innerHTML with potentially unsanitised data can cause XSS.',
  },
  {
    name: 'Path traversal risk',
    pattern: /readFile(?:Sync)?\s*\([^)]*req\.|readFile(?:Sync)?\s*\([^)]*params\./,
    severity: 'high',
    description: 'User-controlled input used in file path operations.',
  },
  {
    name: 'Prototype pollution risk',
    pattern: /\.__proto__|Object\.assign\s*\(\s*{},\s*req\./,
    severity: 'medium',
    description: 'Potential prototype pollution vector detected.',
  },
  {
    name: 'Weak cryptography (MD5/SHA1)',
    pattern: /createHash\s*\(\s*['"](?:md5|sha1)['"]\)/,
    severity: 'medium',
    description: 'MD5 and SHA1 are cryptographically broken. Use SHA-256+.',
  },
  {
    name: 'Debug/verbose logging in code',
    pattern: /console\.log\s*\(|print\s*\(f?['"](?:password|secret|token|key)/i,
    severity: 'low',
    description: 'Sensitive data may be logged.',
  },
];

// ── File scanner ──────────────────────────────────────────────────────────────

function scanFile(filePath, relativePath) {
  const findings = [];
  let lines;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    lines = content.split('\n');
  } catch {
    return findings;
  }

  // Skip minified files (single very long line)
  if (lines.length === 1 && lines[0].length > 5000) return findings;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Secret detection
    for (const { name, pattern, severity, ignoreCase } of SECRET_PATTERNS) {
      const regex = new RegExp(pattern.source, ignoreCase ? 'i' : '');
      if (regex.test(line)) {
        findings.push({
          type: 'secret',
          name,
          severity,
          file: relativePath,
          line: lineIdx + 1,
          // Never store the actual secret value
          context: `Line ${lineIdx + 1}: [REDACTED - potential secret detected]`,
        });
      }
    }

    // Vulnerability detection
    for (const { name, pattern, severity, description } of VULNERABILITY_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          type: 'vulnerability',
          name,
          severity,
          file: relativePath,
          line: lineIdx + 1,
          description,
          context: line.trim().slice(0, 120),
        });
      }
    }
  }

  return findings;
}

function walkDir(dir, extensions, maxFiles = 300) {
  const results = [];
  function walk(current) {
    if (results.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || ['node_modules', '__pycache__', 'dist', 'build', '.git'].includes(e.name)) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (extensions.some(ext => e.name.endsWith(ext))) results.push(full);
    }
  }
  walk(dir);
  return results;
}

// ── Main scanner ──────────────────────────────────────────────────────────────

export async function scanSecurity(repoPath, repoName) {
  logger.info('Starting security scan', { repoPath, repoName });

  const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.env', '.json', '.yaml', '.yml', '.sh'];
  const files = walkDir(repoPath, extensions);

  const allFindings = [];
  for (const file of files) {
    const relative = path.relative(repoPath, file);
    const findings = scanFile(file, relative);
    allFindings.push(...findings);
  }

  // Deduplicate identical findings (same name + file + line)
  const deduped = allFindings.filter((f, idx, arr) =>
    arr.findIndex(g => g.name === f.name && g.file === f.file && g.line === f.line) === idx
  );

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  deduped.sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));

  const report = {
    repo: repoName,
    summary: {
      files_scanned: files.length,
      total_findings: deduped.length,
      by_severity: {
        critical: deduped.filter(f => f.severity === 'critical').length,
        high: deduped.filter(f => f.severity === 'high').length,
        medium: deduped.filter(f => f.severity === 'medium').length,
        low: deduped.filter(f => f.severity === 'low').length,
      },
      has_secrets: deduped.some(f => f.type === 'secret'),
      has_critical_vulns: deduped.some(f => f.severity === 'critical'),
    },
    findings: deduped.slice(0, 50), // cap at 50 for report size
    patterns_checked: SECRET_PATTERNS.length + VULNERABILITY_PATTERNS.length,
  };

  logger.info('Security scan complete', { repoName, findings: deduped.length });
  return report;
}
