import crypto from 'crypto';
import { spawn } from 'child_process';
import logger from './logger.js';

/**
 * GitHub Webhook Handler for Investment Co-Pilot Deployment
 */

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const DEPLOY_SCRIPT = '/opt/invest-copilot/deploy-invest.sh';
const TARGET_BRANCH = process.env.DEPLOY_BRANCH || 'main';

/**
 * Verify GitHub webhook signature
 */
function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET) {
    logger.warn('GITHUB_WEBHOOK_SECRET not set, skipping signature verification');
    return true;
  }

  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(JSON.stringify(payload)).digest('hex');
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(digest)
    );
  } catch (error) {
    logger.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Execute deployment script
 */
function executeDeploy(sha, branch) {
  return new Promise((resolve, reject) => {
    logger.info(`Starting deployment: ${branch}@${sha}`);
    
    const deploy = spawn('sudo', ['/bin/bash', DEPLOY_SCRIPT], {
      env: {
        ...process.env,
        INVEST_BRANCH: branch
      },
      detached: true,
      stdio: 'ignore'
    });

    deploy.unref();

    // Don't wait for deployment to complete
    resolve({
      success: true,
      message: 'Deployment started in background',
      sha,
      branch
    });
  });
}

/**
 * Webhook handler middleware
 */
export async function handleDeployWebhook(req, res) {
  try {
    // Verify signature
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('No signature provided');
      return res.status(401).json({ error: 'No signature provided' });
    }

    if (!verifySignature(req.body, signature)) {
      logger.warn('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { ref, repository, head_commit } = req.body;

    // Verify it's a push to the target branch
    const branch = ref?.replace('refs/heads/', '');
    if (branch !== TARGET_BRANCH) {
      logger.info(`Ignoring push to branch: ${branch}`);
      return res.json({ 
        message: `Ignoring push to ${branch}, only deploying ${TARGET_BRANCH}` 
      });
    }

    const repoName = repository?.full_name;
    const sha = head_commit?.id;
    const message = head_commit?.message;
    const author = head_commit?.author?.name;

    logger.info(`Received push event: ${repoName}@${branch} by ${author}`);
    logger.info(`Commit: ${sha?.substring(0, 7)} - ${message}`);

    // Execute deployment
    const result = await executeDeploy(sha, branch);

    res.json({
      success: true,
      deployment: result,
      commit: {
        sha: sha?.substring(0, 7),
        message,
        author,
        branch
      }
    });

  } catch (error) {
    logger.error('Webhook handler error:', error);
    res.status(500).json({ 
      error: 'Deployment failed', 
      message: error.message 
    });
  }
}

/**
 * Manual deployment trigger
 */
export async function triggerManualDeploy(req, res) {
  try {
    const { branch = TARGET_BRANCH } = req.body;

    logger.info(`Manual deployment triggered for branch: ${branch}`);

    const result = await executeDeploy('manual', branch);

    res.json({
      success: true,
      deployment: result,
      message: `Deployment of ${branch} started`
    });

  } catch (error) {
    logger.error('Manual deploy error:', error);
    res.status(500).json({ 
      error: 'Deployment failed', 
      message: error.message 
    });
  }
}

export default {
  handleDeployWebhook,
  triggerManualDeploy
};