# Instalador do Painel de Envio de Mensagens
# -----------------------------------------------------------------
# O que este script faz, na ordem:
#   1. Verifica se o Node.js esta instalado; se nao estiver, baixa e
#      instala automaticamente (pode pedir permissao de administrador)
#   2. Instala as dependencias do projeto (npm install)
#   3. Cria um atalho "Painel de Envio de Mensagens" na Area de
#      Trabalho, ja com o icone certo, apontando para "Abrir Painel.vbs"
#   4. Oferece para abrir o painel na hora
#
# Se alguma etapa falhar (ex: sem internet, politica de seguranca do
# Windows bloqueando), o script avisa em vez de travar silenciosamente.

$ErrorActionPreference = "Stop"
$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $raiz

function Escrever($texto, $cor = "White") {
    Write-Host $texto -ForegroundColor $cor
}

Escrever "=================================================="
Escrever " Instalador - Painel de Envio de Mensagens"
Escrever "=================================================="
Escrever ""

# ---------- 1. Node.js ----------
$nodeOk = $false
try {
    $versao = (node -v) 2>$null
    if ($versao) {
        Escrever "Node.js ja esta instalado ($versao)." "Green"
        $nodeOk = $true
    }
} catch {
    $nodeOk = $false
}

if (-not $nodeOk) {
    Escrever "Node.js nao encontrado. Vou baixar e instalar automaticamente..." "Yellow"
    Escrever "(isso pode pedir permissao de administrador do Windows)" "Yellow"
    try {
        $urlNode = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
        $instaladorNode = Join-Path $env:TEMP "node-installer.msi"
        Escrever "Baixando Node.js..."
        Invoke-WebRequest -Uri $urlNode -OutFile $instaladorNode -UseBasicParsing
        Escrever "Instalando Node.js..."
        Start-Process msiexec.exe -ArgumentList "/i `"$instaladorNode`" /quiet /norestart" -Wait
        $pathMachine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        $pathUser = [System.Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = $pathMachine + ";" + $pathUser
        Escrever "Node.js instalado com sucesso." "Green"
    } catch {
        Escrever ""
        Escrever "ERRO: nao consegui instalar o Node.js automaticamente." "Red"
        Escrever "Motivo: $($_.Exception.Message)" "Red"
        Escrever ""
        Escrever "Instale manualmente em https://nodejs.org (baixe a versao LTS)," "Yellow"
        Escrever "depois rode este instalador de novo." "Yellow"
        Read-Host "Pressione ENTER para sair"
        exit 1
    }
}

# ---------- 2. Dependencias do projeto ----------
Escrever ""
Escrever "Instalando dependencias do painel (pode levar alguns minutos)..."
try {
    npm install
} catch {
    Escrever ""
    Escrever "ERRO ao instalar as dependencias do painel." "Red"
    Escrever "Motivo: $($_.Exception.Message)" "Red"
    Read-Host "Pressione ENTER para sair"
    exit 1
}

# ---------- 3. Atalho na Area de Trabalho ----------
Escrever ""
Escrever "Criando atalho na Area de Trabalho..."
try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $caminhoAtalho = Join-Path $desktop "Painel de Envio de Mensagens.lnk"
    $caminhoAlvo = Join-Path $raiz "Abrir Painel.vbs"
    $caminhoIcone = Join-Path $raiz "icone-painel.ico"

    $wshShell = New-Object -ComObject WScript.Shell
    $atalho = $wshShell.CreateShortcut($caminhoAtalho)
    $atalho.TargetPath = $caminhoAlvo
    $atalho.WorkingDirectory = $raiz
    if (Test-Path $caminhoIcone) {
        $atalho.IconLocation = $caminhoIcone
    }
    $atalho.Save()

    Escrever "Atalho criado na Area de Trabalho." "Green"
} catch {
    Escrever ""
    Escrever "AVISO: nao consegui criar o atalho automaticamente." "Yellow"
    Escrever "Motivo: $($_.Exception.Message)" "Yellow"
    Escrever "Voce ainda pode usar o painel abrindo Abrir Painel.vbs manualmente nesta pasta." "Yellow"
}

# ---------- 4. Finalizacao ----------
Escrever ""
Escrever "=================================================="
Escrever " Instalacao concluida!" "Green"
Escrever "=================================================="
Escrever ""
Escrever "A partir de agora, use o atalho Painel de Envio de Mensagens"
Escrever "que foi criado na sua Area de Trabalho."
Escrever ""

$resposta = Read-Host "Quer abrir o painel agora? (S/N)"
if ($resposta -eq "S" -or $resposta -eq "s") {
    $alvoAbrir = Join-Path $raiz "Abrir Painel.vbs"
    Start-Process $alvoAbrir
}
