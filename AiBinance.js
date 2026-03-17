const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const YAML = require("yaml");
const API_YAML_FILE = "/root/api.yml";

// === ИМПОРТЫ ДЛЯ ИИ И MCP ===
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const { OpenAI } = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk");
} catch (e) {}

// === НАСТРОЙКИ ИИ ===
const AI_PROVIDER = "openrouter";

const API_KEYS = {
  openai: "sk-proj",
  gemini: "AI",
  anthropic: "sk-ant-api",
  openrouter: "sk-or-v1",
  openclaw: "local",
};

const MODELS = {
  openai: "gpt-5.3-chat-latest",
  gemini: "gemini-2.0-flash-lite",
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "stepfun/step-3.5-flash:free",
  openclaw: "openrouter/free", // Модель для openclaw
};

let aiClient;
if (AI_PROVIDER === "openai") {
  aiClient = new OpenAI({ apiKey: API_KEYS.openai });
} else if (AI_PROVIDER === "openclaw") {
  aiClient = new OpenAI({
    apiKey: API_KEYS.openclaw,
    baseURL: "http://localhost:3000/v1", // Локальный сервер OpenClaw
  });
} else if (AI_PROVIDER === "gemini") {
  aiClient = new GoogleGenerativeAI(API_KEYS.gemini);
} else if (AI_PROVIDER === "openrouter") {
  aiClient = new OpenAI({
    apiKey: API_KEYS.openrouter,
    baseURL: "https://openrouter.ai/api/v1",
  });
} else if (AI_PROVIDER === "anthropic") {
  if (!Anthropic) {
    console.error(
      "Для использования Anthropic установите библиотеку: npm install @anthropic-ai/sdk"
    );
    process.exit(1);
  }
  aiClient = new Anthropic({ apiKey: API_KEYS.anthropic });
}

// === ИНИЦИАЛИЗАЦИЯ MCP КЛИЕНТА ===
const transport = new StdioClientTransport({
  command: "python", // Убедитесь, что используется правильный путь к python, где установлен mcp
  args: ["-m", "hummingbot_mcp.server"],
  cwd: "/root/mcp",
});

const mcpClient = new Client(
  {
    name: "telegram-bot-mcp-client",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
  }
);

async function connectMCP() {
  try {
    await mcpClient.connect(transport);
    console.log("✅ MCP сервер успешно запущен ботом в фоне!");
  } catch (err) {
    console.error("❌ Ошибка при подключении MCP сервера:", err);
  }
}
connectMCP();

// === ПОЛУЧЕНИЕ ИСТОРИИ СДЕЛОК НАПРЯМУЮ ЧЕРЕЗ API (без shell-скриптов) ===
async function getTradeHistoryJS(hours = 24) {
  const INFRA = new Set([
    "hummingbot-api",
    "hummingbot-postgres",
    "hummingbot-broker",
  ]);
  const now = Math.floor(Date.now() / 1000);
  const start = now - hours * 3600;

  // Шаг 1: получаем активные контейнеры
  let bots = [];
  try {
    const containers = await hbot("GET", "/docker/active-containers");
    const list = Array.isArray(containers)
      ? containers
      : Array.isArray(containers?.data)
      ? containers.data
      : [];
    bots = list
      .map((c) => (c.name || c.Names || "").replace(/^\//, ""))
      .filter((name) => name && !INFRA.has(name));
  } catch (e) {
    console.error(
      "getTradeHistoryJS: не удалось получить контейнеры:",
      e.message
    );
  }

  // Шаг 2: для каждого бота получаем историю и фильтруем по времени
  const allTrades = [];
  const botHistories = {};

  for (const botName of bots) {
    try {
      const resp = await hbot("GET", `/bot-orchestration/${botName}/history`);
      // Пробуем все возможные вложенности ответа
      const raw =
        resp?.response?.data?.data?.trades ||
        resp?.response?.data?.trades ||
        resp?.data?.data?.trades ||
        resp?.data?.trades ||
        resp?.trades ||
        [];
      const trades = Array.isArray(raw) ? raw : [];

      // Фильтруем по временному окну
      const filtered = trades
        .filter((t) => {
          let ts = t.trade_timestamp || t.timestamp || 0;
          if (ts > 1e12) ts = ts / 1000;
          return ts >= start;
        })
        .map((t) => ({ ...t, _bot: botName }));

      botHistories[botName] = {
        total_trades: trades.length,
        trades_in_window: filtered.length,
        trades: filtered,
      };
      allTrades.push(...filtered);
    } catch (e) {
      console.error(`getTradeHistoryJS: ошибка для ${botName}:`, e.message);
      botHistories[botName] = {
        total_trades: 0,
        trades_in_window: 0,
        trades: [],
      };
    }
  }

  // Шаг 3: собираем summary
  const pairsMap = {};
  for (const t of allTrades) {
    const sym = t.symbol || t.trading_pair || "UNKNOWN";
    pairsMap[sym] = (pairsMap[sym] || 0) + 1;
  }

  const summary = {
    period_hours: hours,
    start_unix: start,
    end_unix: now,
    active_bots: bots,
    total_trades: allTrades.length,
    pairs_traded: Object.keys(pairsMap),
    trades_by_pair: pairsMap,
  };

  // Шаг 4: дополнительные данные (не критично если упадут)
  let execSummary = {};
  let portfolio = {};
  try {
    execSummary = await hbot("GET", "/executors/summary");
  } catch (e) {}
  try {
    portfolio = await hbot("GET", "/portfolio/state");
  } catch (e) {}

  return {
    summary,
    trades: allTrades,
    bot_histories: botHistories,
    executors_summary: execSummary,
    portfolio,
  };
}

// Функция для чтения скиллов из локальной папки
function getSkillsContext() {
  const skillsDir = "/root/skills";
  let skillsText = "";
  if (fs.existsSync(skillsDir)) {
    try {
      const files = fs.readdirSync(skillsDir);
      for (const file of files) {
        const filePath = path.join(skillsDir, file);
        if (fs.statSync(filePath).isFile()) {
          const content = fs.readFileSync(filePath, "utf-8");
          skillsText += `\n--- Skill: ${file} ---\n${content}\n`;
        }
      }
    } catch (err) {
      console.error("Ошибка при чтении скиллов:", err);
    }
  }
  return skillsText;
}

// === НАСТРОЙКИ ===
const BOT_TOKEN = "";
const CHAT_ID = "";

// Пути к конфигурационным файлам
// Каждый бот-инстанс имеет свою папку конфигов:
// /root/hummingbot/hummingbot-api/bots/instances/{name}/conf/controllers/
// CTRL_DIR_FILES — глобальный шаблон (для деплоя новых ботов)
const BOTS_INSTANCES_DIR = "/root/hummingbot/hummingbot-api/bots/instances";
const CTRL_DIR_FILES = "/root/hummingbot/hummingbot-api/bots/conf/controllers";

// Путь к конфигам конкретного запущенного инстанса
function instanceCtrlDir(instanceName) {
  return `${BOTS_INSTANCES_DIR}/${instanceName}/conf/controllers`;
}
function getCtrlDir(instanceName) {
  const inst = instanceName || _activeInstance;
  if (inst) return instanceCtrlDir(inst);
  return CTRL_DIR_FILES;
}
// Текущий активный бот (обновляется при loadBots)
let _activeInstance = null;

const FILES = {
  config1: `${CTRL_DIR_FILES}/conf_generic.aroon_01.yml`,
  config2: `${CTRL_DIR_FILES}/conf_generic.aroon_02.yml`,
  db: "/root/hummingbot/data/conf_v2_with_controllers_01.sqlite",
  controler: "conf_v2_with_controllers_01.yml",
};

// === ЯЗЫК ПО УМОЛЧАНИЮ ===
let userLang = "ru"; // "en" — английский по умолчанию

const UI = {
  ru: {
    stop: "🛑 Остановить",
    start: "▶️ Запустить",
    logs: "📋 Логи",
    pnl: "📊 PnL",
    history: "📈 История",
    status: "🔍 Статус",
    refresh: "🔄 Обновить",
    del_bot: "🗑️ Удалить бота",
    del_db: "🗄️ Удалить базу данных",
    list_bots: "« Список ботов",
    create_bot: "➕ Создать бота",
    cancel: "❌ Отмена",
    back: "« Назад",
    back_to_bot: "« Назад к боту",
    refresh_logs: "🔄 Обновить логи",
    del_yes: "✅ Да, удалить",
    create_new: "➕ Создать нового",
    del_exchange: "🗑️ Удалить ",
    add_exchange: "➕ Добавить биржу",
    back_to_list: "« Назад к списку",
    create_run: "✅ Создать и запустить",
    main_menu: "🏠 Главное меню",
    ai_analyzing: "🧠 ИИ анализирует запрос...",
  },
  en: {
    stop: "🛑 Stop",
    start: "▶️ Start",
    logs: "📋 Logs",
    pnl: "📊 PnL",
    history: "📈 History",
    status: "🔍 Status",
    refresh: "🔄 Refresh",
    del_bot: "🗑️ Delete bot",
    del_db: "🗄️ Delete database",
    list_bots: "« Bot list",
    create_bot: "➕ Create bot",
    cancel: "❌ Cancel",
    back: "« Back",
    back_to_bot: "« Back to bot",
    refresh_logs: "🔄 Refresh logs",
    del_yes: "✅ Yes, delete",
    create_new: "➕ Create new",
    del_exchange: "🗑️ Delete ",
    add_exchange: "➕ Add exchange",
    back_to_list: "« Back to list",
    create_run: "✅ Create & run",
    main_menu: "🏠 Main Menu",
    ai_analyzing: "🧠 AI is analyzing the request...",
  },
  zh: {
    stop: "🛑 停止",
    start: "▶️ 启动",
    logs: "📋 日志",
    pnl: "📊 PnL",
    history: "📈 历史",
    status: "🔍 状态",
    refresh: "🔄 刷新",
    del_bot: "🗑️ 删除机器人",
    del_db: "🗄️ 删除数据库",
    list_bots: "« 机器人列表",
    create_bot: "➕ 创建机器人",
    cancel: "❌ 取消",
    back: "« 返回",
    back_to_bot: "« 返回机器人",
    refresh_logs: "🔄 刷新日志",
    del_yes: "✅ 是的，删除",
    create_new: "➕ 创建新的",
    del_exchange: "🗑️ 删除 ",
    add_exchange: "➕ 添加交易所",
    back_to_list: "« 返回列表",
    create_run: "✅ 创建并运行",
    main_menu: "🏠 主菜单",
    ai_analyzing: "🧠 AI正在分析请求...",
  },
  ja: {
    stop: "🛑 停止",
    start: "▶️ 開始",
    logs: "📋 ログ",
    pnl: "📊 PnL",
    history: "📈 履歴",
    status: "🔍 ステータス",
    refresh: "🔄 更新",
    del_bot: "🗑️ ボットを削除",
    del_db: "🗄️ DBを削除",
    list_bots: "« ボット一覧",
    create_bot: "➕ ボットを作成",
    cancel: "❌ キャンセル",
    back: "« 戻る",
    back_to_bot: "« ボットに戻る",
    refresh_logs: "🔄 ログを更新",
    del_yes: "✅ はい、削除",
    create_new: "➕ 新規作成",
    del_exchange: "🗑️ 削除 ",
    add_exchange: "➕ 取引所を追加",
    back_to_list: "« リストに戻る",
    create_run: "✅ 作成して実行",
    main_menu: "🏠 メインメニュー",
    ai_analyzing: "🧠 AIがリクエストを分析しています...",
  },
  es: {
    stop: "🛑 Detener",
    start: "▶️ Iniciar",
    logs: "📋 Registros",
    pnl: "📊 PnL",
    history: "📈 Historial",
    status: "🔍 Estado",
    refresh: "🔄 Actualizar",
    del_bot: "🗑️ Eliminar bot",
    del_db: "🗄️ Eliminar base de datos",
    list_bots: "« Lista de bots",
    create_bot: "➕ Crear bot",
    cancel: "❌ Cancelar",
    back: "« Volver",
    back_to_bot: "« Volver al bot",
    refresh_logs: "🔄 Actualizar registros",
    del_yes: "✅ Sí, eliminar",
    create_new: "➕ Crear nuevo",
    del_exchange: "🗑️ Eliminar ",
    add_exchange: "➕ Agregar exchange",
    back_to_list: "« Volver a la lista",
    create_run: "✅ Crear y ejecutar",
    main_menu: "🏠 Menú principal",
    ai_analyzing: "🧠 La IA está analizando la solicitud...",
  },
  tr: {
    stop: "🛑 Durdur",
    start: "▶️ Başlat",
    logs: "📋 Günlükler",
    pnl: "📊 PnL",
    history: "📈 Geçmiş",
    status: "🔍 Durum",
    refresh: "🔄 Yenile",
    del_bot: "🗑️ Botu sil",
    del_db: "🗄️ Veritabanını sil",
    list_bots: "« Bot listesi",
    create_bot: "➕ Bot oluştur",
    cancel: "❌ İptal",
    back: "« Geri",
    back_to_bot: "« Bota geri dön",
    refresh_logs: "🔄 Günlükleri yenile",
    del_yes: "✅ Evet, sil",
    create_new: "➕ Yeni oluştur",
    del_exchange: "🗑️ Sil ",
    add_exchange: "➕ Borsa ekle",
    back_to_list: "« Listeye dön",
    create_run: "✅ Oluştur ve çalıştır",
    main_menu: "🏠 Ana Menü",
    ai_analyzing: "🧠 AI isteği analiz ediyor...",
  },
  vi: {
    stop: "🛑 Dừng",
    start: "▶️ Bắt đầu",
    logs: "📋 Nhật ký",
    pnl: "📊 PnL",
    history: "📈 Lịch sử",
    status: "🔍 Trạng thái",
    refresh: "🔄 Làm mới",
    del_bot: "🗑️ Xóa bot",
    del_db: "🗄️ Xóa cơ sở dữ liệu",
    list_bots: "« Danh sách bot",
    create_bot: "➕ Tạo bot",
    cancel: "❌ Hủy",
    back: "« Quay lại",
    back_to_bot: "« Quay lại bot",
    refresh_logs: "🔄 Làm mới nhật ký",
    del_yes: "✅ Có, xóa",
    create_new: "➕ Tạo mới",
    del_exchange: "🗑️ Xóa ",
    add_exchange: "➕ Thêm sàn",
    back_to_list: "« Quay lại danh sách",
    create_run: "✅ Tạo và chạy",
    main_menu: "🏠 Menu chính",
    ai_analyzing: "🧠 AI đang phân tích yêu cầu...",
  },
  ko: {
    stop: "🛑 중지",
    start: "▶️ 시작",
    logs: "📋 로그",
    pnl: "📊 PnL",
    history: "📈 내역",
    status: "🔍 상태",
    refresh: "🔄 새로고침",
    del_bot: "🗑️ 봇 삭제",
    del_db: "🗄️ 데이터베이스 삭제",
    list_bots: "« 봇 목록",
    create_bot: "➕ 봇 생성",
    cancel: "❌ 취소",
    back: "« 뒤로",
    back_to_bot: "« 봇으로 돌아가기",
    refresh_logs: "🔄 로그 새로고침",
    del_yes: "✅ 예, 삭제합니다",
    create_new: "➕ 새로 만들기",
    del_exchange: "🗑️ 삭제 ",
    add_exchange: "➕ 거래소 추가",
    back_to_list: "« 목록으로 돌아가기",
    create_run: "✅ 생성 및 실행",
    main_menu: "🏠 메인 메뉴",
    ai_analyzing: "🧠 AI가 요청을 분석 중입니다...",
  },
  ar: {
    stop: "🛑 إيقاف",
    start: "▶️ بدء",
    logs: "📋 السجلات",
    pnl: "📊 PnL",
    history: "📈 التاريخ",
    status: "🔍 الحالة",
    refresh: "🔄 تحديث",
    del_bot: "🗑️ حذف الروبوت",
    del_db: "🗄️ حذف قاعدة البيانات",
    list_bots: "« قائمة الروبوتات",
    create_bot: "➕ إنشاء روبوت",
    cancel: "❌ إلغاء",
    back: "« رجوع",
    back_to_bot: "« العودة للروبوت",
    refresh_logs: "🔄 تحديث السجلات",
    del_yes: "✅ نعم، احذف",
    create_new: "➕ إنشاء جديد",
    del_exchange: "🗑️ حذف ",
    add_exchange: "➕ إضافة منصة",
    back_to_list: "« العودة للقائمة",
    create_run: "✅ إنشاء وتشغيل",
    main_menu: "🏠 القائمة الرئيسية",
    ai_analyzing: "🧠 الذكاء الاصطناعي يحلل الطلب...",
  },
  hi: {
    stop: "🛑 रोकें",
    start: "▶️ शुरू करें",
    logs: "📋 लॉग",
    pnl: "📊 PnL",
    history: "📈 इतिहास",
    status: "🔍 स्थिति",
    refresh: "🔄 रीफ़्रेश करें",
    del_bot: "🗑️ बॉट हटाएँ",
    del_db: "🗄️ डेटाबेस हटाएँ",
    list_bots: "« बॉट सूची",
    create_bot: "➕ बॉट बनाएँ",
    cancel: "❌ रद्द करें",
    back: "« वापस",
    back_to_bot: "« बॉट पर वापस",
    refresh_logs: "🔄 लॉग रीफ़्रेश करें",
    del_yes: "✅ हाँ, हटाएँ",
    create_new: "➕ नया बनाएँ",
    del_exchange: "🗑️ हटाएँ ",
    add_exchange: "➕ एक्सचेंज जोड़ें",
    back_to_list: "« सूची पर वापस",
    create_run: "✅ बनाएँ और चलाएँ",
    main_menu: "🏠 मुख्य मेनू",
    ai_analyzing: "🧠 AI अनुरोध का विश्लेषण कर रहा है...",
  },
  fr: {
    stop: "🛑 Arrêter",
    start: "▶️ Démarrer",
    logs: "📋 Journaux",
    pnl: "📊 PnL",
    history: "📈 Historique",
    status: "🔍 Statut",
    refresh: "🔄 Actualiser",
    del_bot: "🗑️ Supprimer le bot",
    del_db: "🗄️ Supprimer la base",
    list_bots: "« Liste des bots",
    create_bot: "➕ Créer un bot",
    cancel: "❌ Annuler",
    back: "« Retour",
    back_to_bot: "« Retour au bot",
    refresh_logs: "🔄 Actualiser les journaux",
    del_yes: "✅ Oui, supprimer",
    create_new: "➕ Créer un nouveau",
    del_exchange: "🗑️ Supprimer ",
    add_exchange: "➕ Ajouter un échange",
    back_to_list: "« Retour à la liste",
    create_run: "✅ Créer et exécuter",
    main_menu: "🏠 Menu principal",
    ai_analyzing: "🧠 L'IA analyse la demande...",
  },
  de: {
    stop: "🛑 Stoppen",
    start: "▶️ Starten",
    logs: "📋 Protokolle",
    pnl: "📊 PnL",
    history: "📈 Verlauf",
    status: "🔍 Status",
    refresh: "🔄 Aktualisieren",
    del_bot: "🗑️ Bot löschen",
    del_db: "🗄️ Datenbank löschen",
    list_bots: "« Bot-Liste",
    create_bot: "➕ Bot erstellen",
    cancel: "❌ Abbrechen",
    back: "« Zurück",
    back_to_bot: "« Zurück zum Bot",
    refresh_logs: "🔄 Protokolle aktualisieren",
    del_yes: "✅ Ja, löschen",
    create_new: "➕ Neu erstellen",
    del_exchange: "🗑️ Löschen ",
    add_exchange: "➕ Börse hinzufügen",
    back_to_list: "« Zurück zur Liste",
    create_run: "✅ Erstellen & ausführen",
    main_menu: "🏠 Hauptmenü",
    ai_analyzing: "🧠 KI analysiert die Anfrage...",
  },
  pt: {
    stop: "🛑 Parar",
    start: "▶️ Iniciar",
    logs: "📋 Logs",
    pnl: "📊 PnL",
    history: "📈 Histórico",
    status: "🔍 Status",
    refresh: "🔄 Atualizar",
    del_bot: "🗑️ Excluir bot",
    del_db: "🗄️ Excluir banco",
    list_bots: "« Lista de bots",
    create_bot: "➕ Criar bot",
    cancel: "❌ Cancelar",
    back: "« Voltar",
    back_to_bot: "« Voltar ao bot",
    refresh_logs: "🔄 Atualizar logs",
    del_yes: "✅ Sim, excluir",
    create_new: "➕ Criar novo",
    del_exchange: "🗑️ Excluir ",
    add_exchange: "➕ Adicionar exchange",
    back_to_list: "« Voltar à lista",
    create_run: "✅ Criar e executar",
    main_menu: "🏠 Menu principal",
    ai_analyzing: "🧠 A IA está analisando a solicitação...",
  },
};

function ui(key) {
  return UI[userLang]?.[key] || UI.en[key];
}

function cleanAiResponse(text) {
  if (typeof text !== "string") return text;

  // Remove TOOLCALL markers and tool execution blocks
  text = text.replace(/TOOLCALL>\[[\s\S]*?\]ALL>/g, "");
  // Remove any remaining ALL> or TOOLCALL> markers
  text = text.replace(/ALL>/g, "").replace(/TOOLCALL>/g, "");

  // Remove Markdown formatting for plain text display
  // Remove bold: **text** or __text__ → text
  text = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
  // Remove italic: *text* or _text_ → text (but be careful with single * in middle of words)
  text = text.replace(/\*([^\*]+?)\*/g, "$1").replace(/_([^_]+?)_/g, "$1");
  // Remove inline code: `text` → text
  text = text.replace(/`([^`]+?)`/g, "$1");
  // Remove code blocks: ```text``` → text
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/```/g, "").trim();
  });
  // Remove headers: ## text → text, # text → text, etc.
  text = text.replace(/^#+\s+/gm, "");
  // Remove links: [text](url) → text (url) or just text
  text = text.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, "$1 ($2)");
  // Remove HTML tags if any
  text = text.replace(/<[^>]+>/g, "");
  // Remove extra whitespace
  text = text.trim();

  return text;
}

async function sendAiMessage(chatId, text) {
  if (typeof text !== "string") return;

  try {
    // Clean tool call markers first
    text = cleanAiResponse(text);
    // Replace Hummingbot/hummingbot with AgentWXO/agentwxo
    text = text
      .replace(/Hummingbot/g, "AgentWXO")
      .replace(/hummingbot/g, "agentwxo");

    // Only send if there's actual content after cleaning
    if (!text || text.length === 0) return;

    // Split long messages (Telegram max 4096 chars)
    const MAX = 3800;
    if (text.length <= MAX) {
      // Send without parse_mode to avoid Markdown errors
      await bot.sendMessage(chatId, text).catch((err) => {
        console.error("AI message error:", err.message);
        // If it fails, try again without any special handling
        bot.sendMessage(chatId, text).catch(() => {});
      });
      return;
    }

    // Split by lines for long messages
    const lines = text.split("\n");
    let chunk = "";
    for (const line of lines) {
      if ((chunk + line + "\n").length > MAX) {
        if (chunk.trim()) {
          await bot.sendMessage(chatId, chunk).catch(() => {});
        }
        chunk = line + "\n";
      } else {
        chunk += line + "\n";
      }
    }
    if (chunk.trim()) {
      await bot.sendMessage(chatId, chunk).catch(() => {});
    }
  } catch (err) {
    console.error("AI message send failed:", err.message);
    // Silently fail to avoid crashes
  }
}

// === Переводы ===
const LANG = {
  ru: {
    start: "🚀 Выполняю команду: start ",
    stop: "🛑 Выполняю команду: stop...",
    started: "✅ Процесс запущен.",
    stopped: "✅ Процесс остановлен.",
    show: "📄 Загружаю конфиг...",
    updated: "✅ Значение обновлено.",
    no_change: "ℹ️ Значение не изменилось.",
    unknown_key: "❌ Неизвестный ключ в конфигурации.",
    type_mismatch: "⚠️ Неверный тип значения.",
    error_update: "⚙️ Ошибка при обновлении конфигурации.",
    added: "➕ Новый параметр добавлен.",
    exiting: "🚪 Выполняется `exit` ",
    exited: "✅ Команда `exit` отправлена.",
    restart_wait_exit: "⚠️ Для перезапуска сначала выполните /exit.",
    exit_wait_restart: "⚠️ Сначала выполните /restart перед следующим /exit",
    restarting: "🔄 Выполняется ввод restart.",
    restarted: "✅ Команда restart отправлена.",
    db_deleted: "🗑️ Удаление базы данных.",
    db_failed: "⚠️ Ошибка при удалении базы.",
    help: `
📘 *Команды управления:*

▶️ /start — запустить процесс

⏹️ /stop — остановить процесс

🚪 /exit — выход 

🔄 /restart — перезапустить (после /exit)

🗑️ /del — удалить базу данных 

🧾 *Работа с config1:*
📄 /showconfig1 — показать содержимое
⚙️ /setconfig1 <ключ> <значение> — изменить параметр

🧩 *Работа с config2:*
📄 /showconfig2 — показать содержимое
⚙️ /setconfig2 <ключ> <значение> — изменить параметр

🌐 /language — переключить язык
📚 Документация: https://trade.coinmarketfacts.com/doc.html
    `,
    lang_switched: "✅ Язык переключен на русский 🇷🇺",
    menu: `🤖 trade.coinmarketfacts.com
*Управление:*
Выберите действие:

▶️ /start — запустить процесс  

⏹️ /stop — остановить процесс  

🚪 /exit — выход  

🔄 /restart — перезапустить (после /exit)  

🗑️ /del — удалить базу данных  

📘 /help — помощь  

🌐 /language — переключить язык`,
  },
  en: {
    start: "🚀 Executing command: start. ",
    stop: "🛑 Executing command: stop...",
    started: "✅ Process started.",
    stopped: "✅ Process stopped.",
    show: "📄 Loading configuration...",
    updated: "✅ Value updated.",
    no_change: "ℹ️ Value not changed.",
    unknown_key: "❌ Unknown key in configuration.",
    type_mismatch: "⚠️ Incorrect value type.",
    error_update: "⚙️ Error updating configuration.",
    added: "➕ Added new parameter.",
    exiting: "🚪 Executing command: exit. ",
    exited: "✅ The exit command has been sent.",
    restart_wait_exit: "⚠️ To restart, first execute /exit.",
    exit_wait_restart: "⚠️ First execute /restart before the next /exit",
    restarting: "🔄 Executing command: restart.",
    restarted: "✅ The restart command has been sent.",
    db_deleted: "🗑️ Deleting the database.",
    db_failed: "⚠️ Error while deleting database.",
    help: `
📘 *Available Commands:*

▶️ /start — start process

⏹️ /stop — stop process

🚪 /exit — exit

🔄 /restart — restart (after /exit)  

🗑️ /del — delete database 

🧾 *Main config (config1):*
📄 /showconfig1 — show configuration
⚙️ /setconfig1 <key> <value> — update parameter

🧩 *Secondary config (config2):*
📄 /showconfig2 — show configuration
⚙️ /setconfig2 <key> <value> — update parameter

🌐 /language — switch language
📚 Documentation: https://trade.coinmarketfacts.com/doc.html
    `,
    lang_switched: "✅ Language switched to English 🇺🇸",
    menu: `🤖 trade.coinmarketfacts.com
*Control:*
Choose an action:

▶️ /start — start process  

⏹️ /stop — stop process  

🚪 /exit — exit  

🔄 /restart — restart (after /exit)  

🗑️ /del — delete database  

📘 /help — help  

🌐 /language — switch language`,
  },
  zh: {
    start: "🚀 执行命令: start.",
    stop: "🛑 执行命令: stop...",
    started: "✅ 进程已启动。",
    stopped: "✅ 进程已停止。",
    show: "📄 正在加载配置…",
    updated: "✅ 值已更新。",
    no_change: "ℹ️ 值未更改。",
    unknown_key: "❌ 配置中未知的键。",
    type_mismatch: "⚠️ 值类型不正确。",
    error_update: "⚙️ 更新配置时出错。",
    added: "➕ 新参数已添加。",
    exiting: "🚪 正在执行 `exit`。",
    exited: "✅ `exit` 命令已发送。",
    restart_wait_exit: "⚠️ 若要重启，请先执行 /exit。",
    exit_wait_restart: "⚠️ 在执行下一个 /exit 之前，请先执行 /restart",
    restarting: "🔄 正在执行命令: restart。",
    restarted: "✅ restart 命令已发送。",
    db_deleted: "🗑️ 正在删除数据库。",
    db_failed: "⚠️ 删除数据库时出错。",
    help: `
📘 *可用命令:*

▶️ /start — 启动进程  

⏹️ /stop — 停止进程  

🚪 /exit — 退出  

🔄 /restart — 重启（在 /exit 后）  

🗑️ /del — 删除数据库  

🧾 *主配置 (config1):*  
📄 /showconfig1 — 显示配置  
⚙️ /setconfig1 <键> <值> — 更新参数

🧩 *次配置 (config2):*  
📄 /showconfig2 — 显示配置  
⚙️ /setconfig2 <键> <值> — 更新参数

🌐 /language — 切换语言  
📚 文档: https://trade.coinmarketfacts.com/doc.html
    `,
    menu: `
🏠 *主菜单:* trade.coinmarketfacts.com

▶️ /start — 启动进程  

⏹️ /stop — 停止进程  

🚪 /exit — 退出  

🔄 /restart — 重启  

🗑️ /del — 删除数据库  

🧾 /showconfig1 主配置  

🧩 /showconfig2 次配置  

🌐 /language 切换语言  

📚 /help 查看文档
    `,
    lang_switched: "✅ 语言切换到中文 🇨🇳",
  },

  ja: {
    start: "🚀 コマンド実行: start.",
    stop: "🛑 コマンド実行: stop...",
    started: "✅ プロセスが開始されました。",
    stopped: "✅ プロセスが停止しました。",
    show: "📄 設定を読み込み中…",
    updated: "✅ 値が更新されました。",
    no_change: "ℹ️ 値は変更されていません。",
    unknown_key: "❌ 設定に不明なキーがあります。",
    type_mismatch: "⚠️ 値の型が正しくありません。",
    error_update: "⚙️ 設定の更新中にエラーが発生しました。",
    added: "➕ 新しいパラメータが追加されました。",
    exiting: "🚪 `exit` を実行しています。",
    exited: "✅ `exit` コマンドが送信されました。",
    restart_wait_exit: "⚠️ 再起動するには、まず /exit を実行してください。",
    exit_wait_restart:
      "⚠️ 次の /exit を実行する前に /restart を実行してください",
    restarting: "🔄 コマンド実行: restart。",
    restarted: "✅ restart コマンドが送信されました。",
    db_deleted: "🗑️ データベースを削除中。",
    db_failed: "⚠️ データベース削除中にエラーが発生しました。",
    help: `
📘 *使用可能なコマンド:*

▶️ /start — プロセスを開始  

⏹️ /stop — プロセスを停止  

🚪 /exit — 終了  

🔄 /restart — 再起動 (/exit 後)  

🗑️ /del — データベースを削除  

🧾 *メイン設定 (config1):*  
📄 /showconfig1 — 設定表示  
⚙️ /setconfig1 <キー> <値> — パラメータ更新

🧩 *サブ設定 (config2):*  
📄 /showconfig2 — 設定表示  
⚙️ /setconfig2 <キー> <値> — パラメータ更新

🌐 /language — 言語切替  
📚 ドキュメント: https://trade.coinmarketfacts.com/doc.html
    `,
    menu: `
🏠 *メインメニュー:* trade.coinmarketfacts.com

▶️ /start — プロセス開始  

⏹️ /stop — プロセス停止  

🚪 /exit — 終了  

🔄 /restart — 再起動  

🗑️ /del — データベース削除  

🌐 /language 言語切替  

📚 /help ドキュメント閲覧
    `,
    lang_switched: "✅ 言語が日本語に切り替わりました 🇯🇵",
  },

  es: {
    start: "🚀 Ejecutando comando: /start.",
    stop: "🛑 Ejecutando comando: /stop...",
    started: "✅ Proceso iniciado.",
    stopped: "✅ Proceso detenido.",
    show: "📄 Cargando configuración…",
    updated: "✅ Valor actualizado.",
    no_change: "ℹ️ El valor no ha cambiado.",
    unknown_key: "❌ Clave desconocida en la configuración.",
    type_mismatch: "⚠️ Tipo de valor incorrecto.",
    error_update: "⚙️ Error al actualizar la configuración.",
    added: "➕ Nuevo parámetro añadido.",
    exiting: "🚪 Ejecutando /exit.",
    exited: "✅ Comando /exit enviado.",
    restart_wait_exit: "⚠️ Para reiniciar, primero ejecute /exit.",
    exit_wait_restart: "⚠️ Primero ejecute /restart antes del siguiente /exit",
    restarting: "🔄 Ejecutando comando: /restart.",
    restarted: "✅ Comando /restart enviado.",
    db_deleted: "🗑️ Eliminando base de datos.",
    db_failed: "⚠️ Error al eliminar base de datos.",
    help: `
📘 *Comandos disponibles:*

▶️ /start — iniciar proceso  

⏹️ /stop — detener proceso  

🚪 /exit — salir  

🔄 /restart — reiniciar (/exit después)  

🗑️ /del — eliminar base de datos  

🧾 *Configuración principal (config1):*  
📄 /showconfig1 — mostrar configuración  
⚙️ /setconfig1 <clave> <valor> — actualizar parámetro

🧩 *Configuración secundaria (config2):*  
📄 /showconfig2 — mostrar configuración  
⚙️ /setconfig2 <clave> <valor> — actualizar parámetro

🌐 /language — cambiar idioma  
📚 Documentación: https://trade.coinmarketfacts.com/doc.html
    `,
    menu: `
🏠 *Menú principal:* trade.coinmarketfacts.com

▶️ /start — Iniciar proceso  

⏹️ /stop — Detener proceso  

🚪 /exit — Salir  

🔄 /restart — Reiniciar  

🗑️ /del — Eliminar base de datos  

🌐 /language Cambiar idioma  

📚 /help Documentación 
    `,
    lang_switched: "✅ Idioma cambiado a español 🇪🇸",
  },

  tr: {
    start: "🚀 Komut çalıştırılıyor: /start.",
    stop: "🛑 Komut çalıştırılıyor: /stop...",
    started: "✅ Süreç başlatıldı.",
    stopped: "✅ Süreç durduruldu.",
    show: "📄 Yapılandırma yükleniyor…",
    updated: "✅ Değer güncellendi.",
    no_change: "ℹ️ Değer değişmedi.",
    unknown_key: "❌ Yapılandırmada bilinmeyen anahtar.",
    type_mismatch: "⚠️ Yanlış değer türü.",
    error_update: "⚙️ Yapılandırma güncellenirken hata oluştu.",
    added: "➕ Yeni parametre eklendi.",
    exiting: "🚪 /exit çalıştırılıyor.",
    exited: "✅ /exit komutu gönderildi.",
    restart_wait_exit: "⚠️ Yeniden başlatmak için önce /exit çalıştırın.",
    exit_wait_restart:
      "⚠️ Sonraki /exit için önce /restart komutunu çalıştırın",
    restarting: "🔄 Komut çalıştırılıyor: /restart.",
    restarted: "✅ /restart komutu gönderildi.",
    db_deleted: "🗑️ Veritabanı siliniyor.",
    db_failed: "⚠️ Veritabanı silinirken hata oluştu.",
    help: `
📘 *Kullanılabilir komutlar:*

▶️ /start — işlemi başlat  

⏹️ /stop — işlemi durdur  

🚪 /exit — çıkış  

🔄 /restart — yeniden başlat (/exit sonrası)  

🗑️ /del — veritabanını sil  

🧾 *Ana yapılandırma (config1):*  
📄 /showconfig1 — yapılandırmayı göster  
⚙️ /setconfig1 <anahtar> <değer> — parametreyi güncelle

🧩 *İkincil yapılandırma (config2):*  
📄 /showconfig2 — yapılandırmayı göster  
⚙️ /setconfig2 <anahtar> <değer> — parametreyi güncelle

🌐 /language — dili değiştir  
📚 Dokümantasyon: https://trade.coinmarketfacts.com/doc.html
    `,
    menu: `
🏠 *Ana Menü:* trade.coinmarketfacts.com

▶️ /start — Süreci başlat  

⏹️ /stop — Süreci durdur  

🚪 /exit — Çıkış  

🔄 /restart — Yeniden başlat  

🗑️ /del — Veritabanını sil  

🧾 /showconfig1 Ana yapılandırma  

🧩 /showconfig2 İkincil yapılandırma  

🌐 /language Dil değiştir  

📚 /help Dokümantasyon
    `,
    lang_switched: "✅ Dil Türkçe olarak değiştirildi 🇹🇷",
  },
  vi: {
    start: "🚀 Thực thi lệnh: /start.",
    stop: "🛑 Thực thi lệnh: /stop...",
    started: "✅ Tiến trình đã bắt đầu.",
    stopped: "✅ Tiến trình đã dừng.",
    show: "📄 Đang tải cấu hình…",
    updated: "✅ Giá trị đã cập nhật.",
    no_change: "ℹ️ Giá trị không thay đổi.",
    unknown_key: "❌ Khóa không xác định trong cấu hình.",
    type_mismatch: "⚠️ Kiểu giá trị không hợp lệ.",
    error_update: "⚙️ Lỗi khi cập nhật cấu hình.",
    added: "➕ Tham số mới đã được thêm.",
    exiting: "🚪 Thực thi /exit.",
    exited: "✅ Lệnh /exit đã gửi.",
    restart_wait_exit: "⚠️ Để khởi động lại, trước tiên thực hiện /exit.",
    exit_wait_restart:
      "⚠️ Thực hiện /restart trước khi thực hiện /exit tiếp theo",
    restarting: "🔄 Thực thi lệnh: /restart.",
    restarted: "✅ Lệnh /restart đã gửi.",
    db_deleted: "🗑️ Xóa cơ sở dữ liệu.",
    db_failed: "⚠️ Lỗi khi xóa cơ sở dữ liệu.",
    help: `📘 *Các lệnh có sẵn:*

▶️ /start — bắt đầu tiến trình  

⏹️ /stop — dừng tiến trình  

🚪 /exit — thoát  

🔄 /restart — khởi động lại (/exit sau)  

🗑️ /del — xóa cơ sở dữ liệu  

🧾 *Cấu hình chính (config1):*  
📄 /showconfig1 — hiển thị cấu hình  
⚙️ /setconfig1 <khóa> <giá trị> — cập nhật tham số

🧩 *Cấu hình phụ (config2):*  
📄 /showconfig2 — hiển thị cấu hình  
⚙️ /setconfig2 <khóa> <giá trị> — cập nhật tham số

🌐 /language — chuyển ngôn ngữ  
📚 Tài liệu: https://trade.coinmarketfacts.com/doc.html`,
    menu: `🏠 *Menu chính:* trade.coinmarketfacts.com

▶️ /start — Bắt đầu tiến trình  

⏹️ /stop — Dừng tiến trình  

🚪 /exit — Thoát  

🔄 /restart — Khởi động lại  

🗑️ /del — Xóa cơ sở dữ liệu  

🌐 /language Chuyển ngôn ngữ  

📚 /help Tài liệu`,
    lang_switched: "✅ Ngôn ngữ đã chuyển sang tiếng Việt 🇻🇳",
  },

  ko: {
    start: "🚀 명령 실행: /start.",
    stop: "🛑 명령 실행: /stop...",
    started: "✅ 프로세스가 시작되었습니다.",
    stopped: "✅ 프로세스가 중지되었습니다.",
    show: "📄 구성 불러오는 중…",
    updated: "✅ 값이 업데이트되었습니다.",
    added: "➕ 새 매개변수가 추가되었습니다.",
    no_change: "ℹ️ 값이 변경되지 않았습니다.",
    unknown_key: "❌ 구성에 알 수 없는 키가 있습니다.",
    type_mismatch: "⚠️ 잘못된 값 유형입니다.",
    error_update: "⚙️ 구성 업데이트 중 오류가 발생했습니다.",
    exiting: "🚪 /exit 실행 중.",
    exited: "✅ /exit 명령 전송됨.",
    restart_wait_exit: "⚠️ 재시작하려면 먼저 /exit 실행.",
    exit_wait_restart: "⚠️ 다음 /exit 전에 먼저 /restart를 실행하세요",
    restarting: "🔄 명령 실행: /restart.",
    restarted: "✅ /restart 명령 전송됨.",
    db_deleted: "🗑️ 데이터베이스 삭제 중.",
    db_failed: "⚠️ 데이터베이스 삭제 중 오류 발생.",
    help: `📘 *사용 가능한 명령:*

▶️ /start — 프로세스 시작  

⏹️ /stop — 프로세스 중지  

🚪 /exit — 종료  

🔄 /restart — 재시작 (/exit 이후)  

🗑️ /del — 데이터베이스 삭제  

🧾 *메인 구성 (config1):*  
📄 /showconfig1 — 구성 표시  
⚙️ /setconfig1 <키> <값> — 매개변수 업데이트

🧩 *보조 구성 (config2):*  
📄 /showconfig2 — 구성 표시  
⚙️ /setconfig2 <키> <값> — 매개변수 업데이트

🌐 /language — 언어 변경  
📚 문서: https://trade.coinmarketfacts.com/doc.html`,
    menu: `🏠 *메인 메뉴:* trade.coinmarketfacts.com

▶️ /start — 프로세스 시작  

⏹️ /stop — 프로세스 중지  

🚪 /exit — 종료  

🔄 /restart — 재시작  

🗑️ /del — 데이터베이스 삭제  

🌐 /language 언어 변경  

📚 /help 문서`,
    lang_switched: "✅ 언어가 한국어로 변경되었습니다 🇰🇷",
  },

  ar: {
    start: "🚀 تنفيذ الأمر: /start.",
    stop: "🛑 تنفيذ الأمر: /stop...",
    started: "✅ تم تشغيل العملية.",
    stopped: "✅ تم إيقاف العملية.",
    show: "📄 جارٍ تحميل التكوين…",
    updated: "✅ تم تحديث القيمة.",
    no_change: "ℹ️ لم يتم تغيير القيمة.",
    unknown_key: "❌ مفتاح غير معروف في التكوين.",
    type_mismatch: "⚠️ نوع القيمة غير صحيح.",
    error_update: "⚙️ خطأ أثناء تحديث التكوين.",
    added: "➕ تم إضافة معلمة جديدة.",
    exiting: "🚪 تنفيذ /exit.",
    exited: "✅ تم إرسال /exit.",
    restart_wait_exit: "⚠️ لإعادة التشغيل، يرجى تنفيذ /exit أولاً.",
    exit_wait_restart: "⚠️ يرجى تنفيذ /restart قبل /exit التالي",
    restarting: "🔄 تنفيذ الأمر: /restart.",
    restarted: "✅ تم إرسال /restart.",
    db_deleted: "🗑️ جارٍ حذف قاعدة البيانات.",
    db_failed: "⚠️ خطأ أثناء حذف قاعدة البيانات.",
    help: `📘 *الأوامر المتاحة:*

▶️ /start — بدء العملية  

⏹️ /stop — إيقاف العملية  

🚪 /exit — خروج  

🔄 /restart — إعادة التشغيل (/exit بعد)  

🗑️ /del — حذف قاعدة البيانات  

🧾 *التكوين الرئيسي (config1):*  
📄 /showconfig1 — عرض التكوين  
⚙️ /setconfig1 <مفتاح> <قيمة> — تحديث المعلمة

🧩 *التكوين الثانوي (config2):*  
📄 /showconfig2 — عرض التكوين  
⚙️ /setconfig2 <مفتاح> <قيمة> — تحديث المعلمة

🌐 /language — تغيير اللغة  
📚 الوثائق: https://trade.coinmarketfacts.com/doc.html`,
    menu: `🏠 *القائمة الرئيسية:* trade.coinmarketfacts.com

▶️ /start — بدء العملية  

⏹️ /stop — إيقاف العملية  

🚪 /exit — خروج  

🔄 /restart — إعادة التشغيل  

🗑️ /del — حذف قاعدة البيانات  

🌐 /language تغيير اللغة  

📚 /help الوثائق`,
    lang_switched: "✅ تم تغيير اللغة إلى العربية 🇸🇦",
  },

  hi: {
    start: "🚀 कमांड निष्पादित: /start.",
    stop: "🛑 कमांड निष्पादित: /stop...",
    started: "✅ प्रक्रिया प्रारंभ हो चुकी है।",
    stopped: "✅ प्रक्रिया रोक दी गई है।",
    show: "📄 कॉन्फ़िग लोड हो रहा है…",
    updated: "✅ मान अपडेट किया गया है।",
    no_change: "ℹ️ मान बदल नहीं गया।",
    unknown_key: "❌ कॉन्फ़िगरेशन में अज्ञात कुंजी।",
    type_mismatch: "⚠️ गलत मूल्य प्रकार।",
    error_update: "⚙️ कॉन्फ़िगरेशन अपडेट करते समय त्रुटि।",
    added: "➕ नया पैरामीटर जोड़ा गया है।",
    exiting: "🚪 /exit निष्पादित हो रहा है।",
    exited: "✅ /exit कमांड भेजी गई।",
    restart_wait_exit: "⚠️ पुनःप्रारंभ करने के लिए पहले /exit निष्पादित करें।",
    exit_wait_restart: "⚠️ अगले /exit से पहले /restart निष्पादित करें",
    restarting: "🔄 कमांड निष्पादित: /restart.",
    restarted: "✅ /restart कमांड भेजी गई।",
    db_deleted: "🗑️ डेटाबेस हटाया जा रहा है।",
    db_failed: "⚠️ डेटाबेस हटाने में त्रुटि हुई।",
    help: `📘 *उपलब्ध कमांड्स:*

▶️ /start — प्रक्रिया शुरू करें  

⏹️ /stop — प्रक्रिया रोकें  

🚪 /exit — बाहर निकलें  

🔄 /restart — पुनःप्रारंभ करें (/exit के बाद)  

🗑️ /del — डेटाबेस हटाएँ  

🧾 *मुख्य कॉन्फ़िग (config1):*  
📄 /showconfig1 — कॉन्फ़िग दिखाएँ  
⚙️ /setconfig1 <कुंजी> <मान> — पैरामीटर अपडेट करें

🧩 *सहायक कॉन्फ़िग (config2):*  
📄 /showconfig2 — कॉन्फ़िग दिखाएँ  
⚙️ /setconfig2 <कुंजी> <मान> — पैरामीटर अपडेट करें

🌐 /language — भाषा बदलें  
📚 प्रलेखन: https://trade.coinmarketfacts.com/doc.html`,
    menu: `🏠 *मुख्य मेन्यू:* trade.coinmarketfacts.com

▶️ /start — प्रक्रिया शुरू करें  

⏹️ /stop — प्रक्रिया रोकें  

🚪 /exit — बाहर निकलें  

🔄 /restart — पुनःप्रारंभ करें  

🗑️ /del — डेटाबेस हटाएँ  
  
🌐 /language भाषा बदलें  

📚 /help प्रलेखन`,
    lang_switched: "✅ भाषा हिंदी में बदल दी गई 🇮🇳",
  },

  fr: {
    start: "🚀 Exécution de la commande: /start.",
    stop: "🛑 Exécution de la commande: /stop...",
    started: "✅ Processus démarré.",
    stopped: "✅ Processus arrêté.",
    show: "📄 Chargement de la configuration…",
    updated: "✅ Valeur mise à jour.",
    no_change: "ℹ️ La valeur n'a pas changé.",
    unknown_key: "❌ Clé inconnue dans la configuration.",
    type_mismatch: "⚠️ Type de valeur incorrect.",
    error_update: "⚙️ Erreur lors de la mise à jour de la configuration.",
    added: "➕ Nouveau paramètre ajouté.",
    exiting: "🚪 Exécution /exit.",
    exited: "✅ /exit envoyé.",
    restart_wait_exit: "⚠️ Pour redémarrer, exécutez d’abord /exit.",
    exit_wait_restart: "⚠️ Exécutez /restart avant le prochain /exit",
    restarting: "🔄 Exécution de la commande: /restart.",
    restarted: "✅ /restart envoyé.",
    db_deleted: "🗑️ Suppression de la base de données.",
    db_failed: "⚠️ Erreur lors de la suppression de la base de données.",
    help: `📘 *Commandes disponibles:*

▶️ /start — démarrer le processus  

⏹️ /stop — arrêter le processus  

🚪 /exit — quitter  

🔄 /restart — redémarrer (/exit après)  

🗑️ /del — supprimer la base de données  

🧾 *Configuration principale (config1):*  
📄 /showconfig1 — afficher la configuration  
⚙️ /setconfig1 <clé> <valeur> — mettre à jour un paramètre

🧩 *Configuration secondaire (config2):*  
📄 /showconfig2 — afficher la configuration  
⚙️ /setconfig2 <clé> <valeur> — mettre à jour un paramètre

🌐 /language — changer de langue  
📚 Documentation: https://trade.coinmarketfacts.com/doc.html`,
    menu: `🏠 *Menu principal:* trade.coinmarketfacts.com

▶️ /start — Démarrer processus  

⏹️ /stop — Arrêter processus  

🚪 /exit — Quitter  

🔄 /restart — Redémarrer  

🗑️ /del — Supprimer base de données  

🌐 /language Changer langue  

📚 /help Documentation`,
    lang_switched: "✅ Langue changée en français 🇫🇷",
  },

  de: {
    start: "🚀 Befehl wird ausgeführt: /start.",
    stop: "🛑 Befehl wird ausgeführt: /stop...",
    started: "✅ Prozess gestartet.",
    stopped: "✅ Prozess gestoppt.",
    show: "📄 Konfiguration wird geladen…",
    updated: "✅ Wert aktualisiert.",
    no_change: "ℹ️ Wert wurde nicht geändert.",
    unknown_key: "❌ Unbekannter Schlüssel in der Konfiguration.",
    type_mismatch: "⚠️ Falscher Werttyp.",
    error_update: "⚙️ Fehler beim Aktualisieren der Konfiguration.",
    added: "➕ Neuer Parameter hinzugefügt.",
    exiting: "🚪 /exit wird ausgeführt.",
    exited: "✅ /exit Befehl gesendet.",
    restart_wait_exit: "⚠️ Zum Neustart zuerst /exit ausführen.",
    exit_wait_restart:
      "⚠️ Führen Sie zuerst /restart aus, bevor Sie /exit erneut ausführen",
    restarting: "🔄 Befehl wird ausgeführt: /restart.",
    restarted: "✅ /restart Befehl gesendet.",
    db_deleted: "🗑️ Datenbank wird gelöscht.",
    db_failed: "⚠️ Fehler beim Löschen der Datenbank.",
    help: `📘 *Verfügbare Befehle:* trade.coinmarketfacts.com

▶️ /start — Prozess starten  

⏹️ /stop — Prozess stoppen  

🚪 /exit — Beenden  

🔄 /restart — Neustarten (/exit nach)  

🗑️ /del — Datenbank löschen  

🧾 *Hauptkonfiguration (config1):*  
📄 /showconfig1 — Konfiguration anzeigen  
⚙️ /setconfig1 <Schlüssel> <Wert> — Parameter aktualisieren

🧩 *Nebenkonfiguration (config2):*  
📄 /showconfig2 — Konfiguration anzeigen  
⚙️ /setconfig2 <Schlüssel> <Wert> — Parameter aktualisieren

🌐 /language — Sprache wechseln  
📚 Dokumentation: https://trade.coinmarketfacts.com/doc.html`,
    menu: `🏠 *Hauptmenü:*

▶️ /start — Prozess starten  

⏹️ /stop — Prozess stoppen  

🚪 /exit — Beenden  

🔄 /restart — Neustarten  

🗑️ /del — Datenbank löschen  

🌐 /language Sprache wechseln  

📚 /help Dokumentation`,
    lang_switched: "✅ Sprache wurde auf Deutsch geändert 🇩🇪",
  },

  pt: {
    start: "🚀 Executando comando: /start.",
    stop: "🛑 Executando comando: /stop...",
    started: "✅ Processo iniciado.",
    stopped: "✅ Processo parado.",
    show: "📄 Carregando configuração…",
    updated: "✅ Valor atualizado.",
    no_change: "ℹ️ O valor não foi alterado.",
    unknown_key: "❌ Chave desconhecida na configuração.",
    type_mismatch: "⚠️ Tipo de valor incorreto.",
    error_update: "⚙️ Erro ao atualizar a configuração.",
    added: "➕ Novo parâmetro adicionado.",
    exiting: "🚪 Executando /exit.",
    exited: "✅ /exit comando enviado.",
    restart_wait_exit: "⚠️ Para reiniciar, execute primeiro /exit.",
    exit_wait_restart: "⚠️ Execute /restart antes do próximo /exit",
    restarting: "🔄 Executando comando: /restart.",
    restarted: "✅ /restart comando enviado.",
    db_deleted: "🗑️ Excluindo banco de dados.",
    db_failed: "⚠️ Erro ao excluir banco de dados.",
    help: `📘 *Comandos disponíveis:*

▶️ /start — iniciar processo  

⏹️ /stop — parar processo  

🚪 /exit — sair  

🔄 /restart — reiniciar (/exit após)  

🗑️ /del — excluir banco de dados  

🧾 *Configuração principal (config1):*  
📄 /showconfig1 — mostrar configuração  
⚙️ /setconfig1 <chave> <valor> — atualizar parâmetro

🧩 *Configuração secundária (config2):*  
📄 /showconfig2 — mostrar configuração  
⚙️ /setconfig2 <chave> <valor> — atualizar parâmetro

🌐 /language — alternar idioma  
📚 Documentação: https://trade.coinmarketfacts.com/doc.html`,
    menu: `🏠 *Menu principal:* trade.coinmarketfacts.com

▶️ /start — Iniciar processo  

⏹️ /stop — Parar processo  

🚪 /exit — Sair  

🔄 /restart — Reiniciar  

🗑️ /del — Excluir banco de dados  

🌐 /language Alternar idioma  

📚 /help Documentação`,
    lang_switched: "✅ Idioma alterado para português 🇧🇷",
  },
};

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// Выполнение локальных команд
function execCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve(stdout || stderr || error || "Нет вывода");
    });
  });
}

function showMenuLater(chatId, delay = 4000) {
  setTimeout(() => sendMainMenu(chatId), delay);
}

function saveApiYaml(key, value) {
  const dir = path.dirname(API_YAML_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let data = {};
  if (fs.existsSync(API_YAML_FILE)) {
    data = YAML.parse(fs.readFileSync(API_YAML_FILE, "utf-8")) || {};
  }

  data[key] = value.trim();

  const yamlOut = YAML.stringify(data);

  fs.writeFileSync(API_YAML_FILE, yamlOut, {
    encoding: "utf-8",
    mode: 0o600, // защита файла
  });
}

// --- Вспомогательная функция: экранирование для RegExp ---
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Определяем правильный формат YAML ---
function detectValueFormat(key, rawValue) {
  if (rawValue === undefined || rawValue === null) return `${key}: ''`;

  let v = rawValue.toString().trim();
  let forcedString = false;

  // Проверяем, задал ли пользователь кавычки вручную
  if (
    (v.startsWith("'") && v.endsWith("'")) ||
    (v.startsWith('"') && v.endsWith('"'))
  ) {
    forcedString = true;
    v = v.slice(1, -1); // убираем внешние кавычки
  }

  // Булево
  if (!forcedString && (v === "true" || v === "false")) {
    return `${key}: ${v}`;
  }

  // Число
  if (!forcedString && v !== "" && !isNaN(v)) {
    return `${key}: ${v}`;
  }

  // Массив / объект (если похоже на JSON)
  if (!forcedString && /^[\[\{].*[\]\}]$/.test(v)) {
    return `${key}: ${v}`;
  }

  // Всё остальное — строка
  const escaped = v.replace(/'/g, "''"); // YAML экранирование
  return `${key}: '${escaped}'`;
}

// --- Определение типа значения на основе текущего YAML ---
function inferValueType(existingValue, newValueRaw) {
  let v = newValueRaw.trim();

  // Явное булево
  if (v.toLowerCase() === "true" || v.toLowerCase() === "false") {
    return v.toLowerCase() === "true";
  }

  // Явное число
  if (!isNaN(v) && v !== "") {
    return Number(v);
  }

  // Если в YAML уже было число — приведение к числу
  if (typeof existingValue === "number" && !isNaN(v)) {
    return Number(v);
  }

  // Если было булево — преобразуем
  if (typeof existingValue === "boolean") {
    return v.toLowerCase() === "true";
  }

  // JSON-подобные строки
  if (/^[\[\{].*[\]\}]$/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  // Строка по умолчанию
  return v;
}

async function updateYamlConfig(filePath, key, valueRaw) {
  const file = path.resolve(filePath);

  // Читаем YAML
  const yamlContent = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  let config = yamlContent ? YAML.parse(yamlContent) : {};

  if (!Object.keys(config).includes(key)) {
    throw new Error("unknown_key");
  }

  const currentValue = config[key];
  let newValueRaw = valueRaw.trim();

  // --- Определяем тип нового значения ---
  let newValue;
  if (typeof currentValue === "number") {
    if (isNaN(newValueRaw)) throw new Error("type_mismatch");
    newValue = Number(newValueRaw);
  } else if (typeof currentValue === "boolean") {
    if (!["true", "false"].includes(newValueRaw.toLowerCase()))
      throw new Error("type_mismatch");
    newValue = newValueRaw.toLowerCase() === "true";
  } else if (Array.isArray(currentValue) || typeof currentValue === "object") {
    try {
      const parsed = JSON.parse(newValueRaw);
      if (Array.isArray(currentValue) && !Array.isArray(parsed))
        throw new Error("type_mismatch");
      if (
        typeof currentValue === "object" &&
        (typeof parsed !== "object" || Array.isArray(parsed))
      )
        throw new Error("type_mismatch");
      newValue = parsed;
    } catch {
      throw new Error("type_mismatch");
    }
  } else {
    // Строка: убираем лишние кавычки, если пользователь ввёл их вручную
    if (
      (newValueRaw.startsWith("'") && newValueRaw.endsWith("'")) ||
      (newValueRaw.startsWith('"') && newValueRaw.endsWith('"'))
    ) {
      newValue = newValueRaw.slice(1, -1);
    } else {
      newValue = newValueRaw;
    }
  }

  if (currentValue === newValue) return "no_change";

  config[key] = newValue;

  // --- Список ключей, значения которых должны быть без кавычек ---
  const keysWithoutQuotes = new Set([
    "id",
    "controller_name",
    "controller_type",
    "connector_name",
    "trading_pair",
    "candles_connector_name",
    "candles_trading_pair",
    "position_mode",
    "database_path",
    "candles_interval",
  ]);

  // --- Сохраняем YAML вручную ---
  const lines = Object.keys(config).map((k) => {
    const val = config[k];

    if (typeof val === "number" || typeof val === "boolean") {
      return `${k}: ${val}`;
    }

    if (typeof val === "string") {
      if (keysWithoutQuotes.has(k)) {
        // Строки без кавычек
        return `${k}: ${val}`;
      } else {
        // Строки с одинарными кавычками
        return `${k}: '${val.replace(/'/g, "''")}'`;
      }
    }

    // Массивы и объекты
    return `${k}: ${JSON.stringify(val)}`;
  });

  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");

  return "updated";
}

// =============================================
// === API ===
// =============================================
const HBOT_URL = "http://localhost:8000";
const HBOT_AUTH = "Basic " + Buffer.from("admin:admin").toString("base64");

// HTTP клиент — поддерживает GET/POST/DELETE
function hbot(method, urlPath, body) {
  const http = require("http");
  const u = new URL(HBOT_URL + urlPath);
  return new Promise((resolve, reject) => {
    const reqBody = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: Number(u.port) || 80,
      path: u.pathname + (u.search || ""),
      method,
      headers: {
        Authorization: HBOT_AUTH,
        "Content-Type": "application/json",
        ...(reqBody ? { "Content-Length": Buffer.byteLength(reqBody) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve({ _raw: d, _status: res.statusCode });
        }
      });
    });
    req.on("error", (e) => reject(new Error("Сеть: " + e.message)));
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// Разбить длинное сообщение на части по 3800 символов
async function sendLong(chatId, text, opts) {
  const MAX = 3800;
  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text, opts || {});
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + line + "\n").length > MAX) {
      await bot.sendMessage(chatId, chunk, opts || {});
      chunk = "";
    }
    chunk += line + "\n";
  }
  if (chunk.trim()) await bot.sendMessage(chatId, chunk, opts || {});
}

// Кэш ботов: { botName: { status, performance, error_logs, general_logs, recently_active } }
let _bots = {};
async function loadBots() {
  const r = await hbot("GET", "/bot-orchestration/status");

  let payload = null;
  if (r && r.data && typeof r.data === "object") {
    const hasStatusField =
      "status" in r.data &&
      (r.data.status === "running" || r.data.status === "stopped");
    if (!hasStatusField) payload = r.data;
  }
  if (
    !payload &&
    r &&
    typeof r === "object" &&
    !r.detail &&
    !r._raw &&
    !r.status
  ) {
    payload = r;
  }

  if (payload && typeof payload === "object") {
    const filtered = {};
    for (const [k, v] of Object.entries(payload)) {
      if (
        typeof v === "object" &&
        v !== null &&
        ("status" in v || "performance" in v || "error_logs" in v)
      ) {
        filtered[k] = v;
      }
    }

    // Проверяем существование docker-контейнера — убираем "призраков" из MQTT
    const names = Object.keys(filtered);
    if (names.length > 0) {
      const psOut = await execCommand(
        `docker ps -a --format '{{.Names}}' 2>&1`
      ).catch(() => "");
      const runningContainers = new Set(
        psOut
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      for (const name of names) {
        if (!runningContainers.has(name)) {
          delete filtered[name]; // контейнера нет — убираем из списка
        }
      }
    }

    _bots = filtered;
    // Запоминаем последний активный инстанс для редактора конфигов
    const instNames = Object.keys(filtered);
    if (instNames.length > 0) {
      _activeInstance =
        instNames.find((n) => filtered[n]?.status === "running") ||
        instNames[0];
    }
    return true;
  }
  return false;
}

// Запустить бота с retry — ждём регистрации в MQTT (все ответы "not found" / false продолжают ожидание)
async function startBotWithRetry(instanceName, retries = 15, delayMs = 4000) {
  // Даём время инициализироваться (загрузить коннекторы, подключиться к бирже)
  await new Promise((res) => setTimeout(res, 8000));
  for (let i = 0; i < retries; i++) {
    const r = await hbot("POST", "/bot-orchestration/start-bot", {
      bot_name: instanceName,
      script: "v2_with_controllers",
      conf: instanceName,
    });
    if (r?.status === "success" && r?.response?.success === true)
      return { ok: true, result: r };
    const msg = (r?.response?.message || r?.message || "").toLowerCase();
    if (msg.includes("already running") || msg.includes("already started"))
      return { ok: true, result: r };
    // Любой "not found / not ready / not connected / false" — ждём ещё
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return { ok: false, result: { timedOut: true } };
}

// Пропатчить database_path во всех контроллерах бота
// Патчим в папке инстанса — именно оттуда бот читает конфиги при работе
function patchDatabasePath(instanceName) {
  const correctDbPath = `data/${instanceName}.sqlite`;
  const hostCtrlDir = instanceCtrlDir(instanceName);

  if (!fs.existsSync(hostCtrlDir)) {
    throw new Error(`Директория не найдена: ${hostCtrlDir}`);
  }

  const ymlFiles = fs
    .readdirSync(hostCtrlDir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => path.join(hostCtrlDir, f));

  if (!ymlFiles.length) {
    throw new Error(`YML файлы не найдены в ${hostCtrlDir}`);
  }

  const patched = [];
  for (const fpath of ymlFiles) {
    try {
      const raw = fs.readFileSync(fpath, "utf-8");
      if (!raw.includes("database_path")) continue; // этот контроллер не использует БД

      // Используем простую замену строки — надёжнее чем YAML.parse/stringify
      // который может изменить форматирование других полей
      const updated = raw.replace(
        /^database_path:.*$/m,
        `database_path: ${correctDbPath}`
      );

      if (updated !== raw) {
        fs.writeFileSync(fpath, updated, "utf-8");
        patched.push(path.basename(fpath));
      } else {
        // Значение уже правильное или ключ не найден через regex — проверим через YAML
        try {
          const cfg = YAML.parse(raw);
          if (
            cfg &&
            cfg.database_path !== undefined &&
            cfg.database_path !== correctDbPath
          ) {
            cfg.database_path = correctDbPath;
            // Перезаписываем только строку database_path, остальное не трогаем
            const fixed = raw.replace(
              /^database_path:.*$/m,
              `database_path: ${correctDbPath}`
            );
            fs.writeFileSync(fpath, fixed, "utf-8");
            patched.push(path.basename(fpath));
          }
        } catch (e) {}
      }
    } catch (e) {
      console.error(`Ошибка патча ${fpath}:`, e.message);
    }
  }

  return {
    patched: patched.length,
    path: correctDbPath,
    files: patched,
    host: true,
  };
}

// Загрузить docker-контейнеры — пробуем несколько эндпоинтов
let _containers = [];
async function loadContainers() {
  _containers = [];
  try {
    // Пробуем /docker/containers
    const r = await hbot("GET", "/docker/containers");
    let list = [];
    if (Array.isArray(r)) list = r;
    else if (Array.isArray(r?.data)) list = r.data;
    else if (r && typeof r === "object" && !r.detail && !r._raw) {
      list = Object.values(r).filter((v) => typeof v === "object");
    }
    _containers = list
      .map((c) => ({
        name: (c.name || c.Names || c.container_name || "")
          .toString()
          .replace(/^\//, ""),
        status: (c.status || c.Status || c.state || "")
          .toString()
          .toLowerCase(),
        image: (c.image || c.Image || "").toString(),
      }))
      .filter(
        (c) =>
          c.name &&
          (c.name.includes("aroon") ||
            c.name.includes("hbot") ||
            c.image.includes("hummingbot"))
      );
  } catch (e) {}
}

// ── Управление биржами ────────────────────────────────────────
// Получить список подключённых бирж
async function getExchanges() {
  const r = await hbot("GET", "/accounts/master_account/credentials");
  if (Array.isArray(r)) return r;
  if (Array.isArray(r?.data)) return r.data;
  return [];
}

// Получить поля для добавления биржи (api_key, api_secret и т.п.)
async function getConnectorFieldsOld(connector) {
  try {
    const r = await hbot("GET", "/connectors/" + connector + "/config-map");
    const fields = r?.data || r || {};
    // Возвращаем только поля которые нужно заполнить (не optional, не системные)
    return Object.entries(fields)
      .filter(
        ([k]) =>
          k.includes("api_key") ||
          k.includes("api_secret") ||
          k.includes("secret") ||
          k.includes("key") ||
          k.includes("passphrase")
      )
      .map(([k]) => k);
  } catch (e) {
    return null;
  }
}

// Хранилище для wizard создания бота: { chatId: { step, ctrl, script, ctrlList, scriptList } }
const _wiz = {};
// Хранилище найденных SQLite файлов для подтверждения удаления
const _dbDelFiles = {};

// Экранирование для Markdown v1 — убираем опасные символы из произвольного текста
function mdEsc(s) {
  return String(s).replace(/[_*`\[]/g, "\\$&");
}

function sanitizeLog(s) {
  return String(s)
    .replace(/Hummingbot/g, "AgentWXO")
    .replace(/hummingbot/g, "agentwxo");
}

// Краткая сводка по боту
function fmtBot(name, info, tradeVolume = null) {
  const ico = info.status === "running" ? "✅" : "🔴";
  const act = info.recently_active ? "🟢 активен" : "🟡 нет активности";
  let s = `${ico} \`${name}\`\nАктивность: ${act}\n`;
  const ctrl = Object.values(info.performance || {})[0];
  const p = ctrl ? ctrl.performance || {} : {};
  if (p.global_pnl_quote !== undefined) {
    const sign = p.global_pnl_quote >= 0 ? "+" : "";
    s += `PnL: \`${sign}${(+p.global_pnl_quote).toFixed(4)}\` USDT\n`;
    s += `Объём: \`${(tradeVolume !== null
      ? tradeVolume
      : +(p.volume_traded || 0)
    ).toFixed(2)}\` USDT\n`;
    const closes = p.close_type_counts || {};
    for (const [ct, cnt] of Object.entries(closes)) {
      s += `⚠️ ${mdEsc(ct.replace("CloseType.", ""))}: ${cnt}x\n`;
    }
  }
  const errs = info.error_logs || [];
  if (errs.length) {
    const last = errs[errs.length - 1];
    s += `❌ Ошибок: ${errs.length} | ${mdEsc(last.msg.slice(0, 50))}\n`;
  }
  return s;
}

// Кнопки управления одним ботом (имя <= 30 символов в callback_data — всё влезет)
function botMenu(name, status) {
  const rows = [
    [
      status === "running"
        ? { text: ui("stop"), callback_data: "b:stop:" + name }
        : { text: ui("start"), callback_data: "b:start:" + name },
      { text: ui("logs"), callback_data: "b:logs:" + name },
    ],
    [
      { text: ui("pnl"), callback_data: "b:pnl:" + name },
      { text: ui("history"), callback_data: "b:history:" + name },
    ],
    [
      { text: ui("status"), callback_data: "b:status:" + name },
      { text: ui("refresh"), callback_data: "b:refresh:" + name },
    ],
    [
      { text: "🔧 Починить БД", callback_data: "b:fixdb:" + name },
      { text: ui("del_bot"), callback_data: "b:delask:" + name },
    ],
    [{ text: ui("del_db"), callback_data: "b:dbdel:" + name }],
  ];
  rows.push([{ text: ui("list_bots"), callback_data: "bots_list" }]);
  rows.push([btnMainMenu()]);
  return { inline_keyboard: rows };
}

function simulateCommand(chatId, command) {
  bot.processUpdate({
    update_id: Date.now(),
    message: {
      message_id: Math.floor(Math.random() * 1000000),
      from: { id: parseInt(chatId) },
      chat: { id: parseInt(chatId) },
      date: Math.floor(Date.now() / 1000),
      text: command,
    },
  });
}

// === БОТ ===
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
  request: {
    timeout: 30000, // 30 секунд таймаут запроса
    agentOptions: {
      keepAlive: true,
      family: 4, // Принудительно IPv4 — исправляет AggregateError в Docker
    },
  },
});

// Патчим bot чтобы ошибки parse_mode автоматически ретраились как plain text
// Это защищает от краша процесса при любых Markdown-ошибках
const _origEdit = bot.editMessageText.bind(bot);
const _origSend = bot.sendMessage.bind(bot);

bot.editMessageText = async function (text, opts = {}) {
  try {
    return await _origEdit(text, opts);
  } catch (e) {
    const msg = e?.message || "";
    if (msg.includes("parse entities") && opts.parse_mode) {
      const safe = { ...opts };
      delete safe.parse_mode;
      return _origEdit(text.replace(/[*_`\[]/g, ""), safe).catch(() => {});
    }
    if (msg.includes("message is not modified")) return; // не ошибка
    throw e;
  }
};

bot.sendMessage = async function (chatId, text, opts = {}) {
  try {
    return await _origSend(chatId, text, opts);
  } catch (e) {
    const msg = e?.message || "";
    if (msg.includes("parse entities") && opts?.parse_mode) {
      const safe = { ...opts };
      delete safe.parse_mode;
      return _origSend(chatId, text.replace(/[*_`\[]/g, ""), safe).catch(
        () => {}
      );
    }
    throw e;
  }
};

function t(key) {
  return LANG[userLang][key] || key;
}

// Флаг, чтобы знать, был ли выполнен exit (для /restart)
let sshWasExited = false;

// Флаг для чередования команд
// true — можно выполнить /restart
// false — можно выполнить /exit
let canExit = true;
let canRestart = false;

// === КОМАНДЫ ===
bot.onText(/\/start/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  bot.sendMessage(CHAT_ID, t("start"));
  await execCommand(
    `screen -S trader -X stuff "start --v2 ${FILES.controler}\\r"`
  );
  bot.sendMessage(CHAT_ID, t("started"));
  showMenuLater(CHAT_ID);
});

bot.onText(/\/stop/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  bot.sendMessage(CHAT_ID, t("stop"));
  await execCommand(`screen -S trader -X stuff "stop\\r"`);
  bot.sendMessage(CHAT_ID, t("stopped"));
  showMenuLater(CHAT_ID);
});

// простое сообщение "exit"
bot.onText(/\/exit/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const chatId = msg.chat.id;

  if (!canExit) {
    return bot.sendMessage(chatId, t("exit_wait_restart"));
  }

  bot.sendMessage(chatId, t("exiting"));
  await execCommand(`screen -S trader -X stuff "exit\\r"`);
  sshWasExited = true;
  bot.sendMessage(chatId, t("exited"));

  // Обновляем флаги
  canExit = false;
  canRestart = true;

  sendMainMenu(chatId);
});

// === ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ (ИИ + ./start + биржи) ===
bot.on("message", async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const text = (msg.text || "").trim();

  // ── Wizard добавления биржи ────────────────
  const exchState = _exchWiz[CHAT_ID];
  if (exchState && exchState.step === "input" && !text.startsWith("/")) {
    exchState.values.push(text);
    if (exchState.values.length < exchState.fields.length) {
      const next = exchState.fields[exchState.values.length];
      bot.sendMessage(CHAT_ID, "🔑 Введите `" + next + "`:", {
        parse_mode: "Markdown",
      });
    } else {
      const { exchange, fields, values } = exchState;
      delete _exchWiz[CHAT_ID];
      const body = {};
      fields.forEach((f, i) => {
        body[f] = values[i];
      });
      const m2 = await bot.sendMessage(
        CHAT_ID,
        "⏳ Добавляю " + exchange.toUpperCase() + "..."
      );
      try {
        const r = await hbot(
          "POST",
          "/accounts/add-credential/master_account/" + exchange,
          body
        );
        const ok = r && !r.detail && !r._raw;
        bot.editMessageText(
          ok
            ? "✅ *" +
                exchange.toUpperCase() +
                " добавлен!*\n\n/exchanges  /balance"
            : "❌ Ошибка:\n```\n" + JSON.stringify(r).slice(0, 300) + "\n```",
          {
            chat_id: CHAT_ID,
            message_id: m2.message_id,
            parse_mode: "Markdown",
          }
        );
      } catch (e) {
        bot.editMessageText("❌ Ошибка: " + e.message, {
          chat_id: CHAT_ID,
          message_id: m2.message_id,
        });
      }
    }
    return; // не передаём в ИИ
  }
  // ──────────────────────────────────────────

  // ── Редактор конфигурации: не передаём ввод в ИИ ──
  if (_cfgEdit[CHAT_ID]) return;
  // ──────────────────────────────────────────────────

  if (text === "./start") {
    if (!canRestart) {
      bot.sendMessage(msg.chat.id, t("exit_wait_restart"));
      return sendMainMenu(msg.chat.id);
    }
    bot.sendMessage(msg.chat.id, t("restarting"));
    await execCommand(`screen -S trader -X stuff "./start\\r"`);
    sshWasExited = false;
    canRestart = false;
    canExit = true;
    bot.sendMessage(msg.chat.id, t("restarted"));
    sendMainMenu(msg.chat.id);
    return;
  }

  // Игнорируем команды со слэшем
  if (text.startsWith("/")) return;

  // ── Детектор запроса на статью о торговле ──────────────────────────────────
  const ARTICLE_KEYWORDS = [
    "напиши статью",
    "напишите статью",
    "статья о торговле",
    "статья о сделках",
    "отчёт о сделках",
    "отчёт",
    "история торгов",
    "история торговли",
    "write article",
    "trade report",
    "report",
    "Отчёт",
    "какие были сделки",
    "что торговал",
    "итоги торговли",
    "итоги дня",
    "результаты торговли",
    "результаты сделок",
  ];
  const textLower = text.toLowerCase();
  const isArticleRequest = ARTICLE_KEYWORDS.some((kw) =>
    textLower.includes(kw)
  );

  if (isArticleRequest) {
    bot.sendMessage(msg.chat.id, "📡 Загружаю данные о сделках...");
    try {
      const tradeData = await getTradeHistoryJS(24);

      const trades = tradeData.trades || [];
      const summary = tradeData.summary || {};
      const total = summary.total_trades || 0;

      if (total === 0) {
        bot.sendMessage(
          msg.chat.id,
          "😴 За последние 24 часа сделок не было. Бот ожидает сигнала."
        );
        return;
      }

      // Формируем структурированный контекст для ИИ
      const now = new Date();
      const dateStr = now.toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
      });
      const bots = summary.active_bots || [];
      const bot_name = bots[0] || "unknown";
      const pairs = summary.pairs_traded || [];
      const volume = trades.reduce(
        (sum, t) =>
          sum + parseFloat(t.price || 0) * parseFloat(t.quantity || 0),
        0
      );
      const buys = trades.filter((t) => t.trade_type === "BUY");
      const sells = trades.filter((t) => t.trade_type === "SELL");
      const prices = trades
        .map((t) => parseFloat(t.price || 0))
        .filter((p) => p > 0);
      const avgPrice = prices.length
        ? prices.reduce((a, b) => a + b, 0) / prices.length
        : 0;
      const symbol = trades[0]?.symbol || pairs[0] || "?";
      const market = (trades[0]?.market || "MEXC").toUpperCase();
      const base = trades[0]?.base_asset || symbol.split("-")[0] || "?";
      // Получаем реальный PnL из кэша _bots (там данные от /bot-orchestration/status)
      // Именно так работает fmtBot — берёт info.performance[ctrl].performance.global_pnl_quote
      let pnl = 0;
      let closeTypeCounts = {};
      try {
        // Обновляем кэш если бот ещё не загружен
        if (!_bots[bot_name]) await loadBots();
        const botInfo = _bots[bot_name] || {};
        // Суммируем global_pnl_quote по всем контроллерам (как в fmtBot)
        for (const ctrl of Object.values(botInfo.performance || {})) {
          const p = ctrl?.performance || {};
          pnl += parseFloat(p.global_pnl_quote || 0);
          // Собираем close_type_counts
          for (const [k, v] of Object.entries(p.close_type_counts || {})) {
            closeTypeCounts[k] = (closeTypeCounts[k] || 0) + v;
          }
        }
      } catch (e) {
        // Fallback: пробуем из executors_summary в данных о сделках
        pnl = parseFloat(tradeData.executors_summary?.total_pnl_quote || 0);
      }

      const tradeLines = trades
        .slice(0, 20)
        .map((t) => {
          const ts =
            t.trade_timestamp > 1e12
              ? t.trade_timestamp / 1000
              : t.trade_timestamp;
          const dt = new Date(ts * 1000).toLocaleString("ru-RU", {
            timeZone: "Europe/Moscow",
          });
          const p = parseFloat(t.price || 0);
          const q = parseFloat(t.quantity || 0);
          const type = t.trade_type === "SELL" ? "📉 ПРОДАЖА" : "📈 ПОКУПКА";
          return `${type} | ${dt}\n      💲 ${p.toFixed(
            5
          )} USDT  📦 ${q.toFixed(2)} ${base}  💵 ${(p * q).toFixed(2)} USDT`;
        })
        .join("\n\n");

      const pnlSign = pnl > 0 ? "+" : "";
      const pnlLine =
        pnl !== 0
          ? `💚 P&L за сутки: ${pnlSign}${pnl.toFixed(4)} USDT${
              pnl > 0 ? " 🎉" : ""
            }`
          : "⚖️ P&L: 0.0000 USDT (позиции ещё открыты или данные обновляются)";

      // closeTypesText формируется из closeTypeCounts, уже собранных из _bots выше
      const closeTypesText = Object.keys(closeTypeCounts).length
        ? "\n- Типы закрытия позиций: " +
          Object.entries(closeTypeCounts)
            .map(([k, v]) => `${k.replace("CloseType.", "")}: ${v}x`)
            .join(", ")
        : "";

      const articlePrompt = `Ты — финансовый журналист AgentWXO. На основе РЕАЛЬНЫХ данных о торгах напиши красивую статью-отчёт с эмодзи.

РЕАЛЬНЫЕ ДАННЫЕ О СДЕЛКАХ:
- Дата/время генерации: ${dateStr}
- Бот: ${bot_name}
- Торговая пара: ${symbol} на ${market}
- Всего сделок за сутки: ${total}
- Покупок: ${buys.length}, Продаж: ${sells.length}
- Общий объём: ${volume.toFixed(2)} USDT
- Средняя цена: ${avgPrice.toFixed(5)} USDT
- P&L: ${pnlSign}${pnl.toFixed(4)} USDT${closeTypesText}

ВАЖНО: P&L = ${pnlSign}${pnl.toFixed(
        4
      )} USDT — это РЕАЛЬНОЕ значение прибыли/убытка. Используй его точно как есть.

СПИСОК СДЕЛОК:
${tradeLines}
${trades.length > 20 ? `...и ещё ${trades.length - 20} сделок\n` : ""}
ИНСТРУКЦИЯ:
Напиши полноценную статью строго по этому шаблону (используй ТОЛЬКО реальные данные выше):

📊 **ДНЕВНОЙ ОТЧЁТ О ТОРГОВЛЕ**
🗓️ За последние 24 часа

🤖 Бот: [название бота]
📋 Сделок: [число]
💵 Объём: [объём] USDT
${pnlLine}

📌 **СДЕЛКИ — [пара] на [биржа]**
   📈 Покупок: [N]  📉 Продаж: [N]

[список всех сделок с датой, ценой, количеством и суммой]

💡 **[тикер]** — [краткое описание токена 1 предложение]
   💹 Средняя цена: [цена] USDT

📈 **ИТОГИ**

🧩 Стратегия: aroon | Сделок: [N] | P&L: ${pnlSign}${pnl.toFixed(4)} USDT

🏁 [2-3 предложения с выводами об итогах дня, упомяни P&L если он ненулевой]

⚡ AI by AgentWXO · ${dateStr}`;

      bot.sendMessage(msg.chat.id, "✅ Генерирую статью...");

      const articleResponse = await aiClient.chat.completions.create({
        model: MODELS[AI_PROVIDER],
        messages: [
          {
            role: "system",
            content:
              "Ты финансовый журналист. Пиши красивые отчёты о торгах с эмодзи. Используй ТОЛЬКО предоставленные реальные данные.",
          },
          { role: "user", content: articlePrompt },
        ],
        max_tokens: 2000,
      });

      const articleText = articleResponse.choices[0].message.content;
      await sendAiMessage(msg.chat.id, articleText);
    } catch (err) {
      console.error("Ошибка генерации статьи:", err);
      bot.sendMessage(
        msg.chat.id,
        "⚠️ Ошибка при генерации статьи: " + err.message
      );
    }
    return;
  }
  // ────────────────────────────────────────────────────────────────────────────

  bot.sendMessage(msg.chat.id, ui("ai_analyzing"));

  try {
    const toolsResponse = await mcpClient.listTools();

    // Формируем системный промпт с загрузкой скиллов
    const skillsContext = getSkillsContext();
    let systemPrompt =
      "Ты — торговый ассистент AgentWXO, управляющий алгоритмическим трейдингом через предоставленные инструменты (MCP). " +
      "Выполняй команды пользователя, вызывая инструменты. Отвечай кратко, четко и по делу. " +
      "Когда нужны данные о сделках для анализа или ответа — используй инструмент get_bot_trade_history.";
    if (skillsContext) {
      systemPrompt += "\n\nДоступные скиллы (Skills):\n" + skillsContext;
    }
    // ── Кастомный инструмент: реальные сделки из бота ─────────
    const CUSTOM_TOOL_NAME = "get_bot_trade_history";
    const customToolDef = {
      type: "function",
      function: {
        name: CUSTOM_TOOL_NAME,
        description:
          "Получает РЕАЛЬНУЮ историю сделок за последние 24 часа из бота. " +
          "Используй когда просят: напиши статью, отчёт о сделках, write article, trade report. " +
          "Возвращает JSON: summary.total_trades, trades[].symbol, trades[].trade_type (BUY/SELL), " +
          "trades[].price (строка), trades[].quantity (строка), trades[].trade_timestamp (мс), trades[].base_asset, trades[]._bot.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
    async function runCustomTool(toolName) {
      if (toolName !== CUSTOM_TOOL_NAME) return null;
      try {
        const data = await getTradeHistoryJS(24);
        return JSON.stringify(data);
      } catch (e) {
        return JSON.stringify({
          error: "Не удалось получить данные",
          detail: e.message,
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // Единая логика для OpenAI/Gemini/OpenRouter/OpenClaw
    if (
      AI_PROVIDER === "openai" ||
      AI_PROVIDER === "gemini" ||
      AI_PROVIDER === "openrouter" ||
      AI_PROVIDER === "openclaw"
    ) {
      const tools = [
        customToolDef,
        ...toolsResponse.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
      ];

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ];

      let response;
      if (AI_PROVIDER === "gemini") {
        const model = aiClient.getGenerativeModel({ model: MODELS.gemini });
        const history = messages.slice(0, -1).map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));
        const chat = model.startChat({ history });
        const result = await chat.sendMessage(messages.at(-1).content);
        response = {
          choices: [
            {
              message: { content: result.response.text(), tool_calls: null },
              finish_reason: "stop",
            },
          ],
        };
      } else {
        response = await aiClient.chat.completions.create({
          model: MODELS[AI_PROVIDER],
          messages: messages,
          tools: tools.length > 0 ? tools : undefined,
        });
      }

      const responseMessage = response.choices[0].message;

      // Парсим <tool_call> из текста если модель вернула в текстовом формате
      if (!responseMessage.tool_calls && responseMessage.content) {
        const toolCallMatches = responseMessage.content.match(
          /<tool_call>([\s\S]*?)<\/tool_call>/g
        );
        if (toolCallMatches) {
          responseMessage.tool_calls = toolCallMatches
            .map((match, index) => {
              const json = match.replace(/<\/?tool_call>/g, "").trim();
              try {
                const parsed = JSON.parse(json);
                return {
                  id: `call_${index}`,
                  type: "function",
                  function: {
                    name: parsed.name,
                    arguments: JSON.stringify(parsed.arguments || {}),
                  },
                };
              } catch (e) {
                return null;
              }
            })
            .filter(Boolean);
        }
      }

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        messages.push(responseMessage);

        for (const toolCall of responseMessage.tool_calls) {
          // OpenRouter/OpenClaw могут вернуть аргументы в виде строки или объекта
          let args = {};
          try {
            args =
              typeof toolCall.function.arguments === "string"
                ? JSON.parse(toolCall.function.arguments)
                : toolCall.function.arguments;
          } catch (e) {
            console.error("Failed to parse arguments", e);
          }
          console.log(
            `🤖 ИИ вызывает (${AI_PROVIDER}): ${toolCall.function.name}`,
            args
          );

          let toolResultContent;
          const customResult = await runCustomTool(toolCall.function.name);
          if (customResult !== null) {
            toolResultContent = customResult;
          } else {
            let mcpResult;
            try {
              mcpResult = await mcpClient.callTool({
                name: toolCall.function.name,
                arguments: args,
              });
            } catch (e) {
              mcpResult = {
                content: [{ type: "text", text: "Ошибка: " + e.message }],
              };
            }
            toolResultContent = JSON.stringify(mcpResult.content);
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResultContent,
          });
        }

        let finalResponse;
        if (AI_PROVIDER === "gemini") {
          const model = aiClient.getGenerativeModel({ model: MODELS.gemini });
          const history = messages.slice(0, -1).map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          }));
          const chat = model.startChat({ history });
          const result = await chat.sendMessage(messages.at(-1).content);
          finalResponse = {
            choices: [{ message: { content: result.response.text() } }],
          };
        } else {
          finalResponse = await aiClient.chat.completions.create({
            model: MODELS[AI_PROVIDER],
            messages: messages,
          });
        }

        await sendAiMessage(
          msg.chat.id,
          finalResponse.choices[0].message.content
        );
      } else {
        await sendAiMessage(msg.chat.id, responseMessage.content);
      }
    }

    // Логика для Anthropic (Claude)
    else if (AI_PROVIDER === "anthropic") {
      const tools = toolsResponse.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));

      const messages = [{ role: "user", content: text }];

      const response = await aiClient.messages.create({
        model: MODELS.anthropic,
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });

        for (const contentBlock of response.content) {
          if (contentBlock.type === "tool_use") {
            console.log(
              `🤖 ИИ вызывает (Claude): ${contentBlock.name}`,
              contentBlock.input
            );

            let mcpResult;
            try {
              mcpResult = await mcpClient.callTool({
                name: contentBlock.name,
                arguments: contentBlock.input,
              });
            } catch (e) {
              mcpResult = {
                content: [{ type: "text", text: "Ошибка: " + e.message }],
              };
            }

            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: contentBlock.id,
                  content: JSON.stringify(mcpResult.content),
                },
              ],
            });
          }
        }

        const finalResponse = await aiClient.messages.create({
          model: MODELS.anthropic,
          max_tokens: 1024,
          messages: messages,
          tools: tools,
        });

        await sendAiMessage(msg.chat.id, finalResponse.content[0].text);
      } else {
        await sendAiMessage(msg.chat.id, response.content[0].text);
      }
    }
  } catch (error) {
    console.error("Ошибка при работе с ИИ:", error);
    bot.sendMessage(
      msg.chat.id,
      "⚠️ Ошибка при обращении к ИИ: " + error.message
    );
  }
});

// /restart — перезапуск (только после exit)
bot.onText(/\/restart/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const chatId = msg.chat.id;

  if (!canRestart) {
    return bot.sendMessage(chatId, t("restart_wait_exit"));
  }

  bot.sendMessage(chatId, t("restarting"));
  await execCommand(`screen -S trader -X stuff "./start\\r"`);
  sshWasExited = false;
  bot.sendMessage(chatId, t("restarted"));

  // Обновляем флаги
  canRestart = false;
  canExit = true;

  sendMainMenu(chatId);
});

// /del — удаляет базу данных
bot.onText(/\/del/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🗑️ ...");
  try {
    await execCommand(`screen -S trader -X stuff "rm -f ${FILES.db}\\r"`);
    bot.sendMessage(chatId, t("db_deleted"));
  } catch (err) {
    bot.sendMessage(chatId, t("db_failed"));
  }
  sendMainMenu(chatId);
});

bot.onText(/\/showconfig1/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  bot.sendMessage(CHAT_ID, t("show"));
  const data = fs.readFileSync(FILES.config1, "utf-8");
  bot.sendMessage(CHAT_ID, `📜 *config1:*\n\`\`\`\n${data}\n\`\`\``, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/setconfig1 (\S+) (.+)/, async (msg, m) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const key = m[1];
  const value = m[2];

  try {
    const result = await updateYamlConfig(FILES.config1, key, value);
    bot.sendMessage(CHAT_ID, t(result)); // теперь result может быть "updated" или др.
  } catch (err) {
    switch (err.message) {
      case "unknown_key":
        return bot.sendMessage(CHAT_ID, t("unknown_key"));
      case "type_mismatch":
        return bot.sendMessage(CHAT_ID, t("type_mismatch"));
      case "no_change":
        return bot.sendMessage(CHAT_ID, t("no_change"));
      case "error_update":
        return bot.sendMessage(CHAT_ID, t("error_update"));
      default:
        return bot.sendMessage(CHAT_ID, "⚙️ Неизвестная ошибка.");
    }
  }
});

bot.onText(/\/showconfig2/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  bot.sendMessage(CHAT_ID, t("show"));
  const data = fs.readFileSync(FILES.config2, "utf-8");
  bot.sendMessage(CHAT_ID, `📜 *config2:*\n\`\`\`\n${data}\n\`\`\``, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/setconfig2 (\S+) (.+)/, async (msg, m) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const key = m[1];
  const value = m[2];

  try {
    const result = await updateYamlConfig(FILES.config2, key, value);
    bot.sendMessage(CHAT_ID, t(result)); // теперь result может быть "updated" или др.
  } catch (err) {
    switch (err.message) {
      case "unknown_key":
        return bot.sendMessage(CHAT_ID, t("unknown_key"));
      case "type_mismatch":
        return bot.sendMessage(CHAT_ID, t("type_mismatch"));
      case "no_change":
        return bot.sendMessage(CHAT_ID, t("no_change"));
      case "error_update":
        return bot.sendMessage(CHAT_ID, t("error_update"));
      default:
        return bot.sendMessage(CHAT_ID, "⚙️ Неизвестная ошибка.");
    }
  }
});

bot.onText(/\/help/, (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  bot.sendMessage(CHAT_ID, t("help"), { parse_mode: "Markdown" });
});

bot.onText(/\/api\s+(.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;

  try {
    saveApiYaml("api_key", match[1]);
    bot.sendMessage(CHAT_ID, "✅");
  } catch {
    bot.sendMessage(CHAT_ID, "⚠️ Ошибка");
  }
});

bot.onText(/\/secret\s+(.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;

  try {
    saveApiYaml("secret_key", match[1]);
    bot.sendMessage(CHAT_ID, "✅");
  } catch {
    bot.sendMessage(CHAT_ID, "⚠️ Ошибка");
  }
});

// === Переключение языка ===
bot.onText(/\/language/, (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  bot.sendMessage(CHAT_ID, "🌐 Выберите язык / Choose language:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🇷🇺 Русский", callback_data: "lang_ru" },
          { text: "🇺🇸 English", callback_data: "lang_en" },
        ],
        [
          { text: "🇨🇳 中文", callback_data: "lang_zh" },
          { text: "🇯🇵 日本語", callback_data: "lang_ja" },
        ],
        [
          { text: "🇪🇸 Español", callback_data: "lang_es" },
          { text: "🇹🇷 Türkçe", callback_data: "lang_tr" },
        ],
        [
          { text: "🇻🇳 Tiếng Việt", callback_data: "lang_vi" },
          { text: "🇰🇷 한국어", callback_data: "lang_ko" },
        ],
        [
          { text: "🇸🇦 العربية", callback_data: "lang_ar" },
          { text: "🇮🇳 हिंदी", callback_data: "lang_hi" },
        ],
        [
          { text: "🇫🇷 Français", callback_data: "lang_fr" },
          { text: "🇩🇪 Deutsch", callback_data: "lang_de" },
        ],
        [{ text: "🇧🇷 Português", callback_data: "lang_pt" }],
      ],
    },
  });
});

// =============================================
// === КОМАНДЫ ===
// =============================================

// /menu — показать главное меню
bot.onText(/\/menu/, (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  sendMainMenu(CHAT_ID);
});

// /help — документация
bot.onText(/\/help/, (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const helpText = {
    ru: "📚 *Документация*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n*Команды:*\n📜  /menu - меню\n🤖 /bots — список ботов\n🚀 /newbot — создать бота\n💰 /balance — балансы\n📊 /portfolio — портфолио\n🔌 /exchanges — биржи\n⚙️ /configs — конфиги\n🌐 /language — язык\n📋 /botlogs — логи бота",
    en: "📚 *Documentation*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n*Commands:*\n📜  /menu\n🤖 /bots — bot list\n🚀 /newbot — create bot\n💰 /balance — balances\n📊 /portfolio — portfolio\n🔌 /exchanges — exchanges\n⚙️ /configs — configs\n🌐 /language — language",
    zh: "📚 *文档*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n📜  /menu\n🤖 /bots · 🚀 /newbot · 💰 /balance · 📊 /portfolio · 🔌 /exchanges · ⚙️ /configs",
    ja: "📚 *ドキュメント*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n📜  /menu\n🤖 /bots · 🚀 /newbot · 💰 /balance · 📊 /portfolio · 🔌 /exchanges · ⚙️ /configs",
    es: "📚 *Documentación*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n📜  /menu\n🤖 /bots · 🚀 /newbot · 💰 /balance · 📊 /portfolio · 🔌 /exchanges · ⚙️ /configs",
    tr: "📚 *Dokümantasyon*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n📜  /menu\n🤖 /bots · 🚀 /newbot · 💰 /balance · 📊 /portfolio · 🔌 /exchanges · ⚙️ /configs",
    vi: "📚 *Tài liệu*\nhttps://trade.coinmarketfacts.com/docv2.html",
    ko: "📚 *문서*\nhttps://trade.coinmarketfacts.com/docv2.html",
    ar: "📚 *الوثائق*\nhttps://trade.coinmarketfacts.com/docv2.html",
    hi: "📚 *दस्तावेज़*\nhttps://trade.coinmarketfacts.com/docv2.html",
    fr: "📚 *Documentation*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n📜  /menu\n🤖 /bots · 🚀 /newbot · 💰 /balance · 📊 /portfolio · 🔌 /exchanges · ⚙️ /configs",
    de: "📚 *Dokumentation*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n📜  /menu\n🤖 /bots · 🚀 /newbot · 💰 /balance · 📊 /portfolio · 🔌 /exchanges · ⚙️ /configs",
    pt: "📚 *Documentação*\nhttps://trade.coinmarketfacts.com/docv2.html",
  };
  bot.sendMessage(CHAT_ID, helpText[userLang] || helpText.en, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
});

// /bots — список всех ботов
bot.onText(/\/bots/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const m = await bot.sendMessage(CHAT_ID, "⏳ Загружаю ботов...");
  try {
    await Promise.all([loadBots(), loadContainers()]);

    const mqttNames = Object.keys(_bots);
    const dockerNames = _containers.map((c) => c.name);
    // Объединяем: docker-контейнеры + MQTT-боты (без дублей)
    const allNames = [...new Set([...dockerNames, ...mqttNames])];

    if (allNames.length === 0) {
      return bot.editMessageText(
        "🤖 *Ботов нет*\n\nНи задеплоенных контейнеров, ни активных MQTT-ботов.\n\nСоздайте нового: /newbot",
        {
          chat_id: CHAT_ID,
          message_id: m.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: ui("create_bot"), callback_data: "bots_new" }],
            ],
          },
        }
      );
    }

    let text = `🤖 *Боты (${allNames.length}):*\n\n`;
    for (const name of allNames) {
      const mqtt = _bots[name];
      const docker = _containers.find((c) => c.name === name);

      if (mqtt) {
        // Бот активен в MQTT — полная информация
        text += fmtBot(name, mqtt) + "\n";
      } else if (docker) {
        // Только docker-контейнер — нет MQTT соединения
        const running =
          docker.status.includes("up") || docker.status.includes("running");
        text += `${running ? "🟡" : "⚫"} \`${name}\`\n`;
        text += `  Docker: \`${docker.status}\`\n`;
        text += `  _MQTT не подключён — нажмите ▶️ Запустить_\n\n`;
      }
    }

    const rows = allNames.map((name) => {
      const mqtt = _bots[name];
      const docker = _containers.find((c) => c.name === name);
      const status =
        mqtt?.status || (docker?.status.includes("up") ? "stopped" : "stopped");
      const icon = mqtt?.status === "running" ? "✅" : "🟡";
      return [{ text: icon + " " + name, callback_data: "b:menu:" + name }];
    });
    rows.push([
      { text: ui("create_new"), callback_data: "bots_new" },
      { text: ui("refresh"), callback_data: "bots_list" },
    ]);

    await bot.editMessageText(text, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    });
  } catch (e) {
    bot.editMessageText("❌ Ошибка: " + e.message, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
    });
  }
});

async function _showBotsList(chatId, editMsgId) {
  const names = Object.keys(_bots);
  let text, markup;

  if (names.length === 0) {
    text = "🤖 *Активных ботов нет*\n\nСоздайте нового: /newbot";
    markup = {
      inline_keyboard: [
        [{ text: ui("create_bot"), callback_data: "bots_new" }],
      ],
    };
  } else {
    text = `🤖 *Боты (${names.length}):*\n\n`;
    for (const [n, i] of Object.entries(_bots)) {
      text += fmtBot(n, i) + "\n";
    }
    const rows = names.map((n) => [
      {
        text: (_bots[n]?.status === "running" ? "✅ " : "🔴 ") + n,
        callback_data: "b:menu:" + n,
      },
    ]);
    rows.push([
      { text: ui("create_new"), callback_data: "bots_new" },
      { text: ui("refresh"), callback_data: "bots_list" },
    ]);
    rows.push([btnMainMenu()]);
    markup = { inline_keyboard: rows };
  }

  if (editMsgId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: editMsgId,
        parse_mode: "Markdown",
        reply_markup: markup,
      });
      return;
    } catch (e) {
      /* если сообщение не изменилось — просто шлём новое */
    }
  }
  await sendLong(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: markup,
  });
}

// /newbot — wizard создания бота
bot.onText(/\/newbot/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const m = await bot.sendMessage(CHAT_ID, "⏳ Загружаю конфиги...");
  try {
    // Динамический путь к конфигам: если есть активный инстанс — пишем в его папку
    // иначе в глобальный bots/conf/controllers (для новых деплоев)
    // getCtrlDir moved to top
    const SCRIPT_DIR = "/root/hummingbot/hummingbot-api/bots/conf/scripts";

    // Читаем файлы прямо с диска — API /controllers/configs/ возвращает неверные имена
    const [ctrlOut, scriptOut] = await Promise.all([
      execCommand(`ls "${CTRL_DIR_FILES}" 2>&1`),
      execCommand(`ls "${SCRIPT_DIR}" 2>&1`),
    ]);

    // Контроллеры: берём .yml файлы, убираем расширение
    const ctrlList = (ctrlOut || "")
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".yml"))
      .map((f) => f.replace(/\.yml$/, ""));

    // Скрипты: только conf_*.yml, убираем экземпляры ботов (aroon-bot-YYYYMMDD-HHMMSS)
    const scriptList = (scriptOut || "")
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".yml") && !/^.+-\d{8}-\d{6}\.yml$/.test(f))
      .map((f) => f.replace(/\.yml$/, ""));

    if (!ctrlList.length) {
      return bot.editMessageText(
        "❌ Нет конфигов контроллеров в:\n`" +
          CTRL_DIR_FILES +
          "`\n\n`" +
          ctrlOut.slice(0, 300) +
          "`",
        { chat_id: CHAT_ID, message_id: m.message_id, parse_mode: "Markdown" }
      );
    }

    _wiz[CHAT_ID] = { ctrlList, scriptList, ctrls: [] }; // ctrls — выбранные контроллеры

    function buildCtrlRows(ctrlList, selected) {
      const rows = ctrlList.map((n) => [
        {
          text: (selected.includes(n) ? "✅ " : "☐ ") + n,
          callback_data: "wz1t:" + n.slice(0, 50), // toggle
        },
      ]);
      if (selected.length > 0) {
        rows.push([
          {
            text: `➡️ Далее (выбрано: ${selected.length})`,
            callback_data: "wz1next",
          },
        ]);
      }
      rows.push([
        { text: ui("cancel"), callback_data: "wz_cancel" },
        btnMainMenu(),
      ]);
      return rows;
    }

    bot.editMessageText(
      "🚀 *Новый бот — Шаг 1/3*\n\nВыберите контроллеры (можно несколько):",
      {
        chat_id: CHAT_ID,
        message_id: m.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buildCtrlRows(ctrlList, []) },
      }
    );
  } catch (e) {
    bot.editMessageText("❌ Ошибка: " + e.message, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
    });
  }
});

// /diag [botname] — полная диагностика состояния бота
bot.onText(/\/diag(?:\s+(.+))?/, async (msg, match) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  let botName = (match[1] || "").trim();
  if (!botName) {
    botName = (
      await execCommand(
        "docker ps -a --format '{{.Names}}' --filter 'name=aroon' | head -1 2>&1"
      )
    ).trim();
  }
  const m = await bot.sendMessage(CHAT_ID, "🔍 Диагностика...");
  try {
    const [psAll, confCtrl, apiStatus] = await Promise.all([
      execCommand(
        "docker ps -a --format '{{.Names}}\\t{{.Status}}' --filter 'name=aroon' 2>&1"
      ),
      execCommand(
        "ls /root/hummingbot/hummingbot-api/bots/conf/controllers/ 2>&1"
      ),
      hbot("GET", "/bot-orchestration/status").catch(() => null),
    ]);

    let text = "🔍 *Диагностика*\n\n";
    text += `*Контейнеры aroon:*\n\`\`\`\n${(
      psAll || "не найдено"
    ).trim()}\n\`\`\`\n\n`;
    text += `*Конфиги:* \`${(confCtrl || "пусто").trim()}\`\n\n`;

    if (botName) {
      const [inspect, top, logs, dbCheck, entrypoint, mounts, confInside] =
        await Promise.all([
          execCommand(
            `docker inspect --format='Status={{.State.Status}} Running={{.State.Running}} ExitCode={{.State.ExitCode}} StartedAt={{.State.StartedAt}}' ${botName} 2>&1`
          ),
          execCommand(`docker top ${botName} aux 2>&1`),
          execCommand(`docker logs ${botName} --tail 20 2>&1`),
          execCommand(
            `docker exec ${botName} find /home/hummingbot/data -name "*.sqlite" 2>&1`
          ).catch(() => ""),
          execCommand(
            `docker inspect --format='CMD={{.Config.Cmd}} ENTRYPOINT={{.Config.Entrypoint}}' ${botName} 2>&1`
          ),
          execCommand(
            `docker inspect --format='{{range .Mounts}}{{.Source}} -> {{.Destination}}\n{{end}}' ${botName} 2>&1`
          ),
          execCommand(
            `docker exec ${botName} find /home/hummingbot/conf/controllers -name "*.yml" 2>&1`
          ).catch(() => "не найдено"),
        ]);

      text += `*Контейнер:* \`${botName}\`\n\`\`\`\n${inspect.trim()}\n\`\`\`\n`;
      text += `*Entrypoint:* \`${entrypoint.trim().slice(0, 200)}\`\n\n`;
      text += `*Volume mounts:*\n\`\`\`\n${(mounts || "?")
        .trim()
        .slice(0, 400)}\n\`\`\`\n\n`;
      text += `*Конфиги внутри контейнера (/conf/controllers):*\n\`\`\`\n${(
        confInside || "?"
      )
        .trim()
        .slice(0, 300)}\n\`\`\`\n\n`;

      // Процессы внутри
      const hasHbot =
        top.toLowerCase().includes("python") ||
        top.toLowerCase().includes("hummingbot");
      text += `*Процессы внутри:* ${
        hasHbot ? "🟢 python найден" : "🔴 процессов нет"
      }\n`;
      text += `\`\`\`\n${top.trim().slice(0, 400)}\n\`\`\`\n\n`;

      // БД
      const dbFiles = dbCheck.trim();
      text += `*SQLite файлы в /data:*\n\`${dbFiles || "не найдено"}\`\n\n`;

      // MQTT статус
      const mqttInfo =
        apiStatus && (apiStatus[botName] || apiStatus?.data?.[botName]);
      text += `*MQTT статус:* ${
        mqttInfo ? "🟢 зарегистрирован" : "🔴 не в MQTT"
      }\n`;
      if (mqttInfo) {
        text += `  status: \`${mqttInfo.status || "?"}\`\n`;
        text += `  recently_active: \`${mqttInfo.recently_active}\`\n`;
      }
      text += "\n";

      // Логи
      const logLines = sanitizeLog(logs)
        .split("\n")
        .filter((l) => l.trim())
        .slice(-15);
      text += `*Последние логи (${logLines.length} строк):*\n\`\`\`\n${logLines
        .join("\n")
        .slice(0, 800)}\n\`\`\``;
    }

    await sendLong(CHAT_ID, text, { parse_mode: "Markdown" });
    await bot.deleteMessage(CHAT_ID, m.message_id).catch(() => {});
  } catch (e) {
    bot.editMessageText("❌ " + e.message, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
    });
  }
});

// /botlogs <botname> — полные docker логи конкретного бота
bot.onText(/\/botlogs(?:\s+(.+))?/, async (msg, match) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  let botName = (match[1] || "").trim();
  const m = await bot.sendMessage(CHAT_ID, "📋 Загружаю логи...");

  try {
    if (!botName) {
      // Берём последний aroon-бот
      botName = (
        await execCommand(
          "docker ps -a --format '{{.Names}}' --filter 'name=aroon' | head -1 2>&1"
        )
      ).trim();
    }
    if (!botName)
      return bot.editMessageText(
        "❌ Бот не найден. Укажите имя: /botlogs aroon-bot-XXXXXXXX-XXXXXX",
        { chat_id: CHAT_ID, message_id: m.message_id }
      );

    const logs = await execCommand(`docker logs ${botName} --tail 60 2>&1`);
    const status = await execCommand(
      `docker inspect --format='{{.State.Status}} (exit={{.State.ExitCode}})' ${botName} 2>&1`
    );

    await sendLong(
      CHAT_ID,
      `📋 *Логи: ${botName}*\nСтатус: \`${status.trim()}\`\n\`\`\`\n${sanitizeLog(
        logs
      ).slice(0, 3500)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    await bot.deleteMessage(CHAT_ID, m.message_id).catch(() => {});
  } catch (e) {
    bot.editMessageText("❌ " + e.message, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
    });
  }
});
bot.onText(/\/balance/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const m = await bot.sendMessage(CHAT_ID, "💰 Загружаю балансы...");
  try {
    // Пробуем POST /portfolio/state (основной)
    let data = await hbot("POST", "/portfolio/state", {
      account_name: "master_account",
    });

    // Если не то — пробуем GET /portfolio/distribution
    if (!data || data.detail || data._raw) {
      data = await hbot("GET", "/portfolio/distribution");
    }

    if (!data || data.detail || data._raw) {
      return bot.editMessageText(
        "⚠️ Баланс недоступен.\n\nОтвет API:\n```\n" +
          JSON.stringify(data).slice(0, 300) +
          "\n```\n\nПроверьте что MEXC/Binance добавлены: /portfolio",
        { chat_id: CHAT_ID, message_id: m.message_id, parse_mode: "Markdown" }
      );
    }

    // Разбираем ответ формата: { master_account: { binance: [{token, units, value, available_units}], mexc: [...] } }
    let text = "💰 *Балансы:*\n\n";
    const payload = data.data || data;
    let hasAny = false;

    // Перебираем аккаунты (master_account, ...)
    for (const [account, exchanges] of Object.entries(payload)) {
      if (typeof exchanges !== "object" || Array.isArray(exchanges)) continue;
      // Перебираем биржи (binance, mexc, ...)
      for (const [exchange, tokens] of Object.entries(exchanges)) {
        if (!Array.isArray(tokens) || !tokens.length) continue;
        let block = `*${exchange.toUpperCase()}*\n`;
        let hasVal = false;
        for (const t of tokens) {
          const units = +(t.units || t.available_units || 0);
          const avail = +(t.available_units || 0);
          const value = +(t.value || 0);
          if (units > 0) {
            block += `  ${t.token}: \`${units.toFixed(
              6
            )}\` (доступно: \`${avail.toFixed(6)}\`)`;
            if (value > 0) block += ` ≈ \`$${value.toFixed(2)}\``;
            block += "\n";
            hasVal = true;
            hasAny = true;
          }
        }
        if (hasVal) text += block + "\n";
      }
    }

    if (!hasAny) text += "_Нет ненулевых балансов_";

    bot.editMessageText(text, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
      parse_mode: "Markdown",
    });
  } catch (e) {
    bot.editMessageText("❌ Ошибка: " + e.message, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
    });
  }
});

// /portfolio — сводка
bot.onText(/\/portfolio/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const m = await bot.sendMessage(CHAT_ID, "📈 Загружаю...");
  try {
    await loadBots();
    const creds = await hbot("GET", "/accounts/master_account/credentials");

    let text = "📊 *Портфолио*\n\n";
    const exchList = Array.isArray(creds)
      ? creds
      : creds?.data
      ? creds.data
      : [];
    text += "🔌 *Биржи:* " + (exchList.join(", ") || "нет") + "\n\n";

    const botNames = Object.keys(_bots);
    text += `🤖 *Боты (${botNames.length}):*\n`;
    if (botNames.length === 0) {
      text += "  _нет активных ботов_\n";
    } else {
      for (const [n, i] of Object.entries(_bots)) {
        const p = Object.values(i.performance || {})[0]?.performance || {};
        const pnlStr =
          p.global_pnl_quote !== undefined
            ? ` | PnL: ${(+p.global_pnl_quote).toFixed(4)} USDT`
            : "";
        text += `  ${i.status === "running" ? "✅" : "🔴"} \`${n}\`${pnlStr}\n`;
      }
    }
    text +=
      "\n💰 /balance   🤖 /bots   🚀 /newbot   🔌 /exchanges   ⚙️ /configs";
    bot.editMessageText(text, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
      parse_mode: "Markdown",
    });
  } catch (e) {
    bot.editMessageText("❌ Ошибка: " + e.message, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
    });
  }
});

// =============================================
// === CALLBACK ROUTER ===
// =============================================
bot.on("callback_query", async (query) => {
  const data = query.data || "";
  const chatId = query.message.chat.id.toString();
  const msgId = query.message.message_id;
  bot.answerCallbackQuery(query.id).catch(() => {});

  // ── оригинальный язык ─────────────────────
  if (data.startsWith("lang_")) {
    const langCode = data.replace("lang_", "");
    if (LANG[langCode] || UI[langCode]) {
      userLang = langCode;
      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(
        CHAT_ID,
        (LANG[langCode] && LANG[langCode].lang_switched) ||
          "✅ Язык изменен / Language updated"
      );
      sendMainMenu(CHAT_ID);
    }
    return;
  }

  // ── главное меню ──────────────────────────
  if (data === "main_menu") {
    sendMainMenu(chatId);
    return;
  }

  // ── список ботов ──────────────────────────
  if (data === "bots_list") {
    try {
      await Promise.all([loadBots(), loadContainers()]);
    } catch (e) {}
    const mqttNames = Object.keys(_bots);
    const dockerNames = _containers.map((c) => c.name);
    const allNames = [...new Set([...dockerNames, ...mqttNames])];

    if (allNames.length === 0) {
      try {
        await bot.editMessageText("🤖 *Ботов нет*\n\nСоздайте: /newbot", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: ui("create_bot"), callback_data: "bots_new" }],
            ],
          },
        });
      } catch (e) {}
      return;
    }

    // Загружаем историю для всех ботов параллельно (для точного объёма)
    const tradeVolumes = {};
    await Promise.all(
      allNames
        .filter((n) => _bots[n])
        .map(async (name) => {
          try {
            const rh = await hbot(
              "GET",
              "/bot-orchestration/" + name + "/history"
            );
            let trades = null;
            if (Array.isArray(rh)) trades = rh;
            else if (Array.isArray(rh?.data)) trades = rh.data;
            else if (Array.isArray(rh?.response?.data?.data?.trades))
              trades = rh.response.data.data.trades;
            else if (Array.isArray(rh?.response?.data?.trades))
              trades = rh.response.data.trades;
            else if (Array.isArray(rh?.data?.trades)) trades = rh.data.trades;
            else if (Array.isArray(rh?.trades)) trades = rh.trades;
            if (trades && trades.length)
              tradeVolumes[name] = trades.reduce(
                (sum, t) =>
                  sum + +(t.amount || t.quantity || 0) * +(t.price || 0),
                0
              );
          } catch (e) {}
        })
    );

    let text = `🤖 *Боты (${allNames.length}):*\n\n`;
    for (const name of allNames) {
      const mqtt = _bots[name];
      if (mqtt) {
        text += fmtBot(name, mqtt, tradeVolumes[name] ?? null) + "\n";
      } else {
        const docker = _containers.find((c) => c.name === name);
        text += `🟡 \`${name}\`\n  Docker: \`${
          docker?.status || "?"
        }\`  _MQTT не подключён_\n\n`;
      }
    }
    const rows = allNames.map((name) => {
      const icon = _bots[name]?.status === "running" ? "✅" : "🟡";
      return [{ text: icon + " " + name, callback_data: "b:menu:" + name }];
    });
    rows.push([
      { text: ui("create_new"), callback_data: "bots_new" },
      { text: ui("refresh"), callback_data: "bots_list" },
    ]);
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
    } catch (e) {}
    return;
  }

  if (data === "bots_new") {
    // Удаляем старое меню чтобы не плодить кнопки
    bot.deleteMessage(chatId, msgId).catch(() => {});
    // Запускаем wizard — симулируем команду /newbot
    simulateCommand(chatId, "/newbot");
    return;
  }

  // ── меню конкретного бота ─────────────────
  if (data.startsWith("b:menu:")) {
    const name = data.slice(7);
    try {
      await Promise.all([loadBots(), loadContainers()]);
    } catch (e) {}
    const mqtt = _bots[name];
    const docker = _containers.find((c) => c.name === name);
    let text, status;

    if (mqtt) {
      status = mqtt.status || "stopped";
      // Загружаем историю для точного объёма
      let tradeVolume = null;
      try {
        const rh = await hbot("GET", "/bot-orchestration/" + name + "/history");
        let trades = null;
        if (Array.isArray(rh)) trades = rh;
        else if (Array.isArray(rh?.data)) trades = rh.data;
        else if (Array.isArray(rh?.response?.data?.data?.trades))
          trades = rh.response.data.data.trades;
        else if (Array.isArray(rh?.response?.data?.trades))
          trades = rh.response.data.trades;
        else if (Array.isArray(rh?.data?.trades)) trades = rh.data.trades;
        else if (Array.isArray(rh?.trades)) trades = rh.trades;
        if (trades && trades.length)
          tradeVolume = trades.reduce(
            (sum, t) => sum + +(t.amount || t.quantity || 0) * +(t.price || 0),
            0
          );
      } catch (e) {}
      text = "🤖 " + fmtBot(name, mqtt, tradeVolume);
    } else if (docker) {
      const up =
        docker.status.includes("up") || docker.status.includes("running");
      status = "stopped";
      text =
        `🟡 \`${name}\`\n\nDocker: \`${docker.status}\`\n\n` +
        `_Бот задеплоен но не подключён к MQTT._\n` +
        `_Нажмите ▶️ Запустить чтобы подключить._`;
    } else {
      status = "stopped";
      text = `⚫ \`${name}\`\n\n_Контейнер не найден_`;
    }

    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: botMenu(name, status),
      });
    } catch (e) {
      await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: botMenu(name, status),
      });
    }
    return;
  }

  // ── обновить карточку бота ────────────────
  if (data.startsWith("b:refresh:")) {
    const name = data.slice(10);
    try {
      await loadBots();
    } catch (e) {}
    const info = _bots[name] || {};
    // Загружаем историю для точного объёма
    let tradeVolume = null;
    try {
      const rh = await hbot("GET", "/bot-orchestration/" + name + "/history");
      let trades = null;
      if (Array.isArray(rh)) trades = rh;
      else if (Array.isArray(rh?.data)) trades = rh.data;
      else if (Array.isArray(rh?.response?.data?.data?.trades))
        trades = rh.response.data.data.trades;
      else if (Array.isArray(rh?.response?.data?.trades))
        trades = rh.response.data.trades;
      else if (Array.isArray(rh?.data?.trades)) trades = rh.data.trades;
      else if (Array.isArray(rh?.trades)) trades = rh.trades;
      if (trades && trades.length)
        tradeVolume = trades.reduce(
          (sum, t) => sum + +(t.amount || t.quantity || 0) * +(t.price || 0),
          0
        );
    } catch (e) {}
    const text = fmtBot(name, info, tradeVolume) + "\n_🔄 Обновлено_";
    try {
      await bot.editMessageText("🤖 " + text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: botMenu(name, info.status || "stopped"),
      });
    } catch (e) {}
    return;
  }

  // ── логи бота ─────────────────────────────
  if (data.startsWith("b:logs:")) {
    const name = data.slice(7);
    try {
      // Загружаем MQTT статус и docker logs параллельно
      // --since 2h — показываем только логи за последние 2 часа (не весь буфер с момента деплоя)
      const since2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const [r, dockerLogs, dockerStatus] = await Promise.all([
        hbot("GET", "/bot-orchestration/" + name + "/status"),
        execCommand(
          `docker logs ${name} --since="${since2h}" --tail 60 2>&1`
        ).catch(() => ""),
        execCommand(
          `docker inspect --format='{{.State.Status}} (exit={{.State.ExitCode}})' ${name} 2>&1`
        ).catch(() => ""),
      ]);
      const info = r && r.data ? r.data : r || {};
      let text = `📋 *Логи — ${name}*\n`;
      text += `Контейнер: \`${(dockerStatus || "").trim()}\`\n\n`;

      // 1. Docker logs — самый актуальный источник (всегда свежие после рестарта)
      const cleanDocker = sanitizeLog(dockerLogs || "").trim();
      if (cleanDocker) {
        // Берём последние 25 строк и убираем DEBUG
        const dockerLines = cleanDocker
          .split("\n")
          .filter((l) => l.trim() && !l.includes(" - DEBUG - "))
          .slice(-25);
        text += `🐳 *Docker logs (последние ${dockerLines.length}):*\n\`\`\`\n`;
        text += dockerLines.join("\n").slice(0, 2000);
        text += "\n```\n\n";
      }

      // 2. MQTT ошибки
      const errs = (info.error_logs || []).slice(-3);
      if (errs.length) {
        text += `❌ *Ошибки MQTT (${info.error_logs.length} всего):*\n`;
        errs.forEach((e) => {
          const t = new Date(e.timestamp * 1000).toLocaleTimeString("ru-RU");
          text += `  [${t}] ${sanitizeLog(e.msg).slice(0, 65)}\n`;
        });
        text += "\n";
      }

      // 3. MQTT события (только INFO/WARNING/ERROR, не DEBUG)
      const mqttLogs = (info.general_logs || [])
        .filter((l) => l.level_name !== "DEBUG")
        .slice(-5);
      if (mqttLogs.length) {
        text += `📡 *MQTT события:*\n`;
        mqttLogs.forEach((l) => {
          const t = new Date(l.timestamp * 1000).toLocaleTimeString("ru-RU");
          const ico =
            l.level_name === "ERROR"
              ? "❌"
              : l.level_name === "WARNING"
              ? "⚠️"
              : "ℹ️";
          text += `  ${ico} [${t}] ${sanitizeLog(l.msg).slice(0, 70)}\n`;
        });
      }

      if (!cleanDocker && !errs.length && !mqttLogs.length)
        text += "_Логов нет_";

      const rows = [
        [{ text: ui("refresh_logs"), callback_data: "b:logs:" + name }],
        [{ text: "« Назад к боту", callback_data: "b:menu:" + name }],
      ];
      await sendLong(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (e) {}
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка загрузки логов: " + e.message);
    }
    return;
  }

  // ── детальный PnL ─────────────────────────
  if (data.startsWith("b:pnl:")) {
    const name = data.slice(6);
    try {
      await loadBots();
    } catch (e) {}
    const ctrls = (_bots[name] || {}).performance || {};
    let text = `📊 PnL — \`${name}\`\n\n`;

    // Загружаем историю для точного расчёта объёма
    let tradesVolume = null;
    try {
      const rHistory = await hbot(
        "GET",
        "/bot-orchestration/" + name + "/history"
      );
      let trades = null;
      if (Array.isArray(rHistory)) trades = rHistory;
      else if (Array.isArray(rHistory?.data)) trades = rHistory.data;
      else if (Array.isArray(rHistory?.response?.data?.data?.trades))
        trades = rHistory.response.data.data.trades;
      else if (Array.isArray(rHistory?.response?.data?.trades))
        trades = rHistory.response.data.trades;
      else if (Array.isArray(rHistory?.data?.trades))
        trades = rHistory.data.trades;
      else if (Array.isArray(rHistory?.trades)) trades = rHistory.trades;
      if (trades && trades.length) {
        tradesVolume = trades.reduce(
          (sum, t) => sum + +(t.amount || t.quantity || 0) * +(t.price || 0),
          0
        );
      }
    } catch (e) {}

    if (!Object.keys(ctrls).length) {
      text += "_Нет данных о производительности_";
    } else {
      for (const [cid, cd] of Object.entries(ctrls)) {
        const p = cd.performance || {};
        text += `Контроллер: \`${mdEsc(cid.slice(0, 30))}\`\nСтатус: ${mdEsc(
          cd.status || "?"
        )}\n`;
        if (p.global_pnl_quote !== undefined) {
          const sign = p.global_pnl_quote >= 0 ? "+" : "";
          text += `  PnL всего: \`${sign}${(+p.global_pnl_quote).toFixed(
            6
          )}\` USDT\n`;
          text += `  Реализ.:   \`${(+(p.realized_pnl_quote || 0)).toFixed(
            6
          )}\` USDT\n`;
          text += `  Нереализ.: \`${(+(p.unrealized_pnl_quote || 0)).toFixed(
            6
          )}\` USDT\n`;
          text += `  Объём:     \`${(tradesVolume !== null
            ? tradesVolume
            : +(p.volume_traded || 0)
          ).toFixed(4)}\` USDT\n`;
          for (const [ct, cnt] of Object.entries(p.close_type_counts || {}))
            text += `  ⚠️ ${mdEsc(ct.replace("CloseType.", ""))}: ${cnt}x\n`;
        } else {
          text += "  _Данных PnL нет_\n";
        }
        text += "\n";
      }
    }
    const rows = [
      [{ text: ui("back_to_bot"), callback_data: "b:menu:" + name }],
    ];
    await safeEdit(chatId, msgId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  // ── история сделок ────────────────────────
  if (data.startsWith("b:history:")) {
    const name = data.slice(10);
    try {
      await bot.editMessageText("⏳ Загружаю историю...", {
        chat_id: chatId,
        message_id: msgId,
      });
    } catch (e) {}
    try {
      const r = await hbot("GET", "/bot-orchestration/" + name + "/history");
      let trades = null;
      if (Array.isArray(r)) {
        trades = r;
      } else if (Array.isArray(r?.data)) {
        trades = r.data;
      } else if (Array.isArray(r?.response?.data?.data?.trades)) {
        trades = r.response.data.data.trades;
      } else if (Array.isArray(r?.response?.data?.trades)) {
        trades = r.response.data.trades;
      } else if (Array.isArray(r?.data?.trades)) {
        trades = r.data.trades;
      } else if (Array.isArray(r?.trades)) {
        trades = r.trades;
      }

      let text = `📈 *История* — \`${name}\`\n\n`;

      if (!trades || !trades.length) {
        text += "_Сделок нет_";
      } else {
        // Сводная статистика
        let totalVol = 0,
          buys = 0,
          sells = 0;
        for (const t of trades) {
          if ((t.trade_type || t.side || "").toUpperCase().includes("BUY"))
            buys++;
          else sells++;
          totalVol += +(t.amount || t.quantity || 0) * +(t.price || 0);
        }

        // PnL берём из кэша _bots (global_pnl_quote) — так же как в карточке бота
        if (!_bots[name]) await loadBots().catch(() => {});
        let totalPnl = 0;
        for (const ctrl of Object.values(
          (_bots[name] || {}).performance || {}
        )) {
          totalPnl += parseFloat(ctrl?.performance?.global_pnl_quote || 0);
        }

        const pnlSign = totalPnl >= 0 ? "+" : "";
        text += `Всего: *${trades.length}* сделок | 🟢 ${buys} buy / 🔴 ${sells} sell\n`;
        text += `P&L: \`${pnlSign}${totalPnl.toFixed(
          4
        )} USDT\` | Объём: \`${totalVol.toFixed(2)} USDT\`\n\n`;

        // Последние 10 сделок
        text += `*Последние сделки:*\n`;
        const last = trades.slice(-10).reverse();
        for (const t of last) {
          const side = (t.trade_type || t.side || "?").toUpperCase();
          const pair = mdEsc(t.trading_pair || t.symbol || "?");
          const price = t.price !== undefined ? (+t.price).toFixed(4) : "?";
          const qty =
            t.amount !== undefined
              ? t.amount
              : t.quantity !== undefined
              ? t.quantity
              : "?";
          const qtyStr = qty !== "?" ? (+qty).toFixed(4) : "?";

          let fee = "";
          if (t.trade_fee !== undefined) {
            fee = ` fee:${(+t.trade_fee).toFixed(4)}`;
          } else if (
            t.raw_json?.trade_fee?.flat_fees?.[0]?.amount !== undefined
          ) {
            fee = ` fee:${(+t.raw_json.trade_fee.flat_fees[0].amount).toFixed(
              4
            )}`;
          }

          const pnl =
            t.realized_pnl !== undefined
              ? ` pnl:${
                  +t.realized_pnl >= 0 ? "+" : ""
                }${(+t.realized_pnl).toFixed(4)}`
              : "";
          const tsRaw = t.timestamp || t.trade_timestamp;
          const ts = tsRaw
            ? new Date(tsRaw > 1e11 ? tsRaw : tsRaw * 1000).toLocaleString(
                "ru-RU",
                {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                }
              )
            : "";
          const ico = side.includes("BUY") ? "🟢" : "🔴";
          text += `${ico} ${side} ${pair}\n  \`${price}\` × \`${qtyStr}\`${fee}${pnl}${
            ts ? " " + ts : ""
          }\n`;
        }
        if (trades.length > 10)
          text += `\n_...ещё ${trades.length - 10} сделок_`;
      }

      const rows = [
        [{ text: ui("refresh"), callback_data: "b:history:" + name }],
        [{ text: ui("back_to_bot"), callback_data: "b:menu:" + name }],
      ];
      await safeEdit(chatId, msgId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка истории: " + e.message);
    }
    return;
  }

  // ── детальный статус ──────────────────────
  if (data.startsWith("b:status:")) {
    const name = data.slice(9);
    try {
      await bot.editMessageText("⏳ Загружаю статус...", {
        chat_id: chatId,
        message_id: msgId,
      });
    } catch (e) {}
    try {
      const [r, rHistory] = await Promise.all([
        hbot("GET", "/bot-orchestration/" + name + "/status"),
        hbot("GET", "/bot-orchestration/" + name + "/history").catch(
          () => null
        ),
      ]);
      const info =
        r?.data && typeof r.data === "object" && !Array.isArray(r.data)
          ? r.data
          : r || {};

      let tradesCount = 0;
      let tradesVolume = null; // null = использовать p.volume_traded как fallback
      if (rHistory) {
        let trades = null;
        if (Array.isArray(rHistory)) trades = rHistory;
        else if (Array.isArray(rHistory?.data)) trades = rHistory.data;
        else if (Array.isArray(rHistory?.response?.data?.data?.trades))
          trades = rHistory.response.data.data.trades;
        else if (Array.isArray(rHistory?.response?.data?.trades))
          trades = rHistory.response.data.trades;
        else if (Array.isArray(rHistory?.data?.trades))
          trades = rHistory.data.trades;
        else if (Array.isArray(rHistory?.trades)) trades = rHistory.trades;
        if (trades) {
          tradesCount = trades.length;
          // Считаем объём из реальных сделок (как в разделе "История")
          tradesVolume = trades.reduce(
            (sum, t) => sum + +(t.amount || t.quantity || 0) * +(t.price || 0),
            0
          );
        }
      }

      const statusIco = {
        running: "✅",
        stopped: "🔴",
        error: "💥",
        starting: "🟡",
      };

      let text = `🔍 *Статус* — \`${name}\`\n\n`;
      text += `${statusIco[info.status] || "⚪"} *${
        info.status || "unknown"
      }*\n`;
      text += `Активен: ${info.recently_active ? "🟢 да" : "🔴 нет"}\n\n`;

      const perf = info.performance || {};
      if (Object.keys(perf).length) {
        for (const [cid, cd] of Object.entries(perf)) {
          const p = cd.performance || {};
          text += `*Контроллер:* \`${mdEsc(cid.slice(0, 30))}\`\n`;
          text += `Статус: ${cd.status || "?"}\n`;

          if (p.global_pnl_quote !== undefined) {
            const pnlSign = p.global_pnl_quote >= 0 ? "+" : "";
            const pnlPct =
              p.global_pnl_pct !== undefined
                ? ` (${(+p.global_pnl_pct * 100).toFixed(2)}%)`
                : "";
            text += `\nP&L:      \`${pnlSign}${(+p.global_pnl_quote).toFixed(
              4
            )} USDT${pnlPct}\`\n`;
            text += `Реализ.:  \`${(+(p.realized_pnl_quote || 0)).toFixed(
              4
            )} USDT\`\n`;
            text += `Нереализ: \`${(+(p.unrealized_pnl_quote || 0)).toFixed(
              4
            )} USDT\`\n`;
            text += `Объём:    \`${(tradesVolume !== null
              ? tradesVolume
              : +(p.volume_traded || 0)
            ).toFixed(2)} USDT\`\n`;
            text += `Сделок:   \`${
              tradesCount || p.number_of_executors || 0
            }\`\n`;

            const closes = p.close_type_counts || {};
            const closeStr = Object.entries(closes)
              .map(([k, v]) => `${k.replace("CloseType.", "")}: ${v}`)
              .join(", ");
            if (closeStr) text += `Закрытия: ${mdEsc(closeStr)}\n`;
          } else {
            text += "_Данных производительности нет_\n";
          }
          text += "\n";
        }
      } else {
        text += "_Контроллеры не найдены_\n\n";
      }

      const errs = (info.error_logs || []).slice(-3);
      if (errs.length) {
        text += `*Последние ошибки (${info.error_logs.length} всего):*\n`;
        for (const e of errs) {
          const t = new Date(e.timestamp * 1000).toLocaleTimeString("ru-RU");
          text += `[${t}] ${mdEsc(e.msg.slice(0, 70))}\n`;
        }
      }

      const rows = [
        [{ text: ui("refresh"), callback_data: "b:status:" + name }],
        [
          { text: ui("logs"), callback_data: "b:logs:" + name },
          { text: ui("history"), callback_data: "b:history:" + name },
        ],
        [{ text: ui("back_to_bot"), callback_data: "b:menu:" + name }],
      ];
      await safeEdit(chatId, msgId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка статуса: " + e.message);
    }
    return;
  }

  // ── стоп ──────────────────────────────────
  if (data.startsWith("b:stop:")) {
    const name = data.slice(7);
    try {
      await bot.editMessageText("⏳ Останавливаю " + name + "...", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
      });
    } catch (e) {}
    try {
      const r = await hbot("POST", "/bot-orchestration/stop-bot", {
        bot_name: name,
      });
      await new Promise((res) => setTimeout(res, 2000));
      await loadBots();
      const info = _bots[name] || { status: "stopped" };
      const text = "✅ Остановлен\n\n" + fmtBot(name, info);
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: botMenu(name, "stopped"),
        });
      } catch (e) {
        bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: botMenu(name, "stopped"),
        });
      }
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка остановки: " + e.message);
    }
    return;
  }

  // ── старт существующего ───────────────────
  if (data.startsWith("b:start:")) {
    const name = data.slice(8);
    try {
      await bot.editMessageText("⏳ Запускаю " + name + "...", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
      });
    } catch (e) {}
    try {
      // Проверяем состояние Docker контейнера
      const dockerStatus = (
        (await execCommand(
          `docker inspect --format='{{.State.Status}}' ${name} 2>&1`
        )) || ""
      )
        .trim()
        .toLowerCase();

      // Если контейнер exited/stopped — сначала поднимаем его через docker start
      if (
        dockerStatus === "exited" ||
        dockerStatus === "created" ||
        dockerStatus === "stopped"
      ) {
        try {
          await bot.editMessageText(
            "⏳ Запускаю " + name + "...\n🐳 Поднимаю Docker контейнер...",
            { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
          );
        } catch (e) {}

        await execCommand(`docker start ${name} 2>&1`);

        // Ждём пока контейнер станет running (до 30 секунд)
        let containerUp = false;
        for (let i = 0; i < 10; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          const st = (
            (await execCommand(
              `docker inspect --format='{{.State.Status}}' ${name} 2>&1`
            )) || ""
          )
            .trim()
            .toLowerCase();
          if (st === "running") {
            containerUp = true;
            break;
          }
          if (st === "exited" || st === "dead") {
            // Контейнер упал — показываем логи
            const logs = await execCommand(
              `docker logs ${name} --tail 30 2>&1`
            );
            return bot.sendMessage(
              chatId,
              "💥 *Контейнер упал при запуске!*\n\n```\n" +
                sanitizeLog(logs).slice(0, 1500) +
                "\n```",
              { parse_mode: "Markdown", reply_markup: botMenu(name, "stopped") }
            );
          }
        }

        if (!containerUp) {
          const psOut = await execCommand(
            `docker ps -a --format '{{.Names}} {{.Status}}' --filter name=${name} 2>&1`
          );
          return bot.sendMessage(
            chatId,
            "⚠️ Контейнер не запустился за 30с\n\n`" + psOut.trim() + "`",
            { parse_mode: "Markdown", reply_markup: botMenu(name, "stopped") }
          );
        }

        try {
          await bot.editMessageText(
            "⏳ Запускаю " +
              name +
              "...\n🟢 Контейнер запущен, подключаю к MQTT...",
            { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
          );
        } catch (e) {}
      } else if (dockerStatus !== "running") {
        // Контейнер вообще не существует или неизвестный статус
        return bot.sendMessage(
          chatId,
          "⚠️ Docker контейнер не найден или недоступен\nСтатус: `" +
            (dockerStatus || "неизвестен") +
            "`\n\nСоздайте нового бота: /newbot",
          { parse_mode: "Markdown" }
        );
      }

      // === АЛГОРИТМ СТАРТА ===
      // Факт: start-bot API всегда шлёт только stop, start никогда не доходит
      // после того как бот уже был запущен и остановлен.
      // Единственное что работает: docker restart → бот автозапускается сам
      // (именно так он запустился в 12:42 при первом старте контейнера).

      try {
        await bot.editMessageText(
          "⏳ " + name + "\n🔄 Перезапускаю контейнер...",
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
        );
      } catch (e) {}

      await execCommand(`docker restart ${name} 2>&1`);

      // Ждём пока контейнер поднимется
      let containerUp = false;
      for (let i = 0; i < 10; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const st = (
          await execCommand(
            `docker inspect --format='{{.State.Running}}' ${name} 2>&1`
          ).catch(() => "")
        ).trim();
        if (st === "true") {
          containerUp = true;
          break;
        }
      }

      if (!containerUp) {
        const logs = await execCommand(
          `docker logs ${name} --tail 15 2>&1`
        ).catch(() => "");
        return bot.sendMessage(
          chatId,
          "💥 *Контейнер не запустился*\n\n```\n" +
            sanitizeLog(logs).slice(0, 800) +
            "\n```",
          { parse_mode: "Markdown", reply_markup: botMenu(name, "stopped") }
        );
      }

      try {
        await bot.editMessageText(
          "⏳ " +
            name +
            "\n🟢 Контейнер запущен\n⏳ Жду автозапуска стратегии...",
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
        );
      } catch (e) {}

      // Ждём пока MQTT статус станет "running" (автозапуск при старте контейнера)
      let finalStatus = "stopped";
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 4000));
        try {
          const sr = await hbot("GET", "/bot-orchestration/status");
          const sp = sr?.data || sr || {};
          const st = sp[name]?.status;
          console.log(`[start wait] ${i + 1}/20 MQTT status:`, st);
          if (st === "running") {
            finalStatus = "running";
            break;
          }
        } catch (e) {}

        // Прогресс каждые 20с
        if (i % 5 === 4) {
          const sec = (i + 1) * 4;
          try {
            await bot.editMessageText(
              "⏳ " +
                name +
                `\n🟢 Контейнер запущен\n⏳ Ожидание... (${sec}с / 80с)`,
              { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
            );
          } catch (e) {}
        }
      }

      // Если за 80с не "running" — пробуем start-bot один раз как запасной вариант
      if (finalStatus !== "running") {
        try {
          await bot.editMessageText(
            "⏳ " + name + "\n📡 Пробую start-bot API...",
            { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
          );
        } catch (e) {}

        try {
          const r = await hbot("POST", "/bot-orchestration/start-bot", {
            bot_name: name,
            script: "v2_with_controllers",
            conf: name,
          });
          console.log("[start-bot fallback]:", JSON.stringify(r).slice(0, 200));
        } catch (e) {}

        await new Promise((res) => setTimeout(res, 15000));
        try {
          const sr2 = await hbot("GET", "/bot-orchestration/status");
          finalStatus = (sr2?.data || sr2 || {})[name]?.status || "stopped";
        } catch (e) {}
      }

      await loadBots();
      const info = _bots[name] || {};
      const text =
        finalStatus === "running"
          ? "▶️ *Запущен!*\n\n" + fmtBot(name, info)
          : "❌ *Стратегия не запустилась автоматически*\n\n" +
            `_MQTT: \`${finalStatus}\`_\n` +
            "_Контейнер запущен, но стратегия не стартовала.\n" +
            "Возможно проблема в конфиге или базе данных._\n\n" +
            fmtBot(name, info);

      await sendLong(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: botMenu(
          name,
          finalStatus === "running" ? "running" : "stopped"
        ),
      });
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (e) {}
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка запуска: " + e.message);
    }
    return;
  }

  // ── починить database_path ────────────────
  if (data.startsWith("b:fixdb:")) {
    const name = data.slice(8);
    try {
      await bot.editMessageText("🔧 Прописываю `database_path`...", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
      });
    } catch (e) {}
    try {
      const result = patchDatabasePath(name);
      const where = result.host ? "на хосте" : "в контейнере";
      const fileList = result.files
        .map((f) => `  • \`${f.split("/").pop()}\``)
        .join("\n");
      await safeEdit(
        chatId,
        msgId,
        `✅ *database\\_path обновлён*\n\n` +
          `📁 Путь: \`${result.path}\`\n` +
          `📝 Файлов (${where}): ${result.patched}\n` +
          `${fileList}\n\n` +
          `⚠️ Перезапустите бота чтобы изменения вступили в силу.`,
        {
          parse_mode: "Markdown",
          reply_markup: botMenu(name, _bots[name]?.status || "stopped"),
        }
      );
    } catch (e) {
      await safeEdit(chatId, msgId, "❌ Ошибка: " + e.message, {
        reply_markup: botMenu(name, _bots[name]?.status || "stopped"),
      });
    }
    return;
  }

  // ── удалить: подтверждение ────────────────
  if (data.startsWith("b:delask:")) {
    const name = data.slice(9);
    try {
      await bot.editMessageText(
        "⚠️ *Удалить бота?*\n\n`" +
          name +
          "`\n\nКонтейнер будет удалён. Данные в `bots/` сохранятся.",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: ui("del_yes"), callback_data: "b:delok:" + name },
                { text: ui("cancel"), callback_data: "b:menu:" + name },
              ],
            ],
          },
        }
      );
    } catch (e) {}
    return;
  }

  // ── удалить: выполнить ────────────────────
  if (data.startsWith("b:delok:")) {
    const name = data.slice(8);
    await bot.editMessageText("⏳ Удаляю `" + name + "`...", {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
    });
    try {
      // 1. Стоп через API
      await hbot("POST", "/bot-orchestration/stop-bot", {
        bot_name: name,
      }).catch(() => {});
      // 2. Принудительное удаление docker-контейнера (надёжнее API)
      await execCommand(`docker stop ${name} 2>&1`).catch(() => {});
      await execCommand(`docker rm -f ${name} 2>&1`).catch(() => {});
      // 3. API удаление
      await hbot("DELETE", "/docker/remove-container/" + name).catch(() => {});
      // 4. Ждём пока API очистит MQTT-запись и удаляем из кэша
      delete _bots[name];
      await new Promise((res) => setTimeout(res, 4000));
      await loadBots();
      delete _bots[name]; // на случай если API ещё не очистил

      await bot.editMessageText("✅ Бот `" + name + "` удалён.", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: ui("create_new"), callback_data: "bots_new" },
              { text: "🤖 Список ботов", callback_data: "bots_list" },
            ],
          ],
        },
      });
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка удаления: " + e.message);
    }
    return;
  }

  // ── удалить базу данных бота ─────────────
  if (data.startsWith("b:dbdel:")) {
    const name = data.slice(8);

    // Проверяем что бот не запущен
    await loadBots();
    if (_bots[name]?.status === "running") {
      await safeEdit(
        chatId,
        msgId,
        "⚠️ Нельзя удалить базу работающего бота.\n\nСначала остановите: 🛑 Остановить",
        { reply_markup: botMenu(name, "running") }
      );
      return;
    }

    // SQLite живёт в папке инстанса: instances/{name}/data/{name}.sqlite
    // Также ищем через docker exec — на случай если путь другой
    const instDataDir = `${BOTS_INSTANCES_DIR}/${name}/data`;
    const candidates = [
      `${instDataDir}/${name}.sqlite`,
      `${instDataDir}/conf_v2_with_controllers_01.sqlite`,
    ];

    // Ищем через find в папке инстанса + через docker exec внутри контейнера
    const [findOut, dockerFind] = await Promise.all([
      execCommand(`find "${instDataDir}" -name "*.sqlite" 2>/dev/null`),
      execCommand(
        `docker exec ${name} find /home/hummingbot/data -name "*.sqlite" 2>/dev/null`
      ).catch(() => ""),
    ]);

    // Собираем уникальные хостовые пути
    const hostFiles = findOut
      .trim()
      .split("\n")
      .filter((f) => f.trim());
    // Docker пути конвертируем в хостовые через volume mount
    const dockerFiles = dockerFind
      .trim()
      .split("\n")
      .filter((f) => f.trim())
      .map((f) => f.replace("/home/hummingbot/data", instDataDir));

    const allFiles = [...new Set([...hostFiles, ...dockerFiles])];
    const foundFiles = allFiles.filter((f) => f.endsWith(".sqlite"));

    let text = `🗄️ *База данных — \`${name}\`*\n\n`;

    if (!foundFiles.length) {
      text += `_SQLite файлы не найдены_\n\nПроверенные пути:\n`;
      candidates.forEach((p) => {
        text += `  \`${p}\`\n`;
      });
      text += `\nВозможно база внутри контейнера (не смонтирована на хост).`;
      await safeEdit(chatId, msgId, text, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: ui("back"), callback_data: "b:menu:" + name }],
          ],
        },
      });
      return;
    }

    // Показываем найденные файлы и предлагаем удалить
    text += `*Найденные базы:*\n`;
    foundFiles.forEach((f) => {
      text += `  \`${f}\`\n`;
    });
    text += `\n⚠️ *Удалить все найденные файлы?*\nИстория торгов будет очищена.`;

    // Сохраняем список файлов в callback через разделитель — но файлов может быть много,
    // поэтому храним в памяти
    _dbDelFiles[chatId] = { name, files: foundFiles };

    await safeEdit(chatId, msgId, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: ui("del_yes"), callback_data: "b:dbdel_ok:" + name },
            { text: "❌ Отмена", callback_data: "b:menu:" + name },
          ],
        ],
      },
    });
    return;
  }

  // ── подтверждение удаления базы ──────────
  if (data.startsWith("b:dbdel_ok:")) {
    const name = data.slice(11);
    const saved = _dbDelFiles[chatId];
    delete _dbDelFiles[chatId];

    if (!saved || !saved.files.length) {
      await safeEdit(
        chatId,
        msgId,
        "⚠️ Файлы не найдены. Попробуйте снова.",
        {}
      );
      return;
    }

    let results = "";
    for (const f of saved.files) {
      const out = await execCommand(
        `rm -f "${f}" 2>&1 && echo "OK" || echo "ERR"`
      );
      results += `\`${f}\`: ${
        out.trim() === "OK" ? "✅" : "❌ " + out.trim()
      }\n`;
    }

    await safeEdit(chatId, msgId, `🗄️ *База удалена*\n\n${results}`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: ui("back_to_bot"), callback_data: "b:menu:" + name }],
        ],
      },
    });
    return;
  }
  // ── wizard шаг 1: toggle контроллера ─────
  if (data.startsWith("wz1t:")) {
    const ctrl = data.slice(5);
    const state = _wiz[chatId];
    if (!state)
      return bot.sendMessage(chatId, "⚠️ Сессия устарела, повторите /newbot");

    // Переключаем выбор
    const idx = state.ctrls.indexOf(ctrl);
    if (idx >= 0) state.ctrls.splice(idx, 1);
    else state.ctrls.push(ctrl);

    const rows = state.ctrlList.map((n) => [
      {
        text: (state.ctrls.includes(n) ? "✅ " : "☐ ") + n,
        callback_data: "wz1t:" + n.slice(0, 50),
      },
    ]);
    if (state.ctrls.length > 0) {
      rows.push([
        {
          text: `➡️ Далее (выбрано: ${state.ctrls.length})`,
          callback_data: "wz1next",
        },
      ]);
    }
    rows.push([
      { text: ui("cancel"), callback_data: "wz_cancel" },
      btnMainMenu(),
    ]);

    const selected = state.ctrls.length
      ? state.ctrls.map((c) => `✅ \`${c}\``).join("\n")
      : "_ничего не выбрано_";

    try {
      await bot.editMessageText(
        "🚀 *Новый бот — Шаг 1/3*\n\nВыберите контроллеры:\n\n" + selected,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: rows },
        }
      );
    } catch (e) {}
    return;
  }

  // ── wizard шаг 1: переход к шагу 2 ───────
  if (data === "wz1next") {
    const state = _wiz[chatId];
    if (!state || !state.ctrls.length)
      return bot.sendMessage(chatId, "⚠️ Выберите хотя бы один контроллер");

    const scriptList = state.scriptList || [];
    const rows = scriptList.map((s) => [
      { text: "📄 " + s, callback_data: "wz2:" + s.slice(0, 50) },
    ]);
    if (!scriptList.includes("conf_v2_with_controllers_01")) {
      rows.push([
        {
          text: "📄 conf_v2_with_controllers_01 (по умолч.)",
          callback_data: "wz2:conf_v2_with_controllers_01",
        },
      ]);
    }
    rows.push([
      { text: ui("cancel"), callback_data: "wz_cancel" },
      btnMainMenu(),
    ]);

    const ctrlsText = state.ctrls.map((c) => `  ✅ \`${c}\``).join("\n");
    try {
      await bot.editMessageText(
        "🚀 *Новый бот — Шаг 2/3*\n\nКонтроллеры:\n" +
          ctrlsText +
          "\n\nВыберите конфиг скрипта:",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: rows },
        }
      );
    } catch (e) {}
    return;
  }

  // ── wizard шаг 2: скрипт ─────────────────
  if (data.startsWith("wz2:")) {
    const script = data.slice(4);
    const state = _wiz[chatId];
    if (!state)
      return bot.sendMessage(chatId, "⚠️ Сессия устарела, повторите /newbot");
    state.script = script;

    const ctrlsText = state.ctrls.map((c) => `  • \`${c}.yml\``).join("\n");
    try {
      await bot.editMessageText(
        "🚀 *Новый бот — Шаг 3/3*\n\n*Параметры:*\n\n" +
          "📋 Контроллеры:\n" +
          ctrlsText +
          "\n\n" +
          "📄 Скрипт:  `" +
          script +
          ".yml`\n" +
          "🐳 Образ:   `AgentWXO`\n" +
          "🔌 Аккаунт: `master_account`",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: ui("create_run"), callback_data: "wz_ok" },
                { text: "❌ Отмена", callback_data: "wz_cancel" },
              ],
            ],
          },
        }
      );
    } catch (e) {}
    return;
  }

  // ── wizard подтверждение ──────────────────
  if (data === "wz_ok") {
    const state = _wiz[chatId];
    if (!state)
      return bot.sendMessage(chatId, "⚠️ Сессия устарела, повторите /newbot");
    const { ctrls, script } = state;
    delete _wiz[chatId];

    try {
      await bot.editMessageText("⏳ Создаю бота...", {
        chat_id: chatId,
        message_id: msgId,
      });
    } catch (e) {}

    try {
      // Добавляем .yml к каждому контроллеру
      const ctrlFiles = ctrls.map((c) => (c.endsWith(".yml") ? c : c + ".yml"));

      // 1. Deploy — передаём массив контроллеров
      const deploy = await hbot(
        "POST",
        "/bot-orchestration/deploy-v2-controllers",
        {
          instance_name: "aroon-bot",
          credentials_profile: "master_account",
          controllers_config: ctrlFiles, // массив!
          image: "hummingbot-hummingbot:latest",
          script_config: script,
          headless: true,
        }
      );

      if (!deploy || !deploy.success) {
        return bot.sendMessage(
          chatId,
          "❌ Ошибка деплоя:\n```\n" +
            JSON.stringify(deploy, null, 2).slice(0, 500) +
            "\n```",
          { parse_mode: "Markdown" }
        );
      }

      const instanceName = deploy.unique_instance_name;
      try {
        await bot.editMessageText(
          "📦 `" + instanceName + "`\n⏳ Ожидаю запуска контейнера...",
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
        );
      } catch (e) {}

      // Ждём пока контейнер появится в docker ps
      let containerRunning = false;
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        const psOut = await execCommand(
          `docker inspect --format='{{.State.Status}}' ${instanceName} 2>&1`
        );
        const st = (psOut || "").trim().toLowerCase();
        if (st === "running") {
          containerRunning = true;
          break;
        }
        if (st.includes("no such") || st.includes("error")) break; // контейнера нет вообще
        if (st === "exited" || st === "dead") {
          // Контейнер упал — показываем логи сразу
          const logs = await execCommand(
            `docker logs ${instanceName} --tail 40 2>&1`
          );
          return bot.sendMessage(
            chatId,
            "💥 *Контейнер упал при запуске!*\n\n`" +
              instanceName +
              "`\n\n" +
              "```\n" +
              logs.slice(0, 2000) +
              "\n```\n\n" +
              "Проверьте конфиг: /diag",
            { parse_mode: "Markdown" }
          );
        }
      }

      if (!containerRunning) {
        const psOut = await execCommand(
          `docker ps -a --format '{{.Names}} {{.Status}}' --filter name=${instanceName} 2>&1`
        );
        return bot.sendMessage(
          chatId,
          "⚠️ Контейнер не запустился за 60с\n\n`" +
            instanceName +
            "`\n\n`" +
            psOut.trim() +
            "`\n\n/diag",
          {
            parse_mode: "Markdown",
            reply_markup: botMenu(instanceName, "stopped"),
          }
        );
      }

      // Контейнер running — патчим database_path в контроллерах ДО старта
      try {
        await bot.editMessageText(
          "📦 `" + instanceName + "`\n🔧 Прописываю путь к базе данных...",
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
        );
      } catch (e) {}

      try {
        const patchResult = patchDatabasePath(instanceName);
        console.log(
          `✅ database_path пропатчен в ${patchResult.patched} файлах -> ${patchResult.path}`
        );
      } catch (patchErr) {
        console.error("⚠️ Ошибка патча database_path:", patchErr.message);
        // Не прерываем запуск
      }

      // Контейнер running — ждём MQTT регистрации и вызываем start-bot
      bot.sendMessage(chatId, "🟢 Контейнер запущен, подключаю к MQTT...");
      const { ok, result: startRes } = await startBotWithRetry(
        instanceName,
        15,
        4000
      );

      await Promise.all([loadBots(), loadContainers()]);
      const info = _bots[instanceName] || {
        status: ok ? "running" : "stopped",
      };

      if (ok) {
        const ctrlsLine = ctrls.map((c) => `  • \`${c}\``).join("\n");
        bot.sendMessage(
          chatId,
          "✅ *Бот запущен!*\n\n📛 `" +
            instanceName +
            "`\n📋 Контроллеры:\n" +
            ctrlsLine +
            "\n\n" +
            fmtBot(instanceName, info),
          {
            parse_mode: "Markdown",
            reply_markup: botMenu(instanceName, "running"),
          }
        );
      } else {
        // Показываем docker logs для диагностики
        const logs = await execCommand(
          `docker logs ${instanceName} --tail 25 2>&1`
        );
        bot.sendMessage(
          chatId,
          "⚠️ *Контейнер работает, но MQTT не подключился*\n\n" +
            "📛 `" +
            instanceName +
            "`\n\n" +
            "```\n" +
            sanitizeLog(logs).slice(0, 1200) +
            "\n```\n\n" +
            "Подробнее: /botlogs " +
            instanceName,
          {
            parse_mode: "Markdown",
            reply_markup: botMenu(instanceName, "stopped"),
          }
        );
      }
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка создания бота: " + e.message);
    }
    return;
  }

  // ── wizard отмена ─────────────────────────
  if (data === "wz_cancel") {
    delete _wiz[chatId];
    try {
      await bot.editMessageText("❌ Отменено.", {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [[btnMainMenu()]] },
      });
    } catch (e) {
      bot.sendMessage(chatId, "❌ Отменено.");
    }
    return;
  }

  // ────────── БИРЖИ ──────────────────────────

  // Список бирж (обновить)
  if (data === "ex:list") {
    try {
      const list = await getExchanges();
      let text = "🔌 *Подключённые биржи:*\n\n";
      if (!list.length) text += "_Нет_\n";
      else
        list.forEach((e) => {
          text += `  ✅ ${e}\n`;
        });
      const rows = list.map((e) => [
        {
          text: ui("del_exchange") + e.toUpperCase(),
          callback_data: "ex:delask:" + e,
        },
      ]);
      rows.push([
        { text: ui("add_exchange"), callback_data: "ex:add" },
        { text: ui("refresh"), callback_data: "ex:list" },
      ]);
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
    } catch (e) {}
    return;
  }

  // Добавить биржу — выбор из полного списка коннекторов
  if (data === "ex:add") {
    try {
      await bot.editMessageText("⏳ Загружаю список бирж...", {
        chat_id: chatId,
        message_id: msgId,
      });
    } catch (e) {}
    try {
      const all = await getConnectorList();
      // Показываем по 2 в ряд
      const rows = [];
      for (let i = 0; i < all.length; i += 2) {
        const row = [{ text: all[i], callback_data: "ex:choose:" + all[i] }];
        if (all[i + 1])
          row.push({
            text: all[i + 1],
            callback_data: "ex:choose:" + all[i + 1],
          });
        rows.push(row);
      }
      rows.push([{ text: ui("cancel"), callback_data: "ex:list" }]);
      await bot.editMessageText(
        "🔌 *Добавить биржу*\n\nВыберите биржу (" + all.length + " доступно):",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: rows },
        }
      );
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка загрузки бирж: " + e.message);
    }
    return;
  }

  // Выбрана биржа — загружаем поля из API и начинаем ввод
  if (data.startsWith("ex:choose:")) {
    const exchange = data.slice(10);
    try {
      await bot.editMessageText("⏳ Загружаю поля для " + exchange + "...", {
        chat_id: chatId,
        message_id: msgId,
      });
    } catch (e) {}
    try {
      const fields = await getConnectorFields(exchange);
      if (!fields || !fields.length) {
        return bot.sendMessage(
          chatId,
          "❌ Не удалось получить поля для `" +
            exchange +
            "`.\n\nВозможно эта биржа не поддерживается.",
          { parse_mode: "Markdown" }
        );
      }
      _exchWiz[chatId] = { exchange, fields, values: [], step: "input" };
      bot.sendMessage(
        chatId,
        "🔑 *Добавление " +
          exchange.toUpperCase() +
          "*\n\n" +
          "Нужно ввести " +
          fields.length +
          " " +
          (fields.length === 1 ? "поле" : "поля") +
          ":\n" +
          fields.map((f) => `• \`${f}\``).join("\n") +
          "\n\n" +
          "Введите `" +
          fields[0] +
          "`:",
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка: " + e.message);
    }
    return;
  }

  // Удалить биржу — подтверждение
  if (data.startsWith("ex:delask:")) {
    const exchange = data.slice(10);
    try {
      await bot.editMessageText(
        "⚠️ *Удалить " +
          exchange.toUpperCase() +
          "?*\n\nAPI ключи будут удалены из master_account.",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: ui("del_yes"), callback_data: "ex:delok:" + exchange },
                { text: ui("cancel"), callback_data: "ex:list" },
              ],
            ],
          },
        }
      );
    } catch (e) {}
    return;
  }

  // Удалить биржу — выполнить
  if (data.startsWith("ex:delok:")) {
    const exchange = data.slice(9);
    try {
      await bot.editMessageText("⏳ Удаляю " + exchange.toUpperCase() + "...", {
        chat_id: chatId,
        message_id: msgId,
      });
    } catch (e) {}
    try {
      // Пробуем разные эндпоинты — API agentwxo нестабилен в этом
      let r = await hbot(
        "DELETE",
        "/accounts/master_account/credentials/" + exchange
      );
      if (r?.detail === "Not Found") {
        r = await hbot(
          "POST",
          "/accounts/delete-credential/master_account/" + exchange,
          {}
        );
      }
      if (r?.detail === "Not Found") {
        r = await hbot("DELETE", "/accounts/" + exchange + "/credentials");
      }

      const success = r && !r.detail && !r._raw;
      const list = await getExchanges();
      const rows = list.map((e) => [
        {
          text: ui("del_exchange") + e.toUpperCase(),
          callback_data: "ex:delask:" + e,
        },
      ]);
      rows.push([
        { text: ui("add_exchange"), callback_data: "ex:add" },
        { text: ui("refresh"), callback_data: "ex:list" },
      ]);
      let fullText = "🔌 *Подключённые биржи:*\n\n";
      if (!list.length) fullText += "_Нет_\n";
      else
        list.forEach((e) => {
          fullText += `  ✅ ${e}\n`;
        });
      fullText += success
        ? "\n✅ " + exchange.toUpperCase() + " удалён."
        : "\n⚠️ Ответ API:\n`" +
          JSON.stringify(r).slice(0, 150) +
          "`\n\nЕсли биржа не удалилась — попробуйте /diag";
      await bot.editMessageText(fullText, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
    } catch (e) {
      bot.sendMessage(chatId, "❌ Ошибка: " + e.message);
    }
    return;
  }

  // ── конфиги контроллеров (cfg:) ──────────
  if (data.startsWith("cfg:")) {
    if (data === "cfg:list") {
      try {
        const activeDir = getCtrlDir();
        const out = await execCommand(`ls "${activeDir}" 2>&1`);
        const files = out
          .split("\n")
          .map((f) => f.trim())
          .filter((f) => f.endsWith(".yml"));
        const rows = files.map((f) => [
          { text: "⚙️ " + f, callback_data: "cfg:open:" + f },
        ]);
        rows.push([{ text: "🔄 Обновить", callback_data: "cfg:list" }]);
        await bot
          .editMessageText("⚙️ *Конфиги контроллеров:*\n\nВыберите файл:", {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: rows },
          })
          .catch(() =>
            bot.sendMessage(
              chatId,
              "⚙️ *Конфиги контроллеров:*\n\nВыберите файл:",
              {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: rows },
              }
            )
          );
      } catch (e) {
        bot.sendMessage(chatId, "❌ " + e.message);
      }
      return;
    }
    if (data.startsWith("cfg:open:")) {
      const fname = data.slice(9);
      const fpath = path.join(getCtrlDir(), fname);
      await showConfigEditor(chatId, fpath, msgId);
      return;
    }
    if (data.startsWith("cfg:edit:")) {
      const parts = data.slice(9).split(":");
      const fname2 = parts[0];
      const key = parts.slice(1).join(":");
      const fpath2 = path.join(getCtrlDir(), fname2);
      let config2;
      try {
        config2 = readYaml(fpath2);
      } catch (e) {
        return bot.sendMessage(chatId, "❌ " + e.message);
      }
      if (!(key in config2))
        return bot.sendMessage(chatId, "❌ Ключ не найден");
      const currentValue = config2[key];
      const typeName =
        currentValue === null
          ? "null/число/строка"
          : Array.isArray(currentValue)
          ? "список (через запятую или JSON)"
          : typeof currentValue;
      let hint = "";
      if (typeof currentValue === "boolean")
        hint = "Введите: `true` или `false`";
      else if (typeof currentValue === "number")
        hint = "Введите число (например: `0.01`)";
      else if (Array.isArray(currentValue))
        hint = "Введите через запятую: `BTC-USDT, ETH-USDT`";
      else hint = "Введите строку (кавычки не нужны)";
      _cfgEdit[chatId] = {
        fname: fname2,
        key,
        currentValue,
        filePath: fpath2,
        msgId,
      };
      await bot.sendMessage(
        chatId,
        `✏️ *${mdEsc(fname2)}*\n\nРедактирование: \`${key}\`\nТекущее: ${fmtVal(
          currentValue
        )}\nТип: _${typeName}_\n\n${hint}\n\n_Отправьте новое значение или_ /cancel`,
        { parse_mode: "Markdown" }
      );
      return;
    }
  }
}); // конец callback_query router

// =============================================
// === УПРАВЛЕНИЕ БИРЖАМИ ===
// =============================================

// Список популярных бирж с нужными полями
// Полный список бирж с правильными именами полей (из реальных тестов api)
// Используется как fallback если API /connectors/{name}/config-map недоступен
const EXCHANGE_FALLBACK = {
  binance: ["binance_api_key", "binance_api_secret"],
  binance_paper_trade: ["binance_api_key", "binance_api_secret"],
  mexc: ["mexc_api_key", "mexc_api_secret"],
  bybit: ["bybit_api_key", "bybit_api_secret"],
  okx: ["okx_api_key", "okx_api_secret", "okx_passphrase"],
  kucoin: ["kucoin_api_key", "kucoin_api_secret", "kucoin_passphrase"],
  gate_io: ["gate_io_api_key", "gate_io_secret_key"],
  htx: ["htx_api_key", "htx_secret_key"],
  kraken: ["kraken_api_key", "kraken_secret_key"],
  coinbase_advanced_trade: [
    "coinbase_advanced_trade_api_key",
    "coinbase_advanced_trade_api_secret",
  ],
  bitget: ["bitget_api_key", "bitget_secret_key", "bitget_passphrase"],
  bingx: ["bingx_api_key", "bingx_secret_key"],
  bitmart: ["bitmart_api_key", "bitmart_secret_key", "bitmart_memo"],
  deribit: ["deribit_client_id", "deribit_client_secret"],
  hyperliquid: ["hyperliquid_api_key", "hyperliquid_api_secret"],
  vertex_protocol: ["vertex_protocol_api_key", "vertex_protocol_api_secret"],
};

// Получить список всех доступных коннекторов из API
async function getConnectorList() {
  try {
    const r = await hbot("GET", "/connectors/");
    const list = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [];
    if (list.length)
      return list.map((c) =>
        typeof c === "string" ? c : c.name || c.connector_name || String(c)
      );
  } catch (e) {}
  return Object.keys(EXCHANGE_FALLBACK);
}

// Получить реальные поля для коннектора из API config-map
async function getConnectorFields(connector) {
  try {
    const r = await hbot("GET", "/connectors/" + connector + "/config-map");
    const map = r?.data || r || {};
    if (typeof map !== "object" || Array.isArray(map))
      throw new Error("bad format");
    const fields = Object.keys(map).filter(
      (k) =>
        ![
          "trading_pair",
          "leverage",
          "position_mode",
          "slippage_buffer",
        ].includes(k) &&
        (k.includes("key") ||
          k.includes("secret") ||
          k.includes("passphrase") ||
          k.includes("password") ||
          k.includes("memo") ||
          k.includes("client_id") ||
          k.includes("api") ||
          k.includes("token"))
    );
    if (fields.length) return fields;
  } catch (e) {}
  // fallback
  return EXCHANGE_FALLBACK[connector] || null;
}

// Состояние для добавления биржи: { chatId: { exchange, fields, values } }
const _exchWiz = {};

// /exchanges — список подключённых бирж с кнопками
bot.onText(/\/exchanges/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const m = await bot.sendMessage(CHAT_ID, "🔌 Загружаю биржи...");
  try {
    const list = await getExchanges();
    let text = "🔌 *Подключённые биржи:*\n\n";
    if (!list.length) {
      text += "_Нет подключённых бирж_\n";
    } else {
      list.forEach((e) => {
        text += `  ✅ ${e}\n`;
      });
    }
    const rows = list.map((e) => [
      {
        text: "🗑️ Удалить " + e.toUpperCase(),
        callback_data: "ex:delask:" + e,
      },
    ]);
    rows.push([{ text: ui("add_exchange"), callback_data: "ex:add" }]);
    rows.push([{ text: ui("refresh"), callback_data: "ex:list" }]);
    bot.editMessageText(text, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    });
  } catch (e) {
    bot.editMessageText("❌ Ошибка: " + e.message, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
    });
  }
});

// Обработчик ввода ключей биржи (текстовые сообщения для wizard добавления)

// Безопасная отправка — если Markdown сломан, шлём plain text
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, opts);
  } catch (e) {
    if (e.message && e.message.includes("parse entities")) {
      // Markdown сломан — шлём без форматирования
      const plain = { ...opts };
      delete plain.parse_mode;
      return bot
        .sendMessage(chatId, text.replace(/[*_`\[\]]/g, ""), plain)
        .catch(() => {});
    }
    throw e;
  }
}

async function safeEdit(chatId, msgId, text, opts = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      ...opts,
    });
  } catch (e) {
    if (
      e.message &&
      (e.message.includes("parse entities") ||
        e.message.includes("message is not modified"))
    ) {
      if (e.message.includes("parse entities")) {
        const plain = { ...opts };
        delete plain.parse_mode;
        return bot
          .editMessageText(text.replace(/[*_`\[\]]/g, ""), {
            chat_id: chatId,
            message_id: msgId,
            ...plain,
          })
          .catch(() => {});
      }
      return; // "not modified" — не ошибка
    }
    throw e;
  }
}

// Безопасные глобальные обработчики ошибок
// Без них любой unhandled rejection убивает процесс Node.js
// =============================================
process.on("unhandledRejection", (reason, promise) => {
  const msg = (reason?.message || String(reason) || "").slice(0, 200);
  console.error("⚠️ unhandledRejection:", msg);
  // Если это ошибка Telegram — пробуем уведомить пользователя
  if (msg.includes("ETELEGRAM") || msg.includes("parse entities")) {
    bot
      .sendMessage(
        CHAT_ID,
        "⚠️ Ошибка форматирования сообщения. Попробуйте ещё раз."
      )
      .catch(() => {});
  }
});

process.on("uncaughtException", (err) => {
  console.error("💥 uncaughtException:", err.message);
  bot
    .sendMessage(
      CHAT_ID,
      "💥 Критическая ошибка бота: " + err.message.slice(0, 100)
    )
    .catch(() => {});
  // НЕ делаем process.exit() — бот продолжает работать
});

// Ошибки polling Telegram (соединение, таймауты) — не убиваем процесс
let _pollingRestartCount = 0;
let _pollingRestartTimer = null;

bot.on("polling_error", (err) => {
  console.error("📡 polling_error:", err.message || err.code || err);

  // EFATAL — критическая сетевая ошибка, библиотека прекращает polling.
  // Нужно перезапустить polling вручную с экспоненциальной задержкой.
  const isFatal =
    err.code === "EFATAL" ||
    (err.message && err.message.includes("EFATAL")) ||
    err instanceof AggregateError;

  if (isFatal) {
    if (_pollingRestartTimer) return; // уже запланирован рестарт
    _pollingRestartCount++;
    // Задержка: 5s, 10s, 20s, 40s, максимум 60s
    const delay = Math.min(5000 * Math.pow(2, _pollingRestartCount - 1), 60000);
    console.warn(
      `⚠️ Polling EFATAL — перезапуск через ${
        delay / 1000
      }s (попытка ${_pollingRestartCount})`
    );

    _pollingRestartTimer = setTimeout(async () => {
      _pollingRestartTimer = null;
      try {
        await bot.stopPolling();
      } catch (e) {}
      try {
        await bot.startPolling({ restart: false });
        console.log("✅ Polling перезапущен успешно");
        _pollingRestartCount = 0; // сбрасываем счётчик при успехе
      } catch (e) {
        console.error("❌ Ошибка при перезапуске polling:", e.message);
        // Имитируем следующую EFATAL для повторного рестарта
        bot.emit("polling_error", e);
      }
    }, delay);
  }
});

// =============================================
// === РЕДАКТОР КОНФИГОВ КОНТРОЛЛЕРОВ ===
// =============================================

// CTRL_DIR = CTRL_DIR_FILES (see getCtrlDir at top)

// Ключи которые сохраняются БЕЗ кавычек (идентификаторы, типы, пути)
const KEYS_NO_QUOTES = new Set([
  "id",
  "controller_name",
  "controller_type",
  "connector_name",
  "trading_pair",
  "candles_connector_name",
  "candles_trading_pair",
  "position_mode",
  "candles_interval",
  "exchange",
]);

// Ключи только для чтения — нельзя менять
const KEYS_READONLY = new Set([
  "id",
  "controller_name",
  "controller_type",
  "database_path",
  "position_mode",
  "manual_kill_switch",
  "candles_config",
  "initial_positions",
]);

// Состояние редактора: { chatId: { file, key, currentType, msgId } }
const _cfgEdit = {};

// Читает YAML и возвращает объект
function readYaml(filePath) {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  return raw ? YAML.parse(raw) : {};
}

// Сохраняет объект обратно в YAML с правильным форматированием
function writeYaml(filePath, config) {
  const lines = Object.keys(config).map((k) => {
    const val = config[k];
    if (val === null || val === undefined) return `${k}: null`;
    if (typeof val === "number" || typeof val === "boolean")
      return `${k}: ${val}`;
    if (typeof val === "string") {
      return KEYS_NO_QUOTES.has(k)
        ? `${k}: ${val}`
        : `${k}: '${val.replace(/'/g, "''")}'`;
    }
    if (Array.isArray(val)) {
      if (!val.length) return `${k}: []`;
      return (
        `${k}:\n` +
        val
          .map((v) => `- ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("\n")
      );
    }
    return `${k}: ${JSON.stringify(val)}`;
  });
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// Валидирует и парсит новое значение по типу текущего
function parseConfigValue(raw, currentValue) {
  const s = raw.trim();
  // Снимаем кавычки если пользователь сам поставил
  const unquoted =
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
      ? s.slice(1, -1)
      : s;

  if (typeof currentValue === "number") {
    const n = Number(unquoted);
    if (isNaN(n)) throw new Error(`Ожидается число, получено: "${unquoted}"`);
    return n;
  }
  if (typeof currentValue === "boolean") {
    const b = unquoted.toLowerCase();
    if (b !== "true" && b !== "false")
      throw new Error(`Ожидается true или false`);
    return b === "true";
  }
  if (currentValue === null || currentValue === undefined) {
    if (unquoted.toLowerCase() === "null") return null;
    const n = Number(unquoted);
    if (!isNaN(n) && unquoted !== "") return n;
    return unquoted;
  }
  if (Array.isArray(currentValue)) {
    // Массив: каждая строка или JSON
    try {
      const parsed = JSON.parse(unquoted);
      if (!Array.isArray(parsed)) throw new Error("Ожидается массив");
      return parsed;
    } catch {
      // Пробуем через запятую
      return unquoted
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return unquoted;
}

// Форматирует значение для отображения
function fmtVal(val) {
  if (val === null || val === undefined) return "`null`";
  if (Array.isArray(val))
    return val.length ? val.map((v) => `\`${v}\``).join(", ") : "_пусто_";
  return `\`${String(val)}\``;
}

// Показывает конфиг в виде кнопок
async function showConfigEditor(chatId, filePath, editMsgId) {
  let config;
  try {
    config = readYaml(filePath);
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Ошибка чтения файла: " + e.message);
  }
  const fname = path.basename(filePath);
  let text = `⚙️ *${mdEsc(fname)}*\n\nНажмите на параметр чтобы изменить:\n\n`;

  const rows = [];
  for (const [k, v] of Object.entries(config)) {
    const readonly = KEYS_READONLY.has(k);
    const displayVal =
      String(v).slice(0, 25) + (String(v).length > 25 ? "…" : "");
    text += `${readonly ? "🔒" : "✏️"} \`${k}\`: ${fmtVal(v)}\n`;
    if (!readonly) {
      rows.push([
        {
          text: `✏️ ${k}: ${displayVal}`,
          callback_data: `cfg:edit:${fname}:${k}`,
        },
      ]);
    }
  }
  rows.push([{ text: ui("back_to_list"), callback_data: "cfg:list" }]);

  if (editMsgId) {
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: editMsgId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
    } catch (e) {}
  }
  return bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

// /configs — список конфиг-файлов
bot.onText(/\/configs/, async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const m = await bot.sendMessage(CHAT_ID, "⚙️ Загружаю конфиги...");
  try {
    const activeDir = getCtrlDir();
    const out = await execCommand(`ls "${activeDir}" 2>&1`);
    const files = out
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".yml"));
    if (!files.length) {
      return bot.editMessageText("❌ Нет конфигов в " + activeDir, {
        chat_id: CHAT_ID,
        message_id: m.message_id,
      });
    }
    const rows = files.map((f) => [
      { text: "⚙️ " + f, callback_data: "cfg:open:" + f },
    ]);
    rows.push([{ text: "🔄 Обновить", callback_data: "cfg:list" }]);
    bot.editMessageText(
      "⚙️ *Конфиги контроллеров:*\n\nВыберите файл для редактирования:",
      {
        chat_id: CHAT_ID,
        message_id: m.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      }
    );
  } catch (e) {
    bot.editMessageText("❌ " + e.message, {
      chat_id: CHAT_ID,
      message_id: m.message_id,
    });
  }
});

// Callback-обработчики редактора конфигов
// (встраиваем в существующий router через отдельный listener)
bot.on("callback_query", async (query) => {
  if (query.message.chat.id.toString() !== CHAT_ID) return;
  const data = query.data || "";
  const chatId = query.message.chat.id.toString();
  const msgId = query.message.message_id;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (!data.startsWith("cfg:")) return;

  // cfg:list — список файлов
  if (data === "cfg:list") {
    try {
      const activeDir2 = getCtrlDir();
      const out = await execCommand(`ls "${activeDir2}" 2>&1`);
      const files = out
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.endsWith(".yml"));
      const rows = files.map((f) => [
        { text: "⚙️ " + f, callback_data: "cfg:open:" + f },
      ]);
      rows.push([{ text: "🔄 Обновить", callback_data: "cfg:list" }]);
      await bot.editMessageText(
        "⚙️ *Конфиги контроллеров:*\n\nВыберите файл:",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: rows },
        }
      );
    } catch (e) {}
    return;
  }

  // cfg:open:<filename> — открыть файл
  if (data.startsWith("cfg:open:")) {
    const fname = data.slice(9);
    const fpath = path.join(getCtrlDir(), fname);
    await showConfigEditor(chatId, fpath, msgId);
    return;
  }

  // cfg:edit:<filename>:<key> — начать редактирование поля
  if (data.startsWith("cfg:edit:")) {
    const parts = data.slice(9).split(":");
    const fname = parts[0];
    const key = parts.slice(1).join(":"); // на случай если в ключе есть ":"
    const fpath = path.join(getCtrlDir(), fname);

    let config;
    try {
      config = readYaml(fpath);
    } catch (e) {
      return bot.sendMessage(chatId, "❌ " + e.message);
    }
    if (!(key in config)) return bot.sendMessage(chatId, "❌ Ключ не найден");

    const currentValue = config[key];
    const typeName =
      currentValue === null
        ? "null/число/строка"
        : Array.isArray(currentValue)
        ? "список (через запятую или JSON)"
        : typeof currentValue;

    // Подсказка по типу
    let hint = "";
    if (typeof currentValue === "boolean") hint = "Введите: `true` или `false`";
    else if (typeof currentValue === "number")
      hint = "Введите число (например: `0.01`)";
    else if (Array.isArray(currentValue))
      hint =
        'Введите через запятую: `BTC-USDT, ETH-USDT`\nили JSON: `["BTC-USDT","ETH-USDT"]`';
    else hint = "Введите строку (кавычки не нужны)";

    _cfgEdit[chatId] = { fname, key, currentValue, filePath: fpath, msgId };

    await bot.sendMessage(
      chatId,
      `✏️ *${mdEsc(
        fname
      )}*\n\nРедактирование: \`${key}\`\nТекущее значение: ${fmtVal(
        currentValue
      )}\nТип: _${typeName}_\n\n${hint}\n\n_Отправьте новое значение или_ /cancel`,
      { parse_mode: "Markdown" }
    );
    return;
  }
});

// Обработчик ввода нового значения для конфига (встроен в message handler)
// Добавляем через отдельный listener чтобы не трогать основной handler
bot.on("message", async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const text = (msg.text || "").trim();
  const state = _cfgEdit[CHAT_ID];
  if (!state) return;
  if (text.startsWith("/")) {
    if (text === "/cancel") {
      delete _cfgEdit[CHAT_ID];
      bot.sendMessage(CHAT_ID, "❌ Редактирование отменено.", {
        reply_markup: { remove_keyboard: true },
      });
    }
    return;
  }

  delete _cfgEdit[CHAT_ID];

  try {
    const config = readYaml(state.filePath);
    const newValue = parseConfigValue(text, state.currentValue);

    if (JSON.stringify(newValue) === JSON.stringify(state.currentValue)) {
      bot.sendMessage(CHAT_ID, "ℹ️ Значение не изменилось.");
      await showConfigEditor(CHAT_ID, state.filePath, null);
      return;
    }

    config[state.key] = newValue;
    writeYaml(state.filePath, config);

    const m = await bot.sendMessage(
      CHAT_ID,
      `✅ *Сохранено*\n\n\`${state.key}\`: ${fmtVal(
        state.currentValue
      )} → ${fmtVal(newValue)}\n\nФайл: \`${state.fname}\``,
      { parse_mode: "Markdown" }
    );
    // Показываем обновлённый файл
    await showConfigEditor(CHAT_ID, state.filePath, null);
  } catch (e) {
    bot.sendMessage(
      CHAT_ID,
      `❌ *Ошибка:* ${mdEsc(e.message)}\n\nПопробуйте ещё раз или /cancel`,
      { parse_mode: "Markdown" }
    );
    // Возвращаем состояние редактирования
    _cfgEdit[CHAT_ID] = state;
  }
});

// === Запуск ===
(async () => {
  console.log("🤖 Алгоритм готов к запуску.");
  try {
    const ok = await loadBots();
    if (ok && Object.keys(_bots).length) {
      console.log("✅ Боты загружены: " + Object.keys(_bots).join(", "));
    }
  } catch (e) {
    console.log("⚠️ agentwxo-api недоступен при старте:", e.message);
  }
  sendMainMenu(CHAT_ID);
})();

// === Главное меню ===

const MENU_TITLE = {
  ru: "🤖 *AI Binance by AgentWXO*\nВыберите раздел:",
  en: "🤖 *AI Binance by AgentWXO*\nChoose a section:",
  zh: "🤖 *AI Binance by AgentWXO*\n选择一个部分:",
  ja: "🤖 *AI Binance by AgentWXO*\nセクションを選択:",
  es: "🤖 *AI Binance by AgentWXO*\nElige una sección:",
  tr: "🤖 *AI Binance by AgentWXO*\nBir bölüm seçin:",
  vi: "🤖 *AI Binance by AgentWXO*\nChọn một mục:",
  ko: "🤖 *AI Binance by AgentWXO*\n섹션 선택:",
  ar: "🤖 *AI Binance by AgentWXO*\nاختر قسمًا:",
  hi: "🤖 *AI Binance by AgentWXO*\nएक अनुभाग चुनें:",
  fr: "🤖 *AI Binance by AgentWXO*\nChoisissez une section:",
  de: "🤖 *AI Binance by AgentWXO*\nWählen Sie einen Bereich:",
  pt: "🤖 *AI Binance by AgentWXO*\nEscolha uma seção:",
};

// Переводы кнопок главного меню
const MENU_BUTTONS = {
  ru: {
    bots: "🤖 Боты",
    newbot: "🚀 Новый бот",
    balance: "💰 Баланс",
    portfolio: "📊 Портфолио",
    exchanges: "🔌 Биржи",
    configs: "⚙️ Конфиги",
    language: "🌐 Язык",
    help: "📚 Помощь",
  },
  en: {
    bots: "🤖 Bots",
    newbot: "🚀 New Bot",
    balance: "💰 Balance",
    portfolio: "📊 Portfolio",
    exchanges: "🔌 Exchanges",
    configs: "⚙️ Configs",
    language: "🌐 Language",
    help: "📚 Help",
  },
  zh: {
    bots: "🤖 机器人",
    newbot: "🚀 新建机器人",
    balance: "💰 余额",
    portfolio: "📊 投资组合",
    exchanges: "🔌 交易所",
    configs: "⚙️ 配置",
    language: "🌐 语言",
    help: "📚 帮助",
  },
  ja: {
    bots: "🤖 ボット",
    newbot: "🚀 新規ボット",
    balance: "💰 残高",
    portfolio: "📊 ポートフォリオ",
    exchanges: "🔌 取引所",
    configs: "⚙️ 設定",
    language: "🌐 言語",
    help: "📚 ヘルプ",
  },
  es: {
    bots: "🤖 Bots",
    newbot: "🚀 Nuevo Bot",
    balance: "💰 Balance",
    portfolio: "📊 Cartera",
    exchanges: "🔌 Exchanges",
    configs: "⚙️ Configs",
    language: "🌐 Idioma",
    help: "📚 Ayuda",
  },
  tr: {
    bots: "🤖 Botlar",
    newbot: "🚀 Yeni Bot",
    balance: "💰 Bakiye",
    portfolio: "📊 Portföy",
    exchanges: "🔌 Borsalar",
    configs: "⚙️ Yapılandırma",
    language: "🌐 Dil",
    help: "📚 Yardım",
  },
  vi: {
    bots: "🤖 Bots",
    newbot: "🚀 Bot Mới",
    balance: "💰 Số dư",
    portfolio: "📊 Danh mục",
    exchanges: "🔌 Sàn giao dịch",
    configs: "⚙️ Cấu hình",
    language: "🌐 Ngôn ngữ",
    help: "📚 Trợ giúp",
  },
  ko: {
    bots: "🤖 봇",
    newbot: "🚀 새 봇",
    balance: "💰 잔액",
    portfolio: "📊 포트폴리오",
    exchanges: "🔌 거래소",
    configs: "⚙️ 설정",
    language: "🌐 언어",
    help: "📚 도움말",
  },
  ar: {
    bots: "🤖 الروبوتات",
    newbot: "🚀 روبوت جديد",
    balance: "💰 الرصيد",
    portfolio: "📊 المحفظة",
    exchanges: "🔌 البورصات",
    configs: "⚙️ الإعدادات",
    language: "🌐 اللغة",
    help: "📚 المساعدة",
  },
  hi: {
    bots: "🤖 बॉट्स",
    newbot: "🚀 नया बॉट",
    balance: "💰 बैलेंस",
    portfolio: "📊 पोर्टफोलियो",
    exchanges: "🔌 एक्सचेंज",
    configs: "⚙️ कॉन्फिग",
    language: "🌐 भाषा",
    help: "📚 सहायता",
  },
  fr: {
    bots: "🤖 Bots",
    newbot: "🚀 Nouveau Bot",
    balance: "💰 Solde",
    portfolio: "📊 Portefeuille",
    exchanges: "🔌 Échanges",
    configs: "⚙️ Configs",
    language: "🌐 Langue",
    help: "📚 Aide",
  },
  de: {
    bots: "🤖 Bots",
    newbot: "🚀 Neuer Bot",
    balance: "💰 Guthaben",
    portfolio: "📊 Portfolio",
    exchanges: "🔌 Börsen",
    configs: "⚙️ Konfiguration",
    language: "🌐 Sprache",
    help: "📚 Hilfe",
  },
  pt: {
    bots: "🤖 Bots",
    newbot: "🚀 Novo Bot",
    balance: "💰 Saldo",
    portfolio: "📊 Portfólio",
    exchanges: "🔌 Exchanges",
    configs: "⚙️ Configs",
    language: "🌐 Idioma",
    help: "📚 Ajuda",
  },
};

// Вспомогательная: кнопка "🏠 Главное меню" на текущем языке
function btnMainMenu() {
  return { text: ui("main_menu"), callback_data: "main_menu" };
}

function sendMainMenu(chatId) {
  const title = MENU_TITLE[userLang] || MENU_TITLE.en;
  const b = MENU_BUTTONS[userLang] || MENU_BUTTONS.en;
  bot.sendMessage(chatId, title, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: b.bots, callback_data: "bots_list" },
          { text: b.newbot, callback_data: "bots_new" },
        ],
        [
          { text: b.balance, callback_data: "menu:balance" },
          { text: b.portfolio, callback_data: "menu:portfolio" },
        ],
        [
          { text: b.exchanges, callback_data: "ex:list" },
          { text: b.configs, callback_data: "cfg:list" },
        ],
        [
          { text: b.language, callback_data: "menu:language" },
          { text: b.help, callback_data: "menu:help" },
        ],
      ],
    },
  });
}

// Кнопки главного меню (balance, portfolio, language, help)
bot.on("callback_query", async (query) => {
  if (query.message.chat.id.toString() !== CHAT_ID) return;
  const data = query.data || "";
  const chatId = query.message.chat.id.toString();
  const msgId = query.message.message_id;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  if (!data.startsWith("menu:")) return;

  if (data === "menu:balance") {
    // Повторяем логику /balance
    const m = await bot.sendMessage(CHAT_ID, "💰 Загружаю балансы...");
    try {
      let data2 = await hbot("POST", "/portfolio/state", {
        account_name: "master_account",
      });
      if (!data2 || data2.detail || data2._raw)
        data2 = await hbot("GET", "/portfolio/distribution");
      if (!data2 || data2.detail || data2._raw) {
        return bot.editMessageText(
          "⚠️ Баланс недоступен. Проверьте /exchanges",
          { chat_id: CHAT_ID, message_id: m.message_id }
        );
      }
      const payload = data2.data || data2;
      let text = "💰 *Балансы:*\n\n";
      let hasAny = false;
      const accounts = payload.master_account
        ? payload
        : { master_account: payload };
      for (const [acc, exchanges] of Object.entries(accounts)) {
        if (typeof exchanges !== "object") continue;
        for (const [exch, tokens] of Object.entries(exchanges)) {
          if (!Array.isArray(tokens)) continue;
          const nonZero = tokens.filter(
            (t) => +(t.value || t.units || 0) > 0.001
          );
          if (!nonZero.length) continue;
          hasAny = true;
          text += `*${exch.toUpperCase()}*\n`;
          nonZero.forEach((tk) => {
            text += `  ${tk.token}: \`${(+tk.units).toFixed(
              4
            )}\` ≈ \`${(+tk.value).toFixed(2)}\` USD\n`;
          });
          text += "\n";
        }
      }
      if (!hasAny) text += "_Нет активов_";
      await bot.editMessageText(text, {
        chat_id: CHAT_ID,
        message_id: m.message_id,
        parse_mode: "Markdown",
      });
    } catch (e) {
      bot.editMessageText("❌ " + e.message, {
        chat_id: CHAT_ID,
        message_id: m.message_id,
      });
    }
    return;
  }

  if (data === "menu:portfolio") {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    simulateCommand(chatId, "/portfolio");
    return;
  }

  if (data === "menu:language") {
    bot.sendMessage(CHAT_ID, "🌐 Выберите язык / Choose language:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🇷🇺 Русский", callback_data: "lang_ru" },
            { text: "🇺🇸 English", callback_data: "lang_en" },
          ],
          [
            { text: "🇨🇳 中文", callback_data: "lang_zh" },
            { text: "🇯🇵 日本語", callback_data: "lang_ja" },
          ],
          [
            { text: "🇪🇸 Español", callback_data: "lang_es" },
            { text: "🇹🇷 Türkçe", callback_data: "lang_tr" },
          ],
          [
            { text: "🇻🇳 Tiếng Việt", callback_data: "lang_vi" },
            { text: "🇰🇷 한국어", callback_data: "lang_ko" },
          ],
          [
            { text: "🇸🇦 العربية", callback_data: "lang_ar" },
            { text: "🇮🇳 हिंदी", callback_data: "lang_hi" },
          ],
          [
            { text: "🇫🇷 Français", callback_data: "lang_fr" },
            { text: "🇩🇪 Deutsch", callback_data: "lang_de" },
          ],
          [{ text: "🇧🇷 Português", callback_data: "lang_pt" }],
        ],
      },
    });
    return;
  }

  if (data === "menu:help") {
    const helpText = {
      ru: "📚 *Документация*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n*Команды:*\n 📜 /menu\n🤖 /bots — список ботов\n🚀 /newbot — создать бота\n💰 /balance — балансы\n📊 /portfolio — портфолио\n🔌 /exchanges — биржи\n⚙️ /configs — конфиги\n🌐 /language — язык",
      en: "📚 *Documentation*\nhttps://trade.coinmarketfacts.com/docv2.html\n\n*Commands:*\n 📜 /menu\n🤖 /bots — bot list\n🚀 /newbot — create bot\n💰 /balance — balances\n📊 /portfolio — portfolio\n🔌 /exchanges — exchanges\n⚙️ /configs — configs\n🌐 /language — language",
      zh: "📚 *文档*\nhttps://trade.coinmarketfacts.com/docv2.html",
      ja: "📚 *ドキュメント*\nhttps://trade.coinmarketfacts.com/docv2.html",
      es: "📚 *Documentación*\nhttps://trade.coinmarketfacts.com/docv2.html",
      tr: "📚 *Dokümantasyon*\nhttps://trade.coinmarketfacts.com/docv2.html",
      vi: "📚 *Tài liệu*\nhttps://trade.coinmarketfacts.com/docv2.html",
      ko: "📚 *문서*\nhttps://trade.coinmarketfacts.com/docv2.html",
      ar: "📚 *الوثائق*\nhttps://trade.coinmarketfacts.com/docv2.html",
      hi: "📚 *दस्तावेज़ीकरण*\nhttps://trade.coinmarketfacts.com/docv2.html",
      fr: "📚 *Documentation*\nhttps://trade.coinmarketfacts.com/docv2.html",
      de: "📚 *Dokumentation*\nhttps://trade.coinmarketfacts.com/docv2.html",
      pt: "📚 *Documentação*\nhttps://trade.coinmarketfacts.com/docv2.html",
    };
    bot.sendMessage(CHAT_ID, helpText[userLang] || helpText.en, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    return;
  }
});
