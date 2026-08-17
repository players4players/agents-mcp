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
const RETRY = githubRetryConfig('CTO_PR_FINALIZER');
const DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS = 'OWNER,MEMBER,COLLABORATOR';
const DEFAULT_STAGING_BRANCH = 'staging';
const DEFAULT_IN_REVIEW_STATUS = 'In Review';
const QA_ACCEPTED_LABELS = ['qa:accepted', 'approved:qa'];
const QA_REJECTED_LABELS = ['qa:rejected', 'rejected:qa'];
const SECURITY_ACCEPTED_LABELS = ['security:accepted', 'approved:security'];
const SECURITY_REJECTED_LABELS = ['security:rejected', 'rejected:security'];

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

function hasAnyLabel(labels, candidates) {
  return candidates.some((label) => labels.has(label));
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
            'User-Agent': 'OWNER-cto-pr-finalizer',
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
    { label: 'GitHub GraphQL CTO PR finalizer', ...RETRY }
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
            'User-Agent': 'OWNER-cto-pr-finalizer',
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
    { label: `GitHub REST CTO PR finalizer ${path}`, ...RETRY }
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

function authorIsEligible(issue, allowedAssociations) {
  return allowedAssociations.has((issue.authorAssociation || '').toUpperCase());
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

function pullRequestLabels(pr) {
  return (pr.labels?.nodes || []).map((label) => label?.name).filter(Boolean);
}

function isOpenPullRequest(pr) {
  return pr?.state === 'OPEN';
}

function branchContainsIssueNumber(headRefName, issueNumber) {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[/-])${escaped}([/-]|$)`);
  return pattern.test(headRefName || '');
}

function prIsReady(pr, issueNumber, stagingBranch) {
  const labels = new Set(pullRequestLabels(pr));
  if (hasAnyLabel(labels, QA_REJECTED_LABELS) || hasAnyLabel(labels, SECURITY_REJECTED_LABELS)) return false;
  if (!hasAnyLabel(labels, QA_ACCEPTED_LABELS) || !hasAnyLabel(labels, SECURITY_ACCEPTED_LABELS)) return false;
  if (!isOpenPullRequest(pr)) return false;
  if (pr.isDraft) return false;
  if ((pr.baseRefName || '').trim().toLowerCase() !== stagingBranch.toLowerCase()) return false;
  if (!branchContainsIssueNumber(pr.headRefName || '', issueNumber)) return false;
  if (pr.mergeable === false || pr.mergeable === 'CONFLICTING') return false;
  return true;
}

function sortByIssueCreatedAt(items) {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.content?.createdAt || '') || 0;
    const rightTs = Date.parse(right.content?.createdAt || '') || 0;
    return leftTs - rightTs;
  });
}

function findCandidate(items, allowedAssociations, stagingBranch) {
  for (const item of sortByIssueCreatedAt(items)) {
    const issue = item.content;
    if (!issue?.repository?.nameWithOwner) continue;
    if (issue.state !== 'OPEN') continue;
    if (!authorIsEligible(issue, allowedAssociations)) continue;

    const pullRequest = normalizePullRequests(issue).find((pr) => prIsReady(pr, issue.number, stagingBranch));
    if (pullRequest) return { item, pullRequest };
  }
  return null;
}

function serializeCandidate(item, pr) {
  const issue = item.content;
  return {
    issue: {
      id: issue.id,
      ref: `${issue.repository.nameWithOwner}#${issue.number}`,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      createdAt: issue.createdAt,
      authorLogin: issue.author?.login || null,
      authorAssociation: issue.authorAssociation || null,
    },
    pullRequest: {
      id: pr.id,
      ref: `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: Boolean(pr.isDraft),
      mergeable: pr.mergeable,
      baseRefName: pr.baseRefName || null,
      headRefName: pr.headRefName || null,
      labels: pullRequestLabels(pr),
    },
  };
}

async function approvePullRequest(prId, body) {
  await githubGraphQL(
    `mutation($pullRequestId:ID!, $event:PullRequestReviewEvent!, $body:String!) {
      addPullRequestReview(input:{pullRequestId:$pullRequestId, event:$event, body:$body}) {
        pullRequestReview {
          id
          state
        }
      }
    }`,
    { pullRequestId: prId, event: 'APPROVE', body }
  );
}

async function mergePullRequest(repoFullName, pullNumber, mergeMethod) {
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: mergeMethod }),
  });
}

async function addIssueComment(repoFullName, issueNumber, body) {
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

function buildApprovalBody(issueRef) {
  return [
    'CTO aprovou esta PR para a promocao final.',
    `Issue vinculada: ${issueRef}.`,
    'QA e Security ja registraram aceite por label e a branch atende a politica operacional.',
  ].join(' ');
}

function buildIssueComment(issueRef, prRef, inReviewStatus) {
  return [
    '### CTO concluiu a trilha tecnica',
    '',
    `Issue: ${issueRef}`,
    `PR: ${prRef}`,
    `Status do projeto: ${inReviewStatus}`,
    '',
    'O CTO aprovou a PR, promoveu a mudanca em staging e moveu a task para In Review.',
  ].join('\n');
}

function writeOutputFile(payload) {
  const outDir = env('CTO_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/cto-pr-finalizer.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('CTO_PROJECT_ORG', 'OWNER');
  const projectNumber = Number(env('CTO_PROJECT_NUMBER', '1'));
  const dryRun = env('CTO_FINALIZER_DRY_RUN', env('CTO_DRY_RUN', 'true')).toLowerCase() !== 'false';
  const stagingBranch = env('CTO_STAGING_BRANCH', DEFAULT_STAGING_BRANCH);
  const mergeMethod = env('CTO_STAGING_MERGE_METHOD', 'merge');
  const inReviewStatus = env('CTO_IN_REVIEW_STATUS', DEFAULT_IN_REVIEW_STATUS);
  const allowedAssociations = new Set(
    parseCsv(env('CTO_ALLOWED_AUTHOR_ASSOCIATIONS', DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS)).map((value) =>
      value.toUpperCase()
    )
  );

  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);

  const candidate = findCandidate(project.items?.nodes || [], allowedAssociations, stagingBranch);
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
    inReviewStatus,
    acceptedLabelsRecognized: [...QA_ACCEPTED_LABELS, ...SECURITY_ACCEPTED_LABELS],
    candidate: candidate ? serializeCandidate(candidate.item, candidate.pullRequest) : null,
  };

  if (!candidate) {
    result.ok = true;
    result.skipped = true;
    result.reason = 'Nenhuma PR pronta para aprovacao exclusiva do CTO foi encontrada.';
    const outPath = writeOutputFile(result);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason, outPath }, null, 2));
    return;
  }

  const issue = candidate.item.content;
  const pr = candidate.pullRequest;
  const issueRef = `${issue.repository.nameWithOwner}#${issue.number}`;
  const prRef = `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`;
  result.action = {
    issue: issueRef,
    pullRequest: prRef,
    targetProjectStatus: inReviewStatus,
  };

  if (!dryRun) {
    await approvePullRequest(pr.id, buildApprovalBody(issueRef));
    await mergePullRequest(pr.repository.nameWithOwner, pr.number, mergeMethod);
    await moveProjectItem(project, candidate.item.id, inReviewStatus);
    await addIssueComment(issue.repository.nameWithOwner, issue.number, buildIssueComment(issueRef, prRef, inReviewStatus));
  }

  result.ok = true;
  result.reason = 'Somente o CTO aprovou a PR e moveu a task para In Review.';
  const outPath = writeOutputFile(result);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        issue: issueRef,
        pullRequest: prRef,
        targetProjectStatus: inReviewStatus,
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