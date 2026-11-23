# Atimo

App desktop (Tauri 2 + React 19 + Vite + Tailwind 4) para consultoria Oracle
Fusion Cloud com qualquer modelo de IA.

Um workspace local onde projetos guardam o contexto (instruções, documentos,
memória) e qualquer modelo — GLM, DeepSeek, os do OpenRouter, ou a sua
conta do Claude, ChatGPT, Cursor, Gemini, Grok, Kimi ou Devin via CLI — responde em cima dele. Em perguntas de
Oracle, o app anexa a documentação oficial antes da resposta, para o modelo
consultar nomes de tabela, coluna e endpoint em vez de inventá-los.

## Rodando

```sh
bun install
bun run dev          # só o frontend, http://localhost:1420 (sem Rust: sem Keychain nem SQLite)
bun run tauri dev    # janela desktop
bun run build        # typecheck + bundle
bun test             # testes do frontend
cd src-tauri && cargo test --lib
bun run tauri build  # bundles assinados para o updater — ver "Releases"
```

Na primeira execução o app pergunta como começar: projeto vazio, dados de
exemplo ou restaurar um backup.

## Provedores

`⌘,` abre as Configurações (Aparência, Respostas, Provedores, Pesquisa Oracle, Backup, Sobre), também pelo menu da conta no rodapé da barra lateral; Provedores leva à tela de conexão. O anel ao lado mostra o limite mais apertado do plano e abre os detalhes (`usage-limits.ts`): Codex via `codex app-server`, Claude pelo `rate_limit_event` de cada resposta, OpenRouter por `/api/v1/key`, Coding Plan da Z.AI pela cota que o plugin oficial deles lê, DeepSeek pelo saldo. Os provedores via ACP e a API paga da Z.AI não informam limites. A chave vai para o cofre do sistema (Keychain,
Credential Manager, Secret Service) e só o Rust a lê; o webview nunca a vê. No
`bun run dev` cai para `localStorage`, e a tela avisa.

| provedor   | o que é                                                         |
| ---------- | --------------------------------------------------------------- |
| OpenRouter | uma chave, centenas de modelos (catálogo ao vivo, público)      |
| Z.AI       | GLM, pela General API ou pelo Coding Plan (chaves separadas)    |
| DeepSeek   | API oficial                                                     |
| Claude     | a CLI `claude` já instalada e logada; o app não guarda credencial |
| ChatGPT    | a CLI `codex` já instalada e logada; idem                       |
| Cursor     | `cursor-agent`, com login feito em `cursor-agent login`         |
| Gemini     | `gemini`, com login Google feito ao abrir a CLI                 |
| Grok       | Grok Build (`grok`), com login feito em `grok login`             |
| Kimi       | Kimi Code (`kimi`), com login feito em `kimi login`              |
| Devin      | CLI local `devin`, com login feito em `devin auth login`         |

Para os provedores via CLI, instale a ferramenta oficial e faça o login no
terminal. Em Conexões, selecione o provedor e clique em **Detectar**. O login
e suas credenciais ficam com a CLI; o Atimo não lê seus tokens. Essas conexões
exigem o app desktop. Os cinco novos usam ACP para consultar os modelos da
conta e enviar as mensagens, seguindo os fluxos de CLI/conta do
[Synara](https://github.com/Emanuele-web04/synara) e do
[T3 Code](https://github.com/pingdotgg/t3code).

Todos passam por `src/lib/adapter/`; nada acima dele sabe qual está ativo.
Esforço de raciocínio (`effort.ts` ↔ `effort.rs`), visibilidade do raciocínio
e "Fast" (throughput no OpenRouter) são preferências globais.

> O Coding Plan da Z.AI só é permitido nas ferramentas que a Z.AI lista, e o
> Atimo não está entre elas.

## Oracle Fusion

A parte que mais mudou e a razão de ser do app hoje. Detalhes em
[`docs/oracle-fusion-mvp.md`](docs/oracle-fusion-mvp.md).

- **Acervos** — índices da documentação oficial em docs.oracle.com, consultados
  por nome, nunca gerados:
  - Tables and Views (`oracle-acervo.ts`): colunas, PK e índices das tabelas
    da pergunta. HCM (`oedmh`, FA Latest) e Financials (`oedmf`, versionado).
  - Integração (`oracle-rest.ts`): recursos REST de HCM e ERP com path,
    parâmetros e campos, além de notas estáticas sobre OIC, BIP via SOAP, Atom,
    FBDI e HDL.
  - Guias HCM (`oracle-faq.ts`): livros de Q&A, Implementing Global HR e HCM
    Data Loader, buscados localmente pelos títulos.
- **Verificação depois da resposta** — `checkSql`, `checkRest` e `checkHdl`
  apontam colunas, paths e componentes que a documentação não tem. Só avisam;
  não reescrevem a resposta.
- **Pesquisa web** (`research-*.ts`, `research.rs`) — Gemini (Google Search + URL
  Context) ou OpenRouter Web Search. Modos: *Sem pesquisa* (padrão),
  *Automático* e *Pesquisa profunda*. Exige autorização explícita e orçamento
  mensal opcional; o pesquisador recebe só a pergunta, nunca arquivos ou
  memória do projeto. As fontes mostram se a página foi lida pelo Atimo, pelo
  provedor, ou se só o link foi checado.
- **Revisão de integração** — um `.iar`/`.zip` do OIC anexado vai inteiro para o
  modelo (`integration-files.ts`), dentro de um teto do contexto.
- **Diagramas** — peça um fluxograma, sequência de chamadas ou desenho de uma
  integração do zero. Blocos `mermaid` aparecem como diagramas no chat e na
  comparação de respostas, com zoom, código copiável e exportação SVG. O layout
  roda localmente em um worker, sob demanda; o SVG é sanitizado, sem buscar fontes
  externas. Também aceita estados, classes e entidades/relacionamentos na sintaxe
  suportada pelo `beautiful-mermaid`. Em análises de arquivos, o modelo deve
  distinguir o fluxo observado de mudanças propostas e indicar cobertura parcial.
- **Skills Oracle** — Solução mínima, Texto pro cliente, Documento funcional,
  Revisão de SQL/BIP, Carga HDL, entre outras (`skills.ts`).
- **Eval** — `evals/oracle/` roda o mesmo pipeline contra modelos reais; ver o
  [README de lá](evals/oracle/README.md).

## Contexto

- **Projetos** têm `instructions` (o brief que vai em todo turno, nunca cortado)
  e `description` (só para você).
- **Documentos** soltos na conversa viram trechos de ~220 tokens indexados;
  só os trechos que respondem à pergunta vão para o modelo. **Anexos** (imagens,
  arquivos de um turno só) são outra coisa (`attachments.ts`).
- **Referências** `@chat(...)`, `@project(...)`, `@document(...)` etc.
  (`references.ts`) sempre entram no contexto.
- **Context Composer** (`context-composer.ts`) monta o contexto a cada envio
  com orçamento de 30% da janela do modelo; o medidor (`context-usage.ts`)
  mostra o custo por parte.
- **Busca semântica** local: `multilingual-e5-base` via `fastembed` (~1,1 GB,
  baixado uma vez, com consentimento), combinada com busca por termos.
- **Painel** (`panel.ts`) — vários modelos respondem o mesmo prompt dentro do
  chat; um deles continua como a conversa.
- Fork, retry/regenerate, renomear e apagar chats e projetos.

## Dados

- SQLite local, gravado a cada mudança (`src-tauri/src/db.rs`,
  `src/lib/sync.ts`). No macOS:
  `~/Library/Application Support/com.maccuci.atimo/atimo.sqlite3`.
- Exportação do workspace ou de um projeto em JSON (restaurável) ou Markdown
  (legível), e restauração do JSON. Restaurar só adiciona, nunca apaga. Nenhuma
  chave vai no arquivo.
- Sem servidor e sem sync entre máquinas.

A restauração ainda aceita backups no formato antigo (`grapheno.workspace`).

## Interface

`src/t3/` é a interface atual (inspirada no
[t3code](https://github.com/pingdotgg/t3code)); regras em
[`src/t3/DESIGN.md`](src/t3/DESIGN.md), tokens em `src/styles/theme-t3.css`.
Nenhuma cor fora desse arquivo. Os temas (Configurações → Aparência) são blocos `[data-theme]` no mesmo arquivo; tema, cor de destaque, fonte e tamanho do texto ficam em `src/lib/theme.ts`.

| cor     | significado                          |
| ------- | ------------------------------------ |
| indigo  | entrada do usuário, seleção, status  |
| verde   | sucesso, adições                     |
| vermelho| erros, remoções                      |
| fúcsia  | o modelo                             |

| atalho | ação                 |
| ------ | -------------------- |
| `⌘K`   | busca / comandos     |
| `⌘N`   | novo chat            |
| `⌘B`   | barra lateral        |
| `⌘1`   | chat                 |
| `⌘6`   | modelos              |
| `⌘7`   | skills               |
| `⌘,`   | configurações        |
| `@`    | referenciar contexto |

## Releases

O app não é assinado pela Apple. Na primeira instalação no macOS: botão direito
→ Abrir, ou `xattr -cr /Applications/Atimo.app`. Depois disso, as atualizações
chegam pelo updater do Tauri, verificadas com uma chave minisign:

| onde                                 | o quê                                       |
| ------------------------------------ | ------------------------------------------- |
| `~/.tauri/atimo-updater.key`      | chave privada, fora do repositório; faça backup |
| `plugins.updater.pubkey`             | chave pública, em `tauri.conf.json`         |

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/atimo-updater.key
```

A chave não tem senha, então **não** crie `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`:
o GitHub não aceita secret vazio, `gh secret set --body ""` abre um prompt, e
qualquer valor ali quebra a assinatura ("Wrong password for that key").
Sem o secret, o workflow recebe string vazia, que é a senha certa.

Plataformas: Mac Intel fica de fora porque o ONNX Runtime da busca semântica
(`ort-sys`) não tem binário pronto para `x86_64-apple-darwin`. O Linux é
compilado no Ubuntu 24.04 e exige glibc 2.39+ (Ubuntu 24.04, Debian 13,
Fedora 40 ou mais novos).

Para lançar: suba `version` em `package.json` (é o único lugar), commit, e
`git tag vX.Y.Z && git push origin vX.Y.Z`. O workflow `release.yml` gera
macOS (só Apple silicon), Windows e Linux como release **rascunho**; publique quando estiver
completo, porque o `latest.json` é o que todas as cópias instaladas consultam.

## CSP

`script-src 'self'`; as chamadas de rede saem do Rust. `style-src` mantém
`'unsafe-inline'` por causa de `style={{…}}`. Não coloque `<style>` em
`index.html`: o Tauri injeta um nonce nele, e com nonce o navegador ignora
`'unsafe-inline'`, e todo estilo inline do app para de funcionar.

## Licença

Apache-2.0. Ver [`LICENSE`](LICENSE).
