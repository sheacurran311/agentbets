#!/usr/bin/env node
/**
 * Manual script to post the AgentBets introduction to m/agentbets on Moltbook.
 *
 * Usage:
 *   MOLTBOOK_BOT_API_KEY=your-key node post-intro.js
 *
 * Or if the env var is already set:
 *   node post-intro.js
 *
 * Options:
 *   --force    Post even if the submolt already has posts
 *   --dry-run  Show what would be posted without actually posting
 */

const MoltbookService = require('./src/moltbook.js');

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');

  if (!process.env.MOLTBOOK_BOT_API_KEY) {
    console.error('Error: MOLTBOOK_BOT_API_KEY environment variable is required');
    console.error('Usage: MOLTBOOK_BOT_API_KEY=your-key node post-intro.js');
    process.exit(1);
  }

  const moltbook = new MoltbookService();

  if (!moltbook.enabled) {
    console.error('Moltbook service is not enabled. Check your API key.');
    process.exit(1);
  }

  // Verify identity
  console.log('Verifying Moltbook identity...');
  const me = await moltbook.getMe();
  if (me.success) {
    console.log(`Authenticated as: ${moltbook.botName}`);
  } else {
    console.warn(`Could not verify identity: ${me.error}`);
    console.warn('Proceeding anyway...');
  }

  // Check if submolt exists
  console.log('Checking submolt m/agentbets...');
  const submolt = await moltbook.ensureSubmolt();
  if (!submolt.success) {
    console.error(`Failed to ensure submolt exists: ${submolt.error}`);
    process.exit(1);
  }

  // Check if already has posts
  if (!force) {
    const hasPosts = await moltbook.submoltHasPosts();
    if (hasPosts) {
      console.log('Submolt m/agentbets already has posts. Use --force to post anyway.');
      process.exit(0);
    }
  }

  if (dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log('Would post the introduction to m/agentbets.');
    console.log('Run without --dry-run to actually post.\n');
    process.exit(0);
  }

  // Post the introduction
  console.log('Posting introduction to m/agentbets...');
  const result = await moltbook.postIntroduction();

  if (result.success) {
    console.log('Introduction posted successfully!');
    console.log(`Post ID: ${result.id || result.data?.id || 'unknown'}`);
    console.log('View it at: https://www.moltbook.com/m/agentbets');
  } else {
    console.error(`Failed to post: ${result.error}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
