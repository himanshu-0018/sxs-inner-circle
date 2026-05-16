// server/models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        maxlength: 60
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true
    },
    phone: {
        type: String,
        default: ''
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: 6
    },
    role: {
        type: String,
        enum: ['student', 'admin'],
        default: 'student'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    isBlocked: {
        type: Boolean,
        default: false
    },
    blockReason: {
        type: String,
        default: ''
    },
    accessKey: {
        type: String,
        required: true
    },
    mentorships: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Mentorship'
    }],
    uniqueIPs: [{
        ip: String,
        userAgent: String,
        firstSeen: { type: Date, default: Date.now },
        lastSeen: { type: Date, default: Date.now }
    }],
    loginCount: {
        type: Number,
        default: 0
    },
    lastLogin: Date,
    lastLoginIP: String,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, 12);
    next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.trackIP = function(ip, userAgent) {
    const existing = this.uniqueIPs.find(entry => entry.ip === ip);
    if (existing) {
        existing.lastSeen = new Date();
    } else {
        this.uniqueIPs.push({ ip, userAgent, firstSeen: new Date(), lastSeen: new Date() });
    }

    const maxIPs = parseInt(process.env.MAX_IP_LIMIT) || 5;
    if (this.uniqueIPs.length > maxIPs && this.role !== 'admin') {
        this.isBlocked = true;
        this.blockReason = `Auto-blocked: Account accessed from ${this.uniqueIPs.length} different IP addresses (limit: ${maxIPs}). Suspected account sharing.`;
    }

    this.loginCount += 1;
    this.lastLogin = new Date();
    this.lastLoginIP = ip;
};

module.exports = mongoose.model('User', userSchema);