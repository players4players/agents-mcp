import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  githubRetryConfig,
  isRetriableGraphQLErrors,
  isRetriableStatus,
  retryAsync,
  retryableError,
} from '../../src/retry.js';

const GITHUB_API_URL = 'https://api.github.com/graphql';
const REST_API_URL = 'https://api.github.com';

const AGENT_LABELS = {
  developer: 'agent:developer',
  security: 'agent:security',
  qa: 'agent:qa',
  devops: 'agent:devops',
  sysadmin: 'agent:sysadmin',
};

const ALL_AGENT_LABELS = Object.values(AGENT_LABELS);
const RETRY = githubRetryConfig('FLOW');
const LABEL_META = {
  'agent:developer': { color: 'facc15', description: 'Task marcada para a etapa de Developer' },
  'agent:security': { color: 'd1242f', description: 'Task marcada para a etapa de Security' },
  'agent:qa': { color: 'facc15', description: 'Task marcada para a etapa de QA' },
  'agent:devops': { color: 'fb8c00', description: 'Task marcada para a etapa de DevOps' },
  'agent:sysadmin': { color: '94a3b8', description: 'Task marcada para acompanhamento do Sysadmin' },
  'agent:technical-documenter': {
    color: 'f59e0b',
    description: 'Task marcada para a etapa de Technical Documenter',
  },
  'agent:tutorial-assistant': {
    color: '0ea5e9',
    description: 'Task marcada para a etapa de Tutorial Assistant',
  },
};
const COMMENT_MARKER_PREFIX = 'cto-mcp-flow-sync';
const COMMENT_TYPES = {
  seedDeveloper: 'seed-developer',
  routeConflictToDevops: 'route-conflict-to-devops',
  syncReviewPair: 'sync-review-pair',
  cleanupAssignees: 'cleanup-assignees',
  cleanupReview: 'cleanup-review',
};

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
        response = await fetch(GITHUB_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'OWNER-agent-flow-sync',
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
    { label: 'GitHub GraphQL flow sync', ...RETRY }
  );
}

async function githubRest(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');

  return retryAsync(
    async () => {
      let response;
      try {
        response = await fetch(`${REST_API_URL}${path}`, {
          ...options,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'OWNER-agent-flow-sync',
            ...(options.headers || {}),
          },
        });
      } catch (error) {
        throw retryableError(`GitHub REST request failed: ${error.message || error}`);
      }

      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        const message = JSON.stringify({ status: response.status, path, body: text }, null, 2);
        if (isRetriableStatus(response.status)) {
          throw retryableError(message);
        }
        throw new Error(message);
      }
      if (!response.ok) {
        const message = JSON.stringify({ status: response.status, path, body }, null, 2);
        if (isRetriableStatus(response.status)) {
          throw retryableError(message);
        }
        throw new Error(message);
      }
      return body;
    },
    { label: `GitHub REST flow sync ${path}`, ...RETRY }
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
                comments(last:10) {
                  nodes {
                    body
                  }
                }
                labels(first:20) {
                  nodes {
                    name
                  }
                }
                assignees(first:20) {
                  nodes {
                    login
                  }
                }
                repository {
                  id
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
                          mergeable
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

function hasReviewDecisionLabel(labels) {
  const decisionLabels = new Set([
    'qa:accepted',
    'qa:rejected',
    'security:accepted',
    'security:rejected',
  ]);
  return labels.some((label) => decisionLabels.has(label));
}

function assigneeLogins(issue) {
  return (issue.assignees?.nodes || [])
    .map((assignee) => (assignee?.login || '').trim())
    .filter(Boolean);
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

function openPullRequests(issue) {
  return normalizePullRequests(issue).filter((pr) => pr?.state === 'OPEN');
}

function openPullRequestsInSameRepository(issue) {
  const repoFullName = issue.repository?.nameWithOwner;
  return openPullRequests(issue).filter((pr) => pr?.repository?.nameWithOwner === repoFullName);
}

function isConflictingOrBlockedMergeable(mergeable) {
  return mergeable === false || mergeable === 'CONFLICTING';
}

function hasConflictingPullRequestInSameRepository(issue) {
  return openPullRequestsInSameRepository(issue).some((pr) => isConflictingOrBlockedMergeable(pr?.mergeable));
}

function recentComments(issue) {
  return issue.comments?.nodes || [];
}

function commentSignature(payload) {
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

function buildCommentMarker(type, signature) {
  return `<!-- ${COMMENT_MARKER_PREFIX}:${type}:${signature} -->`;
}

function hasRecentCommentMarker(issue, type, signature) {
  const marker = buildCommentMarker(type, signature);
  return recentComments(issue).some((comment) => (comment?.body || '').includes(marker));
}

function statusMatches(status, allowedStatuses) {
  const normalized = (status || '').trim().toLowerCase();
  return allowedStatuses.some((entry) => entry.toLowerCase() === normalized);
}

async function ensureLabelExists(repoFullName, labelName) {
  const [owner, repo] = repoFullName.split('/');
  const meta = LABEL_META[labelName] || { color: '1f6feb', description: labelName };
  try {
    await githubRest(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({
        name: labelName,
        color: meta.color,
        description: meta.description,
      }),
    });
  } catch (error) {
    const payload = JSON.parse(error.message || '{}');
    if (payload.status !== 422) throw error;
  }
}

async function replaceIssueLabels(repoFullName, issueNumber, nextLabels) {
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'PUT',
    body: JSON.stringify(nextLabels),
  });
}

async function removeIssueAssignees(repoFullName, issueNumber, assignees) {
  if (!assignees.length) return;
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, {
    method: 'DELETE',
    body: JSON.stringify({ assignees }),
  });
}

async function addIssueComment(issueId, body) {
  return githubGraphQL(
    `mutation($subjectId:ID!, $body:String!) {
      addComment(input:{subjectId:$subjectId, body:$body}) {
        commentEdge {
          node {
            id
          }
        }
      }
    }`,
    { subjectId: issueId, body }
  );
}

function buildDeveloperSeedComment(issueRef, signature) {
  return [
    '### Fluxo iniciado por tags',
    '',
    `Issue: ${issueRef}`,
    'Ação: a task entrou em `Ready` ou `Working` sem `agent:*`, então a trilha oficial marcou `agent:developer` como primeira etapa.',
    'Próximo passo: o agent `Developer` deve descobrir essa task pela tag e pela coluna, sem uso de assignee.',
    '',
    buildCommentMarker(COMMENT_TYPES.seedDeveloper, signature),
  ].join('\n');
}

function buildConflictComment(issueRef, signature) {
  return [
    '### Fluxo redirecionado para DevOps',
    '',
    `Issue: ${issueRef}`,
    'Motivo: foi detectado PR aberto com conflito no mesmo repositório da issue/composição.',
    'Ação: a responsabilidade atual foi marcada com `agent:devops`; a captura deve acontecer pela tag e pela coluna `Deploy`, sem assignee.',
    '',
    buildCommentMarker(COMMENT_TYPES.routeConflictToDevops, signature),
  ].join('\n');
}

function buildReviewPairComment(issueRef, signature, nextLabels) {
  return [
    '### Sincronizacao da fase compartilhada',
    '',
    `Issue: ${issueRef}`,
    `Ação: a task estava em revisão com apenas parte das labels esperadas; o fluxo completou a fase compartilhada com ${nextLabels.map((label) => `\`${label}\``).join(' e ')}.`,
    'Próximo passo: QA e Security continuam a atuar apenas por labels e comentario na issue.',
    '',
    buildCommentMarker(COMMENT_TYPES.syncReviewPair, signature),
  ].join('\n');
}

function buildAssigneeCleanupComment(issueRef, signature) {
  return [
    '### Limpeza de atribuicoes',
    '',
    `Issue: ${issueRef}`,
    'Ação: os assignees foram removidos porque a captura de trabalho agora acontece apenas por tags e coluna.',
    '',
    buildCommentMarker(COMMENT_TYPES.cleanupAssignees, signature),
  ].join('\n');
}

function buildReviewCleanupComment(issueRef, signature) {
  return [
    '### Limpeza final de fluxo',
    '',
    `Issue: ${issueRef}`,
    'Ação: a task entrou em `In Review`, então as tags `agent:*` residuais foram removidas para deixar o estado final coerente.',
    '',
    buildCommentMarker(COMMENT_TYPES.cleanupReview, signature),
  ].join('\n');
}

function serializeItem(item) {
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
    },
    projectItemId: item.id,
    currentProjectStatus: getStatusValue(item),
    labels: issueLabels(issue),
    currentAgentLabel: currentAgentLabel(issue),
    assignees: assigneeLogins(issue),
    openPullRequests: pullRequests
      .filter((pr) => pr?.state === 'OPEN')
      .map((pr) => ({
        ref: `${pr.repository.nameWithOwner}#${pr.number}`,
        url: pr.url,
        mergeable: pr.mergeable,
      })),
  };
}

function writeOutputFile(payload) {
  const outDir = env('FLOW_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/agent-flow-sync.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('FLOW_PROJECT_ORG', 'OWNER');
  const projectNumber = Number(env('FLOW_PROJECT_NUMBER', '1'));
  const dryRun = env('FLOW_DRY_RUN', 'true').toLowerCase() !== 'false';
  const workStatuses = parseCsv(env('FLOW_WORK_STATUSES', 'Ready,Working'));
  const deployStatuses = parseCsv(env('FLOW_DEPLOY_STATUSES', 'Deploy'));
  const inReviewStatuses = parseCsv(env('FLOW_IN_REVIEW_STATUSES', 'In Review'));
  const doneStatuses = parseCsv(env('FLOW_DONE_STATUSES', 'Done'));

  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);

  const items = project.items?.nodes || [];
  const result = {
    generatedAt: new Date().toISOString(),
    dryRun,
    project: {
      org,
      number: projectNumber,
      id: project.id,
      title: project.title,
    },
    workStatuses,
    deployStatuses,
    inReviewStatuses,
    doneStatuses,
    actions: [],
  };

  for (const item of items) {
    const issue = item.content;
    if (!issue?.repository?.nameWithOwner) continue;

    const issueRef = `${issue.repository.nameWithOwner}#${issue.number}`;
    const status = getStatusValue(item);
    const labels = issueLabels(issue);
    const stageLabel = currentAgentLabel(issue);
    const assignees = assigneeLogins(issue);
    const record = serializeItem(item);

    if (assignees.length > 0 && (statusMatches(status, workStatuses) || statusMatches(status, deployStatuses))) {
      const signature = commentSignature({
        type: COMMENT_TYPES.cleanupAssignees,
        issueRef,
        assignees: [...assignees].sort(),
        status,
      });
      const duplicateComment = hasRecentCommentMarker(issue, COMMENT_TYPES.cleanupAssignees, signature);
      const action = {
        type: 'cleanup-assignees',
        issue: record.issue,
        assignees,
        skippedDuplicateComment: duplicateComment,
      };
      result.actions.push(action);
      if (!dryRun) {
        await removeIssueAssignees(issue.repository.nameWithOwner, issue.number, assignees);
        if (!duplicateComment) {
          await addIssueComment(issue.id, buildAssigneeCleanupComment(issueRef, signature));
        }
      }
    }

    if (
      statusMatches(status, workStatuses) &&
      !stageLabel &&
      !hasConflictingPullRequestInSameRepository(issue)
    ) {
      const nextLabels = [...new Set([...labels, AGENT_LABELS.developer])];
      const signature = commentSignature({
        type: COMMENT_TYPES.seedDeveloper,
        issueRef,
        nextLabels: [...nextLabels].sort(),
        status,
      });
      const duplicateComment = hasRecentCommentMarker(issue, COMMENT_TYPES.seedDeveloper, signature);
      const action = {
        type: 'seed-developer',
        issue: record.issue,
        previewLabels: nextLabels,
        skippedDuplicateComment: duplicateComment,
      };
      result.actions.push(action);
      if (!dryRun) {
        await ensureLabelExists(issue.repository.nameWithOwner, AGENT_LABELS.developer);
        await replaceIssueLabels(issue.repository.nameWithOwner, issue.number, nextLabels);
        if (!duplicateComment) {
          await addIssueComment(issue.id, buildDeveloperSeedComment(issueRef, signature));
        }
      }
      continue;
    }

    if (
      statusMatches(status, workStatuses) &&
      !hasConflictingPullRequestInSameRepository(issue) &&
      (labels.includes(AGENT_LABELS.qa) || labels.includes(AGENT_LABELS.security))
    ) {
      const hasQaLabel = labels.includes(AGENT_LABELS.qa);
      const hasSecurityLabel = labels.includes(AGENT_LABELS.security);
      const missingLabels = [];
      if (!hasQaLabel) missingLabels.push(AGENT_LABELS.qa);
      if (!hasSecurityLabel) missingLabels.push(AGENT_LABELS.security);

      if (missingLabels.length > 0 && !hasReviewDecisionLabel(labels)) {
        const nextLabels = [...new Set([...labels, ...missingLabels])];
        const signature = commentSignature({
          type: COMMENT_TYPES.syncReviewPair,
          issueRef,
          nextLabels: [...nextLabels].sort(),
          status,
        });
        const duplicateComment = hasRecentCommentMarker(issue, COMMENT_TYPES.syncReviewPair, signature);
        const action = {
          type: 'sync-review-pair',
          issue: record.issue,
          previewLabels: nextLabels,
          skippedDuplicateComment: duplicateComment,
        };
        result.actions.push(action);
        if (!dryRun) {
          await ensureLabelExists(issue.repository.nameWithOwner, AGENT_LABELS.qa);
          await ensureLabelExists(issue.repository.nameWithOwner, AGENT_LABELS.security);
          await replaceIssueLabels(issue.repository.nameWithOwner, issue.number, nextLabels);
          if (!duplicateComment) {
            await addIssueComment(issue.id, buildReviewPairComment(issueRef, signature, missingLabels));
          }
        }
      }
    }

    if (
      statusMatches(status, workStatuses) &&
      hasConflictingPullRequestInSameRepository(issue) &&
      stageLabel !== AGENT_LABELS.devops
    ) {
      const nextLabels = [...new Set([...labels.filter((label) => !ALL_AGENT_LABELS.includes(label)), AGENT_LABELS.devops])];
      const signature = commentSignature({
        type: COMMENT_TYPES.routeConflictToDevops,
        issueRef,
        nextLabels: [...nextLabels].sort(),
      });
      const duplicateComment = hasRecentCommentMarker(issue, COMMENT_TYPES.routeConflictToDevops, signature);
      const action = {
        type: 'route-conflict-to-devops',
        issue: record.issue,
        previewLabels: nextLabels,
        skippedDuplicateComment: duplicateComment,
      };
      result.actions.push(action);
      if (!dryRun) {
        await ensureLabelExists(issue.repository.nameWithOwner, AGENT_LABELS.devops);
        await replaceIssueLabels(issue.repository.nameWithOwner, issue.number, nextLabels);
        if (!duplicateComment) {
          await addIssueComment(issue.id, buildConflictComment(issueRef, signature));
        }
      }
      continue;
    }

    if ((statusMatches(status, inReviewStatuses) || statusMatches(status, doneStatuses)) && stageLabel) {
      const nextLabels = labels.filter((label) => !ALL_AGENT_LABELS.includes(label));
      const signature = commentSignature({
        type: COMMENT_TYPES.cleanupReview,
        issueRef,
        nextLabels: [...nextLabels].sort(),
        status,
      });
      const duplicateComment = hasRecentCommentMarker(issue, COMMENT_TYPES.cleanupReview, signature);
      const action = {
        type: 'cleanup-stage-labels',
        issue: record.issue,
        previewLabels: nextLabels,
        skippedDuplicateComment: duplicateComment,
      };
      result.actions.push(action);
      if (!dryRun) {
        await replaceIssueLabels(issue.repository.nameWithOwner, issue.number, nextLabels);
        if (!duplicateComment) {
          await addIssueComment(issue.id, buildReviewCleanupComment(issueRef, signature));
        }
      }
    }
  }

  result.actionCount = result.actions.length;
  const outPath = writeOutputFile(result);
  console.log(JSON.stringify({ ok: true, dryRun, actionCount: result.actions.length, outPath }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
