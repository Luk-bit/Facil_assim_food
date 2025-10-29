// bot.js - WhatsApp Web JS + SQLite + Menu dinâmico + notificações
const { create } = require('@open-wa/wa-automate');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');
const fs = require('fs');

// Caminho do banco do app Kivy
const DB_PATH = "C:/Users/lukav/OneDrive/Documentos/Facil_assim_Restaurante/facil_assim_moderno_full.db";

// Verificação se o banco existe
if (!fs.existsSync(DB_PATH)) {
  console.error("❌ Banco de dados não encontrado em:", DB_PATH);
  process.exit(1);
}
console.log("📁 Usando banco de dados:", DB_PATH);

// --- 🔹 FILTRO DE LOG: remove "Not a contact" do console ---
const originalError = console.error;
console.error = (...args) => {
  if (args.some(a => typeof a === 'string' && a.includes('Not a contact'))) {
    console.log("⚠️ Ignorado: tentativa de envio para número não salvo.");
    return;
  }
  originalError(...args);
};

// Inicializa o banco
function initDB() {
  const db = new sqlite3.Database(DB_PATH);
  db.run(`CREATE TABLE IF NOT EXISTS wa_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      estab_id INTEGER,
      client_name TEXT,
      address TEXT,
      items TEXT,
      total REAL,
      payment_method TEXT,
      cash_received REAL,
      troco REAL,
      obs TEXT DEFAULT 'não',
      status TEXT DEFAULT 'pendente',
      created_at TEXT,
      phone_number TEXT,
      tipo TEXT DEFAULT 'entrega'
  )`);
  return db;
}

// --- Adiciona coluna tipo se não existir ---
const dbCheck = new sqlite3.Database(DB_PATH);
dbCheck.run(`ALTER TABLE wa_orders ADD COLUMN tipo TEXT`, [], (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

// --- Cria o bot ---
create({
  sessionId: 'FACIL_ASSIM_BOT',
  authTimeout: 60,
  blockCrashLogs: true,
  disableSpins: true,
  headless: false,
  useChrome: true,
  popup: false,
  cacheEnable: true,
  qrTimeout: 0,
  licenseKey: "FREE_TRIAL",
  throwErrorOnTosBlock: false,
  killProcessOnBrowserClose: false
}).then(client => {
  globalClient = client;
  start(client);
  initExpress(client);
});

// --- Pega estab_id do bot ---
async function getEstabIdFromBot(client) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    client.getHostNumber().then(hostNumber => {
      db.get(`SELECT id FROM estab WHERE phone = ?`, [hostNumber], (err, row) => {
        if (err) reject(err);
        else if (!row) {
          console.warn(`⚠️ Nenhum estab_id encontrado para o número ${hostNumber}. Usando fallback id=1`);
          resolve(1);
        } else {
          console.log(`🏪 Bot vinculado ao estab_id ${row.id}`);
          resolve(row.id);
        }
      });
    }).catch(err => reject(err));
  });
}

// --- CONTROLE DE INATIVIDADE (5 MIN) ---
const userTimeouts = {};

// --- FUNÇÃO PRINCIPAL ---
async function start(client) {
  console.log('🤖 Bot iniciado! Aguardando mensagens...');
  const db = initDB();
  const estab_id = await getEstabIdFromBot(client);
  console.log("🏪 Este bot pertence ao estab_id:", estab_id);

  async function getMenuItems() {
    return new Promise((resolve, reject) => {
      db.all(`SELECT id, name, price FROM menu`, [], (err, rows) => {
        if (err) reject(err);
        else {
          const menu = {};
          rows.forEach(r => {
            menu[r.id] = { name: r.name, price: r.price };
          });
          resolve(menu);
        }
      });
    });
  }

  if (!client.states) client.states = {};

  client.onAnyMessage(async message => {
    if (!message.body) return;

    const chatId = message.from;
    const number = chatId.replace('@c.us', '');
    const msg = message.body.trim().toLowerCase();

    // Reinicia temporizador de inatividade
    if (userTimeouts[chatId]) clearTimeout(userTimeouts[chatId]);
    userTimeouts[chatId] = setTimeout(async () => {
      const state = client.states[chatId];
      if (state && !state.completed) {
        await client.sendText(chatId, '⏰ Pedido finalizado por inatividade.');
      }
      delete client.states[chatId];
      delete userTimeouts[chatId];
    }, 5 * 60 * 1000); // 5 minutos

    if (!client.states[chatId]) {
      client.states[chatId] = { step: 0, order: {} };
    }

    const state = client.states[chatId];

    try {
      const menuItems = await getMenuItems();

      switch (state.step) {

        // --- ETAPA 0: Nome ---
        case 0:
          await client.sendText(chatId, "Olá! Qual seu nome completo?");
          state.step = 1;
          break;

        // --- ETAPA 1: Nome do cliente enviado, pergunta tipo de pedido ---
        case 1:
          state.order.client_name = message.body.trim();
          await client.sendText(chatId, "Você deseja *Retirada* ou *Entrega*?\nDigite 1️⃣ para Retirada ou 2️⃣ para Entrega");
          state.step = 1.5;
          break;

        // --- ETAPA 1.5: Tipo de pedido ---
        case 1.5:
          if (msg.includes("1")) {
            state.order.tipo = "retirada";

            const dbEstab = new sqlite3.Database(DB_PATH);
            dbEstab.get("SELECT address FROM estab LIMIT 1", async (err, row) => {
              if (err) {
                console.error("Erro ao buscar endereço:", err);
                await client.sendText(chatId, "⚠️ Ocorreu um erro ao obter o endereço do estabelecimento.");
                dbEstab.close();
                return;
              }
              const endereco = row ? row.address : "Endereço não cadastrado.";
              await client.sendText(
                chatId,
                `🏪 Você escolheu *RETIRADA*.\n\nNosso endereço é:\n${endereco}\n\nA seguir, veja nosso cardápio. 🍔`
              );
              let menuText = "📋 *Menu disponível:*\n\n";
              Object.keys(menuItems).forEach(id => {
                const item = menuItems[id];
                menuText += `${id} - ${item.name}  R$${item.price.toFixed(2)}\n`;
              });
              menuText += "\nDigite os *números dos itens* separados por vírgula:";

              await client.sendText(chatId, menuText);
              state.step = 3; // pula direto para escolha de itens

              dbEstab.close();
            });
          } else if (msg.includes("2")) {
            state.order.tipo = "entrega";
            await client.sendText(chatId, "Certo! Informe seu endereço completo para entrega:");
            state.step = 1.6;
          } else {
            await client.sendText(chatId, "Por favor, digite 1️⃣ para Retirada ou 2️⃣ para Entrega.");
          }
          break;
        // --- ETAPA 1.6: Endereço do cliente (apenas entrega) ---
        case 1.6:
          state.order.address = message.body.trim();

          let menuText1 = "📋 *Menu disponível:*\n\n";
          Object.keys(menuItems).forEach(id => {
            const item = menuItems[id];
            menuText1 += `${id} - ${item.name}  R$${item.price.toFixed(2)}\n`;
          });
          menuText1 += "\nDigite os *números dos itens* separados por vírgula:";
          await client.sendText(chatId, menuText1);
          state.step = 3;
          break;

        // --- ETAPA 2: Mostrar menu ---
        case 2:
          let menuText = "📋 *Menu disponível:*\n\n";
          Object.keys(menuItems).forEach(id => {
            const item = menuItems[id];
            menuText += `${id} - ${item.name}  R$${item.price.toFixed(2)}\n`;
          });
          menuText += "\nDigite os *números dos itens* separados por vírgula:";
          await client.sendText(chatId, menuText);
          state.step = 3;
          break;

        // --- ETAPA 3: Seleção de itens ---
        case 3:
          const selections = msg.split(',').map(s => s.trim());
          const validSelections = selections.filter(s => menuItems[s]);

          if (validSelections.length === 0) {
            await client.sendText(chatId, "❌ Opção inválida. Tente novamente digitando os números do menu disponíveis.");
            return;
          }

          let itemsText = '';
          let total = 0;
          validSelections.forEach(s => {
            itemsText += `${menuItems[s].name} R$${menuItems[s].price.toFixed(2)}\n`;
            total += menuItems[s].price;
          });

          if (state.order.tipo === "entrega") total += 5; // taxa entrega
          state.order.items = itemsText.trim();
          state.order.total = total.toFixed(2);

          await client.sendText(chatId,
            `Resumo do pedido:\n${itemsText}\n${state.order.tipo === "entrega" ? "Taxa entrega: R$5,00\n" : ""}TOTAL: R$${total.toFixed(2)}\n\nGostaria de adicionar alguma observação do pedido? 🤔\nEx: sem milho, sem cebola...\nSe não, digite *não* para prosseguir.`
          );
          state.step = 3.5;
          break;

        // --- ETAPA 3.5: Observação ---
        case 3.5:
          state.order.obs = msg.toLowerCase() === "não" ? "" : message.body.trim();
          await client.sendText(chatId, "Agora escolha a forma de pagamento:\n1️⃣ Dinheiro\n2️⃣ Cartão\n3️⃣ PIX");
          state.step = 4;
          break;

        // --- ETAPA 4: Pagamento ---
        case 4:
          if (msg.includes("1")) state.order.payment_method = "dinheiro";
          else if (msg.includes("2")) state.order.payment_method = "cartão";
          else if (msg.includes("3")) state.order.payment_method = "PIX";
          else {
            await client.sendText(chatId, "Por favor, digite 1️⃣ Dinheiro, 2️⃣ Cartão ou 3️⃣ PIX.");
            return;
          }

          if (state.order.payment_method === "dinheiro") {
            await client.sendText(chatId, "Qual valor você vai pagar em dinheiro?");
            state.step = 5;
          } else {
            state.order.cash_received = null;
            state.order.change = null;
            state.step = 6;
            await finalizeOrder(client, chatId, state, db, number, estab_id);
          }
          break;

        // --- ETAPA 5: Recebimento em dinheiro ---
        case 5:
          const cash = parseFloat(msg.replace(',', '.'));
          if (isNaN(cash)) {
            await client.sendText(chatId, "❌ Valor inválido. Informe um número (ex: 50 ou 50,00).");
            return;
          }

          state.order.cash_received = cash;
          state.order.change = (cash - parseFloat(state.order.total)).toFixed(2);
          state.step = 6;
          await finalizeOrder(client, chatId, state, db, number, estab_id);
          break;

        // --- ETAPA 6: Pedido finalizado ---
        case 6:
          await client.sendText(chatId, "✅ Pedido já registrado! Para iniciar um novo pedido, envie qualquer mensagem.");
          state.step = 0;
          state.order = {};
          break;

      }
    } catch (err) {
      console.error(err);
    }
  });
}

// --- FUNÇÃO FINALIZAR PEDIDO ---
async function finalizeOrder(client, chatId, state, db, number, estab_id) {
  const order = state.order;

  state.completed = true;
  try {
    await client.sendText(chatId,
      `✅ Pedido confirmado!\n\n${order.items}\n${order.tipo === "entrega" ? "Taxa entrega: R$5,00\n" : ""}TOTAL: R$${order.total}\nPagamento: ${order.payment_method}${order.cash_received ? `\nValor recebido: R$${order.cash_received}\nTroco: R$${order.change}` : ""}${order.obs ? `\nObservação: ${order.obs}` : ""}`
    );
  } catch (e) {
    console.log("⚠️ Mensagem não enviada (usuário não contato).");
  }

  db.run(
    `INSERT INTO wa_orders (
      estab_id, client_name, address, items, total, payment_method,
      cash_received, troco, obs, status, created_at, phone_number, tipo
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      estab_id,
      order.client_name,
      order.address,
      order.items,
      order.total,
      order.payment_method,
      order.cash_received,
      order.change || 0,
      order.obs || 'não',
      'pendente',
      new Date().toISOString(),
      number,
      order.tipo || "entrega"
    ],
    function (err) {
      if (err) console.error("❌ Erro ao salvar pedido:", err);
      else console.log(`📦 Pedido salvo com ID ${this.lastID}`);
    }
  );
}

// --- API EXPRESS ---
function initExpress(client) {
  const app = express();
  app.use(express.json());

  app.post('/send-message', async (req, res) => {
    const { to, message } = req.body;
    if (!globalClient) return res.status(500).send('❌ Cliente WhatsApp não iniciado ainda');

    try {
      const chatId = to + '@c.us';
      await globalClient.sendText(chatId, message);
      res.send('✅ Mensagem enviada com sucesso!');
    } catch (err) {
      if (String(err).includes('Not a contact')) {
        console.log(`⚠️ Tentativa de enviar mensagem para não-contato ignorada: ${to}`);
        return res.send('⚠️ Mensagem não enviada (não contato).');
      }
      console.error('Erro ao enviar mensagem:', err);
      res.status(500).send('❌ Erro ao enviar mensagem');
    }
  });

  app.listen(5000, () => console.log('🚀 API WhatsApp rodando na porta 5000'));
}
