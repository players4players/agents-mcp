import fs from 'node:fs';
import {
  githubRetryConfig,
  isRetriableGraphQLErrors,
  isRetriableStatus,
  retryAsync,
  retryableError,
} from '../../src/retry.js';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const RETRY = githubRetryConfig('DEVELOPER_PR_DISPATCH');
const DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS = 'OWNER,MEMBER,COLLABORATOR';
const DEFAULT_WORK_STATUSES = 'Ready,Working';
const DEVELOPER_LABEL = 'agent:developer';
const ALL_AGENT_LABELS = [
  'agent:developer',
  'agent:security',
  'agent:qa',
  'agent:devops',
  'agent:sysadmin',
];
const QA_ACCEPTED_LABEL = 'qa:accepted';
const QA_REJECTED_LABEL = 'qa:rejected';
const SECURITY_ACCEPTED_LABEL = 'security:accepted';
const SECURITY_REJECTED_LABEL = 'security:rejected';
const BUG_LABEL = 'bug';
const IMPROVEMENT_LABEL = 'enhancement';
const FEATURE_LABEL = 'feature';

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function parseCsv(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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
        response = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'OWNER-developer-pr-dispatch',
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
        if (isRetriableStatus(response.status)) throw retryableError(message);
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
    { label: 'GitHub GraphQL developer PR dispatch', ...RETRY }
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
                authorAssociation
                author {
                  login
                }
                labels(first:50) {
                  nodes {
                    name
                  }
                }
                repository {
                  nameWithOwner
                }
                timelineItems(first:50, itemTypes:[CROSS_REFERENCED_EVENT]) {
                  nodes {
                    ... on CrossReferencedEvent {
                      source {
                        __typename
                        ... on PullRequest {
                          id
                          number
                          title
                          url
                          state
                          isDraft
                          baseRefName
                          headRefName
                          labels(first:20) {
                            nodes {
                              name
                            }
                          }
                          repository {
                            nameWithOwner
                          }
                        }
                      }
                    }
                  }
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
    items.push(...(page?.organization?.projectV2?.items?.nodes || []));
    pageInfo = page?.organization?.projectV2?.items?.pageInfo;
  }

  project.items.nodes = items;
  return firstPage;
}

function issueLabels(issue) {
  return (issue.labels?.nodes || []).map((label) => label?.name).filter(Boolean);
}

function getProjectStatus(item) {
  const statusValue = item.fieldValues?.nodes?.find((node) => node?.field?.name?.toLowerCase() === 'status');
  return statusValue?.name || null;
}

function pullRequestLabels(pr) {
  return (pr.labels?.nodes || []).map((label) => label?.name).filter(Boolean);
}

function normalizePullRequests(issue) {
  const seen = new Set();
  const pullRequests = [];
  for (const node of issue.timelineItems?.nodes || []) {
    const pr = node?.source;
    if (!pr || pr.__typename !== 'PullRequest') continue;
    const key = `${pr.repository?.nameWithOwner || ''}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pullRequests.push(pr);
  }
  return pullRequests;
}

function sortByCreatedAt(items) {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.content?.createdAt || '') || 0;
    const rightTs = Date.parse(right.content?.createdAt || '') || 0;
    return leftTs - rightTs;
  });
}

function authorIsEligible(issue, allowedAssociations) {
  return allowedAssociations.has((issue.authorAssociation || '').toUpperCase());
}

function isOpenPullRequest(pr) {
  return pr?.state === 'OPEN';
}

function prIsRejected(pr) {
  const labels = new Set(pullRequestLabels(pr));
  return labels.has(QA_REJECTED_LABEL) || labels.has(SECURITY_REJECTED_LABEL);
}

function prIsFullyApproved(pr) {
  const labels = new Set(pullRequestLabels(pr));
  return labels.has(QA_ACCEPTED_LABEL) && labels.has(SECURITY_ACCEPTED_LABEL);
}

function prIsPendingQaOrSecurity(pr) {
  return isOpenPullRequest(pr) && !prIsRejected(pr) && !prIsFullyApproved(pr);
}

function currentAgentLabels(issue) {
  return issueLabels(issue).filter((label) => ALL_AGENT_LABELS.includes(label));
}

function hasRejectedReview(issue) {
  const labels = new Set(issueLabels(issue));
  return labels.has(QA_REJECTED_LABEL) || labels.has(SECURITY_REJECTED_LABEL);
}

function issuePriority(issue) {
  const labels = new Set(issueLabels(issue));
  if (labels.has(BUG_LABEL)) return 0;
  if (hasRejectedReview(issue)) return 1;
  if (labels.has(IMPROVEMENT_LABEL)) return 2;
  if (labels.has(FEATURE_LABEL)) return 3;
  return 4;
}

function issueBelongsToDeveloper(issue) {
  const agentLabels = currentAgentLabels(issue);
  if (agentLabels.length === 0) return true;
  return agentLabels.every((label) => label === DEVELOPER_LABEL);
}

function issueInWorkStatus(item, workStatuses) {
  const currentStatus = (getProjectStatus(item) || '').trim();
  if (!currentStatus) return true;
  return workStatuses.has(currentStatus.toLowerCase());
}

function serializeIssue(item) {
  const issue = item.content;
  const pullRequests = normalizePullRequests(issue);
  return {
    issue: {
      id: issue.id,
      ref: `${issue.repository.nameWithOwner}#${issue.number}`,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      authorLogin: issue.author?.login || null,
      authorAssociation: issue.authorAssociation || null,
      labels: issueLabels(issue),
    },
    projectItemId: item.id,
    currentProjectStatus: getProjectStatus(item),
    openPullRequestCount: pullRequests.filter((pr) => pr.state === 'OPEN').length,
    pendingPullRequestCount: pullRequests.filter((pr) => prIsPendingQaOrSecurity(pr)).length,
    pullRequests: pullRequests.map((pr) => ({
      ref: `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`,
      state: pr.state,
      isDraft: Boolean(pr.isDraft),
      baseRefName: pr.baseRefName || null,
      headRefName: pr.headRefName || null,
      labels: pullRequestLabels(pr),
    })),
  };
}

function isDeveloperCandidate(item, allowedAssociations, workStatuses) {
  const issue = item.content;
  if (!issue?.repository?.nameWithOwner) return false;
  if (issue.state !== 'OPEN') return false;
  if (!authorIsEligible(issue, allowedAssociations)) return false;
  if (!issueInWorkStatus(item, workStatuses)) return false;
  if (!issueBelongsToDeveloper(issue)) return false;

  const openPullRequests = normalizePullRequests(issue).filter((pr) => isOpenPullRequest(pr));
  if (openPullRequests.length === 0) return true;

  return openPullRequests.every((pr) => prIsRejected(pr));
}

function writeOutputFile(payload) {
  const outDir = env('DEVELOPER_OUTPUT_DIR', env('AGENT_OUTPUT_DIR', '/tmp'));
  const outPath = `${outDir}/developer-pr-dispatch.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('AGENT_PROJECT_ORG', 'OWNER');
  const projectNumber = Number(env('AGENT_PROJECT_NUMBER', '1'));
  const dryRun = env('DEVELOPER_DRY_RUN', env('AGENT_DRY_RUN', 'true')).toLowerCase() !== 'false';
  const allowedAssociations = new Set(
    parseCsv(env('DEVELOPER_ALLOWED_AUTHOR_ASSOCIATIONS', DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS)).map((value) =>
      value.toUpperCase()
    )
  );
  const workStatuses = new Set(
    parseCsv(env('DEVELOPER_WORK_STATUSES', env('AGENT_WORK_STATUSES', DEFAULT_WORK_STATUSES))).map((value) =>
      value.toLowerCase()
    )
  );

  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);

  const items = sortByCreatedAt(project.items?.nodes || []);
  const candidateItems = items
    .filter((item) => isDeveloperCandidate(item, allowedAssociations, workStatuses))
    .sort((left, right) => {
      const leftPriority = issuePriority(left.content);
      const rightPriority = issuePriority(right.content);
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      const leftTs = Date.parse(left.content?.createdAt || '') || 0;
      const rightTs = Date.parse(right.content?.createdAt || '') || 0;
      return leftTs - rightTs;
    });

  const result = {
    generatedAt: new Date().toISOString(),
    role: 'developer',
    dryRun,
    project: {
      org,
      number: projectNumber,
      id: project.id,
      title: project.title,
    },
    allowedAuthorAssociations: Array.from(allowedAssociations),
    workStatuses: Array.from(workStatuses),
    candidateCount: candidateItems.length,
    candidateItems: candidateItems.map((item) => serializeIssue(item)),
    selectedItem: candidateItems.length > 0 ? serializeIssue(candidateItems[0]) : null,
    discoveryMode: 'open-team-issues-in-work-owned-by-developer-without-pending-qa-security-pr',
  };

  if (candidateItems.length === 0) {
    result.ok = true;
    result.skipped = true;
    result.reason = 'Nenhuma issue aberta de membro da equipe em Ready/Working e pertencente a Developer sem PR pendente de QA/Security foi encontrada.';
    const outPath = writeOutputFile(result);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason, outPath }, null, 2));
    return;
  }

  result.ok = true;
  result.reason = 'Seleção concluída usando issue aberta, autoria de membro da equipe, status em Ready/Working, ownership de Developer e ausência de PR pendente de QA/Security.';
  const outPath = writeOutputFile(result);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
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
