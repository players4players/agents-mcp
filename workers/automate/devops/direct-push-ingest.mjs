import fs from 'node:fs';

const GRAPHQL_API = 'https://api.github.com/graphql';
const REST_API = 'https://api.github.com';
const TRACKING_LABELS = ['devops', 'untracked-change'];

const CONFIG = {
  org: process.env.DEVOPS_PROJECT_ORG || process.env.QA_PROJECT_ORG || '<env.<env.OWNER>>',
  projectNumber: Number(process.env.DEVOPS_PROJECT_NUMBER || process.env.QA_PROJECT_NUMBER || 1),
  status:
    process.env.DEVOPS_UNTRACKED_STATUS ||
    process.env.DEVOPS_TARGET_STATUS ||
    process.env.QA_UNTRACKED_STATUS ||
    process.env.QA_TARGET_STATUS ||
    'Work',
  repository: process.env.GITHUB_REPOSITORY,
  refName: process.env.GITHUB_REF_NAME,
  sha: process.env.GITHUB_SHA,
  eventPath: process.env.GITHUB_EVENT_PATH,
};

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
  const response = await fetch(GRAPHQL_API, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (!response.ok || json.errors) {
    throw new Error(JSON.stringify({ status: response.status, errors: json.errors || json }, null, 2));
  }
  return json.data;
}

async function rest(path, options = {}) {
  const response = await fetch(`${REST_API}${path}`, {
    ...options,
    headers: headers({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(JSON.stringify({ status: response.status, path, body }, null, 2));
  }
  return body;
}

async function loadProject() {
  const data = await gql(
    `
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
  `,
    { org: CONFIG.org, number: CONFIG.projectNumber }
  );
  const project = data?.organization?.projectV2;
  if (!project) throw new Error(`Project not found: ${CONFIG.org}/projects/${CONFIG.projectNumber}`);
  return project;
}

function statusField(project) {
  const field = project.fields.nodes.find((f) => f?.name === 'Status' && f?.options);
  if (!field) throw new Error('Status field not found');
  return field;
}

async function addIssueToProject(project, issueNodeId) {
  const data = await gql(
    `
    mutation($projectId:ID!, $contentId:ID!) {
      addProjectV2ItemById(input:{ projectId:$projectId, contentId:$contentId }) {
        item { id }
      }
    }
  `,
    { projectId: project.id, contentId: issueNodeId }
  );
  return data.addProjectV2ItemById.item.id;
}

async function moveProjectItem(project, itemId, targetStatus) {
  const field = statusField(project);
  const option = field.options.find((o) => o.name.toLowerCase() === targetStatus.toLowerCase());
  if (!option) throw new Error(`Status option not found: ${targetStatus}`);
  await gql(
    `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
      updateProjectV2ItemFieldValue(input:{
        projectId:$projectId,
        itemId:$itemId,
        fieldId:$fieldId,
        value:{ singleSelectOptionId:$optionId }
      }) { projectV2Item { id } }
    }
  `,
    { projectId: project.id, itemId, fieldId: field.id, optionId: option.id }
  );
}

function readEvent() {
  if (!CONFIG.eventPath) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG.eventPath, 'utf8'));
  } catch {
    return null;
  }
}

function trackingTitle() {
  return `DevOps: mudança sem tarefa em ${CONFIG.refName}`;
}

function summarizeCommits(event) {
  return (event?.commits || []).slice(0, 20).map((commit) => {
    const sha = commit.id?.slice(0, 12) || '';
    const message = commit.message?.split('\n')[0] || '';
    return `- ${sha} ${message}`.trimEnd();
  });
}

function hasTaskReference(event) {
  if (/^task-\d+$/i.test(CONFIG.refName || '')) return true;
  const text = JSON.stringify(event || {});
  return /(?:#\d+|task-\d+|close[sd]?\s+#\d+|fix(?:e[sd])?\s+#\d+|ref(?:s|erences)?\s+#\d+)/i.test(text);
}

function trackingIssueBody(event) {
  const commits = summarizeCommits(event);
  return [
    'Automação de DevOps detectou alteração em branch sem tarefa vinculada.',
    '',
    `Repositório: ${CONFIG.repository}`,
    `Branch original: ${CONFIG.refName}`,
    `SHA: ${CONFIG.sha}`,
    '',
    'Resumo dos commits:',
    ...(commits.length ? commits : ['- sem commits detalhados no payload do evento']),
    '',
    'Fluxo obrigatório:',
    '1. Continuar a partir do branch criado pela automação: `task-{id}`.',
    '2. Abrir PR vinculado a esta tarefa.',
    '3. Corrigir a trilha de desenvolvimento antes de retornar ao fluxo normal.',
  ].join('\n');
}

function trackingUpdateComment(event) {
  const commits = summarizeCommits(event);
  return [
    'Nova alteração detectada nesta mesma trilha sem tarefa vinculada.',
    '',
    `SHA mais recente: ${CONFIG.sha}`,
    '',
    'Resumo dos commits desta rodada:',
    ...(commits.length ? commits : ['- sem commits detalhados no payload do evento']),
    '',
    'A issue existente foi reaproveitada para evitar duplicação da fila operacional.',
  ].join('\n');
}

async function findExistingTrackingIssue() {
  const params = new URLSearchParams({
    state: 'open',
    labels: TRACKING_LABELS.join(','),
    per_page: '100',
  });
  const issues = await rest(`/repos/${CONFIG.repository}/issues?${params.toString()}`);
  return issues.find((issue) => !issue.pull_request && issue.title === trackingTitle()) || null;
}

async function createTrackingIssue(event) {
  return rest(`/repos/${CONFIG.repository}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: trackingTitle(),
      body: trackingIssueBody(event),
      labels: TRACKING_LABELS,
    }),
  });
}

async function commentOnTrackingIssue(issueNumber, body) {
  await rest(`/repos/${CONFIG.repository}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
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

async function ensureTrackingIssue(project, event) {
  const existing = await findExistingTrackingIssue();
  if (existing) {
    await commentOnTrackingIssue(existing.number, trackingUpdateComment(event));
    return { issue: existing, reused: true };
  }

  const issue = await createTrackingIssue(event);
  const itemId = await addIssueToProject(project, issue.node_id);
  await moveProjectItem(project, itemId, CONFIG.status);
  return { issue, reused: false };
}

async function main() {
  if (!CONFIG.repository || !CONFIG.refName || !CONFIG.sha) {
    throw new Error('GITHUB_REPOSITORY, GITHUB_REF_NAME and GITHUB_SHA are required');
  }

  const event = readEvent();
  if (hasTaskReference(event)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'Task reference already present.' }, null, 2));
    return;
  }

  const project = await loadProject();
  const { issue, reused } = await ensureTrackingIssue(project, event);
  const branch = await createTaskBranch(issue.number);

  if (branch.created || !reused) {
    await commentOnTrackingIssue(
      issue.number,
      `Branch de continuidade criado: \`${branch.branch}\`. Todo desenvolvimento subsequente deve sair desse branch e seguir por PR vinculado a esta tarefa.`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        issue: issue.html_url,
        reused,
        branch: branch.branch,
        branchCreated: branch.created,
        project: `${CONFIG.org}/projects/${CONFIG.projectNumber}`,
        status: CONFIG.status,
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