import fs from 'node:fs';

const GITHUB_API_URL = 'https://api.github.com/graphql';
const DEFAULT_AGENT_LOGIN = 'github-copilot[bot]';
const DEFAULT_AGENT_LOGINS = 'github-copilot[bot],copilot-swe-agent,copilot';

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

async function githubGraphQL(query, variables = {}, extraHeaders = {}) {
  const token = getToken();
  if (!token) throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');

  const response = await fetch(GITHUB_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': '<env.OWNER>-developer-automation',
      ...extraHeaders,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();
  if (!response.ok || json.errors) {
    throw new Error(JSON.stringify({ status: response.status, errors: json.errors || json }, null, 2));
  }

  return json.data;
}

async function getProjectSnapshot(org, projectNumber) {
  return githubGraphQL(
    `query($org:String!, $projectNumber:Int!) {
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
          items(first:100) {
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
                  assignees(first:20) {
                    nodes {
                      login
                    }
                  }
                  repository {
                    id
                    nameWithOwner
                    suggestedActors(capabilities:[CAN_BE_ASSIGNED], first:20) {
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
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { org, projectNumber }
  );
}

function getStatusValue(item) {
  const value = item.fieldValues?.nodes?.find(
    (node) => node?.field?.name?.toLowerCase() === 'status'
  );
  return value?.name || null;
}

function listWorkItems(project, workStatus) {
  return (project.items?.nodes || []).filter((item) => {
    if (!item?.content?.repository?.nameWithOwner) return false;
    if (item.content.state !== 'OPEN') return false;
    const status = getStatusValue(item);
    return status?.toLowerCase() === workStatus.toLowerCase();
  });
}

function assigneeLogins(issue) {
  return (issue.assignees?.nodes || [])
    .map((assignee) => (assignee?.login || '').trim().toLowerCase())
    .filter(Boolean);
}

function hasAgentAssignee(issue, agentLogins) {
  return assigneeLogins(issue).some((login) => agentLogins.has(login));
}

function hasHumanAssignee(issue, agentLogins) {
  return assigneeLogins(issue).some((login) => !agentLogins.has(login));
}

function hasHumanOnlyAssignee(issue, agentLogins) {
  return hasHumanAssignee(issue, agentLogins) && !hasAgentAssignee(issue, agentLogins);
}

function getAssignableActor(issue, preferredAgentLogin) {
  return (issue.repository?.suggestedActors?.nodes || []).find(
    (actor) => actor?.login?.toLowerCase() === preferredAgentLogin
  );
}

function sortByCreatedAt(items) {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.content?.createdAt || '') || 0;
    const rightTs = Date.parse(right.content?.createdAt || '') || 0;
    return leftTs - rightTs;
  });
}

function buildDeveloperInstructions(issueRef, issueNumber) {
  return [
    `Atue como o agent Developer do ecossistema para a issue ${issueRef}.`,
    'Antes de agir, leia e siga `.github/agents/developer.agent.md` no repositório alvo.',
    'Leia também o `AGENTS.md` mais específico do código afetado.',
    `Trabalhe a partir do branch \`task-${issueNumber}\` derivado de \`master\`, reutilizando-o quando ele já existir.`,
    'Use GitHub como fonte de verdade para issue, PR, comentários, branch e evidências.',
    'Ao iniciar a execução, mova a task para `Working`.',
    'Ao concluir a implementação com evidência suficiente, devolva a task para `Ready` e repasse a responsabilidade para o agent Security.',
  ].join(' ');
}

function buildAssignmentComment(issueRef) {
  return [
    '### Developer iniciado',
    '',
    `Issue: ${issueRef}`,
    'Origem: coluna `Ready` do ProjectV2',
    'Critério: task parada, sem ownership exclusivamente humano e sem outra execução ativa do Developer em `Ready`.',
    'Ação inicial: quando assumir a task, mova a coluna para `Working`.',
    'Ação: o runner atribuiu o agent `Developer` para iniciar a execução.',
  ].join('\n');
}

async function assignIssueToAgent(issueId, actorId, repositoryId, baseRef, customInstructions, model) {
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
    { issueId, actorId, repositoryId, baseRef, customInstructions, model: model || null },
    {
      'GraphQL-Features': 'issues_copilot_assignment_api_support,coding_agent_model_selection',
    }
  );
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

function serializeItem(item, agentLogins, preferredAgentLogin) {
  const issue = item.content;
  const assignees = assigneeLogins(issue);
  const actor = getAssignableActor(issue, preferredAgentLogin);
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
    assignees,
    hasAgentAssignee: hasAgentAssignee(issue, agentLogins),
    hasHumanAssignee: hasHumanAssignee(issue, agentLogins),
    hasHumanOnlyAssignee: hasHumanOnlyAssignee(issue, agentLogins),
    canAssignPreferredAgent: Boolean(actor?.id),
  };
}

function writeOutputFile(payload) {
  const outDir = env('DEVELOPER_OUTPUT_DIR', '/tmp');
  const outPath = `${outDir}/developer-project-dispatch.json`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function main() {
  const org = env('DEVELOPER_PROJECT_ORG', '<env.OWNER>');
  const projectNumber = Number(env('DEVELOPER_PROJECT_NUMBER', '1'));
  const dryRun = env('DEVELOPER_DRY_RUN', 'true').toLowerCase() !== 'false';
  const workStatus = env('DEVELOPER_WORK_STATUS', 'Ready');
  const preferredAgentLogin = env('DEVELOPER_AGENT_LOGIN', DEFAULT_AGENT_LOGIN).toLowerCase();
  const agentLogins = new Set(
    parseCsv(env('DEVELOPER_AGENT_LOGINS', DEFAULT_AGENT_LOGINS)).map((login) => login.toLowerCase())
  );
  const baseRef = env('DEVELOPER_COPILOT_BASE_REF', 'master');
  const model = env('DEVELOPER_COPILOT_MODEL');

  const data = await getProjectSnapshot(org, projectNumber);
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${org}/projects/${projectNumber}`);

  const workItems = sortByCreatedAt(listWorkItems(project, workStatus));
  const activeItems = workItems.filter((item) => {
    if (!hasAgentAssignee(item.content, agentLogins)) return false;
    return !hasHumanAssignee(item.content, agentLogins);
  });
  const humanOwnedItems = workItems.filter((item) => hasHumanOnlyAssignee(item.content, agentLogins));
  const candidateItems = workItems.filter((item) => {
    if (hasAgentAssignee(item.content, agentLogins)) return false;
    if (hasHumanOnlyAssignee(item.content, agentLogins)) return false;
    return true;
  });

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
    activeCount: activeItems.length,
    humanOwnedCount: humanOwnedItems.length,
    candidateCount: candidateItems.length,
    activeItems: activeItems.map((item) => serializeItem(item, agentLogins, preferredAgentLogin)),
    humanOwnedItems: humanOwnedItems.map((item) => serializeItem(item, agentLogins, preferredAgentLogin)),
    candidateItems: candidateItems.map((item) => serializeItem(item, agentLogins, preferredAgentLogin)),
  };

  if (activeItems.length > 0) {
    result.ok = true;
    result.skipped = true;
    result.reason = 'Já existe task em execução pelo Developer na coluna Ready.';
    const outPath = writeOutputFile(result);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason, outPath }, null, 2));
    return;
  }

  if (candidateItems.length === 0) {
    result.ok = true;
    result.skipped = true;
    result.reason = 'Nenhuma task elegível foi encontrada em Ready.';
    const outPath = writeOutputFile(result);
    console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason, outPath }, null, 2));
    return;
  }
  result.assignmentAttempts = [];

  for (const target of candidateItems) {
    const issue = target.content;
    const issueRef = `${issue.repository.nameWithOwner}#${issue.number}`;
    const actor = getAssignableActor(issue, preferredAgentLogin);
    const targetRecord = serializeItem(target, agentLogins, preferredAgentLogin);

    if (!actor?.id) {
      result.assignmentAttempts.push({
        issue: targetRecord.issue,
        status: 'skipped',
        reason: `O agent ${preferredAgentLogin} não apareceu em suggestedActors para ${issue.repository.nameWithOwner}.`,
      });
      continue;
    }

    result.selectedItem = targetRecord;

    if (!dryRun) {
      await assignIssueToAgent(
        issue.id,
        actor.id,
        issue.repository.id,
        baseRef,
        buildDeveloperInstructions(issueRef, issue.number),
        model
      );
      await addIssueComment(issue.id, buildAssignmentComment(issueRef));
      result.executed = true;
    } else {
      result.executed = false;
      result.previewComment = buildAssignmentComment(issueRef);
      result.previewInstructions = buildDeveloperInstructions(issueRef, issue.number);
    }

    result.ok = true;
    result.assignedIssue = issueRef;
    result.assignedAgent = preferredAgentLogin;
    result.baseRef = baseRef;
    result.assignmentAttempts.push({
      issue: targetRecord.issue,
      status: dryRun ? 'preview' : 'assigned',
      reason: 'Primeira task elegível e atribuível encontrada.',
    });

    const outPath = writeOutputFile(result);
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun,
          assignedIssue: issueRef,
          assignedAgent: preferredAgentLogin,
          outPath,
        },
        null,
        2
      )
    );
    return;
  }

  result.ok = false;
  result.skipped = true;
  result.reason = 'Nenhuma task elegível em Ready pôde ser atribuída ao agent configurado.';
  const outPath = writeOutputFile(result);
  console.log(JSON.stringify({ ok: false, skipped: true, reason: result.reason, outPath }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
