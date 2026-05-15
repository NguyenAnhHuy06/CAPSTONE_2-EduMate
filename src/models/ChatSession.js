const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const ChatSession = sequelize.define('ChatSession', {
    session_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    user_id: {
        type: DataTypes.INTEGER,
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