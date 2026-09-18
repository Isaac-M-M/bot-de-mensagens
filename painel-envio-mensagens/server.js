/**
 * Painel de Envio de Mensagens — WhatsApp e E-mail
 * -----------------------------------------------------------------
 * Interface web local para escrever uma mensagem, escolher o canal
 * (WhatsApp ou E-mail) e enviar — sem precisar mexer em código.
 *
 * COMO USAR:
 *   1. npm install
 *   2. Copie .env.example para .env e preencha com seu Gmail + senha de app
 *   3. Coloque sua lista de contatos em ./contatos.xlsx
 *      (colunas: nome, telefone, email — veja contatos-exemplo.xlsx)
 *   4. npm start
 *   5. Abra http://localhost:3000 no navegador
 *   6. Na primeira vez, escaneie o QR Code que aparece na própria página
 *      para conectar o WhatsApp
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const xlsx = require("xlsx");
const nodemailer = require("nodemailer");
const multer = require("multer");
const { Client, LocalAuth } = require("whatsapp-web.js");

const PORTA = process.env.PORTA || 3000;
const ARQUIVO_CONTATOS = "./contatos.xlsx";
const ARQUIVO_MODELO = "./contatos-exemplo.xlsx";
const ARQUIVO_CONTROLE_REMETENTES = "./controle-remetentes.json";

// Configuração do upload da planilha: salva sempre como contatos.xlsx,
// sobrescrevendo a anterior.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "."),
    filename: (req, file, cb) => cb(null, "contatos.xlsx"),
  }),
  fileFilter: (req, file, cb) => {
    const nomeValido = /\.xlsx$/i.test(file.originalname);
    if (!nomeValido) return cb(new Error("Envie um arquivo .xlsx"));
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Limite diário de envios por conta (o Gmail comum permite ~500/dia;
// deixamos uma margem de segurança abaixo disso).
const LIMITE_DIARIO_POR_REMETENTE = 400;

// ==================== ESTADO DO WHATSAPP ====================

let whatsappStatus = "iniciando"; // "iniciando" | "aguardando_qr" | "conectado"
let ultimoQrDataUrl = null;

const waClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

waClient.on("qr", async (qr) => {
  whatsappStatus = "aguardando_qr";
  ultimoQrDataUrl = await QRCode.toDataURL(qr);
  console.log("📱 Novo QR Code gerado — abra http://localhost:%d para escanear.", PORTA);
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

waClient.initialize();

// ==================== FUNÇÕES AUXILIARES ====================

function formatarTelefone(numero) {
  let digits = String(numero || "").replace(/\D/g, "");
  if (!digits) return null;
  if (!digits.startsWith("55")) digits = "55" + digits;
  return digits;
}

function resolverChatId(destino) {
  const valor = String(destino || "").trim();
  if (valor.endsWith("@g.us") || valor.endsWith("@c.us")) return valor;
  return `${formatarTelefone(valor)}@c.us`;
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
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const msg = (err && err.message || "").toLowerCase();
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
const ARQUIVO_ENV = path.join(__dirname, ".env");

function configuracaoInicialPendente() {
  return !fs.existsSync(ARQUIVO_ENV);
}

// Antes de qualquer outra coisa: se ainda não existe .env, mostra a tela
// de configuração inicial em vez do painel normal (e libera a rota que
// salva essa configuração, sem exigir login — ainda não há login definido).
app.post("/configuracao-inicial", express.json(), (req, res) => {
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
  conteudo += `PORTA=${PORTA}\n`;

  try {
    fs.writeFileSync(ARQUIVO_ENV, conteudo, "utf8");
  } catch (err) {
    return res.status(500).json({ erro: `Não consegui salvar o arquivo .env: ${err.message}` });
  }

  // Aplica na hora, sem precisar reiniciar o programa
  process.env.PAINEL_USUARIO = painelUsuario.trim();
  process.env.PAINEL_SENHA = painelSenha.trim();
  if (gmailUser && gmailUser.trim() && gmailSenha && gmailSenha.trim()) {
    process.env.GMAIL_USER_1 = gmailUser.trim();
    process.env.GMAIL_APP_PASSWORD_1 = gmailSenha.trim();
  }

  res.json({ ok: true });
});

app.get("/", (req, res, next) => {
  if (configuracaoInicialPendente()) {
    return res.sendFile(path.join(__dirname, "public", "configuracao-inicial.html"));
  }
  next();
});

// Proteção por senha (opcional, mas recomendada): se PAINEL_USUARIO e
// PAINEL_SENHA estiverem definidos no .env, exige login antes de
// qualquer acesso. Sem isso configurado, o painel fica aberto pra
// qualquer pessoa na mesma rede — então avisamos no console.
function autenticacaoBasica(req, res, next) {
  if (configuracaoInicialPendente()) return next(); // ainda não há login definido

  const usuario = process.env.PAINEL_USUARIO;
  const senha = process.env.PAINEL_SENHA;
  if (!usuario || !senha) return next();

  const header = req.headers.authorization || "";
  const [tipo, credenciais] = header.split(" ");
  if (tipo === "Basic" && credenciais) {
    const decodificado = Buffer.from(credenciais, "base64").toString("utf8");
    const separador = decodificado.indexOf(":");
    const u = decodificado.slice(0, separador);
    const p = decodificado.slice(separador + 1);
    if (u === usuario && p === senha) return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Painel de Envio de Mensagens"');
  return res.status(401).send("Acesso restrito. Informe usuário e senha configurados no .env.");
}

app.use(autenticacaoBasica);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

if (configuracaoInicialPendente()) {
  console.log("ℹ️  Primeira execução detectada — abra o painel no navegador para concluir a configuração inicial.");
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
      const chatId = resolverChatId(destino);
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
          const chatId = resolverChatId(contato.telefone);
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

app.listen(PORTA, () => {
  console.log(`\n🌐 Painel disponível em: http://localhost:${PORTA}\n`);
});
