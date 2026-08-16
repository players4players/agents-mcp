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
const RETRY = githubRetryConfig('TECHNICAL_LEAD_PR_FINALIZER');
const DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS = 'OWNER,MEMBER,COLLABORATOR';
const DEFAULT_STAGING_BRANCH = 'staging';
const DEFAULT_IN_REVIEW_STATUS = 'In Review';
const QA_ACCEPTED_LABEL = 'approved:qa';
const QA_REJECTED_LABEL = 'rejected:qa';
const SECURITY_ACCEPTED_LABEL = 'approved:security';
const SECURITY_REJECTED_LABEL = 'rejected:security';

function env(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function parseCsv(value) { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function getToken() { return env('GITHUB_TOKEN') || env('GH_TOKEN'); }

async function githubGraphQL(query, variables = {}) {
  const token = getToken();
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');
  return retryAsync(async () => {
    let response;
    try {
      response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'players4players-technical-lead-pr-finalizer' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw retryableError(`GitHub GraphQL request failed: ${error.message || error}`);
    }
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch {
      if (isRetriableStatus(response.status)) throw retryableError(text);
      throw new Error(text);
    }
    if (!response.ok || json.errors) {
      const message = JSON.stringify({ status: response.status, errors: json.errors || json }, null, 2);
      if ((!response.ok && isRetriableStatus(response.status)) || isRetriableGraphQLErrors(json.errors)) throw retryableError(message);
      throw new Error(message);
    }
    return json.data;
  }, { label: 'GitHub GraphQL Technical Lead PR finalizer', ...RETRY });
}

async function githubRest(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');
  return retryAsync(async () => {
    let response;
    try {
      response = await fetch(`${REST_URL}${path}`, {
        ...options,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'players4players-technical-lead-pr-finalizer',
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      throw retryableError(`GitHub REST request failed: ${error.message || error}`);
    }
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch {
      if (isRetriableStatus(response.status)) throw retryableError(text);
      throw new Error(text);
    }
    if (!response.ok) {
      const message = JSON.stringify({ status: response.status, path, body }, null, 2);
      if (isRetriableStatus(response.status)) throw retryableError(message);
      throw new Error(message);
    }
    return body;
  }, { label: `GitHub REST Technical Lead PR finalizer ${path}`, ...RETRY });
}

async function getProjectSnapshot(org, projectNumber) {
  const query = `query($org:String!, $projectNumber:Int!, $cursor:String) {
    organization(login:$org) { projectV2(number:$projectNumber) { id title fields(first:50) { nodes { ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { id name options { id name } } } }
      items(first:100, after:$cursor) { pageInfo { hasNextPage endCursor } nodes { id content { ... on Issue { id number title url state createdAt updatedAt authorAssociation author { login } repository { nameWithOwner } labels(first:50) { nodes { name } }
        timelineItems(first:50, itemTypes:[CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent { source { __typename ... on PullRequest { id number title url state isDraft mergeable baseRefName headRefName labels(first:50) { nodes { name } } repository { nameWithOwner } } } } } }
      } } } }
    } }
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

function labelsFrom(nodes = []) { return nodes.map((label) => label?.name).filter(Boolean); }
function issueLabels(issue) { return labelsFrom(issue.labels?.nodes || []); }
function pullRequestLabels(pr) { return labelsFrom(pr.labels?.nodes || []); }
function authorIsEligible(issue, allowedAssociations) { return allowedAssociations.has((issue.authorAssociation || '').toUpperCase()); }
function isOpenPullRequest(pr) { return pr?.state === 'OPEN'; }
function branchContainsIssueNumber(headRefName, issueNumber) {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[/-])${escaped}([/-]|$)`).test(headRefName || '');
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
function hasLabel(issue, pr, label) { return issueLabels(issue).includes(label) || pullRequestLabels(pr).includes(label); }
function prIsReady(pr, issue, stagingBranch) {
  if (hasLabel(issue, pr, QA_REJECTED_LABEL) || hasLabel(issue, pr, SECURITY_REJECTED_LABEL)) return false;
  if (!hasLabel(issue, pr, QA_ACCEPTED_LABEL) || !hasLabel(issue, pr, SECURITY_ACCEPTED_LABEL)) return false;
  if (!isOpenPullRequest(pr) || pr.isDraft) return false;
  if ((pr.baseRefName || '').trim().toLowerCase() !== stagingBranch.toLowerCase()) return false;
  if (!branchContainsIssueNumber(pr.headRefName || '', issue.number)) return false;
  if (pr.mergeable === false || pr.mergeable === 'CONFLICTING') return false;
  return true;
}
function sortByIssueCreatedAt(items) {
  return [...items].sort((left, right) => (Date.parse(left.content?.createdAt || '') || 0) - (Date.parse(right.content?.createdAt || '') || 0));
}
function findCandidate(items, allowedAssociations, stagingBranch) {
  for (const item of sortByIssueCreatedAt(items)) {
    const issue = item.content;
    if (!issue?.repository?.nameWithOwner) continue;
    if (issue.state !== 'OPEN') continue;
    if (!authorIsEligible(issue, allowedAssociations)) continue;
    const pullRequest = normalizePullRequests(issue).find((pr) => prIsReady(pr, issue, stagingBranch));
    if (pullRequest) return { item, pullRequest };
  }
  return null;
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
  await githubGraphQL(`mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) { updateProjectV2ItemFieldValue(input:{ projectId:$projectId, itemId:$itemId, fieldId:$fieldId, value:{ singleSelectOptionId:$optionId } }) { projectV2Item { id } } }`, { projectId: project.id, itemId, fieldId, optionId });
}
async function approvePullRequest(prId, body) {
  await githubGraphQL(`mutation($pullRequestId:ID!, $event:PullRequestReviewEvent!, $body:String!) { addPullRequestReview(input:{pullRequestId:$pullRequestId, event:$event, body:$body}) { pullRequestReview { id state } } }`, { pullRequestId: prId, event: 'APPROVE', body });
}
async function mergePullRequest(repoFullName, pullNumber, mergeMethod) {
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: mergeMethod }) });
}
async function addIssueComment(repoFullName, issueNumber, body) {
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}
async function closeIssue(repoFullName, issueNumber) {
  const [owner, repo] = repoFullName.split('/');
  await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
}
function buildApprovalBody(issueRef) {
  return ['Technical Lead aprovou esta PR para staging.', `Issue vinculada: ${issueRef}.`, 'Quality Assurance e Security Review ja registraram aprovacao por label.'].join(' ');
}
function buildIssueComment(issueRef, prRef, inReviewStatus) {
  return ['### Technical Lead concluiu a tarefa', '', `Issue: ${issueRef}`, `PR: ${prRef}`, `Status do projeto: ${inReviewStatus}`, '', 'A PR foi aprovada e mesclada em staging. A tarefa foi marcada como concluida e movida para In Review. Os labels de aprovacao foram preservados para conferencia futura.'].join('\n');
}
function serializeCandidate(item, pr) {
  const issue = item.content;
  return { issue: { ref: `${issue.repository.nameWithOwner}#${issue.number}`, title: issue.title, state: issue.state, labels: issueLabels(issue) }, pullRequest: { ref: `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`, title: pr.title, state: pr.state, labels: pullRequestLabels(pr), baseRefName: pr.baseRefName, headRefName: pr.headRefName } };
}
function writeOutputFile(payload) {
  const outDir = env('TECHNICAL_LEAD_OUTPUT_DIR', env('AGENT_OUTPUT_DIR', '/tmp'));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/technical-lead-pr-finalizer.json`;
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('TECHNICAL_LEAD_PROJECT_ORG', env('CTO_PROJECT_ORG', 'players4players'));
  const projectNumber = Number(env('TECHNICAL_LEAD_PROJECT_NUMBER', env('CTO_PROJECT_NUMBER', '1')));
  const dryRun = env('TECHNICAL_LEAD_DRY_RUN', env('AGENT_DRY_RUN', 'true')).toLowerCase() !== 'false';
  const stagingBranch = env('TECHNICAL_LEAD_STAGING_BRANCH', DEFAULT_STAGING_BRANCH);
  const mergeMethod = env('TECHNICAL_LEAD_STAGING_MERGE_METHOD', 'merge');
  const inReviewStatus = env('TECHNICAL_LEAD_IN_REVIEW_STATUS', DEFAULT_IN_REVIEW_STATUS);
  const allowedAssociations = new Set(parseCsv(env('TECHNICAL_LEAD_ALLOWED_AUTHOR_ASSOCIATIONS', DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS)).map((value) => value.toUpperCase()));
  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);
  const candidate = findCandidate(project.items?.nodes || [], allowedAssociations, stagingBranch);
  const result = { generatedAt: new Date().toISOString(), dryRun, project: { org, number: projectNumber, id: project.id, title: project.title }, stagingBranch, inReviewStatus, candidate: candidate ? serializeCandidate(candidate.item, candidate.pullRequest) : null };
  if (!candidate) {
    result.ok = true; result.skipped = true; result.reason = 'Nenhuma PR pronta para aprovacao exclusiva do Technical Lead foi encontrada.';
    const outPath = writeOutputFile(result);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason, outPath }, null, 2));
    return;
  }
  const issue = candidate.item.content;
  const pr = candidate.pullRequest;
  const issueRef = `${issue.repository.nameWithOwner}#${issue.number}`;
  const prRef = `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`;
  if (!dryRun) {
    await approvePullRequest(pr.id, buildApprovalBody(issueRef));
    await mergePullRequest(pr.repository.nameWithOwner, pr.number, mergeMethod);
    await moveProjectItem(project, candidate.item.id, inReviewStatus);
    await closeIssue(issue.repository.nameWithOwner, issue.number);
    await addIssueComment(issue.repository.nameWithOwner, issue.number, buildIssueComment(issueRef, prRef, inReviewStatus));
  }
  result.ok = true;
  result.reason = 'Somente o Technical Lead aprovou e mesclou a PR; a task foi concluida e movida para In Review.';
  const outPath = writeOutputFile(result);
  console.log(JSON.stringify({ ok: true, dryRun, issue: issueRef, pullRequest: prRef, targetProjectStatus: inReviewStatus, outPath }, null, 2));
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
