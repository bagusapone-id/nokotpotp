const { Telegraf, Markup } = require('telegraf');

// Masukkan token bot kamu di sini
const bot = new Telegraf('8949771712:AAEOpOX51_jcFiujwDBZIZCjPqZTrJP3ebI');

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
        `Selamat datang di Panel Bot Interaktif Kamu.\n` +
        `Silakan pilih menu di bawah ini untuk mulai:`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📦 Cek Stok Nokos', 'cek_stok')],
                [Markup.button.callback('💰 Cek Saldo', 'cek_saldo')],
                [Markup.button.url('🌐 Kunjungi Website', 'https://google.com')]
            ])
        }
    );
});

// 2. Aksi saat tombol "Cek Stok Nokos" diklik
bot.action('cek_stok', async (ctx) => {
    await ctx.answerCbQuery();
    
    const stokText = `📦 <b>STOK LAYANAN SAAT INI:</b>\n\n` +
                     `• Nokos WA Indo (Fresh): <b>15 Pcs</b> (Rp 5.000)\n` +
                     `• Nokos WA Vermet: <b>3 Pcs</b> (Rp 12.000)\n` +
                     `• Centang Biru Business: <b>Ready</b> (Rp 150.000)\n\n` +
                     `<i>Stok update secara real-time! (Update: ${new Date().toLocaleTimeString()})</i>`;

    await safeEditMessage(ctx, stokText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh Stok', 'cek_stok')],
            [Markup.button.callback('« Kembali ke Menu', 'menu_utama')]
        ])
    });
});

// 3. Aksi saat tombol "Cek Saldo" diklik
bot.action('cek_saldo', async (ctx) => {
    await ctx.answerCbQuery('Memuat data saldo...');
    
    const saldoText = `💰 <b>INFORMASI AKUN:</b>\n\n` +
                      `👤 User ID: <code>${ctx.from.id}</code>\n` +
                      `💵 Sisa Saldo: <b>Rp 45.000</b>\n\n` +
                      `Mau top-up saldo? Silakan langsung lewat web utama ya!`;

    await safeEditMessage(ctx, saldoText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('« Kembali ke Menu', 'menu_utama')]
        ])
    });
});

// 4. Tombol Kembali ke Menu Utama
bot.action('menu_utama', async (ctx) => {
    await ctx.answerCbQuery();
    
    const menuText = `🏠 <b>MENU UTAMA</b>\n\nSilakan pilih menu di bawah ini:`;

    await safeEditMessage(ctx, menuText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📦 Cek Stok Nokos', 'cek_stok')],
            [Markup.button.callback('💰 Cek Saldo', 'cek_saldo')],
            [Markup.button.url('🌐 Kunjungi Website', 'https://google.com')]
        ])
    });
});

// Jalankan bot
bot.launch();
console.log("Bot Interaktif (Anti-Crash) sedang berjalan...");

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));