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
        required: [true, 'Mentorship is required']
    },
    videoUrl: {
        type: String,
        required: true
    },
    cloudinaryId: {
        type: String,
        default: ''
    },
    thumbnail: {
        type: String,
        default: ''
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