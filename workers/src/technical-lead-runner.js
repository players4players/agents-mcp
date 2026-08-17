import { getAuthToken } from './github-app-auth.js';

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || await getAuthToken();
process.env.TECHNICAL_LEAD_CORE_REPOSITORY = process.env.TECHNICAL_LEAD_CORE_REPOSITORY || 'OWNER/agents-mcp';

await import('../automate/scripts/technical-lead-pr-finalizer.mjs');
