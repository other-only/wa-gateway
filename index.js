const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const app = express();
app.use(express.json());

let sock;
let qrDynamic;
let connectionState = 'disconnected';
let retryCount = 0;
let maxRetries = 6;
let retryInterval = 5000; // 5 seconds
let systemEnabled = true; // Status sistem send WA

// Fungsi untuk cleanup socket lama
function cleanup() {
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end();
        } catch (error) {
            console.log('Cleanup error:', error.message);
        }
        sock = null;
    }
}

// Fungsi untuk auto restart session jika bermasalah
async function autoRestartSession() {
    retryCount++;
    console.log(`🔍 Auto restart attempt ${retryCount}/${maxRetries}`);
    
    if (retryCount >= maxRetries) {
        console.log('❌ Max retry attempts reached. Clearing session and restarting...');
        
        // Clear session otomatis
        cleanup();
        if (fs.existsSync('session')) {
            fs.rmSync('session', { recursive: true, force: true });
            console.log('🗑️ Session folder cleared automatically');
        }
        
        // Reset retry count
        retryCount = 0;
        
        // Restart dengan session baru
        setTimeout(() => {
            console.log('🔄 Starting fresh connection...');
            connectToWhatsApp();
        }, 3000);
        
        return;
    }
    
    // Tunggu sebentar lalu coba lagi
    setTimeout(() => {
        connectToWhatsApp();
    }, retryInterval);
}

// Fungsi untuk check health connection
function checkConnectionHealth() {
    if (sock && connectionState === 'connected') {
        return true;
    }
    return false;
}

// Fungsi untuk reset retry count saat berhasil connect
function resetRetryCount() {
    if (retryCount > 0) {
        console.log(`✅ Connection restored after ${retryCount} attempts`);
        retryCount = 0;
    }
}

// Fungsi untuk memulai koneksi WhatsApp
async function connectToWhatsApp() {
    if (connectionState === 'connecting') {
        console.log('Already connecting, please wait...');
        return;
    }
    
    console.log('🔄 Starting WhatsApp connection...');
    connectionState = 'connecting';
    
    // Cleanup connection lama
    cleanup();
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState('session');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            defaultQueryTimeoutMs: 60000,
        });
        
        // Event listener untuk update koneksi
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('\n=== SCAN QR CODE ===');
                qrcode.generate(qr, { small: true });
                qrDynamic = qr;
            }
            
            if (connection === 'close') {
                connectionState = 'disconnected';
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.log('❌ Connection closed with code:', statusCode);
                
                // Cleanup socket yang terputus
                cleanup();
                
                // Handling reconnection berdasarkan status code dengan auto restart
                if (statusCode === DisconnectReason.badSession) {
                    console.log('❌ Bad session detected, will auto-restart after 6 attempts');
                    autoRestartSession();
                } else if (statusCode === DisconnectReason.connectionClosed) {
                    console.log('🔄 Connection closed, attempting reconnect...');
                    autoRestartSession();
                } else if (statusCode === DisconnectReason.connectionLost) {
                    console.log('🔄 Connection lost, attempting reconnect...');
                    autoRestartSession();
                } else if (statusCode === DisconnectReason.connectionReplaced) {
                    console.log('❌ Connection replaced by another session');
                    autoRestartSession();
                } else if (statusCode === DisconnectReason.loggedOut) {
                    console.log('❌ Device logged out, will clear session after 6 attempts');
                    autoRestartSession();
                } else if (statusCode === DisconnectReason.restartRequired) {
                    console.log('🔄 Restart required, attempting reconnect...');
                    autoRestartSession();
                } else if (statusCode === DisconnectReason.timedOut) {
                    console.log('🔄 Connection timed out, attempting reconnect...');
                    autoRestartSession();
                } else {
                    console.log('🔄 Unknown error, attempting reconnect...');
                    autoRestartSession();
                }
            } else if (connection === 'open') {
                connectionState = 'connected';
                console.log('✅ WhatsApp Connected Successfully!');
                console.log('📱 Connected as:', sock.user.id);
                qrDynamic = null;
                
                // Reset retry count saat berhasil connect
                resetRetryCount();
            } else if (connection === 'connecting') {
                console.log('🔄 Connecting to WhatsApp...');
            }
        });
        
        // Event listener untuk update credentials
        sock.ev.on('creds.update', saveCreds);
        
        // Event listener untuk pesan masuk (untuk kontrol stop/start)
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const message = m.messages[0];
                if (!message.message) return;
                
                const messageText = message.message.conversation || 
                                  message.message.extendedTextMessage?.text || '';
                const fromJid = message.key.remoteJid;
                const fromUser = message.key.participant || message.key.remoteJid;
                const isGroup = fromJid.includes('@g.us');
                const myNumber = sock.user.id.split(':')[0];
                
                // Cek apakah ini pesan dari bot sendiri (skip)
                if (message.key.fromMe) return;
                
                let shouldProcess = false;
                let responseTarget = fromJid;
                let cleanMessage = messageText.toLowerCase().trim();
                
                // Scenario 1: Private message langsung
                if (!isGroup) {
                    shouldProcess = true;
                    responseTarget = fromJid;
                    console.log(`📱 Private message dari ${fromUser}: ${messageText}`);
                }
                
                // Scenario 2: Mention/tag di grup (termasuk grup control)
                if (isGroup) {
                    // Cek apakah ada mention ke bot
                    const mentioned = message.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const isMentioned = mentioned.some(jid => jid.includes(myNumber));
                    
                    if (isMentioned) {
                        shouldProcess = true;
                        responseTarget = fromJid; // Reply ke grup
                        
                        // Bersihkan message dari mention
                        cleanMessage = messageText.replace(/@\d+/g, '').toLowerCase().trim();
                        console.log(`👥 Mentioned di grup ${fromJid} oleh ${fromUser}: ${cleanMessage}`);
                    }
                }
                
                // Proses perintah jika memenuhi kondisi
                if (shouldProcess) {
                    const command = cleanMessage;
                    
                    if (command === 'stop') {
                        systemEnabled = false;
                        console.log(`🛑 Sistem STOP oleh: ${fromUser}`);
                        
                        const responseText = '🛑 *SISTEM SEND WA DIHENTIKAN*\n\n' +
                                           'Semua pengiriman pesan telah dihentikan.\n' +
                                           'Ketik "START" untuk mengaktifkan kembali sistem.';
                        
                        await sock.sendMessage(responseTarget, { text: responseText });
                        
                    } else if (command === 'start') {
                        systemEnabled = true;
                        console.log(`✅ Sistem START oleh: ${fromUser}`);
                        
                        const responseText = '✅ *SISTEM SEND WA DIAKTIFKAN*\n\n' +
                                           'Semua pengiriman pesan sudah aktif kembali.\n' +
                                           'Sistem siap menerima request.';
                        
                        await sock.sendMessage(responseTarget, { text: responseText });
                        
                    } else if (command === 'status') {
                        const statusIcon = systemEnabled ? '✅' : '🛑';
                        const statusText = systemEnabled ? 'AKTIF' : 'NONAKTIF';
                        const connectionIcon = connectionState === 'connected' ? '🟢' : '🔴';
                        const connectionText = connectionState === 'connected' ? 'Tersambung' : 'Terputus';
                        
                        const responseText = `📊 *STATUS SISTEM WA GATEWAY*\n\n` +
                                           `${statusIcon} Status Sistem: *${statusText}*\n` +
                                           `${connectionIcon} Koneksi WA: *${connectionText}*\n` +
                                           `🔄 Retry Count: ${retryCount}/${maxRetries}\n` +
                                           `🤖 User: ${sock.user?.id || 'Not connected'}\n\n` +
                                           `*Perintah tersedia:*\n` +
                                           `• STOP - Hentikan sistem\n` +
                                           `• START - Aktifkan sistem\n` +
                                           `• STATUS - Cek status\n\n` +
                                           `_Kirim pesan private atau mention saya di grup_`;
                        
                        await sock.sendMessage(responseTarget, { text: responseText });
                        
                    } else if (command === 'help' || command === 'menu') {
                        const helpText = `🤖 *WA GATEWAY BOT COMMANDS*\n\n` +
                                       `*Kontrol Sistem:*\n` +
                                       `• START - Aktifkan sistem send WA\n` +
                                       `• STOP - Hentikan sistem send WA\n` +
                                       `• STATUS - Lihat status sistem\n` +
                                       `• HELP - Tampilkan menu ini\n\n` +
                                       `*Cara Penggunaan:*\n` +
                                       `1. Kirim pesan private ke bot\n` +
                                       `2. Mention/tag bot di grup dengan perintah\n\n` +
                                       `*Contoh:* @${myNumber} status\n\n` +
                                       `_Bot akan merespon sesuai perintah yang diberikan_`;
                        
                        await sock.sendMessage(responseTarget, { text: helpText });
                    }
                }
                
            } catch (error) {
                console.error('Error processing message:', error);
            }
        });
        
    } catch (error) {
        connectionState = 'disconnected';
        console.error('❌ Error in connectToWhatsApp:', error.message);
        cleanup();
        console.log('🔄 Error occurred, attempting auto restart...');
        autoRestartSession();
    }
}

// Endpoint untuk mengirim pesan ke nomor biasa
app.get('/send-message', async (req, res) => {
    if (!systemEnabled) {
        return res.status(500).json({ success: false, error: 'Sistem belum diaktifkan' });
    }
    try {
        // Cek apakah sistem diaktifkan
        const { number, message } = req.query;
        
        if (!number || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Parameter number dan message wajib diisi',
                example: '/send-message?number=6281234567890&message=Halo%20dari%20API'
            });
        }
        
        if (!sock || connectionState !== 'connected') {
            return res.status(500).json({ success: false, error: 'WhatsApp belum terkoneksi' });
        }
        
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        await sock.sendMessage(jid, { text: decodeURIComponent(message) });
        
        console.log(`✅ Pesan terkirim ke ${number}: ${decodeURIComponent(message)}`);
        
        res.json({ 
            success: true, 
            message: 'Pesan berhasil dikirim',
            to: number,
            text: decodeURIComponent(message),
            systemEnabled: systemEnabled
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint untuk mengirim pesan ke grup
app.get('/send-group-message', async (req, res) => {
    if (!systemEnabled) {
        return res.status(500).json({ success: false, error: 'Sistem belum diaktifkan' });
    }
    try {
        const { groupId, message } = req.query;
        
        if (!groupId || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Parameter groupId dan message wajib diisi',
                example: '/send-group-message?groupId=120363123456789012@g.us&message=Halo%20grup'
            });
        }
        
        if (!sock || connectionState !== 'connected') {
            return res.status(500).json({ success: false, error: 'WhatsApp belum terkoneksi' });
        }
        
        const jid = groupId.includes('@g.us') ? groupId : `${groupId}@g.us`;
        
        await sock.sendMessage(jid, { text: decodeURIComponent(message) });
        
        res.json({ 
            success: true, 
            message: 'Pesan grup berhasil dikirim',
            to: groupId,
            text: decodeURIComponent(message)
        });
    } catch (error) {
        console.error('Error sending group message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint untuk melihat list grup
app.get('/groups', async (req, res) => {
    if (!systemEnabled) {
        return res.status(500).json({ success: false, error: 'Sistem belum diaktifkan' });
    }
    try {
        if (!sock || connectionState !== 'connected') {
            return res.status(500).json({ success: false, error: 'WhatsApp belum terkoneksi' });
        }
        
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(group => ({
            id: group.id,
            name: group.subject,
            participants: group.participants.length
        }));
        
        res.json({ success: true, groups: groupList });
    } catch (error) {
        console.error('Error fetching groups:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint untuk cek status koneksi
app.get('/status', (req, res) => {
    const isConnected = sock && connectionState === 'connected';
    res.json({
        success: true,
        connected: isConnected,
        connectionState: connectionState,
        systemEnabled: systemEnabled,
        retryCount: retryCount,
        maxRetries: maxRetries,
        user: isConnected ? sock.user : null
    });
});

// Endpoint untuk mendapatkan QR code jika diperlukan
app.get('/qr', (req, res) => {
    if (qrDynamic) {
        res.json({ success: true, qr: qrDynamic });
    } else {
        res.json({ success: false, message: 'QR code tidak tersedia' });
    }
});

// Endpoint untuk restart koneksi manual
app.get('/restart', (req, res) => {
    if (!systemEnabled) {
        return res.status(500).json({ success: false, error: 'Sistem belum diaktifkan' });
    }
    try {
        console.log('🔄 Manual restart requested...');
        cleanup();
        connectionState = 'disconnected';
        retryCount = 0; // Reset retry count untuk manual restart
        
        setTimeout(() => {
            connectToWhatsApp();
        }, 2000);
        
        res.json({ success: true, message: 'Koneksi restart dimulai', retryCount: 0 });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint untuk clear session
app.get('/clear-session', (req, res) => {
    if (!systemEnabled) {
        return res.status(500).json({ success: false, error: 'Sistem belum diaktifkan' });
    }
    try {
        cleanup();
        connectionState = 'disconnected';
        retryCount = 0; // Reset retry count
        
        // Hapus folder session
        if (fs.existsSync('session')) {
            fs.rmSync('session', { recursive: true, force: true });
            console.log('📁 Session folder cleared manually');
        }
        
        res.json({ 
            success: true, 
            message: 'Session cleared, akan restart otomatis dalam 3 detik',
            retryCount: 0
        });
        
        // Auto restart setelah clear session
        setTimeout(() => {
            console.log('🔄 Auto restarting after session clear...');
            connectToWhatsApp();
        }, 3000);
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint untuk reset retry count
app.get('/reset-retry', (req, res) => {
    if (!systemEnabled) {
        return res.status(500).json({ success: false, error: 'Sistem belum diaktifkan' });
    }
    try {
        const oldRetryCount = retryCount;
        retryCount = 0;
        
        res.json({ 
            success: true, 
            message: 'Retry count reset',
            oldRetryCount: oldRetryCount,
            newRetryCount: retryCount
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint untuk health check dengan auto restart
app.get('/health', (req, res) => {
    const isHealthy = checkConnectionHealth();
    
    res.json({
        success: true,
        healthy: isHealthy,
        connectionState: connectionState,
        systemEnabled: systemEnabled,
        retryCount: retryCount,
        maxRetries: maxRetries,
        nextRetryIn: isHealthy ? null : `${retryInterval/1000} seconds`,
        autoRestartEnabled: true
    });
});

// Endpoint untuk enable/disable sistem manual
app.get('/system-control', (req, res) => {
    try {
        const { action } = req.query;
        
        if (!action) {
            return res.status(400).json({
                success: false,
                error: 'Parameter action wajib diisi (start/stop/status)',
                example: '/system-control?action=stop'
            });
        }
        
        const command = action.toLowerCase();
        
        if (command === 'stop') {
            systemEnabled = false;
            console.log('🛑 Sistem STOP via API');
            
            res.json({
                success: true,
                message: 'Sistem send WA dihentikan via API',
                systemEnabled: systemEnabled,
                controlledBy: 'API'
            });
            
        } else if (command === 'start') {
            systemEnabled = true;
            console.log('✅ Sistem START via API');
            
            res.json({
                success: true,
                message: 'Sistem send WA diaktifkan via API',
                systemEnabled: systemEnabled,
                controlledBy: 'API'
            });
            
        } else if (command === 'status') {
            res.json({
                success: true,
                systemEnabled: systemEnabled,
                controlGroupId: controlGroupId,
                connectionState: connectionState,
                message: `Sistem saat ini ${systemEnabled ? 'AKTIF' : 'NONAKTIF'}`
            });
            
        } else {
            res.status(400).json({
                success: false,
                error: 'Action tidak valid. Gunakan: start, stop, atau status'
            });
        }
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
    console.log('\n📋 Endpoints yang tersedia:');
    console.log(`GET  http://localhost:${PORT}/send-message?number=6281234567890&message=Halo - Kirim pesan ke nomor`);
    console.log(`GET  http://localhost:${PORT}/send-group-message?groupId=120363123456789012@g.us&message=Halo - Kirim pesan ke grup`);
    console.log(`GET  http://localhost:${PORT}/groups - Lihat list grup`);
    console.log(`GET  http://localhost:${PORT}/status - Cek status koneksi & sistem`);
    console.log(`GET  http://localhost:${PORT}/health - Health check dengan auto restart info`);
    console.log(`GET  http://localhost:${PORT}/system-control?action=stop/start/status - Kontrol sistem manual`);
    console.log(`GET  http://localhost:${PORT}/qr - Dapatkan QR code`);
    console.log(`GET  http://localhost:${PORT}/restart - Restart koneksi`);
    console.log(`GET  http://localhost:${PORT}/clear-session - Clear session`);
    console.log(`GET  http://localhost:${PORT}/reset-retry - Reset retry counter\n`);
    console.log('🔧 Auto Restart Feature: Session akan otomatis di-clear dan restart setelah 6x gagal connect');
    console.log('⏱️  Retry Interval: 5 detik antar attempt');
    console.log('🤖 Bot Control: Kirim pesan private atau mention bot dengan STOP/START/STATUS/HELP');
    console.log('📱 Bot Commands: Private message atau @mention di grup dengan perintah\n');
    
    // Mulai koneksi WhatsApp
    connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    cleanup();
    process.exit(0);
});