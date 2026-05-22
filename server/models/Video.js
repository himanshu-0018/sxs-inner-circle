// server/models/Video.js
const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Title is required'],
        trim: true
    },
    description: {
        type: String,
        default: ''
    },
    mentorship: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Mentorship',
        required: true
    },
    videoUrl: {
        type: String,
        required: true
    },
    cloudinaryId: {
        type: String,
        default: ''
    },
    // HLS conversion status
    hlsStatus: {
        type: String,
        enum: ['pending', 'downloading', 'converting', 'ready', 'failed'],
        default: 'pending'
    },
    hlsProgress: {
        type: Number,
        default: 0  // 0-100
    },
    hlsSessionId: {
        type: String,
        default: ''
    },
    hlsError: {
        type: String,
        default: ''
    },
    hlsConvertedAt: {
        type: Date,
        default: null
    },
    duration: {
        type: String,
        default: ''
    },
    size: {
        type: Number,
        default: 0
    },
    order: {
        type: Number,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true
    },
    viewCount: {
        type: Number,
        default: 0
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Video', videoSchema);
