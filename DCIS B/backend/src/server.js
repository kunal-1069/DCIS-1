import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './config/logger.js';
import { config } from './config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static UI files from the frontend directory
app.use(express.static(path.join(__dirname, '../../frontend')));

// Basic health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', environment: config.server.env });
});

// Example route to trigger an audit
app.post('/api/audit', async (req, res) => {
  try {
    const { auditRunId, url } = req.body;
    if (!url || !auditRunId) {
      return res.status(400).json({ error: 'auditRunId and url are required' });
    }
    // In the future: const result = await auditLiveApp(auditRunId, url);
    res.json({ status: 'acknowledged', auditRunId, url, message: 'Audit triggered successfully!' });
  } catch (error) {
    logger.error('Error in /api/audit:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to trigger brutal repository analysis bot
app.post('/api/analyze-repo', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'GitHub repository url is required' });
    }
    
    // We import dynamically to avoid loading Playwright unnecessarily if this route isn't hit
    const { analyzeRepository } = await import('./services/repoAnalyzerService.js');
    
    logger.info('Starting repository analysis', { url });
    const result = await analyzeRepository(url);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ status: 'success', data: result });
  } catch (error) {
    logger.error('Error in /api/analyze-repo:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const PORT = config.server.port || 3000;
app.listen(PORT, () => {
  logger.info(`Server running in ${config.server.env} mode on port ${PORT}`);
});
