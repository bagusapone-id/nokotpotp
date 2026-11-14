require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN must be set');
}
const bot = new Telegraf(botToken);

// Fungsi helper aman untuk edit pesan (mencegah error jika konten sama persis)
async function safeEditMessage(ctx, newText, extra) {
    try {
        await ctx.editMessageText(newText, extra);
    } catch (error) {
        // Abaikan error kalau pesannya emang nggak berubah
        if (error.response && error.response.error_code === 400) {
            console.log("[Info] Pesan tidak berubah, diabaikan oleh sistem.");
        } else {
            throw error; // Lempar error lain jika ada masalah serius
        }
    }
}

// 1. Perintah /start dengan Menu Utama
bot.start((ctx) => {
    const namaUser = ctx.from.first_name || 'Boss';
    
    ctx.reply(
        `Halo, <b>${namaUser}</b>! 👋\n\n` +
        `Selamat datang di NOKOTPOTP.\n` +
        `Silakan pilih menu di bawah ini untuk mulai:`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🌐 Website', 'https://google.com')]
            ])
        }
    );
});

// 4. Tombol Kembali ke Menu Utama
bot.action('menu_utama', async (ctx) => {
    await ctx.answerCbQuery();
    
    const menuText = `🏠 <b>MENU UTAMA</b>\n\nSilakan pilih menu di bawah ini:`;

    await safeEditMessage(ctx, menuText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.url('🌐 Website', 'https://google.com')]
        ])``
    });
});

if (require.main === module) {
    bot.launch();
    console.log("Bot Interaktif (Anti-Crash) sedang berjalan...");

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}