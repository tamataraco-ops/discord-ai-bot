require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
const extractModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const conversationHistory = new Map();
const MAX_HISTORY = 10;

// サーバー内検索
async function searchServerMessages(guild, keyword, channelKeyword = null, excludeMessageId = null, limit = 15) {
  const results = [];
  let channels = guild.channels.cache.filter(
    (ch) => ch.isTextBased() && ch.viewable
  );

  // チャンネル名絞り込み
  if (channelKeyword) {
    const filtered = channels.filter((ch) =>
      ch.name.toLowerCase().includes(channelKeyword.toLowerCase())
    );
    if (filtered.size > 0) channels = filtered;
  }

  for (const [, channel] of channels) {
    try {
      const messages = await channel.messages.fetch({ limit: 100 });
      const matched = keyword
        ? messages.filter((msg) =>
            msg.id !== excludeMessageId &&
            msg.content.toLowerCase().includes(keyword.toLowerCase())
          )
        : messages.filter((msg) => msg.id !== excludeMessageId);

      matched.forEach((msg) => {
        results.push({
          channel: channel.name,
          author: msg.author.username,
          content: msg.content,
          timestamp: msg.createdAt.toLocaleString('ja-JP'),
          createdAt: msg.createdAt,
        });
      });
    } catch {
      // 権限なしはスキップ
    }
    if (results.length >= limit * 5) break;
  }

  return results
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

// キーワード抽出
async function extractSearchInfo(userMessage) {
  try {
    const prompt = `以下のDiscordへの質問から、検索に必要な情報を抽出してください。
必ずJSONのみを返してください。\`\`\`json等のマークダウン記法は使わないでください。

抽出する項目:
- keyword: メッセージ本文の検索キーワード（人名・固有名詞など1〜2語、不要なら空文字）
- channelKeyword: チャンネル名に含まれそうなキーワード（不明なら空文字）
- needSearch: 検索が必要かどうか（true/false）

例1: 「弁当注文通知のチャンネル、5/31の齋藤の注文内容教えて」
{"keyword":"齋藤","channelKeyword":"弁当注文通知","needSearch":true}

例2: 「先週のミーティングメモを探して」
{"keyword":"ミーティング","channelKeyword":"","needSearch":true}

例3: 「こんにちは」
{"keyword":"","channelKeyword":"","needSearch":false}

質問: ${userMessage}`;

    const result = await extractModel.generateContent(prompt);
    const text = result.response.text().trim().replace(/```json|```/g, '').trim();
    console.log(`[抽出rawテキスト] ${text}`);
    return JSON.parse(text);
  } catch (e) {
    console.error('[キーワード抽出エラー]', e.message);
    // フォールバック：チャンネル名らしき「」内テキストを抽出
    const channelMatch = userMessage.match(/「([^」]+)」/);
    return {
      keyword: '',
      channelKeyword: channelMatch ? channelMatch[1] : '',
      needSearch: true,
    };
  }
}

client.once('ready', () => {
  console.log(`✅ Bot起動: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const userInput = message.content.replace(/<@!?[0-9]+>/g, '').trim();
  if (!userInput) {
    await message.reply('何か聞いてください！');
    return;
  }

  await message.channel.sendTyping();

  const userId = message.author.id;
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const history = conversationHistory.get(userId);

  try {
    let searchContext = '';

    if (message.guild) {
      const searchInfo = await extractSearchInfo(userInput);
      console.log(`[検索情報]`, searchInfo);

      if (searchInfo.needSearch) {
        // 自分のメッセージIDを除外して検索
        const searchResults = await searchServerMessages(
          message.guild,
          searchInfo.keyword,
          searchInfo.channelKeyword,
          message.id
        );
        console.log(`[検索結果] ${searchResults.length}件`);
        searchResults.forEach((r, i) =>
          console.log(`  [${i+1}] #${r.channel}: ${r.content.slice(0, 100)}`)
        );

        if (searchResults.length > 0) {
          searchContext = `\n\n【サーバー内の検索結果】\n` +
            searchResults.map((r) =>
              `[#${r.channel}] ${r.author} (${r.timestamp}): ${r.content}`
            ).join('\n') +
            `\n※上記はこのDiscordサーバー内から実際に取得したメッセージです。`;
        } else {
          searchContext = `\n\n【サーバー内検索結果】該当するメッセージは見つかりませんでした。`;
        }
      }
    }

    const historyText = history.length > 0
      ? `\n\n【これまでの会話】\n` + history.map((h) =>
          `${h.role === 'user' ? 'ユーザー' : 'AI'}: ${h.content}`
        ).join('\n')
      : '';

    const prompt = `あなたはDiscordサーバーに設置されたAIアシスタントです。
このサーバーの全チャンネルを検索・参照できます。
フレンドリーで簡潔に回答してください。Markdownは最小限に。
サーバー内の情報を聞かれた場合は【サーバー内の検索結果】を必ず参照して答えてください。
「自分では検索できない」「Discordの検索機能を使ってください」と言わないでください。
検索結果にない情報は絶対に作り話しないでください。${historyText}${searchContext}

ユーザー: ${userInput}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    history.push({ role: 'user', content: userInput });
    history.push({ role: 'assistant', content: responseText });
    if (history.length > MAX_HISTORY * 2) history.splice(0, 2);

    if (responseText.length <= 2000) {
      await message.reply(responseText);
    } else {
      const chunks = responseText.match(/.{1,2000}/gs) || [];
      for (const chunk of chunks) await message.channel.send(chunk);
    }
  } catch (err) {
    console.error('エラー:', err);
    await message.reply('エラーが発生しました。しばらく待ってから再試行してください。');
  }
});

client.login(process.env.DISCORD_TOKEN);

// Render Web Service用：ポートをリッスンしてタイムアウトを防ぐ
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('OK')).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
