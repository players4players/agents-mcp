import { getAuthToken } from './github-app-auth.js';

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || await getAuthToken();
process.env.CTO_CORE_REPOSITORY = process.env.CTO_CORE_REPOSITORY || '<env.OWNER>/agents-mcp';

await import('../automate/scripts/cto-project-supervisor.mjs');
