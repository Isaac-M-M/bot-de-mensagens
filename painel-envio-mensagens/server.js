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
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const db = require("./db");

// Limite diário de envios por conta (o Gmail comum permite ~500/dia;
// deixamos uma margem de segurança abaixo disso). Contas de outros
// provedores/Workspace podem aguentar mais — dá pra ajustar aqui.
const LIMITE_DIARIO_POR_REMETENTE = 400;

// Palavras que, numa resposta recebida pelo WhatsApp, indicam que a
// pessoa não quer mais receber mensagens — usado pra alimentar a
// blacklist automaticamente, sem precisar de ninguém marcando na mão.
const PALAVRAS_DESCADASTRO = [
  "não quero", "nao quero", "pare de mandar", "para de mandar",
  "não me mande", "nao me mande", "remove", "remova", "descadastr",
  "sair da lista", "cancelar", "não interessa", "nao interessa",
  "para de enviar", "não envie mais", "nao envie mais",
];

let httpServer = null;
let waClient = null;
let temporizadorAgendamento = null;
let temporizadorRespostasEmail = null;

/**
 * @param {object} opts
 * @param {string} opts.dataDir - pasta onde ficam .env, contatos.xlsx,
 *   painel.db, controle-remetentes.json e a sessão do WhatsApp (dados do
 *   usuário, separados dos arquivos do programa em si).
 * @param {number} [opts.porta] - porta preferida (padrão 3000; se estiver
 *   ocupada, tenta as próximas automaticamente).
 * @returns {Promise<{ porta: number }>}
 */
function iniciarServidor({ dataDir, porta }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dataDir, { recursive: true });

    const ARQUIVO_ENV = path.join(dataDir, ".env");
    require("dotenv").config({ path: ARQUIVO_ENV });

    db.iniciarBanco(dataDir);
    migrarRemetentesDoEnvParaBanco();

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

    // Blacklist automática via WhatsApp: se a pessoa responder algo do
    // tipo "não quero mais", "remove", "descadastra" etc., ela entra na
    // blacklist sozinha — sem precisar de ninguém marcando na mão.
    waClient.on("message", (msg) => {
      try {
        if (!msg || msg.fromMe || !msg.body) return;
        const textoNormalizado = msg.body
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, ""); // remove acentos
        const pareceDescadastro = PALAVRAS_DESCADASTRO.some((palavra) => textoNormalizado.includes(palavra));
        if (!pareceDescadastro) return;

        const numero = String(msg.from || "").split("@")[0].replace(/\D/g, "");
        if (!numero) return;
        db.adicionarNaBlacklist(numero, "whatsapp");
        console.log(`🚫 ${numero} pediu pra não receber mais mensagens — adicionado à blacklist automaticamente.`);
      } catch {
        // Nunca deixa um erro aqui derrubar a conexão do WhatsApp
      }
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

    function chaveHoje() {
      return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }

    // ==================== SERVIDORES DE E-MAIL (multi-provedor) ====================

    // Cada provedor tem seu próprio host/porta de SMTP. "gmail" usa o
    // atalho "service" do nodemailer (já testado e funcionando); os
    // outros usam host/porta explícitos pra não depender da lista interna
    // de "serviços conhecidos" do nodemailer, que pode mudar de versão
    // pra versão.
    const CONFIG_PROVEDOR = {
      gmail: { service: "gmail" },
      outlook: { host: "smtp.office365.com", port: 587, secure: false },
      zoho: { host: "smtp.zoho.com", port: 465, secure: true },
      hostinger: { host: "smtp.hostinger.com", port: 465, secure: true },
      godaddy: { host: "smtpout.secureserver.net", port: 465, secure: true },
    };

    function criarTransportador(servidor) {
      const base =
        servidor.provedor === "custom"
          ? { host: servidor.host, port: servidor.porta, secure: Boolean(servidor.seguro) }
          : CONFIG_PROVEDOR[servidor.provedor] || CONFIG_PROVEDOR.gmail;
      return nodemailer.createTransport({
        ...base,
        auth: { user: servidor.usuario, pass: servidor.senha },
        // Sem isso, uma rede com problema (ou credencial que nunca responde)
        // deixaria "Testar conexão" ou um envio pendurado pra sempre.
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
      });
    }

    // O mesmo, só que pra IMAP (leitura da caixa de entrada) — usado pra
    // detectar resposta negativa recebida por e-mail. Só funciona pros
    // provedores conhecidos; "custom" não tem host de IMAP cadastrado.
    const CONFIG_IMAP_PROVEDOR = {
      gmail: { host: "imap.gmail.com", port: 993 },
      outlook: { host: "outlook.office365.com", port: 993 },
      zoho: { host: "imap.zoho.com", port: 993 },
      hostinger: { host: "imap.hostinger.com", port: 993 },
      godaddy: { host: "imap.secureserver.net", port: 993 },
    };

    // Checa a caixa de entrada de cada conta de e-mail cadastrada em busca
    // de respostas com palavras de descadastro — igual ao que já fazemos
    // pra mensagens recebidas no WhatsApp, mas aqui via IMAP. Só olha
    // e-mails novos desde a última checagem (guardado por conta no banco);
    // na primeira vez que roda pra uma conta, só marca "a partir de agora"
    // e não varre o histórico inteiro da caixa de entrada.
    async function verificarRespostasNegativasPorEmail() {
      const servidores = db.listarServidoresEmail({ apenasAtivos: true }).filter((s) => s.provedor !== "custom");

      for (const servidor of servidores) {
        const configImap = CONFIG_IMAP_PROVEDOR[servidor.provedor];
        if (!configImap) continue;

        let client = null;
        try {
          client = new ImapFlow({
            host: configImap.host,
            port: configImap.port,
            secure: true,
            auth: { user: servidor.usuario, pass: servidor.senha },
            logger: false,
            socketTimeout: 20000,
          });
          await client.connect();
          const caixa = await client.mailboxOpen("INBOX");

          if (!servidor.ultimo_uid_imap) {
            // Primeira vez checando essa conta: não varre o histórico,
            // só marca a partir de onde a caixa está agora.
            db.atualizarUltimoUidImap(servidor.id, caixa.uidNext - 1);
            await client.logout();
            continue;
          }

          const inicio = servidor.ultimo_uid_imap + 1;
          if (inicio >= caixa.uidNext) {
            await client.logout();
            continue; // nada novo desde a última checagem
          }

          const mensagens = await client.fetchAll(`${inicio}:*`, { envelope: true, source: true }, { uid: true });
          let maiorUid = servidor.ultimo_uid_imap;

          for (const msg of mensagens) {
            maiorUid = Math.max(maiorUid, msg.uid);
            try {
              const parsed = await simpleParser(msg.source);
              const textoNormalizado = `${parsed.subject || ""} ${parsed.text || ""}`
                .toLowerCase()
                .normalize("NFD")
                .replace(/[̀-ͯ]/g, "");
              const pareceDescadastro = PALAVRAS_DESCADASTRO.some((palavra) => textoNormalizado.includes(palavra));
              if (!pareceDescadastro) continue;

              const remetente = parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0].address : null;
              if (!remetente) continue;
              db.adicionarNaBlacklist(remetente, "descadastro");
              console.log(`🚫 ${remetente} pediu descadastro por e-mail — adicionado à blacklist automaticamente.`);
            } catch (err) {
              console.log("⚠️ Erro ao processar um e-mail recebido:", err.message);
            }
          }

          db.atualizarUltimoUidImap(servidor.id, maiorUid);
          await client.logout();
        } catch (err) {
          console.log(`⚠️ Não consegui checar a caixa de entrada de ${servidor.usuario}:`, err.message);
          if (client) {
            try {
              await client.logout();
            } catch {
              // já desconectado, ignora
            }
          }
        }
      }
    }

    // Erros do Gmail/SMTP que indicam bloqueio/limite (vs. erro pontual,
    // tipo e-mail de destino inválido, que não deve trocar de remetente)
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

    // Erros que indicam que o endereço de destino simplesmente não existe
    // (bounce) — nesse caso, o e-mail entra sozinho na blacklist, porque
    // não faz sentido tentar mandar pra ele de novo numa próxima campanha.
    function pareceEnderecoInexistente(err) {
      const msg = ((err && err.message) || "").toLowerCase();
      return (
        msg.includes("does not exist") ||
        msg.includes("user unknown") ||
        msg.includes("no such user") ||
        msg.includes("recipient address rejected") ||
        msg.includes("mailbox unavailable") ||
        msg.includes("5.1.1")
      );
    }

    // Lê todos os remetentes cadastrados no .env, no formato:
    //   GMAIL_USER_1 / GMAIL_APP_PASSWORD_1
    //   GMAIL_USER_2 / GMAIL_APP_PASSWORD_2 ...
    // Também aceita o formato antigo (GMAIL_USER / GMAIL_APP_PASSWORD).
    // Roda só uma vez, na primeira inicialização — a partir daí, contas
    // de e-mail vivem no banco de dados (tela de Servidores de E-mail),
    // não mais no .env.
    function migrarRemetentesDoEnvParaBanco() {
      const doEnv = [];
      if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
        doEnv.push({ email: process.env.GMAIL_USER, senha: process.env.GMAIL_APP_PASSWORD });
      }
      let i = 1;
      while (process.env[`GMAIL_USER_${i}`]) {
        const email = process.env[`GMAIL_USER_${i}`];
        const senha = process.env[`GMAIL_APP_PASSWORD_${i}`];
        if (email && senha) doEnv.push({ email, senha });
        i++;
      }

      const existentes = new Set(db.listarServidoresEmail().map((s) => s.usuario));
      for (const conta of doEnv) {
        if (existentes.has(conta.email)) continue;
        db.criarServidorEmail({
          apelido: conta.email,
          provedor: "gmail",
          host: null,
          porta: null,
          seguro: true,
          usuario: conta.email,
          senha: conta.senha,
        });
        console.log(`ℹ️  Conta ${conta.email} migrada do .env para a tela de Servidores de E-mail.`);
      }
    }

    // ==================== ROTAÇÃO DE REMETENTES ====================

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
    function estadoDeHoje(controle, usuario) {
      const hoje = chaveHoje();
      const registro = controle[usuario];
      if (!registro || registro.data !== hoje) {
        return { data: hoje, enviados: 0, bloqueado: false };
      }
      return registro;
    }

    function registrarEnvioRemetente(usuario) {
      const controle = lerControleRemetentes();
      const estado = estadoDeHoje(controle, usuario);
      estado.enviados += 1;
      controle[usuario] = estado;
      salvarControleRemetentes(controle);
    }

    function registrarBloqueioRemetente(usuario) {
      const controle = lerControleRemetentes();
      const estado = estadoDeHoje(controle, usuario);
      estado.bloqueado = true;
      controle[usuario] = estado;
      salvarControleRemetentes(controle);
    }

    // Escolhe o próximo remetente disponível (não bloqueado, abaixo do
    // limite diário), ignorando os que já falharam nessa mesma rodada.
    function proximoRemetenteDisponivel(remetentes, jaTentados) {
      const controle = lerControleRemetentes();
      for (const r of remetentes) {
        if (jaTentados.has(r.usuario)) continue;
        const estado = estadoDeHoje(controle, r.usuario);
        if (estado.bloqueado) continue;
        if (estado.enviados >= LIMITE_DIARIO_POR_REMETENTE) continue;
        return r;
      }
      return null;
    }

    // Tenta enviar um e-mail, trocando de remetente automaticamente se um
    // deles estiver bloqueado ou tiver batido o limite do dia. Se o erro
    // parecer um endereço que não existe, o destinatário entra sozinho
    // na blacklist (bounce automático).
    async function enviarComRotacao(remetentes, destinatario, assunto, texto, campanhaId) {
      const jaTentados = new Set();

      while (true) {
        const remetente = proximoRemetenteDisponivel(remetentes, jaTentados);
        if (!remetente) {
          throw new Error("Nenhum remetente disponível (todos bloqueados ou no limite diário).");
        }

        const transporter = criarTransportador(remetente);

        try {
          await transporter.sendMail({ from: remetente.usuario, to: destinatario, subject: assunto, html: texto });
          registrarEnvioRemetente(remetente.usuario);
          return { remetenteUsado: remetente.usuario };
        } catch (err) {
          jaTentados.add(remetente.usuario);
          if (pareceEnderecoInexistente(err)) {
            db.adicionarNaBlacklist(destinatario, "bounce", campanhaId);
            console.log(`🚫 ${destinatario} não existe — adicionado à blacklist automaticamente.`);
          }
          if (pareceBloqueioDeConta(err)) {
            registrarBloqueioRemetente(remetente.usuario);
            console.log(`⚠️  Remetente ${remetente.usuario} parece bloqueado/no limite. Tentando o próximo...`);
            continue; // tenta o próximo remetente
          }
          // Erro que não é de bloqueio de conta — não adianta trocar de remetente
          throw err;
        }
      }
    }

    // ==================== EXECUÇÃO DE CAMPANHA ====================

    // Núcleo do envio: usado tanto pela tela de "envio rápido" quanto
    // pelas campanhas salvas/agendadas — assim o log de entrega e a
    // blacklist funcionam do mesmo jeito nos dois casos.
    async function executarCampanha(campanha) {
      const resultados = [];

      if (campanha.canal === "whatsapp") {
        if (whatsappStatus !== "conectado") {
          throw new Error("WhatsApp ainda não está conectado. Escaneie o QR Code primeiro.");
        }

        if (campanha.tipo_destino === "planilha") {
          const contatos = lerContatos().filter((c) => c.telefone);
          for (const contato of contatos) {
            const numero = formatarTelefone(contato.telefone);
            if (numero && db.estaNaBlacklist(numero)) {
              db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.telefone, nomeContato: contato.nome, canal: "whatsapp", status: "bloqueado_blacklist" });
              resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "bloqueado", detalhe: "na blacklist" });
              continue;
            }
            try {
              const base = contato.mensagem || campanha.mensagem;
              if (!base || !base.trim()) {
                db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.telefone, nomeContato: contato.nome, canal: "whatsapp", status: "erro", detalhe: "sem mensagem" });
                resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "erro", detalhe: "sem mensagem (nem individual, nem padrão)" });
                continue;
              }
              const chatId = await resolverChatId(contato.telefone);
              if (!chatId) {
                db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.telefone, nomeContato: contato.nome, canal: "whatsapp", status: "erro", detalhe: "número não está no WhatsApp" });
                resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "erro", detalhe: "número não está no WhatsApp" });
                continue;
              }
              const texto = personalizar(base, contato);
              await waClient.sendMessage(chatId, texto);
              db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.telefone, nomeContato: contato.nome, canal: "whatsapp", status: "enviado" });
              resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "enviado" });
            } catch (err) {
              db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.telefone, nomeContato: contato.nome, canal: "whatsapp", status: "erro", detalhe: err.message });
              resultados.push({ destino: `${contato.nome} (${contato.telefone})`, status: "erro", detalhe: err.message });
            }
            await delay(8000 + Math.random() * 7000); // 8-15s entre mensagens
          }
        } else {
          // "unico" ou "grupo": um destino só
          const numero = formatarTelefone(campanha.destino);
          if (numero && db.estaNaBlacklist(numero)) {
            db.registrarEnvioLog({ campanhaId: campanha.id, destino: campanha.destino, canal: "whatsapp", status: "bloqueado_blacklist" });
            resultados.push({ destino: campanha.destino, status: "bloqueado", detalhe: "na blacklist" });
          } else {
            const chatId = await resolverChatId(campanha.destino);
            if (!chatId) {
              throw new Error("Esse número não está no WhatsApp (ou o formato está incorreto).");
            }
            await waClient.sendMessage(chatId, campanha.mensagem);
            db.registrarEnvioLog({ campanhaId: campanha.id, destino: campanha.destino, canal: "whatsapp", status: "enviado" });
            resultados.push({ destino: campanha.destino, status: "enviado" });
          }
        }
      } else if (campanha.canal === "email") {
        const remetentes = campanha.servidor_email_id
          ? [db.obterServidorEmail(campanha.servidor_email_id)].filter((s) => s && s.ativo)
          : db.listarServidoresEmail({ apenasAtivos: true });
        if (remetentes.length === 0) {
          throw new Error("Nenhum servidor de e-mail ativo cadastrado.");
        }

        const contatos = lerContatos().filter((c) => c.email);
        for (const contato of contatos) {
          if (db.estaNaBlacklist(contato.email)) {
            db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.email, nomeContato: contato.nome, canal: "email", status: "bloqueado_blacklist" });
            resultados.push({ destino: `${contato.nome} (${contato.email})`, status: "bloqueado", detalhe: "na blacklist" });
            continue;
          }
          try {
            const base = contato.mensagem || campanha.mensagem;
            if (!base || !base.trim()) {
              db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.email, nomeContato: contato.nome, canal: "email", status: "erro", detalhe: "sem mensagem" });
              resultados.push({ destino: `${contato.nome} (${contato.email})`, status: "erro", detalhe: "sem mensagem (nem individual, nem padrão)" });
              continue;
            }
            const texto = personalizar(base, contato);
            const { remetenteUsado } = await enviarComRotacao(remetentes, contato.email, campanha.assunto, texto, campanha.id);
            db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.email, nomeContato: contato.nome, canal: "email", status: "enviado", detalhe: `via ${remetenteUsado}` });
            resultados.push({ destino: `${contato.nome} (${contato.email})`, status: "enviado", detalhe: `via ${remetenteUsado}` });
          } catch (err) {
            db.registrarEnvioLog({ campanhaId: campanha.id, destino: contato.email, nomeContato: contato.nome, canal: "email", status: "erro", detalhe: err.message });
            resultados.push({ destino: `${contato.nome} (${contato.email})`, status: "erro", detalhe: err.message });
          }
          await delay(2000); // 2s entre e-mails, ritmo mais tranquilo que o WhatsApp
        }
      }

      db.atualizarCampanha(campanha.id, { status: "concluida" });
      return resultados;
    }

    // ==================== AGENDAMENTO ====================

    function diaDaSemanaHoje() {
      return new Date().getDay(); // 0=domingo ... 6=sábado
    }

    function horaAtualHHMM() {
      const agora = new Date();
      return `${String(agora.getHours()).padStart(2, "0")}:${String(agora.getMinutes()).padStart(2, "0")}`;
    }

    async function verificarAgendamentos() {
      const hoje = chaveHoje();
      const horaAgora = horaAtualHHMM();
      const diaSemana = diaDaSemanaHoje();

      const campanhas = db.listarCampanhas().filter((c) => c.agendamento_dias && c.agendamento_hora);
      for (const campanha of campanhas) {
        if (campanha.ultima_execucao === hoje) continue; // já rodou hoje
        let dias;
        try {
          dias = JSON.parse(campanha.agendamento_dias);
        } catch {
          continue;
        }
        if (!Array.isArray(dias) || !dias.includes(diaSemana)) continue;
        if (horaAgora < campanha.agendamento_hora) continue; // ainda não chegou a hora

        console.log(`⏰ Disparando campanha agendada: "${campanha.nome}"`);
        db.marcarExecucaoCampanha(campanha.id, hoje);
        try {
          await executarCampanha(campanha);
        } catch (err) {
          console.log(`⚠️  Erro ao executar campanha agendada "${campanha.nome}":`, err.message);
          db.atualizarCampanha(campanha.id, { status: "erro" });
        }
      }
    }

    temporizadorAgendamento = setInterval(() => {
      verificarAgendamentos().catch(() => {});
    }, 60 * 1000);
    setTimeout(() => verificarAgendamentos().catch(() => {}), 15 * 1000);

    // Checagem de respostas negativas por e-mail: a cada 5 minutos é
    // suficiente (não precisa ser em tempo real) e evita sobrecarregar a
    // conexão IMAP das contas cadastradas.
    temporizadorRespostasEmail = setInterval(() => {
      verificarRespostasNegativasPorEmail().catch(() => {});
    }, 5 * 60 * 1000);
    setTimeout(() => verificarRespostasNegativasPorEmail().catch(() => {}), 30 * 1000);

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
      conteudo += `PORTA=${PORTA_PREFERIDA}\n`;
      conteudo += `SESSAO_SEGREDO=${crypto.randomBytes(32).toString("hex")}\n`;

      try {
        fs.writeFileSync(ARQUIVO_ENV, conteudo, "utf8");
      } catch (err) {
        return res.status(500).json({ erro: `Não consegui salvar o arquivo .env: ${err.message}` });
      }

      // Aplica na hora, sem precisar reiniciar o programa
      require("dotenv").config({ path: ARQUIVO_ENV });

      if (gmailUser && gmailUser.trim() && gmailSenha && gmailSenha.trim()) {
        db.criarServidorEmail({
          apelido: gmailUser.trim(),
          provedor: "gmail",
          host: null,
          porta: null,
          seguro: true,
          usuario: gmailUser.trim(),
          senha: gmailSenha.trim(),
        });
      }

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

    // ---------- Envio rápido (avulso) — cria uma campanha por trás dos
    // panos, pra tudo que é enviado ficar registrado no mesmo lugar ----------

    app.post("/enviar/whatsapp", async (req, res) => {
      const { tipoDestino, destino, mensagem } = req.body;

      if (whatsappStatus !== "conectado") {
        return res.status(400).json({ erro: "WhatsApp ainda não está conectado. Escaneie o QR Code primeiro." });
      }
      if (tipoDestino !== "planilha" && (!mensagem || !mensagem.trim())) {
        return res.status(400).json({ erro: "Mensagem vazia." });
      }
      if (tipoDestino !== "planilha" && (!destino || !destino.trim())) {
        return res.status(400).json({ erro: "Informe o destino (número ou ID do grupo)." });
      }

      const campanha = db.criarCampanha({
        nome: `Envio rápido — ${new Date().toLocaleString("pt-BR")}`,
        canal: "whatsapp",
        tipoDestino,
        destino,
        mensagem,
      });

      try {
        const resultados = await executarCampanha(campanha);
        res.json({ ok: true, resultados });
      } catch (err) {
        db.atualizarCampanha(campanha.id, { status: "erro" });
        res.status(500).json({ erro: err.message });
      }
    });

    app.post("/enviar/email", async (req, res) => {
      const { assunto, mensagem } = req.body;

      if (!assunto || !assunto.trim()) {
        return res.status(400).json({ erro: "Informe o assunto do e-mail." });
      }

      const campanha = db.criarCampanha({
        nome: `Envio rápido — ${new Date().toLocaleString("pt-BR")}`,
        canal: "email",
        assunto,
        mensagem,
      });

      try {
        const resultados = await executarCampanha(campanha);
        res.json({ ok: true, resultados });
      } catch (err) {
        db.atualizarCampanha(campanha.id, { status: "erro" });
        res.status(400).json({ erro: err.message });
      }
    });

    // ==================== SERVIDORES DE E-MAIL ====================

    app.get("/api/servidores-email", (req, res) => {
      const servidores = db.listarServidoresEmail().map((s) => ({ ...s, senha: undefined }));
      res.json({ servidores });
    });

    app.post("/api/servidores-email", (req, res) => {
      const { apelido, provedor, host, porta, seguro, usuario, senha } = req.body || {};
      if (!apelido || !provedor || !usuario || !senha) {
        return res.status(400).json({ erro: "Preencha apelido, provedor, usuário e senha." });
      }
      if (provedor === "custom" && (!host || !porta)) {
        return res.status(400).json({ erro: "Provedor customizado precisa de host e porta." });
      }
      try {
        const servidor = db.criarServidorEmail({ apelido, provedor, host, porta, seguro, usuario, senha });
        res.json({ ok: true, servidor: { ...servidor, senha: undefined } });
      } catch (err) {
        res.status(400).json({ erro: err.message.includes("UNIQUE") ? "Já existe um servidor com esse usuário." : err.message });
      }
    });

    app.put("/api/servidores-email/:id", (req, res) => {
      const servidor = db.atualizarServidorEmail(Number(req.params.id), req.body || {});
      if (!servidor) return res.status(404).json({ erro: "Servidor não encontrado." });
      res.json({ ok: true, servidor: { ...servidor, senha: undefined } });
    });

    app.delete("/api/servidores-email/:id", (req, res) => {
      db.excluirServidorEmail(Number(req.params.id));
      res.json({ ok: true });
    });

    app.post("/api/servidores-email/:id/testar", async (req, res) => {
      const servidor = db.obterServidorEmail(Number(req.params.id));
      if (!servidor) return res.status(404).json({ erro: "Servidor não encontrado." });
      try {
        const transporter = criarTransportador(servidor);
        await transporter.verify();
        res.json({ ok: true, mensagem: "Conexão feita com sucesso!" });
      } catch (err) {
        res.status(400).json({ erro: `Falha na conexão: ${err.message}` });
      }
    });

    // ==================== BLACKLIST ====================

    app.get("/api/blacklist", (req, res) => {
      res.json({ blacklist: db.listarBlacklist() });
    });

    app.post("/api/blacklist", (req, res) => {
      const { valor } = req.body || {};
      if (!valor || !valor.trim()) return res.status(400).json({ erro: "Informe um e-mail ou telefone." });
      db.adicionarNaBlacklist(valor.trim(), "manual");
      res.json({ ok: true });
    });

    app.delete("/api/blacklist/:valor", (req, res) => {
      db.removerDaBlacklist(decodeURIComponent(req.params.valor));
      res.json({ ok: true });
    });

    // ==================== CAMPANHAS ====================

    app.get("/api/campanhas", (req, res) => {
      res.json({ campanhas: db.listarCampanhas() });
    });

    app.get("/api/campanhas/:id", (req, res) => {
      const campanha = db.obterCampanha(Number(req.params.id));
      if (!campanha) return res.status(404).json({ erro: "Campanha não encontrada." });
      res.json({
        campanha,
        resumo: db.resumoDaCampanha(campanha.id),
        envios: db.listarEnviosDaCampanha(campanha.id),
      });
    });

    app.post("/api/campanhas", (req, res) => {
      const { nome, canal, tipoDestino, destino, assunto, mensagem, servidorEmailId, agendamentoDias, agendamentoHora } = req.body || {};
      if (!nome || !nome.trim()) return res.status(400).json({ erro: "Dê um nome pra campanha." });
      if (!canal || !["whatsapp", "email"].includes(canal)) return res.status(400).json({ erro: "Canal inválido." });
      if (!mensagem || !mensagem.trim()) return res.status(400).json({ erro: "Escreva a mensagem da campanha." });
      if (agendamentoDias && agendamentoDias.length > 0 && !agendamentoHora) {
        return res.status(400).json({ erro: "Defina um horário pro agendamento." });
      }
      const campanha = db.criarCampanha({ nome, canal, tipoDestino, destino, assunto, mensagem, servidorEmailId, agendamentoDias, agendamentoHora });
      res.json({ ok: true, campanha });
    });

    app.put("/api/campanhas/:id", (req, res) => {
      const campanha = db.atualizarCampanha(Number(req.params.id), req.body || {});
      if (!campanha) return res.status(404).json({ erro: "Campanha não encontrada." });
      res.json({ ok: true, campanha });
    });

    app.delete("/api/campanhas/:id", (req, res) => {
      db.excluirCampanha(Number(req.params.id));
      res.json({ ok: true });
    });

    app.post("/api/campanhas/:id/enviar", async (req, res) => {
      const campanha = db.obterCampanha(Number(req.params.id));
      if (!campanha) return res.status(404).json({ erro: "Campanha não encontrada." });
      db.atualizarCampanha(campanha.id, { status: "enviando" });
      try {
        const resultados = await executarCampanha(campanha);
        db.marcarExecucaoCampanha(campanha.id, chaveHoje());
        res.json({ ok: true, resultados });
      } catch (err) {
        db.atualizarCampanha(campanha.id, { status: "erro" });
        res.status(400).json({ erro: err.message });
      }
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

// Encerra tudo de forma limpa: fecha o servidor HTTP, o agendador, o
// banco de dados e desliga o WhatsApp (que por baixo dos panos mantém um
// Chromium aberto — se não fechar direito, ele continua rodando escondido
// e "trava" a próxima abertura).
async function encerrarServidor() {
  const tarefas = [];

  if (temporizadorAgendamento) {
    clearInterval(temporizadorAgendamento);
    temporizadorAgendamento = null;
  }

  if (temporizadorRespostasEmail) {
    clearInterval(temporizadorRespostasEmail);
    temporizadorRespostasEmail = null;
  }

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
  db.fecharBanco();
}

module.exports = { iniciarServidor, encerrarServidor };
