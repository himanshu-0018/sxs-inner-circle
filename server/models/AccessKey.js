// server/models/AccessKey.js
const mongoose = require('mongoose');

const accessKeySchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true
    },
    isUsed: {
        type: Boolean,
        default: false
    },
    usedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    usedAt: Date,
    mentorships: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Mentorship'
    }],
    expiresAt: {
        type: Date,
        required: true
    },
    note: {
        type: String,
        default: ''
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('AccessKey', accessKeySchema);