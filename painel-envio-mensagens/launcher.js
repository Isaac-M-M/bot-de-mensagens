/**
 * Launcher do Painel de Envio de Mensagens.
 * -----------------------------------------------------------------
 * Feito em Node.js (em vez de lógica complexa no .bat) justamente para
 * não quebrar com pastas que têm espaço, parênteses ou acentos no nome
 * — problema comum em scripts de terminal do Windows.
 *
 * O que ele faz:
 *   1. Instala as dependências, se ainda não tiver feito (node_modules)
 *   2. Avisa se o .env não existe
 *   3. Inicia o servidor (server.js)
 *   4. Abre o navegador automaticamente, em modo "app" (sem barra de
 *      endereço) se achar Chrome ou Edge instalado, ou no navegador
 *      padrão como alternativa
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
process.chdir(ROOT);

const PORTA = process.env.PORTA || 3000;
const URL = `http://localhost:${PORTA}`;

function instalarDependenciasSeNecessario() {
  if (fs.existsSync(path.join(ROOT, "node_modules"))) return;
  console.log("============================================");
  console.log(" Primeira vez rodando - instalando tudo...");
  console.log(" Isso pode levar alguns minutos, aguarde.");
  console.log("============================================");
  execSync("npm install", { stdio: "inherit", cwd: ROOT });
}

function avisarSeFaltaEnv() {
  if (fs.existsSync(path.join(ROOT, ".env"))) return;
  console.log("");
  console.log("ℹ️  Primeira execução: abra o navegador para concluir a configuração inicial (usuário, senha, e opcionalmente o Gmail).");
  console.log("");
}

function encontrarNavegador() {
  if (process.platform !== "win32") return null;
  const candidatos = [
    combinar(process.env["ProgramFiles"], "Google", "Chrome", "Application", "chrome.exe"),
    combinar(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    combinar(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    combinar(process.env["ProgramFiles"], "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidatos.find((p) => p && fs.existsSync(p)) || null;
}

function combinar(base, ...partes) {
  if (!base) return null;
  return path.join(base, ...partes);
}

function abrirNavegador() {
  try {
    if (process.platform === "win32") {
      const navegador = encontrarNavegador();
      if (navegador) {
        // spawn com array de argumentos: o Node cuida da formatação certa
        // do comando por baixo dos panos, mesmo com espaços/parênteses
        // no caminho — não depende da gente escrever aspas na mão.
        spawn(navegador, [`--app=${URL}`], { detached: true, stdio: "ignore" }).unref();
        return;
      }
      spawn("cmd", ["/c", "start", "", URL], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [URL], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [URL], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    console.log(`Não consegui abrir o navegador automaticamente (${err.message}).`);
    console.log(`Abra manualmente: ${URL}`);
  }
}

instalarDependenciasSeNecessario();
avisarSeFaltaEnv();

console.log("");
console.log("Iniciando o painel... a janela vai abrir sozinha em alguns segundos.");
console.log("NÃO FECHE ESTA JANELA enquanto estiver usando o painel.");
console.log("");

// Inicia o servidor no mesmo processo
require("./server.js");

// Dá um tempo pro servidor subir antes de abrir o navegador
setTimeout(abrirNavegador, 4000);
