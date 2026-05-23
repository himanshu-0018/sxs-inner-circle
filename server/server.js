// server/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// Security Headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:", "https:"],
            mediaSrc: ["'self'", "blob:", "data:", "https:", "*"],
            connectSrc: ["'self'", "https:"],
            frameSrc: [
                "'self'",
                "https://drive.google.com",
                "https://www.youtube.com",
                "https://player.vimeo.com"
            ],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            workerSrc: ["'self'", "blob:"],
            scriptSrcAttr: ["'unsafe-inline'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    referrerPolicy: { policy: "no-referrer" }
}));

app.use(cors({ origin: false }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ✅ Fix for Railway proxy
app.set('trust proxy', 1);

// ✅ ADMIN rate limiter - very lenient (admin panel fires many requests)
const adminLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,   // 1 minute window
    max: 300,                    // 300 requests per minute for admin
    standardHeaders: true,
    legacyHeaders: false,
    // ✅ Return JSON not plain text - fixes the crash in admin.js
    message: { success: false, message: 'Too many requests. Please wait a moment.' },
    skip: (req) => {
        // Skip rate limiting if valid admin token (optional extra leniency)
        return false;
    }
});

// ✅ General API rate limiter
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 500,                    // Increased from 200
    standardHeaders: true,
    legacyHeaders: false,
    // ✅ Return JSON not plain text
    message: { success: false, message: 'Too many requests. Please slow down.' }
});

// ✅ Auth limiter (keep strict)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Try again later.' }
});

// ✅ Video stream limiter
const videoLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,                     // Increased from 10
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Slow down.' }
});

// ✅ Apply limiters in correct ORDER (specific first, general last)
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/videos/secure-stream', videoLimiter);
app.use('/api/admin', adminLimiter);   // ✅ Lenient for admin panel
app.use('/api/', limiter);             // ✅ General for everything else

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/videos', require('./routes/videos'));
app.use('/api/admin', require('./routes/admin'));

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, '../public/index.html'));
    }
});

// Connect to MongoDB and start server
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('✅ MongoDB connected');

        const User = require('./models/User');
        const Mentorship = require('./models/Mentorship');

        // Force reset admin if RESET_ADMIN=true
        if (process.env.RESET_ADMIN === 'true') {
            await User.deleteMany({ role: 'admin' });
            console.log('🗑️ Old admin deleted');
        }

        // Create default admin if not exists
        const adminExists = await User.findOne({ role: 'admin' });
        if (!adminExists) {

            // Create default mentorship only if not exists
            let defaultMentorship = await Mentorship.findOne({ slug: 'sxs-inner-circle' });
            if (!defaultMentorship) {
                defaultMentorship = new Mentorship({
                    name: 'SxS Inner Circle',
                    description: 'The main crypto mentorship program with live classes and recordings.',
                    icon: '👑',
                    color: '#6c5ce7',
                    order: 1
                });
                await defaultMentorship.save();
                console.log('🎓 Default mentorship created');
            }

            // Create admin user
            const admin = new User({
                name: 'Admin',
                email: process.env.ADMIN_EMAIL || 'admin@sxsinner.com',
                password: process.env.ADMIN_PASSWORD || 'Admin@SxS2024',
                role: 'admin',
                accessKey: 'MASTER-ADMIN',
                mentorships: [defaultMentorship._id]
            });
            await admin.save();
            console.log('👤 Admin created:', process.env.ADMIN_EMAIL);
        }

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on port ${PORT}`);

            // Auto-convert pending videos in background
            const { autoConvertPending, ffmpegAvailable } = require('./hlsConverter');
            if (ffmpegAvailable) {
                const VideoModel = require('./models/Video');
                setTimeout(() => {
                    autoConvertPending(VideoModel);
                }, 10000);

                setInterval(() => {
                    autoConvertPending(VideoModel);
                }, 5 * 60 * 1000);
            }
        });
    })
    .catch(err => {
        console.error('❌ MongoDB error:', err);
        process.exit(1);
    });
