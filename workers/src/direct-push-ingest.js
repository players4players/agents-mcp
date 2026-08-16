import fs from 'node:fs';
import {
  githubRetryConfig,
  isRetriableGraphQLErrors,
  isRetriableStatus,
  retryAsync,
  retryableError,
} from './retry.js';

const GRAPHQL_API = 'https://api.github.com/graphql';
const REST_API = 'https://api.github.com';
const RETRY = githubRetryConfig('INGEST');

const CONFIG = {
  org: process.env.QA_PROJECT_ORG || process.env.PROJECT_ORG || 'players4players',
  projectNumber: Number(process.env.QA_PROJECT_NUMBER || process.env.PROJECT_NUMBER || 1),
  status: process.env.DEVOPS_UNTRACKED_STATUS || process.env.QA_UNTRACKED_STATUS || 'Work',
  repository: process.env.GITHUB_REPOSITORY,
  refName: process.env.GITHUB_REF_NAME,
  sha: process.env.GITHUB_SHA,
  eventPath: process.env.GITHUB_EVENT_PATH,
  repairRefs: (process.env.PROJECT_REPAIR_REFS || '').split(',').map((item) => item.trim()).filter(Boolean),
  repairStatus: process.env.PROJECT_REPAIR_STATUS || 'Work',
  developerAgentLogin: (process.env.DEVELOPER_AGENT_LOGIN || 'github-copilot[bot]').trim().toLowerCase(),
  developerAgentLogins: (process.env.DEVELOPER_AGENT_LOGINS || 'github-copilot[bot],copilot-swe-agent,copilot')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
  developerBaseRef: process.env.DEVELOPER_COPILOT_BASE_REF || 'master',
  developerModel: process.env.DEVELOPER_COPILOT_MODEL || '',
  autoAssignDeveloper: (process.env.DIRECT_PUSH_ASSIGN_DEVELOPER || 'true').toLowerCase() === 'true',
};

const DEVELOPER_LABEL = 'agent:developer';
const ALL_AGENT_LABELS = ['agent:developer', 'agent:security', 'agent:qa', 'agent:devops'];

function token() {
  const value = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (!value) throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
  return value;
}

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-project-mcp',
    ...extra,
  };
}

async function gql(query, variables = {}) {
  return retryAsync(
    async () => {
      let response;
      try {
        response = await fetch(GRAPHQL_API, {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
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
    { label: 'GitHub GraphQL ingest', ...RETRY }
  );
}

async function rest(path, options = {}) {
  return retryAsync(
    async () => {
      let response;
      try {
        response = await fetch(`${REST_API}${path}`, {
          ...options,
          headers: headers({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
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
    { label: `GitHub REST ingest ${path}`, ...RETRY }
  );
}

async function loadProject() {
  const data = await gql(`
    query($org:String!, $number:Int!) {
      organization(login:$org) {
        projectV2(number:$number) {
          id
          fields(first:50) {
            nodes {
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      }
    }
  `, { org: CONFIG.org, number: CONFIG.projectNumber });
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${CONFIG.org}/projects/${CONFIG.projectNumber}`);
  return project;
}

async function loadProjectItems() {
  const data = await gql(`
    query($org:String!, $number:Int!) {
      organization(login:$org) {
        projectV2(number:$number) {
          id
          fields(first:50) {
            nodes {
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
          items(first:100) {
            nodes {
              id
              content {
                ... on Issue {
                  __typename
                  id
                  number
                  title
                  url
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
                  repository { nameWithOwner }
                }
                ... on PullRequest {
                  __typename
                  id
                  number
                  title
                  url
                  repository { nameWithOwner }
                }
              }
              fieldValues(first:30) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2SingleSelectField { name } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { org: CONFIG.org, number: CONFIG.projectNumber });
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${CONFIG.org}/projects/${CONFIG.projectNumber}`);
  return project;
}

function statusField(project) {
  const field = project.fields.nodes.find((f) => f?.name === 'Status' && f?.options);
  if (!field) throw new Error('Status field not found');
  return field;
}

function statusOf(item) {
  return item.fieldValues?.nodes?.find((value) => value?.field?.name === 'Status')?.name || null;
}

function itemRef(item) {
  const content = item.content;
  if (!content?.repository?.nameWithOwner || !content?.number) return null;
  return `${content.repository.nameWithOwner}#${content.number}`;
}

function assigneeLogins(content) {
  return (content?.assignees?.nodes || [])
    .map((assignee) => (assignee?.login || '').trim().toLowerCase())
    .filter(Boolean);
}

function issueLabels(content) {
  return (content?.labels?.nodes || []).map((label) => label?.name).filter(Boolean);
}

function currentAgentLabel(content) {
  return issueLabels(content).find((label) => ALL_AGENT_LABELS.includes(label)) || null;
}

function hasDeveloperAgentAssignee(content) {
  const known = new Set(CONFIG.developerAgentLogins);
  return assigneeLogins(content).some((login) => known.has(login));
}

function hasHumanAssignee(content) {
  const known = new Set(CONFIG.developerAgentLogins);
  return assigneeLogins(content).some((login) => !known.has(login));
}

async function addIssueToProject(project, issueNodeId) {
  const data = await gql(`
    mutation($projectId:ID!, $contentId:ID!) {
      addProjectV2ItemById(input:{ projectId:$projectId, contentId:$contentId }) {
        item { id }
      }
    }
  `, { projectId: project.id, contentId: issueNodeId });
  return data.addProjectV2ItemById.item.id;
}

async function moveProjectItem(project, itemId, targetStatus) {
  const field = statusField(project);
  const option = field.options.find((o) => o.name.toLowerCase() === targetStatus.toLowerCase());
  if (!option) throw new Error(`Status option not found: ${targetStatus}`);
  await gql(`
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
      updateProjectV2ItemFieldValue(input:{
        projectId:$projectId,
        itemId:$itemId,
        fieldId:$fieldId,
        value:{ singleSelectOptionId:$optionId }
      }) { projectV2Item { id } }
    }
  `, { projectId: project.id, itemId, fieldId: field.id, optionId: option.id });
}

async function ensureLabelExists(repoFullName, labelName) {
  const [owner, repo] = repoFullName.split('/');
  try {
    await rest(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({
        name: labelName,
        color: '1f6feb',
        description: 'Task atualmente com o agent Developer',
      }),
    });
  } catch (error) {
    const payload = JSON.parse(error.message || '{}');
    if (payload.status !== 422) throw error;
  }
}

async function replaceIssueLabels(repoFullName, issueNumber, labels) {
  const [owner, repo] = repoFullName.split('/');
  await rest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'PUT',
    body: JSON.stringify(labels),
  });
}

async function getRepositoryAssignableActor(repositoryFullName) {
  const [owner, name] = repositoryFullName.split('/');
  const data = await gql(`
    query($owner:String!, $name:String!) {
      repository(owner:$owner, name:$name) {
        id
        nameWithOwner
        suggestedActors(capabilities:[CAN_BE_ASSIGNED], first:20) {
          nodes {
            __typename
            login
            ... on Bot { id }
            ... on User { id }
          }
        }
      }
    }
  `, { owner, name });

  const repository = data?.repository;
  if (!repository) return null;
  const actor = (repository.suggestedActors?.nodes || []).find(
    (candidate) => candidate?.login?.toLowerCase() === CONFIG.developerAgentLogin
  );
  return actor?.id ? { repositoryId: repository.id, actorId: actor.id } : null;
}

async function assignIssueToDeveloper(issueId, repositoryId, actorId, issueRef, issueNumber) {
  const customInstructions = [
    `Atue como o agent Developer da players4players para a issue ${issueRef}.`,
    'Antes de agir, leia e siga `.github/agents/developer.agent.md` no repositório alvo.',
    'Leia também o `AGENTS.md` mais específico do código afetado.',
    `Trabalhe a partir do branch \`task-${issueNumber}\` derivado de \`master\`, reutilizando-o quando ele já existir.`,
    'Use GitHub como fonte de verdade para issue, PR, comentários, branch e evidências.',
    'Ao concluir a implementação com evidência suficiente, repasse a issue para o agent Security.',
  ].join(' ');

  await gql(`
    mutation(
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
    }
  `, {
    issueId,
    actorId,
    repositoryId,
    baseRef: CONFIG.developerBaseRef,
    customInstructions,
    model: CONFIG.developerModel || null,
  });
}

async function repairConfiguredProjectItems() {
  if (CONFIG.repairRefs.length === 0) return [];
  const wanted = new Set(CONFIG.repairRefs.map((ref) => ref.toLowerCase()));
  const project = await loadProjectItems();
  const repairs = [];

  for (const item of project.items.nodes || []) {
    const ref = itemRef(item);
    if (!ref || !wanted.has(ref.toLowerCase())) continue;
    const currentStatus = statusOf(item);
    if (currentStatus?.toLowerCase() === CONFIG.repairStatus.toLowerCase()) {
      repairs.push({ ref, status: currentStatus, changed: false });
      continue;
    }
    await moveProjectItem(project, item.id, CONFIG.repairStatus);
    repairs.push({ ref, from: currentStatus, to: CONFIG.repairStatus, changed: true });
  }

  return repairs;
}

async function hasActiveDeveloperExecution() {
  const project = await loadProjectItems();
  return (project.items.nodes || []).some((item) => {
    if (statusOf(item)?.toLowerCase() !== CONFIG.status.toLowerCase()) return false;
    const content = item.content;
    if (!content || content.__typename !== 'Issue') return false;
    if (currentAgentLabel(content) !== DEVELOPER_LABEL) return false;
    if (!hasDeveloperAgentAssignee(content)) return false;
    return true;
  });
}

function readEvent() {
  if (!CONFIG.eventPath) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG.eventPath, 'utf8'));
  } catch {
    return null;
  }
}

function hasTaskReference(event) {
  if (/^task-\d+$/i.test(CONFIG.refName || '')) return true;
  const text = JSON.stringify(event || {});
  return /(?:#\d+|task-\d+|close[sd]?\s+#\d+|fix(?:e[sd])?\s+#\d+|ref(?:s|erences)?\s+#\d+)/i.test(text);
}

async function createTrackingIssue(event) {
  const commits = event?.commits || [];
  const body = [
    'Automação DevOps detectou alteração sem tarefa vinculada.',
    '',
    `Repositório: ${CONFIG.repository}`,
    `Branch original: ${CONFIG.refName}`,
    `SHA: ${CONFIG.sha}`,
    '',
    'Resumo dos commits:',
    ...commits.slice(0, 20).map((commit) => `- ${commit.id?.slice(0, 12) || ''} ${commit.message?.split('\n')[0] || ''}`),
    '',
    'Fluxo obrigatório:',
    '1. Continuar a partir do branch criado pela automação: `task-{id}`.',
    '2. Abrir PR vinculado a esta tarefa.',
    '3. Seguir o fluxo normal pelo ProjectV2, começando em `Work` e aguardando captura pelo runner de `Developer`.',
  ].join('\n');

  return rest(`/repos/${CONFIG.repository}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: `DevOps: mudança sem tarefa em ${CONFIG.refName}`,
      body,
      labels: ['devops', 'untracked-change'],
    }),
  });
}

async function createTaskBranch(issueNumber) {
  const branch = `task-${issueNumber}`;
  try {
    await rest(`/repos/${CONFIG.repository}/git/ref/heads/${encodeURIComponent(branch)}`);
    return { branch, created: false };
  } catch {
    await rest(`/repos/${CONFIG.repository}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: CONFIG.sha }),
    });
    return { branch, created: true };
  }
}

async function main() {
  if (!CONFIG.repository || !CONFIG.refName || !CONFIG.sha) {
    throw new Error('GITHUB_REPOSITORY, GITHUB_REF_NAME and GITHUB_SHA are required');
  }

  const event = readEvent();
  const repairs = await repairConfiguredProjectItems();
  if (hasTaskReference(event)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'Task reference already present.', repairs }, null, 2));
    return;
  }

  const project = await loadProject();
  const issue = await createTrackingIssue(event);
  const itemId = await addIssueToProject(project, issue.node_id);
  await moveProjectItem(project, itemId, CONFIG.status);
  const branch = await createTaskBranch(issue.number);
  let developerAssigned = false;
  let developerAssignmentReason = null;
  await ensureLabelExists(CONFIG.repository, DEVELOPER_LABEL);
  await replaceIssueLabels(CONFIG.repository, issue.number, ['devops', 'untracked-change', DEVELOPER_LABEL]);

  await rest(`/repos/${CONFIG.repository}/issues/${issue.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body: `Branch de continuidade criado: \`${branch.branch}\`. Todo desenvolvimento subsequente deve sair desse branch e seguir por PR vinculado a esta tarefa.`,
    }),
  });

  if (CONFIG.autoAssignDeveloper) {
    if (await hasActiveDeveloperExecution()) {
      developerAssignmentReason = 'Já existe task do Developer em execução em Work.';
    } else {
      const assignable = await getRepositoryAssignableActor(CONFIG.repository);
      if (!assignable) {
        developerAssignmentReason = `O agent ${CONFIG.developerAgentLogin} não apareceu em suggestedActors para ${CONFIG.repository}.`;
      } else {
        await assignIssueToDeveloper(
          issue.node_id,
          assignable.repositoryId,
          assignable.actorId,
          `${CONFIG.repository}#${issue.number}`,
          issue.number
        );
        developerAssigned = true;
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    issue: issue.html_url,
    branch: branch.branch,
    branchCreated: branch.created,
    project: `${CONFIG.org}/projects/${CONFIG.projectNumber}`,
    status: CONFIG.status,
    developerAssigned,
    developerAssignmentReason,
    repairs,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
