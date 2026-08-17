import fs from 'node:fs';

const GITHUB_API_URL = 'https://api.github.com/graphql';
const DECISION_DEVELOPER = 'Developer';
const DECISION_SECURITY = 'Security';
const DECISION_IN_REVIEW = 'In Review';

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
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

function parseMergeTargets(value) {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') {
    return { mode: 'all', branches: [] };
  }

  return {
    mode: 'selected',
    branches: parseCsv(value)
  };
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function githubGraphQL(query, variables = {}) {
  const token = getToken();
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');

  const response = await fetch(GITHUB_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'OWNER-qa-automation'
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  if (!response.ok || json.errors) {
    throw new Error(JSON.stringify({ status: response.status, errors: json.errors || json }, null, 2));
  }

  return json.data;
}

async function getProjectSnapshot(org, projectNumber) {
  const query = `query($org:String!, $projectNumber:Int!, $cursor:String) {
    viewer {
      login
    }
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

function getStatusField(project) {
  return project.fields.nodes.find(
    (field) => field?.name?.toLowerCase() === 'status' && field?.options
  );
}

function getStatusValue(item) {
  const value = item.fieldValues?.nodes?.find(
    (node) => node?.field?.name?.toLowerCase() === 'status'
  );
  return value?.name || null;
}

function listQaItems(project) {
  return (project.items?.nodes || []).filter((item) => {
    if (!item?.content?.repository?.nameWithOwner) return false;
    const status = getStatusValue(item);
    return status?.toLowerCase() === 'quality assurance';
  });
}

async function getIssueQaContext(owner, repo, issueNumber) {
  return githubGraphQL(
    `query($owner:String!, $repo:String!, $issueNumber:Int!) {
      repository(owner:$owner, name:$repo) {
        issue(number:$issueNumber) {
          id
          number
          title
          url
          body
          comments(first:100) {
            nodes {
              id
              author {
                login
              }
              body
              createdAt
            }
          }
          timelineItems(first:100, itemTypes:[CROSS_REFERENCED_EVENT]) {
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
                    body
                    repository {
                      nameWithOwner
                    }
                    author {
                      login
                    }
                    comments(first:50) {
                      nodes {
                        id
                        author {
                          login
                        }
                        body
                      }
                    }
                    reviews(first:50) {
                      nodes {
                        id
                        author {
                          login
                        }
                        state
                        body
                      }
                    }
                    commits(last:1) {
                      nodes {
                        commit {
                          oid
                          statusCheckRollup {
                            state
                            contexts(first:50) {
                              nodes {
                                __typename
                                ... on CheckRun {
                                  name
                                  conclusion
                                  status
                                }
                                ... on StatusContext {
                                  context
                                  state
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
      }
    }`,
    { owner, repo, issueNumber }
  );
}

function normalizePrs(issue) {
  const prs = (issue.timelineItems?.nodes || [])
    .map((node) => node?.source)
    .filter((source) => source?.__typename === 'PullRequest');

  return uniqBy(prs, (pr) => `${pr.repository.nameWithOwner}#${pr.number}`);
}

function getRollupState(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || 'PENDING';
}

function getChecks(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
}

function normalizeCheckContext(node) {
  if (node?.__typename === 'CheckRun') {
    return {
      name: node.name || 'unknown-check-run',
      state: (node.conclusion || node.status || 'PENDING').toUpperCase()
    };
  }

  return {
    name: node?.context || 'unknown-status-context',
    state: (node?.state || 'PENDING').toUpperCase()
  };
}

function isSuccessfulCheckState(state) {
  return ['SUCCESS', 'SUCCESSFUL', 'NEUTRAL', 'SKIPPED'].includes(state);
}

function isNonBlockingExternalCheck(check) {
  const normalizedName = (check.name || '').trim().toLowerCase();
  const normalizedState = (check.state || '').trim().toUpperCase();
  return normalizedName === 'scrutinizer' && ['ERROR', 'FAILURE', 'FAILED'].includes(normalizedState);
}

function evaluateCheckHealth(pr) {
  const checks = getChecks(pr).map(normalizeCheckContext);

  if (checks.length === 0) {
    return {
      checks,
      blocking: [
        {
          name: 'missing-checks',
          state: 'MISSING'
        }
      ],
      warnings: []
    };
  }

  const blocking = [];
  const warnings = [];

  for (const check of checks) {
    if (isSuccessfulCheckState(check.state)) continue;
    if (isNonBlockingExternalCheck(check)) {
      warnings.push(check);
      continue;
    }
    blocking.push(check);
  }

  return { checks, blocking, warnings };
}

function buildEquivalentEvidenceText(issue, prs) {
  return [
    issue.body,
    ...(issue.comments?.nodes || []).map((comment) => comment.body),
    ...prs.flatMap((pr) => [
      pr.body,
      ...(pr.comments?.nodes || []).map((comment) => comment.body),
      ...(pr.reviews?.nodes || []).map((review) => review.body)
    ])
  ]
    .filter(Boolean)
    .join('\n');
}

function hasEquivalentEvidence(issue, prs) {
  const text = buildEquivalentEvidenceText(issue, prs);
  const patterns = [
    /git diff --check/i,
    /pull request checks?/i,
    /github actions/i,
    /phpunit/i,
    /npm test/i,
    /node --test/i,
    /workflow/i,
    /\b\d+\/\d+\s+test/i,
    /tests?\s+passing/i,
    /conclu[ií]d[oa]\s+com\s+sucesso/i,
    /status publicado/i,
    /checks?\s+.*verde/i,
    /valida(c|ç)(a|ã)o\s+.*(sucesso|verde)/i
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function needsSecurityApproval(issue, prs, securityApprovers) {
  if (securityApprovers.length === 0) return false;

  const textMatches = (body = '') => /\b(pk|ok|approved|aprovado|aprovada)\b/i.test(body);

  const issueApproval = (issue.comments?.nodes || []).some((comment) => {
    const login = comment.author?.login?.toLowerCase();
    return securityApprovers.includes(login) && textMatches(comment.body);
  });

  const prApproval = prs.some((pr) =>
    (pr.reviews?.nodes || []).some((review) => {
      const login = review.author?.login?.toLowerCase();
      return securityApprovers.includes(login) && (review.state === 'APPROVED' || textMatches(review.body));
    }) ||
    (pr.comments?.nodes || []).some((comment) => {
      const login = comment.author?.login?.toLowerCase();
      return securityApprovers.includes(login) && textMatches(comment.body);
    })
  );

  return !(issueApproval || prApproval);
}

function formatCheckList(checks) {
  return checks.map((check) => `${check.name}=${check.state}`).join(', ');
}

function buildDecision(issue, prs, securityApprovers) {
  const reasons = [];

  if (prs.length === 0) {
    reasons.push('Nenhum PR vinculado foi encontrado na timeline da issue.');
    return {
      projectTarget: DECISION_DEVELOPER,
      prReviewAction: 'REQUEST_CHANGES',
      status: 'rejected',
      reasons
    };
  }

  const invalidPrs = prs.filter((pr) => pr.state !== 'OPEN' || pr.isDraft);
  if (invalidPrs.length > 0) {
    reasons.push('Existe PR vinculado fechado ou em draft, sem trilha publica pronta para QA.');
    return {
      projectTarget: DECISION_DEVELOPER,
      prReviewAction: 'REQUEST_CHANGES',
      status: 'rejected',
      reasons
    };
  }

  const checkHealth = prs.map((pr) => ({
    pr,
    ...evaluateCheckHealth(pr)
  }));

  const blockingPrs = checkHealth.filter((entry) => entry.blocking.length > 0);
  if (blockingPrs.length > 0) {
    const refs = blockingPrs
      .map((entry) => `${entry.pr.repository.nameWithOwner}#${entry.pr.number} (${formatCheckList(entry.blocking)})`)
      .join(', ');
    reasons.push(`Checks ainda nao estao aceitaveis no commit atual de: ${refs}.`);
    return {
      projectTarget: DECISION_DEVELOPER,
      prReviewAction: 'REQUEST_CHANGES',
      status: 'rejected',
      reasons
    };
  }

  const warningPrs = checkHealth.filter((entry) => entry.warnings.length > 0);
  if (warningPrs.length > 0) {
    if (!hasEquivalentEvidence(issue, prs)) {
      const refs = warningPrs
        .map((entry) => `${entry.pr.repository.nameWithOwner}#${entry.pr.number} (${formatCheckList(entry.warnings)})`)
        .join(', ');
      reasons.push(`Restou apenas falha externa conhecida em ${refs}, mas ainda nao encontrei evidencia tecnica equivalente suficiente publicada na issue/PR.`);
      return {
        projectTarget: DECISION_DEVELOPER,
        prReviewAction: 'REQUEST_CHANGES',
        status: 'rejected',
        reasons
      };
    }

    const refs = warningPrs
      .map((entry) => `${entry.pr.repository.nameWithOwner}#${entry.pr.number} (${formatCheckList(entry.warnings)})`)
      .join(', ');
    reasons.push(`Falha externa conhecida foi tratada como warning em: ${refs}. A issue/PR ja publica evidencia tecnica equivalente para a revisao.`);
  }

  if (needsSecurityApproval(issue, prs, securityApprovers)) {
    reasons.push('Aprovacao obrigatoria de seguranca ainda nao foi encontrada de forma explicita.');
    return {
      projectTarget: DECISION_SECURITY,
      prReviewAction: null,
      status: 'waiting_security',
      reasons
    };
  }

  reasons.push('Checks relevantes estao verdes ou a trilha ja traz evidencia tecnica equivalente suficiente.');
  reasons.push('A entrega esta tecnicamente pronta para verificacao humana final em In Review.');
  return {
    projectTarget: DECISION_IN_REVIEW,
    prReviewAction: 'APPROVE',
    status: 'approved',
    reasons
  };
}

function buildIssueComment(issueRef, decision) {
  const header =
    decision.projectTarget === DECISION_IN_REVIEW
      ? 'QA aprovado'
      : decision.projectTarget === DECISION_SECURITY
        ? 'QA aguardando seguranca'
        : 'QA reprovado';

  const lines = [
    `### ${header}`,
    '',
    `Issue: ${issueRef}`,
    `Destino no ProjectV2: ${decision.projectTarget}`,
    ''
  ];

  for (const reason of decision.reasons) {
    lines.push(`- ${reason}`);
  }

  return lines.join('\n');
}

async function addComment(subjectId, body) {
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
    { subjectId, body }
  );
}

async function addPullRequestReview(pullRequestId, event, body) {
  return githubGraphQL(
    `mutation($pullRequestId:ID!, $event:PullRequestReviewEvent!, $body:String!) {
      addPullRequestReview(input:{pullRequestId:$pullRequestId, event:$event, body:$body}) {
        pullRequestReview {
          id
          state
        }
      }
    }`,
    { pullRequestId, event, body }
  );
}

function isSelfAuthoredPullRequest(pr, viewerLogin) {
  return Boolean(
    viewerLogin &&
    pr.author?.login &&
    pr.author.login.toLowerCase() === viewerLogin
  );
}

function buildSelfReviewFallbackComment(body, viewerLogin) {
  return [
    body,
    '',
    `Observacao operacional: review formal nao foi enviado porque a credencial ativa \`${viewerLogin}\` tambem e autora deste PR.`
  ].join('\n');
}

async function updateProjectItemStatus(projectId, itemId, fieldId, optionId) {
  return githubGraphQL(
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
    { projectId, itemId, fieldId, optionId }
  );
}

function getStatusOptionId(statusField, targetStatus) {
  const option = statusField.options.find(
    (entry) => entry.name.toLowerCase() === targetStatus.toLowerCase()
  );
  if (!option) throw new Error(`Project status option not found: ${targetStatus}`);
  return option.id;
}

function splitRepo(fullName) {
  const [owner, repo] = fullName.split('/');
  return { owner, repo };
}

function writeOutputFile(payload) {
  const outDir = env('QA_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/qa-project-review.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('QA_PROJECT_ORG', 'OWNER');
  const projectNumber = Number(env('QA_PROJECT_NUMBER', '1'));
  const dryRun = env('QA_DRY_RUN', 'true').toLowerCase() !== 'false';
  const securityApprovers = parseCsv(env('QA_SECURITY_APPROVERS')).map((login) => login.toLowerCase());
  const mergeTargets = parseMergeTargets(env('QA_MERGE_TARGETS', 'all'));

  const data = await getProjectSnapshot(org, projectNumber);
  const viewerLogin = (data.viewer?.login || '').trim().toLowerCase();
  const project = data.organization.projectV2;
  const statusField = getStatusField(project);
  if (!statusField) throw new Error('Status field not found in ProjectV2');

  const qaItems = listQaItems(project);
  const decisions = [];

  for (const item of qaItems) {
    const repoFullName = item.content.repository.nameWithOwner;
    const { owner, repo } = splitRepo(repoFullName);
    const issueNumber = item.content.number;
    const context = await getIssueQaContext(owner, repo, issueNumber);
    const issue = context.repository.issue;
    const prs = normalizePrs(issue);
    const decision = buildDecision(issue, prs, securityApprovers);
    const issueRef = `${repoFullName}#${issue.number}`;
    const issueComment = buildIssueComment(issueRef, decision);

    const renderedPrs = prs.map((pr) => ({
      id: pr.id,
      ref: `${pr.repository.nameWithOwner}#${pr.number}`,
      url: pr.url,
      author: pr.author?.login || null,
      state: pr.state,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      headOid: pr.commits?.nodes?.[0]?.commit?.oid || null,
      checkRollupState: getRollupState(pr),
      checks: getChecks(pr)
    }));

    const decisionRecord = {
      issue: {
        id: issue.id,
        ref: issueRef,
        title: issue.title,
        url: issue.url
      },
      projectItemId: item.id,
      currentProjectStatus: getStatusValue(item),
      targetProjectStatus: decision.projectTarget,
      mergeTargets,
      prReviewAction: decision.prReviewAction,
      reasons: decision.reasons,
      prs: renderedPrs,
      dryRun
    };

    if (!dryRun) {
      await addComment(issue.id, issueComment);

      for (const pr of prs) {
        if (decision.prReviewAction) {
          if (isSelfAuthoredPullRequest(pr, viewerLogin)) {
            await addComment(
              pr.id,
              buildSelfReviewFallbackComment(issueComment, viewerLogin)
            );
          } else {
            await addPullRequestReview(
              pr.id,
              decision.prReviewAction,
              issueComment
            );
          }
        }
      }

      const optionId = getStatusOptionId(statusField, decision.projectTarget);
      await updateProjectItemStatus(project.id, item.id, statusField.id, optionId);
      decisionRecord.executed = true;
    } else {
      decisionRecord.executed = false;
      decisionRecord.previewComment = issueComment;
    }

    decisions.push(decisionRecord);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    dryRun,
    project: {
      org,
      number: projectNumber,
      id: project.id,
      title: project.title
    },
    qaItemCount: qaItems.length,
    decisions
  };

  const outPath = writeOutputFile(result);
  console.log(JSON.stringify({ ok: true, outPath, qaItemCount: qaItems.length, dryRun }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
