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
const RETRY = githubRetryConfig('CTO_STAGING');
const ALL_AGENT_LABELS = ['agent:developer', 'agent:security', 'agent:qa', 'agent:devops', 'agent:sysadmin'];
const DEFAULT_KNOWN_AGENT_LOGINS = 'github-copilot[bot],copilot-swe-agent,copilot';
const DEFAULT_QA_APPROVED_LABEL = 'approved:qa';
const DEFAULT_SECURITY_APPROVED_LABEL = 'approved:security';
const DEFAULT_STAGING_BRANCH = 'staging';
const DEFAULT_READY_STATUSES = 'Ready,Working,In Review';

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

function statusMatches(status, allowedStatuses) {
  const normalized = (status || '').trim().toLowerCase();
  return allowedStatuses.some((entry) => entry.toLowerCase() === normalized);
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
            'User-Agent': 'OWNER-cto-staging-promotion',
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
    { label: 'GitHub GraphQL CTO staging promotion', ...RETRY }
  );
}

async function githubRest(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');

  return retryAsync(
    async () => {
      let response;
      try {
        response = await fetch(`${REST_URL}${path}`, {
          ...options,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'OWNER-cto-staging-promotion',
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
        if (isRetriableStatus(response.status)) throw retryableError(message);
        throw new Error(message);
      }

      if (!response.ok) {
        const message = JSON.stringify({ status: response.status, path, body }, null, 2);
        if (isRetriableStatus(response.status)) throw retryableError(message);
        throw new Error(message);
      }

      return body;
    },
    { label: `GitHub REST CTO staging promotion ${path}`, ...RETRY }
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
                          mergedAt
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

function getStatusValue(item) {
  const value = item.fieldValues?.nodes?.find((node) => node?.field?.name?.toLowerCase() === 'status');
  return value?.name || null;
}

function statusField(project) {
  const field = project.fields.nodes.find((node) => node?.name === 'Status' && node?.options);
  if (!field) throw new Error('Status field not found');
  return field;
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

function issueLabels(issue) {
  return (issue.labels?.nodes || []).map((label) => label?.name).filter(Boolean);
}

function pullRequestLabels(pr) {
  return (pr.labels?.nodes || []).map((label) => label?.name).filter(Boolean);
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

async function cleanupTechnicalAssignees(issue, knownAgentLogins) {
  const preservedHumanActorIds = retainedHumanActorIds(issue, knownAgentLogins);
  const technicalAssignees = technicalAgentLogins(issue, knownAgentLogins);

  if (technicalAssignees.length === 0) {
    return { technicalAssignees, cleared: false };
  }

  await replaceAssignableActors(issue.id, preservedHumanActorIds);
  await removeIssueAssignees(issue.repository.nameWithOwner, issue.number, technicalAssignees);
  return { technicalAssignees, cleared: true };
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

function approvalPresent(issue, pullRequests, label) {
  return issueLabels(issue).includes(label) || pullRequests.some((pr) => pullRequestLabels(pr).includes(label));
}

function serializePullRequest(pr) {
  return {
    ref: `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`,
    repository: pr.repository?.nameWithOwner || 'unknown',
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    baseRefName: pr.baseRefName || null,
    headRefName: pr.headRefName || null,
    isDraft: Boolean(pr.isDraft),
    mergeable: pr.mergeable,
    mergedAt: pr.mergedAt || null,
    labels: pullRequestLabels(pr),
  };
}

function buildPromotionComment(issueRef, fromStatus, doneStatus, mergedRefs, reasons) {
  return [
    '### CTO - promoção para staging concluída',
    '',
    `Issue: ${issueRef}`,
    `Ação: o CTO aceitou o PR em \`staging\` e moveu a task de \`${fromStatus}\` para \`${doneStatus}\`.`,
    '',
    'Sinais objetivos:',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    'PRs processados:',
    ...mergedRefs.map((ref) => `- ${ref}`),
  ].join('\n');
}

async function replaceIssueLabels(repoFullName, issueNumber, labels) {
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'PUT',
    body: JSON.stringify(labels),
  });
}

async function mergePullRequest(pr, mergeMethod) {
  const [owner, repo] = (pr.repository?.nameWithOwner || '').split('/');
  if (!owner || !repo) throw new Error(`Invalid PR repository: ${pr.repository?.nameWithOwner || 'unknown'}`);
  return githubRest(`/repos/${owner}/${repo}/pulls/${pr.number}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: mergeMethod }),
  });
}

function writeOutputFile(payload) {
  const outDir = env('CTO_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/cto-staging-promotion.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('CTO_PROJECT_ORG', 'OWNER');
  const projectNumber = Number(env('CTO_PROJECT_NUMBER', '1'));
  const dryRun = env('CTO_STAGING_DRY_RUN', env('CTO_DRY_RUN', 'true')).toLowerCase() !== 'false';
  const doneStatus = env('CTO_DONE_STATUS', 'Done');
  const readyStatuses = parseCsv(env('CTO_READY_STATUSES', DEFAULT_READY_STATUSES));
  const qaApprovedLabel = env('CTO_QA_APPROVED_LABEL', DEFAULT_QA_APPROVED_LABEL);
  const securityApprovedLabel = env('CTO_SECURITY_APPROVED_LABEL', DEFAULT_SECURITY_APPROVED_LABEL);
  const stagingBranch = env('CTO_STAGING_BRANCH', DEFAULT_STAGING_BRANCH);
  const mergeMethod = env('CTO_STAGING_MERGE_METHOD', 'merge');
  const commentChanges = env('CTO_STAGING_COMMENT_CHANGES', 'true').toLowerCase() !== 'false';
  const cleanupAssignees = env('CTO_STAGING_REMOVE_ASSIGNEES', 'true').toLowerCase() !== 'false';
  const knownAgentLogins = new Set(
    parseCsv(env('CTO_KNOWN_AGENT_LOGINS', DEFAULT_KNOWN_AGENT_LOGINS)).map((login) => login.toLowerCase())
  );

  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);

  const actions = [];

  for (const item of project.items?.nodes || []) {
    const issue = item.content;
    if (!issue?.repository?.nameWithOwner || issue.state !== 'OPEN') continue;

    const currentStatus = getStatusValue(item);
    if (!statusMatches(currentStatus, readyStatuses)) continue;

    const pullRequests = normalizePullRequests(issue);
    const securityApproved = approvalPresent(issue, pullRequests, securityApprovedLabel);
    const qaApproved = approvalPresent(issue, pullRequests, qaApprovedLabel);
    if (!securityApproved || !qaApproved) continue;

    const stagingPullRequests = pullRequests.filter((pr) => pr.baseRefName === stagingBranch);
    const mergedStagingPullRequests = stagingPullRequests.filter((pr) => pr.mergedAt);
    const openStagingPullRequests = stagingPullRequests.filter((pr) => isOpenPullRequest(pr));
    const blockedPullRequests = openStagingPullRequests.filter((pr) => pr.isDraft || mergeConflictForPr(pr));
    const issueRef = `${issue.repository.nameWithOwner}#${issue.number}`;

    if (stagingPullRequests.length === 0) {
      actions.push({
        type: 'awaiting-staging-pr',
        issue: issueRef,
        currentStatus,
        reason: `as labels ${securityApprovedLabel} e ${qaApprovedLabel} já existem, mas não há PR vinculado com base em ${stagingBranch}`,
      });
      continue;
    }

    if (blockedPullRequests.length > 0) {
      actions.push({
        type: 'blocked-staging-pr',
        issue: issueRef,
        currentStatus,
        pullRequests: blockedPullRequests.map(serializePullRequest),
      });
      continue;
    }

    const mergedRefs = mergedStagingPullRequests.map((pr) => `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`);
    const pullRequestsToMerge = openStagingPullRequests;
    const nextLabels = issueLabels(issue).filter(
      (label) =>
        !ALL_AGENT_LABELS.includes(label) &&
        label !== qaApprovedLabel &&
        label !== securityApprovedLabel
    );
    const reasons = [
      `a tag ${securityApprovedLabel} está presente`,
      `a tag ${qaApprovedLabel} está presente`,
      `há ${stagingPullRequests.length} PR(s) vinculado(s) para ${stagingBranch}`,
    ];

    const action = {
      type: 'promote-approved-item-to-done',
      issue: issueRef,
      fromStatus: currentStatus,
      targetStatus: doneStatus,
      pullRequestsToMerge: pullRequestsToMerge.map(serializePullRequest),
      mergedPullRequestRefs: mergedRefs,
      nextLabels,
    };
    actions.push(action);

    if (dryRun) continue;

    for (const pr of pullRequestsToMerge) {
      await mergePullRequest(pr, mergeMethod);
      mergedRefs.push(`${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`);
    }

    await moveProjectItem(project, item.id, doneStatus);
    await replaceIssueLabels(issue.repository.nameWithOwner, issue.number, nextLabels);

    if (cleanupAssignees) {
      const cleanup = await cleanupTechnicalAssignees(issue, knownAgentLogins);
      action.clearedTechnicalAssignees = cleanup.technicalAssignees;
    }

    if (commentChanges) {
      await githubGraphQL(
        `mutation($subjectId:ID!, $body:String!) {
          addComment(input:{subjectId:$subjectId, body:$body}) {
            commentEdge { node { id } }
          }
        }`,
        {
          subjectId: issue.id,
          body: buildPromotionComment(issueRef, currentStatus, doneStatus, mergedRefs, reasons),
        }
      );
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    dryRun,
    project: {
      org,
      number: projectNumber,
      id: project.id,
      title: project.title,
    },
    stagingBranch,
    doneStatus,
    qaApprovedLabel,
    securityApprovedLabel,
    actionCount: actions.length,
    actions,
  };

  const outPath = writeOutputFile(result);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
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
