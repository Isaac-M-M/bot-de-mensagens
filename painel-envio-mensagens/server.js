/**
 * Painel de Envio de Mensagens — WhatsApp e E-mail
 * -----------------------------------------------------------------
 * Interface web local para escrever uma mensagem, escolher o canal
 * (WhatsApp ou E-mail) e enviar — sem precisar mexer em código.
 *
 * Este arquivo exporta `iniciarServidor()` / `encerrarServidor()` em vez
 * de subir sozinho ao ser importado, porque quem controla o ciclo de
 * vida (quando inicia, em qual pasta salva os dados, quando encerra de
 * verdade) é o processo principal do Electron (main.js).
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const QRCode = require("qrcode");
const xlsx = require("xlsx");
const nodemailer = require("nodemailer");
const multer = require("multer");
const { Client, LocalAuth } = require("whatsapp-web.js");

// Limite diário de envios por conta (o Gmail comum permite ~500/dia;
// deixamos uma margem de segurança abaixo disso).
const LIMITE_DIARIO_POR_REMETENTE = 400;

let httpServer = null;
let waClient = null;

/**
 * @param {object} opts
 * @param {string} opts.dataDir - pasta onde ficam .env, contatos.xlsx,
 *   controle-remetentes.json e a sessão do WhatsApp (dados do usuário,
 *   separados dos arquivos do programa em si).
 * @param {number} [opts.porta] - porta preferida (padrão 3000; se estiver
 *   ocupada, tenta as próximas automaticamente).
 * @returns {Promise<{ porta: number }>}
 */
function iniciarServidor({ dataDir, porta }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dataDir, { recursive: true });

    const ARQUIVO_ENV = path.join(dataDir, ".env");
    require("dotenv").config({ path: ARQUIVO_ENV });

    const ARQUIVO_CONTATOS = path.join(dataDir, "contatos.xlsx");
    const ARQUIVO_MODELO = path.join(__dirname, "contatos-exemplo.xlsx");
    const ARQUIVO_CONTROLE_REMETENTES = path.join(dataDir, "controle-remetentes.json");
    const PORTA_PREFERIDA = porta || Number(process.env.PORTA) || 3000;

    // Upload da planilha: salva sempre como contatos.xlsx dentro da pasta
    // de dados do usuário, sobrescrevendo a anterior.
    const upload = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, dataDir),
        filename: (req, file, cb) => cb(null, "contatos.xlsx"),
      }),
      fileFilter: (req, file, cb) => {
        const nomeValido = /\.xlsx$/i.test(file.originalname);
        if (!nomeValido) return cb(new Error("Envie um arquivo .xlsx"));
        cb(null, true);
      },
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    });

    // ==================== ESTADO DO WHATSAPP ====================

    let whatsappStatus = "iniciando"; // "iniciando" | "aguardando_qr" | "conectado"
    let ultimoQrDataUrl = null;

    const opcoesPuppeteer = { headless: true };
    try {
      // Usa o Chromium empacotado junto com o programa (não depende do
      // usuário ter Chrome/Edge instalado, nem baixa nada na hora de usar).
      opcoesPuppeteer.executablePath = require("puppeteer").executablePath();
    } catch {
      // Sem o pacote puppeteer disponível, deixa o whatsapp-web.js decidir
      // sozinho qual navegador usar (comportamento padrão dele).
    }

    waClient = new Client({
      authStrategy: new LocalAuth({ dataPath: path.join(dataDir, ".wwebjs_auth") }),
      puppeteer: opcoesPuppeteer,
    });

    waClient.on("qr", async (qr) => {
      whatsappStatus = "aguardando_qr";
      ultimoQrDataUrl = await QRCode.toDataURL(qr);
      console.log("📱 Novo QR Code gerado — abra o painel para escanear.");
    });

    waClient.on("ready", () => {
      whatsappStatus = "conectado";
      ultimoQrDataUrl = null;
      console.log("✅ WhatsApp conectado!");
    });

    waClient.on("disconnected", (motivo) => {
      whatsappStatus = "iniciando";
      console.log("⚠️ WhatsApp desconectado:", motivo);
    });

    waClient.initialize().catch((err) => {
      console.log("⚠️ Falha ao iniciar o WhatsApp:", err.message);
    });

    // ==================== FUNÇÕES AUXILIARES ====================

    function formatarTelefone(numero) {
      let digits = String(numero || "").replace(/\D/g, "");
      if (!digits) return null;
      if (!digits.startsWith("55")) digits = "55" + digits;
      return digits;
    }

    // Resolve o ID de destino consultando o próprio WhatsApp (via
    // getNumberId) em vez de só montar "numero@c.us" na mão. O WhatsApp
    // passou a usar um sistema novo de identificação de contato (LID), e
    // montar o ID manualmente pode disparar erros do tipo "No LID for
    // user" na hora de enviar. Retorna null se o número não tiver WhatsApp.
    async function resolverChatId(destino) {
      const valor = String(destino || "").trim();
      if (valor.endsWith("@g.us") || valor.endsWith("@c.us") || valor.endsWith("@lid")) return valor;

      const numero = formatarTelefone(valor);
      if (!numero) return null;

      const idInfo = await waClient.getNumberId(numero);
      return idInfo ? idInfo._serialized : null;
    }

    function lerContatos() {
      if (!fs.existsSync(ARQUIVO_CONTATOS)) return [];
      const workbook = xlsx.readFile(ARQUIVO_CONTATOS, { cellDates: true });
      const sheetName = workbook.SheetNames[0];
      const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
      return rows.map((row) => ({
        nome: String(row.nome || "").trim(),
        telefone: String(row.telefone || "").trim(),
        email: String(row.email || "").trim(),
        mensagem: String(row.mensagem || "").trim(),
      }));
    }

    function personalizar(mensagem, contato) {
      return mensagem.replaceAll("{{nome}}", contato.nome || "");
    }

    function delay(ms) {
      return new Promise((resolve2) => setTimeout(resolve2, ms));
    }

    // ==================== ROTAÇÃO DE REMETENTES ====================

    // Lê todos os remetentes cadastrados no .env, no formato:
    //   GMAIL_USER_1 / GMAIL_APP_PASSWORD_1
    //   GMAIL_USER_2 / GMAIL_APP_PASSWORD_2
    //   ...
    // Também aceita o formato antigo (GMAIL_USER / GMAIL_APP_PASSWORD) como
    // remetente único, pra quem ainda não migrou.
    function lerRemetentes() {
      const remetentes = [];

      if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
        remetentes.push({ email: process.env.GMAIL_USER, senha: process.env.GMAIL_APP_PASSWORD });
      }

      let i = 1;
      while (process.env[`GMAIL_USER_${i}`]) {
        const email = process.env[`GMAIL_USER_${i}`];
        const senha = process.env[`GMAIL_APP_PASSWORD_${i}`];
        if (email && senha) remetentes.push({ email, senha });
        i++;
      }

      // Remove duplicados (caso alguém cadastre o mesmo e-mail nos dois formatos)
      const vistos = new Set();
      return remetentes.filter((r) => {
        if (vistos.has(r.email)) return false;
        vistos.add(r.email);
        return true;
      });
    }

    function chaveHoje() {
      return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }

    function lerControleRemetentes() {
      if (!fs.existsSync(ARQUIVO_CONTROLE_REMETENTES)) return {};
      try {
        return JSON.parse(fs.readFileSync(ARQUIVO_CONTROLE_REMETENTES, "utf8"));
      } catch {
        return {};
      }
    }

    function salvarControleRemetentes(controle) {
      fs.writeFileSync(ARQUIVO_CONTROLE_REMETENTES, JSON.stringify(controle, null, 2), "utf8");
    }

    // Retorna o estado de hoje para um remetente: { enviados, bloqueado }
    function estadoDeHoje(controle, email) {
      const hoje = chaveHoje();
      const registro = controle[email];
      if (!registro || registro.data !== hoje) {
        return { data: hoje, enviados: 0, bloqueado: false };
      }
      return registro;
    }

    function registrarEnvio(email) {
      const controle = lerControleRemetentes();
      const estado = estadoDeHoje(controle, email);
      estado.enviados += 1;
      controle[email] = estado;
      salvarControleRemetentes(controle);
    }

    function registrarBloqueio(email) {
      const controle = lerControleRemetentes();
      const estado = estadoDeHoje(controle, email);
      estado.bloqueado = true;
      controle[email] = estado;
      salvarControleRemetentes(controle);
    }

    // Escolhe o próximo remetente disponível (não bloqueado, abaixo do limite
    // diário), ignorando os que já falharam nessa mesma rodada de envio.
    function proximoRemetenteDisponivel(remetentes, jaTentados) {
      const controle = lerControleRemetentes();
      for (const r of remetentes) {
        if (jaTentados.has(r.email)) continue;
        const estado = estadoDeHoje(controle, r.email);
        if (estado.bloqueado) continue;
        if (estado.enviados >= LIMITE_DIARIO_POR_REMETENTE) continue;
        return r;
      }
      return null;
    }

    // Erros do Gmail que indicam bloqueio/limite (vs. erro pontual, tipo
    // e-mail de destino inválido, que não deve trocar de remetente)
    function pareceBloqueioDeConta(err) {
      const msg = ((err && err.message) || "").toLowerCase();
      return (
        msg.includes("invalid login") ||
        msg.includes("too many login attempts") ||
        msg.includes("quota") ||
        msg.includes("rate limit") ||
        msg.includes("suspended") ||
        msg.includes("5.7.0") ||
        msg.includes("5.4.5")
      );
    }

    // Tenta enviar um e-mail, trocando de remetente automaticamente se um
    // deles estiver bloqueado ou tiver batido o limite do dia.
    async function enviarComRotacao(remetentes, destinatario, assunto, texto) {
      const jaTentados = new Set();

      while (true) {
        const remetente = proximoRemetenteDisponivel(remetentes, jaTentados);
        if (!remetente) {
          throw new Error("Nenhum remetente disponível (todos bloqueados ou no limite diário).");
        }

        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: remetente.email, pass: remetente.senha },
        });

        try {
          await transporter.sendMail({ from: remetente.email, to: destinatario, subject: assunto, text: texto });
          registrarEnvio(remetente.email);
          return { remetenteUsado: remetente.email };
        } catch (err) {
          jaTentados.add(remetente.email);
          if (pareceBloqueioDeConta(err)) {
            registrarBloqueio(remetente.email);
            console.log(`⚠️  Remetente ${remetente.email} parece bloqueado/no limite. Tentando o próximo...`);
            continue; // tenta o próximo remetente
          }
          // Erro que não é de bloqueio de conta (ex: e-mail de destino inválido) — não adianta trocar de remetente
          throw err;
        }
      }
    }

    // ==================== ROTAS ====================

    const app = express();

    function configuracaoInicialPendente() {
      return !fs.existsSync(ARQUIVO_ENV);
    }

    // Nome do cookie que guarda a sessão de login, e a chave usada pra
    // gerar/validar seu valor. Trocar SESSAO_SEGREDO (ex: trocando a senha)
    // invalida sozinho qualquer sessão aberta antes — de propósito.
    const COOKIE_SESSAO = "painel_sessao";

    // Antes usávamos autenticação HTTP Basic (a caixinha nativa do
    // navegador). Dentro do Electron ela se mostrou pouco confiável — às
    // vezes simplesmente não aparece, deixando a pessoa presa numa tela de
    // "acesso restrito" sem conseguir digitar a senha em lugar nenhum. Por
    // isso trocamos para uma tela de login própria (login.html) + cookie de
    // sessão, que é só HTML normal e sempre aparece.
    function garantirSegredoSessao() {
      if (process.env.SESSAO_SEGREDO || configuracaoInicialPendente()) return;
      const segredo = crypto.randomBytes(32).toString("hex");
      fs.appendFileSync(ARQUIVO_ENV, `SESSAO_SEGREDO=${segredo}\n`, "utf8");
      process.env.SESSAO_SEGREDO = segredo;
    }
    garantirSegredoSessao();

    function tokenDeSessaoValido() {
      if (!process.env.SESSAO_SEGREDO) return null;
      return crypto.createHmac("sha256", process.env.SESSAO_SEGREDO).update("painel-autenticado").digest("hex");
    }

    function lerCookie(req, nome) {
      const header = req.headers.cookie || "";
      for (const parte of header.split(";")) {
        const item = parte.trim();
        const idx = item.indexOf("=");
        if (idx === -1) continue;
        if (item.slice(0, idx) === nome) return decodeURIComponent(item.slice(idx + 1));
      }
      return null;
    }

    // Sem PAINEL_USUARIO/SENHA configurados, o painel fica acessível sem
    // login pra qualquer pessoa na mesma rede (mesmo comportamento de antes).
    function estaAutenticado(req) {
      if (!process.env.PAINEL_USUARIO || !process.env.PAINEL_SENHA) return true;
      const cookie = lerCookie(req, COOKIE_SESSAO);
      const esperado = tokenDeSessaoValido();
      return Boolean(cookie && esperado && cookie === esperado);
    }

    app.use(express.json());

    // Antes de qualquer outra coisa: se ainda não existe .env, mostra a tela
    // de configuração inicial em vez do painel normal (e libera a rota que
    // salva essa configuração, sem exigir login — ainda não há login definido).
    app.post("/configuracao-inicial", (req, res) => {
      // Trava importante: essa rota só funciona ANTES da configuração existir.
      // Depois que o .env já foi criado, ela fica bloqueada — senão qualquer
      // pessoa sem login poderia trocar a senha do painel por essa rota.
      if (!configuracaoInicialPendente()) {
        return res.status(403).json({ erro: "A configuração inicial já foi concluída. Edite o arquivo .env manualmente para alterar." });
      }

      const { painelUsuario, painelSenha, gmailUser, gmailSenha } = req.body || {};

      if (!painelUsuario || !painelUsuario.trim() || !painelSenha || !painelSenha.trim()) {
        return res.status(400).json({ erro: "Defina um usuário e uma senha para proteger o painel." });
      }

      let conteudo = `PAINEL_USUARIO=${painelUsuario.trim()}\nPAINEL_SENHA=${painelSenha.trim()}\n`;
      if (gmailUser && gmailUser.trim() && gmailSenha && gmailSenha.trim()) {
        conteudo += `GMAIL_USER_1=${gmailUser.trim()}\nGMAIL_APP_PASSWORD_1=${gmailSenha.trim()}\n`;
      }
      conteudo += `PORTA=${PORTA_PREFERIDA}\n`;
      conteudo += `SESSAO_SEGREDO=${crypto.randomBytes(32).toString("hex")}\n`;

      try {
        fs.writeFileSync(ARQUIVO_ENV, conteudo, "utf8");
      } catch (err) {
        return res.status(500).json({ erro: `Não consegui salvar o arquivo .env: ${err.message}` });
      }

      // Aplica na hora, sem precisar reiniciar o programa
      require("dotenv").config({ path: ARQUIVO_ENV });

      res.json({ ok: true });
    });

    app.post("/login", (req, res) => {
      const { usuario, senha } = req.body || {};
      if (usuario === process.env.PAINEL_USUARIO && senha === process.env.PAINEL_SENHA) {
        res.cookie(COOKIE_SESSAO, tokenDeSessaoValido(), {
          httpOnly: true,
          sameSite: "lax",
          maxAge: 90 * 24 * 60 * 60 * 1000, // 90 dias — não precisa logar de novo toda hora
        });
        return res.json({ ok: true });
      }
      res.status(401).json({ erro: "Usuário ou senha incorretos." });
    });

    app.get("/", (req, res, next) => {
      if (configuracaoInicialPendente()) {
        return res.sendFile(path.join(__dirname, "public", "configuracao-inicial.html"));
      }
      if (!estaAutenticado(req)) {
        return res.sendFile(path.join(__dirname, "public", "login.html"));
      }
      next();
    });

    // Os arquivos estáticos (CSS, ícone, e o próprio login.html) precisam
    // carregar mesmo antes do login, senão a tela de login não teria nem
    // estilo. Nada sensível fica exposto aqui — só a interface em si.
    app.use(express.static(path.join(__dirname, "public")));

    // Proteção por senha (opcional, mas recomendada): protege as rotas que
    // realmente fazem algo (ler/enviar contatos, mandar mensagens). Sem
    // PAINEL_USUARIO/SENHA configurados, o painel fica aberto pra qualquer
    // pessoa na mesma rede — então avisamos no console.
    function exigirLogin(req, res, next) {
      if (configuracaoInicialPendente()) return next(); // ainda não há login definido
      if (estaAutenticado(req)) return next();
      return res.status(401).json({ erro: "Sessão não autenticada. Recarregue a página e faça login novamente." });
    }

    app.use(exigirLogin);

    if (configuracaoInicialPendente()) {
      console.log("ℹ️  Primeira execução detectada — abra o painel para concluir a configuração inicial.");
    } else if (!process.env.PAINEL_USUARIO || !process.env.PAINEL_SENHA) {
      console.log("⚠️  PAINEL_USUARIO/PAINEL_SENHA não configurados no .env — o painel está acessível SEM SENHA para qualquer pessoa na mesma rede.");
    }

    app.get("/status", (req, res) => {
      res.json({
        whatsappStatus,
        qr: ultimoQrDataUrl,
        temContatos: fs.existsSync(ARQUIVO_CONTATOS),
      });
    });

    app.get("/contatos", (req, res) => {
      try {
        const contatos = lerContatos();
        res.json({ contatos });
      } catch (err) {
        res.status(500).json({ erro: err.message });
      }
    });

    // Baixar a planilha modelo (para o usuário preencher)
    app.get("/contatos/modelo", (req, res) => {
      if (!fs.existsSync(ARQUIVO_MODELO)) {
        return res.status(404).json({ erro: "Planilha modelo não encontrada no servidor." });
      }
      res.download(path.resolve(ARQUIVO_MODELO), "modelo-contatos.xlsx");
    });

    // Upload da planilha preenchida — sobrescreve contatos.xlsx
    app.post("/contatos/upload", (req, res) => {
      upload.single("planilha")(req, res, (err) => {
        if (err) {
          return res.status(400).json({ erro: err.message });
        }
        if (!req.file) {
          return res.status(400).json({ erro: "Nenhum arquivo recebido." });
        }
        try {
          const contatos = lerContatos(); // valida se a planilha é legível
          res.json({ ok: true, totalContatos: contatos.length });
        } catch (err2) {
          res.status(400).json({ erro: "Arquivo recebido, mas não consegui ler como planilha: " + err2.message });
        }
      });
    });

    // Envio por WhatsApp
    app.post("/enviar/whatsapp", async (req, res) => {
      const { tipoDestino, destino, mensagem } = req.body;

      if (whatsappStatus !== "conectado") {
        return res.status(400).json({ erro: "WhatsApp ainda não está conectado. Escaneie o QR Code primeiro." });
      }
      // A mensagem padrão só é obrigatória se não for "lista da planilha" —
      // nesse modo, cada contato pode ter sua própria mensagem na coluna "mensagem".
      if (tipoDestino !== "planilha" && (!mensagem || !mensagem.trim())) {
        return res.status(400).json({ erro: "Mensagem vazia." });
      }

      const resultados = [];

      try {
        if (tipoDestino === "unico" || tipoDestino === "grupo") {
          if (!destino || !destino.trim()) {
            return res.status(400).json({ erro: "Informe o destino (número ou ID do grupo)." });
          }
          const chatId = await resolverChatId(destino);
          if (!chatId) {
            return res.status(400).json({ erro: "Esse número não está no WhatsApp (ou o formato está incorreto)." });
          }
          await waClient.sendMessage(chatId, mensagem);
          resultados.push({ destino, status: "enviado" });
        } else if (tipoDestino === "planilha") {
          const contatos = lerContatos().filter((c) => c.telefone);
          if (contatos.length === 0) {
            return res.status(400).json({ erro: "Nenhum contato com telefone encontrado em contatos.xlsx." });
          }
          for (const contato of contatos) {
            try {
              const base = contato.mensagem || mensagem;
              if (!base || !base.trim()) {
                resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "erro", detalhe: "sem mensagem (nem individual, nem padrão)" });
                continue;
              }
              const chatId = await resolverChatId(contato.telefone);
              if (!chatId) {
                resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "erro", detalhe: "número não está no WhatsApp" });
                continue;
              }
              const texto = personalizar(base, contato);
              await waClient.sendMessage(chatId, texto);
              resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "enviado" });
            } catch (err) {
              resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "erro", detalhe: err.message });
            }
            await delay(8000 + Math.random() * 7000); // 8-15s entre mensagens
          }
        } else {
          return res.status(400).json({ erro: "tipoDestino inválido." });
        }

        res.json({ ok: true, resultados });
      } catch (err) {
        res.status(500).json({ erro: err.message });
      }
    });

    // Envio por E-mail (sempre em lista, via planilha, com rotação de remetentes)
    app.post("/enviar/email", async (req, res) => {
      const { assunto, mensagem } = req.body;

      if (!assunto || !assunto.trim()) {
        return res.status(400).json({ erro: "Informe o assunto do e-mail." });
      }
      // A mensagem padrão é opcional aqui — cada contato pode ter a sua própria
      // na coluna "mensagem" da planilha. Só validamos por contato, mais abaixo.

      const remetentes = lerRemetentes();
      if (remetentes.length === 0) {
        return res.status(400).json({ erro: "Nenhum remetente configurado no .env (GMAIL_USER_1/GMAIL_APP_PASSWORD_1, etc.)." });
      }

      const contatos = lerContatos().filter((c) => c.email);
      if (contatos.length === 0) {
        return res.status(400).json({ erro: "Nenhum contato com e-mail encontrado em contatos.xlsx." });
      }

      const resultados = [];
      for (const contato of contatos) {
        try {
          const base = contato.mensagem || mensagem;
          if (!base || !base.trim()) {
            resultados.push({ destino: `${contato.nome} (${contato.email})`, status: "erro", detalhe: "sem mensagem (nem individual, nem padrão)" });
            continue;
          }
          const texto = personalizar(base, contato);
          const { remetenteUsado } = await enviarComRotacao(remetentes, contato.email, assunto, texto);
          resultados.push({ destino: `${contato.nome} (${contato.email})`, status: "enviado", detalhe: `via ${remetenteUsado}` });
        } catch (err) {
          resultados.push({ destino: `${contato.nome} (${contato.email})`, status: "erro", detalhe: err.message });
        }
        await delay(2000); // 2s entre e-mails, ritmo mais tranquilo que o WhatsApp
      }

      res.json({ ok: true, resultados });
    });

    // Tenta a porta preferida e, se estiver ocupada, vai tentando as
    // próximas — evita que o programa simplesmente não abra por causa de
    // uma porta presa por outro processo.
    function tentarOuvir(portaAtual, tentativasRestantes) {
      const servidor = app.listen(portaAtual, "127.0.0.1");
      servidor.on("listening", () => {
        httpServer = servidor;
        console.log(`\n🌐 Painel disponível em: http://localhost:${portaAtual}\n`);
        resolve({ porta: portaAtual });
      });
      servidor.on("error", (err) => {
        if (err.code === "EADDRINUSE" && tentativasRestantes > 0) {
          tentarOuvir(portaAtual + 1, tentativasRestantes - 1);
        } else {
          reject(err);
        }
      });
    }

    tentarOuvir(PORTA_PREFERIDA, 10);
  });
}

// Encerra tudo de forma limpa: fecha o servidor HTTP e desliga o WhatsApp
// (que por baixo dos panos mantém um Chromium aberto — se não fechar
// direito, ele continua rodando escondido e "trava" a próxima abertura).
async function encerrarServidor() {
  const tarefas = [];

  if (httpServer) {
    const servidor = httpServer;
    httpServer = null;
    tarefas.push(new Promise((resolve) => servidor.close(() => resolve())));
  }

  if (waClient) {
    const cliente = waClient;
    waClient = null;
    tarefas.push(cliente.destroy().catch(() => {}));
  }

  await Promise.all(tarefas);
}

module.exports = { iniciarServidor, encerrarServidor };
