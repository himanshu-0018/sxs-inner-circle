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
// DOWNLOAD FROM GOOGLE DRIVE - FIXED
// =============================================
function downloadFromDrive(fileId, outputPath, progressCallback) {
    return new Promise((resolve, reject) => {

        // ✅ Use the export download URL with confirm token
        const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t&uuid=${crypto.randomBytes(8).toString('hex')}`;

        let downloadedBytes = 0;
        let totalBytes = 0;
        let lastProgressTime = Date.now();
        let cookies = '';

        // ✅ Progress stall detector - if no progress for 60 seconds, fail
        const stallCheck = setInterval(() => {
            if (Date.now() - lastProgressTime > 60000) {
                clearInterval(stallCheck);
                reject(new Error('Download stalled - no data received for 60 seconds'));
            }
        }, 10000);

        function extractCookies(res) {
            const setCookie = res.headers['set-cookie'];
            if (setCookie) {
                cookies = setCookie.map(c => c.split(';')[0]).join('; ');
            }
        }

        function tryDownload(url, redirects = 0) {
            if (redirects > 10) {
                clearInterval(stallCheck);
                reject(new Error('Too many redirects'));
                return;
            }

            const protocol = url.startsWith('https') ? https : http;

            const reqHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'identity', // ✅ No compression so we get raw bytes
                'Connection': 'keep-alive',
            };

            // ✅ Add cookies if we have them (needed for large file confirm)
            if (cookies) reqHeaders['Cookie'] = cookies;

            const req = protocol.get(url, { headers: reqHeaders }, (res) => {

                // ✅ Always extract and store cookies
                extractCookies(res);

                // Handle redirects
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const loc = res.headers.location;
                    if (loc) {
                        res.resume();
                        const nextUrl = loc.startsWith('http') ? loc : `https://drive.google.com${loc}`;
                        console.log(`↪️  Redirect ${redirects + 1}: ${nextUrl.substring(0, 80)}...`);
                        tryDownload(nextUrl, redirects + 1);
                        return;
                    }
                }

                if (res.statusCode !== 200) {
                    clearInterval(stallCheck);
                    reject(new Error(`HTTP ${res.statusCode} from Google Drive`));
                    return;
                }

                const contentType = res.headers['content-type'] || '';
                const contentLength = parseInt(res.headers['content-length'] || '0');

                console.log(`📡 Response: ${res.statusCode}, Content-Type: ${contentType}, Size: ${contentLength > 0 ? (contentLength / 1024 / 1024).toFixed(1) + 'MB' : 'unknown'}`);

                // ✅ Detect if Google is sending us an HTML warning page instead of the video
                if (contentType.includes('text/html')) {
                    // Collect the HTML to find the confirm token
                    let html = '';
                    res.on('data', chunk => { html += chunk.toString(); });
                    res.on('end', () => {
                        // ✅ Look for confirm token in the HTML
                        const confirmMatch = html.match(/confirm=([0-9A-Za-z_-]+)/);
                        const uuidMatch = html.match(/uuid=([0-9A-Za-z_-]+)/);

                        if (confirmMatch) {
                            const confirmToken = confirmMatch[1];
                            const uuid = uuidMatch ? uuidMatch[1] : '';
                            const confirmUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmToken}${uuid ? `&uuid=${uuid}` : ''}`;
                            console.log(`🔑 Got confirm token, retrying download...`);
                            tryDownload(confirmUrl, redirects + 1);
                        } else if (html.includes('virus scan warning') || html.includes('too large')) {
                            // ✅ Try alternative download URL format
                            const altUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
                            console.log(`⚠️ Virus scan warning, trying alternative URL...`);
                            tryDownload(altUrl, redirects + 1);
                        } else {
                            clearInterval(stallCheck);
                            reject(new Error('Google Drive returned HTML instead of video file. Check file permissions (must be "Anyone with link can view").'));
                        }
                    });
                    return;
                }

                // ✅ Check if it's actually a video file
                const isVideo = contentType.includes('video/') ||
                               contentType.includes('application/octet-stream') ||
                               contentType.includes('binary/octet-stream') ||
                               contentType.includes('application/binary');

                if (!isVideo && contentType !== '') {
                    console.warn(`⚠️ Unexpected content type: ${contentType} - proceeding anyway`);
                }

                totalBytes = contentLength;

                // ✅ Open file for writing
                const file = fs.createWriteStream(outputPath);

                file.on('error', (err) => {
                    clearInterval(stallCheck);
                    reject(err);
                });

                res.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    lastProgressTime = Date.now(); // ✅ Reset stall timer

                    // ✅ Calculate progress properly
                    let pct;
                    if (totalBytes > 0) {
                        // We know the total size
                        pct = Math.round((downloadedBytes / totalBytes) * 50); // 0-50%
                    } else {
                        // ✅ Unknown size - estimate based on downloaded MB
                        // Show incremental progress that never hits 50% until done
                        const downloadedMB = downloadedBytes / (1024 * 1024);
                        pct = Math.min(Math.round(downloadedMB * 2), 45); // Caps at 45%
                    }

                    if (progressCallback) progressCallback(pct);
                });

                res.on('error', (err) => {
                    clearInterval(stallCheck);
                    file.close();
                    reject(err);
                });

                res.pipe(file);

                file.on('finish', () => {
                    clearInterval(stallCheck);
                    file.close(() => {
                        // ✅ Verify file is not empty or tiny (HTML error page)
                        const fileSize = fs.statSync(outputPath).size;
                        console.log(`✅ Download complete: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

                        if (fileSize < 100 * 1024) { // Less than 100KB = probably an error page
                            reject(new Error(`Downloaded file too small (${fileSize} bytes) - likely an error page. Check Google Drive permissions.`));
                            return;
                        }

                        resolve({ size: fileSize });
                    });
                });
            });

            req.on('error', (err) => {
                clearInterval(stallCheck);
                reject(err);
            });

            // ✅ 10 minute timeout for large files
            req.setTimeout(600000, () => {
                req.destroy();
                clearInterval(stallCheck);
                reject(new Error('Download timeout after 10 minutes'));
            });
        }

        tryDownload(initialUrl);
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

        console.log(`📥 [${videoDoc.title}] Starting download from Google Drive...`);

        // Get file ID
        const fileId = getFileId(videoDoc.videoUrl);
        if (!fileId) {
            throw new Error('Cannot extract Google Drive file ID from URL: ' + videoDoc.videoUrl);
        }

        console.log(`🔑 [${videoDoc.title}] File ID: ${fileId}`);

        // Download
        const inputFile = path.join(outputDir, 'input.mp4');
        const downloadResult = await downloadFromDrive(fileId, inputFile, async (pct) => {
            // ✅ Only save if progress actually changed
            if (pct !== videoDoc.hlsProgress) {
                videoDoc.hlsProgress = pct;
                await videoDoc.save().catch(() => {});
            }
        });

        console.log(`✅ [${videoDoc.title}] Downloaded ${(downloadResult.size / 1024 / 1024).toFixed(1)}MB. Converting to HLS...`);

        // Update status: converting
        videoDoc.hlsStatus = 'converting';
        videoDoc.hlsProgress = 50;
        await videoDoc.save();

        // Generate encryption key
        const encKey = crypto.randomBytes(16);
        const keyFile = path.join(outputDir, 'enc.key');
        fs.writeFileSync(keyFile, encKey);

        // Store encryption key in memory
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
                .on('start', (cmd) => {
                    console.log(`🎬 [${videoDoc.title}] FFmpeg started`);
                })
                .on('progress', async (progress) => {
                    if (progress.percent) {
                        const hlsPct = 50 + Math.round(progress.percent / 2); // 50-100%
                        videoDoc.hlsProgress = Math.min(hlsPct, 99);
                        await videoDoc.save().catch(() => {});
                    }
                })
                .on('end', resolve)
                .on('error', (err) => {
                    console.error(`❌ [${videoDoc.title}] FFmpeg error:`, err.message);
                    reject(err);
                })
                .run();
        });

        // Fix M3U8 playlist paths
        let playlist = fs.readFileSync(playlistFile, 'utf8');
        playlist = playlist.replace(
            new RegExp(keyFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
            keyUrl
        );
        playlist = playlist.replace(
            /seg(\d{4})\.ts/g,
            `/api/videos/hls/${sessionId}/seg$1.ts`
        );
        fs.writeFileSync(playlistFile, playlist);

        // Cleanup temp files
        try { fs.unlinkSync(inputFile); } catch (e) {}
        try { fs.unlinkSync(keyInfoFile); } catch (e) {}

        // Calculate duration from playlist
        const durationMatch = playlist.match(/#EXTINF:([\d.]+)/g);
        let totalDuration = 0;
        if (durationMatch) {
            durationMatch.forEach(d => {
                totalDuration += parseFloat(d.replace('#EXTINF:', ''));
            });
        }

        const hours = Math.floor(totalDuration / 3600);
        const mins = Math.floor((totalDuration % 3600) / 60);
        const secs = Math.floor(totalDuration % 60);
        const durationStr = hours > 0
            ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
            : `${mins}:${secs.toString().padStart(2, '0')}`;

        // Mark as ready
        videoDoc.hlsStatus = 'ready';
        videoDoc.hlsProgress = 100;
        videoDoc.hlsConvertedAt = new Date();
        videoDoc.duration = durationStr;
        await videoDoc.save();

        console.log(`🎬 [${videoDoc.title}] ✅ Complete! Duration: ${durationStr}`);
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
                    try { fs.unlinkSync(path.join(outputDir, f)); } catch (e) {}
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

    for (const video of pendingVideos) {
        console.log(`⏳ Converting: ${video.title}`);
        await convertToHLS(video, Video);
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
    if (encryptionKeys.has(sessionId)) {
        return encryptionKeys.get(sessionId);
    }
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
            try {
                const stat = fs.statSync(dirPath);
                if (now - stat.mtimeMs > maxAge) {
                    fs.readdirSync(dirPath).forEach(f => {
                        try { fs.unlinkSync(path.join(dirPath, f)); } catch (e) {}
                    });
                    fs.rmdirSync(dirPath);
                    console.log(`🗑️ Cleaned up old HLS: ${dir}`);
                }
            } catch (e) {}
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
