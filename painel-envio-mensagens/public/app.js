const tabs = document.querySelectorAll(".tab");
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
