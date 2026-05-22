// server/hlsConverter.js
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

// Base directory for HLS files
const HLS_BASE = process.env.HLS_DIR || path.join(os.tmpdir(), 'sxs-hls');
if (!fs.existsSync(HLS_BASE)) {
    fs.mkdirSync(HLS_BASE, { recursive: true });
}

// Check FFmpeg
let ffmpegAvailable = false;
try {
    const { execSync } = require('child_process');
    execSync('ffmpeg -version', { stdio: 'ignore' });
    ffmpegAvailable = true;
    console.log('✅ FFmpeg available');
} catch (e) {
    console.log('⚠️ FFmpeg not found');
}

// Store encryption keys per session
const encryptionKeys = new Map();

// =============================================
// EXTRACT FILE ID FROM GOOGLE DRIVE URL
// =============================================
function getFileId(url) {
    if (!url) return null;
    const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
}

// =============================================
// DOWNLOAD FROM GOOGLE DRIVE
// =============================================
function downloadFromDrive(fileId, outputPath, progressCallback) {
    return new Promise((resolve, reject) => {
        const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

        const tryDownload = (url, redirects = 0) => {
            if (redirects > 8) {
                reject(new Error('Too many redirects'));
                return;
            }

            const protocol = url.startsWith('https') ? https : http;
            const req = protocol.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*'
                }
            }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const loc = res.headers.location;
                    if (loc) {
                        req.destroy();
                        res.resume();
                        tryDownload(loc, redirects + 1);
                        return;
                    }
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const totalSize = parseInt(res.headers['content-length'] || '0');
                let downloaded = 0;

                const file = fs.createWriteStream(outputPath);
                res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (totalSize > 0 && progressCallback) {
                        const pct = Math.round((downloaded / totalSize) * 50); // 0-50%
                        progressCallback(pct);
                    }
                });

                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve({ size: downloaded });
                });
                file.on('error', reject);
            });

            req.on('error', reject);
            req.setTimeout(300000, () => { // 5 min timeout
                req.destroy();
                reject(new Error('Download timeout'));
            });
        };

        tryDownload(driveUrl);
    });
}

// =============================================
// CONVERT VIDEO TO ENCRYPTED HLS
// =============================================
async function convertToHLS(videoDoc, Video) {
    if (!ffmpegAvailable) {
        console.log('⚠️ FFmpeg not available, skipping conversion');
        return false;
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    const outputDir = path.join(HLS_BASE, sessionId);

    try {
        // Create output directory
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Update status: downloading
        videoDoc.hlsStatus = 'downloading';
        videoDoc.hlsProgress = 0;
        videoDoc.hlsSessionId = sessionId;
        videoDoc.hlsError = '';
        await videoDoc.save();

        console.log(`📥 [${videoDoc.title}] Downloading from Drive...`);

        // Get file ID
        const fileId = getFileId(videoDoc.videoUrl);
        if (!fileId) {
            throw new Error('Cannot extract Google Drive file ID');
        }

        // Download
        const inputFile = path.join(outputDir, 'input.mp4');
        await downloadFromDrive(fileId, inputFile, async (pct) => {
            videoDoc.hlsProgress = pct;
            await videoDoc.save().catch(() => {});
        });

        console.log(`✅ [${videoDoc.title}] Downloaded. Converting to HLS...`);

        // Update status: converting
        videoDoc.hlsStatus = 'converting';
        videoDoc.hlsProgress = 50;
        await videoDoc.save();

        // Generate encryption key
        const encKey = crypto.randomBytes(16);
        const keyFile = path.join(outputDir, 'enc.key');
        fs.writeFileSync(keyFile, encKey);

        // Store encryption key
        encryptionKeys.set(sessionId, encKey);

        // Key info file
        const keyInfoFile = path.join(outputDir, 'enc.keyinfo');
        const keyUrl = `/api/videos/hls-key/${sessionId}`;
        fs.writeFileSync(keyInfoFile, `${keyUrl}\n${keyFile}\n`);

        // Convert with FFmpeg
        const playlistFile = path.join(outputDir, 'playlist.m3u8');
        const segmentPattern = path.join(outputDir, 'seg%04d.ts');

        await new Promise((resolve, reject) => {
            ffmpeg(inputFile)
                .outputOptions([
                    '-c:v copy',
                    '-c:a copy',
                    '-hls_time 10',
                    '-hls_list_size 0',
                    '-hls_segment_type mpegts',
                    `-hls_key_info_file ${keyInfoFile}`,
                    '-hls_segment_filename', segmentPattern,
                    '-hls_playlist_type vod',
                    '-f hls'
                ])
                .output(playlistFile)
                .on('progress', async (progress) => {
                    if (progress.percent) {
                        const hlsPct = 50 + Math.round(progress.percent / 2); // 50-100%
                        videoDoc.hlsProgress = Math.min(hlsPct, 99);
                        await videoDoc.save().catch(() => {});
                    }
                })
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        // Fix M3U8 playlist to use our API paths
        let playlist = fs.readFileSync(playlistFile, 'utf8');
        // Replace local key path with our API path
        playlist = playlist.replace(
            new RegExp(keyFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
            keyUrl
        );
        // Replace segment paths with our API paths
        playlist = playlist.replace(
            /seg(\d{4})\.ts/g,
            `/api/videos/hls/${sessionId}/seg$1.ts`
        );
        fs.writeFileSync(playlistFile, playlist);

        // Delete input file to save space
        try { fs.unlinkSync(inputFile); } catch (e) {}
        try { fs.unlinkSync(keyInfoFile); } catch (e) {}

        // Get video duration from playlist
        const durationMatch = playlist.match(/#EXTINF:([\d.]+)/g);
        let totalDuration = 0;
        if (durationMatch) {
            durationMatch.forEach(d => {
                const sec = parseFloat(d.replace('#EXTINF:', ''));
                totalDuration += sec;
            });
        }

        const hours = Math.floor(totalDuration / 3600);
        const mins = Math.floor((totalDuration % 3600) / 60);
        const secs = Math.floor(totalDuration % 60);
        const durationStr = hours > 0
            ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
            : `${mins}:${secs.toString().padStart(2, '0')}`;

        // Update video as ready
        videoDoc.hlsStatus = 'ready';
        videoDoc.hlsProgress = 100;
        videoDoc.hlsConvertedAt = new Date();
        videoDoc.duration = durationStr;
        await videoDoc.save();

        console.log(`🎬 [${videoDoc.title}] HLS conversion complete! Duration: ${durationStr}`);
        return true;

    } catch (error) {
        console.error(`❌ [${videoDoc.title}] Conversion failed:`, error.message);

        videoDoc.hlsStatus = 'failed';
        videoDoc.hlsError = error.message;
        await videoDoc.save().catch(() => {});

        // Cleanup on failure
        try {
            if (fs.existsSync(outputDir)) {
                fs.readdirSync(outputDir).forEach(f => {
                    fs.unlinkSync(path.join(outputDir, f));
                });
                fs.rmdirSync(outputDir);
            }
        } catch (e) {}

        return false;
    }
}

// =============================================
// AUTO CONVERT ALL PENDING VIDEOS
// =============================================
async function autoConvertPending(Video) {
    if (!ffmpegAvailable) return;

    const pendingVideos = await Video.find({
        hlsStatus: { $in: ['pending', 'failed'] },
        isActive: true
    }).sort({ createdAt: 1 });

    if (pendingVideos.length === 0) return;

    console.log(`🔄 Auto-converting ${pendingVideos.length} pending video(s)...`);

    // Convert one at a time to avoid overloading server
    for (const video of pendingVideos) {
        console.log(`⏳ Converting: ${video.title}`);
        await convertToHLS(video, Video);
        // Small delay between conversions
        await new Promise(r => setTimeout(r, 2000));
    }
}

// =============================================
// GET HLS FILE PATH
// =============================================
function getHLSFilePath(sessionId, filename) {
    const filePath = path.join(HLS_BASE, sessionId, filename);
    if (fs.existsSync(filePath)) return filePath;
    return null;
}

// =============================================
// CHECK IF VIDEO HAS HLS READY
// =============================================
function isHLSReady(sessionId) {
    const playlistPath = path.join(HLS_BASE, sessionId, 'playlist.m3u8');
    return fs.existsSync(playlistPath);
}

// =============================================
// GET ENCRYPTION KEY
// =============================================
function getEncryptionKey(sessionId) {
    // Try from memory first
    if (encryptionKeys.has(sessionId)) {
        return encryptionKeys.get(sessionId);
    }
    // Try from file
    const keyPath = path.join(HLS_BASE, sessionId, 'enc.key');
    if (fs.existsSync(keyPath)) {
        const key = fs.readFileSync(keyPath);
        encryptionKeys.set(sessionId, key);
        return key;
    }
    return null;
}

// =============================================
// CLEANUP OLD HLS FILES
// =============================================
function cleanupOldHLS(maxAgeDays = 7) {
    try {
        const dirs = fs.readdirSync(HLS_BASE);
        const now = Date.now();
        const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

        dirs.forEach(dir => {
            const dirPath = path.join(HLS_BASE, dir);
            const stat = fs.statSync(dirPath);
            if (now - stat.mtimeMs > maxAge) {
                fs.readdirSync(dirPath).forEach(f => {
                    fs.unlinkSync(path.join(dirPath, f));
                });
                fs.rmdirSync(dirPath);
                console.log(`🗑️ Cleaned up old HLS: ${dir}`);
            }
        });
    } catch (e) {}
}

// Cleanup every 24 hours
setInterval(() => cleanupOldHLS(7), 24 * 60 * 60 * 1000);

module.exports = {
    ffmpegAvailable,
    convertToHLS,
    autoConvertPending,
    getHLSFilePath,
    isHLSReady,
    getEncryptionKey,
    encryptionKeys,
    HLS_BASE
};
