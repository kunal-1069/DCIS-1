import { chromium } from 'playwright';
import { logger } from '../config/logger.js';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config/index.js';

// Initialize Gemini client
const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

/**
 * Extracts owner and repo name from a GitHub URL
 */
function parseGithubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace('.git', '') };
}

/**
 * Headless bot that crawls the repository using Playwright
 */
async function crawlRepositoryCode(page, owner, repo) {
  logger.info(`Bot is analyzing repository: ${owner}/${repo}`);
  
  // Try to get default branch from main page
  await page.goto(`https://github.com/${owner}/${repo}`, { waitUntil: 'domcontentloaded' });
  const defaultBranch = await page.evaluate(() => {
    // GitHub's branch selector contains the default branch
    const branchSelector = document.querySelector('[data-hotkey="w"] span');
    return branchSelector ? branchSelector.textContent.trim() : 'main';
  }).catch(() => 'main');

  logger.info(`Detected default branch: ${defaultBranch}`);

  // We will use the GitHub API via the browser to get the file tree
  // This avoids getting blocked and is faster than clicking through the UI
  await page.goto(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`);
  const treeContent = await page.evaluate(() => document.body.innerText);
  
  let treeData;
  try {
    treeData = JSON.parse(treeContent);
  } catch (e) {
    throw new Error('Failed to parse repository tree. The repository might be private or invalid.');
  }

  if (!treeData.tree) {
    throw new Error('No files found in the repository.');
  }

  // Filter for interesting code files (skip node_modules, dist, etc.)
  const interestingExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rb', '.php', '.cs'];
  const codeFiles = treeData.tree
    .filter(item => item.type === 'blob')
    .filter(item => {
      const path = item.path.toLowerCase();
      if (path.includes('node_modules/') || path.includes('dist/') || path.includes('build/') || path.includes('vendor/')) {
        return false;
      }
      return interestingExtensions.some(ext => path.endsWith(ext));
    })
    // Limit to 10 files to keep prompt within context limits and analysis fast
    .slice(0, 10);

  logger.info(`Found ${codeFiles.length} files to analyze`);

  const fileContents = [];
  for (const file of codeFiles) {
    logger.info(`Bot is fetching code for: ${file.path}`);
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${file.path}`;
    await page.goto(rawUrl, { waitUntil: 'domcontentloaded' });
    const code = await page.evaluate(() => document.body.innerText);
    fileContents.push({ path: file.path, code });
  }

  return fileContents;
}

/**
 * Sends the extracted code to Gemini for a brutal review
 */
async function generateBrutalReview(fileContents) {
  logger.info('Sending codebase to GenAI for brutal review...');

  let codePrompt = 'Here is the codebase extracted from the repository:\n\n';
  for (const file of fileContents) {
    codePrompt += `--- FILE: ${file.path} ---\n\`\`\`\n${file.code}\n\`\`\`\n\n`;
  }

  const prompt = `
You are a senior, brutally honest code reviewer and architect.
You have been asked to review a developer's repository.
Your task is to:
1. Assess the developer's knowledge based strictly on how the code is written (patterns, anti-patterns, structure, naming).
2. Provide a "brutal review": point out every flaw, bad practice, and area for improvement without sugar-coating it. Be direct but constructive.
3. Provide rewritten versions of the most problematic or important files, but ADD COMMENTS in between the code to make it extremely readable and developer-friendly, explaining WHY the changes were made.

Format your response in Markdown:
# Knowledge Assessment
(Your assessment of their skill level)

# Brutal Review
(Your brutal feedback)

# Code Improvements (with Comments)
(The rewritten code with rich inline comments)

${codePrompt}
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: prompt,
  });

  return response.text;
}

export async function analyzeRepository(repoUrl) {
  const repoInfo = parseGithubUrl(repoUrl);
  if (!repoInfo) {
    throw new Error('Invalid GitHub repository URL');
  }

  let browser;
  try {
    // Launch headless bot
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // 1. Crawl repository
    const fileContents = await crawlRepositoryCode(page, repoInfo.owner, repoInfo.repo);
    
    if (fileContents.length === 0) {
      return { success: false, error: 'No readable code files found in the repository.' };
    }

    // 2. Analyze with AI
    const reviewResult = await generateBrutalReview(fileContents);

    return {
      success: true,
      repo: `${repoInfo.owner}/${repoInfo.repo}`,
      filesAnalyzed: fileContents.map(f => f.path),
      review: reviewResult
    };

  } catch (error) {
    logger.error('Error during repository analysis:', error);
    return { success: false, error: error.message };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
