const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Design ref: Database Design — "chat_sessions" table
const ChatSession = sequelize.define('ChatSession', {
    session_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    user_id: {
        type: DataTypes.STRING(36), // Standardized for MySQL FK compatibility
        allowNull: false
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'chat_sessions',
    timestamps: false
});

module.exports = ChatSession;
