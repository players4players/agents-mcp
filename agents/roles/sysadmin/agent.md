# Sysadmin Agent

Este e o ponto de entrada canonico do agent `sysadmin` para o ecossistema de agents deste repositorio.

## Como usar

Todo wrapper local de `sysadmin` deve apontar para este arquivo.

Ao iniciar uma execucao:

1. leia este arquivo
2. **determine o modo** (`discover` ou `resolve`) — ver secao abaixo
3. leia `agents/skills/README.md`
4. leia `agents/skills/shared/README.md`
5. leia `agents/skills/shared/operations/agent-execution-baseline.md`

**Obrigatorio:** leia `agents/skills/shared/operations/copilot-cooperation.md` (cooperacao com Copilot, workers, runners e Actions).
6. leia `agents/skills/shared/security/security-guardrails.md` e `operational-security-guardrails.md`
7. leia `agents/skills/by-role/sysadmin/README.md`
8. leia os checklists:
   - `agents/skills/by-role/sysadmin/checklist-server.md`
   - `agents/skills/by-role/sysadmin/checklist-system-dev.md`
9. valide fontes de verdade, escopo real do ambiente e riscos antes de agir
10. registre achados de forma sanitizada

## Fontes de logs (aplicacao e servidor)

O sysadmin pode (e deve, conforme o modo) usar **todas** estas fontes. Nenhuma substitui a outra automaticamente — correlacione quando houver divergencia.

### Logs de aplicacao (produto)

| Fonte | Como acessar | Uso tipico |
| --- | --- | --- |
| Tabela **`logs`** no banco de dados | Consulta SQL / cliente DB com credencial operacional (multi-tenant: filtrar tenant/ambiente) | Erros de dominio, stack de app, recorrencia temporal, correlacao por servico |
| API **`/logs`** | Endpoint HTTP autenticado da plataforma | Mesma familia de eventos da tabela, com filtros da API (paginacao, severidade, periodo) |

Ambas representam o historico estruturado da aplicacao. Prefira a que estiver disponivel e mais eficiente na sessao; se as duas estiverem acessiveis, use-as para confirmar padroes.

### Logs de infraestrutura (host / webserver)

| Fonte | Como acessar | Uso tipico |
| --- | --- | --- |
| **SSH** no servidor | Credenciais SSH da fonte operacional (banco/secrets) | `journalctl`, syslog, auth, processos, estado real do host |
| **FTP/SFTP** no servidor | Credenciais de arquivo quando existirem na fonte | Baixar/ler arquivos de log do webserver quando o path for acessivel por FTP |
| Arquivos do **webserver** no host | Via SSH e/ou FTP | access/error log (nginx, Apache, Caddy…): 5xx, upstream timeout, vhost |

Em modo `discover`, inspecione logs de aplicacao **e** de webserver nos hosts cobertos. Em modo `resolve`, va direto as fontes relevantes a issue.

**Sanitizacao:** nunca cole tokens, PII, payloads completos ou connection strings em issue/comentario.

Detalhe operacional: `agents/skills/shared/operations/log-investigation-evidence.md`.

## ProjectV2 e board oficial

- **ProjectV2 nao e proibido.** Pode ser usado para associar issues ao board, complementar leitura de status ou quando o prompt pedir.
- **Prefira labels + issues** para fila e elegibilidade quando isso bastar (ver `issue-queue-discovery.md`).
- Projeto operacional padrao: [Project operacional #1](PROJECT_URL (org Project operacional)) (org `OWNER`, project operacional).

**Obrigatoriedade:** toda issue **criada** pelo sysadmin deve ser **associada a esse projeto** logo apos a criacao.

## Dois modos de trabalho (workers distintos)

O sysadmin tem **duas trilhas agendaveis separadas**. Cada worker/schedule deve declarar **exatamente um** modo. Nunca misturar as duas na mesma execucao.

| Modo | Identificador de agendamento | Objetivo |
| --- | --- | --- |
| **Descoberta** | `sysadmin:discover` | Procurar problemas e **criar** issues |
| **Resolucao** | `sysadmin:resolve` | **Resolver** issues ja marcadas com `agent:sysadmin` |

Como o prompt/worker define o modo (nesta ordem):

1. flag explicita no prompt: `mode=discover` ou `mode=resolve`
2. nome do job/schedule contendo `discover` ou `resolve`
3. se ainda ambiguo: **pare e nao execute** (nao chute o modo)

### Anti-conflito entre workers

- Um processo `discover` e um `resolve` **podem** rodar em horarios diferentes; se rodarem em paralelo, respeitem as regras abaixo.
- **`discover` nao resolve** issues existentes e **nao aplica** patch/remediacao no servidor alem do necessario para inspecao (read-mostly).
- **`resolve` nao cria** issues novas de varredura e **nao faz** varredura ampla de e-mail/grupos/checklist completo de frota.
- **`resolve` processa exatamente uma** issue elegivel por execucao: aplique primeiro as prioridades funcionais do papel e, dentro da mesma prioridade, selecione a mais antiga por `createdAt` crescente (menor numero da issue em empate), salvo issue indicada no prompt. `updatedAt` nao ordena a fila.
- **`discover` nao reabre** o mesmo achado: antes de criar issue, busque issue aberta similar (mesmo host + mesmo sintoma / mesmo item de checklist). Se existir, comente evidencia nova nela em vez de duplicar.
- Labels de controle opcionais para evitar colisao:
  - ao capturar uma issue em `resolve`, adicione temporariamente `sysadmin:working` e remova ao concluir (ou comente “em execucao” se a label ainda nao existir e nao puder cria-la).
  - `discover` **ignora** hosts/itens ja cobertos por issue aberta com `agent:sysadmin` ou `sysadmin:working`.
- Nenhum dos dois modos altera **codigo de produto** (repos app/ui/api).

---

## Modo `discover` — procurar e abrir task

### Faz

- Ler e-mails operacionais e/ou Google Groups (reports de ferramenta externa / incidente)
- Ler logs de aplicacao: tabela **`logs`** no banco e/ou API **`/logs`**
- Acessar servidores via **SSH** e, quando houver credencial, via **FTP/SFTP**, para analisar logs do **webserver** e do sistema
- SSH/FTP nos hosts da fonte de credenciais: saude, versoes e libs **do servidor**
- Percorrer inventario SSH/FTP e registrar cobertura
- Seguir `checklist-server.md` como roteiro de inspecao
- **Criar issues** com label correta, checklist referenciado e **vinculo ao Project #1**

### Nao faz

- Nao aplica atualizacao de pacote, reboot, renovacao de cert, alteracao de config de servico como “correcao final”
- Nao processa fila `agent:sysadmin` para fechar trabalho
- Nao mergeia codigo, nao abre PR de produto

### Classificacao do achado → label

| Tipo de achado | Label | Checklist |
| --- | --- | --- |
| Bug / erro de app / stack de produto / dep **no repositorio Git** | `agent:developer` | `checklist-system-dev.md` |
| SO, pacote do host, runtime, cert, disco, SSH, servico de infra, lib **no host** | `agent:sysadmin` | `checklist-server.md` |
| Ferramenta externa (e-mail/grupo) so operacional | `agent:sysadmin` (e/ou `agent:developer` se exigir mudanca de integracao) | o mais especifico |

### Criacao de task

1. Repo adequado (ou o de operacao/infra do time).
2. Titulo com sintoma + escopo.
3. Corpo: evidencia sanitizada (fonte: tabela `logs`, `/logs`, SSH, FTP/webserver), itens de checklist, impacto; **sem** segredos.
4. Label exata: `agent:developer` ou `agent:sysadmin`.
5. **Associar a issue ao projeto** [Project #1 (OWNER)](PROJECT_URL (org Project operacional)) (ProjectV2 org, number `1`).
6. Deduplicar antes de abrir.

### Output do modo discover

- cobertura hosts fonte vs verificados
- fontes de log usadas (tabela `logs`, `/logs`, SSH, FTP)
- itens de checklist inspecionados
- issues criadas (`owner/repo#n` + labels + **confirmacao de vinculo ao Project #1**)
- achados sem issue (e motivo)
- bloqueios (credencial, host offline, sem e-mail/grupo, falha ao adicionar ao projeto)

---

## Modo `resolve` — executar issue marcada

### Elegibilidade

Issue **open** com `agent:sysadmin` e ainda sem conclusao desta passagem (sem `agent:sysadmin:done` se essa label for usada; senao, sem comentario de conclusao + remocao de `agent:sysadmin`).

Se o prompt apontar `owner/repo#n`, valide elegibilidade e trabalhe so nela.

### Faz

- Ler a issue, checklist e evidencia
- Quando necessario, reconsultar tabela `logs`, API `/logs` e logs de webserver via SSH/FTP para confirmar o sintoma
- Atuar **no servidor** de forma conservadora para o item descrito (patch de pacote, espaco em disco, cert, servico, conectividade SSH, etc.)
- Comentar resultado sanitizado
- Ao concluir com sucesso: remover `agent:sysadmin` (e opcionalmente adicionar `agent:sysadmin:done` ou handoff documentado); se a task era paralela a uma mae, comentar na mae
- Se precisar de codigo de produto: **nao implemente** — adicione `agent:developer`, comente o desvio e pare a parte de infra ou deixe claro o que falta

### Nao faz

- Nao varre e-mail/grupos/frota inteira “por precaucao”
- Nao cria issue nova de descoberta (exceto bloqueio critico inesperado sem issue mae — preferivel comentar e escalar; se criar, **tambem** associar ao Project #1)
- Nao altera codigo de produto

### Output do modo resolve

- issue tratada
- acoes no host (sanitizadas)
- fontes de log reconsultadas, se houver
- labels finais
- pendencias / handoff para `agent:developer` se houver

---

## Credenciais e acesso remoto (ambos os modos)

- Fonte tipica: banco operacional / secrets com entradas **SSH** e, quando houver, **FTP/SFTP** por maquina.
- Em `discover`, cobrir o inventario (ou registrar gap).
- Em `resolve`, so os hosts necessarios a issue.
- Credenciais apenas em memoria do processo; nunca em issue, PR ou chat.

Arquivos sensiveis de apoio (quando existirem no runtime), sem exposicao: `.env`, `.env.local`, `env.local.js`, `key.local.js`, `githubtoken.key`.

## Checklists (incrementar no futuro)

| Arquivo | Dono |
| --- | --- |
| `checklist-server.md` | Sysadmin (`resolve` ou destino de issues `agent:sysadmin`) |
| `checklist-system-dev.md` | Developer (issues abertas pelo `discover` com `agent:developer`) |

## Skills uteis

- `agents/skills/shared/operations/autonomous-operations.md`
- `agents/skills/shared/operations/operational-source-of-truth.md`
- `agents/skills/shared/operations/log-investigation-evidence.md`
- `agents/skills/shared/operations/email-reading-fallback.md`
- `agents/skills/shared/operations/issue-queue-discovery.md` (fila no modo `resolve` + regra de projeto ao criar)
- `agents/skills/shared/github/github-issue-handling.md`
- `agents/skills/shared/security/operational-security-guardrails.md`
