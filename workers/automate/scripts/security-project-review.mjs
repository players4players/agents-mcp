import fs from 'node:fs';

const GITHUB_API_URL = 'https://api.github.com/graphql';
const SOURCE_STATUS = 'Security';
const DECISION_DEVELOPER = 'Developer';
const DECISION_QA = 'Quality Assurance';
const COPILOT_LOGIN = 'copilot-swe-agent';

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

function uniqBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseDecisionTarget(text = '') {
  if (/project_status:\s*quality assurance/i.test(text) || /quality assurance/i.test(text)) {
    return DECISION_QA;
  }
  if (/project_status:\s*developer/i.test(text) || /developer/i.test(text)) {
    return DECISION_DEVELOPER;
  }
  return null;
}

function extractStructuredDecision(text = '') {
  const normalized = text.replace(/\r/g, '');
  const strictDecision = normalized.match(/SECURITY_DECISION:\s*(APPROVED|REJECTED)/i);
  const strictTarget = normalized.match(/PROJECT_STATUS:\s*(Quality Assurance|Developer)/i);
  if (strictDecision && strictTarget) {
    return {
      decision: strictDecision[1].toUpperCase(),
      targetStatus: strictTarget[1]
    };
  }

  if (!/(security|seguran[cç]a)/i.test(normalized)) return null;

  if (/\baprovad[ao]\b/i.test(normalized)) {
    return {
      decision: 'APPROVED',
      targetStatus: parseDecisionTarget(normalized) || DECISION_QA
    };
  }

  if (/\breprovad[ao]\b/i.test(normalized)) {
    return {
      decision: 'REJECTED',
      targetStatus: parseDecisionTarget(normalized) || DECISION_DEVELOPER
    };
  }

  return null;
}

function isTrustedDecisionAuthor(login, analysts) {
  if (!login) return false;
  if (login === COPILOT_LOGIN) return true;
  if (analysts.size === 0) return true;
  return analysts.has(login);
}

function decisionTimestamp(entry) {
  const value = entry.createdAt || entry.submittedAt || null;
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function githubGraphQL(query, variables = {}, extraHeaders = {}) {
  const token = getToken();
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');

  const response = await fetch(GITHUB_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'OWNER-security-automation',
      ...extraHeaders
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

function listSecurityItems(project) {
  return (project.items?.nodes || []).filter((item) => {
    if (!item?.content?.repository?.nameWithOwner) return false;
    const status = getStatusValue(item);
    return status?.toLowerCase() === SOURCE_STATUS.toLowerCase();
  });
}

async function getIssueSecurityContext(owner, repo, issueNumber) {
  return githubGraphQL(
    `query($owner:String!, $repo:String!, $issueNumber:Int!) {
      repository(owner:$owner, name:$repo) {
        id
        suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 20) {
          nodes {
            __typename
            login
            ... on Bot {
              id
            }
            ... on User {
              id
            }
          }
        }
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
          assignees(first:20) {
            nodes {
              login
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
                        createdAt
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
                        submittedAt
                      }
                    }
                    files(first:100) {
                      nodes {
                        path
                        additions
                        deletions
                      }
                    }
                    commits(last:1) {
                      nodes {
                        commit {
                          oid
                          statusCheckRollup {
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

function splitRepo(fullName) {
  const [owner, repo] = fullName.split('/');
  return { owner, repo };
}

function isCopilotAlreadyAssigned(issue) {
  return (issue.assignees?.nodes || []).some(
    (assignee) => assignee?.login?.toLowerCase() === COPILOT_LOGIN
  );
}

function getCopilotActor(repository) {
  return (repository.suggestedActors?.nodes || []).find(
    (actor) => actor?.login?.toLowerCase() === COPILOT_LOGIN
  );
}

function buildCopilotInstructions(issueRef) {
  return [
    `Analise a issue ${issueRef} com foco em seguranca.`,
    'Revise autorizacao, controle de acesso, exposicao de dados, securityFilter e regras sensiveis de negocio.',
    'Considere risco de IDOR, privilege escalation, mass assignment, injecoes e alteracao indevida de fluxo.',
    'Ao concluir, publique a decisao diretamente na issue ou no PR vinculado usando exatamente estas linhas:',
    'SECURITY_DECISION: APPROVED ou SECURITY_DECISION: REJECTED',
    'PROJECT_STATUS: Quality Assurance ou PROJECT_STATUS: Developer',
    'Depois dessas linhas, acrescente um resumo curto com escopo, riscos avaliados e motivo da decisao final.'
  ].join(' ');
}

async function assignIssueToCopilot(issueId, actorId, repositoryId, baseRef, customInstructions, model) {
  const variables = {
    issueId,
    actorId,
    repositoryId,
    baseRef,
    customInstructions,
    model: model || null
  };

  return githubGraphQL(
    `mutation(
      $issueId:ID!,
      $actorId:ID!,
      $repositoryId:ID!,
      $baseRef:String!,
      $customInstructions:String!,
      $model:String
    ) {
      replaceActorsForAssignable(input: {
        assignableId: $issueId,
        actorIds: [$actorId],
        agentAssignment: {
          targetRepositoryId: $repositoryId,
          baseRef: $baseRef,
          customInstructions: $customInstructions,
          model: $model
        }
      }) {
        assignable {
          ... on Issue {
            id
          }
        }
      }
    }`,
    variables,
    {
      'GraphQL-Features': 'issues_copilot_assignment_api_support,coding_agent_model_selection'
    }
  );
}

function getStatusOptionId(statusField, targetStatus) {
  const option = statusField.options.find(
    (entry) => entry.name.toLowerCase() === targetStatus.toLowerCase()
  );
  if (!option) throw new Error(`Project status option not found: ${targetStatus}`);
  return option.id;
}

function findLatestDecision(issue, prs, analysts) {
  const entries = [];

  for (const comment of issue.comments?.nodes || []) {
    const login = comment.author?.login?.toLowerCase() || '';
    if (!isTrustedDecisionAuthor(login, analysts)) continue;
    const structured = extractStructuredDecision(comment.body);
    if (!structured) continue;
    entries.push({
      source: `issue comment by ${comment.author.login}`,
      createdAt: comment.createdAt,
      ...structured
    });
  }

  for (const pr of prs) {
    for (const comment of pr.comments?.nodes || []) {
      const login = comment.author?.login?.toLowerCase() || '';
      if (!isTrustedDecisionAuthor(login, analysts)) continue;
      const structured = extractStructuredDecision(comment.body);
      if (!structured) continue;
      entries.push({
        source: `comment on ${pr.repository.nameWithOwner}#${pr.number} by ${comment.author.login}`,
        createdAt: comment.createdAt,
        ...structured
      });
    }

    for (const review of pr.reviews?.nodes || []) {
      const login = review.author?.login?.toLowerCase() || '';
      if (!isTrustedDecisionAuthor(login, analysts)) continue;
      const structured = extractStructuredDecision(review.body);
      if (!structured) continue;
      entries.push({
        source: `review on ${pr.repository.nameWithOwner}#${pr.number} by ${review.author.login}`,
        submittedAt: review.submittedAt,
        ...structured
      });
    }
  }

  return entries
    .sort((left, right) => decisionTimestamp(left) - decisionTimestamp(right))
    .at(-1) || null;
}

function buildDecision(issue, prs, analysts) {
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
    reasons.push('Existe PR vinculado fechado ou em draft, sem trilha pública pronta para revisão de segurança.');
    return {
      projectTarget: DECISION_DEVELOPER,
      prReviewAction: 'REQUEST_CHANGES',
      status: 'rejected',
      reasons
    };
  }

  const latestDecision = findLatestDecision(issue, prs, analysts);
  if (!latestDecision) {
    reasons.push('Nenhuma decisão de segurança reconhecível foi encontrada.');
    reasons.push('Aceita comentários estruturados ou texto explícito de aprovação/reprovação de segurança; na ausência deles, o Copilot deve ser acionado.');
    return {
      projectTarget: SOURCE_STATUS,
      prReviewAction: null,
      status: 'awaiting_decision',
      reasons
    };
  }

  if (latestDecision.decision === 'REJECTED') {
    reasons.push(`Decisão de segurança encontrada em ${latestDecision.source}.`);
    reasons.push('A análise de segurança registrou reprovação explícita.');
    return {
      projectTarget: latestDecision.targetStatus || DECISION_DEVELOPER,
      prReviewAction: 'REQUEST_CHANGES',
      status: 'rejected',
      reasons
    };
  }

  reasons.push(`Decisão de segurança encontrada em ${latestDecision.source}.`);
  reasons.push('A análise de segurança registrou aprovação explícita.');
  return {
    projectTarget: latestDecision.targetStatus || DECISION_QA,
    prReviewAction: 'APPROVE',
    status: 'approved',
    reasons
  };
}

function buildIssueComment(issueRef, decision) {
  const header =
    decision.projectTarget === DECISION_QA
      ? 'Security aprovado'
      : decision.projectTarget === DECISION_DEVELOPER
        ? 'Security reprovado'
        : 'Security aguardando decisão estruturada';

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

function writeOutputFile(payload) {
  const outDir = env('SECURITY_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/security-project-review.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('SECURITY_PROJECT_ORG', 'OWNER');
  const projectNumber = Number(env('SECURITY_PROJECT_NUMBER', '1'));
  const dryRun = env('SECURITY_DRY_RUN', 'true').toLowerCase() !== 'false';
  const analysts = new Set(parseCsv(env('SECURITY_ANALYST_LOGINS')).map((login) => login.toLowerCase()));
  analysts.add(COPILOT_LOGIN);
  const useCopilot = env('SECURITY_USE_COPILOT', 'false').toLowerCase() === 'true';
  const copilotBaseRef = env('SECURITY_COPILOT_BASE_REF', 'master');
  const copilotModel = env('SECURITY_COPILOT_MODEL');

  const data = await getProjectSnapshot(org, projectNumber);
  const viewerLogin = (data.viewer?.login || '').trim().toLowerCase();
  const project = data.organization.projectV2;
  const statusField = getStatusField(project);
  if (!statusField) throw new Error('Status field not found in ProjectV2');

  const securityItems = listSecurityItems(project);
  const decisions = [];

  for (const item of securityItems) {
    const repoFullName = item.content.repository.nameWithOwner;
    const { owner, repo } = splitRepo(repoFullName);
    const issueNumber = item.content.number;
    const context = await getIssueSecurityContext(owner, repo, issueNumber);
    const issue = context.repository.issue;
    const prs = normalizePrs(issue);
    const decision = buildDecision(issue, prs, analysts);
    const issueRef = `${repoFullName}#${issue.number}`;
    let copilotTriggered = false;
    let copilotTriggerError = null;
    let activityLogged = false;

    if (useCopilot && decision.projectTarget === SOURCE_STATUS && !dryRun) {
      const copilotActor = getCopilotActor(context.repository);
      if (copilotActor && !isCopilotAlreadyAssigned(issue)) {
        try {
          await assignIssueToCopilot(
            issue.id,
            copilotActor.id,
            context.repository.id,
            copilotBaseRef,
            buildCopilotInstructions(issueRef),
            copilotModel
          );
          copilotTriggered = true;
          decision.reasons.push('Copilot cloud agent foi acionado para aprofundar a investigação antes da decisão final.');
        } catch (error) {
          copilotTriggerError = error.message || String(error);
          decision.reasons.push('Não foi possível acionar o Copilot cloud agent nesta rodada.');
        }
      } else if (isCopilotAlreadyAssigned(issue)) {
        decision.reasons.push('Copilot cloud agent já estava atribuído a esta issue.');
      } else {
        decision.reasons.push('Copilot cloud agent não apareceu em suggestedActors para este repositório.');
      }
    }
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
      checkRollupState: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || 'PENDING',
      files: pr.files?.nodes || []
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
      prReviewAction: decision.prReviewAction,
      copilotTriggered,
      copilotTriggerError,
      reasons: decision.reasons,
      prs: renderedPrs,
      dryRun
    };

    if (!dryRun && decision.projectTarget !== SOURCE_STATUS) {
      await addComment(issue.id, issueComment);

      for (const pr of prs) {
        if (decision.prReviewAction) {
          if (isSelfAuthoredPullRequest(pr, viewerLogin)) {
            await addComment(
              pr.id,
              buildSelfReviewFallbackComment(issueComment, viewerLogin)
            );
          } else {
            await addPullRequestReview(pr.id, decision.prReviewAction, issueComment);
          }
        }
      }

      const optionId = getStatusOptionId(statusField, decision.projectTarget);
      await updateProjectItemStatus(project.id, item.id, statusField.id, optionId);
      decisionRecord.executed = true;
      activityLogged = true;
    } else {
      decisionRecord.executed = false;
      decisionRecord.previewComment = issueComment;
    }

    if (!dryRun && !activityLogged && copilotTriggered) {
      await addComment(issue.id, issueComment);
      decisionRecord.activityLogged = true;
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
    securityItemCount: securityItems.length,
    decisions
  };

  const outPath = writeOutputFile(result);
  console.log(JSON.stringify({ ok: true, outPath, securityItemCount: securityItems.length, dryRun }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
