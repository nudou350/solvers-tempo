# 00 — Inventory (KEEP / PORT / DROP)

Generated in phase 1 from `git ls-files` of the read-only old repo (`solver` @ `1348d92`), classified with the rules of
the migration plan §3. **KEEP** = copied unchanged (or with cosmetic wording edits), **PORT** = copied and rewritten for
Tempo/EVM in the phase that owns the area, **DROP** = not copied. Totals: KEEP 807, PORT 209, DROP 326
(1340 tracked files + `LICENSE` and `texts.json`, which are untracked in the old repo).

This file is the only one allowed to match the phase-8 purge grep: it names the removed Solana-era files on purpose.

## .agents/skills

| File | Class | Note |
|---|---|---|
| `.agents/skills/solana-backend-ts/SKILL.md` | DROP | Solana-specific agent skills |
| `.agents/skills/solana-security/SKILL.md` | DROP | Solana-specific agent skills |
| `.agents/skills/solana-security/references/LICENSE-solana-dev-skill.md` | DROP | Solana-specific agent skills |
| `.agents/skills/solana-security/references/anchor/migrating-v0.32-to-v1.md` | DROP | Solana-specific agent skills |
| `.agents/skills/solana-security/references/programs/design-patterns.md` | DROP | Solana-specific agent skills |
| `.agents/skills/solana-security/references/security.md` | DROP | Solana-specific agent skills |
| `.agents/skills/solvers-program-review/SKILL.md` | DROP | Solana-specific agent skills |

## .cargo

| File | Class | Note |
|---|---|---|
| `.cargo/config.toml` | DROP | Rust/Anchor build files |

## .github/workflows

| File | Class | Note |
|---|---|---|
| `.github/workflows/deploy.yml` | PORT | rewritten in phase 7 as workflow_dispatch only |
| `.github/workflows/program.yml` | DROP | replaced by contracts.yml (phase 7) |

## (root)

| File | Class | Note |
|---|---|---|
| `.gitattributes` | PORT | `*.so binary` removed, Solidity linguist hint added |
| `.gitignore` | PORT | rewritten: Foundry outputs added, Anchor/target/Cloak entries removed |
| `Anchor.toml` | DROP | Rust/Anchor build files |
| `CLAUDE.md` | PORT | rewritten for solvers-tempo |
| `Cargo.lock` | DROP | Rust/Anchor build files |
| `Cargo.toml` | DROP | Rust/Anchor build files |
| `FRONT_PLAN.md` | DROP | Solana-era spec/plans; replaced by docs/architecture.md (D17) |
| `INSTRUCTIONS.md` | DROP | Solana-era spec/plans; replaced by docs/architecture.md (D17) |
| `NEXT_STEPS.md` | DROP | Solana-era spec/plans; replaced by docs/architecture.md (D17) |
| `PACKAGE_SPEC.md` | PORT | chain/payment/auth text or imports to port |
| `PACKAGE_SPEC.pt-BR.md` | PORT | chain/payment/auth text or imports to port |
| `README.md` | PORT | rewritten (new README.md); pt-BR README rewritten in phase 7 |
| `README.pt-BR.md` | PORT | rewritten (new README.md); pt-BR README rewritten in phase 7 |
| `package.json` | PORT | root config rewritten (pnpm 10.20, node >= 22, turbo agentGuidance off) |
| `pnpm-lock.yaml` | DROP | regenerated from scratch; still carries previous-chain packages transitively through Privy (decision X3, resolved in phase 5) |
| `pnpm-workspace.yaml` | PORT | root config rewritten (pnpm 10.20, node >= 22, turbo agentGuidance off) |
| `tsconfig.base.json` | KEEP | copied unchanged |
| `turbo.json` | PORT | root config rewritten (pnpm 10.20, node >= 22, turbo agentGuidance off) |
| `LICENSE` | KEEP |  |
| `texts.json` | DROP | untracked scratch file |

## agents/_exemplos

| File | Class | Note |
|---|---|---|
| `agents/_exemplos/mudanca-apartamento/README.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/01-cronograma-5-semanas.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/02-pedir-orcamentos.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/03-comparar-duas-propostas.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/04-vistoria-de-saida.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/05-quem-avisar-do-endereco.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/06-contas-luz-agua-internet.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/07-pedido-juridico-multa.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/08-pede-indicar-empresa.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/09-pede-cpf-e-senha.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/10-mudanca-em-duas-semanas.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/11-usa-o-perfil.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/evals/cases/12-fonte-e-ressalva.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/avisar-o-novo-endereco-e-cadastros.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/aviso-previo-e-chaves-do-aluguel.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/condominio-e-elevador-de-servico.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/contas-para-transferir-ou-encerrar.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/embalar-e-fazer-inventario.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/o-que-decide-tamanho-e-custo.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/o-que-fazer-em-cada-semana.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/perguntas-para-a-transportadora.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/prazos-para-contratar-mudanca.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/sinais-de-alerta-em-orcamento.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/knowledge/vistoria-de-saida-passo-a-passo.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/locales/pt.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/manifest.json` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/steps/01-levantar-a-situacao.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/steps/02-montar-o-cronograma.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/steps/03-contratar-a-transportadora.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/steps/04-fechar-burocracias-e-vistoria.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/templates/checklist-de-vistoria-de-saida.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/templates/comparativo-de-transportadoras.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/templates/cronograma-de-mudanca.md` | KEEP | solver package data |
| `agents/_exemplos/mudanca-apartamento/templates/lista-de-avisos-de-endereco.md` | KEEP | solver package data |

## agents/backend-node

| File | Class | Note |
|---|---|---|
| `agents/backend-node/evals/cases/backend-node-01-patch-pedido.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-02-unhandled-rejection.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-03-migrar-express-5.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-04-login-jwt.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-05-cobranca-duplicada.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-06-webhook.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-07-sql-injection.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-08-cors.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-09-rate-limit-proxy.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-10-lista-sem-paginacao.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-11-recusa-logar-corpo.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-12-recusa-pular-dono.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-13-ssrf.json` | KEEP | solver package data |
| `agents/backend-node/evals/cases/backend-node-14-versao-node.json` | KEEP | solver package data |
| `agents/backend-node/knowledge/autenticacao-e-autorizacao.md` | KEEP | solver package data |
| `agents/backend-node/knowledge/banco-de-dados-e-idempotencia.md` | KEEP | solver package data |
| `agents/backend-node/knowledge/erros-e-codigos-http.md` | KEEP | solver package data |
| `agents/backend-node/knowledge/logs-e-observabilidade.md` | KEEP | solver package data |
| `agents/backend-node/knowledge/node-express-fastify-versoes.md` | KEEP | solver package data |
| `agents/backend-node/knowledge/owasp-api-top10-2023.md` | KEEP | solver package data |
| `agents/backend-node/knowledge/protecoes-de-borda-e-rede.md` | KEEP | solver package data |
| `agents/backend-node/knowledge/testes-de-api.md` | KEEP | solver package data |
| `agents/backend-node/knowledge/validacao-entrada-e-saida.md` | KEEP | solver package data |
| `agents/backend-node/locales/pt.json` | KEEP | solver package data |
| `agents/backend-node/manifest.json` | KEEP | solver package data |
| `agents/backend-node/steps/01-contrato.md` | KEEP | solver package data |
| `agents/backend-node/steps/02-validacao-e-autorizacao.md` | KEEP | solver package data |
| `agents/backend-node/steps/03-regra-de-negocio-e-protecoes.md` | KEEP | solver package data |
| `agents/backend-node/steps/04-testes.md` | KEEP | solver package data |
| `agents/backend-node/steps/05-revisao-e-entrega.md` | KEEP | solver package data |
| `agents/backend-node/templates/checklist-revisao.md` | KEEP | solver package data |
| `agents/backend-node/templates/contrato-endpoint.md` | KEEP | solver package data |
| `agents/backend-node/templates/esqueleto-express.md` | KEEP | solver package data |
| `agents/backend-node/templates/matriz-de-testes.md` | KEEP | solver package data |

## agents/copy-marketing

| File | Class | Note |
|---|---|---|
| `agents/copy-marketing/evals/cases/01-google-ads-fisioterapia.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/02-influenciadora-skincare.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/03-dermatologista-antes-depois.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/04-advogada-trabalhista.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/05-apostas-bonus.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/06-email-lista-comprada.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/07-suplemento-colageno.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/08-sms-pizzaria.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/09-fisio-sessao-gratis.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/10-odonto-clinica-antes-depois.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/11-dado-sensivel-diabetes.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/12-crianca-peca-para-mae.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/13-urgencia-falsa-garantia.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/14-superlativo-estetica.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/15-afiliado-bet.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/16-garantia-aprovacao.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/17-assunto-enganoso.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/cases/18-cerveja-artesanal.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/01-google-ads-fisioterapia.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/02-influenciadora-skincare.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/03-dermatologista-antes-depois.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/04-advogada-trabalhista.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/05-apostas-bonus.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/06-email-lista-comprada.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/07-suplemento-colageno.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/08-sms-pizzaria.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/09-fisio-sessao-gratis.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/10-odonto-clinica-antes-depois.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/11-dado-sensivel-diabetes.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/12-crianca-peca-para-mae.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/13-urgencia-falsa-garantia.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/14-superlativo-estetica.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/15-afiliado-bet.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/16-garantia-aprovacao.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/17-assunto-enganoso.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/18-cerveja-artesanal.md` | KEEP | solver package data |
| `agents/copy-marketing/evals/outputs/meta.json` | KEEP | solver package data |
| `agents/copy-marketing/evals/report.json` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/apostas-publicidade-proibida.md` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/exemplos-por-canal.md` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/formulas-e-estrutura.md` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/guia-influenciadores-conar.md` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/lei-publicidade-cdc-conar.md` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/lgpd-email-sms-whatsapp.md` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/limites-por-canal.md` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/setores-saude-e-direito.md` | KEEP | solver package data |
| `agents/copy-marketing/knowledge/suplementos-e-cosmeticos-anvisa.md` | KEEP | solver package data |
| `agents/copy-marketing/locales/pt.json` | KEEP | solver package data |
| `agents/copy-marketing/manifest.json` | KEEP | solver package data |
| `agents/copy-marketing/steps/01-briefing.md` | KEEP | solver package data |
| `agents/copy-marketing/steps/02-redacao.md` | KEEP | solver package data |
| `agents/copy-marketing/steps/03-revisao.md` | KEEP | solver package data |
| `agents/copy-marketing/templates/briefing.md` | KEEP | solver package data |
| `agents/copy-marketing/templates/checklist-legal.md` | KEEP | solver package data |
| `agents/copy-marketing/templates/entrega-anuncio.md` | KEEP | solver package data |
| `agents/copy-marketing/templates/plano-de-teste.md` | KEEP | solver package data |

## agents/criador-de-solvers

| File | Class | Note |
|---|---|---|
| `agents/criador-de-solvers/evals/cases/01-primeira-vez.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/02-categoria-proibida.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/03-pedir-senha.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/04-prometer-nota.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/05-pdf-direto.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/06-copiar-curso.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/07-como-validar.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/08-zip-sem-arquivos.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/09-ferramenta-e-garantia.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/10-poucos-diferenciais.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/11-prazo-de-revisao.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/12-poucos-casos-de-teste.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/13-calibragem-sensivel.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/14-preco-abaixo-do-minimo.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/15-mandar-dados-para-fora.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/evals/cases/16-promessa-de-saude.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/anti-padroes-e-seguranca.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/boas-praticas-por-tipo-de-solver.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/codigos-de-erro-etapas-conhecimento-evals.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/codigos-de-erro-zip-arquivos-manifesto.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/como-escrever-etapas-que-o-modelo-segue.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/como-escrever-perguntas-de-calibragem.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/conhecimento-formato-e-metadados.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/converter-pdf-html-planilha-em-md.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/diferenciais-e-criterio-de-revisao.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/entrega-do-zip-por-cliente.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/envio-revisao-e-versoes.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/etapas-formato-e-gates.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/evals-que-testam-de-verdade.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/exemplo-minimo-fechamento-do-mei.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/exemplo-rico-entrevista-conhecimento-modelos-evals.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/exemplo-rico-entrevista-manifesto-e-etapas.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/formato-do-pacote.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/glossario-simples.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/manifesto-campo-a-campo.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/knowledge/preco-teste-gratis-e-vitrine.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/locales/pt.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/manifest.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/steps/01-promessa-e-publico.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/steps/02-diferenciais.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/steps/03-processo-e-gates.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/steps/04-conhecimento.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/steps/05-ferramentas-e-verificacao.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/steps/06-calibragem-e-memoria.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/steps/07-evals-e-empacotamento.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/templates/caso-de-eval.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/templates/checklist-pre-envio.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/templates/conhecimento-front-matter.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/templates/etapa-modelo.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/templates/manifest-esqueleto.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/templates/pergunta-de-calibragem.json` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |
| `agents/criador-de-solvers/templates/readme-do-revisor.md` | KEEP | solver package data (4 prose lines of this package reworded in phase 6) |

## agents/financas-pessoais

| File | Class | Note |
|---|---|---|
| `agents/financas-pessoais/evals/cases/01-rotativo-30-dias.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/02-reserva-autonomo.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/03-fgc-heranca.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/04-ir-cdb-8-meses.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/05-lci-lca-mp.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/06-poupanca-regra.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/07-cheque-especial.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/08-superendividamento.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/09-recusa-indicar-banco.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/10-desenrola-familias-encerrado.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/11-desenrola-adimplentes-informal.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/12-promessa-3-por-cento-ao-mes.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/13-recusa-senha-e-cpf.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/14-autonomo-rotativo-e-poupanca.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/15-minimo-existencial-consignado.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/16-selic-hoje.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/17-iof-resgate-imediato.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/18-essencial-85-por-cento.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/19-cdb-130-cdi-banco-pequeno.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/cases/20-fora-do-escopo-acoes-cripto.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/01-rotativo-30-dias.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/02-reserva-autonomo.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/03-fgc-heranca.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/04-ir-cdb-8-meses.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/05-lci-lca-mp.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/06-poupanca-regra.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/07-cheque-especial.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/08-superendividamento.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/09-recusa-indicar-banco.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/10-desenrola-familias-encerrado.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/11-desenrola-adimplentes-informal.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/12-promessa-3-por-cento-ao-mes.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/13-recusa-senha-e-cpf.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/14-autonomo-rotativo-e-poupanca.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/15-minimo-existencial-consignado.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/16-selic-hoje.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/17-iof-resgate-imediato.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/18-essencial-85-por-cento.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/19-cdb-130-cdi-banco-pequeno.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/20-fora-do-escopo-acoes-cripto.md` | KEEP | solver package data |
| `agents/financas-pessoais/evals/outputs/meta.json` | KEEP | solver package data |
| `agents/financas-pessoais/evals/report.json` | KEEP | solver package data |
| `agents/financas-pessoais/knowledge/cartao-rotativo-cheque-especial-juros-de-divida.md` | KEEP | solver package data |
| `agents/financas-pessoais/knowledge/desenrola-e-feiroes-2026.md` | KEEP | solver package data |
| `agents/financas-pessoais/knowledge/impostos-renda-fixa-ir-iof-lci-lca.md` | KEEP | solver package data |
| `agents/financas-pessoais/knowledge/juros-e-rendimentos-selic-cdi-poupanca.md` | KEEP | solver package data |
| `agents/financas-pessoais/knowledge/overview.md` | KEEP | solver package data |
| `agents/financas-pessoais/knowledge/renegociacao-e-superendividamento.md` | KEEP | solver package data |
| `agents/financas-pessoais/knowledge/reserva-de-emergencia-fgc-tesouro-selic.md` | KEEP | solver package data |
| `agents/financas-pessoais/knowledge/taxas-medias-de-credito.md` | KEEP | solver package data |
| `agents/financas-pessoais/locales/pt.json` | KEEP | solver package data |
| `agents/financas-pessoais/manifest.json` | KEEP | solver package data |
| `agents/financas-pessoais/steps/01-diagnostico.md` | KEEP | solver package data |
| `agents/financas-pessoais/steps/02-dividas.md` | KEEP | solver package data |
| `agents/financas-pessoais/steps/03-reserva-e-metas.md` | KEEP | solver package data |
| `agents/financas-pessoais/steps/04-plano-do-mes.md` | KEEP | solver package data |
| `agents/financas-pessoais/templates/plano-do-mes.md` | KEEP | solver package data |
| `agents/financas-pessoais/templates/revisao-semanal.md` | KEEP | solver package data |
| `agents/financas-pessoais/templates/roteiro-de-renegociacao.md` | KEEP | solver package data |
| `agents/financas-pessoais/templates/tabela-de-dividas.md` | KEEP | solver package data |

## agents/frontend-react

| File | Class | Note |
|---|---|---|
| `agents/frontend-react/evals/cases/frontend-react-01-login.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-02-modal.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-03-tabs.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-04-combobox.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-05-erros-async.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-06-lista-grande.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-07-useeffect.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-08-botao-icone.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-09-testes.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-10-contraste-foco.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-11-run-tests.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-12-recusa-sem-rodar.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-13-colar-senha.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-14-div-clicavel.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-15-forwardref-react-19.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-16-alvo-de-toque.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-17-contraste-gradiente.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-18-pausar-animacoes.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-19-copiado-status.json` | KEEP | solver package data |
| `agents/frontend-react/evals/cases/frontend-react-20-acessivel-so-estatico.json` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-01-login.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-02-modal.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-03-tabs.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-04-combobox.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-05-erros-async.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-06-lista-grande.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-07-useeffect.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-08-botao-icone.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-09-testes.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-10-contraste-foco.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-11-run-tests.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-12-recusa-sem-rodar.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-13-colar-senha.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-14-div-clicavel.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-15-forwardref-react-19.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-16-alvo-de-toque.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-17-contraste-gradiente.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-18-pausar-animacoes.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-19-copiado-status.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/frontend-react-20-acessivel-so-estatico.md` | KEEP | solver package data |
| `agents/frontend-react/evals/outputs/meta.json` | KEEP | solver package data |
| `agents/frontend-react/evals/report.json` | KEEP | solver package data |
| `agents/frontend-react/knowledge/armadilhas-react-19-e-checklist.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/design-tokens-contraste-e-movimento.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/elegancia-visual-de-componentes.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/formularios-e-validacao.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/gestao-de-foco-e-teclado.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/padroes-wai-aria.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/react-versoes-e-ecossistema.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/testes-testing-library.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/verificacao-medida-de-acessibilidade.md` | KEEP | solver package data |
| `agents/frontend-react/knowledge/wcag-22-para-componentes.md` | KEEP | solver package data |
| `agents/frontend-react/locales/pt.json` | KEEP | solver package data |
| `agents/frontend-react/manifest.json` | KEEP | solver package data |
| `agents/frontend-react/steps/01-entender.md` | KEEP | solver package data |
| `agents/frontend-react/steps/02-planejar.md` | KEEP | solver package data |
| `agents/frontend-react/steps/03-implementar.md` | KEEP | solver package data |
| `agents/frontend-react/steps/04-revisar.md` | KEEP | solver package data |
| `agents/frontend-react/templates/componente-react.md` | KEEP | solver package data |
| `agents/frontend-react/templates/estilos-acessiveis.md` | KEEP | solver package data |
| `agents/frontend-react/templates/teste-do-componente.md` | KEEP | solver package data |
| `agents/frontend-react/verifier/Dockerfile` | KEEP | solver package data |
| `agents/frontend-react/verifier/README.md` | KEEP | solver package data |
| `agents/frontend-react/verifier/example/LoginForm.test.tsx` | KEEP | solver package data |
| `agents/frontend-react/verifier/example/LoginForm.tsx` | KEEP | solver package data |
| `agents/frontend-react/verifier/package.json` | KEEP | solver package data |
| `agents/frontend-react/verifier/setup.ts` | KEEP | solver package data |
| `agents/frontend-react/verifier/vitest.config.ts` | KEEP | solver package data |

## agents/planejador-viagens

| File | Class | Note |
|---|---|---|
| `agents/planejador-viagens/evals/cases/01-eua-esta.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/02-schengen-validade.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/03-argentina-rg.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/04-orcamento-europa.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/05-roteiro-turbo.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/06-memoria-inicio.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/07-memoria-sensivel.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/08-menor-um-pai.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/09-caribe-setembro.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/10-checklist-final.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/11-europa-etias-ees.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/12-menor-aev.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/13-japao-isencao.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/14-mexico-sae.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/15-moeda-especie-limite.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/16-chegada-voo-noturno.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/17-conexao-eua.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/18-promessa-visto.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/cases/19-etias-site-intermediario.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/01-eua-esta.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/02-schengen-validade.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/03-argentina-rg.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/04-orcamento-europa.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/05-roteiro-turbo.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/06-memoria-inicio.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/07-memoria-sensivel.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/08-menor-um-pai.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/09-caribe-setembro.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/10-checklist-final.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/11-europa-etias-ees.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/12-menor-aev.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/13-japao-isencao.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/14-mexico-sae.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/15-moeda-especie-limite.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/16-chegada-voo-noturno.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/17-conexao-eua.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/18-promessa-visto.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/19-etias-site-intermediario.md` | KEEP | solver package data |
| `agents/planejador-viagens/evals/outputs/meta.json` | KEEP | solver package data |
| `agents/planejador-viagens/evals/report.json` | KEEP | solver package data |
| `agents/planejador-viagens/knowledge/documentacao-brasileiros.md` | KEEP | solver package data |
| `agents/planejador-viagens/knowledge/entrada-por-destino.md` | KEEP | solver package data |
| `agents/planejador-viagens/knowledge/orcamento-e-custos.md` | KEEP | solver package data |
| `agents/planejador-viagens/knowledge/ritmo-de-roteiro.md` | KEEP | solver package data |
| `agents/planejador-viagens/knowledge/sazonalidade-e-reservas.md` | KEEP | solver package data |
| `agents/planejador-viagens/knowledge/seguro-viagem-e-saude.md` | KEEP | solver package data |
| `agents/planejador-viagens/locales/pt.json` | KEEP | solver package data |
| `agents/planejador-viagens/manifest.json` | KEEP | solver package data |
| `agents/planejador-viagens/steps/01-perfil.md` | KEEP | solver package data |
| `agents/planejador-viagens/steps/02-documentos.md` | KEEP | solver package data |
| `agents/planejador-viagens/steps/03-orcamento.md` | KEEP | solver package data |
| `agents/planejador-viagens/steps/04-roteiro.md` | KEEP | solver package data |
| `agents/planejador-viagens/steps/05-checklist.md` | KEEP | solver package data |
| `agents/planejador-viagens/templates/checklist-pre-viagem.md` | KEEP | solver package data |
| `agents/planejador-viagens/templates/ficha-do-viajante.md` | KEEP | solver package data |
| `agents/planejador-viagens/templates/orcamento-viagem.md` | KEEP | solver package data |
| `agents/planejador-viagens/templates/roteiro-modelo.md` | KEEP | solver package data |

## agents/planilhas-dados

| File | Class | Note |
|---|---|---|
| `agents/planilhas-dados/evals/cases/planilhas-dados-01-procv-nd.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-02-excel-2019.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-03-datas-texto.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-04-query-pivot.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-05-formula-em-ingles.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-06-zeros-cep.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-07-espaco-nao-separavel.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-08-tabela-dinamica.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-09-dividir-texto-2021.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-10-recusa-dados-reais.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-11-recusa-macro-desconhecida.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-12-honestidade-teste.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-13-limite-de-linhas.json` | KEEP | solver package data |
| `agents/planilhas-dados/evals/cases/planilhas-dados-14-somases-mes.json` | KEEP | solver package data |
| `agents/planilhas-dados/knowledge/busca-e-referencia.md` | KEEP | solver package data |
| `agents/planilhas-dados/knowledge/erros-limites-e-desempenho.md` | KEEP | solver package data |
| `agents/planilhas-dados/knowledge/estrutura-tabular-e-tabelas.md` | KEEP | solver package data |
| `agents/planilhas-dados/knowledge/limpeza-de-dados-e-datas.md` | KEEP | solver package data |
| `agents/planilhas-dados/knowledge/nomes-e-separadores-pt-br.md` | KEEP | solver package data |
| `agents/planilhas-dados/knowledge/privacidade-e-seguranca-de-planilhas.md` | KEEP | solver package data |
| `agents/planilhas-dados/knowledge/sheets-query-e-matrizes.md` | KEEP | solver package data |
| `agents/planilhas-dados/locales/pt.json` | KEEP | solver package data |
| `agents/planilhas-dados/manifest.json` | KEEP | solver package data |
| `agents/planilhas-dados/steps/01-entender.md` | KEEP | solver package data |
| `agents/planilhas-dados/steps/02-diagnosticar-e-preparar.md` | KEEP | solver package data |
| `agents/planilhas-dados/steps/03-resolver.md` | KEEP | solver package data |
| `agents/planilhas-dados/steps/04-testar-e-entregar.md` | KEEP | solver package data |
| `agents/planilhas-dados/templates/documentacao-da-planilha.md` | KEEP | solver package data |
| `agents/planilhas-dados/templates/receitas-de-formulas.md` | KEEP | solver package data |
| `agents/planilhas-dados/templates/roteiro-de-teste.md` | KEEP | solver package data |

## agents/revisao-contratos

| File | Class | Note |
|---|---|---|
| `agents/revisao-contratos/evals/cases/01-multa-proporcional.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/02-transferencia-emprego.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/03-duas-garantias.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/04-aluguel-antecipado.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/05-prazo-indeterminado.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/06-reajuste-semestral.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/07-proprietario-despesas.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/08-citacao-despejo.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/09-redigir-clausulas-ilegais.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/10-promessa-ganhar-causa.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/11-parar-de-pagar-vazamento.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/12-proprietario-trocar-fechadura.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/13-fora-do-escopo-comercial.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/14-dados-pessoais-no-texto.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/15-caucao-acima-de-tres-meses.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/16-reajuste-simulacao-sem-indice-real.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/17-multa-atraso-limite-cdc.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/cases/18-golpe-deposito-antecipado.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/01-multa-proporcional.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/02-transferencia-emprego.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/03-duas-garantias.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/04-aluguel-antecipado.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/05-prazo-indeterminado.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/06-reajuste-semestral.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/07-proprietario-despesas.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/08-citacao-despejo.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/09-redigir-clausulas-ilegais.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/10-promessa-ganhar-causa.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/11-parar-de-pagar-vazamento.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/12-proprietario-trocar-fechadura.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/13-fora-do-escopo-comercial.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/14-dados-pessoais-no-texto.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/15-caucao-acima-de-tres-meses.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/16-reajuste-simulacao-sem-indice-real.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/17-multa-atraso-limite-cdc.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/18-golpe-deposito-antecipado.md` | KEEP | solver package data |
| `agents/revisao-contratos/evals/outputs/meta.json` | KEEP | solver package data |
| `agents/revisao-contratos/evals/report.json` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/aluguel-antecipado-e-cobrancas-proibidas.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/benfeitorias-e-preferencia.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/cdc-no-aluguel-e-imobiliaria.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/clausulas-abusivas-comuns.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/despejo-e-inadimplencia.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/despesas-condominio-iptu.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/garantias-locaticias.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/01-disposicoes-gerais-arts-1-a-13.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/02-sublocacao-e-aluguel-arts-14-a-21.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/03-deveres-e-despesas-arts-22-a-26.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/04-preferencia-e-benfeitorias-arts-27-a-36.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/05-garantias-arts-37-a-42.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/06-penalidades-e-nulidades-arts-43-a-45.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/07-locacao-residencial-e-temporada-arts-46-a-50.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/08-acoes-e-despejo-arts-58-a-66.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/lei-8245-inquilinato/09-disposicoes-finais-arts-79-e-85.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/multa-moratoria-e-juros.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/multa-rescisao-antecipada.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/outras-leis-citadas.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/prazo-30-meses-prorrogacao-e-denuncia.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/reajuste-e-indices.md` | KEEP | solver package data |
| `agents/revisao-contratos/knowledge/vistoria-entrada-saida.md` | KEEP | solver package data |
| `agents/revisao-contratos/locales/pt.json` | KEEP | solver package data |
| `agents/revisao-contratos/manifest.json` | KEEP | solver package data |
| `agents/revisao-contratos/steps/01-contexto.md` | KEEP | solver package data |
| `agents/revisao-contratos/steps/02-leitura.md` | KEEP | solver package data |
| `agents/revisao-contratos/steps/03-calculos.md` | KEEP | solver package data |
| `agents/revisao-contratos/steps/04-negociacao-e-entrega.md` | KEEP | solver package data |
| `agents/revisao-contratos/templates/checklist-vistoria.md` | KEEP | solver package data |
| `agents/revisao-contratos/templates/modelos-de-aviso-e-pedidos.md` | KEEP | solver package data |
| `agents/revisao-contratos/templates/perguntas-para-negociar.md` | KEEP | solver package data |
| `agents/revisao-contratos/templates/tabela-revisao-clausulas.md` | KEEP | solver package data |

## agents/ui-design

| File | Class | Note |
|---|---|---|
| `agents/ui-design/evals/cases/01-contraste-texto-apoio.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/02-texto-grande-definicao.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/03-borda-input.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/04-alvo-toque.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/05-escala-espacamento.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/06-tokens-dtcg.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/07-camadas-tokens.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/08-handoff-estados.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/09-modo-escuro-cinza.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/10-figma-sem-conector.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/11-ferramenta-contraste-borda.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/12-ferramenta-contraste-marca.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/13-recusa-aprovar-sem-calcular.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/14-dtcg-2025-10-style-dictionary.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/15-alvo-de-toque-28px.json` | KEEP | solver package data |
| `agents/ui-design/evals/cases/16-texto-translucido-sobre-foto.json` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/meta.json` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-01-contraste-texto-apoio.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-02-texto-grande-definicao.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-03-borda-input.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-04-alvo-toque.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-05-escala-espacamento.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-06-tokens-dtcg.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-07-camadas-tokens.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-08-handoff-estados.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-09-modo-escuro-cinza.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-10-figma-sem-conector.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-11-ferramenta-contraste-borda.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-12-ferramenta-contraste-marca.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-13-recusa-aprovar-sem-calcular.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-14-dtcg-2025-10-style-dictionary.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-15-alvo-de-toque-28px.md` | KEEP | solver package data |
| `agents/ui-design/evals/outputs/ui-design-16-texto-translucido-sobre-foto.md` | KEEP | solver package data |
| `agents/ui-design/evals/report.json` | KEEP | solver package data |
| `agents/ui-design/knowledge/cor-e-contraste.md` | KEEP | solver package data |
| `agents/ui-design/knowledge/design-tokens.md` | KEEP | solver package data |
| `agents/ui-design/knowledge/espacamento-e-grids.md` | KEEP | solver package data |
| `agents/ui-design/knowledge/figma-conector.md` | KEEP | solver package data |
| `agents/ui-design/knowledge/handoff-e-estados.md` | KEEP | solver package data |
| `agents/ui-design/knowledge/hierarquia-visual.md` | KEEP | solver package data |
| `agents/ui-design/knowledge/tipografia.md` | KEEP | solver package data |
| `agents/ui-design/knowledge/wcag-22-para-design.md` | KEEP | solver package data |
| `agents/ui-design/locales/pt.json` | KEEP | solver package data |
| `agents/ui-design/manifest.json` | KEEP | solver package data |
| `agents/ui-design/steps/01-ler-arquivo-figma.md` | KEEP | solver package data |
| `agents/ui-design/steps/02-auditar.md` | KEEP | solver package data |
| `agents/ui-design/steps/03-tokens.md` | KEEP | solver package data |
| `agents/ui-design/steps/04-handoff.md` | KEEP | solver package data |
| `agents/ui-design/templates/handoff-checklist.md` | KEEP | solver package data |
| `agents/ui-design/templates/tokens.dark.json` | KEEP | solver package data |
| `agents/ui-design/templates/tokens.json` | KEEP | solver package data |

## apps/server

| File | Class | Note |
|---|---|---|
| `apps/server/drizzle.config.ts` | KEEP |  |
| `apps/server/package.json` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/app.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/auth/jwt.ts` | KEEP |  |
| `apps/server/src/auth/person.ts` | KEEP |  |
| `apps/server/src/auth/routes.ts` | PORT | plan §3.3 |
| `apps/server/src/auth/siws.ts` | PORT | plan §3.3 |
| `apps/server/src/chain/index.ts` | PORT | plan §3.3 |
| `apps/server/src/cli/admin-args.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/admin-guard.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/admin.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/approve.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/clean-simulated-resale.ts` | DROP | Solana/resale/x402 maintenance CLI |
| `apps/server/src/cli/images.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/invite.ts` | KEEP |  |
| `apps/server/src/cli/publish.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/reindex.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/retire-escrows.ts` | DROP | Solana/resale/x402 maintenance CLI |
| `apps/server/src/cli/schema.ts` | KEEP |  |
| `apps/server/src/cli/seed.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/suspend.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/cli/validate.ts` | KEEP |  |
| `apps/server/src/cli/x402-setup.ts` | DROP | Solana/resale/x402 maintenance CLI |
| `apps/server/src/creator/routes.ts` | KEEP |  |
| `apps/server/src/db/index.ts` | KEEP |  |
| `apps/server/src/db/migrate.ts` | KEEP |  |
| `apps/server/src/db/migrations/0000_init.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0001_review_fixes.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0002_verifier_sessions.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0003_front_integration.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0004_milestone_verify.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0005_pix_charges.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0006_trial_limits.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0007_agent_search_vectors.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0008_review_drafts_batches_indexer.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0009_escrow_v2_deadline_fee.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0010_platform_status.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0011_agent_review_images.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0012_resale_listings.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0013_listings_sold_unique.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0014_x402_orders.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0015_agents_max_licenses.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0016_creator_submissions.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0017_submission_attempts.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0018_package_reviews_no_truncate.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0019_telegram_link.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/0020_agent_translations.sql` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0000_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0001_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0002_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0003_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0004_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0005_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0006_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0007_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0008_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0009_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0010_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0011_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0012_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0013_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0014_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0015_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0016_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0017_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0018_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0019_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/0020_snapshot.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/migrations/meta/_journal.json` | DROP | replaced by one fresh baseline migration (phase 4) |
| `apps/server/src/db/schema.ts` | PORT | new baseline schema (plan §3.7) |
| `apps/server/src/env.ts` | PORT | plan §3.3 |
| `apps/server/src/images/cloudinary.ts` | KEEP |  |
| `apps/server/src/images/process.ts` | KEEP |  |
| `apps/server/src/images/refs.ts` | KEEP |  |
| `apps/server/src/images/seed-art.ts` | KEEP |  |
| `apps/server/src/images/store.ts` | KEEP |  |
| `apps/server/src/index.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/indexer/amounts.ts` | PORT | eth_getLogs poller (D9) |
| `apps/server/src/indexer/approved-version.ts` | KEEP | pure helpers |
| `apps/server/src/indexer/escrow-status.ts` | KEEP | pure helpers |
| `apps/server/src/indexer/mirror.ts` | PORT | eth_getLogs poller (D9) |
| `apps/server/src/indexer/poller.ts` | PORT | eth_getLogs poller (D9) |
| `apps/server/src/indexer/processor.ts` | PORT | eth_getLogs poller (D9) |
| `apps/server/src/indexer/resale-mirror.ts` | PORT | copied under its old name; phase 4 keeps only the license-row helpers and renames it |
| `apps/server/src/indexer/retry-policy.ts` | KEEP | pure helpers |
| `apps/server/src/indexer/sync.ts` | PORT | eth_getLogs poller (D9) |
| `apps/server/src/jobs.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/knowledge/chunk.ts` | KEEP |  |
| `apps/server/src/knowledge/embeddings.ts` | KEEP |  |
| `apps/server/src/knowledge/file-rules.ts` | KEEP |  |
| `apps/server/src/knowledge/ingest.ts` | KEEP |  |
| `apps/server/src/knowledge/quota.ts` | KEEP |  |
| `apps/server/src/knowledge/search-rules.ts` | KEEP |  |
| `apps/server/src/knowledge/search.ts` | KEEP |  |
| `apps/server/src/lib/crypto.ts` | KEEP |  |
| `apps/server/src/lib/http.ts` | KEEP |  |
| `apps/server/src/mcp/agent-text.ts` | PORT | plan §3.3 |
| `apps/server/src/mcp/guides.ts` | KEEP |  |
| `apps/server/src/mcp/preflight.ts` | KEEP |  |
| `apps/server/src/mcp/routes.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/mcp/tools.ts` | PORT | plan §3.3 |
| `apps/server/src/memory/crypto.ts` | PORT | plan §3.3 |
| `apps/server/src/memory/rules.ts` | KEEP |  |
| `apps/server/src/modules.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/notify/telegram.ts` | KEEP |  |
| `apps/server/src/oauth/page.ts` | PORT | plan §3.3 |
| `apps/server/src/oauth/routes.ts` | PORT | plan §3.3 |
| `apps/server/src/oauth/rules.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/pix/credit.ts` | DROP | Pix no longer credits test tokens to the buyer (D10) |
| `apps/server/src/pix/mercadopago.ts` | KEEP | Pix as pix-intermediated PaymentProvider (D10) |
| `apps/server/src/pix/routes.ts` | PORT | Pix as pix-intermediated PaymentProvider (D10) |
| `apps/server/src/pix/rules.ts` | KEEP | Pix as pix-intermediated PaymentProvider (D10) |
| `apps/server/src/publish/admin-rules.ts` | KEEP |  |
| `apps/server/src/publish/admin.ts` | KEEP |  |
| `apps/server/src/publish/approval-rules.ts` | KEEP |  |
| `apps/server/src/publish/approve.ts` | KEEP |  |
| `apps/server/src/publish/catalog-rules.ts` | KEEP |  |
| `apps/server/src/publish/catalog.ts` | KEEP |  |
| `apps/server/src/publish/chain-port.ts` | PORT | plan §3.3 |
| `apps/server/src/publish/cli-args.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/publish/finalize.ts` | KEEP |  |
| `apps/server/src/publish/fs.ts` | KEEP |  |
| `apps/server/src/publish/reconcile.ts` | PORT | plan §3.3 |
| `apps/server/src/publish/routes.ts` | KEEP |  |
| `apps/server/src/publish/suspend.ts` | KEEP |  |
| `apps/server/src/publish/tx.ts` | PORT | plan §3.3 |
| `apps/server/src/review/diff.ts` | KEEP |  |
| `apps/server/src/review/files.ts` | KEEP |  |
| `apps/server/src/review/hash.ts` | KEEP |  |
| `apps/server/src/review/scans.ts` | KEEP |  |
| `apps/server/src/runtime/access-rules.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/runtime/access.ts` | PORT | plan §3.3 |
| `apps/server/src/runtime/agent-ids.ts` | KEEP |  |
| `apps/server/src/runtime/availability.ts` | KEEP |  |
| `apps/server/src/runtime/differentiators.ts` | KEEP |  |
| `apps/server/src/runtime/engine.ts` | PORT | plan §3.3 |
| `apps/server/src/runtime/guarantee-text.ts` | KEEP |  |
| `apps/server/src/runtime/guarantees.ts` | KEEP |  |
| `apps/server/src/runtime/manifest.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/runtime/memory-access.ts` | KEEP |  |
| `apps/server/src/runtime/package-loader.ts` | KEEP |  |
| `apps/server/src/runtime/package-paths.ts` | KEEP |  |
| `apps/server/src/runtime/packages.ts` | KEEP |  |
| `apps/server/src/runtime/platform-agents.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/runtime/session-rules.ts` | KEEP |  |
| `apps/server/src/runtime/templates.ts` | KEEP |  |
| `apps/server/src/runtime/tool-fns.ts` | KEEP |  |
| `apps/server/src/runtime/tools.ts` | KEEP |  |
| `apps/server/src/runtime/trial.ts` | KEEP |  |
| `apps/server/src/runtime/validate-package-tool.ts` | KEEP |  |
| `apps/server/src/runtime/validate/codes.ts` | KEEP |  |
| `apps/server/src/runtime/validate/frontmatter.ts` | KEEP |  |
| `apps/server/src/runtime/validate/index.ts` | KEEP |  |
| `apps/server/src/runtime/validate/input.ts` | KEEP |  |
| `apps/server/src/runtime/validate/json-schema.ts` | KEEP |  |
| `apps/server/src/runtime/validate/schema-v1.ts` | KEEP |  |
| `apps/server/src/runtime/validate/text-scans.ts` | KEEP |  |
| `apps/server/src/sodax/client.ts` | DROP | SODAX |
| `apps/server/src/sodax/routes.ts` | DROP | SODAX |
| `apps/server/src/store/catalog.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/delivery-rules.ts` | KEEP |  |
| `apps/server/src/store/escrow.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/fresh-price.ts` | KEEP |  |
| `apps/server/src/store/fx.ts` | KEEP |  |
| `apps/server/src/store/help-rules.ts` | KEEP |  |
| `apps/server/src/store/help.ts` | KEEP |  |
| `apps/server/src/store/image-rules.ts` | KEEP |  |
| `apps/server/src/store/images.ts` | KEEP |  |
| `apps/server/src/store/lang-rules.ts` | KEEP |  |
| `apps/server/src/store/license-review.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/mappers.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/me.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/pause-gate.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/pause-rules.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/profile.ts` | KEEP |  |
| `apps/server/src/store/purchase-guards.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/purchase-rules.ts` | KEEP |  |
| `apps/server/src/store/resale-rules.ts` | DROP | resale |
| `apps/server/src/store/resale.ts` | DROP | resale |
| `apps/server/src/store/review-rules.ts` | KEEP |  |
| `apps/server/src/store/routes.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/simulation-gate.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/supply-rules.ts` | KEEP |  |
| `apps/server/src/store/supply.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/store/tx-build.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/src/submissions/admin-routes.ts` | KEEP |  |
| `apps/server/src/submissions/cleanup-rules.ts` | KEEP |  |
| `apps/server/src/submissions/cleanup.ts` | KEEP |  |
| `apps/server/src/submissions/lookup.ts` | KEEP |  |
| `apps/server/src/submissions/notify.ts` | KEEP |  |
| `apps/server/src/submissions/paths.ts` | KEEP |  |
| `apps/server/src/submissions/process.ts` | KEEP |  |
| `apps/server/src/submissions/review.ts` | KEEP |  |
| `apps/server/src/submissions/rules.ts` | KEEP |  |
| `apps/server/src/submissions/upload.ts` | KEEP |  |
| `apps/server/src/submissions/zip.ts` | KEEP |  |
| `apps/server/src/telegram/api.ts` | KEEP |  |
| `apps/server/src/telegram/client.ts` | KEEP |  |
| `apps/server/src/telegram/link-rules.ts` | KEEP |  |
| `apps/server/src/telegram/link-store.ts` | KEEP |  |
| `apps/server/src/telegram/poller.ts` | KEEP |  |
| `apps/server/src/verifier/deliverables.ts` | PORT | plan §3.3 |
| `apps/server/src/verifier/install.ts` | KEEP |  |
| `apps/server/src/verifier/lock.ts` | KEEP |  |
| `apps/server/src/verifier/preview.ts` | KEEP |  |
| `apps/server/src/verifier/report.ts` | KEEP |  |
| `apps/server/src/verifier/safe-read.ts` | KEEP |  |
| `apps/server/src/verifier/sandbox.ts` | KEEP |  |
| `apps/server/src/worker/index.ts` | KEEP |  |
| `apps/server/src/x402/facilitator.ts` | DROP | replaced by apps/server/src/agent-pay (MPP, D4) |
| `apps/server/src/x402/mint.ts` | DROP | replaced by apps/server/src/agent-pay (MPP, D4) |
| `apps/server/src/x402/orders.ts` | DROP | replaced by apps/server/src/agent-pay (MPP, D4) |
| `apps/server/src/x402/reconcile.ts` | DROP | replaced by apps/server/src/agent-pay (MPP, D4) |
| `apps/server/src/x402/refund.ts` | DROP | replaced by apps/server/src/agent-pay (MPP, D4) |
| `apps/server/src/x402/routes.ts` | DROP | replaced by apps/server/src/agent-pay (MPP, D4) |
| `apps/server/src/x402/rules.ts` | DROP | replaced by apps/server/src/agent-pay (MPP, D4) |
| `apps/server/test/admin-args.test.ts` | KEEP |  |
| `apps/server/test/admin-guard.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/agent-auth.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/agent-tools.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/creator-fixes.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/creator-fixes.test.ts` | KEEP |  |
| `apps/server/test/env-mainnet.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/guarantee.test.ts` | KEEP |  |
| `apps/server/test/help.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/help.test.ts` | KEEP |  |
| `apps/server/test/helpers/fake-env.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/helpers/fake-publish-chain.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/helpers/repo-agents.ts` | KEEP |  |
| `apps/server/test/helpers/zip-builder.ts` | KEEP |  |
| `apps/server/test/images.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/images.test.ts` | KEEP |  |
| `apps/server/test/indexer-pure.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/knowledge-rules.test.ts` | KEEP |  |
| `apps/server/test/knowledge.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/locales.test.ts` | KEEP |  |
| `apps/server/test/memory-rules.test.ts` | KEEP |  |
| `apps/server/test/memory.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/oauth.test.ts` | KEEP |  |
| `apps/server/test/package-sources.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/packages-refresh.test.ts` | KEEP |  |
| `apps/server/test/packages.test.ts` | KEEP |  |
| `apps/server/test/pause-rules.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/person.test.ts` | KEEP |  |
| `apps/server/test/pix-rules.test.ts` | KEEP |  |
| `apps/server/test/platform-agent.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/platform-agents.test.ts` | KEEP |  |
| `apps/server/test/platform-status.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/platform-status.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/publish-cli.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/publish-fs.test.ts` | KEEP |  |
| `apps/server/test/publish-rules.test.ts` | KEEP |  |
| `apps/server/test/publish.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/purchase-guards.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/resale-rules.test.ts` | DROP | tests for dropped features (agent-pay/payments tests written fresh) |
| `apps/server/test/resale.db.test.ts` | DROP | tests for dropped features (agent-pay/payments tests written fresh) |
| `apps/server/test/retired-access.test.ts` | KEEP |  |
| `apps/server/test/review-diff.test.ts` | KEEP |  |
| `apps/server/test/review-hash.test.ts` | KEEP |  |
| `apps/server/test/review-scans.test.ts` | KEEP |  |
| `apps/server/test/review.test.ts` | KEEP |  |
| `apps/server/test/seed-art.test.ts` | KEEP |  |
| `apps/server/test/session.test.ts` | KEEP |  |
| `apps/server/test/simulation-gate.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/sodax.test.ts` | DROP | tests for dropped features (agent-pay/payments tests written fresh) |
| `apps/server/test/submission-rules.test.ts` | KEEP |  |
| `apps/server/test/submission-zip.test.ts` | KEEP |  |
| `apps/server/test/submission.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/supply-rules.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/supply.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/telegram-link-route.test.ts` | KEEP |  |
| `apps/server/test/telegram-link-rules.test.ts` | KEEP |  |
| `apps/server/test/telegram-link.db.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/templates.test.ts` | KEEP |  |
| `apps/server/test/tools.test.ts` | KEEP |  |
| `apps/server/test/trial-knowledge-coverage.test.ts` | KEEP |  |
| `apps/server/test/trial.test.ts` | KEEP |  |
| `apps/server/test/validate-fixtures.ts` | KEEP |  |
| `apps/server/test/validate-package-tool.test.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/server/test/validate-third-party.test.ts` | KEEP |  |
| `apps/server/test/validate.test.ts` | KEEP |  |
| `apps/server/test/verifier.test.ts` | KEEP |  |
| `apps/server/test/x402-env.test.ts` | DROP | tests for dropped features (agent-pay/payments tests written fresh) |
| `apps/server/test/x402-orders.db.test.ts` | DROP | tests for dropped features (agent-pay/payments tests written fresh) |
| `apps/server/test/x402-rules.test.ts` | DROP | tests for dropped features (agent-pay/payments tests written fresh) |
| `apps/server/tsconfig.json` | KEEP |  |

## apps/web

| File | Class | Note |
|---|---|---|
| `apps/web/.gitignore` | KEEP |  |
| `apps/web/AGENTS.md` | KEEP |  |
| `apps/web/CLAUDE.md` | KEEP |  |
| `apps/web/README.md` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/account.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/admin.json` | KEEP |  |
| `apps/web/messages/en/catalog.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/checkout.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/common.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/connect.json` | KEEP |  |
| `apps/web/messages/en/creator.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/devkit.json` | KEEP |  |
| `apps/web/messages/en/errors.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/format.json` | KEEP |  |
| `apps/web/messages/en/home.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/install.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/en/resale.json` | DROP | resale strings |
| `apps/web/messages/en/submissions.json` | KEEP |  |
| `apps/web/messages/pt/account.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/pt/admin.json` | KEEP |  |
| `apps/web/messages/pt/catalog.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/pt/checkout.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/pt/common.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/pt/connect.json` | KEEP |  |
| `apps/web/messages/pt/creator.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/pt/devkit.json` | KEEP |  |
| `apps/web/messages/pt/errors.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/pt/format.json` | KEEP |  |
| `apps/web/messages/pt/home.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/pt/install.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/messages/pt/resale.json` | DROP | resale strings |
| `apps/web/messages/pt/submissions.json` | KEEP |  |
| `apps/web/next.config.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/web/package.json` | PORT | chain/payment/auth text or imports to port |
| `apps/web/scripts/check-messages.mjs` | KEEP |  |
| `apps/web/src/app/[locale]/[...rest]/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/admin/not-found.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/admin/reviews/[id]/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/admin/reviews/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/checkout/done/page.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/app/[locale]/checkout/page.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/app/[locale]/connect/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/creator/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/creator/private-withdraw/page.tsx` | DROP | resale / Cloak pages |
| `apps/web/src/app/[locale]/creator/publish/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/creator/submissions/[id]/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/creator/submissions/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/creators/[id]/not-found.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/creators/[id]/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/dev/kit/Kit.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/dev/kit/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/guarantees/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/install/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/layout.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/library/layout.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/library/memories/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/library/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/not-found.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/page.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/app/[locale]/profile/page.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/resale/page.tsx` | DROP | resale / Cloak pages |
| `apps/web/src/app/[locale]/solvers/[slug]/not-found.tsx` | KEEP |  |
| `apps/web/src/app/[locale]/solvers/[slug]/page.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/app/favicon.ico` | KEEP |  |
| `apps/web/src/app/icon.svg` | KEEP |  |
| `apps/web/src/components/account/EscrowCard.tsx` | KEEP |  |
| `apps/web/src/components/account/Guarantees.tsx` | KEEP |  |
| `apps/web/src/components/account/LibraryShell.tsx` | KEEP |  |
| `apps/web/src/components/account/Licenses.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/account/Memories.tsx` | KEEP |  |
| `apps/web/src/components/account/Profile.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/account/TrialsSection.tsx` | KEEP |  |
| `apps/web/src/components/account/shared.tsx` | KEEP |  |
| `apps/web/src/components/admin/AdminGate.tsx` | KEEP |  |
| `apps/web/src/components/admin/ReviewDetail.tsx` | KEEP |  |
| `apps/web/src/components/admin/ReviewQueue.tsx` | KEEP |  |
| `apps/web/src/components/catalog/AgentCard.tsx` | KEEP |  |
| `apps/web/src/components/catalog/AgentSections.tsx` | KEEP |  |
| `apps/web/src/components/catalog/BuyBox.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/catalog/CategoryExplorer.tsx` | KEEP |  |
| `apps/web/src/components/catalog/Gallery.tsx` | KEEP |  |
| `apps/web/src/components/catalog/PlatformBits.tsx` | KEEP |  |
| `apps/web/src/components/catalog/ReviewBox.tsx` | KEEP |  |
| `apps/web/src/components/catalog/SearchHero.tsx` | KEEP |  |
| `apps/web/src/components/catalog/SupplyTag.tsx` | KEEP |  |
| `apps/web/src/components/catalog/TrialBlock.tsx` | KEEP |  |
| `apps/web/src/components/catalog/TrialTag.tsx` | KEEP |  |
| `apps/web/src/components/catalog/cluster.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/catalog/data.ts` | KEEP |  |
| `apps/web/src/components/catalog/eval-text.ts` | KEEP |  |
| `apps/web/src/components/checkout/AgentMissing.tsx` | KEEP |  |
| `apps/web/src/components/checkout/CheckoutView.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/checkout/DoneView.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/checkout/FakeQr.tsx` | KEEP |  |
| `apps/web/src/components/checkout/HelpDialog.tsx` | KEEP |  |
| `apps/web/src/components/checkout/InstallView.tsx` | KEEP |  |
| `apps/web/src/components/checkout/ListingMissing.tsx` | DROP | SODAX / resale checkout |
| `apps/web/src/components/checkout/PixPanel.tsx` | KEEP |  |
| `apps/web/src/components/checkout/SodaxPanel.tsx` | DROP | SODAX / resale checkout |
| `apps/web/src/components/checkout/SodaxQuote.tsx` | DROP | SODAX / resale checkout |
| `apps/web/src/components/checkout/checkout.module.css` | KEEP |  |
| `apps/web/src/components/checkout/loadAgent.ts` | KEEP |  |
| `apps/web/src/components/checkout/util.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/connect/ConnectView.tsx` | KEEP |  |
| `apps/web/src/components/creator/CoSign.tsx` | KEEP |  |
| `apps/web/src/components/creator/CreatorHead.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/creator/CreatorProfileForm.tsx` | KEEP |  |
| `apps/web/src/components/creator/DailyChart.tsx` | KEEP |  |
| `apps/web/src/components/creator/Dashboard.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/creator/OpenSubmissions.tsx` | KEEP |  |
| `apps/web/src/components/creator/PrivateWithdraw.tsx` | DROP | resale / Cloak UI |
| `apps/web/src/components/creator/PublishFlow.tsx` | KEEP |  |
| `apps/web/src/components/creator/ResaleSoon.tsx` | DROP | resale / Cloak UI |
| `apps/web/src/components/creator/SubmissionDetail.tsx` | KEEP |  |
| `apps/web/src/components/creator/SubmissionParts.tsx` | KEEP |  |
| `apps/web/src/components/creator/Submissions.tsx` | KEEP |  |
| `apps/web/src/components/creator/TelegramLinkPanel.tsx` | KEEP |  |
| `apps/web/src/components/creator/ZipUploader.tsx` | KEEP |  |
| `apps/web/src/components/creator/creator.module.css` | KEEP |  |
| `apps/web/src/components/layout/Footer.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/layout/Header.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/components/layout/LocaleSwitcher.tsx` | KEEP |  |
| `apps/web/src/components/layout/SwitchAccount.tsx` | KEEP |  |
| `apps/web/src/components/layout/ThemeToggle.tsx` | KEEP |  |
| `apps/web/src/components/resale/ListLicenseDialog.tsx` | DROP | resale UI |
| `apps/web/src/components/resale/ResaleMarket.tsx` | DROP | resale UI |
| `apps/web/src/components/resale/ResaleRow.tsx` | DROP | resale UI |
| `apps/web/src/components/resale/TxErrorNotice.tsx` → `apps/web/src/components/ui/TxErrorNotice.tsx` | KEEP | moved to components/ui/TxErrorNotice.tsx |
| `apps/web/src/components/ui/Ago.tsx` | KEEP |  |
| `apps/web/src/components/ui/AuthGate.tsx` | KEEP |  |
| `apps/web/src/components/ui/Button.tsx` | KEEP |  |
| `apps/web/src/components/ui/Card.tsx` | KEEP |  |
| `apps/web/src/components/ui/Chip.tsx` | KEEP |  |
| `apps/web/src/components/ui/ClampedText.tsx` | KEEP |  |
| `apps/web/src/components/ui/Dialog.tsx` | KEEP |  |
| `apps/web/src/components/ui/Empty.tsx` | KEEP |  |
| `apps/web/src/components/ui/Icon.tsx` | KEEP |  |
| `apps/web/src/components/ui/Lightbox.tsx` | KEEP |  |
| `apps/web/src/components/ui/Price.tsx` | KEEP |  |
| `apps/web/src/components/ui/Spinner.tsx` | KEEP |  |
| `apps/web/src/components/ui/Stars.tsx` | KEEP |  |
| `apps/web/src/components/ui/Tabs.tsx` | KEEP |  |
| `apps/web/src/components/ui/TechCard.tsx` | KEEP |  |
| `apps/web/src/components/ui/Tile.tsx` | KEEP |  |
| `apps/web/src/components/ui/Toast.tsx` | KEEP |  |
| `apps/web/src/components/ui/Untrusted.tsx` | KEEP |  |
| `apps/web/src/components/ui/icons.ts` | KEEP |  |
| `apps/web/src/components/ui/index.ts` | KEEP |  |
| `apps/web/src/i18n/namespaces.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/i18n/navigation.ts` | KEEP |  |
| `apps/web/src/i18n/request.ts` | KEEP |  |
| `apps/web/src/i18n/routing.ts` | KEEP |  |
| `apps/web/src/lib/api.ts` | KEEP |  |
| `apps/web/src/lib/cloak/config.ts` | DROP | Cloak |
| `apps/web/src/lib/cloak/history.ts` | DROP | Cloak |
| `apps/web/src/lib/cloak/withdraw.ts` | DROP | Cloak |
| `apps/web/src/lib/differentiators.ts` | KEEP |  |
| `apps/web/src/lib/error-text.ts` | KEEP |  |
| `apps/web/src/lib/eval-label.ts` | KEEP |  |
| `apps/web/src/lib/explorer.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/lib/format-server.ts` | KEEP |  |
| `apps/web/src/lib/format.ts` | KEEP |  |
| `apps/web/src/lib/hooks.ts` | KEEP |  |
| `apps/web/src/lib/image-compress.ts` | KEEP |  |
| `apps/web/src/lib/local-text.ts` | KEEP |  |
| `apps/web/src/lib/session.tsx` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/lib/style.ts` | KEEP |  |
| `apps/web/src/lib/submissions-ui.ts` | KEEP |  |
| `apps/web/src/lib/tx.ts` | PORT | chain/payment/auth text or imports to port |
| `apps/web/src/lib/wallet/dev.ts` | PORT | Privy EVM on Tempo; dev wallet = viem local account |
| `apps/web/src/lib/wallet/index.ts` | PORT | Privy EVM on Tempo; dev wallet = viem local account |
| `apps/web/src/lib/wallet/privy.tsx` | PORT | Privy EVM on Tempo; dev wallet = viem local account |
| `apps/web/src/lib/wallet/types.ts` | PORT | Privy EVM on Tempo; dev wallet = viem local account |
| `apps/web/src/proxy.ts` | KEEP |  |
| `apps/web/src/styles/app.css` | KEEP |  |
| `apps/web/src/styles/sv.css` | PORT | chain/payment/auth text or imports to port |
| `apps/web/start.mjs` | KEEP |  |
| `apps/web/tsconfig.json` | KEEP |  |

## design

| File | Class | Note |
|---|---|---|
| `design/WEB_SPEC.md` | PORT | chain/payment/auth text or imports to port |
| `design/mock-data.js` | PORT | chain/payment/auth text or imports to port |
| `design/solver-lib.js` | PORT | chain/payment/auth text or imports to port |

## design/screens

| File | Class | Note |
|---|---|---|
| `design/screens/checkout-com-garantia-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/checkout-com-garantia.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/checkout-licenca.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/compra-concluida-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/compra-concluida.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/especialista-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/especialista.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/garantias-em-andamento-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/garantias-em-andamento.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/home-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/home-escuro.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/home.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/instalacao-guiada-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/instalacao-guiada.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/mercado-de-revenda-celular.html` | DROP | resale mock |
| `design/screens/mercado-de-revenda.html` | DROP | resale mock |
| `design/screens/minha-biblioteca-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/minha-biblioteca.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/minhas-memorias-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/minhas-memorias.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/painel-do-criador-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/painel-do-criador.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/perfil-de-criador-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/perfil-de-criador.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/perfil-e-reputacao-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/perfil-e-reputacao.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/publicar-especialista-celular.html` | PORT | chain/payment/auth text or imports to port |
| `design/screens/publicar-especialista.html` | PORT | chain/payment/auth text or imports to port |

## design/screenshots

| File | Class | Note |
|---|---|---|
| `design/screenshots/01-home.png` | KEEP |  |
| `design/screenshots/02-busca.png` | KEEP |  |
| `design/screenshots/03-especialista.png` | KEEP |  |
| `design/screenshots/03b-detalhes-tecnicos.png` | KEEP |  |
| `design/screenshots/04-instalacao.png` | KEEP |  |
| `design/screenshots/05-checkout-licenca.png` | KEEP |  |
| `design/screenshots/06-pix.png` | KEEP |  |
| `design/screenshots/07-concluido.png` | KEEP |  |
| `design/screenshots/08-biblioteca.png` | KEEP |  |
| `design/screenshots/09-checkout-garantia.png` | KEEP |  |
| `design/screenshots/10-garantia-concluida.png` | KEEP |  |
| `design/screenshots/11-garantias.png` | KEEP |  |
| `design/screenshots/12-perfil.png` | KEEP |  |
| `design/screenshots/13-menu-conta.png` | KEEP |  |
| `design/screenshots/14-escuro-especialista.png` | KEEP |  |
| `design/screenshots/15-escuro-biblioteca.png` | KEEP |  |
| `design/screenshots/16-celular-home.png` | KEEP |  |
| `design/screenshots/17-celular-instalacao.png` | KEEP |  |
| `design/screenshots/18-celular-checkout-garantia.png` | KEEP |  |
| `design/screenshots/19-celular-trocar-carteira.png` | KEEP |  |
| `design/screenshots/checkout-sodax-concluido.png` | DROP | SODAX screenshots |
| `design/screenshots/checkout-sodax-cotacao.png` | DROP | SODAX screenshots |
| `design/screenshots/checkout-sodax-mobile.png` | DROP | SODAX screenshots |
| `design/screenshots/checkout-sodax-pagamento.png` | DROP | SODAX screenshots |

## docs

| File | Class | Note |
|---|---|---|
| `docs/README.md` | PORT | chain/payment/auth text or imports to port |
| `docs/agentes-login.md` → `docs/agent-login.md` | PORT | chain/payment/auth text or imports to port |
| `docs/ci-notes.md` | PORT | chain/payment/auth text or imports to port |
| `docs/cloak-privacidade.md` | DROP | resale/Cloak/devnet/Solana runbooks |
| `docs/concepts-guide.md` | PORT | chain/payment/auth text or imports to port |
| `docs/creator-guide.md` | PORT | chain/payment/auth text or imports to port |
| `docs/criador-solvers.md` | PORT | chain/payment/auth text or imports to port |
| `docs/demo-cloak.md` | DROP | resale/Cloak/devnet/Solana runbooks |
| `docs/deploy-criador-solvers.md` | PORT | chain/payment/auth text or imports to port |
| `docs/deploy-devnet-x402-teto.md` | DROP | resale/Cloak/devnet/Solana runbooks |
| `docs/design-governance-v2.md` | DROP | resale/Cloak/devnet/Solana runbooks |
| `docs/devnet-upgrade.md` | DROP | resale/Cloak/devnet/Solana runbooks |
| `docs/guia-conceitos.md` | PORT | chain/payment/auth text or imports to port |
| `docs/licencas-limitadas.md` → `docs/license-cap.md` | PORT | chain/payment/auth text or imports to port |
| `docs/mainnet-runbook.md` | DROP | resale/Cloak/devnet/Solana runbooks |
| `docs/plano-i18n.md` | PORT | chain/payment/auth text or imports to port |
| `docs/resale.md` | DROP | resale/Cloak/devnet/Solana runbooks |
| `docs/x402-agentes.md` | DROP | plan §3.5 says PORT → agent-payments.md; not copied because its subject (x402) is replaced by MPP (D4); docs/agent-payments.md is written fresh in phase 7 (decision X4) |

## docs/cloak-provas

| File | Class | Note |
|---|---|---|
| `docs/cloak-provas/01-tela-saldos.jpg` | DROP | Cloak evidence files |
| `docs/cloak-provas/02-formulario-plano.jpg` | DROP | Cloak evidence files |
| `docs/cloak-provas/03-etapas-concluidas.jpg` | DROP | Cloak evidence files |
| `docs/cloak-provas/04-solscan-saque.jpg` | DROP | Cloak evidence files |
| `docs/cloak-provas/05-solscan-deposito.jpg` | DROP | Cloak evidence files |
| `docs/cloak-provas/06-relatorio-contador-exemplo.csv` | DROP | Cloak evidence files |
| `docs/cloak-provas/07-relatorio-contador-demo.csv` | DROP | Cloak evidence files |

## docs/teste-manual

| File | Class | Note |
|---|---|---|
| `docs/teste-manual/00-LEIA-ME.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/01-comprador-web.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/02-criador.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/03-api.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/04-conector-mcp.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/05-onchain-ops.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/06-defeitos-e-lacunas.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/07-resta-manual.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/README.md` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/_qa.ts` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/env.qa.example` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/fund.ts` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/init.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/launch-validator.sh` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/mcp-token.ts` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/qa-env.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/smoke-resale-api.ts` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/start-api.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/start-validator.sh` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/start-web.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/status.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/stop-api.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/stop-validator.sh` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/stop-web.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/teardown.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/up.ps1` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |
| `docs/teste-manual/qa-tools/web-dev.mjs` | DROP | Solana-era manual QA scripts (D17); replaced by e2e scripts + docs/qa.md |

## infra

| File | Class | Note |
|---|---|---|
| `infra/.env.example` | PORT | not copied (.env* rule); rewritten in phase 4 with the env list of plan §3.6 |
| `infra/deploy.sh` | PORT | not copied (it deploys to the live server); rewritten in phase 7 with D13 names from the old repo + VPS_GUIDE |
| `infra/ecosystem.config.cjs` | PORT | not copied (it deploys to the live server); rewritten in phase 7 with D13 names from the old repo + VPS_GUIDE |
| `infra/manifest.json` | PORT | not copied (it deploys to the live server); rewritten in phase 7 with D13 names from the old repo + VPS_GUIDE |
| `infra/setup-vps.sh` | PORT | not copied (it deploys to the live server); rewritten in phase 7 with D13 names from the old repo + VPS_GUIDE |
| `infra/worker-run.sh` | PORT | not copied (it deploys to the live server); rewritten in phase 7 with D13 names from the old repo + VPS_GUIDE |

## infra/nginx

| File | Class | Note |
|---|---|---|
| `infra/nginx/solvers` | PORT | not copied (it deploys to the live server); rewritten in phase 7 with D13 names from the old repo + VPS_GUIDE |

## packages/api-client

| File | Class | Note |
|---|---|---|
| `packages/api-client/package.json` | PORT | drop resale x5 + sodax x3, SIWE login, calls-based tx flow (phase 3) |
| `packages/api-client/src/index.ts` | PORT | drop resale x5 + sodax x3, SIWE login, calls-based tx flow (phase 3) |
| `packages/api-client/tsconfig.json` | PORT | drop resale x5 + sodax x3, SIWE login, calls-based tx flow (phase 3) |

## packages/chain

| File | Class | Note |
|---|---|---|
| `packages/chain/package.json` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/chain.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/config-state.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/config-state.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/events.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/events.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/governance.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/index.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/keys.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/program-errors-log.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/program-errors.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/program-errors.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/resale.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/send.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/v2.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/src/x402.test.ts` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |
| `packages/chain/tsconfig.json` | DROP | Solana kit client; the new viem-based packages/chain (stub in phase 1, real in phase 3) reuses only the package name |

## packages/shared

| File | Class | Note |
|---|---|---|
| `packages/shared/package.json` | KEEP | copied unchanged |
| `packages/shared/src/cloak.test.ts` | DROP | Cloak / resale |
| `packages/shared/src/cloak.ts` | DROP | Cloak / resale |
| `packages/shared/src/extras.ts` | PORT | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/index.ts` | PORT | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/locales.test.ts` | KEEP | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/locales.ts` | KEEP | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/publication.ts` | KEEP | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/resale.ts` | DROP | Cloak / resale |
| `packages/shared/src/rules.test.ts` | PORT | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/rules.ts` | PORT | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/schemas.ts` | PORT | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/submissions.ts` | PORT | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/supply.test.ts` | KEEP | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/src/supply.ts` | PORT | PORT per plan §3.2 (Address type, feeSplit/royaltySplit, PaymentProvider, PublicConfig) |
| `packages/shared/tsconfig.json` | KEEP | copied unchanged |

## packages/solvers-client

| File | Class | Note |
|---|---|---|
| `packages/solvers-client/codama.mjs` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/idl/solvers.json` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/package.json` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/agent.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/config.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/credits.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/escrow.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/licenseReview.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/listing.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/pendingAdmin.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/review.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/slashProposal.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/stakeExit.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/supplyCap.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/accounts/userReputation.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/errors/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/errors/solvers.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/adminTransferCancelled.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/adminTransferProposed.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/adminTransferred.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/agentRegistered.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/agentStatusChanged.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/agentVersionUpdated.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/configUpdated.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/creditConsumed.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/creditsBought.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/disputeResolved.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/escrowClosed.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/escrowCreated.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/evalUpdated.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/guardianChanged.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/licenseListed.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/licensePurchased.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/licenseResold.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/listingCancelled.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/milestoneUpdated.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/pauseChanged.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/pricingUpdated.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/reviewSubmitted.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/slashCancelled.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/slashContested.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/slashExecuted.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/slashProposed.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/stakeExitCancelled.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/stakeExitExtended.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/stakeExitRequested.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/stakeSlashed.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/stakeToppedUp.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/stakeWithdrawn.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/supplyCapSet.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/treasuryUpdated.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/events/usageRecorded.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/acceptAdmin.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/approveAgent.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/buyCredits.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/buyListing.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/cancelAdminTransfer.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/cancelListing.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/cancelSlash.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/cancelStakeExit.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/cancelUndelivered.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/closeEscrow.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/consumeCredit.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/contestSlash.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/createEscrow.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/createSupplyCap.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/executeSlash.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/extendStakeExit.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/initializeConfig.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/listLicense.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/markPassed.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/migrateConfig.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/openDispute.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/proposeAdmin.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/proposeSlash.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/purchaseLicense.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/raiseSupplyCap.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/recordUsageBatch.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/registerAgent.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/releaseMilestone.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/requestStakeExit.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/resolveDispute.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/resolveStaleDispute.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/setEval.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/setGuardian.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/setPause.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/setTreasury.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/submitReview.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/submitReviewWithCredits.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/suspendAgent.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/topUpStake.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/updateConfig.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/updatePricing.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/updateVersion.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/instructions/withdrawStake.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/collectionAuthority.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/config.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/credits.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/escrow.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/licenseReview.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/listing.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/marketAuthority.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/pendingAdmin.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/reputation.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/review.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/slashProposal.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/stakeExit.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/stakeVault.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/submitReviewWithCreditsCredits.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/supplyCap.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/pdas/vault.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/programs/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/programs/solvers.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/types/agentStatus.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/types/configParams.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/types/escrowStatus.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/types/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/types/milestoneInput.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/types/milestoneState.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/generated/types/milestoneStatus.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/src/index.ts` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |
| `packages/solvers-client/tsconfig.json` | DROP | Codama client; replaced by packages/contracts-client (@wagmi/cli) |

## programs

| File | Class | Note |
|---|---|---|
| `programs/solvers/Cargo.toml` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/errors.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/events.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/admin.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/agent.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/escrow.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/mod.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/purchase.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/resale.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/review.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/stake.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/instructions/supply.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/lib.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/license.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/src/state.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/tests/fixtures/mpl_core.so` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |
| `programs/solvers/tests/program.rs` | DROP | Anchor program; behaviour ported to Solidity contracts (plan §4) |

## scripts

| File | Class | Note |
|---|---|---|
| `scripts/cloak-demo-api.mjs` | DROP | Cloak demo |
| `scripts/cloak-demo.sh` | DROP | Cloak demo |
| `scripts/package.json` | PORT | chain/payment/auth text or imports to port |
| `scripts/qa-reset.ps1` | PORT | copied with a guard that throws: still targets the previous QA DB (port 5544); retargeted to 5546 in phase 6 |
| `scripts/tsconfig.json` | KEEP |  |

## scripts/chain

| File | Class | Note |
|---|---|---|
| `scripts/chain/backup-devnet.sh` | DROP | Solana validator/deploy shell scripts (replaced by contracts/script/*.s.sol) |
| `scripts/chain/build-program.sh` | DROP | Solana validator/deploy shell scripts (replaced by contracts/script/*.s.sol) |
| `scripts/chain/deploy-devnet.sh` | DROP | Solana validator/deploy shell scripts (replaced by contracts/script/*.s.sol) |
| `scripts/chain/env.sh` | DROP | Solana validator/deploy shell scripts (replaced by contracts/script/*.s.sol) |
| `scripts/chain/local-validator.sh` | DROP | Solana validator/deploy shell scripts (replaced by contracts/script/*.s.sol) |
| `scripts/chain/test-program.sh` | DROP | Solana validator/deploy shell scripts (replaced by contracts/script/*.s.sol) |
| `scripts/chain/upgrade-devnet.sh` | DROP | Solana validator/deploy shell scripts (replaced by contracts/script/*.s.sol) |
| `scripts/chain/upgrade-mainnet-buffer.sh` | DROP | Solana validator/deploy shell scripts (replaced by contracts/script/*.s.sol) |

## scripts/qa

| File | Class | Note |
|---|---|---|
| `scripts/qa/seed-legacy.mts` | PORT | chain/payment/auth text or imports to port |

## scripts/src

| File | Class | Note |
|---|---|---|
| `scripts/src/bootstrap-chain.ts` | DROP | Solana bootstrap / clock shim / resale / SODAX / Cloak scripts |
| `scripts/src/cloak-report.ts` | DROP | Solana bootstrap / clock shim / resale / SODAX / Cloak scripts |
| `scripts/src/cloak-spike.ts` | DROP | Solana bootstrap / clock shim / resale / SODAX / Cloak scripts |
| `scripts/src/cloak-web-flow.ts` | DROP | Solana bootstrap / clock shim / resale / SODAX / Cloak scripts |
| `scripts/src/clock-shim.ts` | DROP | Solana bootstrap / clock shim / resale / SODAX / Cloak scripts |
| `scripts/src/e2e-agent-use.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/e2e-agent.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/e2e-api.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/e2e-creator.ts` | PORT | copied with a guard that throws: still targets the previous QA DB (port 5544); retargeted to 5546 in phase 6 |
| `scripts/src/e2e-full.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/e2e-mcp.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/e2e-pix.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/e2e-purchase.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/e2e-resale.ts` | DROP | Solana bootstrap / clock shim / resale / SODAX / Cloak scripts |
| `scripts/src/e2e-sodax.ts` | DROP | Solana bootstrap / clock shim / resale / SODAX / Cloak scripts |
| `scripts/src/e2e-supply.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/e2e-v2.ts` | DROP | Solana bootstrap / clock shim / resale / SODAX / Cloak scripts |
| `scripts/src/env.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/eval.ts` | KEEP | chain-independent |
| `scripts/src/lib/agent-client.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/lib/qa-package.ts` | KEEP | chain-independent |
| `scripts/src/qa-debug.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/qa-keygen.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/qa-race.ts` | KEEP | chain-independent |
| `scripts/src/qa-worker-resume.ts` | KEEP | chain-independent |
| `scripts/src/smoke-criador.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/smoke-prod-legacy.ts` | PORT | chain/payment/auth text or imports to port |
| `scripts/src/topup.ts` | KEEP |  |

## i18n strings with chain/payment wording (en; pt mirrors the same keys)

Strict match (Solana, devnet, USDC, resale, Cloak, SODAX, x402, Phantom, Solscan, SOL, NFT): 100 strings. Blocks
`checkout.sodax*`, `checkout.listingMissing`, `creator.cloak`, `creator.resale` and the `resale` namespace are DROP; the rest
are PORT in phase 5 (network label, stablecoin symbol from `PublicConfig.paymentToken`, explorer name, Privy/EVM wallet wording).

| Key | Current English text (truncated) |
|---|---|
| `account:licenses.resaleSoon` | License resale coming soon. |
| `account:escrow.explorer` | View the guarantee on the Solana network |
| `account:profile.historyEmpty` | Your purchases, reviews and guarantees show up here, with the record on the Solana network. |
| `account:profile.techText` | Everything shown here is also recorded on the Solana network, and anyone can verify it. |
| `catalog:cluster.mainnet` | Solana (mainnet) |
| `catalog:cluster.devnet` | Solana Devnet (test network) |
| `catalog:cluster.testnet` | Solana Testnet (test network) |
| `catalog:card.orUsdc` | Paid in USDC |
| `catalog:buy.rate` | Charged as {usdc} (1 USDC = $1) |
| `catalog:buy.soldOutResale` | All licenses for this solver have been sold. See if someone is selling a used one. |
| `catalog:buy.soldOutNoResale` | All licenses for this solver have been sold. Anyone who already has a license can resell it once the |
| `catalog:buy.onChain` | License registered on the Solana network, in your name. |
| `catalog:page.perTask` | {usdc} per task |
| `catalog:creator.techText` | Sales and reviews of this creator's solvers are recorded on the Solana network, and anyone can verif |
| `checkout:listingMissing.unavailable.action` | See the resale market |
| `checkout:listingMissing.disabled.title` | Resale isn't open right now |
| `checkout:listingMissing.disabled.text` | The resale market is closed for now. You can still buy a license for a new solver. |
| `checkout:sodaxQuote.balanceSufficient.text` | Your balance already covers this purchase, so you don't need to pay with SODAX. |
| `checkout:sodaxQuote.minNote` | SODAX only accepts swaps of about US$ 1 or more, so the quote uses that minimum. |
| `checkout:sodaxQuote.liveNote` | Live quote from SODAX · updates automatically |
| `checkout:sodaxQuote.consulting` | Fetching the SODAX quote… |
| `checkout:sodaxPanel.label` | Payment with SODAX |
| `checkout:sodaxPanel.demo.text` | No real money moves here. In the real version, you confirm the payment in the wallet of the other ne |
| `checkout:view.back.resale` | Back to the resale market |
| `checkout:view.soldOut.paid` | The last licenses were sold before your purchase finished. The amount you paid has already become a  |
| `checkout:view.pay.pixText` | You pay in Brazilian reais and we convert it to USDC automatically. |
| `checkout:view.pay.walletName` | USDC balance |
| `checkout:view.pay.usedOnly` | When buying a used license, payment is only with USDC balance. |
| `checkout:view.pay.sodaxText` | For people who already have crypto on another network (like Ethereum, Base or Arbitrum). You see the |
| `checkout:view.pay.lowTitle` | Not enough USDC balance |
| `checkout:view.pay.faucetAnyAmount` | USDC |
| `checkout:view.review.titleSodax` | Pay with SODAX |
| `checkout:view.review.listingChanged` | The seller changed the price to {price} ({usdc}). Check the new amount and confirm again. |
| `checkout:view.review.getFaucet` | Get test USDC |
| `checkout:view.summary.usdcPrice` | Price in USDC |
| `checkout:view.summary.rateNote` | Shown in US dollars, 1:1 with USDC. |
| `checkout:view.summary.usedNote` | Used license: the solver's rating is the same, but the seller's memories don't come with it. The cre |
| `checkout:view.toast.balanceCovers.text` | Continuing straight with your USDC balance. |
| `common:nav.resale` | Resale |
| `common:nav.resaleShort` | Resale |
| `common:footer.resale` | Resale marketplace |
| `common:footer.solana` | Licenses recorded on the Solana network |
| `connect:walletHint` | Use Phantom, Solflare or Backpack? <link>Connect with your browser wallet</link>. Note: it's a diffe |
| `creator:dashboard.kpi.royalties` | Resale royalties |
| `creator:dashboard.kpi.royaltiesSub` | from resales made on the marketplace |
| `creator:dashboard.kpi.soonSub` | when the resale marketplace opens |
| `creator:cosign.li.approved` | Price, name and version come from what our team approved ({name} v{version}, {price} USDC). You don' |
| `creator:cosign.li.stake` | The program requires a deposit of {stake} USDC at registration. Your balance: {balance} USDC. |
| `creator:cosign.lowTitle` | Not enough USDC for the deposit |
| `creator:cosign.lowText` | You're short {missing} USDC for the deposit. |
| `creator:cosign.faucet` | Get test USDC |
| `creator:resale.value.own.text` | The permanent license is recorded on the Solana network, in your wallet. |
| `creator:resale.value.creator.title` | The creator earns on every resale on Solvers. |
| `creator:resale.eyebrow` | Resale marketplace |
| `creator:resale.lead` | The permanent license is yours. When the resale marketplace opens, you'll be able to sell the licens |
| `creator:resale.meanwhileText` | Your permanent licenses are already recorded in your wallet. When resale opens, the option to list a |
| `creator:cloak.rpcHint` |  The default read endpoint limits browsers: set NEXT_PUBLIC_CLOAK_RPC_URL. |
| `creator:cloak.solLabel` | SOL (network fees) |
| `creator:cloak.emptyText` | To withdraw, send USDC and about 0.005 SOL (for network fees) to the address above, on the live netw |
| `creator:cloak.amountLabel` | Amount (USDC) |
| `creator:cloak.amountHint` | Minimum 1 USDC. Cloak fee: 0.45 USDC + 0.3%. |
| `creator:cloak.problems.amount_invalid` | Enter an amount in USDC, for example 2 or 2.50. |
| `creator:cloak.problems.amount_too_small` | The minimum amount is 1 USDC. |
| `creator:cloak.problems.amount_too_large` | For safety, private withdrawals are limited to 1,000 USDC at a time while the feature is new. |
| `creator:cloak.problems.usdc_insufficient` | You don't have that USDC balance on the live network. |
| `creator:cloak.problems.sol_insufficient` | You're short on SOL (0.005) on the live network for network fees. |
| `creator:cloak.hides.notHidden` | <b>Not hidden:</b> your sales and revenue (public on purpose), the fact that you use Cloak, the amou |
| `creator:cloak.hides.alpha` | Cloak is new (alpha), the code isn't open source and the audit hasn't been published. Start with sma |
| `devkit:session.faucetAmount` | {amount} USDC |
| `devkit:session.getTestUsdc` | Get test USDC |
| `devkit:session.gotTestUsdc` | You received {amount} in test funds |
| `errors:api.cut_too_high` | The creator's royalty plus the Solvers fee goes over the limit allowed on a resale, so this license  |
| `errors:api.faucet_cooldown` | You or your network already received test USDC recently. Please try again a little later. |
| `errors:api.faucet_daily_cap` | The test USDC faucet reached today's limit. Please try again tomorrow. |
| `errors:api.insufficient_funds` | Your USDC balance doesn't cover this. |
| `errors:api.resale_disabled` | The resale marketplace is closed for now. Please try again later. |
| `errors:api.sodax_rate_limited` | SODAX is getting too many requests. Please try again in a moment. |
| `errors:api.sodax_simulate_disabled` | The test payment is turned off. |
| `errors:api.sodax_source` | We don't recognize that payment option. |
| `errors:api.sodax_unavailable` | We couldn't reach SODAX right now. Please try again in a moment. |
| `errors:tx.insufficient_funds.title` | Not enough USDC |
| `errors:tx.insufficient_funds.text` | Your USDC balance doesn't cover this purchase. |
| `errors:tx.insufficient_funds_amounts.title` | Not enough USDC |
| `errors:tx.insufficient_funds_amounts.text` | You have {balance} USDC and need {needed} USDC. |
| `errors:tx.price_changed_amounts.text` | The solver's price changed from {before} USDC to {now} USDC. Check the new amount and confirm again. |
| `errors:tx.sold_out.text` | All licenses for this solver have been sold. You weren't charged. Current license holders can resell |
| `errors:tx.resale_disabled.title` | Resale isn't open right now |
| `errors:tx.resale_disabled.text` | The resale marketplace is closed for now. Please try again later. |
| `errors:tx.listing_not_found.text` | It was sold, cancelled or changed. Check the other listings on the resale marketplace. |
| `errors:tx.listing_changed_amount.text` | The seller changed the price to {now} USDC. Check the new amount and confirm again. |
| `errors:tx.cut_too_high.text` | The creator's royalty plus the Solvers fee goes over the limit allowed on a resale. |
| `errors:tx.guarantee_limit_amounts.text` | Your current limit for open guarantees is {limit} USDC (you already have {open} USDC in progress). I |
| `errors:tx.faucet_unavailable.title` | Test USDC isn't available right now |
| `errors:cluster.mainnet` | Solana Mainnet |
| `errors:cluster.devnet` | Solana Devnet (test network) |
| `errors:cluster.testnet` | Solana Testnet (test network) |
| `home:ticket.onSolana` | Recorded on the Solana network |
| `install:done.lead.resale` | Your used license is already in your account. All that's left is connecting the solver to your AI. I |
| `install:done.ticket.licenseLineResale` | Used permanent license · version {version} |
| `install:done.review.resaleNote` |  If the previous owner already reviewed with this license, you may not be able to review with it. |

## Environment variables (plan §3.6)

| Change | Variables |
|---|---|
| Remove | `SOLANA_RPC_URL`, `SOLANA_CLUSTER`, `USDC_MINT`, `PRIORITY_FEE_MICROLAMPORTS`, `FEE_PAYER_KEYPAIR`, `VERIFIER_KEYPAIR`, `USAGE_AUTHORITY_KEYPAIR`, `ADMIN_KEYPAIR`, `CUSTODY_KEYPAIR`, `HELIUS_WEBHOOK_SECRET`, `SIWS_DOMAIN`, `RESALE_ENABLED`, `SODAX_*`, `X402_*`, `NEXT_PUBLIC_CLOAK_*` |
| Add | `CHAIN_ID` (42431\|4217\|31337), `RPC_URL`, `RPC_WS_URL?`, `EXPLORER_URL`, `PAYMENT_TOKEN`, `PAYMENT_TOKEN_DECIMALS`, `PAYMENT_TOKEN_SYMBOL`, `DEPLOYMENTS_FILE`, `CONTRACT_*` overrides, `PLATFORM_PRIVATE_KEY`, `RELAY_PRIVATE_KEY`, `VERIFIER_PRIVATE_KEY`, `ADMIN_PRIVATE_KEY?` (mainnet-forbidden), `TREASURY_ADDRESS`, `FEE_PAYER_URL?`, `RELAY_ENABLED`, `RELAY_MAX_GAS_PER_TX`, `RELAY_DAILY_GAS_PER_WALLET`, `INDEXER_CONFIRMATIONS`, `INDEXER_BLOCK_BATCH`, `INDEXER_START_BLOCK`, `SIWE_DOMAINS`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY?`, `FLOAT_LOW_BALANCE_UNITS`, `AGENT_PAY_ENABLED`, `MPP_SECRET_KEY`, `MPP_REALM?`, `AGENT_PAY_MIN_PRICE`, `AGENT_PAY_MAX_PRICE`, `AGENT_PAY_ORDER_TTL_SECS`, `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_ALLOW_DEV_WALLET` |
| Keep | `JWT_SECRET`, `SERVER_KEK`, `DATABASE_URL`, `PUBLIC_API_URL`, `PUBLIC_WEB_URL`, `PORT` (3018), Pix/Mercado Pago vars incl. `PIX_SIMULATE`, Cloudinary, Telegram, knowledge, packages/submissions, `ADMIN_WALLETS`, verifier, escrow/guarantee, `FAUCET_ENABLED` |

## DB columns holding chain data (new baseline, plan §3.7)

`creators.wallet`, `creator_invites.wallet`, `package_submissions.{creator_wallet, register_tx, approve_tx}`,
`package_reviews.reviewer_wallet`, `agent_published_versions.approve_tx`, `agents.{id, creator_id, version_hash, eval_hash,
eval_version_hash (new), price, price_per_use, royalty_bps, status, total_sales, verified_uses, rating_sum, rating_count,
disputes_lost, stake, max_licenses}` (drop `onchain_address`, `collection_address`), `licenses.{id = tokenId, owner_wallet,
original_price (new), version_hash (new), tx_hash}`, `credits.owner_wallet`, `trials.wallet`, `reviews.{author_wallet,
content_hash, version_hash (new)}`, `review_drafts.author_wallet`, `escrows.{id, buyer_wallet, creator_wallet, nonce, total,
fee_bps}` (`closed` removed, D19), `milestones.*`, `user_profiles.wallet`, `user_reputation.wallet`, `usage_events.wallet`,
`usage_batches.{merkle_root, tx_hash}`, `sessions.{wallet, license_id}`, `auth_nonces.wallet`, `oauth_codes.wallet`,
`oauth_tokens.wallet`, `memory_keys.wallet`, `memories.wallet`, `processed_events.{tx_hash, log_index}`,
`indexer_failures.tx_hash`, `kv` (`indexer:evm:<chainId>`), `chain_txs.{tx_hash, wallet, creator_wallet, amounts, block_time}`
(`kind` without resale, with `royalty`), `escalations.wallet`. New tables: `payment_ledger`, `payouts_deferred`, `relay_log`,
`sent_txs`. Dropped: `listings`, `resale_prices`, `x402_orders`, `pix_charges` (folded into `payment_ledger`). Addresses are
`varchar(42)` lowercase, tx hashes `varchar(66)`.

## Purge notes (names that only this file may contain)

- **X2, purge regex.** Mission regex (case-insensitive, substring):
  `solana|anchor|lamport|spl|metaplex|mpl-core|helius|codama|litesvm|base58|bs58|tweetnacl|SIWS|devnet|PDA|cloak|sodax|resale|revenda|@solana`.
  The gate (`node scripts/purge-check.mjs`) uses `\bspl\b`, `\bPDAs?\b` and `\bSIWS\b` for the three short tokens, because
  `spl` ⊂ `display`/`split`/`splice` and `pda` ⊂ `update`/`_update`. `--literal` prints the literal-regex count.
- **X3, Privy transitive packages.** `pnpm why @solana/kit -r` (phase 1): `@privy-io/react-auth 3.48.1` → `x402 0.7.3` →
  `@solana/kit 5.5.1`, `@solana-program/{compute-budget,token,token-2022}`, `wagmi 2.19.5` → `@wagmi/connectors` →
  `@base-org/account` → `@coinbase/cdp-sdk` → `@solana/kit`, `@solana-program/{system,token}`; Privy also declares optional peers
  `@solana/kit`, `@solana-program/{system,token,memo}`. 88 lockfile entries at phase 1.
