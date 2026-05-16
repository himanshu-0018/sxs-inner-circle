// server/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// STRICT Security Headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            mediaSrc: ["'self'", "blob:", "data:"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            workerSrc: ["'self'", "blob:"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" }
}));

app.use(cors({ origin: false })); // Disable CORS - same origin only
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', true);

// Aggressive rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Video stream rate limit - prevent mass downloading
const videoLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { success: false, message: 'Too many requests. Slow down.' } });
app.use('/api/videos/secure-stream', videoLimiter);

app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/videos', require('./routes/videos'));
app.use('/api/admin', require('./routes/admin'));

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, '../public/index.html'));
    }
});

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('✅ MongoDB connected');

        const User = require('./models/User');
        const Mentorship = require('./models/Mentorship');

        const adminExists = await User.findOne({ role: 'admin' });
        if (!adminExists) {
            const defaultMentorship = new Mentorship({
                name: 'SxS Inner Circle',
                description: 'The main crypto mentorship program with live classes and recordings.',
                icon: '👑',
                color: '#6c5ce7',
                order: 1
            });
            await defaultMentorship.save();

            const admin = new User({
                name: 'Admin',
                email: process.env.ADMIN_EMAIL || 'admin@sxsinner.com',
                password: process.env.ADMIN_PASSWORD || 'Admin@SxS2024',
                role: 'admin',
                accessKey: 'MASTER-ADMIN',
                mentorships: [defaultMentorship._id]
            });
            await admin.save();
            console.log('👤 Admin created:', process.env.ADMIN_EMAIL || 'admin@sxsinner.com');
            console.log('🎓 Default mentorship "SxS Inner Circle" created');
        }

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('❌ MongoDB error:', err);
        process.exit(1);
    });