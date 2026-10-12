# O guia do Solvers para quem nunca viu uma blockchain

[English](concepts-guide.md) | Português

Estado em 2026-10-11. Tudo roda na **Moderato**, a rede de testes da Tempo, com **dinheiro de teste** (uma stablecoin
distribuída por uma torneira pública, o "faucet"). A mainnet (dinheiro real) está planejada, não está no ar: depende das
decisões do dono listadas em `docs/migration/decisions.md` (entre elas, o token de pagamento). O que é **protótipo ou
ainda não existe** está marcado como "(protótipo)" ou "(planejado)".

Leitura complementar (em inglês): [arquitetura](architecture.md), [economia](economics.md), [royalties](royalties.md),
[pagamentos](payments.md), [pagamentos de agentes](agent-payments.md), [login de agentes](agent-login.md),
[teto de licenças](license-cap.md); em português: [guia do criador](criador-solvers.md).

---

## 1. A história inteira em 6 linhas

1. Um **criador** monta um "especialista" (um Solver): uma pasta de texto com etapas, conhecimento e modelos. Não é um programa, é uma **receita**.
2. O **servidor** guarda a receita e entrega **uma etapa por vez** ao Claude/ChatGPT de quem comprou (por um "conector" chamado MCP). Quem tivesse a receita inteira num arquivo poderia copiá-la de graça; por isso ela fica trancada no servidor.
3. O **comprador** paga em uma **stablecoin de dólar** e recebe uma **licença**: um item digital único (um NFT) que cai na carteira dele. A plataforma paga a taxa da rede.
4. O servidor olha a carteira: "tem licença? então libera."
5. Uma **garantia** significa que o dinheiro fica num cofre até o trabalho passar nos testes combinados antes.
6. **Agentes de IA sem humano** também compram: pagam por HTTP (o Machine Payments Protocol, MPP) ou direto da própria carteira, e a licença cai na carteira deles.

---

## 2. Conceitos de blockchain

| Termo | Em palavras simples | No Solvers |
|---|---|---|
| **Blockchain** | Um caderno gigante que **muitos computadores mantêm sincronizado**. Só se escreve no fim, e ninguém apaga o que já foi escrito. | O caderno é a **Tempo**, uma rede voltada a pagamentos e compatível com as ferramentas do Ethereum (EVM). Rede de testes **Moderato** (chain id 42431) hoje; mainnet (4217) depois. |
| **Por que usar** | Ninguém precisa **acreditar na nossa palavra**: qualquer um confere no caderno quem comprou, quanto o criador recebeu, qual é a nota. | Licenças, avaliações, garantias, stake, teto de licenças, royalty de transferência e reputação. |
| **Carteira** | Seu **endereço** no caderno (como um número de conta) mais uma **chave secreta** que só você tem (como a senha de uma caneta). | O login por e-mail (Privy) **cria uma carteira embutida** (uma conta comum no estilo Ethereum); o usuário nem precisa vê-la. Nas redes de teste existe também a "carteira de desenvolvimento" (uma chave de teste guardada no navegador). |
| **Chave privada / assinatura** | Assinar = provar "fui eu" sem revelar a senha. Sem assinatura ninguém mexe nas suas coisas. | Comprar, avaliar, transferir, abrir disputa: o usuário assina. Entrar também é uma assinatura (**SIWE**, Sign-In With Ethereum, EIP-4361), cujo texto diz que não autoriza pagamento e não custa nada. |
| **Transação** | Uma **frase escrita no caderno**: "Ana paga 10 a Beto". | Toda compra é uma transação: o servidor prepara as chamadas e a carteira do usuário assina. |
| **Transação em lote** | Várias frases escritas **como uma só**: acontecem todas ou nenhuma. | A transação da Tempo leva uma lista de chamadas. Uma compra é `[aprovar o preço, comprar]` numa transação atômica: se a compra falha, a aprovação também é desfeita. |
| **Taxa de rede (gas)** | Cada frase custa uma taxa pequena. A Tempo **não tem moeda própria**: a taxa é paga em stablecoin. | **A plataforma sempre paga**, pelo seu **relay** (um "pagador de taxa" que coassina a sua transação). Usuários e agentes nunca precisam de nada para taxas. A ação mais pesada (uma garantia com 5 etapas) custa alguns centavos no teto da taxa. |
| **Stablecoin (TIP-20)** | Um token digital que vale 1 dólar. TIP-20 é o padrão de token da Tempo (compatível com ERC-20), sempre com **6 casas decimais**. | O preço de tudo. Na Moderato é o **pathUSD** de teste, do faucet público. O token da mainnet ainda é decisão do dono. |
| **Testnet / mainnet** | Testnet = treino com dinheiro de teste. Mainnet = o jogo valendo. | Estamos na Moderato (testnet). |
| **Contrato inteligente** | Um **juiz-robô que mora no caderno**: segue regras escritas em código, e ninguém o suborna. | Seis contratos em `contracts/src` (Solidity): Registry (regras, Solvers, teto), License (os NFTs e o royalty), Credits, Reviews, Escrow (garantias), Staking. |
| **Contrato atualizável** | O juiz-robô pode ser trocado por uma versão nova **no mesmo endereço**, mantendo as gavetas. | Os seis são atualizáveis (UUPS). Só o admin frio atualiza, e os dados guardados **só crescem**: campos novos entram no fim, os existentes nunca mudam de forma. |
| **NFT (ERC-721)** | Um **item digital único com dono registrado** no caderno. | A **licença**. Quem tem a licença tem acesso. |
| **Hash** | Uma **impressão digital** de um arquivo: muda uma letra e muda tudo. | `versionHash` (pacote), `contentHash` (texto da avaliação), `criteriaHash` (testes da garantia), `deliverableHash` (entrega). Só a impressão digital vai para a rede; o texto fica fora. |
| **Evento + indexador** | O contrato "grita" o que aconteceu; o **indexador** lê os gritos e copia para o nosso banco (rápido de consultar). | O servidor pede os eventos novos à rede a cada segundo (`eth_getLogs`), um bloco atrás do topo; não há webhook. O banco é um **espelho**; a verdade é a rede. |
| **Escrow (cofre)** | Um **cofrinho com duas fechaduras**: o dinheiro sai do comprador, fica travado e só sai quando a regra mandar (para o criador ou de volta). | A **garantia** (seção 8). Quem guarda o dinheiro é o contrato `SolversEscrow`; nem a plataforma tira de lá fora das regras. |
| **Stake** | O **depósito de boa-fé** do criador: se trapacear, pode perdê-lo. | O `minStake` é **0 na Moderato**, então ainda não protege ninguém. |
| **Pagamento retido + resgate** | Se uma carteira tem uma regra que recusa dinheiro recebido, o pagamento voltaria. | O contrato **guarda** esse valor para o destinatário (um "pagamento retido") e a venda acontece mesmo assim; o destinatário pega depois com **Resgatar** (Claim). |
| **Raiz de Merkle** | Uma **única impressão digital que resume uma lista inteira** de recibos. | Um lote de usos verificados, a cada 10 min. |
| **Pontos-base (bps)** | Porcentagem em centésimos: 1000 bps = 10%. | Taxa e royalty. |

**O que NÃO está na blockchain** (e você precisa saber dizer com clareza): o **conteúdo** do Solver (etapas, conhecimento), as **memórias** do usuário, as **sessões**, o **texto** das avaliações (só a impressão digital), os textos do catálogo e os preços em reais (Pix). O que **está** lá: dono da licença, preço, vendas, notas, créditos, garantia, stake, versão (hash), nota de avaliação por versão, teto de licenças e reputação.
**Limite honesto:** a licença é do usuário, mas é **o nosso servidor** que libera o conteúdo lendo a carteira. Se o servidor sumisse, o usuário continuaria dono do NFT, mas não teria como rodar o Solver.

---

## 3. Quem é quem

| Quem | O que faz |
|---|---|
| **Criador** | Escreve o pacote, define o preço e a sua parte do royalty, ganha em cada venda e em cada transferência, pode limitar o número de licenças. |
| **Comprador (humano)** | Entra por e-mail (ou com uma carteira), paga, conecta o Claude/ChatGPT ao conector. |
| **Agente autônomo** | Uma IA sem humano, com a própria chave e stablecoin. Compra por MPP ou direto da carteira. |
| **Servidor (plataforma)** | Entrega etapas, conhecimento, ferramentas e memória; prepara transações; patrocina a taxa da rede; indexa a rede. |
| **Chaves do sistema** | `ADMIN` (**fria**, fora do servidor: aprova Solvers, julga disputas, confisca stake, muda a configuração, atualiza os contratos) · `PLATFORM` (servidor: guarda o **caixa** em stablecoin, compra em nome do comprador no Pix e nos pagamentos de agentes, registra o uso) · `VERIFIER` (servidor: marca uma etapa como "passou nos testes", registra notas de avaliação) · `RELAY` (servidor: **só paga taxas**, não tem nenhum papel nos contratos) · `GUARDIAN` (só consegue **ligar** uma pausa) · `TREASURY` (carteira fria que recebe a taxa e o royalty da plataforma). Chaves separadas: um vazamento da chave de taxas não alcança o caixa nem nenhum papel. |
| **Pausa de emergência** | Três chaves: entradas novas (compras, registros), pagamentos (liberação de etapa, decisão de disputa) e transferências de licença. O admin liga ou desliga qualquer uma; um guardião só **liga** entradas/pagamentos (nunca transferências, nunca desliga). As saídas do comprador (abrir disputa, cancelar tarefa não entregue, reembolso de disputa parada) nunca pausam. |

---

## 4. Fluxo do criador

> Guia completo: [criador-solvers.md](criador-solvers.md). O fluxo roda de ponta a ponta numa rede local e foi exercitado uma vez na Moderato (um Solver de teste).

### 4.1 Montando o pacote
A pasta `agents/<slug>/`: `manifest.json` (nome, preço, parte do royalty, etapas, ferramentas, teste grátis, garantia, teto de licenças), `steps/` (um `.md` por etapa, com um checklist "portão"), `knowledge/` (textos que a IA consulta), `templates/`, `evals/` (casos de teste). Formato completo: `PACKAGE_SPEC.pt-BR.md`. Os pacotes são primeiro em inglês, com tradução opcional para o português em `locales/pt.json`.
O criador não precisa escrever tudo à mão: existe o **Criador de Solvers** (`criador-de-solvers`), um **Solver gratuito da plataforma** (só banco de dados, sem blockchain) que, dentro do Claude/ChatGPT do criador, passa por **7 etapas** (promessa, diferenciais, etapas, conhecimento, ferramentas, calibração, evals), consulta o validador do servidor e entrega o ZIP.

### 4.2 Como um pacote passa nos testes (3 camadas)

| Camada | O que faz | Quem decide |
|---|---|---|
| **1. Validador** (estrutura) | Um único esquema no código (zod), **68 códigos** (3 reservados para fases futuras), cada um erro `E` (bloqueia) ou aviso `A`. ZIP sem `..`/links/arquivos gigantes, caminhos presos dentro da pasta, tamanhos, `slug`/versão, preço >= 5, etapas com as seções obrigatórias, conhecimento com fonte e data, **>= 10 casos de avaliação**, **>= 2 de 5 "diferenciais"** provados pelo próprio pacote, terceiros **sem ferramentas, sem garantia, sem categorias reguladas** (Finanças, Jurídico, Saúde). Roda sozinho no upload e também no `cli:validate`. | Máquina (um erro bloqueia o envio) |
| **2. Varreduras** ("é malicioso?") | **Avisos** mostrados ao revisor: Unicode invisível ou bidirecional, HTML/CSS escondido, imagens remotas, frases de injeção de prompt, pedido de dados sensíveis, URLs de envio de dados, **conteúdo copiado de outro pacote publicado**, frases de busca fora do tema, conhecimento vencido. | A máquina avisa, **o humano decide** |
| **3. Evals** ("funciona?") | Casos com checagens simples (`regex`, `contains`, `not_contains`) aplicadas a **respostas geradas antes** com o Solver ativo. Gera o `report.json` (nota em `scoreBps`, 8750 = 87,5%). | Máquina |

**Limites que você precisa saber dizer:** as varreduras são **heurísticas que dá para driblar**; ninguém garante achar uma injeção escondida num trecho entre milhares. A defesa de verdade é **convite + limites + revisão humana de 100% das versões + desligamento rápido**. O servidor **nunca executa código de terceiros**. Nota de desempenho: terceiros **não têm** (só avaliações de compradores); os pacotes da equipe mostram "**teste interno da equipe**", nunca "verificado".

### 4.3 Upload, validação e revisão humana

1. **Convite:** a equipe gera um código `SLV-XXXX-XXXX-XXXX` (`cli:invite create`) e manda por e-mail. Vale uma vez e fica preso à carteira de quem usa.
2. **Perfil:** em `/creator/publish` o criador entra, preenche nome e bio, aceita os termos e digita o código. O contato de escalonamento (Telegram) fica "verificado" quando o criador o vincula com um código de uso único `LINK-XXXXXXXX` enviado ao bot.
3. **Upload do ZIP:** o servidor só **guarda o arquivo e responde na hora**. Limites: ZIP de 50 MB, 150 MB extraído, 2.000 arquivos, 10 MB por arquivo, só `.json/.md/.txt`, **3 envios em andamento** e **5 por dia** por criador.
4. **Worker:** um processo **separado** (`solvers-tempo-worker`, para não derrubar a API) extrai, valida, varre e indexa o conhecimento numa área de **preparo**, retomando de onde parou se reiniciar.
5. **Revisão humana** em `/admin/reviews` (carteiras em `ADMIN_WALLETS`; uma permissão do site que **não assina nada na blockchain**). O revisor vê o resultado do validador, o manifesto, um **diff de todos os arquivos** contra a versão publicada, buscas de teste, varreduras e diferenciais, tudo como texto escapado. Para aprovar, marca o checklist inteiro e escreve um motivo; também pode pedir mudanças, rejeitar ou revogar. Tudo vai para uma **trilha que só aceita inserção**.
6. **Coassinatura:** depois de aprovado, o **criador assina uma transação em lote** na carteira dele (`registerAgent` para um Solver novo, mais a aprovação do stake e o teto quando preciso; `updateVersion` para uma atualização); o relay da plataforma paga a taxa. A plataforma **nunca guarda a chave de um criador**.
7. **Aprovação na rede (só Solver novo):** o dono roda `cli:approve <slug>` com a **chave fria do admin** (`approveAgent`; a taxa é patrocinada, então a chave fria não guarda tokens). Só aprova se o Solver na rede **bater** com a versão aprovada no site. Só então o Solver aparece na vitrine.

**Versão nova:** mesmo `slug`, `version` **maior**, e **passa pela revisão inteira de novo**.
**Trapaça possível e a defesa:** o criador pode chamar `updateVersion`/`updatePricing` **direto na rede**, sem revisão. O indexador compara com as versões aprovadas; se divergirem, marca `unapproved_chain_version`, **continua servindo o pacote aprovado** e **bloqueia as vendas** (`price_in_review`) até a revisão aprovar ou o criador desfazer.

Os Solvers da plataforma (como o Criador de Solvers) **não passam por esse fluxo**: quem decide é uma lista no servidor (`PLATFORM_AGENTS`), não um campo do manifesto, e eles saem pelo `cli:publish`.

### 4.4 O que vai para a blockchain na publicação
- **O criador assina:** `registerAgent` (preço, preço por uso, parte do royalty, impressão digital da versão, link de metadados; o stake é puxado se `minStake > 0`) e, se quiser, `setSupplyCap`.
- **O admin frio assina:** `approveAgent` (sem isso o Solver fica `Pending` e não vende).
- Cada versão nova: `updateVersion` (nova impressão digital). A nota de avaliação fica guardada **por versão**: nunca é apagada, mas uma nota medida numa versão antiga aparece como "não medida para esta versão" até uma nova ser registrada (`setEval`, só pacotes da plataforma).
- O que **não** vai: o pacote, o ZIP, o texto da revisão.

Estados do Solver na rede: `Pending -> Active <-> Suspended`, e `Retired` (o criador pediu para sair; o stake só sai depois de 30 dias).
**Botão de desligar:** `cli:suspend <slug>` faz **as duas coisas**: `platform_status = suspended` no banco (derruba sessões, vitrine e vendas na hora) **e** `suspendAgent` na rede (senão ainda daria para comprar direto pelo contrato). `--resume` desfaz. Um Solver também sai da vitrine sozinho com **média abaixo de 3,5 depois de 10 avaliações** (quem já comprou continua usando).

### 4.5 O dinheiro do criador
Na compra, **na mesma transação**: a taxa da plataforma (10% por padrão, no máximo 20%, arredondada para baixo) vai para a tesouraria e o resto vai **direto para a carteira do criador**. A taxa da rede nunca é descontada de ninguém. Se a carteira do criador recusa pagamentos recebidos, o contrato guarda o valor para ele (Resgatar). Não há reembolso de licença. Cada transferência posterior da licença paga um **royalty** ao criador (seção 9). Detalhes: [economics.md](economics.md).

---

## 5. Fluxo do comprador humano

1. **Entrar:** e-mail pelo Privy (cria uma carteira embutida) ou uma carteira nas redes de teste. Entrar = assinar uma mensagem SIWE -> sessão.
2. **Escolher e pagar:** vitrine -> checkout. Opções: **carteira** (stablecoin) ou **Pix**. Na Moderato o Pix é **simulado** (nenhum banco envolvido). A mainnet recusa simulação, e o Pix fica desligado na mainnet até as perguntas abertas de [payments-open-questions.md](payments-open-questions.md) terem resposta.
3. **Caminho da carteira:** o servidor grava primeiro um registro da compra (`POST /api/purchases/intent`) e devolve as chamadas `[approve, purchaseLicense]` com o **preço que o usuário viu**: se o criador mudar o preço no meio, a compra **falha** (`PriceChanged`) em vez de cobrar outro valor. A carteira assina uma transação em lote; o relay paga a taxa.
4. **O contrato confere e executa tudo ou nada:** o Solver está `Active`? stake >= mínimo? preço >= 5? não está pausado? o teto não foi atingido? quem compra não é o criador? Então divide o pagamento (taxa da plataforma / criador), **cria o NFT na carteira do comprador** e soma a compra à reputação dele.
5. **Evento -> indexador -> banco -> o `list_my_solvers` mostra.** Se o banco ainda não viu, o conector confere direto na rede.

**Caminho do Pix:** uma cobrança Pix compra uma coisa para um comprador. Confirmado o pagamento, a plataforma compra na rede **para o comprador** com o próprio caixa em stablecoin (`purchaseLicenseFor`); o comprador nunca segura a stablecoin. Reenvios do webhook nunca geram uma segunda compra (cada cobrança tem um id de compra que o contrato aceita uma vez só). Detalhes: [payments.md](payments.md).

**Teto de licenças:** o criador pode definir um limite (ex.: 10). O **contrato** bloqueia vendas além dele (`SoldOut`); transferir ou queimar uma licença **não** libera vaga; o criador só consegue **subir** o teto. Nunca prometa "só existirão N": diga "o limite atual é N e ele só pode subir". Detalhes: [license-cap.md](license-cap.md).
**Outras coisas para comprar:** **créditos** (pagar por uso, `buyCredits`; existem na rede e também permitem avaliar) e uma **garantia por tarefa** (seção 8). Hoje o conector libera um Solver por licença, garantia aberta, teste grátis ou Solver da plataforma.

---

## 6. Usando o Solver (conector MCP)

1. **Conectar:** o usuário cola o endereço do conector (`/mcp` na API do Solvers; ainda sem domínio público no ar) no Claude/ChatGPT. O `/mcp` responde 401 -> o cliente descobre o **OAuth** sozinho (registro automático + PKCE) -> abre a página "Conecte sua carteira" -> o usuário assina (SIWE) -> o cliente recebe um token **preso à carteira**.
2. **Ferramentas** (15; a IA chama sozinha): `list_my_solvers`, `find_solver` (busca por significado), `get_purchase_link`, `activate_solver`, `preflight_check`, `next_step`, `search_knowledge`, `run_tool`, `get_memory`, `save_memory`, `forget_memory`, `submit_deliverable`, `escalate_to_creator`, `list_open_guarantees`, `get_template`.
3. **Fluxo:** `activate_solver` confere a licença (ou garantia, ou teste) e abre uma **sessão** -> `preflight_check` (a IA tem as ferramentas exigidas?) -> `next_step` entrega **uma etapa por vez** (com um checklist que a IA precisa cumprir) -> `search_knowledge` (**RAG**, seção 7.1).
4. **Teste grátis:** limites definidos pelo criador no manifesto (usos, etapas, buscas, execuções de ferramenta), contados **por pessoa**: carteiras ligadas ao mesmo e-mail verificado contam como uma. **Agentes não têm teste** (uma carteira nova não custa nada).
5. **Memória e calibração** (seção 7.2): preferências do usuário criptografadas; a chave vem de uma **segunda assinatura** do usuário.
6. **Avaliação** (no site): exige **licença** (ou créditos comprados). Uma licença sustenta **uma** avaliação; o criador não avalia o próprio Solver. O texto fica fora da rede; **só a impressão digital + uma nota de 1 a 5** vão para a rede.
7. **Escalar:** `escalate_to_creator` manda um resumo para o Telegram do criador (o recurso humano).
8. **Registro de uso:** cada uso verificado vira um recibo; a cada 10 min um **lote** registra a contagem + a raiz de Merkle na rede (`recordUsageBatch`).

---

## 7. RAG e calibração (como o especialista "sabe" e "se adapta")

Dois problemas, duas peças. **Nenhuma treina ou altera o modelo de IA** (Claude/ChatGPT continuam exatamente iguais).

| | **RAG** (o que o especialista sabe) | **Calibração** (o que ele sabe sobre você) |
|---|---|---|
| **Analogia** | Uma **biblioteca com bibliotecário**: em vez de decorar tudo, a IA pergunta e recebe só as páginas certas. | Uma **ficha de cliente**: na primeira visita o atendente pergunta o essencial e anota. |
| **De quem é** | Do criador (igual para todo comprador). | Do usuário (uma ficha por carteira **e** por especialista). |
| **Onde fica** | Banco de dados, em trechos com vetores. | Banco de dados, **criptografada** (memória). |
| **Quando age** | Quando a IA chama `search_knowledge`. | No primeiro uso (`get_memory`) e em cada etapa que lê o perfil. |

### 7.1 RAG (Retrieval-Augmented Generation = "consulte antes de responder")

**Por que existe:** a IA não pode receber a base de conhecimento inteira toda vez (caro, lento, e entregaria o produto). Então os textos ficam no servidor e a IA recebe **só 5 trechos** por consulta.

**Preparo (na publicação, uma vez):**
1. O criador escreve textos `.md`/`.txt` em `knowledge/`, cada um com um cabeçalho: título, **fonte**, data da fonte, validade e, opcionalmente, `trial: true` (liberado no teste grátis).
2. O servidor **corta em trechos** de cerca de 2.000 caracteres, respeitando títulos e parágrafos, com cerca de 200 caracteres repetidos entre trechos para não partir uma ideia ao meio.
3. Cada trecho vira um **vetor** (um embedding): 384 números que representam o **significado** do texto. O modelo roda localmente no servidor (`multilingual-e5-small`), sem custo e sem mandar texto a terceiros. Os vetores vão para o Postgres com pgvector.

**No uso:**
1. A IA chama `search_knowledge` com a pergunta. O servidor a transforma em vetor e acha os **5 trechos mais próximos**, só do **Solver e da versão** que o usuário tem.
2. Cada trecho volta com **título, fonte e data**; um vencido volta com o aviso "pode estar desatualizado", e a IA é orientada a **citar a fonte**.
3. Toda resposta leva uma **marca d'água** (uma frase que varia por carteira). É um indício, não uma prova: muitas carteiras dividem a mesma frase.
4. Proteções: uma **cota diária** de buscas (300 por padrão), só arquivos `trial: true` no teste grátis, nada sem acesso.

**Mesma ideia, outro uso:** o `find_solver` e a busca da vitrine também usam vetores (um por Solver e um por frase de busca). Se o modelo não carregou, cai para a busca por palavras do Postgres.

**Limites para saber dizer:** o RAG **acha** trechos, não garante que a IA os use bem; a qualidade depende do que o criador escreveu; a busca por significado pode trazer um trecho parecido mas errado (por isso fonte e data aparecem).

### 7.2 Calibração: um "ajuste fino" sem treinar nada

**Ajuste fino de verdade** = retreinar o modelo com os seus dados. **Não fazemos isso.** Nós **perguntamos na primeira vez, guardamos as respostas e fazemos cada etapa ler a ficha**.

**Como o criador configura:** em `manifest.onboarding`, **de 1 a 5 perguntas**, cada uma com `ask`, `why` (por que se pergunta) e `options` opcionais (de 2 a 6).

**Fluxo no primeiro uso:**
1. O usuário ativa o Solver. O servidor manda a IA chamar `get_memory` **antes da etapa 1**.
2. Ainda não há ficha -> a resposta traz as perguntas. A IA as faz em **no máximo 2 mensagens**, explicando cada uma. **Toda pergunta pode ser pulada.**
3. A IA guarda as respostas (`save_memory`, tipo `profile`). Pulou -> fica registrado como pulado e não pergunta de novo a cada sessão.
4. As etapas seguintes leem o perfil e **adaptam** exemplos e escolhas. O usuário pode pedir para "recalibrar" quando quiser.
5. Além da calibração, a IA só guarda **notas** (até 30) quando o **usuário pede**.

**Regras de segurança:** o perfil é **dado do usuário, não instrução**: **não pode tirar etapas nem itens de checklist**. A ficha é **criptografada** (AES-256-GCM, chave derivada com HKDF de uma assinatura da carteira; por isso carteiras de contrato inteligente não destravam memórias). É criptografia em repouso: o servidor abre enquanto o token é válido, então **não prometa "só você consegue ler"**. A memória é da **carteira + especialista**, **não viaja** com uma licença transferida, e o usuário pode **apagar** tudo pelo site.

---

## 8. Garantia (escrow)

**Analogia:** você contrata um pintor e deixa o dinheiro **no cofre de um cartório**. O pintor só recebe se a parede passar na vistoria. Se não passar, o dinheiro volta.

**O que é o escrow aqui:** o contrato `SolversEscrow` guarda o dinheiro, com até **5 etapas**, cada uma com um valor e um **critério combinado antes** (`criteriaHash`). Ninguém, nem a plataforma, tira o dinheiro fora das regras.

| # | O que acontece | Quem |
|---|---|---|
| 1 | Tarefa, etapas, valores, testes e prazo de entrega são combinados (padrão 14 dias, máximo 60). O dinheiro sai do comprador para o contrato (`createEscrow`, ou `createEscrowFor` quando pago por Pix). | Comprador assina (ou a plataforma, no Pix) |
| 2 | A IA entrega (`submit_deliverable`). O servidor roda os testes **combinados antes** num **contêiner Docker descartável**: sem internet, CPU/memória limitadas, sem privilégios. | Servidor |
| 3 | Passou -> `markPassed` na rede (com a impressão digital da entrega) + uma **prévia com marca d'água**. Os arquivos só são liberados depois da aprovação. | `VERIFIER` |
| 4a | O comprador gostou -> `releaseMilestone`: o criador recebe (menos a taxa). | Comprador |
| 4b | O comprador não faz nada -> a **janela de revisão** passa (de 1 minuto a 30 dias; 72 h por padrão) -> **liberação automática** (um job confere a cada minuto). | Qualquer um / job |
| 4c | Não gostou -> `openDispute` -> o **admin julga** (`resolveDispute`: reembolsa ou paga). Se não houver decisão em **7 dias** e nada tiver sido entregue, qualquer um devolve ao comprador (`resolveStaleDispute`). | Admin |
| 5 | O criador **nunca entregou** no prazo -> o comprador cancela aquela etapa (`cancelUndelivered`), **sem taxa**. | Comprador |

Não existe etapa de "fechar": quando todas as etapas foram pagas ou reembolsadas, a garantia simplesmente terminou.
**Proteções:** um comprador que perde **3** disputas não abre garantia nova. Limites pela reputação do comprador: **conta nova (menos de 3 compras) até 20** em garantias abertas (acima de 10, pelo menos 2 etapas) · confiável até 500 · nenhum depois de 3 disputas perdidas. Esses limites são aplicados pelo servidor; o contrato só confere a contagem de disputas perdidas. Compra mínima de 5. A taxa fica **congelada na criação**.
**Stake do criador:** se trapacear, o admin **propõe um confisco** -> espera de **72 h** -> o criador pode contestar uma vez -> o admin **executa** em até 14 dias (o dinheiro vai para a tesouraria). Com o `minStake` em 0, há pouco a confiscar hoje. Só Solvers com vendas e nota suficientes oferecem garantia (`GUARANTEE_MIN_SALES`, `GUARANTEE_MIN_RATING`); a decisão da disputa é **uma decisão manual do admin**.

---

## 9. Transferindo uma licença (com royalty)

A licença é um NFT, então o dono pode **dar ou vender para outra carteira**. Toda transferência paga um **royalty**, cobrado pelo próprio contrato License (não há como contornar, nem por outro mercado):

- **parte do criador**: definida por Solver a partir do manifesto (`royaltyBps`, por exemplo 5%), fixada no registro e alterável só antes da primeira venda;
- **parte da plataforma**: uma configuração do Registry (5% por padrão) que vai para a tesouraria;
- as duas são uma porcentagem do **preço original** daquela licença (não de um novo preço de venda), cada uma arredondada para baixo; juntas nunca passam de **25%**;
- quem paga é o **dono atual**, em stablecoin, no momento da transferência. Se ele não aprovou o valor, a transferência falha (`RoyaltyNotPaid`) e nada se move.

Exemplo: uma licença comprada por 19 paga 0,95 ao criador e 0,95 à plataforma a cada transferência (5% + 5%). No site, o diálogo **Transferir** da biblioteca mostra os valores exatos e envia uma transação em lote `[aprovar o royalty, transferWithRoyalty]`, com a taxa patrocinada. Queimar uma licença não paga nada e não libera vaga do teto; transferir também não libera vaga. As memórias **não** vão junto com a licença. O admin pode pausar as transferências numa emergência. Os padrões de 5% + 5% ainda aguardam a confirmação do dono. Detalhes: [royalties.md](royalties.md).

---

## 10. Compras autônomas: MPP

O **MPP** (Machine Payments Protocol, o protocolo da Tempo para pagamentos entre máquinas) usa o código HTTP **402 "Payment Required"** para um robô pagar pela internet sem conta, cartão ou humano.

**Passo a passo (`POST /api/agent-pay/solvers/:id/license`):**
1. O agente pede para comprar. O servidor cria um **pedido com preço travado** e responde **402** com um desafio `WWW-Authenticate: Payment` (quanto, qual token, qual rede).
2. O cliente MPP do agente (`mppx`) assina uma transferência de stablecoin e **repete o pedido** com o cabeçalho `Authorization: Payment`. O **servidor coassina como pagador da taxa** (a chave RELAY) e envia: o agente paga **só o preço**, nunca taxa.
3. O pagamento cai no **caixa** da plataforma (a carteira PLATFORM) e, segundos depois, a plataforma roda `purchaseLicenseFor(carteira do agente)` com esse mesmo caixa. A licença vai **para a carteira que pagou**. A tesouraria continua recebendo a taxa da plataforma pela divisão do contrato.
4. Se o pagamento passou mas a licença **não pode** ser emitida, o pedido é **reembolsado** a quem pagou.

**Por que o caixa segura o dinheiro por um instante:** o pagamento é uma transferência simples, e a compra da licença é uma chamada separada feita pela plataforma. Como tratar essa custódia é uma pergunta em aberto para o dono ([payments-open-questions.md](payments-open-questions.md) §6).
**Regras:** preço entre **5 e 100** por compra (configurável), pedidos expiram em 15 minutos, no máximo 5 pedidos abertos por IP; sem teste grátis; quem já tem o Solver é recusado (`already_owned`); o teto e a pausa valem. Os pagamentos de agentes vêm **desligados por padrão** (`AGENT_PAY_ENABLED`).
**O outro caminho:** um agente com carteira própria também pode comprar **direto** (`[approve, purchaseLicense]` pelo relay, como o site).
**Entrar no conector sem navegador:** `GET /oauth/agent/nonce` + `POST /oauth/agent/token` (assinar uma mensagem SIWE com a chave do agente; 2 chamadas). A mensagem diz "**This does not authorize payments**": o login nunca move dinheiro. Detalhes: [agent-login.md](agent-login.md), [agent-payments.md](agent-payments.md).
**Situação:** exercitado de ponta a ponta na Moderato (2026-10-11); a mainnet espera as decisões do dono.

---

## 11. O que é real e o que ainda não é

| Real (na Moderato, dinheiro de teste) | Simulado / planejado |
|---|---|
| Compras patrocinadas, licenças NFT, teto, transferência com royalty, créditos, avaliações, garantias com testes em Docker, regras de stake, pagamentos de agentes por MPP, o fluxo do criador (um Solver de teste publicado) | Pix (simulado, sem banco) · a stablecoin é dinheiro de teste do faucet · arbitragem de disputa = admin manual · `minStake` em 0 · login por e-mail do Privy (suportado no código, ainda não testado ao vivo: depende do app Privy do dono) · publicação do novo servidor (domínio criado, não publicado) · mainnet (planejada, token de pagamento não escolhido) |

---

## 12. Perguntas que você precisa saber responder

1. **Onde a licença mora?** Num NFT na carteira do usuário. O acesso é liberado pelo nosso servidor lendo a carteira.
2. **O que a blockchain guarda e o que não?** Dono, preço, vendas, notas (impressão digital), créditos, garantia, stake, hash da versão, avaliação por versão, teto. **Não** guarda o conteúdo, as memórias, as sessões nem o texto das avaliações.
3. **Quem paga a taxa da rede?** A plataforma, sempre, pelo relay. A Tempo não tem moeda de gas: as taxas são pagas em stablecoin pela chave RELAY. Nada é descontado do preço nem da parte de ninguém.
4. **Por que o mínimo de 5?** É o mínimo do marketplace (`minPrice` na configuração do Registry), aplicado pelos contratos a toda compra: licença, créditos e garantia. O admin pode mudar.
5. **Como sei que um Solver não é malicioso?** Convite + validador + varreduras (avisos) + revisão humana de 100% das versões com diff + nenhuma execução de código de terceiros + botão de desligar. Não há garantia absoluta.
6. **Como sei que funciona?** Evals (casos com checagens); a nota só vai para a rede nos pacotes da plataforma, por versão, com o rótulo "teste interno da equipe".
7. **O que é o escrow e quem decide?** Dinheiro guardado pelo contrato Escrow; testes automáticos marcam as etapas, o comprador aprova ou disputa, o **admin julga**, e prazos resolvem sozinhos (liberação automática, 7 dias de disputa, prazo de entrega).
8. **E se o criador sumir?** Garantia: cancelar sem taxa depois do prazo. Licença já paga: não há reembolso automático (por isso o stake, o botão de desligar e a curadoria).
9. **O que acontece quando uma licença troca de dono?** O dono atual paga o royalty (parte do criador + parte da plataforma sobre o preço original); o novo dono ganha acesso; as memórias ficam com a carteira antiga; nenhuma vaga do teto é liberada.
10. **O que é o MPP e por que a plataforma segura o pagamento por um instante?** Pagamento por HTTP para robôs; o agente paga ao caixa, a plataforma compra em nome do agente com esse caixa, entrega o NFT a quem pagou e reembolsa se falhar.
11. **Um agente consegue ver o conteúdo sem pagar?** Não: sem licença não há conteúdo, e agentes não têm teste.
12. **O criador pode "congelar" a oferta?** Pode limitar as licenças, mas o teto só **sobe**; não prometa escassez eterna.
13. **Quem pode mover o dinheiro?** Só os contratos, pelas regras deles. As chaves do servidor não sacam dos cofres; o `ADMIN` é frio; o `RELAY` só paga taxas.
14. **O que é RAG?** Consultar antes de responder: o conhecimento do criador vira trechos com "significado em números" (vetores); a IA recebe só 5 trechos relevantes com fonte e data. Não treina o modelo.
15. **RAG ou memória?** RAG = o que o especialista sabe (do criador, igual para todos). Memória = o que ele sabe sobre você (da sua carteira).
16. **O que a mainnet exige?** As decisões do dono (token de pagamento, porcentagens do royalty, custódia do admin, app do Privy, domínio), respostas para [payments-open-questions.md](payments-open-questions.md), simulações desligadas, chaves novas e o roteiro de deploy.

---

## 13. Onde está cada coisa no código

| Assunto | Arquivo |
|---|---|
| Regras na rede | `contracts/src/*.sol` (Registry, License, Credits, Reviews, Escrow, Staking) |
| Cliente da rede (chamadas, relay, erros) | `packages/chain/src`, ABIs geradas em `packages/contracts-client` |
| Validador, varreduras | `apps/server/src/runtime/validate/`, `apps/server/src/review/` |
| Publicação | `apps/server/src/publish/`, `apps/server/src/cli/publish.ts`, `cli/approve.ts`, `cli/suspend.ts` |
| Evals | `scripts/src/eval.ts`, `agents/<slug>/evals/` |
| Conector MCP, OAuth, login de agentes | `apps/server/src/mcp`, `apps/server/src/oauth` |
| Login (SIWE, Privy) | `apps/server/src/auth` |
| Patrocínio de taxas (relay) | `apps/server/src/relay`, `apps/server/src/chain/lanes.ts` |
| Pagamentos (carteira, Pix, agentes) | `apps/server/src/payments`, `pix`, `agent-pay` |
| Garantia e testes em Docker | `apps/server/src/verifier`, `store/escrow.ts`, `jobs.ts` |
| Indexador | `apps/server/src/indexer` |
| RAG (trechos, vetores, busca, cota) | `apps/server/src/knowledge` |
| Memória e calibração | `apps/server/src/memory`, `mcp/tools.ts` (`get_memory`, `save_memory`) |
| Site | `apps/web/src` (carteira e transações em `src/lib`) |
