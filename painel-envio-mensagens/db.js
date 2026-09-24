/**
 * Banco de dados local (SQLite) do painel.
 * -----------------------------------------------------------------
 * Guarda tudo que precisa sobreviver entre uma execução e outra:
 * campanhas, o log de cada envio, eventos de abertura/clique e a
 * blacklist. Fica na mesma pasta de dados do usuário (dataDir), do
 * lado do .env e da sessão do WhatsApp.
 */

const path = require("path");
const Database = require("better-sqlite3");

let db = null;

function iniciarBanco(dataDir) {
  db = new Database(path.join(dataDir, "painel.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS servidores_email (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      apelido TEXT NOT NULL,
      provedor TEXT NOT NULL,
      host TEXT,
      porta INTEGER,
      seguro INTEGER NOT NULL DEFAULT 1,
      usuario TEXT NOT NULL UNIQUE,
      senha TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campanhas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      canal TEXT NOT NULL,
      tipo_destino TEXT,
      destino TEXT,
      assunto TEXT,
      mensagem TEXT NOT NULL,
      servidor_email_id INTEGER REFERENCES servidores_email(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'rascunho',
      agendamento_dias TEXT,
      agendamento_hora TEXT,
      ultima_execucao TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS envios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campanha_id INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
      destino TEXT NOT NULL,
      nome_contato TEXT,
      canal TEXT NOT NULL,
      status TEXT NOT NULL,
      detalhe TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      detalhe TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      valor TEXT NOT NULL UNIQUE,
      motivo TEXT NOT NULL,
      campanha_id INTEGER,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_envios_campanha ON envios(campanha_id);
    CREATE INDEX IF NOT EXISTS idx_eventos_envio ON eventos(envio_id);
  `);

  return db;
}

function obterBanco() {
  if (!db) throw new Error("Banco de dados ainda não foi iniciado.");
  return db;
}

function fecharBanco() {
  if (db) {
    db.close();
    db = null;
  }
}

// ==================== SERVIDORES DE E-MAIL ====================

function listarServidoresEmail({ apenasAtivos = false } = {}) {
  const sql = apenasAtivos
    ? "SELECT * FROM servidores_email WHERE ativo = 1 ORDER BY id"
    : "SELECT * FROM servidores_email ORDER BY id";
  return obterBanco().prepare(sql).all();
}

function obterServidorEmail(id) {
  return obterBanco().prepare("SELECT * FROM servidores_email WHERE id = ?").get(id);
}

function criarServidorEmail({ apelido, provedor, host, porta, seguro, usuario, senha }) {
  const info = obterBanco()
    .prepare(
      `INSERT INTO servidores_email (apelido, provedor, host, porta, seguro, usuario, senha)
       VALUES (@apelido, @provedor, @host, @porta, @seguro, @usuario, @senha)`
    )
    .run({ apelido, provedor, host: host || null, porta: porta || null, seguro: seguro ? 1 : 0, usuario, senha });
  return obterServidorEmail(info.lastInsertRowid);
}

function atualizarServidorEmail(id, campos) {
  const atual = obterServidorEmail(id);
  if (!atual) return null;
  const dados = { ...atual, ...campos };
  obterBanco()
    .prepare(
      `UPDATE servidores_email SET apelido=@apelido, provedor=@provedor, host=@host, porta=@porta,
       seguro=@seguro, usuario=@usuario, senha=@senha, ativo=@ativo WHERE id=@id`
    )
    .run({ ...dados, seguro: dados.seguro ? 1 : 0, ativo: dados.ativo ? 1 : 0, id });
  return obterServidorEmail(id);
}

function excluirServidorEmail(id) {
  obterBanco().prepare("DELETE FROM servidores_email WHERE id = ?").run(id);
}

// ==================== BLACKLIST ====================

function normalizarContato(valor) {
  return String(valor || "").trim().toLowerCase();
}

function estaNaBlacklist(valor) {
  const v = normalizarContato(valor);
  if (!v) return false;
  return Boolean(obterBanco().prepare("SELECT 1 FROM blacklist WHERE valor = ?").get(v));
}

function adicionarNaBlacklist(valor, motivo, campanhaId = null) {
  const v = normalizarContato(valor);
  if (!v) return;
  obterBanco()
    .prepare(
      `INSERT INTO blacklist (valor, motivo, campanha_id) VALUES (?, ?, ?)
       ON CONFLICT(valor) DO NOTHING`
    )
    .run(v, motivo, campanhaId);
}

function removerDaBlacklist(valor) {
  obterBanco().prepare("DELETE FROM blacklist WHERE valor = ?").run(normalizarContato(valor));
}

function listarBlacklist() {
  return obterBanco().prepare("SELECT * FROM blacklist ORDER BY criado_em DESC").all();
}

// ==================== CAMPANHAS ====================

function listarCampanhas() {
  return obterBanco().prepare("SELECT * FROM campanhas ORDER BY criado_em DESC").all();
}

function obterCampanha(id) {
  return obterBanco().prepare("SELECT * FROM campanhas WHERE id = ?").get(id);
}

function criarCampanha(dados) {
  const info = obterBanco()
    .prepare(
      `INSERT INTO campanhas
        (nome, canal, tipo_destino, destino, assunto, mensagem, servidor_email_id, agendamento_dias, agendamento_hora, status)
       VALUES
        (@nome, @canal, @tipo_destino, @destino, @assunto, @mensagem, @servidor_email_id, @agendamento_dias, @agendamento_hora, @status)`
    )
    .run({
      nome: dados.nome,
      canal: dados.canal,
      tipo_destino: dados.tipoDestino || null,
      destino: dados.destino || null,
      assunto: dados.assunto || null,
      mensagem: dados.mensagem,
      servidor_email_id: dados.servidorEmailId || null,
      agendamento_dias: dados.agendamentoDias ? JSON.stringify(dados.agendamentoDias) : null,
      agendamento_hora: dados.agendamentoHora || null,
      status: dados.agendamentoDias ? "agendada" : "rascunho",
    });
  return obterCampanha(info.lastInsertRowid);
}

function atualizarCampanha(id, dados) {
  const atual = obterCampanha(id);
  if (!atual) return null;
  obterBanco()
    .prepare(
      `UPDATE campanhas SET nome=@nome, canal=@canal, tipo_destino=@tipo_destino, destino=@destino,
        assunto=@assunto, mensagem=@mensagem, servidor_email_id=@servidor_email_id,
        agendamento_dias=@agendamento_dias, agendamento_hora=@agendamento_hora, status=@status,
        atualizado_em=datetime('now')
       WHERE id=@id`
    )
    .run({
      id,
      nome: dados.nome ?? atual.nome,
      canal: dados.canal ?? atual.canal,
      tipo_destino: dados.tipoDestino ?? atual.tipo_destino,
      destino: dados.destino ?? atual.destino,
      assunto: dados.assunto ?? atual.assunto,
      mensagem: dados.mensagem ?? atual.mensagem,
      servidor_email_id: dados.servidorEmailId ?? atual.servidor_email_id,
      agendamento_dias: dados.agendamentoDias !== undefined ? JSON.stringify(dados.agendamentoDias) : atual.agendamento_dias,
      agendamento_hora: dados.agendamentoHora ?? atual.agendamento_hora,
      status: dados.status ?? atual.status,
    });
  return obterCampanha(id);
}

function excluirCampanha(id) {
  obterBanco().prepare("DELETE FROM campanhas WHERE id = ?").run(id);
}

function marcarExecucaoCampanha(id, dataISO) {
  obterBanco().prepare("UPDATE campanhas SET ultima_execucao = ? WHERE id = ?").run(dataISO, id);
}

// ==================== ENVIOS (log de entrega) ====================

function registrarEnvioLog({ campanhaId, destino, nomeContato, canal, status, detalhe }) {
  const info = obterBanco()
    .prepare(
      `INSERT INTO envios (campanha_id, destino, nome_contato, canal, status, detalhe)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(campanhaId, destino, nomeContato || null, canal, status, detalhe || null);
  return info.lastInsertRowid;
}

function listarEnviosDaCampanha(campanhaId) {
  return obterBanco().prepare("SELECT * FROM envios WHERE campanha_id = ? ORDER BY criado_em DESC").all(campanhaId);
}

function resumoDaCampanha(campanhaId) {
  const linhas = obterBanco()
    .prepare("SELECT status, COUNT(*) AS total FROM envios WHERE campanha_id = ? GROUP BY status")
    .all(campanhaId);
  const resumo = { enviado: 0, erro: 0, bloqueado_blacklist: 0 };
  for (const l of linhas) resumo[l.status] = l.total;
  const eventos = obterBanco()
    .prepare(
      `SELECT e.tipo, COUNT(*) AS total FROM eventos e
       JOIN envios v ON v.id = e.envio_id
       WHERE v.campanha_id = ? GROUP BY e.tipo`
    )
    .all(campanhaId);
  resumo.aberturas = 0;
  resumo.cliques = 0;
  for (const ev of eventos) {
    if (ev.tipo === "abertura") resumo.aberturas = ev.total;
    if (ev.tipo === "clique") resumo.cliques = ev.total;
  }
  return resumo;
}

// ==================== EVENTOS (abertura/clique) ====================

function registrarEvento(envioId, tipo, detalhe = null) {
  obterBanco().prepare("INSERT INTO eventos (envio_id, tipo, detalhe) VALUES (?, ?, ?)").run(envioId, tipo, detalhe);
}

function obterEnvioPorId(id) {
  return obterBanco().prepare("SELECT * FROM envios WHERE id = ?").get(id);
}

module.exports = {
  iniciarBanco,
  obterBanco,
  fecharBanco,
  listarServidoresEmail,
  obterServidorEmail,
  criarServidorEmail,
  atualizarServidorEmail,
  excluirServidorEmail,
  normalizarContato,
  estaNaBlacklist,
  adicionarNaBlacklist,
  removerDaBlacklist,
  listarBlacklist,
  listarCampanhas,
  obterCampanha,
  criarCampanha,
  atualizarCampanha,
  excluirCampanha,
  marcarExecucaoCampanha,
  registrarEnvioLog,
  listarEnviosDaCampanha,
  resumoDaCampanha,
  registrarEvento,
  obterEnvioPorId,
};
