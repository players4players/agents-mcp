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
const ALL_AGENT_LABELS = ['agent:developer', 'agent:security', 'agent:qa', 'agent:devops'];
const DEFAULT_KNOWN_AGENT_LOGINS = 'github-copilot[bot],copilot-swe-agent,copilot';
const DEFAULT_UNSUPPORTED_LABEL = 'ops:copilot-unavailable';
const DEFAULT_CORE_REPOSITORY = '<<env.OWNER>>/agents-mcp';
const DEFAULT_PRIORITY_REPOSITORIES =
  '<env.OWNER>/app-community,<env.OWNER>/api-community,<env.OWNER>/api-whatsapp';
const DEFAULT_STALE_HOURS = '24';
const DEFAULT_STALE_DRAFT_HOURS = '24';
const DEFAULT_STALE_OPEN_PR_HOURS = '48';
const DEFAULT_PRIORITY_WORKFLOW_RUN_LOOKBACK = '10';
const RETRY = githubRetryConfig('CTO');

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function getToken() {
  return env('GITHUB_TOKEN') || env('GH_TOKEN');
}

function parseCsv(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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
            'User-Agent': '<env.OWNER>-cto-supervisor',
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
    { label: 'GitHub GraphQL CTO supervisor', ...RETRY }
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
            'User-Agent': '<env.OWNER>-cto-supervisor',
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
    { label: `GitHub REST CTO supervisor ${path}`, ...RETRY }
  );
}

async function getProjectSnapshot(org, projectNumber) {
  const query = `query($org:String!, $projectNumber:Int!, $cursor:String) {
    organization(login:$org) {
      projectV2(number:$projectNumber) {
        id
        title
        fields(first:50) {
          nodes {
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2SingleSelectField { id name options { id name } }
          }
        }
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
                labels(first:30) {
                  nodes {
                    name
                  }
                }
                assignees(first:20) {
                  nodes {
                    id
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
                          reviewDecision
                          createdAt
                          updatedAt
                          mergedAt
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

function statusField(project) {
  const field = project.fields.nodes.find((node) => node?.name === 'Status' && node?.options);
  if (!field) throw new Error('Status field not found');
  return field;
}

function getStatusValue(item) {
  const value = item.fieldValues?.nodes?.find((node) => node?.field?.name?.toLowerCase() === 'status');
  return value?.name || null;
}

function issueLabels(issue) {
  return (issue.labels?.nodes || []).map((label) => label?.name).filter(Boolean);
}

function assigneeLogins(issue) {
  return (issue.assignees?.nodes || [])
    .map((assignee) => (assignee?.login || '').trim().toLowerCase())
    .filter(Boolean);
}

function retainedHumanActorIds(issue, knownAgentLogins) {
  return (issue.assignees?.nodes || [])
    .filter((assignee) => {
      const login = (assignee?.login || '').trim().toLowerCase();
      return login && !knownAgentLogins.has(login) && assignee?.id;
    })
    .map((assignee) => assignee.id);
}

function technicalAgentLogins(issue, knownAgentLogins) {
  return [...new Set(
    (issue.assignees?.nodes || [])
      .map((assignee) => (assignee?.login || '').trim().toLowerCase())
      .filter((login) => login && knownAgentLogins.has(login))
  )];
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

function isOpenPullRequest(pr) {
  return pr?.state === 'OPEN';
}

function mergeConflictForPr(pr) {
  return pr?.mergeable === false || pr?.mergeable === 'CONFLICTING';
}

function reviewPendingForPr(pr) {
  return isOpenPullRequest(pr) && !pr?.isDraft && pr?.reviewDecision !== 'APPROVED';
}

function openPullRequestsForSnapshot(snapshot) {
  return (snapshot?.pullRequests || []).filter((pr) => pr?.state === 'OPEN');
}

function projectStatusOptionId(project, statusName) {
  const field = statusField(project);
  const option = field.options.find((node) => node?.name?.toLowerCase() === statusName.toLowerCase());
  if (!option) throw new Error(`Status option not found: ${statusName}`);
  return { fieldId: field.id, optionId: option.id };
}

async function moveProjectItem(project, itemId, targetStatus) {
  const { fieldId, optionId } = projectStatusOptionId(project, targetStatus);
  await githubGraphQL(
    `mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
      updateProjectV2ItemFieldValue(input:{
        projectId:$projectId,
        itemId:$itemId,
        fieldId:$fieldId,
        value:{ singleSelectOptionId:$optionId }
      }) {
        projectV2Item { id }
      }
    }`,
    { projectId: project.id, itemId, fieldId, optionId }
  );
}

async function addIssueComment(issueId, body) {
  await githubGraphQL(
    `mutation($subjectId:ID!, $body:String!) {
      addComment(input:{subjectId:$subjectId, body:$body}) {
        commentEdge { node { id } }
      }
    }`,
    { subjectId: issueId, body }
  );
}

async function replaceAssignableActors(issueId, actorIds) {
  await githubGraphQL(
    `mutation($issueId:ID!, $actorIds:[ID!]!) {
      replaceActorsForAssignable(input: {
        assignableId: $issueId,
        actorIds: $actorIds
      }) {
        assignable {
          ... on Issue {
            id
          }
        }
      }
    }`,
    { issueId, actorIds }
  );
}

async function removeIssueAssignees(repoFullName, issueNumber, assignees) {
  if (!assignees.length) return;
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, {
    method: 'DELETE',
    body: JSON.stringify({ assignees }),
  });
}

async function cleanupBlockedAgentAssignee(issue, knownAgentLogins) {
  const preservedHumanActorIds = retainedHumanActorIds(issue, knownAgentLogins);
  const technicalAssignees = technicalAgentLogins(issue, knownAgentLogins);
  const warnings = [];
  let graphQlCleared = false;
  let restCleared = false;

  try {
    await replaceAssignableActors(issue.id, preservedHumanActorIds);
    graphQlCleared = true;
  } catch (error) {
    warnings.push(`Falha GraphQL ao limpar actor técnico: ${error.message || error}`);
  }

  if (technicalAssignees.length > 0) {
    try {
      await removeIssueAssignees(issue.repository.nameWithOwner, issue.number, technicalAssignees);
      restCleared = true;
    } catch (error) {
      warnings.push(`Falha REST ao remover assignee técnico: ${error.message || error}`);
    }
  }

  return {
    technicalAssignees,
    graphQlCleared,
    restCleared,
    cleared: graphQlCleared || restCleared,
    warnings,
  };
}

function buildComment(issueRef, fromStatus, targetStatus, reasons) {
  return [
    '### Auditoria do CTO - correção estrutural de coluna',
    '',
    `Issue: ${issueRef}`,
    `Ação: a task foi movida de \`${fromStatus}\` para \`${targetStatus}\` pelo supervisor do CTO.`,
    'Motivo: o estado em `Done` era incompatível com o fluxo oficial observado no `cto-mcp`.',
    '',
    'Sinais objetivos:',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    'Regra aplicada: durante `Developer`, `Security`, `Q.A.` e `DevOps` a task permanece em `Ready`; somente `DevOps` move para `In Review`, e `Done` não deve ser usado enquanto ainda houver bloqueio, ownership operacional ativo ou PR aberto sem revisão concluída.',
  ].join('\n');
}

function ageHours(value) {
  const timestamp = Date.parse(value || '');
  if (!timestamp) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 3600000));
}

function normalizeCombinedStatus(payload) {
  const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
  const deduped = [];
  const seenContexts = new Set();
  for (const status of statuses) {
    const context = status?.context || 'unknown';
    if (seenContexts.has(context)) continue;
    seenContexts.add(context);
    deduped.push({
      context,
      state: status?.state || 'unknown',
      description: status?.description || null,
      targetUrl: status?.target_url || null,
      updatedAt: status?.updated_at || null,
    });
  }
  return {
    state: payload?.state || 'unknown',
    totalCount: deduped.length,
    failingContexts: deduped.filter((status) => ['error', 'failure'].includes(status.state)),
    pendingContexts: deduped.filter((status) => ['pending'].includes(status.state)),
    successfulContexts: deduped.filter((status) => status.state === 'success'),
    contexts: deduped,
  };
}

function normalizeWorkflowRun(run) {
  return {
    id: run.id,
    name: run.name,
    displayTitle: run.display_title || null,
    event: run.event || null,
    status: run.status || null,
    conclusion: run.conclusion || null,
    workflowId: run.workflow_id || null,
    runNumber: run.run_number || null,
    headBranch: run.head_branch || null,
    headSha: run.head_sha || null,
    htmlUrl: run.html_url || run.url || null,
    createdAt: run.created_at || null,
    updatedAt: run.updated_at || null,
    ageHours: ageHours(run.updated_at || run.created_at || null),
  };
}

function classifyLatestWorkflowRunState(workflowFiles, actionsCatalog, recentRuns) {
  if (workflowFiles.length === 0) return 'missing-workflow-files';
  if (actionsCatalog.state !== 'available') return 'catalog-unavailable';
  if (actionsCatalog.totalCount === 0) return 'catalog-empty';
  if (recentRuns.errorStatus) return 'runs-unavailable';
  if (recentRuns.totalCount === 0) return 'runs-empty';

  const latest = recentRuns.latestRun;
  if (!latest) return 'runs-empty';
  if (latest.status !== 'completed') return 'latest-run-in-progress';
  if (latest.conclusion === 'success') return 'latest-run-success';
  if (latest.conclusion === 'failure') return 'latest-run-failure';
  if (latest.conclusion === 'cancelled') return 'latest-run-cancelled';
  if (latest.conclusion === 'timed_out') return 'latest-run-timed-out';
  if (latest.conclusion === 'neutral') return 'latest-run-neutral';
  if (latest.conclusion === 'skipped') return 'latest-run-skipped';
  if (latest.conclusion === 'action_required') return 'latest-run-action-required';
  return 'latest-run-other';
}

function serializeItem(item, knownAgentLogins, unsupportedLabel) {
  const issue = item.content;
  const labels = issueLabels(issue);
  const assignees = assigneeLogins(issue);
  const technicalAssignees = technicalAgentLogins(issue, knownAgentLogins);
  const humanAssignees = assignees.filter((login) => !knownAgentLogins.has(login));
  const pullRequests = normalizePullRequests(issue);
  return {
    issue: {
      id: issue.id,
      repository: issue.repository.nameWithOwner,
      ref: `${issue.repository.nameWithOwner}#${issue.number}`,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      ageHours: ageHours(issue.updatedAt),
    },
    projectItemId: item.id,
    currentProjectStatus: getStatusValue(item),
    labels,
    assignees,
    humanAssignees,
    technicalAgentAssignees: technicalAssignees,
    hasAgentLabel: labels.some((label) => ALL_AGENT_LABELS.includes(label)),
    hasUnsupportedLabel: labels.includes(unsupportedLabel),
    hasKnownAgentAssignee: technicalAssignees.length > 0,
    pullRequests: pullRequests.map((pr) => ({
      ref: `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`,
      repository: pr.repository?.nameWithOwner || 'unknown',
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: Boolean(pr.isDraft),
      mergeable: pr.mergeable,
      reviewDecision: pr.reviewDecision,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      ageHours: ageHours(pr.updatedAt),
      mergedAt: pr.mergedAt,
    })),
  };
}

function classifyDoneMismatch(item, knownAgentLogins, unsupportedLabel, workStatus, inReviewStatus, doneStatus) {
  const issue = item.content;
  const currentStatus = getStatusValue(item);
  if (!issue?.repository?.nameWithOwner) return null;
  if (issue.state !== 'OPEN') return null;
  if ((currentStatus || '').toLowerCase() !== doneStatus.toLowerCase()) return null;

  const labels = issueLabels(issue);
  const assignees = assigneeLogins(issue);
  const pullRequests = normalizePullRequests(issue);
  const reasons = [];
  let targetStatus = null;

  if (labels.includes(unsupportedLabel)) {
    reasons.push(`a issue ainda está marcada com \`${unsupportedLabel}\`, sinalizando bloqueio operacional aberto`);
    targetStatus = workStatus;
  }

  const agentLabels = labels.filter((label) => ALL_AGENT_LABELS.includes(label));
  if (agentLabels.length > 0) {
    reasons.push(`a issue ainda carrega label operacional ativo (${agentLabels.join(', ')})`);
    targetStatus = workStatus;
  }

  const agentAssignees = assignees.filter((login) => knownAgentLogins.has(login));
  if (agentAssignees.length > 0) {
    reasons.push(`a issue ainda está atribuída ao agent técnico (${agentAssignees.join(', ')})`);
    targetStatus = workStatus;
  }

  const openPrs = pullRequests.filter((pr) => isOpenPullRequest(pr));
  if (openPrs.length > 0) {
    const refs = openPrs.map((pr) => `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`).join(', ');
    reasons.push(`a issue ainda tem PR aberto vinculado (${refs})`);
    if (!targetStatus) targetStatus = inReviewStatus;
  }

  if (!targetStatus || reasons.length === 0) return null;

  return {
    issueRef: `${issue.repository.nameWithOwner}#${issue.number}`,
    issueId: issue.id,
    itemId: item.id,
    fromStatus: currentStatus,
    targetStatus,
    reasons,
    snapshot: serializeItem(item, knownAgentLogins, unsupportedLabel),
  };
}

function classifyUnsupportedCopilot(item, knownAgentLogins, unsupportedLabel) {
  const issue = item.content;
  if (!issue?.repository?.nameWithOwner) return null;
  if (issue.state !== 'OPEN') return null;
  const labels = issueLabels(issue);
  if (!labels.includes(unsupportedLabel)) return null;
  return serializeItem(item, knownAgentLogins, unsupportedLabel);
}

function summarizeUnsupportedCopilot(blockedIssues) {
  const byRepository = new Map();
  for (const blocked of blockedIssues) {
    const repository = blocked.issue.repository;
    if (!byRepository.has(repository)) {
      byRepository.set(repository, {
        repository,
        issueCount: 0,
        projectStatuses: new Set(),
        issueRefs: [],
        oldestUpdatedAt: null,
        newestUpdatedAt: null,
        openPullRequestCount: 0,
        residualTechnicalAssigneeCount: 0,
      });
    }
    const bucket = byRepository.get(repository);
    bucket.issueCount += 1;
    if (blocked.currentProjectStatus) bucket.projectStatuses.add(blocked.currentProjectStatus);
    bucket.issueRefs.push(blocked.issue.ref);
    if (!bucket.oldestUpdatedAt || Date.parse(blocked.issue.updatedAt) < Date.parse(bucket.oldestUpdatedAt)) {
      bucket.oldestUpdatedAt = blocked.issue.updatedAt;
    }
    if (!bucket.newestUpdatedAt || Date.parse(blocked.issue.updatedAt) > Date.parse(bucket.newestUpdatedAt)) {
      bucket.newestUpdatedAt = blocked.issue.updatedAt;
    }
    bucket.openPullRequestCount += openPullRequestsForSnapshot(blocked).length;
    bucket.residualTechnicalAssigneeCount += blocked.technicalAgentAssignees.length > 0 ? 1 : 0;
  }

  return Array.from(byRepository.values())
    .map((bucket) => ({
      repository: bucket.repository,
      issueCount: bucket.issueCount,
      projectStatuses: Array.from(bucket.projectStatuses).sort(),
      issueRefs: bucket.issueRefs.sort(),
      oldestUpdatedAt: bucket.oldestUpdatedAt,
      oldestAgeHours: ageHours(bucket.oldestUpdatedAt),
      newestUpdatedAt: bucket.newestUpdatedAt,
      newestAgeHours: ageHours(bucket.newestUpdatedAt),
      openPullRequestCount: bucket.openPullRequestCount,
      residualTechnicalAssigneeCount: bucket.residualTechnicalAssigneeCount,
    }))
    .sort((a, b) => a.repository.localeCompare(b.repository));
}

function normalizeRepositoryName(org, repository) {
  return repository.includes('/') ? repository : `${org}/${repository}`;
}

function normalizePriorityRepositories(org, repositories) {
  return repositories.map((repository) => normalizeRepositoryName(org, repository));
}

function classifyPriorityOperationalItem(item, knownAgentLogins, unsupportedLabel, priorityRepositorySet) {
  const snapshot = serializeItem(item, knownAgentLogins, unsupportedLabel);
  if (!priorityRepositorySet.has(snapshot.issue.repository)) return null;
  return snapshot;
}

async function fetchRepositoryWorkflowFiles(repository) {
  const [owner, repo] = repository.split('/');
  try {
    const contents = await githubRest(`/repos/${owner}/${repo}/contents/.github/workflows`);
    if (!Array.isArray(contents)) {
      return { state: 'available', files: [] };
    }
    const files = contents
      .filter((entry) => entry?.type === 'file')
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        sha: entry.sha,
      }));
    return { state: 'available', files };
  } catch (error) {
    const message = error.message || String(error);
    if (message.includes('404')) {
      return { state: 'missing', files: [], errorMessage: 'workflow directory not found' };
    }
    return { state: 'error', files: [], errorMessage: message };
  }
}

async function fetchRepositoryActionsCatalog(repository) {
  const [owner, repo] = repository.split('/');
  try {
    const payload = await githubRest(`/repos/${owner}/${repo}/actions/workflows`);
    const workflows = Array.isArray(payload?.workflows)
      ? payload.workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          path: workflow.path,
          state: workflow.state,
        }))
      : [];
    return {
      state: 'available',
      totalCount: Number(payload?.total_count || workflows.length || 0),
      workflows,
      errorStatus: null,
      errorMessage: null,
    };
  } catch (error) {
    const message = error.message || String(error);
    let errorStatus = null;
    try {
      errorStatus = JSON.parse(message).status || null;
    } catch {
      errorStatus = null;
    }
    return {
      state: 'error',
      totalCount: 0,
      workflows: [],
      errorStatus,
      errorMessage: message,
    };
  }
}

async function fetchRepositoryRecentWorkflowRuns(repository, lookback) {
  const [owner, repo] = repository.split('/');
  const perPage = Math.max(1, Math.min(lookback, 100));
  try {
    const payload = await githubRest(`/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`);
    const runs = Array.isArray(payload?.workflow_runs)
      ? payload.workflow_runs.slice(0, lookback).map((run) => normalizeWorkflowRun(run))
      : [];
    return {
      totalCount: runs.length,
      latestRun: runs[0] || null,
      recentRuns: runs,
      failingRuns: runs.filter((run) => run.conclusion === 'failure'),
      errorStatus: null,
      errorMessage: null,
    };
  } catch (error) {
    const message = error.message || String(error);
    let errorStatus = null;
    try {
      errorStatus = JSON.parse(message).status || null;
    } catch {
      errorStatus = null;
    }
    return {
      totalCount: 0,
      latestRun: null,
      recentRuns: [],
      failingRuns: [],
      errorStatus,
      errorMessage: message,
    };
  }
}

async function fetchPullRequestCombinedStatus(repository, headSha) {
  const [owner, repo] = repository.split('/');
  try {
    const payload = await githubRest(`/repos/${owner}/${repo}/commits/${headSha}/status`);
    return normalizeCombinedStatus(payload);
  } catch (error) {
    return {
      state: 'unavailable',
      totalCount: 0,
      failingContexts: [],
      pendingContexts: [],
      successfulContexts: [],
      contexts: [],
      errorMessage: error.message || String(error),
    };
  }
}

async function fetchPriorityRepositoryPullRequests(repositories) {
  const map = new Map();
  for (const repository of repositories) {
    const [owner, repo] = repository.split('/');
    let pulls = [];
    try {
      const payload = await githubRest(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
      pulls = Array.isArray(payload)
        ? payload.map((pr) => ({
            ref: `${repository}#${pr.number}`,
            repository,
            number: pr.number,
            title: pr.title,
            url: pr.html_url || pr.url,
            state: pr.state,
            isDraft: Boolean(pr.draft),
            mergeable: pr.mergeable,
            reviewDecision: pr.review_decision || null,
            headSha: pr.head?.sha || null,
            headRefName: pr.head?.ref || null,
            baseRefName: pr.base?.ref || null,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            ageHours: ageHours(pr.updated_at),
          }))
        : [];
    } catch {
      pulls = [];
    }

    for (const pr of pulls) {
      if (pr.headSha) {
        pr.combinedStatus = await fetchPullRequestCombinedStatus(repository, pr.headSha);
      } else {
        pr.combinedStatus = {
          state: 'missing-head-sha',
          totalCount: 0,
          failingContexts: [],
          pendingContexts: [],
          successfulContexts: [],
          contexts: [],
        };
      }
    }

    map.set(repository, pulls);
  }
  return map;
}

async function fetchPriorityRepositoryAutomationHealth(repositories, workflowRunLookback) {
  const map = new Map();
  for (const repository of repositories) {
    const [workflowFiles, actionsCatalog, recentWorkflowRuns] = await Promise.all([
      fetchRepositoryWorkflowFiles(repository),
      fetchRepositoryActionsCatalog(repository),
      fetchRepositoryRecentWorkflowRuns(repository, workflowRunLookback),
    ]);
    map.set(repository, {
      workflowFiles: workflowFiles.files || [],
      workflowFilesState: workflowFiles.state,
      workflowFilesErrorMessage: workflowFiles.errorMessage || null,
      actionsCatalog,
      recentWorkflowRuns,
    });
  }
  return map;
}

function summarizePriorityRepositories(
  priorityRepositories,
  snapshots,
  repositoryPullRequestMap,
  repositoryAutomationHealthMap,
  staleHours,
  staleDraftHours,
  staleOpenPrHours
) {
  return priorityRepositories.map((repository) => {
    const repositorySnapshots = snapshots.filter((snapshot) => snapshot.issue.repository === repository);
    const unsupportedIssues = repositorySnapshots.filter((snapshot) => snapshot.hasUnsupportedLabel);
    const activeAgentIssues = repositorySnapshots.filter(
      (snapshot) => snapshot.hasAgentLabel || snapshot.hasKnownAgentAssignee
    );
    const projectStatuses = [...new Set(repositorySnapshots.map((snapshot) => snapshot.currentProjectStatus).filter(Boolean))].sort();
    const oldestUpdatedAt = repositorySnapshots.reduce((oldest, snapshot) => {
      if (!snapshot.issue.updatedAt) return oldest;
      if (!oldest || Date.parse(snapshot.issue.updatedAt) < Date.parse(oldest)) return snapshot.issue.updatedAt;
      return oldest;
    }, null);
    const newestUpdatedAt = repositorySnapshots.reduce((newest, snapshot) => {
      if (!snapshot.issue.updatedAt) return newest;
      if (!newest || Date.parse(snapshot.issue.updatedAt) > Date.parse(newest)) return snapshot.issue.updatedAt;
      return newest;
    }, null);

    const openPullRequests = repositorySnapshots.flatMap((snapshot) => openPullRequestsForSnapshot(snapshot));
    const repositoryOpenPullRequests = repositoryPullRequestMap.get(repository) || [];
    const untrackedOpenPullRequests = repositoryOpenPullRequests.filter(
      (pr) => !openPullRequests.some((tracked) => tracked.ref === pr.ref)
    );
    const draftPullRequests = repositoryOpenPullRequests.filter((pr) => pr.isDraft);
    const staleDraftPullRequests = draftPullRequests.filter(
      (pr) => pr.ageHours !== null && pr.ageHours >= staleDraftHours
    );
    const conflictingPullRequests = repositoryOpenPullRequests.filter((pr) => mergeConflictForPr(pr));
    const conflictingUntrackedPullRequests = untrackedOpenPullRequests.filter((pr) => mergeConflictForPr(pr));
    const staleUntrackedOpenPullRequests = untrackedOpenPullRequests.filter(
      (pr) => pr.ageHours !== null && pr.ageHours >= staleOpenPrHours
    );
    const reviewPendingPullRequests = repositoryOpenPullRequests.filter((pr) => reviewPendingForPr(pr));
    const pullRequestsWithFailingChecks = repositoryOpenPullRequests.filter(
      (pr) => (pr.combinedStatus?.failingContexts || []).length > 0
    );
    const pullRequestsWithPendingChecks = repositoryOpenPullRequests.filter(
      (pr) => (pr.combinedStatus?.pendingContexts || []).length > 0
    );
    const automation = repositoryAutomationHealthMap.get(repository) || {
      workflowFiles: [],
      actionsCatalog: {
        state: 'unknown',
        totalCount: 0,
        workflows: [],
        errorStatus: null,
        errorMessage: null,
      },
      recentWorkflowRuns: {
        totalCount: 0,
        latestRun: null,
        failingRuns: [],
        recentRuns: [],
        errorStatus: null,
        errorMessage: null,
      },
    };
    const workflowFiles = automation.workflowFiles || [];
    const actionsCatalog = automation.actionsCatalog || {
      state: 'unknown',
      totalCount: 0,
      workflows: [],
      errorStatus: null,
      errorMessage: null,
    };
    const recentWorkflowRuns = automation.recentWorkflowRuns || {
      totalCount: 0,
      latestRun: null,
      failingRuns: [],
      recentRuns: [],
      errorStatus: null,
      errorMessage: null,
    };
    const actionsWorkflowState = classifyLatestWorkflowRunState(workflowFiles, actionsCatalog, recentWorkflowRuns);
    const blocked =
      unsupportedIssues.length > 0 ||
      activeAgentIssues.length > 0 ||
      staleDraftPullRequests.length > 0 ||
      conflictingPullRequests.length > 0 ||
      reviewPendingPullRequests.length > 0 ||
      staleUntrackedOpenPullRequests.length > 0 ||
      conflictingUntrackedPullRequests.length > 0 ||
      pullRequestsWithFailingChecks.length > 0 ||
      actionsWorkflowState !== 'latest-run-success';

    return {
      repository,
      state: blocked ? 'blocked' : snapshots.length > 0 || repositoryOpenPullRequests.length > 0 ? 'active' : 'clear',
      issueCount: snapshots.length,
      unsupportedIssueCount: unsupportedIssues.length,
      activeAgentIssueCount: activeAgentIssues.length,
      stale: Boolean(oldestUpdatedAt && ageHours(oldestUpdatedAt) !== null && ageHours(oldestUpdatedAt) >= staleHours),
      oldestAgeHours: oldestUpdatedAt ? ageHours(oldestUpdatedAt) : null,
      newestAgeHours: newestUpdatedAt ? ageHours(newestUpdatedAt) : null,
      openPullRequestCount: openPullRequests.length,
      repositoryOpenPullRequestCount: repositoryOpenPullRequests.length,
      untrackedOpenPullRequestCount: untrackedOpenPullRequests.length,
      draftPullRequestCount: draftPullRequests.length,
      staleDraftPullRequestCount: staleDraftPullRequests.length,
      conflictingPullRequestCount: conflictingPullRequests.length,
      conflictingUntrackedPullRequestCount: conflictingUntrackedPullRequests.length,
      staleUntrackedOpenPullRequestCount: staleUntrackedOpenPullRequests.length,
      reviewPendingPullRequestCount: reviewPendingPullRequests.length,
      failingCheckPullRequestCount: pullRequestsWithFailingChecks.length,
      pendingCheckPullRequestCount: pullRequestsWithPendingChecks.length,
      residualTechnicalAssigneeCount: snapshots.filter((entry) => entry.technicalAgentAssignees.length > 0).length,
      actionsWorkflowState,
      workflowFileCount: workflowFiles.length,
      workflowFilePaths: workflowFiles.map((entry) => entry.path).sort(),
      actionsWorkflowCatalogCount: actionsCatalog.totalCount || 0,
      actionsWorkflowNames: (actionsCatalog.workflows || []).map((workflow) => workflow.name).sort(),
      actionsWorkflowErrorStatus: actionsCatalog.errorStatus || null,
      actionsWorkflowErrorMessage: actionsCatalog.errorMessage || null,
      latestWorkflowRun: recentWorkflowRuns.latestRun || null,
      recentWorkflowRunCount: recentWorkflowRuns.recentRuns.length,
      failingRecentWorkflowRunCount: recentWorkflowRuns.failingRuns.length,
      failingRecentWorkflowRunRefs: recentWorkflowRuns.failingRuns.map((run) => `run:${run.id}`).sort(),
      recentWorkflowRunErrorStatus: recentWorkflowRuns.errorStatus || null,
      recentWorkflowRunErrorMessage: recentWorkflowRuns.errorMessage || null,
      projectStatuses,
      issueRefs: snapshots.map((entry) => entry.issue.ref).sort(),
      unsupportedIssueRefs: unsupportedIssues.map((entry) => entry.issue.ref).sort(),
      activeAgentIssueRefs: activeAgentIssues.map((entry) => entry.issue.ref).sort(),
      openPullRequestRefs: openPullRequests.map((pr) => pr.ref).sort(),
      repositoryOpenPullRequestRefs: repositoryOpenPullRequests.map((pr) => pr.ref).sort(),
      untrackedOpenPullRequestRefs: untrackedOpenPullRequests.map((pr) => pr.ref).sort(),
      staleDraftPullRequestRefs: staleDraftPullRequests.map((pr) => pr.ref).sort(),
      staleUntrackedOpenPullRequestRefs: staleUntrackedOpenPullRequests.map((pr) => pr.ref).sort(),
      conflictingPullRequestRefs: conflictingPullRequests.map((pr) => pr.ref).sort(),
      conflictingUntrackedPullRequestRefs: conflictingUntrackedPullRequests.map((pr) => pr.ref).sort(),
      reviewPendingPullRequestRefs: reviewPendingPullRequests.map((pr) => pr.ref).sort(),
      failingCheckPullRequestRefs: pullRequestsWithFailingChecks.map((pr) => pr.ref).sort(),
      pendingCheckPullRequestRefs: pullRequestsWithPendingChecks.map((pr) => pr.ref).sort(),
      failingCheckContextsByPullRequest: pullRequestsWithFailingChecks.map((pr) => ({
        ref: pr.ref,
        contexts: (pr.combinedStatus?.failingContexts || []).map((status) => ({
          context: status.context,
          state: status.state,
          description: status.description,
          targetUrl: status.targetUrl,
        })),
      })),
      pendingCheckContextsByPullRequest: pullRequestsWithPendingChecks.map((pr) => ({
        ref: pr.ref,
        contexts: (pr.combinedStatus?.pendingContexts || []).map((status) => ({
          context: status.context,
          state: status.state,
          description: status.description,
          targetUrl: status.targetUrl,
        })),
      })),
    };
  });
}

function summarizeCoreRepositoryHealth(
  coreRepository,
  repositoryPullRequestMap,
  repositoryAutomationHealthMap,
  staleDraftHours
) {
  const repositoryOpenPullRequests = repositoryPullRequestMap.get(coreRepository) || [];
  const draftPullRequests = repositoryOpenPullRequests.filter((pr) => pr.isDraft);
  const staleDraftPullRequests = draftPullRequests.filter(
    (pr) => pr.ageHours !== null && pr.ageHours >= staleDraftHours
  );
  const conflictingPullRequests = repositoryOpenPullRequests.filter((pr) => mergeConflictForPr(pr));
  const reviewPendingPullRequests = repositoryOpenPullRequests.filter((pr) => reviewPendingForPr(pr));
  const pullRequestsWithFailingChecks = repositoryOpenPullRequests.filter(
    (pr) => (pr.combinedStatus?.failingContexts || []).length > 0
  );
  const pullRequestsWithPendingChecks = repositoryOpenPullRequests.filter(
    (pr) => (pr.combinedStatus?.pendingContexts || []).length > 0
  );
  const automation = repositoryAutomationHealthMap.get(coreRepository) || {
    workflowFiles: [],
    actionsCatalog: {
      state: 'unknown',
      totalCount: 0,
      workflows: [],
      errorStatus: null,
      errorMessage: null,
    },
    recentWorkflowRuns: {
      totalCount: 0,
      latestRun: null,
      failingRuns: [],
      recentRuns: [],
      errorStatus: null,
      errorMessage: null,
    },
  };
  const workflowFiles = automation.workflowFiles || [];
  const actionsCatalog = automation.actionsCatalog || {
    state: 'unknown',
    totalCount: 0,
    workflows: [],
    errorStatus: null,
    errorMessage: null,
  };
  const recentWorkflowRuns = automation.recentWorkflowRuns || {
    totalCount: 0,
    latestRun: null,
    failingRuns: [],
    recentRuns: [],
    errorStatus: null,
    errorMessage: null,
  };
  const actionsWorkflowState = classifyLatestWorkflowRunState(workflowFiles, actionsCatalog, recentWorkflowRuns);
  const blocked =
    staleDraftPullRequests.length > 0 ||
    conflictingPullRequests.length > 0 ||
    reviewPendingPullRequests.length > 0 ||
    pullRequestsWithFailingChecks.length > 0 ||
    actionsWorkflowState !== 'latest-run-success';

  return {
    repository: coreRepository,
    state: blocked ? 'blocked' : repositoryOpenPullRequests.length > 0 ? 'active' : 'clear',
    repositoryOpenPullRequestCount: repositoryOpenPullRequests.length,
    draftPullRequestCount: draftPullRequests.length,
    staleDraftPullRequestCount: staleDraftPullRequests.length,
    conflictingPullRequestCount: conflictingPullRequests.length,
    reviewPendingPullRequestCount: reviewPendingPullRequests.length,
    failingCheckPullRequestCount: pullRequestsWithFailingChecks.length,
    pendingCheckPullRequestCount: pullRequestsWithPendingChecks.length,
    actionsWorkflowState,
    workflowFileCount: workflowFiles.length,
    workflowFilePaths: workflowFiles.map((entry) => entry.path).sort(),
    actionsWorkflowCatalogCount: actionsCatalog.totalCount || 0,
    actionsWorkflowNames: (actionsCatalog.workflows || []).map((workflow) => workflow.name).sort(),
    actionsWorkflowErrorStatus: actionsCatalog.errorStatus || null,
    actionsWorkflowErrorMessage: actionsCatalog.errorMessage || null,
    latestWorkflowRun: recentWorkflowRuns.latestRun || null,
    recentWorkflowRunCount: recentWorkflowRuns.recentRuns.length,
    failingRecentWorkflowRunCount: recentWorkflowRuns.failingRuns.length,
    failingRecentWorkflowRunRefs: recentWorkflowRuns.failingRuns.map((run) => `run:${run.id}`).sort(),
    recentWorkflowRunErrorStatus: recentWorkflowRuns.errorStatus || null,
    recentWorkflowRunErrorMessage: recentWorkflowRuns.errorMessage || null,
    repositoryOpenPullRequestRefs: repositoryOpenPullRequests.map((pr) => pr.ref).sort(),
    staleDraftPullRequestRefs: staleDraftPullRequests.map((pr) => pr.ref).sort(),
    conflictingPullRequestRefs: conflictingPullRequests.map((pr) => pr.ref).sort(),
    reviewPendingPullRequestRefs: reviewPendingPullRequests.map((pr) => pr.ref).sort(),
    failingCheckPullRequestRefs: pullRequestsWithFailingChecks.map((pr) => pr.ref).sort(),
    pendingCheckPullRequestRefs: pullRequestsWithPendingChecks.map((pr) => pr.ref).sort(),
    failingCheckContextsByPullRequest: pullRequestsWithFailingChecks.map((pr) => ({
      ref: pr.ref,
      contexts: (pr.combinedStatus?.failingContexts || []).map((status) => ({
          context: status.context,
          state: status.state,
          description: status.description,
          targetUrl: status.targetUrl,
        })),
    })),
    pendingCheckContextsByPullRequest: pullRequestsWithPendingChecks.map((pr) => ({
      ref: pr.ref,
      contexts: (pr.combinedStatus?.pendingContexts || []).map((status) => ({
          context: status.context,
          state: status.state,
          description: status.description,
          targetUrl: status.targetUrl,
        })),
    })),
  };
}

function buildCoreRepositoryAttention(coreRepositoryHealth) {
  if (
    coreRepositoryHealth.state === 'clear' &&
    coreRepositoryHealth.actionsWorkflowState === 'latest-run-success'
  ) {
    return null;
  }

  return {
    repository: coreRepositoryHealth.repository,
    actionsWorkflowState: coreRepositoryHealth.actionsWorkflowState,
    workflowFilePaths: coreRepositoryHealth.workflowFilePaths,
    actionsWorkflowNames: coreRepositoryHealth.actionsWorkflowNames,
    actionsWorkflowErrorStatus: coreRepositoryHealth.actionsWorkflowErrorStatus,
    actionsWorkflowErrorMessage: coreRepositoryHealth.actionsWorkflowErrorMessage,
    latestWorkflowRun: coreRepositoryHealth.latestWorkflowRun,
    recentWorkflowRunErrorStatus: coreRepositoryHealth.recentWorkflowRunErrorStatus,
    recentWorkflowRunErrorMessage: coreRepositoryHealth.recentWorkflowRunErrorMessage,
    repositoryOpenPullRequestRefs: coreRepositoryHealth.repositoryOpenPullRequestRefs,
    staleDraftPullRequestRefs: coreRepositoryHealth.staleDraftPullRequestRefs,
    conflictingPullRequestRefs: coreRepositoryHealth.conflictingPullRequestRefs,
    reviewPendingPullRequestRefs: coreRepositoryHealth.reviewPendingPullRequestRefs,
    failingCheckPullRequestRefs: coreRepositoryHealth.failingCheckPullRequestRefs,
    pendingCheckPullRequestRefs: coreRepositoryHealth.pendingCheckPullRequestRefs,
    failingCheckContextsByPullRequest: coreRepositoryHealth.failingCheckContextsByPullRequest,
    pendingCheckContextsByPullRequest: coreRepositoryHealth.pendingCheckContextsByPullRequest,
  };
}

function buildPriorityPullRequestAttention(priorityRepositoryHealth) {
  return priorityRepositoryHealth
    .filter(
      (entry) =>
        entry.state !== 'clear' &&
        (
          entry.staleDraftPullRequestCount > 0 ||
          entry.conflictingPullRequestCount > 0 ||
          entry.reviewPendingPullRequestCount > 0 ||
          entry.staleUntrackedOpenPullRequestCount > 0 ||
          entry.conflictingUntrackedPullRequestCount > 0 ||
          entry.failingCheckPullRequestCount > 0 ||
          entry.actionsWorkflowState !== 'latest-run-success'
        )
    )
    .map((entry) => ({
      repository: entry.repository,
      actionsWorkflowState: entry.actionsWorkflowState,
      workflowFilePaths: entry.workflowFilePaths,
      actionsWorkflowNames: entry.actionsWorkflowNames,
      actionsWorkflowErrorStatus: entry.actionsWorkflowErrorStatus,
      actionsWorkflowErrorMessage: entry.actionsWorkflowErrorMessage,
      latestWorkflowRun: entry.latestWorkflowRun,
      recentWorkflowRunErrorStatus: entry.recentWorkflowRunErrorStatus,
      recentWorkflowRunErrorMessage: entry.recentWorkflowRunErrorMessage,
      issueRefs: entry.issueRefs,
      activeAgentIssueRefs: entry.activeAgentIssueRefs,
      unsupportedIssueRefs: entry.unsupportedIssueRefs,
      staleDraftPullRequestRefs: entry.staleDraftPullRequestRefs,
      staleUntrackedOpenPullRequestRefs: entry.staleUntrackedOpenPullRequestRefs,
      conflictingPullRequestRefs: entry.conflictingPullRequestRefs,
      conflictingUntrackedPullRequestRefs: entry.conflictingUntrackedPullRequestRefs,
      reviewPendingPullRequestRefs: entry.reviewPendingPullRequestRefs,
      failingCheckPullRequestRefs: entry.failingCheckPullRequestRefs,
      pendingCheckPullRequestRefs: entry.pendingCheckPullRequestRefs,
      failingCheckContextsByPullRequest: entry.failingCheckContextsByPullRequest,
      pendingCheckContextsByPullRequest: entry.pendingCheckContextsByPullRequest,
    }));
}

function writeOutputFile(payload) {
  const outDir = env('CTO_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/cto-project-supervisor.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('CTO_PROJECT_ORG', '<env.<env.OWNER>>');
  const projectNumber = Number(env('CTO_PROJECT_NUMBER', '1'));
  const dryRun = env('CTO_DRY_RUN', 'true').toLowerCase() !== 'false';
  const workStatus = env('CTO_WORK_STATUS', 'Ready');
  const inReviewStatus = env('CTO_IN_REVIEW_STATUS', 'In Review');
  const doneStatus = env('CTO_DONE_STATUS', 'Done');
  const unsupportedLabel = env('CTO_UNSUPPORTED_LABEL', DEFAULT_UNSUPPORTED_LABEL);
  const staleHours = parsePositiveNumber(env('CTO_BLOCKED_STALE_HOURS', DEFAULT_STALE_HOURS), 24);
  const staleDraftHours = parsePositiveNumber(
    env('CTO_PRIORITY_PR_STALE_HOURS', DEFAULT_STALE_DRAFT_HOURS),
    24
  );
  const staleOpenPrHours = parsePositiveNumber(
    env('CTO_PRIORITY_OPEN_PR_STALE_HOURS', DEFAULT_STALE_OPEN_PR_HOURS),
    48
  );
  const workflowRunLookback = parsePositiveNumber(
    env('CTO_PRIORITY_WORKFLOW_RUN_LOOKBACK', DEFAULT_PRIORITY_WORKFLOW_RUN_LOOKBACK),
    10
  );
  const coreRepository = normalizeRepositoryName(
    org,
    env('CTO_CORE_REPOSITORY', DEFAULT_CORE_REPOSITORY) || DEFAULT_CORE_REPOSITORY
  );
  const priorityRepositories = normalizePriorityRepositories(
    org,
    parseCsv(env('CTO_PRIORITY_REPOSITORIES', DEFAULT_PRIORITY_REPOSITORIES))
  );
  const repositoryAuditTargets = [...new Set([...priorityRepositories, coreRepository])];
  const priorityRepositorySet = new Set(priorityRepositories);
  const knownAgentLogins = new Set(
    parseCsv(env('CTO_KNOWN_AGENT_LOGINS', DEFAULT_KNOWN_AGENT_LOGINS)).map((login) => login.toLowerCase())
  );

  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);

  const items = project.items?.nodes || [];
  const actions = [];
  const unsupportedCopilotIssues = [];
  const priorityOperationalIssues = [];

  for (const item of items) {
    const prioritySnapshot = classifyPriorityOperationalItem(
      item,
      knownAgentLogins,
      unsupportedLabel,
      priorityRepositorySet
    );
    if (prioritySnapshot) {
      priorityOperationalIssues.push(prioritySnapshot);
    }

    const blocked = classifyUnsupportedCopilot(item, knownAgentLogins, unsupportedLabel);
    if (blocked) {
      unsupportedCopilotIssues.push(blocked);
      if (blocked.hasKnownAgentAssignee) {
        const action = {
          type: 'cleanup-blocked-agent-assignee',
          issue: blocked.issue,
          currentProjectStatus: blocked.currentProjectStatus,
          technicalAgentAssignees: blocked.technicalAgentAssignees,
        };
        actions.push(action);
        if (!dryRun) {
          const cleanup = await cleanupBlockedAgentAssignee(item.content, knownAgentLogins);
          action.cleanupClearedAgentAssignee = cleanup.cleared;
          action.graphQlCleared = cleanup.graphQlCleared;
          action.restCleared = cleanup.restCleared;
          if (cleanup.warnings.length > 0) {
            action.cleanupWarnings = cleanup.warnings;
          }
        }
      }
    }

    const mismatch = classifyDoneMismatch(
      item,
      knownAgentLogins,
      unsupportedLabel,
      workStatus,
      inReviewStatus,
      doneStatus
    );
    if (!mismatch) continue;

    actions.push({
      type: 'revert-invalid-done',
      issue: mismatch.snapshot.issue,
      fromStatus: mismatch.fromStatus,
      targetStatus: mismatch.targetStatus,
      reasons: mismatch.reasons,
    });

    if (!dryRun) {
      await moveProjectItem(project, mismatch.itemId, mismatch.targetStatus);
      await addIssueComment(
        mismatch.issueId,
        buildComment(mismatch.issueRef, mismatch.fromStatus, mismatch.targetStatus, mismatch.reasons)
      );
    }
  }

  const repositoryPullRequests = await fetchPriorityRepositoryPullRequests(repositoryAuditTargets);
  const repositoryAutomationHealth = await fetchPriorityRepositoryAutomationHealth(
    repositoryAuditTargets,
    workflowRunLookback
  );
  const unsupportedCopilotByRepository = summarizeUnsupportedCopilot(unsupportedCopilotIssues);
  const priorityRepositoryHealth = summarizePriorityRepositories(
    priorityRepositories,
    priorityOperationalIssues,
    repositoryPullRequests,
    repositoryAutomationHealth,
    staleHours,
    staleDraftHours,
    staleOpenPrHours
  );
  const priorityPullRequestAttention = buildPriorityPullRequestAttention(priorityRepositoryHealth);
  const coreRepositoryHealth = summarizeCoreRepositoryHealth(
    coreRepository,
    repositoryPullRequests,
    repositoryAutomationHealth,
    staleDraftHours
  );
  const coreRepositoryAttention = buildCoreRepositoryAttention(coreRepositoryHealth);

  const result = {
    generatedAt: new Date().toISOString(),
    dryRun,
    project: {
      org,
      number: projectNumber,
      id: project.id,
      title: project.title,
    },
    workStatus,
    inReviewStatus,
    doneStatus,
    coreRepository,
    staleDraftHours,
    staleOpenPrHours,
    workflowRunLookback,
    unsupportedCopilotIssueCount: unsupportedCopilotIssues.length,
    unsupportedCopilotByRepository,
    unsupportedCopilotIssues,
    priorityRepositories,
    priorityOperationalIssueCount: priorityOperationalIssues.length,
    priorityOperationalIssues,
    coreRepositoryOpenPullRequests: repositoryPullRequests.get(coreRepository) || [],
    coreRepositoryAutomationHealth:
      repositoryAutomationHealth.get(coreRepository) || {
        workflowFiles: [],
        actionsCatalog: {
          state: 'unknown',
          totalCount: 0,
          workflows: [],
          errorStatus: null,
          errorMessage: null,
        },
        recentWorkflowRuns: {
          totalCount: 0,
          latestRun: null,
          failingRuns: [],
          recentRuns: [],
          errorStatus: null,
          errorMessage: null,
        },
      },
    coreRepositoryHealth,
    coreRepositoryAttentionCount: coreRepositoryAttention ? 1 : 0,
    coreRepositoryAttention,
    priorityRepositoryOpenPullRequests: Object.fromEntries(
      priorityRepositories.map((repository) => [repository, repositoryPullRequests.get(repository) || []])
    ),
    priorityRepositoryAutomationHealth: Object.fromEntries(
      priorityRepositories.map((repository) => [
        repository,
        repositoryAutomationHealth.get(repository) || {
          workflowFiles: [],
          actionsCatalog: {
            state: 'unknown',
            totalCount: 0,
            workflows: [],
            errorStatus: null,
            errorMessage: null,
          },
          recentWorkflowRuns: {
            totalCount: 0,
            latestRun: null,
            failingRuns: [],
            recentRuns: [],
            errorStatus: null,
            errorMessage: null,
          },
        },
      ])
    ),
    blockedPriorityRepositoryCount: priorityRepositoryHealth.filter((entry) => entry.state === 'blocked').length,
    staleBlockedPriorityRepositoryCount: priorityRepositoryHealth.filter((entry) => entry.stale).length,
    actionsBlockedPriorityRepositoryCount: priorityRepositoryHealth.filter(
      (entry) => entry.actionsWorkflowState !== 'latest-run-success'
    ).length,
    failingCheckPriorityPullRequestCount: priorityRepositoryHealth.reduce(
      (sum, entry) => sum + entry.failingCheckPullRequestCount,
      0
    ),
    untrackedPriorityOpenPullRequestCount: priorityRepositoryHealth.reduce(
      (sum, entry) => sum + entry.untrackedOpenPullRequestCount,
      0
    ),
    priorityPullRequestAttentionCount: priorityPullRequestAttention.length,
    priorityPullRequestAttention,
    priorityRepositoryHealth,
    actionCount: actions.length,
    actions,
  };

  const outPath = writeOutputFile(result);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        unsupportedCopilotIssueCount: unsupportedCopilotIssues.length,
        priorityOperationalIssueCount: priorityOperationalIssues.length,
        coreRepositoryState: coreRepositoryHealth.state,
        coreRepositoryActionsWorkflowState: coreRepositoryHealth.actionsWorkflowState,
        blockedPriorityRepositoryCount: result.blockedPriorityRepositoryCount,
        staleBlockedPriorityRepositoryCount: result.staleBlockedPriorityRepositoryCount,
        actionsBlockedPriorityRepositoryCount: result.actionsBlockedPriorityRepositoryCount,
        failingCheckPriorityPullRequestCount: result.failingCheckPriorityPullRequestCount,
        untrackedPriorityOpenPullRequestCount: result.untrackedPriorityOpenPullRequestCount,
        priorityPullRequestAttentionCount: result.priorityPullRequestAttentionCount,
        actionCount: actions.length,
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
