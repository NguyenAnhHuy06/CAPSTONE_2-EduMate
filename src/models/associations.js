const User = require('./User');
const ActivityLog = require('./ActivityLog');
const Flashcard = require('./Flashcard');
const FlashcardContent = require('./FlashcardContent');
const ChatSession = require('./ChatSession');
const ChatMessage = require('./ChatMessage');
const Citation = require('./Citation');
const Notification = require('./Notification');
const Document = require('./Document');
const Donation = require('./Donation');

// User -> ActivityLog
User.hasMany(ActivityLog, { foreignKey: 'user_id' });
ActivityLog.belongsTo(User, { foreignKey: 'user_id' });

// User -> Notification
User.hasMany(Notification, { foreignKey: 'user_id' });
Notification.belongsTo(User, { foreignKey: 'user_id' });

// User -> Flashcard
User.hasMany(Flashcard, { foreignKey: 'user_id' });
Flashcard.belongsTo(User, { foreignKey: 'user_id' });

// User -> ChatSession
User.hasMany(ChatSession, { foreignKey: 'user_id' });
ChatSession.belongsTo(User, { foreignKey: 'user_id' });

// ChatSession -> ChatMessage
ChatSession.hasMany(ChatMessage, { foreignKey: 'session_id' });
ChatMessage.belongsTo(ChatSession, { foreignKey: 'session_id' });

// ChatMessage -> Citation
ChatMessage.hasMany(Citation, { foreignKey: 'message_id' });
Citation.belongsTo(ChatMessage, { foreignKey: 'message_id' });

// Document -> Flashcard
Document.hasMany(Flashcard, { foreignKey: 'document_id' });
Flashcard.belongsTo(Document, {foreignKey: 'document_id' });

// Flashcard -> FlashcardContent
Flashcard.hasMany(FlashcardContent, { foreignKey: 'flashcard_id' });
FlashcardContent.belongsTo(Flashcard, { foreignKey: 'flashcard_id' });

// User -> Donation
User.hasMany(Donation, { foreignKey: 'user_id', as: 'donations' });
Donation.belongsTo(User, { foreignKey: 'user_id', as: 'donor' });

// Admin User -> confirmed Donation
User.hasMany(Donation, { foreignKey: 'confirmed_by', as: 'confirmedDonations' });
Donation.belongsTo(User, { foreignKey: 'confirmed_by', as: 'confirmedByAdmin' });

module.exports = {
    User,
    ActivityLog,
    Flashcard,
    FlashcardContent,
    ChatSession,
    ChatMessage,
    Citation,
    Donation,
};
