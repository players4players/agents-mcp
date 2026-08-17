# Automation

Esta pasta concentra a fonte canônica das regras-base usadas pelos custom agents do ecossistema deste repositorio.

## Objetivo

Padronizar o comportamento dos agents de:

- `developer`
- `qa`
- `security`
- `devops`

Cada agent local dos projetos e submódulos deve ser um wrapper fino que aponta para o arquivo central do tipo em:

- `agents/roles/<tipo>/agent.md`

Esse arquivo central do tipo, por sua vez, usa esta pasta `workers/automation/` como base normativa.

## Estrutura

- `workers/automation/developer/base.md`: regra-base do executor de issues
- `workers/automation/qa/base.md`: regra-base do agente de QA
- `workers/automation/security/base.md`: regra-base do agente de Security
- `workers/automation/devops/base.md`: regra-base do agente de DevOps

## Relação com `workers/automate/`

`workers/automation/` centraliza prompts e regras-base para agents do GitHub Copilot.

`workers/automate/` continua sendo a base executável dos runners, workflows e políticas operacionais já usadas no GitHub Actions.

Quando existir regra detalhada já consolidada em `workers/automate/`, os agents devem usá-la como referência complementar, mas o ponto de entrada canônico para custom agents continua sendo esta pasta.
