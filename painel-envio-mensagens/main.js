/**
 * Processo principal do Electron.
 * -----------------------------------------------------------------
 * Resolve os dois problemas que o programa tinha como script solto
 * (.vbs + .bat + Node "cru"):
 *
 *   1. "Fechar não fecha": ao fechar a janela, este arquivo desliga o
 *      servidor E o WhatsApp (que por baixo mantém um Chromium aberto)
 *      antes de encerrar o processo — nada fica rodando escondido.
 *
 *   2. "Abrir de novo não abre": usa uma trava de instância única do
 *      Electron. Se o programa já está aberto e o usuário clica no
 *      atalho de novo, em vez de tentar abrir uma segunda cópia (que
 *      falharia porque a porta já está em uso), só traz a janela que
 *      já existe pra frente.
 */

const { app, BrowserWindow, Menu, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { iniciarServidor, encerrarServidor } = require("./server");

const ICONE = path.join(__dirname, "icone-painel.ico");

let mainWindow = null;
let encerrando = false;

const temTravaUnica = app.requestSingleInstanceLock();

if (!temTravaUnica) {
  // Já existe uma cópia rodando — não faz nada além de deixar a outra
  // instância (o listener "second-instance" abaixo) trazer a janela dela
  // para frente, e sai imediatamente.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(iniciar);

  app.on("window-all-closed", encerrarTudoEQuitar);
}

// O Chromium usado pelo WhatsApp vem empacotado junto com o programa (não
// depende de baixar nada nem de ter Chrome/Edge instalado). Essa pasta é
// baixada em ".chromium-cache" na hora de preparar o build (veja
// "npm run instalar-dependencias") e vai junto no instalador.
function configurarCacheDoChromium() {
  const pastaCache = app.isPackaged
    ? path.join(process.resourcesPath, "chromium-cache")
    : path.join(__dirname, ".chromium-cache");
  if (fs.existsSync(pastaCache)) {
    process.env.PUPPETEER_CACHE_DIR = pastaCache;
  }
}

function obterDataDir() {
  // Empacotado: dados do usuário (contatos, .env, sessão do WhatsApp)
  // ficam na pasta de perfil do Windows — sempre gravável, sem precisar
  // de permissão de administrador. Em desenvolvimento, usa a própria
  // pasta do projeto, como antes.
  return app.isPackaged ? app.getPath("userData") : __dirname;
}

async function iniciar() {
  Menu.setApplicationMenu(null);
  configurarCacheDoChromium();

  try {
    const { porta } = await iniciarServidor({ dataDir: obterDataDir() });
    criarJanela(porta);
  } catch (err) {
    dialog.showErrorBox(
      "Não consegui iniciar o Painel",
      `Ocorreu um erro ao iniciar o programa:\n\n${err.message}\n\nFeche outros programas que possam estar usando a mesma porta e tente novamente.`
    );
    app.quit();
  }
}

function criarJanela(porta) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 480,
    minHeight: 600,
    icon: ICONE,
    title: "Painel de Envio de Mensagens",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${porta}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function encerrarTudoEQuitar() {
  if (encerrando) return;
  encerrando = true;

  // Dá um tempo curto pro WhatsApp/servidor encerrarem direito, mas nunca
  // deixa o programa preso pra sempre: se demorar demais, força a saída.
  const espera = encerrarServidor().catch(() => {});
  const limite = new Promise((resolve) => setTimeout(resolve, 5000));
  await Promise.race([espera, limite]);

  app.quit();
  // Garantia extra: se algo (ex.: o Chromium do WhatsApp) ainda segurar o
  // processo vivo, força o encerramento mesmo assim.
  setTimeout(() => app.exit(0), 1000);
}

app.on("before-quit", (event) => {
  if (encerrando) return;
  event.preventDefault();
  encerrarTudoEQuitar();
});
