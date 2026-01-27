import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { google } from "googleapis";

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DNTT_CHANNEL_ID,
  ROLE_MANAGER_NAME = "QUẢN LÝ",
  SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  TZ = "Asia/Bangkok"
} = process.env;

function must(x, name) {
  if (!x) throw new Error(`Missing env var: ${name}`);
  return x;
}

must(DISCORD_TOKEN, "DISCORD_TOKEN");
must(DISCORD_CLIENT_ID, "DISCORD_CLIENT_ID");
must(DISCORD_GUILD_ID, "DISCORD_GUILD_ID");
must(DNTT_CHANNEL_ID, "DNTT_CHANNEL_ID");
must(SHEET_ID, "SHEET_ID");
must(GOOGLE_SERVICE_ACCOUNT_JSON, "GOOGLE_SERVICE_ACCOUNT_JSON");

const svc = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.JWT({
  email: svc.client_email,
  key: svc.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheets = google.sheets({ version: "v4", auth });

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

function isoNow() {
  return new Date().toISOString();
}
function monthSheetName(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function makeCode() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DNTT-${y}${m}${day}-${rand}`;
}

async function appendRow(sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

async function getSheetTitles() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
}

async function ensureSheetWithHeader(title, headerRow) {
  const titles = await getSheetTitles();
  if (!titles.includes(title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
    await appendRow(title, headerRow);
  }
}

const REQUESTS_SHEET = "DNTT_Requests";
const REQUESTS_HEADER = [
  "code","created_at","requester_id","requester_tag","source_channel_id",
  "amount","purpose","note","proof_url","status",
  "manager_tag","decision_reason","decision_at","discord_message_id"
];

const MONTHLY_HEADER = [
  "datetime","type","amount","purpose","requester_tag","manager_tag","code","note","proof_url"
];

async function ensureBaseSheets() {
  await ensureSheetWithHeader(REQUESTS_SHEET, REQUESTS_HEADER);
  // Không tự tạo đủ 12 tháng để tránh “tự tiện”. Khi approve sẽ ensure tháng hiện tại.
}

async function findRequestRowByCode(code) {
  // Scan cột A của DNTT_Requests
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_SHEET}!A:A`
  });
  const values = res.data.values || [];
  for (let i = 0; i < values.length; i++) {
    if (values[i]?.[0] === code) return i + 1; // row number (1-indexed)
  }
  return null;
}

async function readRequestRow(rowNum) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_SHEET}!A${rowNum}:N${rowNum}`
  });
  const row = (res.data.values && res.data.values[0]) ? res.data.values[0] : [];
  // Map theo header
  const obj = {};
  REQUESTS_HEADER.forEach((h, idx) => obj[h] = row[idx] ?? "");
  return obj;
}

async function updateRequestRow(rowNum, patchObj) {
  // Đọc row hiện tại rồi merge
  const current = await readRequestRow(rowNum);
  const merged = { ...current, ...patchObj };
  const out = REQUESTS_HEADER.map(h => merged[h] ?? "");
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_SHEET}!A${rowNum}:N${rowNum}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [out] }
  });
}

function memberHasManagerRole(member) {
  return member?.roles?.cache?.some(r => r.name === ROLE_MANAGER_NAME);
}

const commands = [
  {
    name: "dntt",
    description: "Tạo đề nghị thanh toán (CHI) để QUẢN LÝ duyệt",
    options: [
      { name: "amount", type: 10, description: "Số tiền", required: true },
      {
        name: "purpose",
        type: 3,
        description: "Mục đích",
        required: true,
        choices: [
          { name: "Marketing", value: "marketing" },
          { name: "Kho", value: "kho" },
          { name: "Ship", value: "ship" },
          { name: "Nhập hàng", value: "nhap_hang" },
          { name: "Lương", value: "luong" },
          { name: "Khác", value: "khac" }
        ]
      },
      { name: "proof", type: 11, description: "Chứng từ (hình ảnh bắt buộc)", required: true },
      { name: "note", type: 3, description: "Ghi chú", required: false }
    ]
  }
];


async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log("✅ Guild slash commands registered.");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await ensureBaseSheets();
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    // 1) Tạo DNTT
    if (interaction.isChatInputCommand() && interaction.commandName === "dntt") {
      const amount = interaction.options.getNumber("amount");
      const purpose = interaction.options.getString("purpose");
      const note = interaction.options.getString("note") ?? "";
      const proof = interaction.options.getAttachment("proof");

      // Proof bắt buộc là ảnh
      const contentType = proof?.contentType || "";
      if (!contentType.startsWith("image/")) {
        await interaction.reply({ content: "❌ Chứng từ phải là **hình ảnh** (jpg/png/webp).", ephemeral: true });
        return;
      }

      const code = makeCode();
      const requesterTag = `${interaction.user.username}#${interaction.user.discriminator}`;
      const requesterId = interaction.user.id;
      const sourceChannelId = interaction.channelId;
      const proofUrl = proof.url;
      const createdAt = isoNow();

      // Ghi vào DNTT_Requests với status PENDING trước để chống restart
      await appendRow(REQUESTS_SHEET, [
        code, createdAt, requesterId, requesterTag, sourceChannelId,
        amount, purpose, note, proofUrl, "PENDING",
        "", "", "", "" // manager_tag, decision_reason, decision_at, discord_message_id
      ]);

      // Post vào channel #dntt
      const dnttChannel = await client.channels.fetch(DNTT_CHANNEL_ID);

      const embed = new EmbedBuilder()
        .setTitle(`Đề nghị thanh toán (DNTT): ${code}`)
        .addFields(
          { name: "Số tiền", value: `${amount}`, inline: true },
          { name: "Mục đích", value: purpose, inline: true },
          { name: "Người đề nghị", value: `${requesterTag}`, inline: false },
          { name: "Channel tạo", value: `<#${sourceChannelId}>`, inline: false },
          { name: "Ghi chú", value: note || "-", inline: false },
          { name: "Chứng từ", value: proofUrl, inline: false }
        )
        .setFooter({ text: `Chỉ role ${ROLE_MANAGER_NAME} được duyệt/từ chối. Từ chối phải có lý do.` });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve:${code}`).setLabel("Phê duyệt").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`reject:${code}`).setLabel("Từ chối").setStyle(ButtonStyle.Danger)
      );

      const msg = await dnttChannel.send({ embeds: [embed], components: [row] });

      // Update discord_message_id vào sheet
      const rowNum = await findRequestRowByCode(code);
      if (rowNum) await updateRequestRow(rowNum, { discord_message_id: msg.id });

      await interaction.reply({
        content: `✅ Đã tạo DNTT \`${code}\` và gửi sang <#${DNTT_CHANNEL_ID}> để QUẢN LÝ duyệt.`,
        ephemeral: true
      });
      return;
    }

    // 2) Nút bấm Approve/Reject
    if (interaction.isButton()) {
      const [action, code] = interaction.customId.split(":");

      if (!memberHasManagerRole(interaction.member)) {
        await interaction.reply({ content: `❌ Bạn không có role **${ROLE_MANAGER_NAME}** nên không được duyệt.`, ephemeral: true });
        return;
      }

      const rowNum = await findRequestRowByCode(code);
      if (!rowNum) {
        await interaction.reply({ content: "❌ Không tìm thấy DNTT trong Google Sheet.", ephemeral: true });
        return;
      }

      const req = await readRequestRow(rowNum);
      if (req.status !== "PENDING") {
        await interaction.reply({ content: `❌ DNTT này đã được xử lý rồi (status: ${req.status}).`, ephemeral: true });
        return;
      }

      if (action === "approve") {
        const managerTag = `${interaction.user.username}#${interaction.user.discriminator}`;
        const decisionAt = isoNow();

        // Update request status
        await updateRequestRow(rowNum, {
          status: "APPROVED",
          manager_tag: managerTag,
          decision_at: decisionAt,
          decision_reason: ""
        });

        // Ensure monthly sheet + append CHI
        const mSheet = monthSheetName(new Date());
        await ensureSheetWithHeader(mSheet, MONTHLY_HEADER);

        await appendRow(mSheet, [
          decisionAt, "CHI", req.amount, req.purpose, req.requester_tag, managerTag, req.code, req.note, req.proof_url
        ]);

        // Edit message + disable buttons
        await interaction.update({
          content: `✅ **ĐÃ PHÊ DUYỆT** \`${code}\` | duyệt bởi **${managerTag}**`,
          components: []
        });

        // Notify về channel người tạo (không DM)
        const sourceChannel = await client.channels.fetch(req.source_channel_id);
        await sourceChannel.send(`✅ <@${req.requester_id}> DNTT \`${code}\` đã **PHÊ DUYỆT** bởi **${managerTag}**. Số tiền: **${req.amount}**. Mục đích: **${req.purpose}**.`);
        return;
      }

      if (action === "reject") {
        // Mở modal bắt nhập lý do
        const modal = new ModalBuilder()
          .setCustomId(`reject_modal:${code}`)
          .setTitle(`Từ chối DNTT ${code}`);

        const reasonInput = new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Lý do từ chối (bắt buộc)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(400);

        const row = new ActionRowBuilder().addComponents(reasonInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
        return;
      }
    }

    // 3) Submit modal từ chối
    if (interaction.isModalSubmit()) {
      const [tag, code] = interaction.customId.split(":");
      if (tag !== "reject_modal") return;

      if (!memberHasManagerRole(interaction.member)) {
        await interaction.reply({ content: `❌ Bạn không có role **${ROLE_MANAGER_NAME}** nên không được từ chối.`, ephemeral: true });
        return;
      }

      const reason = interaction.fields.getTextInputValue("reason")?.trim();
      if (!reason) {
        await interaction.reply({ content: "❌ Lý do từ chối là bắt buộc.", ephemeral: true });
        return;
      }

      const rowNum = await findRequestRowByCode(code);
      if (!rowNum) {
        await interaction.reply({ content: "❌ Không tìm thấy DNTT trong Google Sheet.", ephemeral: true });
        return;
      }

      const req = await readRequestRow(rowNum);
      if (req.status !== "PENDING") {
        await interaction.reply({ content: `❌ DNTT này đã được xử lý rồi (status: ${req.status}).`, ephemeral: true });
        return;
      }

      const managerTag = `${interaction.user.username}#${interaction.user.discriminator}`;
      const decisionAt = isoNow();

      await updateRequestRow(rowNum, {
        status: "REJECTED",
        manager_tag: managerTag,
        decision_at: decisionAt,
        decision_reason: reason
      });

      // Update message ở kênh DNTT nếu còn
      try {
        const dnttChannel = await client.channels.fetch(DNTT_CHANNEL_ID);
        const msg = await dnttChannel.messages.fetch(req.discord_message_id);
        await msg.edit({ content: `⛔ **ĐÃ TỪ CHỐI** \`${code}\` | bởi **${managerTag}** | Lý do: **${reason}**`, components: [] });
      } catch {}

      // Notify về channel người tạo
      try {
        const sourceChannel = await client.channels.fetch(req.source_channel_id);
        await sourceChannel.send(`⛔ <@${req.requester_id}> DNTT \`${code}\` đã **BỊ TỪ CHỐI** bởi **${managerTag}**.\nLý do: **${reason}**`);
      } catch {}

      await interaction.reply({ content: `Đã từ chối DNTT \`${code}\` và gửi lý do về channel người đề nghị.`, ephemeral: true });
      return;
    }
  } catch (err) {
    console.error(err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "Có lỗi xảy ra. Mở Railway logs để xem chi tiết.", ephemeral: true });
      } else {
        await interaction.reply({ content: "Có lỗi xảy ra. Mở Railway logs để xem chi tiết.", ephemeral: true });
      }
    } catch {}
  }
});

client.login(DISCORD_TOKEN);
