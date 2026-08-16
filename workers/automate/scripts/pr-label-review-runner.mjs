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
const RETRY = githubRetryConfig('PR_LABEL_REVIEW');
const DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS = 'OWNER,MEMBER,COLLABORATOR';
const DEFAULT_STAGING_BRANCH = 'staging';
const DEFAULT_BLOCKED_HEAD_BRANCHES = 'master,main,staging';
const DEFAULT_WORK_STATUSES = 'Ready,Working';
const ALL_AGENT_LABELS = [
  'agent:developer',
  'agent:security',
  'agent:qa',
  'agent:devops',
  'agent:sysadmin',
];

const REVIEWER_META = {
  qa: {
    displayName: 'Quality Assurance',
    acceptedLabel: 'qa:accepted',
    rejectedLabel: 'qa:rejected',
    expectedIssueLabel: 'agent:qa',
    legacyAcceptedLabel: 'approved:qa',
    legacyRejectedLabel: 'rejected:qa',
    checklist: [
      'o escopo ficou dentro do limite de linhas e nao gerou arquivos inchados sem necessidade',
      'componentes, hooks, services e helpers foram reaproveitados quando existiam na base',
      'smoke tests foram executados ou atualizados sempre que a interface foi tocada',
      'testes unitarios relevantes em PHP e JS foram adicionados ou atualizados',
      'helpers da pasta `ui-commun` foram usados quando aplicavel',
      'a issue e o `AGENTS.md` mais especifico foram consultados antes do aceite',
    ],
  },
  security: {
    displayName: 'Security Review',
    acceptedLabel: 'security:accepted',
    rejectedLabel: 'security:rejected',
    expectedIssueLabel: 'agent:security',
    legacyAcceptedLabel: 'approved:security',
    legacyRejectedLabel: 'rejected:security',
    checklist: [
      'autorizacao e controle de acesso foram validados no fluxo alterado',
      'exposicao de dados e leituras indevidas foram revisadas',
      'IDOR, mass assignment e alteracao indevida de status foram considerados',
      'o `securityFilter` do service equivalente protege leitura e escrita quando aplicavel',
      'as regras sensiveis do dominio e o `AGENTS.md` do escopo foram conferidos',
    ],
  },
};

const LEGACY_REVIEW_LABELS = [
  REVIEWER_META.qa.legacyAcceptedLabel,
  REVIEWER_META.qa.legacyRejectedLabel,
  REVIEWER_META.security.legacyAcceptedLabel,
  REVIEWER_META.security.legacyRejectedLabel,
];

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function parseCsv(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function getToken() {
  return env('GITHUB_TOKEN') || env('GH_TOKEN');
}

function getRole() {
  const role = env('PR_REVIEW_ROLE');
  if (!REVIEWER_META[role]) throw new Error(`Unsupported PR_REVIEW_ROLE: ${role}`);
  return role;
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
            'User-Agent': 'players4players-pr-label-review-runner',
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
    { label: 'GitHub GraphQL PR label review runner', ...RETRY }
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
            'User-Agent': 'players4players-pr-label-review-runner',
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
    { label: `GitHub REST PR label review runner ${path}`, ...RETRY }
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
                repository {
                  nameWithOwner
                }
                labels(first:50) {
                  nodes {
                    name
                  }
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
                          createdAt
                          updatedAt
                          baseRefName
                          headRefName
                          labels(first:50) {
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

function labelsFrom(nodes = []) {
  return nodes.map((label) => label?.name).filter(Boolean);
}

function issueLabels(issue) {
  return labelsFrom(issue.labels?.nodes || []);
}

function pullRequestLabels(pr) {
  return labelsFrom(pr.labels?.nodes || []);
}

function getProjectStatus(item) {
  const statusValue = item.fieldValues?.nodes?.find((node) => node?.field?.name?.toLowerCase() === 'status');
  return statusValue?.name || null;
}

function authorIsEligible(issue, allowedAssociations) {
  return allowedAssociations.has((issue.authorAssociation || '').toUpperCase());
}

function isOpenPullRequest(pr) {
  return pr?.state === 'OPEN';
}

function branchContainsIssueNumber(headRefName, issueNumber) {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[/-])${escaped}([/-]|$)`);
  return pattern.test(headRefName || '');
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

function isBlockedHeadBranch(pr, blockedHeadBranches) {
  return blockedHeadBranches.has((pr.headRefName || '').trim().toLowerCase());
}

function issueAlreadyReviewed(issue, meta) {
  const labels = new Set(issueLabels(issue));
  return [
    meta.acceptedLabel,
    meta.rejectedLabel,
    meta.legacyAcceptedLabel,
    meta.legacyRejectedLabel,
  ].some((label) => label && labels.has(label));
}

function hasLegacyDecisionLabel(issue, pr) {
  const labels = new Set([...issueLabels(issue), ...pullRequestLabels(pr)]);
  return LEGACY_REVIEW_LABELS.some((label) => labels.has(label));
}

function candidatePullRequest(issue, stagingBranch, blockedHeadBranches) {
  return normalizePullRequests(issue).find((pr) => {
    if (!isOpenPullRequest(pr)) return false;
    if (pr.isDraft) return false;
    if ((pr.baseRefName || '').trim().toLowerCase() !== stagingBranch.toLowerCase()) return false;
    if (!branchContainsIssueNumber(pr.headRefName || '', issue.number)) return false;
    if (isBlockedHeadBranch(pr, blockedHeadBranches)) return false;
    return true;
  });
}

function sortByIssueCreatedAt(items) {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.content?.createdAt || '') || 0;
    const rightTs = Date.parse(right.content?.createdAt || '') || 0;
    return leftTs - rightTs;
  });
}

function issueInExpectedStage(item, meta, workStatuses) {
  const labels = new Set(issueLabels(item.content));
  if (meta.expectedIssueLabel === 'agent:qa' || meta.expectedIssueLabel === 'agent:security') {
    return labels.has(meta.expectedIssueLabel);
  }
  const status = (getProjectStatus(item) || '').trim();
  if (status && !workStatuses.has(status.toLowerCase())) return false;
  return labels.has(meta.expectedIssueLabel);
}

function getCandidate(items, role, allowedAssociations, stagingBranch, blockedHeadBranches, workStatuses) {
  const meta = REVIEWER_META[role];
  for (const item of sortByIssueCreatedAt(items)) {
    const issue = item.content;
    if (!issue?.repository?.nameWithOwner) continue;
    if (issue.state !== 'OPEN') continue;
    if (!authorIsEligible(issue, allowedAssociations)) continue;
    if (!issueInExpectedStage(item, meta, workStatuses)) continue;
    if (issueAlreadyReviewed(issue, meta)) continue;

    const pr = candidatePullRequest(issue, stagingBranch, blockedHeadBranches);
    if (!pr) continue;
    if (hasLegacyDecisionLabel(issue, pr)) continue;
    return { item, issue, pr };
  }
  return null;
}

function roleDecisionLabels(meta) {
  return [
    meta.acceptedLabel,
    meta.rejectedLabel,
    meta.legacyAcceptedLabel,
    meta.legacyRejectedLabel,
  ].filter(Boolean);
}

function roleIssueLabelsToClear(meta) {
  return [...new Set([meta.expectedIssueLabel, ...roleDecisionLabels(meta)])];
}

function rolePrLabelsToClear(meta) {
  return [...new Set(roleDecisionLabels(meta))];
}

async function addLabelsToIssue(repoFullName, issueNumber, labels) {
  const [owner, repo] = repoFullName.split('/');
  return githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  });
}

async function removeLabelFromIssue(repoFullName, issueNumber, label) {
  const [owner, repo] = repoFullName.split('/');
  try {
    await githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if ((error.message || '').includes('404')) return;
    throw error;
  }
}

async function addLabelsToPullRequest(repoFullName, pullNumber, labels) {
  const [owner, repo] = repoFullName.split('/');
  return githubRest(`/repos/${owner}/${repo}/issues/${pullNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  });
}

async function addIssueComment(repoFullName, issueNumber, body) {
  const [owner, repo] = repoFullName.split('/');
  return githubRest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function syncIssueStage(issue, pr, meta, decision) {
  for (const label of roleIssueLabelsToClear(meta)) {
    await removeLabelFromIssue(issue.repository.nameWithOwner, issue.number, label);
  }

  for (const label of rolePrLabelsToClear(meta)) {
    await removeLabelFromIssue(pr.repository.nameWithOwner, pr.number, label);
  }

  const decisionLabel = decision === 'accepted' ? meta.acceptedLabel : meta.rejectedLabel;
  const issueLabelsToApply = [decisionLabel];

  await addLabelsToIssue(issue.repository.nameWithOwner, issue.number, issueLabelsToApply);
  await addLabelsToPullRequest(pr.repository.nameWithOwner, pr.number, [decisionLabel]);
}

function serializeCandidate(item, issue, pr) {
  return {
    currentProjectStatus: getProjectStatus(item),
    issue: {
      ref: `${issue.repository.nameWithOwner}#${issue.number}`,
      title: issue.title,
      url: issue.url,
      labels: issueLabels(issue),
    },
    pullRequest: {
      ref: `${pr.repository?.nameWithOwner || 'unknown'}#${pr.number}`,
      title: pr.title,
      url: pr.url,
      labels: pullRequestLabels(pr),
      baseRefName: pr.baseRefName || null,
      headRefName: pr.headRefName || null,
      mergeable: pr.mergeable,
    },
  };
}

function buildComment(meta, issueRef, prRef, decision, reasons = []) {
  const approved = decision === 'accepted';
  const decisionLabel = approved ? meta.acceptedLabel : meta.rejectedLabel;
  const lines = [
    `### ${meta.displayName} ${approved ? 'aprovado' : 'reprovado'}`,
    '',
    `Issue: ${issueRef}`,
    `PR: ${prRef}`,
    '',
    'Ação: a task foi tratada apenas por labels; a coluna do projeto nao foi alterada.',
    `Label de decisão aplicado: \`${decisionLabel}\`.`,
    '',
    'Checklist obrigatorio para aprovacao:',
    ...meta.checklist.map((item) => `- ${item}`),
  ];

  if (!approved) {
    lines.push('', 'Motivos objetivos da recusa:', ...reasons.map((reason) => `- ${reason}`));
  }

  return lines.join('\n');
}

function writeOutputFile(payload) {
  const outDir = env('PR_REVIEW_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/pr-label-review-runner.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('PR_REVIEW_PROJECT_ORG', env('CTO_PROJECT_ORG', 'players4players'));
  const projectNumber = Number(env('PR_REVIEW_PROJECT_NUMBER', env('CTO_PROJECT_NUMBER', '1')));
  const role = getRole();
  const meta = REVIEWER_META[role];
  const dryRun = env('PR_REVIEW_DRY_RUN', env('AGENT_DRY_RUN', 'true')).toLowerCase() !== 'false';
  const stagingBranch = env('PR_REVIEW_STAGING_BRANCH', DEFAULT_STAGING_BRANCH);
  const blockedHeadBranches = new Set(
    parseCsv(env('PR_REVIEW_BLOCKED_HEAD_BRANCHES', DEFAULT_BLOCKED_HEAD_BRANCHES)).map((value) =>
      value.toLowerCase()
    )
  );
  const allowedAssociations = new Set(
    parseCsv(env('PR_REVIEW_ALLOWED_AUTHOR_ASSOCIATIONS', DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS)).map((value) =>
      value.toUpperCase()
    )
  );
  const workStatuses = new Set(
    parseCsv(env('PR_REVIEW_WORK_STATUSES', DEFAULT_WORK_STATUSES)).map((value) => value.toLowerCase())
  );

  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);

  const candidate = getCandidate(
    project.items?.nodes || [],
    role,
    allowedAssociations,
    stagingBranch,
    blockedHeadBranches,
    workStatuses
  );
  const result = {
    generatedAt: new Date().toISOString(),
    dryRun,
    role,
    project: {
      org,
      number: projectNumber,
      id: project.id,
      title: project.title,
    },
    workStatuses: Array.from(workStatuses),
    candidate: candidate ? serializeCandidate(candidate.item, candidate.issue, candidate.pr) : null,
  };

  if (!candidate) {
    result.ok = true;
    result.skipped = true;
    result.reason = `Nenhuma issue elegível para ${meta.displayName} na etapa ${meta.expectedIssueLabel} foi encontrada.`;
    const outPath = writeOutputFile(result);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason, outPath }, null, 2));
    return;
  }

  const issueRef = `${candidate.issue.repository.nameWithOwner}#${candidate.issue.number}`;
  const prRef = `${candidate.pr.repository?.nameWithOwner || 'unknown'}#${candidate.pr.number}`;

  result.action = {
    issue: issueRef,
    pullRequest: prRef,
    labelsApplied: [meta.acceptedLabel],
    legacyLabelsStillRecognized: LEGACY_REVIEW_LABELS,
  };

  if (!dryRun) {
    await syncIssueStage(candidate.issue, candidate.pr, meta, 'accepted');
    await addLabelsToPullRequest(candidate.pr.repository.nameWithOwner, candidate.pr.number, [meta.acceptedLabel]);
    await addIssueComment(
      candidate.issue.repository.nameWithOwner,
      candidate.issue.number,
      buildComment(meta, issueRef, prRef, 'accepted')
    );
  }

  result.ok = true;
  result.reason = `${meta.displayName} registrou ${meta.acceptedLabel} e manteve a trilha na etapa operacional correta.`;
  const outPath = writeOutputFile(result);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        issue: issueRef,
        pullRequest: prRef,
        label: meta.acceptedLabel,
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
