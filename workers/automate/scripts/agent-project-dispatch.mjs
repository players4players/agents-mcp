import fs from 'node:fs';
import {
  githubRetryConfig,
  isRetriableGraphQLErrors,
  isRetriableStatus,
  retryAsync,
  retryableError,
} from '../../src/retry.js';

const GITHUB_API_URL = 'https://api.github.com/graphql';

const ROLE_META = {
  developer: {
    displayName: 'Developer',
    label: 'agent:developer',
  },
  security: {
    displayName: 'Security',
    label: 'agent:security',
  },
  qa: {
    displayName: 'Quality Assurance',
    label: 'agent:qa',
  },
  devops: {
    displayName: 'DevOps',
    label: 'agent:devops',
  },
};

const ALL_AGENT_LABELS = [
  'agent:developer',
  'agent:security',
  'agent:qa',
  'agent:devops',
  'agent:sysadmin',
];

const RETRY = githubRetryConfig('AGENT');

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function parseCsv(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getRole() {
  const role = env('AGENT_DISPATCH_ROLE');
  if (!ROLE_META[role]) {
    throw new Error(`Unsupported AGENT_DISPATCH_ROLE: ${role}`);
  }
  return role;
}

function getToken() {
  return env('GITHUB_TOKEN') || env('GH_TOKEN');
}

async function githubGraphQL(query, variables = {}) {
  const token = getToken();
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');

  return retryAsync(
    async () => {
      let response;
      try {
        response = await fetch(GITHUB_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': '<env.OWNER>-agent-dispatch',
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (error) {
        throw retryableError(`GitHub GraphQL request failed: ${error.message || error}`);
      }

      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        const message = JSON.stringify({ status: response.status, body: text }, null, 2);
        if (isRetriableStatus(response.status)) {
          throw retryableError(message);
        }
        throw new Error(message);
      }
      if (!response.ok || json.errors) {
        const message = JSON.stringify({ status: response.status, errors: json.errors || json }, null, 2);
        if ((!response.ok && isRetriableStatus(response.status)) || isRetriableGraphQLErrors(json.errors)) {
          throw retryableError(message);
        }
        throw new Error(message);
      }

      return json.data;
    },
    { label: 'GitHub GraphQL dispatch', ...RETRY }
  );
}

async function getProjectSnapshot(org, projectNumber) {
  const query = `query($org:String!, $projectNumber:Int!, $cursor:String) {
    organization(login:$org) {
      projectV2(number:$projectNumber) {
        id
        title
        items(first:100, after:$cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            fieldValues(first:20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    ... on ProjectV2SingleSelectField {
                      id
                      name
                    }
                  }
                }
              }
            }
            content {
              ... on Issue {
                id
                number
                title
                url
                state
                createdAt
                updatedAt
                labels(first:20) {
                  nodes {
                    name
                  }
                }
                repository {
                  id
                  nameWithOwner
                }
              }
            }
          }
        }
      }
    }
  }`;

  const firstPage = await githubGraphQL(query, { org, projectNumber, cursor: null });
  const project = firstPage?.organization?.projectV2;
  if (!project) return firstPage;

  const items = [...(project.items?.nodes || [])];
  let pageInfo = project.items?.pageInfo;

  while (pageInfo?.hasNextPage && pageInfo.endCursor) {
    const page = await githubGraphQL(query, { org, projectNumber, cursor: pageInfo.endCursor });
    const nextItems = page?.organization?.projectV2?.items?.nodes || [];
    items.push(...nextItems);
    pageInfo = page?.organization?.projectV2?.items?.pageInfo;
  }

  project.items.nodes = items;
  return firstPage;
}

function getStatusValue(item) {
  const value = item.fieldValues?.nodes?.find(
    (node) => node?.field?.name?.toLowerCase() === 'status'
  );
  return value?.name || null;
}

function issueLabels(issue) {
  return (issue.labels?.nodes || []).map((label) => label?.name).filter(Boolean);
}

function currentAgentLabel(issue) {
  return issueLabels(issue).find((label) => ALL_AGENT_LABELS.includes(label)) || null;
}

function hasAgentLabel(issue, label) {
  return issueLabels(issue).includes(label);
}

function hasRejectedReview(issue) {
  const labels = new Set(issueLabels(issue));
  return labels.has('qa:rejected') || labels.has('security:rejected');
}

function issuePriority(issue) {
  const labels = new Set(issueLabels(issue));
  if (labels.has('bug')) return 0;
  if (hasRejectedReview(issue)) return 1;
  if (labels.has('enhancement')) return 2;
  if (labels.has('feature')) return 3;
  return 4;
}

function sortByCreatedAt(items) {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.content?.createdAt || '') || 0;
    const rightTs = Date.parse(right.content?.createdAt || '') || 0;
    return leftTs - rightTs;
  });
}

function statusMatches(status, allowedStatuses) {
  const normalized = (status || '').trim().toLowerCase();
  return allowedStatuses.some((entry) => entry.toLowerCase() === normalized);
}

function isEligibleForRole(item, role, workStatuses, deployStatuses) {
  const issue = item.content;
  if (!issue?.repository?.nameWithOwner) return false;

  const stageLabel = currentAgentLabel(issue);
  const status = getStatusValue(item);

  if (role === 'developer') {
    return statusMatches(status, workStatuses) && (!stageLabel || stageLabel === ROLE_META.developer.label);
  }

  if (role === 'devops') {
    return statusMatches(status, deployStatuses) && stageLabel === ROLE_META.devops.label;
  }

  return statusMatches(status, workStatuses) && hasAgentLabel(issue, ROLE_META[role].label);
}

function serializeItem(item) {
  const issue = item.content;
  return {
    issue: {
      id: issue.id,
      ref: `${issue.repository.nameWithOwner}#${issue.number}`,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    },
    projectItemId: item.id,
    currentProjectStatus: getStatusValue(item),
    labels: issueLabels(issue),
    currentAgentLabel: currentAgentLabel(issue),
  };
}

function writeOutputFile(payload) {
  const outDir = env('AGENT_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/agent-project-dispatch-${payload.role}.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const role = getRole();
  const meta = ROLE_META[role];
  const org = env('AGENT_PROJECT_ORG', '<env.OWNER>');
  const projectNumber = Number(env('AGENT_PROJECT_NUMBER', '1'));
  const dryRun = env('AGENT_DRY_RUN', 'true').toLowerCase() !== 'false';
  const workStatuses = parseCsv(env('AGENT_WORK_STATUSES', 'Ready,Working'));
  const deployStatuses = parseCsv(env('AGENT_DEPLOY_STATUSES', 'Deploy'));

  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);

  const items = sortByCreatedAt(project.items?.nodes || []);
  const candidateItems = items.filter((item) => isEligibleForRole(item, role, workStatuses, deployStatuses));
  if (role === 'developer') {
    candidateItems.sort((left, right) => {
      const leftPriority = issuePriority(left.content);
      const rightPriority = issuePriority(right.content);
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      const leftTs = Date.parse(left.content?.createdAt || '') || 0;
      const rightTs = Date.parse(right.content?.createdAt || '') || 0;
      return leftTs - rightTs;
    });
  }

  const result = {
    generatedAt: new Date().toISOString(),
    role,
    dryRun,
    project: {
      org,
      number: projectNumber,
      id: project.id,
      title: project.title,
    },
    roleLabel: meta.label,
    workStatuses,
    deployStatuses,
    candidateCount: candidateItems.length,
    candidateItems: candidateItems.map((item) => serializeItem(item)),
    selectedItem: candidateItems.length > 0 ? serializeItem(candidateItems[0]) : null,
  };

  if (candidateItems.length === 0) {
    result.ok = true;
    result.skipped = true;
    result.reason = `Nenhuma task elegivel por tags e coluna foi encontrada para ${meta.displayName}.`;
    const outPath = writeOutputFile(result);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason, outPath }, null, 2));
    return;
  }

  result.ok = true;
  result.discoveryMode = 'labels-and-columns-only';
  result.reason = 'Selecao concluida sem uso de assignee, fallback tecnico, comentario automatico ou gate por open/closed.';
  const outPath = writeOutputFile(result);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        role,
        selectedIssue: result.selectedItem?.issue?.ref || null,
        discoveryMode: result.discoveryMode,
        outPath,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
