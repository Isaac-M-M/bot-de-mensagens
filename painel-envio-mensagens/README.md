# Painel de Envio de Mensagens (WhatsApp + E-mail)

Interface web local: você escreve a mensagem, escolhe o canal e envia — sem precisar editar código.

## O que ele faz
- **WhatsApp**: manda para um contato único, um grupo, ou toda a lista da planilha.
- **E-mail**: manda pra todos os contatos com e-mail preenchido na planilha, com rotação automática entre várias contas — **Gmail, Outlook, Zoho, Hostinger, GoDaddy ou qualquer SMTP customizado**.
- **Campanhas**: em vez de só um envio avulso, dá pra criar, salvar e reenviar campanhas nomeadas — com histórico de quantos foram entregues, deram erro ou foram bloqueados.
- **Agendamento**: escolha dias da semana e um horário — a campanha dispara sozinha, sem precisar clicar em nada (só precisa o programa estar aberto no horário).
- **Blacklist automática**: e-mail que não existe (bounce), resposta negativa recebida no WhatsApp e resposta negativa recebida por e-mail (checado a cada 5 minutos, só nos provedores conhecidos — não em SMTP customizado) entram sozinhos na lista de bloqueados — sem precisar de ninguém cadastrando na mão. Também dá pra adicionar manualmente.
- Uma única planilha (`contatos.xlsx`) alimenta os dois canais — com botões para baixar o modelo e enviar a planilha preenchida direto pela página.
- Suporta personalização com `{{nome}}`, e até mensagens diferentes por pessoa.
- Acesso protegido por usuário e senha (configurado na primeira vez, pelo próprio navegador).

## Instalação (só na primeira vez)

1. Baixe o instalador **`Painel de Envio de Mensagens Setup.exe`** (veja com quem te vendeu o programa, ou em **Releases**/**Actions** do repositório — veja a seção "Gerar um novo instalador", mais abaixo).
2. Dê **dois cliques** no arquivo baixado.

Pronto. O instalador:
- Não pede nada — instala sozinho (já vem com tudo: programa, WhatsApp e o "navegador" internos, nada pra baixar depois)
- Cria o atalho **"Painel de Envio de Mensagens"** na Área de Trabalho e no Menu Iniciar
- Abre o painel automaticamente assim que termina

Não precisa instalar Node.js, Chrome, nem nada — é um único arquivo, um único clique, e já funciona. Não é necessário nem ser administrador do computador.

## Uso no dia a dia

Depois de instalado, é só usar o atalho **"Painel de Envio de Mensagens"** (Área de Trabalho ou Menu Iniciar). Ele abre uma janela própria do programa, sem precisar abrir terminal nenhum.

**Fechar o programa** agora funciona como qualquer outro programa: feche a janela (X) e ele encerra tudo de verdade — não fica nada rodando escondido. Por isso, abrir de novo pelo atalho sempre funciona. Se por acaso você clicar duas vezes no atalho enquanto o programa já está aberto, ele não abre uma segunda cópia — só traz a janela que já existe pra frente.

### Primeira abertura: configuração inicial
Na primeira vez que o painel abrir, ele mostra uma tela pedindo:
- Um usuário e senha pra proteger o acesso ao painel (obrigatório)
- E-mail e senha de app do Gmail (opcional — pode configurar depois se quiser usar e-mail)

Preencha e clique em "Salvar e começar a usar". Isso substitui a necessidade de editar arquivos `.env` na mão.

**Sobre a senha de app do Gmail**: não é a senha normal da sua conta Google. Para gerar uma:
1. Acesse [myaccount.google.com/security](https://myaccount.google.com/security) e ative a Verificação em duas etapas (obrigatório)
2. Acesse [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Crie uma nova senha de app — o Google gera um código de 16 letras, é esse código que vai no painel

Se quiser cadastrar **mais contas de e-mail** (pra rotação automática caso uma seja bloqueada, ou de outros provedores como Outlook/Zoho/Hostinger/GoDaddy), use a aba **"🖧 Servidores"** dentro do painel — não precisa mais editar arquivo nenhum na mão. Lá também dá pra testar a conexão de cada conta com um clique antes de usar numa campanha de verdade.

### Preparar a planilha de contatos
Direto na página do painel, no topo: **"⬇️ Baixar planilha modelo"** pra pegar o modelo já formatado, preencha, e **"📤 Enviar planilha preenchida"** pra carregar de volta.

Colunas da planilha:

| nome | telefone | email | mensagem |
|---|---|---|---|
| Maria Silva | 6199973622 | maria@exemplo.com | *(vazio)* |
| Carlos Souza | 6198372141 | carlos@exemplo.com | Mensagem só pra ele, diferente da padrão |

- Preencha `telefone` pra usar no WhatsApp, `email` pra usar no e-mail — não precisa preencher os dois se só for usar um canal.
- A coluna `mensagem` é opcional: vazia usa a mensagem padrão da tela; preenchida, usa esse texto só pra aquela pessoa. Aceita `{{nome}}` também.

### Conectar o WhatsApp (só na primeira vez usando essa aba)
Na aba WhatsApp, um QR Code aparece direto na página — escaneie com **WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho**. Depois disso fica conectado, não precisa repetir.

### Enviar mensagens
- Escolha a aba (WhatsApp ou E-mail)
- No WhatsApp: contato único, grupo (cole o ID — veja `bot-cronograma-diario/capturar-id-grupo.js` de outro projeto se precisar descobrir o ID de um grupo nosso), ou lista da planilha
- Escreva a mensagem e clique em enviar

Todo envio feito por aqui (mesmo o avulso) já fica registrado como uma campanha, com o resultado de cada contato salvo — veja a aba **"📣 Campanhas"**.

### Campanhas, agendamento e blacklist
- **Aba "📣 Campanhas"**: crie uma campanha com nome, canal, mensagem e (opcional) dias da semana + horário pra ela disparar sozinha. Uma campanha salva pode ser editada a qualquer momento (botão "Editar"), reenviada quando quiser, ou excluída. Cada campanha mostra o resumo (quantos foram enviados, deram erro, foram bloqueados pela blacklist, e quando o rastreamento estiver configurado, quantos abriram/clicaram) e, clicando em "Ver detalhes", uma tabela contato por contato mostrando exatamente pra quem foi, o status e o motivo de cada erro — pra identificar na hora onde deu problema, sem precisar adivinhar pelo resumo.
  - **Importante sobre agendamento**: a campanha só dispara enquanto o programa estiver aberto no computador, no horário marcado — não é um serviço na nuvem rodando 24h. Se o computador estiver desligado na hora, ela dispara na próxima vez que o programa abrir naquele dia (ou só no próximo dia marcado, se já tiver passado da hora).
- **Aba "🖧 Servidores"**: cadastre quantas contas de e-mail quiser, de qualquer provedor suportado, e teste a conexão antes de usar.
- **Aba "🚫 Blacklist"**: veja quem está bloqueado e por quê (bounce, resposta no WhatsApp, ou manual), remova alguém se precisar, ou adicione manualmente.

## Arquivos do projeto (resumo)
- `main.js` — processo principal do programa (abre a janela, garante que fecha direito e que não abre em dobro)
- `server.js` — o painel em si (rotas, envio de WhatsApp/e-mail, campanhas, agendamento, blacklist)
- `db.js` — banco de dados local (SQLite) com campanhas, log de envios, eventos e blacklist
- `public/` — a interface (HTML/CSS/JS) que aparece na janela
- `.env.example` — referência do arquivo `.env` (hoje só guarda usuário/senha do painel; contas de e-mail ficam no banco de dados, cadastradas pela aba Servidores)
- Os dados de cada instalação (`.env`, `contatos.xlsx`, `painel.db`, sessão do WhatsApp) ficam guardados na pasta de perfil do Windows, fora da pasta do programa — sobrevivem a uma reinstalação do instalador.

## Cuidados
- **Ritmo de envio**: o WhatsApp em lista espera de 8 a 15 segundos entre mensagens, pra evitar bloqueio. O e-mail espera 2 segundos entre cada envio.
- **Gmail tem limite diário** por conta (o painel considera ~400/dia por segurança). Com múltiplas contas cadastradas, a capacidade soma.
- **Nunca compartilhe o arquivo `.env`** — tem as senhas de app do Gmail e a senha de acesso ao painel.

## Gerar um novo instalador (para quem desenvolve/vende o programa)

Como o instalador Windows (`.exe`) não pode ser gerado num computador Linux/Mac, isso é feito automaticamente pelo GitHub Actions, num computador Windows temporário na nuvem:

1. No GitHub, vá em **Actions → "Gerar instalador do Painel de Envio de Mensagens" → Run workflow** (botão manual), ou crie e envie uma tag no padrão `painel-v1.0.0`:
   ```
   git tag painel-v1.0.0
   git push origin painel-v1.0.0
   ```
2. Espere o workflow terminar (uns 5-10 minutos — ele baixa tudo, inclusive o "navegador" usado pelo WhatsApp, e empacota).
3. Baixe o instalador pronto:
   - Em **Actions**, na execução que rodou, na seção "Artifacts" (se disparou manualmente ou por push comum); ou
   - Em **Releases** (se disparou com uma tag `painel-v*`) — esse já fica com link direto pra compartilhar com os clientes.

Esse `.exe` é o único arquivo que o cliente final precisa baixar e executar — o resto (Node.js, dependências, Chromium) já vai tudo embutido nele.

### Gerando localmente (se tiver Windows à mão)
No PowerShell:
```
cd painel-envio-mensagens
$env:PUPPETEER_CACHE_DIR = "$PWD\.chromium-cache"
npm install
npm run dist
```
O instalador aparece em `painel-envio-mensagens/dist/*.exe`.

## Se for usar isso comercialmente (vender/instalar pra clientes)
Antes de oferecer isso como produto ou serviço pago, deixe claro pro cliente:

- **O envio por WhatsApp usa uma biblioteca não-oficial** (`whatsapp-web.js`), que simula o WhatsApp Web — não é a API oficial da Meta. Isso é contra os Termos de Serviço do WhatsApp, e o número pode ser bloqueado, especialmente com uso intenso.
- A alternativa 100% oficial (WhatsApp Business API) tem custo por mensagem e processo de aprovação — considere migrar se o volume de envio crescer muito.
- A biblioteca pode parar de funcionar temporariamente quando o WhatsApp muda algo internamente (já aconteceu mais de uma vez durante o desenvolvimento deste painel) — combine um plano de suporte pra esses casos.
- Recomendo formalizar por escrito com o cliente que ele está ciente desses riscos antes de instalar.
