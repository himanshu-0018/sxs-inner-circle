// server/videoProcessor.js
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

// Check if FFmpeg is available
let ffmpegAvailable = false;
try {
    const { execSync } = require('child_process');
    execSync('ffmpeg -version', { stdio: 'ignore' });
    ffmpegAvailable = true;
    console.log('✅ FFmpeg is available');
} catch (e) {
    console.log('⚠️ FFmpeg not available - using direct proxy');
}

// Temp directory for HLS chunks
const TEMP_DIR = path.join(os.tmpdir(), 'sxs-hls');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// HLS session store
const hlsSessions = new Map();

// Cleanup old HLS files every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of hlsSessions.entries()) {
        if (now > session.expires) {
            // Delete temp files
            cleanupSession(session);
            hlsSessions.delete(key);
        }
    }
}, 30 * 60 * 1000);

function cleanupSession(session) {
    try {
        if (session.outputDir && fs.existsSync(session.outputDir)) {
            const files = fs.readdirSync(session.outputDir);
            files.forEach(f => {
                fs.unlinkSync(path.join(session.outputDir, f));
            });
            fs.rmdirSync(session.outputDir);
        }
    } catch (e) {
        // Silent cleanup errors
    }
}

// Download Google Drive file to temp
async function downloadToTemp(fileId, outputPath) {
    return new Promise((resolve, reject) => {
        const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

        const tryDownload = (url, redirects = 0) => {
            if (redirects > 8) {
                reject(new Error('Too many redirects'));
                return;
            }

            const protocol = url.startsWith('https') ? https : http;
            const reqHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*'
            };

            const req = protocol.get(url, { headers: reqHeaders }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const loc = res.headers.location;
                    if (loc) {
                        req.destroy();
                        res.resume();
                        tryDownload(loc, redirects + 1);
                        return;
                    }
                }

                if (res.statusCode !== 200 && res.statusCode !== 206) {
                    reject(new Error(`Bad status: ${res.statusCode}`));
                    return;
                }

                const fileStream = fs.createWriteStream(outputPath);
                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve(outputPath);
                });

                fileStream.on('error', reject);
            });

            req.on('error', reject);
            req.setTimeout(60000, () => {
                req.destroy();
                reject(new Error('Download timeout'));
            });
        };

        tryDownload(driveUrl);
    });
}

// Generate encryption key for HLS
function generateEncryptionKey() {
    return crypto.randomBytes(16);
}

// Process video to encrypted HLS
async function processToHLS(fileId, sessionId) {
    if (!ffmpegAvailable) {
        return { success: false, reason: 'ffmpeg_unavailable' };
    }

    const outputDir = path.join(TEMP_DIR, sessionId);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate encryption key
    const encKey = generateEncryptionKey();
    const keyFile = path.join(outputDir, 'enc.key');
    const keyInfoFile = path.join(outputDir, 'enc.keyinfo');

    // Write encryption key
    fs.writeFileSync(keyFile, encKey);

    // Key info file for FFmpeg
    // We use our own server URL for the key
    // So browser fetches key from our server
    // NOT from anywhere that reveals Google Drive
    const keyUrl = `/api/videos/hls-key/${sessionId}`;
    fs.writeFileSync(keyInfoFile, `${keyUrl}\n${keyFile}\n`);

    // Download source video first
    console.log(`📥 Downloading video for HLS processing...`);
    const tempInputFile = path.join(outputDir, 'input.mp4');

    try {
        await downloadToTemp(fileId, tempInputFile);
        console.log(`✅ Video downloaded: ${tempInputFile}`);
    } catch (e) {
        console.error('Download error:', e.message);
        return { success: false, reason: 'download_failed' };
    }

    // Convert to encrypted HLS
    return new Promise((resolve) => {
        const playlistFile = path.join(outputDir, 'playlist.m3u8');
        const segmentPattern = path.join(outputDir, 'seg%03d.ts');

        ffmpeg(tempInputFile)
            .outputOptions([
                '-c:v copy',           // Keep original video codec
                '-c:a copy',           // Keep original audio codec
                '-hls_time 10',        // 10 second segments
                '-hls_list_size 0',    // Keep all segments
                '-hls_segment_type mpegts',
                `-hls_key_info_file ${keyInfoFile}`,  // Encrypt segments!
                '-hls_segment_filename', segmentPattern,
                '-hls_playlist_type vod',
                '-f hls'
            ])
            .output(playlistFile)
            .on('start', (cmd) => {
                console.log('🎬 FFmpeg started HLS conversion');
            })
            .on('progress', (progress) => {
                if (progress.percent) {
                    console.log(`⏳ HLS Progress: ${Math.round(progress.percent)}%`);
                }
            })
            .on('end', () => {
                console.log('✅ HLS conversion complete!');

                // Delete original download to save space
                try { fs.unlinkSync(tempInputFile); } catch (e) {}
                try { fs.unlinkSync(keyInfoFile); } catch (e) {}

                resolve({
                    success: true,
                    outputDir,
                    playlistFile,
                    encKey: encKey.toString('hex')
                });
            })
            .on('error', (err) => {
                console.error('❌ FFmpeg error:', err.message);
                try { fs.unlinkSync(tempInputFile); } catch (e) {}
                resolve({ success: false, reason: err.message });
            })
            .run();
    });
}

module.exports = {
    ffmpegAvailable,
    processToHLS,
    hlsSessions,
    TEMP_DIR
};
