import fs from 'node:fs';
import {
  githubRetryConfig,
  isRetriableGraphQLErrors,
  isRetriableStatus,
  retryAsync,
  retryableError,
} from '../../src/retry.js';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const REST_URL = 'https://api.github.com';
const RETRY = githubRetryConfig('GITHUB_MANAGER');
const DEFAULT_ALLOWED_LOGINS = 'luizkim,github-copilot[bot],copilot-swe-agent,copilot';
const DEFAULT_AGENT_LABELS = 'agent:developer,agent:security,agent:qa,agent:devops,agent:sysadmin';
const COMMAND_PREFIXES = ['/github-manager', '/github-ops'];

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function parseCsv(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function token() {
  return env('GH_TOKEN') || env('GITHUB_TOKEN');
}

function requiredToken() {
  const value = token();
  if (!value) throw new Error('Missing GitHub token. Set GH_TOKEN or GITHUB_TOKEN.');
  return value;
}

function parseGraphQlErrorMessage(error) {
  const message = error?.message || String(error || '');
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function isMissingProjectError(error) {
  const parsed = parseGraphQlErrorMessage(error);
  if (
    parsed?.errors?.some(
      (entry) => entry?.type === 'NOT_FOUND' && Array.isArray(entry.path) && entry.path.includes('projectV2')
    )
  ) {
    return true;
  }

  const message = error?.message || '';
  return /Could not resolve to a ProjectV2/i.test(message) || /Project not found:/i.test(message);
}

async function githubGraphQL(query, variables = {}) {
  const auth = requiredToken();
  return retryAsync(
    async () => {
      let response;
      try {
        response = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${auth}`,
            'User-Agent': '<env.OWNER>-github-manager',
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
    { label: 'GitHub Manager GraphQL', ...RETRY }
  );
}

async function githubRest(path, options = {}) {
  const auth = requiredToken();
  return retryAsync(
    async () => {
      let response;
      try {
        response = await fetch(`${REST_URL}${path}`, {
          ...options,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${auth}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': '<env.OWNER>-github-manager',
            ...(options.headers || {}),
          },
        });
      } catch (error) {
        throw retryableError(`GitHub REST request failed: ${error.message || error}`);
      }

      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        const message = JSON.stringify({ status: response.status, path, body: text }, null, 2);
        if (isRetriableStatus(response.status)) throw retryableError(message);
        throw new Error(message);
      }

      if (!response.ok) {
        const message = JSON.stringify({ status: response.status, path, body: json }, null, 2);
        if (isRetriableStatus(response.status)) throw retryableError(message);
        throw new Error(message);
      }

      return json;
    },
    { label: `GitHub Manager REST ${path}`, ...RETRY }
  );
}

function extractJsonBlock(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  let raw = text.trim();
  for (const prefix of COMMAND_PREFIXES) {
    if (raw.toLowerCase().startsWith(prefix)) {
      raw = raw.slice(prefix.length).trim();
      break;
    }
  }
  return raw;
}

function readIssueCommentCommand() {
  const eventName = env('GITHUB_EVENT_NAME');
  const eventPath = env('GITHUB_EVENT_PATH');
  if (eventName !== 'issue_comment' || !eventPath || !fs.existsSync(eventPath)) {
    return { ignored: false, payload: null, source: 'env' };
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const body = event.comment?.body || '';
  const normalizedBody = body.trim().toLowerCase();
  const matchesPrefix = COMMAND_PREFIXES.some((prefix) => normalizedBody.startsWith(prefix));
  if (!matchesPrefix) {
    return { ignored: true, payload: null, source: 'issue_comment' };
  }

  const allowed = new Set(
    parseCsv(env('GITHUB_MANAGER_ALLOWED_LOGINS', DEFAULT_ALLOWED_LOGINS)).map((login) => login.toLowerCase())
  );
  const actor = (event.comment?.user?.login || '').toLowerCase();
  if (allowed.size > 0 && !allowed.has(actor)) {
    throw new Error(`Actor not allowed to run manager command: ${actor || 'unknown'}`);
  }

  const jsonText = extractJsonBlock(body);
  if (!jsonText) {
    return {
      ignored: false,
      payload: null,
      source: `issue_comment:${event.repository?.full_name || 'unknown'}#${event.issue?.number || 'unknown'}`,
      actor,
      commandOnly: true,
    };
  }

  return {
    ignored: false,
    payload: JSON.parse(jsonText),
    source: `issue_comment:${event.repository?.full_name || 'unknown'}#${event.issue?.number || 'unknown'}`,
    actor,
    commandOnly: false,
  };
}

function readOperationsPayload() {
  const inline = env('OPERATIONS_JSON');
  if (inline) {
    return { payload: JSON.parse(inline), source: 'OPERATIONS_JSON', commandOnly: false };
  }

  const operationsFile = env('OPERATIONS_FILE');
  if (operationsFile && fs.existsSync(operationsFile)) {
    return {
      payload: JSON.parse(fs.readFileSync(operationsFile, 'utf8')),
      source: `OPERATIONS_FILE:${operationsFile}`,
      commandOnly: false,
    };
  }

  const fromComment = readIssueCommentCommand();
  if (fromComment.ignored) {
    return { payload: null, source: fromComment.source, ignored: true, commandOnly: false };
  }
  if (fromComment.payload || fromComment.commandOnly) {
    return fromComment;
  }

  return { payload: null, source: 'none', commandOnly: false };
}

function splitRepo(fullName) {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repo_full_name: ${fullName}`);
  return { owner, repo };
}

async function getProjectMetadata(org, projectNumber) {
  const query = `query($org:String!, $projectNumber:Int!, $cursor:String) {
    organization(login:$org) {
      projectV2(number:$projectNumber) {
        id
        title
        fields(first:50) {
          nodes {
            ... on ProjectV2FieldCommon {
              id
              name
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
          }
        }
        items(first:100, after:$cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            content {
              ... on Issue {
                id
                number
                repository {
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
  if (!project) {
    throw new Error(`Project not found: ${org}#${projectNumber}`);
  }

  const items = [...(project.items?.nodes || [])];
  let pageInfo = project.items?.pageInfo;
  while (pageInfo?.hasNextPage && pageInfo.endCursor) {
    const page = await githubGraphQL(query, { org, projectNumber, cursor: pageInfo.endCursor });
    items.push(...(page?.organization?.projectV2?.items?.nodes || []));
    pageInfo = page?.organization?.projectV2?.items?.pageInfo;
  }
  project.items.nodes = items;
  return project;
}

async function getProjectAuditSnapshot(org, projectNumber) {
  const query = `query($org:String!, $projectNumber:Int!, $cursor:String) {
    organization(login:$org) {
      projectV2(number:$projectNumber) {
        id
        title
        fields(first:50) {
          nodes {
            ... on ProjectV2FieldCommon {
              id
              name
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
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
                updatedAt
                labels(first:30) {
                  nodes {
                    name
                  }
                }
                assignees(first:20) {
                  nodes {
                    login
                  }
                }
                comments(last:20) {
                  nodes {
                    author {
                      login
                    }
                    body
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
                          reviewDecision
                          repository {
                            nameWithOwner
                          }
                          comments(last:20) {
                            nodes {
                              author {
                                login
                              }
                              body
                            }
                          }
                          reviews(last:20) {
                            nodes {
                              author {
                                login
                              }
                              state
                              body
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
    }
  }`;

  const firstPage = await githubGraphQL(query, { org, projectNumber, cursor: null });
  const project = firstPage?.organization?.projectV2;
  if (!project) {
    throw new Error(`Project not found: ${org}#${projectNumber}`);
  }

  const items = [...(project.items?.nodes || [])];
  let pageInfo = project.items?.pageInfo;
  while (pageInfo?.hasNextPage && pageInfo.endCursor) {
    const page = await githubGraphQL(query, { org, projectNumber, cursor: pageInfo.endCursor });
    items.push(...(page?.organization?.projectV2?.items?.nodes || []));
    pageInfo = page?.organization?.projectV2?.items?.pageInfo;
  }
  project.items.nodes = items;
  return project;
}

function getStatusField(project) {
  const field = (project.fields?.nodes || []).find(
    (entry) => entry?.name?.toLowerCase() === 'status' && entry?.options
  );
  if (!field) throw new Error('Status field not found in project.');
  return field;
}

function getStatusOption(field, targetStatus) {
  const option = (field.options || []).find(
    (entry) => entry?.name?.toLowerCase() === String(targetStatus).toLowerCase()
  );
  if (!option) throw new Error(`Project status option not found: ${targetStatus}`);
  return option;
}

function getProjectItem(project, repoFullName, issueNumber, itemId) {
  if (itemId) {
    const item = (project.items?.nodes || []).find((entry) => entry.id === itemId);
    if (!item) throw new Error(`Project item not found by item_id: ${itemId}`);
    return item;
  }

  if (!repoFullName || issueNumber === undefined || issueNumber === null) {
    return null;
  }

  return (
    (project.items?.nodes || []).find(
      (entry) =>
        entry?.content?.repository?.nameWithOwner === repoFullName &&
        entry?.content?.number === Number(issueNumber)
    ) || null
  );
}

async function getIssueNodeId(repoFullName, issueNumber) {
  const { owner, repo } = splitRepo(repoFullName);
  const data = await githubGraphQL(
    `query($owner:String!, $repo:String!, $number:Int!) {
      repository(owner:$owner, name:$repo) {
        issue(number:$number) {
          id
          number
          repository {
            nameWithOwner
          }
        }
      }
    }`,
    { owner, repo, number: Number(issueNumber) }
  );

  return data?.repository?.issue || null;
}

async function addProjectItem(projectId, contentId) {
  const data = await githubGraphQL(
    `mutation($projectId:ID!, $contentId:ID!) {
      addProjectV2ItemById(input:{ projectId:$projectId, contentId:$contentId }) {
        item {
          id
        }
      }
    }`,
    { projectId, contentId }
  );

  return data?.addProjectV2ItemById?.item?.id || null;
}

async function resolveProjectItem(project, input) {
  if (input.item_id) {
    return getProjectItem(project, null, null, input.item_id);
  }

  if (!input.repo_full_name || input.issue_number === undefined || input.issue_number === null) {
    throw new Error('project_status requires item_id or repo_full_name + issue_number.');
  }

  const existing = getProjectItem(project, input.repo_full_name, input.issue_number, null);
  if (existing) {
    return existing;
  }

  const issue = await getIssueNodeId(input.repo_full_name, input.issue_number);
  if (!issue?.id) {
    throw new Error(`Issue not found: ${input.repo_full_name}#${input.issue_number}`);
  }

  const itemId = await addProjectItem(project.id, issue.id);
  if (!itemId) {
    throw new Error(`Project item could not be added for ${input.repo_full_name}#${input.issue_number}`);
  }

  return { id: itemId, content: issue };
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

function assigneeLogins(issue) {
  return (issue.assignees?.nodes || []).map((assignee) => assignee?.login).filter(Boolean);
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

function hasStageLabel(labels, stageLabel) {
  return labels.includes(stageLabel);
}

function hasApprovalByText(comments, patterns) {
  return comments.some((entry) => {
    const body = entry?.body || '';
    return patterns.some((pattern) => pattern.test(body));
  });
}

function hasApprovalByActor(comments, approvers) {
  if (approvers.size === 0) return false;
  return comments.some((entry) => {
    const login = (entry?.author?.login || '').toLowerCase();
    const body = entry?.body || '';
    return approvers.has(login) && /\b(ok|pk|approved|aprovado|aprovada)\b/i.test(body);
  });
}

function hasReviewApproval(prs, approvers) {
  if (approvers.size === 0) return false;
  return prs.some((pr) =>
    (pr.reviews?.nodes || []).some((review) => {
      const login = (review?.author?.login || '').toLowerCase();
      return approvers.has(login) && (review.state === 'APPROVED' || /\b(ok|pk|approved|aprovado|aprovada)\b/i.test(review.body || ''));
    })
  );
}

function detectSecurityApproval(issue, prs, securityLabel, approvers) {
  const labels = issueLabels(issue);
  const issueComments = issue.comments?.nodes || [];
  const prComments = prs.flatMap((pr) => pr.comments?.nodes || []);
  const patterns = [
    /security aprovado/i,
    /security approved/i,
    /aprovad[oa].*security/i,
    /approved.*security/i,
  ];
  const reasons = [];
  if (hasStageLabel(labels, securityLabel)) {
    reasons.push(`a task ainda carrega ${securityLabel}`);
  }
  if (hasApprovalByText(issueComments, patterns) || hasApprovalByText(prComments, patterns)) {
    reasons.push('foi encontrada aprovacao textual de Security em issue ou PR');
  }
  if (hasApprovalByActor(issueComments, approvers) || hasApprovalByActor(prComments, approvers) || hasReviewApproval(prs, approvers)) {
    reasons.push('foi encontrada aprovacao explicita de um aprovador configurado de Security');
  }
  return { approved: reasons.length > 0, reasons };
}

function detectQaApproval(issue, prs, qaLabel, approvers) {
  const labels = issueLabels(issue);
  const issueComments = issue.comments?.nodes || [];
  const prComments = prs.flatMap((pr) => pr.comments?.nodes || []);
  const patterns = [
    /qa aprovado/i,
    /qa approved/i,
    /quality assurance aprovado/i,
    /destino no projectv2:\s*in review/i,
    /tecnicamente pronta para verificacao humana final em in review/i,
  ];
  const reasons = [];
  if (hasStageLabel(labels, qaLabel)) {
    reasons.push(`a task ainda carrega ${qaLabel}`);
  }
  if (hasApprovalByText(issueComments, patterns) || hasApprovalByText(prComments, patterns)) {
    reasons.push('foi encontrada aprovacao textual de Q.A. em issue ou PR');
  }
  if (hasApprovalByActor(issueComments, approvers) || hasApprovalByActor(prComments, approvers) || hasReviewApproval(prs, approvers)) {
    reasons.push('foi encontrada aprovacao explicita de um aprovador configurado de Q.A.');
  }
  return { approved: reasons.length > 0, reasons };
}

function statusMatches(status, allowedStatuses) {
  const normalized = (status || '').trim().toLowerCase();
  return allowedStatuses.some((entry) => entry.toLowerCase() === normalized);
}

function buildMissingProjectAuditSummary({
  org,
  projectNumber,
  dryRun,
  workStatuses,
  inReviewStatuses,
  doneStatuses,
}) {
  return {
    generatedAt: new Date().toISOString(),
    mode: 'manager-audit',
    dryRun,
    skipped: true,
    reason: 'project-not-found',
    project: {
      org,
      number: projectNumber,
      id: null,
      title: null,
    },
    workStatuses,
    inReviewStatuses,
    doneStatuses,
    actionCount: 0,
    actions: [],
    notes: [`No ProjectV2 found for ${org}#${projectNumber}. Scheduled audit skipped.`],
  };
}

async function updateProjectStatus(input) {
  const project = await getProjectMetadata(input.org, Number(input.project_number));
  const statusField = getStatusField(project);
  const statusOption = getStatusOption(statusField, input.target_status);
  const item = await resolveProjectItem(project, input);

  await githubGraphQL(
    `mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }`,
    {
      projectId: project.id,
      itemId: item.id,
      fieldId: statusField.id,
      optionId: statusOption.id,
    }
  );

  return {
    project: { id: project.id, title: project.title, org: input.org, number: Number(input.project_number) },
    item_id: item.id,
    target_status: input.target_status,
    repo_full_name: input.repo_full_name || item?.content?.repository?.nameWithOwner || null,
    issue_number: input.issue_number || item?.content?.number || null,
  };
}

async function addIssueComment(input) {
  const { owner, repo } = splitRepo(input.repo_full_name);
  const body = await githubRest(`/repos/${owner}/${repo}/issues/${Number(input.issue_number)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: input.body }),
  });
  return { comment_id: body?.id || null, html_url: body?.html_url || null };
}

async function createIssue(input) {
  const { owner, repo } = splitRepo(input.repo_full_name);
  const payload = {
    title: input.title,
    body: input.body || '',
  };

  if (Array.isArray(input.labels) && input.labels.length > 0) {
    payload.labels = input.labels;
  }
  if (Array.isArray(input.assignees) && input.assignees.length > 0) {
    payload.assignees = input.assignees;
  }
  if (input.milestone !== undefined && input.milestone !== null && input.milestone !== '') {
    payload.milestone = input.milestone;
  }

  const created = await githubRest(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  const result = {
    issue: {
      id: created?.node_id || null,
      number: created?.number || null,
      url: created?.html_url || null,
      title: created?.title || input.title,
    },
  };

  if (input.project_number !== undefined && input.project_number !== null && input.project_number !== '') {
    const projectOrg = input.project_org || input.org || owner;
    const targetStatus = input.target_status || 'Ready';
    const projectResult = await updateProjectStatus({
      org: projectOrg,
      project_number: input.project_number,
      repo_full_name: input.repo_full_name,
      issue_number: created?.number,
      target_status: targetStatus,
    });

    result.project = projectResult.project;
    result.item_id = projectResult.item_id;
    result.target_status = projectResult.target_status;
  }

  return result;
}

async function replaceLabels(input) {
  const { owner, repo } = splitRepo(input.repo_full_name);
  const body = await githubRest(`/repos/${owner}/${repo}/issues/${Number(input.issue_number)}/labels`, {
    method: 'PUT',
    body: JSON.stringify(input.labels || []),
  });
  return { labels: (body || []).map((label) => label?.name).filter(Boolean) };
}

async function addAssignees(input) {
  const { owner, repo } = splitRepo(input.repo_full_name);
  const body = await githubRest(`/repos/${owner}/${repo}/issues/${Number(input.issue_number)}/assignees`, {
    method: 'POST',
    body: JSON.stringify({ assignees: input.assignees || [] }),
  });
  return { assignees: (body?.assignees || []).map((entry) => entry?.login).filter(Boolean) };
}

async function removeAssignees(input) {
  const { owner, repo } = splitRepo(input.repo_full_name);
  const body = await githubRest(`/repos/${owner}/${repo}/issues/${Number(input.issue_number)}/assignees`, {
    method: 'DELETE',
    body: JSON.stringify({ assignees: input.assignees || [] }),
  });
  return { assignees: (body?.assignees || []).map((entry) => entry?.login).filter(Boolean) };
}

async function addPrReview(input) {
  const query = `query($owner:String!, $repo:String!, $number:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) {
        id
      }
    }
  }`;
  const { owner, repo } = splitRepo(input.repo_full_name);
  const data = await githubGraphQL(query, { owner, repo, number: Number(input.pull_number) });
  const prId = data?.repository?.pullRequest?.id;
  if (!prId) throw new Error(`Pull request not found: ${input.repo_full_name}#${input.pull_number}`);

  const result = await githubGraphQL(
    `mutation($pullRequestId:ID!, $event:PullRequestReviewEvent!, $body:String!) {
      addPullRequestReview(input:{pullRequestId:$pullRequestId, event:$event, body:$body}) {
        pullRequestReview {
          id
          state
        }
      }
    }`,
    { pullRequestId: prId, event: input.event, body: input.body || '' }
  );
  return result?.addPullRequestReview?.pullRequestReview || null;
}

async function executeOperation(operation) {
  const type = String(operation.type || '').trim();
  if (!type) throw new Error('Operation is missing type.');

  switch (type) {
    case 'create_issue':
      return createIssue(operation);
    case 'project_status':
      return updateProjectStatus(operation);
    case 'issue_comment':
      return addIssueComment(operation);
    case 'replace_labels':
      return replaceLabels(operation);
    case 'add_assignees':
      return addAssignees(operation);
    case 'remove_assignees':
      return removeAssignees(operation);
    case 'pr_review':
      return addPrReview(operation);
    case 'manager_audit':
      return runManagerAudit(operation.dry_run === true);
    case 'rest':
      return githubRest(operation.path, {
        method: operation.method || 'GET',
        body: operation.body !== undefined ? JSON.stringify(operation.body) : undefined,
        headers: operation.headers || {},
      });
    case 'graphql':
      return githubGraphQL(operation.query, operation.variables || {});
    default:
      throw new Error(`Unsupported operation type: ${type}`);
  }
}

function buildManagerComment(issueRef, fromStatus, targetStatus, reasons) {
  return [
    '### GitHub Manager',
    '',
    `Issue: ${issueRef}`,
    `Ação: a task foi corrigida de \`${fromStatus}\` para \`${targetStatus}\` pelo runner gerencial.`,
    '',
    'Motivos objetivos:',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    'Manutenção aplicada: ajuste de coluna, limpeza de labels operacionais residuais e higienização de assignees técnicos quando necessário.',
  ].join('\n');
}

function buildLabelCleanupComment(issueRef, status) {
  return [
    '### GitHub Manager',
    '',
    `Issue: ${issueRef}`,
    `Ação: labels operacionais residuais foram removidas porque a task já estava em \`${status}\`.`,
  ].join('\n');
}

function serializeAuditIssue(item) {
  const issue = item.content;
  return {
    ref: `${issue.repository.nameWithOwner}#${issue.number}`,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    status: getStatusValue(item),
    labels: issueLabels(issue),
    assignees: assigneeLogins(issue),
    updatedAt: issue.updatedAt,
  };
}

async function runManagerAudit(explicitDryRun = null) {
  const org = env('GITHUB_MANAGER_PROJECT_ORG', '<env.<env.OWNER>>');
  const projectNumber = Number(env('GITHUB_MANAGER_PROJECT_NUMBER', '1'));
  const dryRun =
    explicitDryRun === null
      ? env('GITHUB_OPS_DRY_RUN', 'false').toLowerCase() === 'true'
      : explicitDryRun;
  const workStatuses = parseCsv(env('GITHUB_MANAGER_WORK_STATUSES', 'Ready,Working'));
  const inReviewStatuses = parseCsv(env('GITHUB_MANAGER_IN_REVIEW_STATUSES', 'In Review'));
  const doneStatuses = parseCsv(env('GITHUB_MANAGER_DONE_STATUSES', 'Done'));
  const qaLabel = env('GITHUB_MANAGER_QA_LABEL', 'agent:qa');
  const securityLabel = env('GITHUB_MANAGER_SECURITY_LABEL', 'agent:security');
  const agentLabels = new Set(parseCsv(env('GITHUB_MANAGER_AGENT_LABELS', DEFAULT_AGENT_LABELS)));
  const qaApprovers = new Set(parseCsv(env('GITHUB_MANAGER_QA_APPROVERS')).map((entry) => entry.toLowerCase()));
  const securityApprovers = new Set(parseCsv(env('GITHUB_MANAGER_SECURITY_APPROVERS')).map((entry) => entry.toLowerCase()));
  const commentChanges = env('GITHUB_MANAGER_COMMENT_CHANGES', 'true').toLowerCase() !== 'false';
  const cleanupAssignees = env('GITHUB_MANAGER_REMOVE_ASSIGNEES', 'true').toLowerCase() !== 'false';

  let project;
  try {
    project = await getProjectAuditSnapshot(org, projectNumber);
  } catch (error) {
    if (isMissingProjectError(error)) {
      return buildMissingProjectAuditSummary({
        org,
        projectNumber,
        dryRun,
        workStatuses,
        inReviewStatuses,
        doneStatuses,
      });
    }
    throw error;
  }
  const statusField = getStatusField(project);
  const inReviewOption = getStatusOption(statusField, inReviewStatuses[0] || 'In Review');
  const actions = [];

  for (const item of project.items?.nodes || []) {
    const issue = item.content;
    if (!issue?.repository?.nameWithOwner || issue.state !== 'OPEN') continue;

    const status = getStatusValue(item);
    const labels = issueLabels(issue);
    const stageLabels = labels.filter((label) => agentLabels.has(label));
    const prs = normalizePullRequests(issue);
    const qaApproval = detectQaApproval(issue, prs, qaLabel, qaApprovers);
    const securityApproval = detectSecurityApproval(issue, prs, securityLabel, securityApprovers);
    const repoFullName = issue.repository.nameWithOwner;
    const issueRef = `${repoFullName}#${issue.number}`;
    const assignees = assigneeLogins(issue);

    if (statusMatches(status, workStatuses) && qaApproval.approved && securityApproval.approved) {
      const nextLabels = labels.filter((label) => !agentLabels.has(label));
      const reasons = [...securityApproval.reasons, ...qaApproval.reasons];
      const action = {
        type: 'promote-approved-work-item',
        issue: serializeAuditIssue(item),
        fromStatus: status,
        targetStatus: inReviewOption.name,
        reasons,
        nextLabels,
        clearAssignees: cleanupAssignees ? assignees : [],
      };
      actions.push(action);

      if (!dryRun) {
        await githubGraphQL(
          `mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
            updateProjectV2ItemFieldValue(
              input: {
                projectId: $projectId
                itemId: $itemId
                fieldId: $fieldId
                value: { singleSelectOptionId: $optionId }
              }
            ) {
              projectV2Item {
                id
              }
            }
          }`,
          {
            projectId: project.id,
            itemId: item.id,
            fieldId: statusField.id,
            optionId: inReviewOption.id,
          }
        );

        if (nextLabels.length !== labels.length) {
          await replaceLabels({ repo_full_name: repoFullName, issue_number: issue.number, labels: nextLabels });
        }
        if (cleanupAssignees && assignees.length > 0) {
          await removeAssignees({ repo_full_name: repoFullName, issue_number: issue.number, assignees });
        }
        if (commentChanges) {
          await addIssueComment({
            repo_full_name: repoFullName,
            issue_number: issue.number,
            body: buildManagerComment(issueRef, status, inReviewOption.name, reasons),
          });
        }
      }
      continue;
    }

    if ((statusMatches(status, inReviewStatuses) || statusMatches(status, doneStatuses)) && stageLabels.length > 0) {
      const nextLabels = labels.filter((label) => !agentLabels.has(label));
      const action = {
        type: 'cleanup-stage-labels',
        issue: serializeAuditIssue(item),
        fromStatus: status,
        targetStatus: status,
        removedLabels: stageLabels,
        nextLabels,
      };
      actions.push(action);

      if (!dryRun) {
        await replaceLabels({ repo_full_name: repoFullName, issue_number: issue.number, labels: nextLabels });
        if (commentChanges) {
          await addIssueComment({
            repo_full_name: repoFullName,
            issue_number: issue.number,
            body: buildLabelCleanupComment(issueRef, status),
          });
        }
      }
      continue;
    }

    if (cleanupAssignees && statusMatches(status, workStatuses) && assignees.length > 0) {
      const action = {
        type: 'cleanup-assignees',
        issue: serializeAuditIssue(item),
        removedAssignees: assignees,
      };
      actions.push(action);

      if (!dryRun) {
        await removeAssignees({ repo_full_name: repoFullName, issue_number: issue.number, assignees });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: 'manager-audit',
    dryRun,
    project: {
      org,
      number: projectNumber,
      id: project.id,
      title: project.title,
    },
    workStatuses,
    inReviewStatuses,
    doneStatuses,
    actionCount: actions.length,
    actions,
  };
}

function writeOutput(payload) {
  const outDir = env('GITHUB_MANAGER_OUTPUT_DIR', env('GITHUB_OPS_OUTPUT_DIR', '/tmp'));
  const outPath = `${outDir}/github-operations.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const loaded = readOperationsPayload();
  if (loaded.ignored) {
    console.log(JSON.stringify({ ok: true, ignored: true, source: loaded.source }, null, 2));
    return;
  }

  const payload = loaded.payload || {};
  const hasOperations = Array.isArray(payload.operations) && payload.operations.length > 0;
  const shouldRunAuditByDefault =
    !hasOperations &&
    (loaded.commandOnly ||
      ['schedule', 'workflow_dispatch'].includes(env('GITHUB_EVENT_NAME')) ||
      loaded.source === 'none');

  if (shouldRunAuditByDefault) {
    const summary = await runManagerAudit(loaded.commandOnly ? true : null);
    const outPath = writeOutput(summary);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: summary.mode,
          dryRun: summary.dryRun,
          skipped: summary.skipped === true,
          reason: summary.reason || null,
          actionCount: summary.actionCount,
          outPath,
        },
        null,
        2
      )
    );
    return;
  }

  const dryRun = loaded.source.startsWith('OPERATIONS_FILE:')
    ? payload.dry_run !== false
    : payload.dry_run === true || env('GITHUB_OPS_DRY_RUN', 'false').toLowerCase() === 'true';
  const operations = hasOperations ? payload.operations : [];
  if (operations.length === 0) {
    throw new Error('No operations provided.');
  }

  const results = [];
  for (const operation of operations) {
    const record = { type: operation.type, input: operation };
    if (dryRun && operation.type !== 'manager_audit') {
      record.dry_run = true;
      results.push(record);
      continue;
    }
    try {
      record.result = await executeOperation(operation);
      record.ok = true;
    } catch (error) {
      record.ok = false;
      record.error = error.message || String(error);
    }
    results.push(record);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    source: loaded.source,
    dryRun,
    mode: 'operations',
    operationCount: operations.length,
    successCount: results.filter((entry) => entry.ok !== false).length,
    failureCount: results.filter((entry) => entry.ok === false).length,
    results,
  };
  const outPath = writeOutput(summary);
  const sourceMatch = loaded.source.match(/^issue_comment:(.+)#(\d+)$/);
  const reportTo = payload.report_to || (
    sourceMatch
      ? { repo_full_name: sourceMatch[1], issue_number: Number(sourceMatch[2]) }
      : null
  );
  if (reportTo?.repo_full_name && reportTo?.issue_number) {
    const failedRefs = results
      .filter((entry) => entry.ok === false)
      .map((entry) => {
        const ref = entry.input?.repo_full_name && entry.input?.issue_number
          ? `${entry.input.repo_full_name}#${entry.input.issue_number}`
          : entry.type;
        return `- ${ref}`;
      });
    const body = [
      '### GitHub Manager',
      '',
      `Operacoes concluidas: ${summary.successCount}/${summary.operationCount} com sucesso.`,
      `Falhas: ${summary.failureCount}.`,
      `Modo dry-run: ${summary.dryRun ? 'sim' : 'nao'}.`,
      ...(failedRefs.length > 0 ? ['', 'Itens com falha:', ...failedRefs] : []),
    ].join('\n');
    await addIssueComment({
      repo_full_name: reportTo.repo_full_name,
      issue_number: Number(reportTo.issue_number),
      body,
    });
  }
  console.log(
    JSON.stringify(
      {
        ok: summary.failureCount === 0,
        mode: summary.mode,
        outPath,
        dryRun,
        operationCount: operations.length,
        failureCount: summary.failureCount,
      },
      null,
      2
    )
  );
  if (summary.failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
