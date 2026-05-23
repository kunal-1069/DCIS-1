import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { query } from '../db/pool.js';

const GH_API = 'https://api.github.com';

const ghClient = axios.create({
  baseURL: GH_API,
  headers: {
    Authorization: `Bearer ${config.github.token}`,
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  timeout: 15000,
});

// Exponential backoff retry for rate limits
async function ghGet(url, params = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await ghClient.get(url, { params });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 403 || status === 429) {
        const reset = err.response?.headers?.['x-ratelimit-reset'];
        const waitMs = reset
          ? Math.max((parseInt(reset) * 1000) - Date.now(), 0)
          : Math.pow(2, attempt) * 2000;
        logger.warn(`GitHub rate limited. Waiting ${waitMs}ms`, { attempt });
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }
}

// ── Core fetchers ─────────────────────────────────────────────────────────────

export async function fetchUserProfile(username) {
  logger.info('Fetching GitHub user profile', { username });
  return ghGet(`/users/${username}`);
}

export async function fetchRepositories(username) {
  logger.info('Fetching repositories', { username });
  const repos = [];
  let page = 1;
  while (true) {
    const batch = await ghGet(`/users/${username}/repos`, {
      per_page: 100, page, sort: 'updated', type: 'owner',
    });
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return repos;
}

export async function fetchCommitActivity(username, repo) {
  try {
    // Get commit activity for the last 52 weeks
    const weeklyData = await ghGet(`/repos/${username}/${repo}/stats/commit_activity`);
    return weeklyData || [];
  } catch {
    return [];
  }
}

export async function fetchPullRequests(username, repo) {
  try {
    const prs = await ghGet(`/repos/${username}/${repo}/pulls`, {
      state: 'all', per_page: 30, sort: 'updated',
    });
    return prs || [];
  } catch {
    return [];
  }
}

// ── Analysis functions ────────────────────────────────────────────────────────

function analyseCommitFrequency(weeklyCommitData) {
  if (!weeklyCommitData?.length) return { avg_per_week: 0, total_90d: 0, peak_week: 0 };
  const last13 = weeklyCommitData.slice(-13); // 13 weeks = 90 days
  const total = last13.reduce((sum, w) => sum + (w?.total || 0), 0);
  const peak = Math.max(...last13.map(w => w?.total || 0));
  return {
    avg_per_week: Math.round(total / 13),
    total_90d: total,
    peak_week: peak,
    weekly_breakdown: last13.map(w => ({ week: w?.week, commits: w?.total || 0 })),
  };
}

function analysePRCommunicationStyle(prs) {
  if (!prs?.length) return { avg_title_length: 0, avg_body_length: 0, style_score: 0 };

  const titlesWithBody = prs.filter(pr => pr.body && pr.body.length > 0);
  const avgTitleLen = Math.round(prs.reduce((s, pr) => s + (pr.title?.length || 0), 0) / prs.length);
  const avgBodyLen = Math.round(titlesWithBody.reduce((s, pr) => s + pr.body.length, 0) / (titlesWithBody.length || 1));

  // Score 0-10: longer descriptions = more communicative
  const styleScore = Math.min(10, Math.round(
    (avgBodyLen / 100) * 5 + (titlesWithBody.length / prs.length) * 5
  ));

  // Vocabulary richness — unique word ratio in titles
  const allWords = prs.flatMap(pr => pr.title?.toLowerCase().split(/\s+/) || []);
  const uniqueRatio = allWords.length ? new Set(allWords).size / allWords.length : 0;

  return {
    total_prs: prs.length,
    prs_with_description: titlesWithBody.length,
    avg_title_length: avgTitleLen,
    avg_body_length: avgBodyLen,
    vocabulary_richness: Math.round(uniqueRatio * 100) / 100,
    style_score: styleScore,
    sample_titles: prs.slice(0, 5).map(pr => pr.title),
  };
}

function extractLanguages(repos) {
  const langCount = {};
  for (const repo of repos) {
    if (repo.language) {
      langCount[repo.language] = (langCount[repo.language] || 0) + 1;
    }
  }
  return Object.entries(langCount)
    .sort(([, a], [, b]) => b - a)
    .map(([lang, count]) => ({ language: lang, repo_count: count }));
}

// ── Main ingestion orchestrator ───────────────────────────────────────────────

export async function ingestGitHubProfile(auditRunId, username) {
  logger.info('Starting GitHub ingestion', { auditRunId, username });

  const [userProfile, repositories] = await Promise.all([
    fetchUserProfile(username),
    fetchRepositories(username),
  ]);

  // Only deeply analyse the top 5 most recently updated repos to stay within time limits
  const topRepos = repositories.slice(0, 5);

  const repoDetails = await Promise.all(
    topRepos.map(async (repo) => {
      const [commitActivity, pullRequests] = await Promise.all([
        fetchCommitActivity(username, repo.name),
        fetchPullRequests(username, repo.name),
      ]);
      return {
        name: repo.name,
        description: repo.description,
        url: repo.html_url,
        clone_url: repo.clone_url,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        language: repo.language,
        topics: repo.topics || [],
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        size_kb: repo.size,
        open_issues: repo.open_issues_count,
        has_readme: repo.has_wiki,
        commit_frequency: analyseCommitFrequency(commitActivity),
        pr_style: analysePRCommunicationStyle(pullRequests),
      };
    })
  );

  // Aggregate commit frequency across all top repos
  const aggregateCommitFreq = {
    total_90d: repoDetails.reduce((s, r) => s + r.commit_frequency.total_90d, 0),
    avg_per_week: Math.round(
      repoDetails.reduce((s, r) => s + r.commit_frequency.avg_per_week, 0) / (repoDetails.length || 1)
    ),
    most_active_repo: repoDetails.sort((a, b) =>
      b.commit_frequency.total_90d - a.commit_frequency.total_90d
    )[0]?.name,
  };

  // Average PR style across repos
  const prStyles = repoDetails.map(r => r.pr_style);
  const aggregatePRStyle = {
    avg_style_score: Math.round(
      prStyles.reduce((s, p) => s + p.style_score, 0) / (prStyles.length || 1)
    ),
    avg_body_length: Math.round(
      prStyles.reduce((s, p) => s + p.avg_body_length, 0) / (prStyles.length || 1)
    ),
    total_prs_analysed: prStyles.reduce((s, p) => s + p.total_prs, 0),
  };

  const languages = extractLanguages(repositories);

  const profileData = {
    username,
    public_repos: userProfile.public_repos,
    followers: userProfile.followers,
    account_created_at: userProfile.created_at,
    languages,
    repositories: repoDetails,
    commit_frequency: aggregateCommitFreq,
    pr_communication_style: aggregatePRStyle,
    raw_data: {
      bio: userProfile.bio,
      blog: userProfile.blog,
      location: userProfile.location,
      hireable: userProfile.hireable,
    },
  };

  // Persist to PostgreSQL
  await query(
    `INSERT INTO github_profiles
      (audit_run_id, username, public_repos, followers, account_created_at,
       languages, repositories, commit_frequency, pr_communication_style, raw_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING`,
    [
      auditRunId,
      profileData.username,
      profileData.public_repos,
      profileData.followers,
      profileData.account_created_at,
      JSON.stringify(profileData.languages),
      JSON.stringify(profileData.repositories),
      JSON.stringify(profileData.commit_frequency),
      JSON.stringify(profileData.pr_communication_style),
      JSON.stringify(profileData.raw_data),
    ]
  );

  logger.info('GitHub ingestion complete', { auditRunId, repos: repoDetails.length });
  return profileData;
}
