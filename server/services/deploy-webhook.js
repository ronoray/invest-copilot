import crypto from 'crypto';
import { writeFileSync } from 'fs';
import logger from './logger.js';

// Support both GITHUB_WEBHOOK_SECRET (preferred) and WEBHOOK_SECRET (legacy)
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
const TARGET_BRANCH = process.env.DEPLOY_BRANCH || 'main';
const TRIGGER_FILE = '/host-tmp/invest-deploy-trigger.json';

function verifySignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) {
    logger.error('GITHUB_WEBHOOK_SECRET not configured — rejecting webhook. Set it in .env to enable auto-deploy.');
    return false;
  }

  // GitHub signs the raw request body bytes — not re-serialized JSON
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch (error) {
    logger.error('Signature verification error:', error);
    return false;
  }
}

function executeDeploy(sha, branch) {
  return new Promise((resolve) => {
    logger.info(`Triggering deployment: ${branch}@${sha}`);
    
    const triggerData = {
      sha,
      branch,
      timestamp: new Date().toISOString(),
      service: 'invest-copilot'
    };
    
    try {
      writeFileSync(TRIGGER_FILE, JSON.stringify(triggerData));
      logger.info('Deployment trigger file written');
      resolve({
        success: true,
        message: 'Deployment queued',
        sha,
        branch
      });
    } catch (error) {
      logger.error('Failed to write trigger file:', error);
      resolve({
        success: false,
        message: 'Failed to queue deployment',
        error: error.message
      });
    }
  });
}

export async function handleDeployWebhook(req, res) {
  try {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('No signature provided');
      return res.status(401).json({ error: 'No signature provided' });
    }

    // Use raw body for HMAC — req.rawBody is set by the express.json verify callback in index.js
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    if (!verifySignature(rawBody, signature)) {
      logger.warn('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { ref, repository, head_commit } = req.body;
    const branch = ref?.replace('refs/heads/', '');
    
    if (branch !== TARGET_BRANCH) {
      logger.info(`Ignoring push to branch: ${branch}`);
      return res.json({ message: `Ignoring push to ${branch}` });
    }

    const sha = head_commit?.id;
    const message = head_commit?.message;
    const author = head_commit?.author?.name;

    logger.info(`Received push event: ${repository?.full_name}@${branch} by ${author}`);
    logger.info(`Commit: ${sha?.substring(0, 7)} - ${message}`);

    const result = await executeDeploy(sha, branch);
    res.json({ success: true, deployment: result });

  } catch (error) {
    logger.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Deployment failed', message: error.message });
  }
}

export async function triggerManualDeploy(req, res) {
  try {
    const { branch = TARGET_BRANCH } = req.body;
    const result = await executeDeploy('manual', branch);
    res.json({ success: true, deployment: result });
  } catch (error) {
    logger.error('Manual deploy error:', error);
    res.status(500).json({ error: 'Deployment failed', message: error.message });
  }
}

export default {
  handleDeployWebhook,
  triggerManualDeploy
};