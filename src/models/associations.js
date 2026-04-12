const User = require('./User');
const ActivityLog = require('./ActivityLog');
const Flashcard = require('./Flashcard');
const ChatSession = require('./ChatSession');
const ChatMessage = require('./ChatMessage');
const Citation = require('./Citation');
const Notification = require('./Notification');

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

module.exports = {
    User,
    ActivityLog,
    Flashcard,
    ChatSession,
    ChatMessage,
    Citation
};
