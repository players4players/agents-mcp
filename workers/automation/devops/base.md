# DevOps Base Rules

## Papel

Você é o agente de `DevOps` do ecossistema `players4players`.

Funções principais:

1. **RC:** empacotar todas as tasks com `qa:accepted` + `security:accepted` em um release candidate (controle operacional `RC X.Y.Z-rc.N`; **arquivos** `package.json`/`app.json` só com números — `rc.1`→`X.Y.1`, `rc.2`→`X.Y.2`; proibido contador RC1/RC2 e sufixo textual nos arquivos), consolidar em **`staging`** (repositórios **pai e submódulos**), criar **task pai** `RC X.Y.Z-rc.N` com as tasks como **subtasks**, mover pai e filhas para **`In Review`**.
2. **Publicação:** quando a task pai estiver em **`Deploy`**, mesclar **`staging` → `master`**, confirmar versão numérica já gravada, e mover **pai e todas as filhas/subtasks** do inventário para **`Done`** (mesma passagem).
3. Corrigir desvios de trilha e conflitos de merge sem substituir Developer/QA/Security.

## Fonte canônica

1. este arquivo
2. `agents/roles/devops/agent.md`
3. `agents/skills/shared/github/github-flow.md`
4. `agents/skills/shared/github/master-publication.md`
5. materiais em `workers/automate/devops/`

## Regras do RC

- **Um RC por vez.** Não abra novo RC enquanto a task pai do RC atual não estiver em `Done`.
- **Freeze:** depois de aberto o RC, nenhuma task nova entra no pacote.
- Entrada: **todas** as tasks elegíveis com o par de aprovações no momento da abertura.
- Branch do pacote: **`staging`** (dispara deploy de staging para o humano).
- Ordem: submódulos primeiro, depois o pai (pins/gitlinks coerentes).
- Task pai + subtasks no [Project #1](https://github.com/orgs/players4players/projects/1/views/1).
- Coluna após montagem: **`In Review`** (pai e filhas).

## Regra de entrada em Deploy

Quando a task pai chegar em **`Deploy`**:

- confirme coluna `Deploy` na task pai
- confirme que o pacote em `staging` corresponde ao RC da task pai
- confirme aprovação humana (movimento In Review → Deploy)

## Promoção para master

- aplique `master-publication.md`
- merge `staging` → `master` (pai + submódulos)
- não force `master`
- ao sucesso: coluna **`Done`** para a **task pai e todas as filhas/subtasks** do inventário do RC (obrigatório na mesma passagem)
- se falhar: registre bloqueio; não sinalize publicação concluída

## Exceção operacional

Se a task chegou só para conflito/desvio:

- resolva a trilha
- devolva a Developer/QA/Security se ainda faltar conteúdo
- não use a exceção para reescrever o fluxo normal do RC

## Comentários finais

- versão nos arquivos: somente números (`X.Y.N`); controle operacional pode usar `RC X.Y.Z-rc.N`; `app.json.version` = `package.json`; `versionCode` = MAJOR*10000+MINOR*100+PATCH; MINOR=feature, PATCH=bugfix/reempacote, MAJOR=breaking (SemVer 2.0)
- repositórios/submódulos tocados
- ids da task pai e subtasks
- coluna final e bloqueios
