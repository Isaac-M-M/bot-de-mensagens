const tabs = document.querySelectorAll(".tab[data-canal]");
const formWhatsapp = document.getElementById("form-whatsapp");
const formEmail = document.getElementById("form-email");
const resultadoBox = document.getElementById("resultado");
const resultadoLista = document.getElementById("resultado-lista");

let canalAtual = "whatsapp";

// ---------- Planilha de contatos: status + upload ----------
async function atualizarStatusContatos() {
  const statusEl = document.getElementById("contatos-status");
  try {
    const res = await fetch("/contatos");
    const data = await res.json();
    if (data.erro) {
      statusEl.textContent = `⚠️ ${data.erro}`;
      return;
    }
    const total = (data.contatos || []).length;
    statusEl.textContent =
      total > 0
        ? `📄 Planilha carregada: ${total} contato(s).`
        : "⚠️ Nenhuma planilha carregada ainda (ou está vazia). Baixe o modelo, preencha e envie.";
  } catch (err) {
    statusEl.textContent = "⚠️ Nenhuma planilha carregada ainda. Baixe o modelo, preencha e envie.";
  }
}
atualizarStatusContatos();

document.getElementById("input-planilha").addEventListener("change", async (e) => {
  const arquivo = e.target.files[0];
  if (!arquivo) return;

  const statusEl = document.getElementById("contatos-status");
  statusEl.textContent = "⏳ Enviando planilha...";

  const formData = new FormData();
  formData.append("planilha", arquivo);

  try {
    const res = await fetch("/contatos/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.erro) {
      statusEl.textContent = `❌ ${data.erro}`;
    } else {
      statusEl.textContent = `✅ Planilha enviada com sucesso! ${data.totalContatos} contato(s) carregado(s).`;
    }
  } catch (err) {
    statusEl.textContent = `❌ Erro ao enviar: ${err.message}`;
  } finally {
    e.target.value = ""; // permite selecionar o mesmo arquivo de novo, se precisar reenviar
  }
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    canalAtual = tab.dataset.canal;

    formWhatsapp.classList.toggle("hidden", canalAtual !== "whatsapp");
    formEmail.classList.toggle("hidden", canalAtual !== "email");
    document.getElementById("whatsapp-status-box").classList.toggle("hidden", canalAtual !== "whatsapp");
    resultadoBox.classList.add("hidden");
  });
});

// Mostrar/esconder campo de destino conforme o tipo escolhido
document.querySelectorAll('input[name="tipoDestino"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const campoDestino = document.getElementById("campo-destino");
    campoDestino.classList.toggle("hidden", radio.value === "planilha" && radio.checked);
  });
});

// ---------- Status do WhatsApp (polling) ----------
async function atualizarStatus() {
  try {
    const res = await fetch("/status");
    const data = await res.json();

    const carregando = document.getElementById("wa-carregando");
    const qrBox = document.getElementById("wa-qr");
    const qrImg = document.getElementById("wa-qr-img");
    const conectado = document.getElementById("wa-conectado");

    carregando.classList.add("hidden");
    qrBox.classList.add("hidden");
    conectado.classList.add("hidden");

    if (data.whatsappStatus === "conectado") {
      conectado.classList.remove("hidden");
    } else if (data.whatsappStatus === "aguardando_qr" && data.qr) {
      qrImg.src = data.qr;
      qrBox.classList.remove("hidden");
    } else {
      carregando.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Erro ao consultar status:", err);
  }
}
atualizarStatus();
setInterval(atualizarStatus, 3000);

// ---------- Envio WhatsApp ----------
formWhatsapp.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = formWhatsapp.querySelector(".btn-enviar");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  const tipoDestino = formWhatsapp.querySelector('input[name="tipoDestino"]:checked').value;
  const destino = document.getElementById("destino-wa").value;
  const mensagem = document.getElementById("mensagem-wa").value;

  try {
    const res = await fetch("/enviar/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipoDestino, destino, mensagem }),
    });
    const data = await res.json();
    mostrarResultado(data);
  } catch (err) {
    mostrarResultado({ erro: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar pelo WhatsApp";
  }
});

// ---------- Envio E-mail ----------
formEmail.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = formEmail.querySelector(".btn-enviar");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  const assunto = document.getElementById("assunto-email").value;
  const mensagem = document.getElementById("mensagem-email").value;

  try {
    const res = await fetch("/enviar/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assunto, mensagem }),
    });
    const data = await res.json();
    mostrarResultado(data);
  } catch (err) {
    mostrarResultado({ erro: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar por E-mail";
  }
});

// ---------- Exibir resultado ----------
function mostrarResultado(data) {
  resultadoBox.classList.remove("hidden");
  resultadoLista.innerHTML = "";

  if (data.erro) {
    const li = document.createElement("li");
    li.className = "erro";
    li.textContent = `❌ ${data.erro}`;
    resultadoLista.appendChild(li);
    return;
  }

  for (const item of data.resultados || []) {
    const li = document.createElement("li");
    li.className = item.status === "enviado" ? "enviado" : "erro";
    li.innerHTML = `<span>${item.destino}</span><span>${item.status === "enviado" ? "✅ enviado" : "❌ " + (item.detalhe || "erro")}</span>`;
    resultadoLista.appendChild(li);
  }
}

// ==================== NAVEGAÇÃO ENTRE PÁGINAS ====================

const paginaTabs = document.querySelectorAll(".tab[data-pagina]");
const paginas = document.querySelectorAll(".pagina");

paginaTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    paginaTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const alvo = tab.dataset.pagina;
    paginas.forEach((p) => p.classList.toggle("hidden", p.id !== `pagina-${alvo}`));

    if (alvo === "campanhas") {
      carregarServidoresNoSeletor();
      carregarCampanhas();
    } else if (alvo === "servidores") {
      carregarServidores();
    } else if (alvo === "blacklist") {
      carregarBlacklist();
    }
  });
});

function escaparHtml(texto) {
  const div = document.createElement("div");
  div.textContent = String(texto == null ? "" : texto);
  return div.innerHTML;
}

// ==================== CAMPANHAS ====================

const campanhaCamposWhatsapp = document.getElementById("campanha-campos-whatsapp");
const campanhaCamposEmail = document.getElementById("campanha-campos-email");

document.querySelectorAll('input[name="campanha-canal"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const ehWhatsapp = radio.value === "whatsapp" && radio.checked;
    if (!radio.checked) return;
    campanhaCamposWhatsapp.classList.toggle("hidden", !ehWhatsapp);
    campanhaCamposEmail.classList.toggle("hidden", ehWhatsapp);
  });
});

document.querySelectorAll('input[name="campanha-tipo-destino"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    document.getElementById("campanha-campo-destino").classList.toggle("hidden", radio.value === "planilha" && radio.checked);
  });
});

async function carregarServidoresNoSeletor() {
  const select = document.getElementById("campanha-servidor");
  try {
    const res = await fetch("/api/servidores-email");
    const data = await res.json();
    const atual = select.value;
    select.innerHTML = '<option value="">Rotação entre todos os ativos</option>';
    for (const s of data.servidores || []) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.apelido} (${s.usuario})${s.ativo ? "" : " — inativo"}`;
      select.appendChild(opt);
    }
    select.value = atual;
  } catch (err) {
    console.error("Erro ao carregar servidores:", err);
  }
}

function badgeStatusCampanha(status) {
  const mapa = {
    rascunho: ["neutro", "rascunho"],
    agendada: ["aviso", "agendada"],
    enviando: ["aviso", "enviando..."],
    concluida: ["sucesso", "concluída"],
    erro: ["erro", "erro"],
  };
  const [classe, texto] = mapa[status] || ["neutro", status];
  return `<span class="badge badge-${classe}">${texto}</span>`;
}

const DIAS_SEMANA_NOMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

async function carregarCampanhas() {
  const lista = document.getElementById("lista-campanhas");
  lista.innerHTML = "";
  try {
    const res = await fetch("/api/campanhas");
    const data = await res.json();
    const campanhas = data.campanhas || [];
    if (campanhas.length === 0) {
      lista.innerHTML = '<li class="item-lista-vazia">Nenhuma campanha ainda.</li>';
      return;
    }
    for (const c of campanhas) {
      const li = document.createElement("li");
      li.className = "item-lista";
      let infoAgendamento = "";
      if (c.agendamento_dias) {
        const dias = JSON.parse(c.agendamento_dias).map((d) => DIAS_SEMANA_NOMES[d]).join(", ");
        infoAgendamento = `<p class="item-lista-info">⏰ ${dias} às ${c.agendamento_hora}${c.ultima_execucao ? ` · última vez: ${c.ultima_execucao}` : ""}</p>`;
      }
      li.innerHTML = `
        <div class="item-lista-topo">
          <span class="item-lista-nome">${escaparHtml(c.nome)}</span>
          ${badgeStatusCampanha(c.status)}
        </div>
        <p class="item-lista-info">${c.canal === "whatsapp" ? "💬 WhatsApp" : "📧 E-mail"}</p>
        ${infoAgendamento}
        <p class="item-lista-info" data-resumo="${c.id}">Carregando resultados...</p>
        <div class="item-lista-acoes">
          <button type="button" class="acao-primaria" data-enviar="${c.id}">Enviar agora</button>
          <button type="button" class="acao-perigo" data-excluir="${c.id}">Excluir</button>
        </div>
      `;
      lista.appendChild(li);
      carregarResumoCampanha(c.id);
    }
  } catch (err) {
    lista.innerHTML = `<li class="item-lista-vazia">Erro ao carregar campanhas: ${escaparHtml(err.message)}</li>`;
  }
}

async function carregarResumoCampanha(id) {
  const alvo = document.querySelector(`[data-resumo="${id}"]`);
  if (!alvo) return;
  try {
    const res = await fetch(`/api/campanhas/${id}`);
    const data = await res.json();
    const r = data.resumo || {};
    alvo.textContent = `✅ ${r.enviado || 0} enviados · ❌ ${r.erro || 0} erros · 🚫 ${r.bloqueado_blacklist || 0} bloqueados · 👁️ ${r.aberturas || 0} aberturas · 🔗 ${r.cliques || 0} cliques`;
  } catch {
    alvo.textContent = "Não consegui carregar os resultados.";
  }
}

document.getElementById("lista-campanhas").addEventListener("click", async (e) => {
  const idEnviar = e.target.dataset.enviar;
  const idExcluir = e.target.dataset.excluir;

  if (idEnviar) {
    e.target.disabled = true;
    e.target.textContent = "Enviando...";
    try {
      const res = await fetch(`/api/campanhas/${idEnviar}/enviar`, { method: "POST" });
      const data = await res.json();
      if (data.erro) alert(`Erro ao enviar: ${data.erro}`);
      carregarCampanhas();
    } catch (err) {
      alert(`Erro ao enviar: ${err.message}`);
      e.target.disabled = false;
      e.target.textContent = "Enviar agora";
    }
  } else if (idExcluir) {
    if (!confirm("Excluir essa campanha e o histórico de envios dela?")) return;
    await fetch(`/api/campanhas/${idExcluir}`, { method: "DELETE" });
    carregarCampanhas();
  }
});

document.getElementById("btn-criar-campanha").addEventListener("click", async () => {
  const erroEl = document.getElementById("campanha-erro");
  erroEl.classList.add("hidden");

  const nome = document.getElementById("campanha-nome").value.trim();
  const canal = document.querySelector('input[name="campanha-canal"]:checked').value;
  const mensagem = document.getElementById("campanha-mensagem").value;
  const dias = Array.from(document.querySelectorAll(".campanha-dia:checked")).map((c) => Number(c.value));
  const hora = document.getElementById("campanha-hora").value;

  const corpo = {
    nome,
    canal,
    mensagem,
    agendamentoDias: dias.length > 0 ? dias : null,
    agendamentoHora: dias.length > 0 ? hora : null,
  };

  if (canal === "whatsapp") {
    corpo.tipoDestino = document.querySelector('input[name="campanha-tipo-destino"]:checked').value;
    corpo.destino = document.getElementById("campanha-destino").value;
  } else {
    corpo.assunto = document.getElementById("campanha-assunto").value;
    const servidorId = document.getElementById("campanha-servidor").value;
    if (servidorId) corpo.servidorEmailId = Number(servidorId);
  }

  try {
    const res = await fetch("/api/campanhas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const data = await res.json();
    if (data.erro) {
      erroEl.textContent = `❌ ${data.erro}`;
      erroEl.classList.remove("hidden");
      return;
    }
    document.getElementById("campanha-nome").value = "";
    document.getElementById("campanha-mensagem").value = "";
    document.getElementById("campanha-destino").value = "";
    document.getElementById("campanha-assunto").value = "";
    document.getElementById("campanha-hora").value = "";
    document.querySelectorAll(".campanha-dia").forEach((c) => (c.checked = false));
    carregarCampanhas();
  } catch (err) {
    erroEl.textContent = `❌ Erro ao salvar: ${err.message}`;
    erroEl.classList.remove("hidden");
  }
});

// ==================== SERVIDORES DE E-MAIL ====================

document.getElementById("servidor-provedor").addEventListener("change", (e) => {
  document.getElementById("servidor-campos-custom").classList.toggle("hidden", e.target.value !== "custom");
});

async function carregarServidores() {
  const lista = document.getElementById("lista-servidores");
  lista.innerHTML = "";
  try {
    const res = await fetch("/api/servidores-email");
    const data = await res.json();
    const servidores = data.servidores || [];
    if (servidores.length === 0) {
      lista.innerHTML = '<li class="item-lista-vazia">Nenhum servidor cadastrado ainda.</li>';
      return;
    }
    for (const s of servidores) {
      const li = document.createElement("li");
      li.className = "item-lista";
      li.innerHTML = `
        <div class="item-lista-topo">
          <span class="item-lista-nome">${escaparHtml(s.apelido)}</span>
          <span class="badge ${s.ativo ? "badge-sucesso" : "badge-neutro"}">${s.ativo ? "ativo" : "inativo"}</span>
        </div>
        <p class="item-lista-info">${escaparHtml(s.provedor)} · ${escaparHtml(s.usuario)}</p>
        <p class="item-lista-info" data-teste="${s.id}"></p>
        <div class="item-lista-acoes">
          <button type="button" class="acao-primaria" data-testar="${s.id}">Testar conexão</button>
          <button type="button" class="acao-perigo" data-excluir-servidor="${s.id}">Excluir</button>
        </div>
      `;
      lista.appendChild(li);
    }
  } catch (err) {
    lista.innerHTML = `<li class="item-lista-vazia">Erro ao carregar servidores: ${escaparHtml(err.message)}</li>`;
  }
}

document.getElementById("lista-servidores").addEventListener("click", async (e) => {
  const idTestar = e.target.dataset.testar;
  const idExcluir = e.target.dataset.excluirServidor;

  if (idTestar) {
    const msgEl = document.querySelector(`[data-teste="${idTestar}"]`);
    e.target.disabled = true;
    e.target.textContent = "Testando...";
    msgEl.textContent = "";
    try {
      const res = await fetch(`/api/servidores-email/${idTestar}/testar`, { method: "POST" });
      const data = await res.json();
      msgEl.textContent = data.ok ? "✅ Conexão feita com sucesso!" : `❌ ${data.erro}`;
    } catch (err) {
      msgEl.textContent = `❌ ${err.message}`;
    } finally {
      e.target.disabled = false;
      e.target.textContent = "Testar conexão";
    }
  } else if (idExcluir) {
    if (!confirm("Excluir esse servidor de e-mail?")) return;
    await fetch(`/api/servidores-email/${idExcluir}`, { method: "DELETE" });
    carregarServidores();
  }
});

document.getElementById("btn-criar-servidor").addEventListener("click", async () => {
  const erroEl = document.getElementById("servidor-erro");
  erroEl.classList.add("hidden");

  const corpo = {
    apelido: document.getElementById("servidor-apelido").value.trim(),
    provedor: document.getElementById("servidor-provedor").value,
    usuario: document.getElementById("servidor-usuario").value.trim(),
    senha: document.getElementById("servidor-senha").value,
    host: document.getElementById("servidor-host").value.trim(),
    porta: Number(document.getElementById("servidor-porta").value) || null,
    seguro: true,
  };

  try {
    const res = await fetch("/api/servidores-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const data = await res.json();
    if (data.erro) {
      erroEl.textContent = `❌ ${data.erro}`;
      erroEl.classList.remove("hidden");
      return;
    }
    document.getElementById("servidor-apelido").value = "";
    document.getElementById("servidor-usuario").value = "";
    document.getElementById("servidor-senha").value = "";
    document.getElementById("servidor-host").value = "";
    document.getElementById("servidor-porta").value = "";
    carregarServidores();
  } catch (err) {
    erroEl.textContent = `❌ Erro ao salvar: ${err.message}`;
    erroEl.classList.remove("hidden");
  }
});

// ==================== BLACKLIST ====================

async function carregarBlacklist() {
  const lista = document.getElementById("lista-blacklist");
  lista.innerHTML = "";
  try {
    const res = await fetch("/api/blacklist");
    const data = await res.json();
    const itens = data.blacklist || [];
    if (itens.length === 0) {
      lista.innerHTML = '<li class="item-lista-vazia">Ninguém na blacklist ainda.</li>';
      return;
    }
    const motivos = { bounce: "e-mail inexistente", descadastro: "pediu descadastro", whatsapp: "respondeu no WhatsApp", manual: "adicionado manualmente" };
    for (const item of itens) {
      const li = document.createElement("li");
      li.className = "item-lista";
      li.innerHTML = `
        <div class="item-lista-topo">
          <span class="item-lista-nome">${escaparHtml(item.valor)}</span>
          <span class="badge badge-neutro">${motivos[item.motivo] || item.motivo}</span>
        </div>
        <div class="item-lista-acoes">
          <button type="button" class="acao-perigo" data-remover-blacklist="${encodeURIComponent(item.valor)}">Remover</button>
        </div>
      `;
      lista.appendChild(li);
    }
  } catch (err) {
    lista.innerHTML = `<li class="item-lista-vazia">Erro ao carregar blacklist: ${escaparHtml(err.message)}</li>`;
  }
}

document.getElementById("lista-blacklist").addEventListener("click", async (e) => {
  const valor = e.target.dataset.removerBlacklist;
  if (!valor) return;
  await fetch(`/api/blacklist/${valor}`, { method: "DELETE" });
  carregarBlacklist();
});

document.getElementById("btn-adicionar-blacklist").addEventListener("click", async () => {
  const input = document.getElementById("blacklist-valor");
  if (!input.value.trim()) return;
  await fetch("/api/blacklist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ valor: input.value.trim() }),
  });
  input.value = "";
  carregarBlacklist();
});
