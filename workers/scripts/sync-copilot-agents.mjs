import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const platformRoot = path.resolve(__dirname, "../..");
const workspaceRoot = path.dirname(platformRoot);

const CONTROL_OWNER = "<env.<env.OWNER>>";
const CENTRAL_REPO = "agents-mcp";
const CENTRAL_BASE_URL = `https://github.com/${CONTROL_OWNER}/${CENTRAL_REPO}/blob/master`;
const centralWorkspaceName = path.basename(platformRoot);
const types = ["developer", "qa", "security", "devops", "tutorial-assistant", "technical-documenter"];

const typeMeta = {
  developer: {
    displayName: "Developer",
    descriptionPrefix: "Executor autonomo de issues",
  },
  qa: {
    displayName: "Quality Assurance",
    descriptionPrefix: "Revisor tecnico de entregas",
  },
  security: {
    displayName: "Security",
    descriptionPrefix: "Revisor de seguranca",
  },
  devops: {
    displayName: "DevOps",
    descriptionPrefix: "Operador de fluxo e automacoes",
  },
  "tutorial-assistant": {
    displayName: "Tutorial Assistant",
    descriptionPrefix: "Agente de tutorial para cliente final",
  },
  "technical-documenter": {
    displayName: "Technical Documenter",
    descriptionPrefix: "Agente de wiki tecnica e de negocio",
  },
};

const roots = [
  { key: CENTRAL_REPO, relPath: centralWorkspaceName, family: "automation" },
  { key: "api-community", relPath: "api-community", family: "backend" },
  { key: "api-whatsapp", relPath: "api-whatsapp", family: "integration" },
  { key: "app-community", relPath: "app-community", family: "frontend" },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${content.trim()}\n`, "utf8");
}

function git(repoPath, args, fallback = "") {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function parseControleRepoName(remoteUrl) {
  const normalized = remoteUrl.replace(/^git@github\.com:/, "https://github.com/");
  const match = normalized.match(/github\.com\/<env.OWNER>\/([^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function parseGitmodules(rootPath) {
  const filePath = path.join(rootPath, ".gitmodules");
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^\[submodule "(.+)"\]$/);
    if (sectionMatch) {
      if (current) {
        entries.push(current);
      }
      current = { section: sectionMatch[1] };
      continue;
    }

    const kvMatch = line.match(/^\s*([a-z]+)\s*=\s*(.+)\s*$/);
    if (current && kvMatch) {
      current[kvMatch[1]] = kvMatch[2];
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries.filter((entry) => entry.path && entry.url);
}

function detectReviewTarget() {
  return "staging";
}

function detectDefaultBranch() {
  return "master";
}

function detectFamily(rootKey, repoName) {
  if (rootKey === CENTRAL_REPO) {
    return "automation";
  }
  if (rootKey === "app-community" || repoName.startsWith("ui-")) {
    return "frontend";
  }
  if (
    rootKey === "api-whatsapp" ||
    repoName.includes("whatsapp") ||
    repoName.includes("messages-sdk") ||
    repoName.includes("spc-sdk")
  ) {
    return "integration";
  }
  return "backend";
}

function repoKindLabel(entry) {
  return entry.kind === "root" ? "projeto raiz" : `submodulo de ${entry.rootKey}`;
}

function familyLabel(family) {
  switch (family) {
    case "frontend":
      return "frontend";
    case "backend":
      return "backend";
    case "integration":
      return "integracao";
    case "automation":
      return "automacao";
    default:
      return family;
  }
}

function renderWrapper(type, entry) {
  const meta = typeMeta[type];
  const canonicalAgentUrl = `${CENTRAL_BASE_URL}/agents/roles/${type}/agent.md`;
  const skillsUrl = `${CENTRAL_BASE_URL}/agents/skills/README.md`;
  const sharedSkillsUrl = `${CENTRAL_BASE_URL}/agents/skills/shared/README.md`;
  const roleSkillsUrl = `${CENTRAL_BASE_URL}/agents/skills/by-role/${type}/README.md`;
  const wrapperContractUrl = `${CENTRAL_BASE_URL}/agents/skills/shared/operations/agent-wrapper-contract.md`;
  const runnersUrl = `${CENTRAL_BASE_URL}/agents/skills/runners/README.md`;
  const executionBaselineUrl = `${CENTRAL_BASE_URL}/agents/skills/shared/operations/agent-execution-baseline.md`;
  const githubWorkflowUrl = `${CENTRAL_BASE_URL}/agents/skills/shared/github/operational-github-workflow.md`;
  const securityGuardrailsUrl = `${CENTRAL_BASE_URL}/agents/skills/shared/security/operational-security-guardrails.md`;
  const agentsStatus = entry.hasAgentsMd ? "presente" : "ausente";

  return `---
name: ${meta.displayName}
description: ${meta.descriptionPrefix} do repositorio ${CONTROL_OWNER}/${entry.repoName}, com fonte canonica centralizada no ${CENTRAL_REPO}.
target: github-copilot
---

## Fonte canonica

Este wrapper deve permanecer fino. Antes de agir, leia e siga nesta ordem:

1. \`${canonicalAgentUrl}\`
2. \`${skillsUrl}\`
3. \`${sharedSkillsUrl}\`
4. \`${roleSkillsUrl}\`
5. \`${wrapperContractUrl}\`

## Contexto local

- repositorio: \`${CONTROL_OWNER}/${entry.repoName}\`
- checkout local: \`${entry.workspacePath}\`
- tipo: ${repoKindLabel(entry)}
- familia: ${familyLabel(entry.family)}
- branch base operacional: \`${entry.baseBranch}\`
- alvo preferencial de PR: \`${entry.reviewTarget}\`
- \`AGENTS.md\` local: ${agentsStatus}

## Lembretes operacionais

- use os runners, wrappers e scripts oficiais do papel atual sempre que isso ajudar a executar, validar ou destravar a trilha; consulte \`${runnersUrl}\`
- workflow desativado em \`.github/workflows/\` nao desautoriza o runner correspondente; siga \`${executionBaselineUrl}\`
- se nao houver outra superficie viavel de escrita no GitHub, a chave anexada a sessao pode ser usada como fallback operacional, com o menor escopo necessario e sem expor o segredo; siga \`${githubWorkflowUrl}\` e \`${securityGuardrailsUrl}\`

Leia o \`AGENTS.md\` mais proximo antes de editar codigo. Se a alteracao tocar apenas o repositorio atual, trabalhe aqui. Se tambem exigir atualizacao do projeto agregador ou de outro modulo dono da mudanca, preserve a separacao de ownership.

_Arquivo gerado por \`${CENTRAL_REPO}/workers/scripts/sync-copilot-agents.mjs\`._
`;
}

function collectEntries() {
  const entries = [];
  const byLocalPath = new Map();

  function addEntry(raw) {
    const localPath = path.join(workspaceRoot, raw.localRelPath);
    const existsLocally = fs.existsSync(localPath);
    const remoteUrl = raw.remoteUrl || (existsLocally ? git(localPath, ["remote", "get-url", "origin"]) : "");
    const repoName = parseControleRepoName(remoteUrl);

    if (!repoName) {
      return;
    }

    const baseBranch = detectDefaultBranch();
    const reviewTarget = detectReviewTarget();
    const hasAgentsMd = existsLocally && fs.existsSync(path.join(localPath, "AGENTS.md"));
    const workspacePath = raw.localRelPath.replace(/\\/g, "/");

    if (byLocalPath.has(workspacePath)) {
      return;
    }

    const entry = {
      repoName,
      repoUrl: `https://github.com/${CONTROL_OWNER}/${repoName}`,
      rootKey: raw.rootKey,
      localRelPath: workspacePath,
      workspacePath,
      localPath,
      existsLocally,
      kind: raw.kind,
      family: detectFamily(raw.rootKey, repoName),
      baseBranch,
      reviewTarget,
      hasAgentsMd,
    };

    byLocalPath.set(workspacePath, entry);
    entries.push(entry);
  }

  for (const root of roots) {
    addEntry({
      rootKey: root.key,
      localRelPath: root.relPath,
      kind: "root",
      remoteUrl: git(path.join(workspaceRoot, root.relPath), ["remote", "get-url", "origin"]),
    });

    const submodules = parseGitmodules(path.join(workspaceRoot, root.relPath));
    for (const submodule of submodules) {
      const repoName = parseControleRepoName(submodule.url);
      if (!repoName) {
        continue;
      }

      addEntry({
        rootKey: root.key,
        localRelPath: path.join(root.relPath, submodule.path),
        kind: "submodule",
        remoteUrl: submodule.url,
        declaredBranch: submodule.branch || "",
      });
    }
  }

  return entries;
}

function sync() {
  const entries = collectEntries();

  for (const entry of entries) {
    if (!entry.existsLocally) {
      continue;
    }

    for (const type of types) {
      const wrapperPath = path.join(entry.localPath, ".github", "agents", `${type}.agent.md`);
      writeFile(wrapperPath, renderWrapper(type, entry));
    }
  }

  console.log(
    `Generated wrappers for ${entries.filter((entry) => entry.existsLocally).length} local checkouts across ${types.length} agent types.`,
  );
}

sync();
