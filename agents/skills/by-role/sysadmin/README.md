# Sysadmin Skills

## Papel

`Sysadmin` opera em **dois modos** agendaveis em workers separados. Cada execucao usa **um** modo apenas.

| Modo | Schedule / prompt | Faz | Nao faz |
| --- | --- | --- | --- |
| **`discover`** | `mode=discover` / job `sysadmin:discover` | Varredura (e-mail, grupos, logs, SSH, checklists) e **cria** issues | Nao resolve issue, nao aplica remediacao final no host |
| **`resolve`** | `mode=resolve` / job `sysadmin:resolve` | Pega **uma** issue com `agent:sysadmin` e **resolve** no servidor | Nao varre frota/e-mail; nao cria issues de descoberta |

Se o modo nao estiver claro no prompt ou no nome do job → **nao execute**.

## Projeto GitHub

- Ao **criar** qualquer issue: associar ao [Project #1](PROJECT_URL (org Project operacional)) (org `<OWNER>`, number `1`).
- ProjectV2 **pode** ser usado; preferir labels/issues para fila quando bastar.

## Anti-conflito

- `discover` e `resolve` nao compartilham a mesma passagem.
- `discover` deduplica issues abertas antes de criar.
- `resolve` pode marcar `sysadmin:working` enquanto atua; `discover` ignora itens ja cobertos por issue aberta `agent:sysadmin` / `sysadmin:working`.
- Nenhum modo altera codigo de produto.

## Skills e checklists

- `agents/skills/shared/operations/autonomous-operations.md`
- `agents/skills/shared/security/operational-security-guardrails.md`
- `agents/skills/shared/operations/operational-source-of-truth.md`
- `agents/skills/shared/operations/log-investigation-evidence.md`
- `agents/skills/shared/operations/email-reading-fallback.md`
- `agents/skills/shared/operations/issue-queue-discovery.md` (modo `resolve` + vinculo ao projeto)
- `agents/skills/shared/github/github-issue-handling.md`
- **Checklist servidor:** `agents/skills/by-role/sysadmin/checklist-server.md`
- **Checklist sistema/app (dev):** `agents/skills/by-role/sysadmin/checklist-system-dev.md`

## Ownership das issues criadas pelo discover

| Situacao | Label | Quem resolve |
| --- | --- | --- |
| Bug / erro de app / stack / dep no Git | `agent:developer` | Developer + checklist-system-dev |
| Patch de host, pacote SO, cert, disco, SSH, lib no servidor | `agent:sysadmin` | Sysadmin em modo **`resolve`** + checklist-server |

## Inventario SSH

1. Ler fonte de credenciais (banco/secrets).
2. Listar todas as maquinas (`discover` cobre; `resolve` so as da issue).
3. Nunca publicar a credencial.

## Fontes principais

- `agents/roles/sysadmin/agent.md`
- `agents/skills/by-role/sysadmin/checklist-server.md`
- `agents/skills/by-role/sysadmin/checklist-system-dev.md`
