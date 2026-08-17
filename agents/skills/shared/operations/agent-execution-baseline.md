## Configuracao do fork

**Obrigatorio:** leia `config/ecosystem.config.json` no inicio da execucao e resolva todos os placeholders (`<OWNER>`, `<PROJECT_URL>`, etc.) com os campos `value` / `runners.defaults`.

# Agent Execution Baseline

## Overview

Use esta skill quando um agent precisar executar uma trilha normal de produto, revisao ou reorganizacao estrutural sem reinventar regras basicas que ja pertencem ao ecossistema.

## Workflow

1. leia o `agents/roles/<agent>/agent.md` canonico do papel atual
2. leia `agents/skills/README.md` e `agents/skills/shared/README.md`
2b. leia `agents/skills/shared/operations/copilot-cooperation.md` (obrigatoria para todos os papeis)
3. leia a referencia mais especifica em `agents/skills/by-role/` ou `agents/skills/runners/`
4. leia o `AGENTS.md` local mais proximo quando houver codigo, modulo ou repositorio afetado
5. trate o repositorio local como ponto principal de execucao, nao como limite de entendimento do ecossistema
6. quando a etapa depender de mutacao real no GitHub, prefira o `GitHub Manager Runner`
7. se o runtime local nao conseguir concluir mutacoes necessarias no GitHub, use a trilha oficial do `GitHub Manager Runner` no proprio `agents-mcp`
8. confirme o estado atual no GitHub antes de concluir
9. use GitHub como fonte de verdade operacional quando houver issue, PR, workflow, review, label, ownership, coluna ou historico envolvidos
10. ao consultar ou alterar GitHub, pode usar qualquer API, busca, listagem, ferramenta ou superficie que estiver disponivel na sessao
11. se nao houver outra superficie de escrita viavel, o agent pode usar a chave do GitHub anexada a sessao como fallback operacional, desde que preserve o segredo e limite o uso ao necessario
12. use memoria apenas como apoio operacional externo ao repositorio

## Output Contract

Ao concluir, deixe claro:

- qual papel estava em execucao
- qual repositorio ou modulo foi o ponto principal da mudanca
- quais fontes foram confirmadas
- qual resultado, handoff ou bloqueio ficou registrado

## Quality Bar

- nao replique estas regras basicas em cada agent ou wrapper
- nao trate o checkout local como fronteira de conhecimento do sistema
- nao conclua sem validar o estado operacional atual
- nao substitua fonte central por memoria auxiliar
- nao finja mudanca de coluna, label ou ownership quando a mutacao real puder ser feita pelo runner oficial de GitHub
