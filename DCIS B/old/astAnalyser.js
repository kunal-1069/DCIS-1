import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../config/logger.js';

// ── Thresholds ────────────────────────────────────────────────────────────────
const THRESHOLDS = {
  FUNCTION_MAX_LINES: 50,
  CYCLOMATIC_COMPLEXITY: 10,
  MAX_NESTING_DEPTH: 4,
  MAX_PARAMS: 5,
};

// ── JavaScript/TypeScript AST analysis via Node.js built-in ──────────────────

function countLines(node, src) {
  if (!node.loc) return 0;
  return node.loc.end.line - node.loc.start.line + 1;
}

function estimateCyclomaticComplexity(sourceText) {
  // Count branch points: if, else if, for, while, case, &&, ||, ?, catch
  const branchKeywords = /\b(if|else if|for|while|switch|case|catch|\?\?|&&|\|\|)\b/g;
  const matches = sourceText.match(branchKeywords);
  return 1 + (matches ? matches.length : 0);
}

function estimateNestingDepth(sourceText) {
  let depth = 0;
  let maxDepth = 0;
  for (const ch of sourceText) {
    if (ch === '{') { depth++; maxDepth = Math.max(maxDepth, depth); }
    else if (ch === '}') { depth = Math.max(0, depth - 1); }
  }
  return maxDepth;
}

function extractFunctionMetrics(sourceText, filename) {
  const functions = [];
  // Match function declarations, arrow functions, class methods
  const funcPatterns = [
    /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
    /(\w+)\s*\([^)]*\)\s*\{/g,
  ];

  const lines = sourceText.split('\n');
  const seen = new Set();

  for (const pattern of funcPatterns) {
    let m;
    while ((m = pattern.exec(sourceText)) !== null) {
      const name = m[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);

      // Find the line number
      const before = sourceText.slice(0, m.index);
      const lineNum = before.split('\n').length;

      // Estimate function body by finding matching brace
      const bodyStart = sourceText.indexOf('{', m.index);
      if (bodyStart === -1) continue;

      let depth = 0, i = bodyStart;
      for (; i < Math.min(sourceText.length, bodyStart + 5000); i++) {
        if (sourceText[i] === '{') depth++;
        else if (sourceText[i] === '}') { depth--; if (depth === 0) break; }
      }
      const bodyText = sourceText.slice(bodyStart, i + 1);
      const lineCount = bodyText.split('\n').length;
      const complexity = estimateCyclomaticComplexity(bodyText);
      const nesting = estimateNestingDepth(bodyText);
      const paramMatch = m[0].match(/\(([^)]*)\)/);
      const paramCount = paramMatch?.[1]?.split(',').filter(p => p.trim()).length || 0;

      const flags = [];
      if (lineCount > THRESHOLDS.FUNCTION_MAX_LINES) flags.push('too_long');
      if (complexity > THRESHOLDS.CYCLOMATIC_COMPLEXITY) flags.push('high_complexity');
      if (nesting > THRESHOLDS.MAX_NESTING_DEPTH) flags.push('deep_nesting');
      if (paramCount > THRESHOLDS.MAX_PARAMS) flags.push('too_many_params');

      functions.push({
        name,
        file: filename,
        line: lineNum,
        line_count: lineCount,
        cyclomatic_complexity: complexity,
        nesting_depth: nesting,
        param_count: paramCount,
        flags,
      });
    }
  }

  return functions;
}

// ── Python analysis via subprocess (uses Python's ast module) ─────────────────

function analyseWithPythonAST(filePath) {
  const script = `
import ast, json, sys
src = open(sys.argv[1]).read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)

results = []
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        lines = node.end_lineno - node.lineno + 1
        params = len(node.args.args)
        flags = []
        if lines > ${THRESHOLDS.FUNCTION_MAX_LINES}: flags.append("too_long")
        if params > ${THRESHOLDS.MAX_PARAMS}: flags.append("too_many_params")
        results.append({"name": node.name, "line": node.lineno, "line_count": lines, "param_count": params, "flags": flags})

print(json.dumps(results))
`;

  try {
    const tmpScript = path.join(os.tmpdir(), `ast_${Date.now()}.py`);
    fs.writeFileSync(tmpScript, script);
    const result = spawnSync('python3', [tmpScript, filePath], { timeout: 10000, encoding: 'utf8' });
    fs.unlinkSync(tmpScript);
    if (result.stdout) return JSON.parse(result.stdout);
    return [];
  } catch {
    return [];
  }
}

// ── Repo walker ───────────────────────────────────────────────────────────────

function walkDir(dir, extensions, maxFiles = 200) {
  const results = [];
  function walk(current) {
    if (results.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some(e => entry.name.endsWith(e))) results.push(full);
    }
  }
  walk(dir);
  return results;
}

// ── Main analyser ─────────────────────────────────────────────────────────────

export async function analyseRepository(repoPath, repoName) {
  logger.info('Starting AST analysis', { repoPath, repoName });

  const jsFiles = walkDir(repoPath, ['.js', '.ts', '.jsx', '.tsx']);
  const pyFiles = walkDir(repoPath, ['.py']);

  const allFunctions = [];
  const fileMetrics = [];

  // JS/TS analysis
  for (const file of jsFiles.slice(0, 100)) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      const funcs = extractFunctionMetrics(src, path.relative(repoPath, file));
      allFunctions.push(...funcs);
      fileMetrics.push({
        file: path.relative(repoPath, file),
        language: 'javascript/typescript',
        lines: src.split('\n').length,
        functions: funcs.length,
        flagged_functions: funcs.filter(f => f.flags.length > 0).length,
      });
    } catch { /* skip unreadable files */ }
  }

  // Python analysis
  for (const file of pyFiles.slice(0, 100)) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      const funcs = analyseWithPythonAST(file).map(f => ({
        ...f,
        file: path.relative(repoPath, file),
        cyclomatic_complexity: estimateCyclomaticComplexity(src),
        nesting_depth: estimateNestingDepth(src),
      }));
      allFunctions.push(...funcs);
      fileMetrics.push({
        file: path.relative(repoPath, file),
        language: 'python',
        lines: src.split('\n').length,
        functions: funcs.length,
        flagged_functions: funcs.filter(f => f.flags.length > 0).length,
      });
    } catch { /* skip */ }
  }

  const flaggedFunctions = allFunctions.filter(f => f.flags.length > 0);
  const avgComplexity = allFunctions.length
    ? Math.round(allFunctions.reduce((s, f) => s + (f.cyclomatic_complexity || 0), 0) / allFunctions.length)
    : 0;

  const report = {
    repo: repoName,
    summary: {
      total_files_analysed: jsFiles.length + pyFiles.length,
      total_functions: allFunctions.length,
      flagged_functions: flaggedFunctions.length,
      avg_cyclomatic_complexity: avgComplexity,
      languages: {
        javascript_typescript: jsFiles.length,
        python: pyFiles.length,
      },
    },
    flagged_functions: flaggedFunctions.slice(0, 30), // top 30 worst offenders
    file_metrics: fileMetrics.slice(0, 50),
    thresholds_used: THRESHOLDS,
  };

  logger.info('AST analysis complete', { repoName, total: allFunctions.length, flagged: flaggedFunctions.length });
  return report;
}
