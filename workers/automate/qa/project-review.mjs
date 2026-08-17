import { getAuthToken, githubApiVersion } from '../common/github-app-auth.js';

const GRAPHQL_API = 'https://api.github.com/graphql';
const REST_API = 'https://api.github.com';

const CONFIG = {
  org: process.env.QA_PROJECT_ORG || '<env.<env.OWNER>>',
  projectNumber: Number(process.env.QA_PROJECT_NUMBER || 1),
  sourceStatus: process.env.QA_TARGET_STATUS || 'Quality Assurance',
  limit: Number(process.env.QA_TASK_LIMIT || 5),
  developerStatus: process.env.QA_DEVELOPER_STATUS || 'Developer',
  securityStatus: process.env.QA_SECURITY_STATUS || 'Security',
  devopsStatus: process.env.QA_DEVOPS_STATUS || 'DevOps',
  approvedStatus: process.env.QA_APPROVED_STATUS || 'Staging',
  merge: (process.env.QA_AUTO_MERGE || 'true').toLowerCase() === 'true',
};

async function headers(extra = {}) {
  return {
    Authorization: `Bearer ${await getAuthToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': githubApiVersion(),
    'User-Agent': 'github-project-mcp',
    ...extra,
  };
}

async function gql(query, variables = {}) {
  const response = await fetch(GRAPHQL_API, {
    method: 'POST',
    headers: await headers({ 'Content-Type': 'application/json' }),
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
    headers: await headers({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(JSON.stringify({ status: response.status, path, body }, null, 2));
  }
  return body;
}

function repoOf(content) {
  return `${content.repository.owner.login}/${content.repository.name}`;
}

function statusOf(item) {
  return item.fieldValues.nodes.find((v) => v?.field?.name === 'Status')?.name || null;
}

async function loadProject() {
  const data = await gql(`
    query($org:String!, $number:Int!) {
      organization(login:$org) {
        projectV2(number:$number) {
          id
          title
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
                ... on Issue { __typename id number title url repository { name owner { login } } }
                ... on PullRequest { __typename id number title url repository { name owner { login } } }
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

async function moveItem(project, item, targetStatus) {
  const field = statusField(project);
  const option = field.options.find((o) => o.name.toLowerCase() === targetStatus.toLowerCase());
  if (!option) throw new Error(`Status option not found: ${targetStatus}`);
  await gql(`
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
      updateProjectV2ItemFieldValue(input:{
        projectId:$projectId,
        itemId:$itemId,
        fieldId:$fieldId,
        value:{singleSelectOptionId:$optionId}
      }) { projectV2Item { id } }
    }
  `, { projectId: project.id, itemId: item.id, fieldId: field.id, optionId: option.id });
  return option.name;
}

async function findPullRequestsForIssue(issue) {
  if (issue.__typename === 'PullRequest') return [{ repo: repoOf(issue), number: issue.number }];
  const repo = repoOf(issue);
  const query = encodeURIComponent(`repo:${repo} is:pr is:open ${issue.number}`);
  const result = await rest(`/search/issues?q=${query}&per_page=10`);
  return (result.items || [])
    .filter((pr) => (`${pr.title}\n${pr.body || ''}`).includes(`#${issue.number}`) || (`${pr.title}\n${pr.body || ''}`).includes(issue.url))
    .map((pr) => ({ repo, number: pr.number }));
}

async function pullRequest(repo, number) {
  return rest(`/repos/${repo}/pulls/${number}`);
}

async function pullFiles(repo, number) {
  return rest(`/repos/${repo}/pulls/${number}/files?per_page=100`);
}

async function commitStatus(repo, sha) {
  const status = await rest(`/repos/${repo}/commits/${sha}/status`);
  const checks = await rest(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  const failedChecks = (checks.check_runs || []).filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion));
  return {
    state: status.state,
    totalChecks: checks.total_count || 0,
    failedChecks,
    ok: status.state === 'success' && failedChecks.length === 0,
  };
}

function needsSecurity(files) {
  const patterns = [/auth/i, /permission/i, /role/i, /token/i, /secret/i, /password/i, /payment/i, /security/i, /middleware/i];
  return files.some((file) => patterns.some((pattern) => pattern.test(file.filename)));
}

async function review(repo, number, event, body, sha) {
  return rest(`/repos/${repo}/pulls/${number}/reviews`, {
    method: 'POST',
    body: JSON.stringify({ event, body, commit_id: sha }),
  });
}

async function commentIssue(repo, number, body) {
  return rest(`/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function mergePr(repo, pr) {
  if (!CONFIG.merge) return { skipped: true, reason: 'QA_AUTO_MERGE=false' };
  return rest(`/repos/${repo}/pulls/${pr.number}/merge`, {
    method: 'PUT',
    body: JSON.stringify({
      merge_method: 'merge',
      sha: pr.head.sha,
      commit_title: `Merge PR #${pr.number}: ${pr.title}`,
      commit_message: 'Merged by QA automation.',
    }),
  });
}

function decisionFor(pr, files, status) {
  if (pr.draft) return { status: CONFIG.developerStatus, event: 'REQUEST_CHANGES', reason: 'PR is still draft.' };
  if (pr.mergeable === false) return { status: CONFIG.devopsStatus, event: 'REQUEST_CHANGES', reason: 'PR has merge conflicts.' };
  if (!status.ok) return { status: CONFIG.developerStatus, event: 'REQUEST_CHANGES', reason: 'Required status checks are not green.' };
  if (needsSecurity(files)) return { status: CONFIG.securityStatus, event: 'COMMENT', reason: 'Changes touch security-sensitive paths.' };
  return { status: CONFIG.approvedStatus, event: 'APPROVE', reason: 'PR is mergeable and checks are green.' };
}

async function processItem(project, item) {
  const content = item.content;
  const prs = await findPullRequestsForIssue(content);
  if (prs.length === 0) {
    const movedTo = await moveItem(project, item, CONFIG.developerStatus);
    return { item: content.url, decision: movedTo, reason: 'No linked open PR found.' };
  }

  const results = [];
  for (const ref of prs) {
    const pr = await pullRequest(ref.repo, ref.number);
    const files = await pullFiles(ref.repo, ref.number);
    const status = await commitStatus(ref.repo, pr.head.sha);
    const decision = decisionFor(pr, files, status);
    const body = [
      `QA automático: ${decision.reason}`,
      `Destino: ${decision.status}`,
      `Checks: ${status.state}`,
      `Arquivos alterados: ${files.length}`,
    ].join('\n');

    if (decision.event === 'APPROVE') await review(ref.repo, ref.number, 'APPROVE', body, pr.head.sha);
    if (decision.event === 'REQUEST_CHANGES') await review(ref.repo, ref.number, 'REQUEST_CHANGES', body, pr.head.sha);
    if (decision.event === 'COMMENT') await commentIssue(ref.repo, ref.number, body);

    const movedTo = await moveItem(project, item, decision.status);
    let merge = null;
    if (decision.event === 'APPROVE') merge = await mergePr(ref.repo, pr);
    results.push({ pr: `${ref.repo}#${ref.number}`, decision: movedTo, reason: decision.reason, merge });
  }
  return { item: content.url, results };
}

async function runBatch() {
  const project = await loadProject();
  statusField(project);
  const items = project.items.nodes
    .filter((item) => item?.content)
    .filter((item) => statusOf(item) === CONFIG.sourceStatus)
    .slice(0, CONFIG.limit);

  const results = [];
  for (const item of items) {
    try {
      results.push(await processItem(project, item));
    } catch (error) {
      results.push({ item: item.content?.url || item.id, error: error.message || String(error) });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    mode: 'qa-autonomous-batch',
    apiVersion: githubApiVersion(),
    project: `${CONFIG.org}/projects/${CONFIG.projectNumber}`,
    sourceStatus: CONFIG.sourceStatus,
    limit: CONFIG.limit,
    processed: results.length,
    results,
  }, null, 2));
}

runBatch().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
