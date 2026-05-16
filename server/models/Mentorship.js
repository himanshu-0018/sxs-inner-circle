// server/models/Mentorship.js
const mongoose = require('mongoose');

const mentorshipSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Mentorship name is required'],
        trim: true
    },
    slug: {
        type: String,
        unique: true,
        lowercase: true
    },
    description: {
        type: String,
        default: ''
    },
    icon: {
        type: String,
        default: '🎓'
    },
    color: {
        type: String,
        default: '#6c5ce7'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    order: {
        type: Number,
        default: 0
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

mentorshipSchema.pre('save', function(next) {
    if (!this.slug || this.isModified('name')) {
        this.slug = this.name.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }
    next();
});

module.exports = mongoose.model('Mentorship', mentorshipSchema);