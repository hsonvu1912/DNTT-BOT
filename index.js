import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
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

// In-memory lock to prevent concurrent processing of same DNTT code
const processingCodes = new Set();

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
  "code",
  "created_at",
  "requester_id",
  "requester_tag",
  "source_channel_id",
  "amount",
  "purpose",
  "note",
  "proof_url",
  "status",
  "manager_tag",
  "decision_reason",
  "decision_at",
  "discord_message_id",
  "source_message_id"
];

const MONTHLY_HEADER = [
  "datetime",
  "type",
  "amount",
  "purpose",
  "requester_tag",
  "manager_tag",
  "code",
  "note",
  "proof_url"
];

async function ensureBaseSheets() {
  await ensureSheetWithHeader(REQUESTS_SHEET, REQUESTS_HEADER);
}

async function findRequestRowByCode(code) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_SHEET}!A:A`
  });
  const values = res.data.values || [];
  for (let i = 0; i < values.length; i++) {
    if (values[i]?.[0] === code) return i + 1;
  }
  return null;
}

async function readRequestRow(rowNum) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_SHEET}!A${rowNum}:O${rowNum}`
  });
  const row = (res.data.values && res.data.values[0]) ? res.data.values[0] : [];
  const obj = {};
  REQUESTS_HEADER.forEach((h, idx) => (obj[h] = row[idx] ?? ""));
  return obj;
}

async function updateRequestRow(rowNum, patchObj) {
  const current = await readRequestRow(rowNum);
  const merged = { ...current, ...patchObj };
  const out = REQUESTS_HEADER.map(h => merged[h] ?? "");
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_SHEET}!A${rowNum}:O${rowNum}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [out] }
  });
}

function memberHasManagerRole(member) {
  return member?.roles?.cache?.some(r => r.name === ROLE_MANAGER_NAME);
}

function truncateForEmbed(text, max = 950) {
  if (!text) return "-";
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function buildProofEmbeds(mainEmbed, proofUrls) {
  const url = "https://dntt.bot";
  mainEmbed.setURL(url);
  if (proofUrls.length > 0) mainEmbed.setImage(proofUrls[0]);
  const embeds = [mainEmbed];
  for (let i = 1; i < proofUrls.length; i++) {
    embeds.push(new EmbedBuilder().setURL(url).setImage(proofUrls[i]));
  }
  return embeds;
}

function parseProofUrls(proofUrlCell) {
  if (!proofUrlCell) return [];
  return proofUrlCell.split("\n").filter(Boolean);
}

async function replyEphemeral(interaction, content) {
  // flags 64 = EPHEMERAL (đỡ warning future)
  return interaction.reply({ content, flags: 64 });
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
    { name: "Hoàn tiền khách", value: "hoan_tien_khach" },
    { name: "Văn phòng", value: "van_phong" },
    { name: "Sửa chữa", value: "sua_chua" },
    { name: "Đóng gói", value: "dong_goi" },
    { name: "Marketing", value: "marketing" },
    { name: "Ship", value: "ship" },
    { name: "Nhập hàng", value: "nhap_hang" },
    { name: "Lương", value: "luong" },
    { name: "Khác", value: "khac" }
  ]
},


      // Required proof first
      { name: "proof1", type: 11, description: "Chứng từ 1 (bắt buộc)", required: true },

      // Optional proofs
      { name: "proof2", type: 11, description: "Chứng từ 2", required: false },
      { name: "proof3", type: 11, description: "Chứng từ 3", required: false },
      { name: "proof4", type: 11, description: "Chứng từ 4", required: false },
      { name: "proof5", type: 11, description: "Chứng từ 5", required: false },

      { name: "note", type: 3, description: "Ghi chú", required: false }
    ]
  }
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Guild slash commands registered.");
  } catch (e) {
    console.error("❌ Register commands failed:", e?.rawError || e);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await ensureBaseSheets();
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  try {
    // 1) Create DNTT
    if (interaction.isChatInputCommand() && interaction.commandName === "dntt") {
      console.log(`[DNTT] /dntt command received from ${interaction.user.username}`);
      // Defer ngay để Discord không timeout sau 3 giây
      await interaction.deferReply({ flags: 64 });
      console.log("[DNTT] deferReply OK");

      const amount = interaction.options.getNumber("amount");
      const purpose = interaction.options.getString("purpose");
      const note = interaction.options.getString("note") ?? "";

      const proofs = ["proof1", "proof2", "proof3", "proof4", "proof5"]
        .map((k) => interaction.options.getAttachment(k))
        .filter(Boolean);

      if (proofs.length === 0) {
        await interaction.editReply({ content: "❌ Bạn phải upload ít nhất 1 ảnh chứng từ (proof1)." });
        return;
      }

      for (const p of proofs) {
        const ct = p?.contentType || "";
        if (!ct.startsWith("image/")) {
          await interaction.editReply({ content: "❌ Tất cả chứng từ phải là **hình ảnh** (jpg/png/webp)." });
          return;
        }
      }

      const proofUrls = proofs.map(p => p.url);
      const proofUrlCell = proofUrls.join("\n"); // lưu vào sheet

      const code = makeCode();
      const requesterTag = `${interaction.user.username}#${interaction.user.discriminator}`;
      const requesterId = interaction.user.id;
      const sourceChannelId = interaction.channelId;
      const createdAt = isoNow();

      // Save pending request to sheet first (anti-restart)
      console.log(`[DNTT] Writing to sheet: ${code}, amount=${amount}, purpose=${purpose}`);
      await appendRow(REQUESTS_SHEET, [
        code,
        createdAt,
        requesterId,
        requesterTag,
        sourceChannelId,
        amount,
        purpose,
        note,
        proofUrlCell,
        "PENDING",
        "",
        "",
        "",
        "", // discord_message_id
        ""  // source_message_id
      ]);

      // Post to #dntt for manager approval
      const embed = new EmbedBuilder()
        .setTitle(`Đề nghị thanh toán (DNTT): ${code}`)
        .setColor(0xFFA500)
        .addFields(
          { name: "Số tiền", value: `${amount}`, inline: true },
          { name: "Mục đích", value: purpose, inline: true },
          { name: "Người đề nghị", value: `${requesterTag}`, inline: false },
          { name: "Channel tạo", value: `<#${sourceChannelId}>`, inline: false },
          { name: "Ghi chú", value: note || "-", inline: false }
        )
        .setFooter({ text: `Chỉ role ${ROLE_MANAGER_NAME} được duyệt/từ chối. Từ chối phải có lý do.` })
        .setTimestamp();

      const dnttEmbeds = buildProofEmbeds(embed, proofUrls);

      const approveRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve:${code}`).setLabel("Phê duyệt").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`reject:${code}`).setLabel("Từ chối").setStyle(ButtonStyle.Danger)
      );

      console.log("[DNTT] Sheet append OK");

      let dnttMsgId = "";
      try {
        const dnttChannel = await client.channels.fetch(DNTT_CHANNEL_ID);
        const msg = await dnttChannel.send({ embeds: dnttEmbeds, components: [approveRow] });
        dnttMsgId = msg.id;
        console.log(`[DNTT] Sent to DNTT channel OK, msgId=${dnttMsgId}`);
      } catch (e) {
        console.error("❌ Cannot send to DNTT channel (Missing Access?).", e?.rawError || e);
        await interaction.editReply({ content: `❌ Bot không gửi được sang <#${DNTT_CHANNEL_ID}> (thiếu quyền hoặc sai channel ID).` });
        return;
      }

      // Reply ephemeral confirmation
      await interaction.editReply({ content: `✅ Đã tạo DNTT \`${code}\` và gửi sang <#${DNTT_CHANNEL_ID}> để QUẢN LÝ duyệt.` });

      // Post preview in source channel + Withdraw button
      const previewEmbed = new EmbedBuilder()
        .setTitle(`🧾 DNTT của bạn: ${code}`)
        .setColor(0xFFA500)
        .setDescription("Trạng thái: **PENDING (chờ phê duyệt)**")
        .addFields(
          { name: "Số tiền", value: `${amount}`, inline: true },
          { name: "Mục đích", value: purpose, inline: true },
          { name: "Ghi chú", value: note || "-", inline: false }
        )
        .setFooter({ text: "Nếu bạn tạo sai, bấm THU HỒI (chỉ hiệu lực khi còn PENDING)." })
        .setTimestamp();

      const previewEmbeds = buildProofEmbeds(previewEmbed, proofUrls);

      const withdrawRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`withdraw:${code}`).setLabel("Thu hồi").setStyle(ButtonStyle.Danger)
      );

      const previewMsg = await interaction.channel.send({ embeds: previewEmbeds, components: [withdrawRow] });

      // Update discord_message_id + source_message_id in sheet
      const rowNum = await findRequestRowByCode(code);
      if (rowNum) await updateRequestRow(rowNum, { discord_message_id: dnttMsgId, source_message_id: previewMsg.id });
      return;
    }

    // 2) Buttons: approve/reject/withdraw
    if (interaction.isButton()) {
      const [action, code] = interaction.customId.split(":");

      // WITHDRAW: requester cancels pending request
      if (action === "withdraw") {
        if (processingCodes.has(code)) {
          await replyEphemeral(interaction, "⏳ DNTT này đang được xử lý, vui lòng chờ...");
          return;
        }
        processingCodes.add(code);
        try {
          await interaction.deferUpdate();

          const rowNum = await findRequestRowByCode(code);
          if (!rowNum) {
            await interaction.followUp({ content: "❌ Không tìm thấy DNTT trong Google Sheet.", flags: 64 });
            return;
          }

          const req = await readRequestRow(rowNum);

          if (req.requester_id !== interaction.user.id) {
            await interaction.followUp({ content: "❌ Bạn không phải người tạo DNTT này nên không thể thu hồi.", flags: 64 });
            return;
          }

          if (req.status !== "PENDING") {
            await interaction.followUp({ content: `❌ DNTT này đã được xử lý (status: ${req.status}) nên không thể thu hồi.`, flags: 64 });
            return;
          }

          const decisionAt = isoNow();
          await updateRequestRow(rowNum, {
            status: "WITHDRAWN",
            manager_tag: req.requester_tag,
            decision_reason: "Thu hồi bởi người tạo",
            decision_at: decisionAt
          });

          // Try disable buttons in #dntt post
          try {
            const dnttChannel = await client.channels.fetch(DNTT_CHANNEL_ID);
            const msg = await dnttChannel.messages.fetch(req.discord_message_id);
            await msg.edit({ content: `🟠 **ĐÃ THU HỒI** \`${code}\` | bởi **${req.requester_tag}**`, components: [] });
          } catch (editErr) {
            console.error(`❌ Failed to edit DNTT message for withdrawn ${code}:`, editErr);
          }

          // Disable withdraw button in preview message
          await interaction.editReply({
            content: `🟠 Bạn đã **THU HỒI** DNTT \`${code}\`.`,
            embeds: interaction.message.embeds,
            components: []
          });
        } finally {
          processingCodes.delete(code);
        }
        return;
      }

      // Approve/Reject: only manager
      if (!memberHasManagerRole(interaction.member)) {
        await replyEphemeral(interaction, `❌ Bạn không có role **${ROLE_MANAGER_NAME}** nên không được duyệt.`);
        return;
      }

      if (action === "approve") {
        if (processingCodes.has(code)) {
          await replyEphemeral(interaction, "⏳ DNTT này đang được xử lý, vui lòng chờ...");
          return;
        }
        processingCodes.add(code);
        try {
          // Defer immediately to prevent 3s timeout during sheet operations
          await interaction.deferUpdate();

          const rowNum = await findRequestRowByCode(code);
          if (!rowNum) {
            await interaction.followUp({ content: "❌ Không tìm thấy DNTT trong Google Sheet.", flags: 64 });
            return;
          }

          const req = await readRequestRow(rowNum);
          if (req.status !== "PENDING") {
            await interaction.followUp({ content: `❌ DNTT này đã được xử lý rồi (status: ${req.status}).`, flags: 64 });
            return;
          }

          const managerTag = `${interaction.user.username}#${interaction.user.discriminator}`;
          const decisionAt = isoNow();

          await updateRequestRow(rowNum, {
            status: "APPROVED",
            manager_tag: managerTag,
            decision_at: decisionAt,
            decision_reason: ""
          });

          // Write to monthly sheet
          const mSheet = monthSheetName(new Date());
          await ensureSheetWithHeader(mSheet, MONTHLY_HEADER);
          await appendRow(mSheet, [
            decisionAt,
            "CHI",
            req.amount,
            req.purpose,
            req.requester_tag,
            managerTag,
            req.code,
            req.note,
            req.proof_url
          ]);

          // Update preview message in source channel (edit instead of new message)
          try {
            const sourceChannel = await client.channels.fetch(req.source_channel_id);
            const proofUrls = parseProofUrls(req.proof_url);
            const notifyEmbed = new EmbedBuilder()
              .setTitle(`✅ DNTT \`${code}\` đã được PHÊ DUYỆT`)
              .setColor(0x00C853)
              .addFields(
                { name: "Số tiền", value: `${req.amount}`, inline: true },
                { name: "Mục đích", value: req.purpose, inline: true },
                { name: "Người duyệt", value: managerTag, inline: false },
                { name: "Ghi chú", value: req.note || "-", inline: false }
              )
              .setTimestamp();
            const notifyEmbeds = buildProofEmbeds(notifyEmbed, proofUrls);
            if (req.source_message_id) {
              const previewMsg = await sourceChannel.messages.fetch(req.source_message_id);
              await previewMsg.edit({
                content: `<@${req.requester_id}>`,
                embeds: notifyEmbeds,
                components: []
              });
            } else {
              await sourceChannel.send({
                content: `<@${req.requester_id}>`,
                embeds: notifyEmbeds
              });
            }
          } catch (notifyErr) {
            console.error(`❌ Failed to notify source channel for ${code}:`, notifyErr);
          }

          // Update #dntt message, remove buttons
          await interaction.editReply({
            content: `✅ **ĐÃ PHÊ DUYỆT** \`${code}\` | duyệt bởi **${managerTag}**`,
            components: []
          });
        } finally {
          processingCodes.delete(code);
        }
        return;
      }

      if (action === "reject") {
        if (processingCodes.has(code)) {
          await replyEphemeral(interaction, "⏳ DNTT này đang được xử lý, vui lòng chờ...");
          return;
        }
        // NOTE: Do NOT defer here — showModal requires an unacknowledged interaction
        const modal = new ModalBuilder()
          .setCustomId(`reject_modal:${code}`)
          .setTitle(`Từ chối DNTT ${code}`);

        const reasonInput = new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Lý do từ chối (bắt buộc)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(400);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
        return;
      }
    }

    // 3) Modal submit reject with mandatory reason
    if (interaction.isModalSubmit()) {
      const [tag, code] = interaction.customId.split(":");
      if (tag !== "reject_modal") return;

      if (!memberHasManagerRole(interaction.member)) {
        await replyEphemeral(interaction, `❌ Bạn không có role **${ROLE_MANAGER_NAME}** nên không được từ chối.`);
        return;
      }

      const reason = (interaction.fields.getTextInputValue("reason") || "").trim();
      if (!reason) {
        await replyEphemeral(interaction, "❌ Lý do từ chối là bắt buộc.");
        return;
      }

      if (processingCodes.has(code)) {
        await replyEphemeral(interaction, "⏳ DNTT này đang được xử lý, vui lòng chờ...");
        return;
      }
      processingCodes.add(code);
      try {
        await interaction.deferReply({ flags: 64 });

        const rowNum = await findRequestRowByCode(code);
        if (!rowNum) {
          await interaction.editReply({ content: "❌ Không tìm thấy DNTT trong Google Sheet." });
          return;
        }

        const req = await readRequestRow(rowNum);
        if (req.status !== "PENDING") {
          await interaction.editReply({ content: `❌ DNTT này đã được xử lý rồi (status: ${req.status}).` });
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

        // Update #dntt post: show reason + remove buttons
        try {
          const dnttChannel = await client.channels.fetch(DNTT_CHANNEL_ID);
          const msg = await dnttChannel.messages.fetch(req.discord_message_id);
          await msg.edit({
            content: `⛔ **ĐÃ TỪ CHỐI** \`${code}\` | bởi **${managerTag}** | Lý do: **${reason}**`,
            components: []
          });
        } catch (editErr) {
          console.error(`❌ Failed to edit DNTT message for rejected ${code}:`, editErr);
        }

        // Update preview message in source channel (edit instead of new message)
        try {
          const sourceChannel = await client.channels.fetch(req.source_channel_id);
          const proofUrls = parseProofUrls(req.proof_url);
          const rejectEmbed = new EmbedBuilder()
            .setTitle(`⛔ DNTT \`${code}\` đã BỊ TỪ CHỐI`)
            .setColor(0xD50000)
            .addFields(
              { name: "Lý do", value: reason, inline: false },
              { name: "Người từ chối", value: managerTag, inline: true },
              { name: "Số tiền", value: `${req.amount}`, inline: true },
              { name: "Mục đích", value: req.purpose, inline: true }
            )
            .setTimestamp();
          const rejectEmbeds = buildProofEmbeds(rejectEmbed, proofUrls);
          if (req.source_message_id) {
            const previewMsg = await sourceChannel.messages.fetch(req.source_message_id);
            await previewMsg.edit({
              content: `<@${req.requester_id}>`,
              embeds: rejectEmbeds,
              components: []
            });
          } else {
            await sourceChannel.send({
              content: `<@${req.requester_id}>`,
              embeds: rejectEmbeds
            });
          }
        } catch (notifyErr) {
          console.error(`❌ Failed to notify source channel for rejected ${code}:`, notifyErr);
        }

        await interaction.editReply({ content: `Đã từ chối DNTT \`${code}\` và gửi lý do về channel người đề nghị.` });
      } finally {
        processingCodes.delete(code);
      }
      return;
    }
  } catch (err) {
    console.error("❌ Unhandled interaction error:", err?.message || err);
    try {
      const errMsg = `❌ Có lỗi xảy ra: ${(err?.message || "unknown").slice(0, 200)}`;
      if (interaction.deferred) {
        // Đã defer → phải editReply để dismiss "thinking" indicator
        await interaction.editReply({ content: errMsg });
      } else if (interaction.replied) {
        await interaction.followUp({ content: errMsg, flags: 64 });
      } else {
        await interaction.reply({ content: errMsg, flags: 64 });
      }
    } catch (replyErr) {
      console.error("❌ Failed to send error message to user:", replyErr?.message || replyErr);
    }
  }
});

client.login(DISCORD_TOKEN);
